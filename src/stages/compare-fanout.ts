import { defineStage } from '../core/stage.ts';
import { getStage } from '../core/registry.ts';
import type { StageContext } from '../core/types.ts';

export interface BranchDef {
  /** Registered stage id this branch runs (e.g. "mistral-ocr", "lighton-ocr"). */
  uses: string;
  /** Stage-specific config passed via ctx.config. */
  config?: Record<string, unknown>;
}

export interface FanoutConfig {
  /** Map of branchId → branch stage definition. */
  branches: Record<string, BranchDef>;
  /**
   * If true, a failing branch does NOT fail the whole fanout — the failure is
   * recorded in `errors[branchId]` and other branches continue. Default true.
   */
  continueOnError?: boolean;
}

export interface FanoutOutput {
  /** Successful branch outputs keyed by branchId. */
  branches: Record<string, unknown>;
  /** Per-branch wall-clock duration in ms. */
  perBranchMs: Record<string, number>;
  /** Per-branch error messages (only present for failed branches). */
  errors: Record<string, string>;
  /** Total wall-clock duration. */
  ms: number;
}

/**
 * compare/fanout — runs N child stage configurations in parallel against the
 * same input. Each branch is a fully self-contained stage invocation that
 * receives this fanout's `input` verbatim. Output groups branch results so
 * downstream comparators or KPI nodes can introspect.
 *
 * Per-branch isolation: each branch gets the same StageContext as the parent
 * but with its own `config` and `stageId` namespaced as `${parentId}.${branchId}`,
 * so artifacts and emitted events do not collide.
 */
export const compareFanoutStage = defineStage<unknown, FanoutOutput, FanoutConfig>({
  id: 'compare/fanout',
  name: 'Fanout — run branches in parallel',
  description:
    'Runs N stage configurations in parallel on the same input. Outputs ' +
    '{branches, perBranchMs, errors} so downstream merge/KPI nodes can compare.',
  hints: {
    inputs: 'whatever the branches expect — passed verbatim to each branch',
    outputs: 'branches{branchId: branchOutput}, perBranchMs{branchId: ms}, errors{branchId: msg}, ms',
    configExample: '{"continueOnError": true, "branches": {"a": {"uses": "mistral-ocr", "config": {}}, "b": {"uses": "lighton-ocr", "config": {}}}}',
  },

  async run(input, ctx) {
    const cfg = ctx.config ?? ({} as FanoutConfig);
    const branches = cfg.branches ?? {};
    const continueOnError = cfg.continueOnError !== false;
    const branchIds = Object.keys(branches);
    if (branchIds.length === 0) throw new Error('compare/fanout: config.branches is empty');

    const t0 = Date.now();
    ctx.emit('fanout_started', { branches: branchIds });

    const results: FanoutOutput = { branches: {}, perBranchMs: {}, errors: {}, ms: 0 };

    await Promise.all(branchIds.map(async (branchId) => {
      const def = branches[branchId];
      const impl = getStage(def.uses);
      if (!impl) {
        results.errors[branchId] = `branch "${branchId}": stage "${def.uses}" not registered`;
        ctx.emit('branch_error', { branchId, error: results.errors[branchId] });
        if (!continueOnError) throw new Error(results.errors[branchId]);
        return;
      }
      const subStageId = `${ctx.stageId}.${branchId}`;
      const branchCtx: StageContext = {
        ...ctx,
        stageId: subStageId,
        config: def.config ?? {},
        emit: (name, payload) => ctx.emit(name, payload),
        logger: {
          debug: (msg, data) => ctx.logger.debug(`[${branchId}] ${msg}`, data),
          info:  (msg, data) => ctx.logger.info (`[${branchId}] ${msg}`, data),
          warn:  (msg, data) => ctx.logger.warn (`[${branchId}] ${msg}`, data),
          error: (msg, data) => ctx.logger.error(`[${branchId}] ${msg}`, data),
        },
      };
      const tBranch = Date.now();
      ctx.emit('branch_started', { branchId, uses: def.uses });
      try {
        const out = await impl.run(input, branchCtx);
        const ms = Date.now() - tBranch;
        results.branches[branchId] = out;
        results.perBranchMs[branchId] = ms;
        ctx.emit('branch_done', { branchId, ms });
        // Persist per-branch output for forensic comparison.
        await ctx.artifacts.write(`${ctx.stageId}/${branchId}/output.json`, out).catch(() => {});
      } catch (err) {
        const ms = Date.now() - tBranch;
        const msg = err instanceof Error ? err.message : String(err);
        results.errors[branchId] = msg;
        results.perBranchMs[branchId] = ms;
        ctx.emit('branch_error', { branchId, ms, error: msg });
        if (!continueOnError) throw err;
      }
    }));

    results.ms = Date.now() - t0;
    ctx.emit('fanout_done', { ms: results.ms, ok: Object.keys(results.branches).length, errs: Object.keys(results.errors).length });
    return results;
  },
});
