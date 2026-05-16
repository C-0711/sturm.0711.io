import { topoLayers } from './workflow.ts';
import { getStage } from './registry.ts';
import { EventBus } from './events.ts';
import { createArtifactStore } from './artifacts.ts';
import { createGitChainArtifactStore, type GitChainArtifactStore } from './artifacts-gitchain.ts';
import { getToolContainer } from './tools/tool-container.ts';
import { NullToolContainer } from './tools/null-container.ts';
import type { ToolContainerView } from './tools/types.ts';
import type {
  WorkflowDef,
  RunResult,
  StageResult,
  StageContext,
  StageLogger,
  ArtifactStore,
} from './types.ts';

const RUN_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function makeRunId(): string {
  const rand = Array.from({ length: 6 }, () => RUN_ID_CHARS[Math.floor(Math.random() * RUN_ID_CHARS.length)]).join('');
  return `${Date.now().toString(36)}-${rand}`;
}

function makeLogger(bus: EventBus, stageId: string): StageLogger {
  return {
    debug: (msg, data) => bus.emit('log_debug', { msg, data }, stageId),
    info:  (msg, data) => bus.emit('log_info',  { msg, data }, stageId),
    warn:  (msg, data) => bus.emit('log_warn',  { msg, data }, stageId),
    error: (msg, data) => bus.emit('log_error', { msg, data }, stageId),
  };
}

/**
 * Löst `${stageId.field}` und `${input.field}` in einem Inputs-Mapping auf.
 * Deep lookup mit `.`-Separator (`${ocr.pages.0.markdown}` geht).
 */
function resolveInputs(
  mapping: Record<string, string> | undefined,
  stageOutputs: Record<string, unknown>,
  input: unknown,
): Record<string, unknown> {
  if (!mapping) return {};
  const out: Record<string, unknown> = {};
  for (const [key, expr] of Object.entries(mapping)) {
    out[key] = resolveExpr(expr, stageOutputs, input);
  }
  return out;
}

function resolveExpr(expr: string, stageOutputs: Record<string, unknown>, input: unknown): unknown {
  if (typeof expr !== 'string' || !expr.startsWith('${') || !expr.endsWith('}')) {
    return expr; // literale Werte durchreichen
  }
  const inner = expr.slice(2, -1).trim();
  const [head, ...rest] = inner.split('.');
  let cur: unknown;
  if (head === 'input') {
    cur = input;
  } else {
    cur = stageOutputs[head];
  }
  for (const part of rest) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface RunOptions {
  runsDir: string; // z.B. /home/.../0711-STURM/runs
  input: unknown;
  abortSignal?: AbortSignal;
  /** Optionaler Callback für jedes Event — zusätzlich zur Bus-Subscription. */
  onEvent?: (name: string, payload: unknown, stageId?: string) => void;
  /**
   * Anwendung, die diesen Run getriggert hat. Wenn gesetzt, injiziert der
   * Runner den passenden bereits gebooteten `ToolContainer` in `ctx.tools`.
   * Standalone-Runs (Designer, Bash, generischer /api/runs/:wf) lassen das
   * Feld weg und bekommen einen `NullToolContainer`.
   */
  appId?: string;
}

export interface Run {
  runId: string;
  bus: EventBus;
  /** Promise des Endergebnisses. */
  result: Promise<RunResult>;
}

/**
 * Startet einen Workflow-Lauf. Gibt sofort Run-Handle zurück (runId + bus).
 * Subscriber können angeheftet werden, bevor das Promise resolved.
 */
export function runWorkflow(def: WorkflowDef, opts: RunOptions): Run {
  const runId = makeRunId();
  const bus = new EventBus(runId, def.id);
  const signal = opts.abortSignal ?? new AbortController().signal;

  if (opts.onEvent) {
    bus.subscribe(e => opts.onEvent!(e.name, e.payload, e.stageId));
  }

  // Resolve tool container once per run: bound by appId from runtimeOpts.
  // Standalone runs (no appId) → NullToolContainer; stages that try to
  // .get() will throw a helpful error. Boot-skip mode (appId present but
  // no container booted) logs a warning once and falls back to NullContainer.
  let tools: ToolContainerView;
  if (opts.appId) {
    const booted = getToolContainer(opts.appId);
    if (booted) {
      tools = booted;
    } else {
      console.warn(
        `[runner] WARN: appId='${opts.appId}' has no booted ToolContainer; falling back to NullToolContainer`,
      );
      tools = new NullToolContainer();
    }
  } else {
    tools = new NullToolContainer();
  }

  const result = (async (): Promise<RunResult> => {
    // Select artifact backend — use GitChain automatically when configured.
    let artifacts: ArtifactStore;
    let gitChainStore: GitChainArtifactStore | null = null;
    const isGitChainConfigured = Boolean(process.env['GITCHAIN_DATABASE_URL'] && process.env['GITCHAIN_REPO_ROOT']);

    if (isGitChainConfigured) {
      try {
        gitChainStore = await createGitChainArtifactStore(opts.runsDir, def.id, runId);
        artifacts = gitChainStore;
        // Bind mandant if provided in run input
        const inputRec = opts.input as Record<string, unknown>;
        if (typeof inputRec?.mandant_id === 'string' && inputRec.mandant_id) {
          const tenantId = process.env['GITCHAIN_DEFAULT_TENANT'] ?? 'ctax-0711';
          await gitChainStore.bindMandant(inputRec.mandant_id, tenantId).catch(e => {
            bus.emit('log_warn', { msg: `gitchain bindMandant failed: ${e instanceof Error ? e.message : e}` });
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bus.emit('log_warn', { msg: `GitChain init failed, falling back to filesystem: ${msg}` });
        artifacts = createArtifactStore(opts.runsDir, def.id, runId);
      }
    } else {
      artifacts = createArtifactStore(opts.runsDir, def.id, runId);
    }

    const runStart = Date.now();
    bus.emit('run_start', { workflowId: def.id, input: sanitizeForLog(opts.input) });

    // Meta persistieren
    await artifacts.write('_meta.json', {
      runId, workflowId: def.id, startedAt: new Date().toISOString(),
    });

    const layers = topoLayers(def);
    const stageOutputs: Record<string, unknown> = {};
    const stageResults: Record<string, StageResult> = {};
    let overallState: 'ok' | 'error' | 'partial' = 'ok';
    let abortedAfterError = false;

    for (const layer of layers) {
      if (abortedAfterError) {
        for (const stageId of layer) {
          stageResults[stageId] = { stageId, state: 'skipped' };
          bus.emit('stage_skipped', null, stageId);
        }
        continue;
      }
      // Stages einer Schicht parallel ausführen
      const layerPromises = layer.map(async (stageId) => {
        const stageDef = def.stages[stageId];
        const impl = getStage(stageDef.uses);
        if (!impl) {
          const err = new Error(`stage implementation not registered: ${stageDef.uses}`);
          stageResults[stageId] = { stageId, state: 'error', error: { message: err.message } };
          bus.emit('stage_error', { message: err.message }, stageId);
          return;
        }
        const resolved = resolveInputs(stageDef.inputs, stageOutputs, opts.input);
        const t0 = Date.now();
        bus.emit('stage_start', { uses: stageDef.uses }, stageId);
        const ctx: StageContext = {
          runId, workflowId: def.id, stageId,
          config: stageDef.config ?? {},
          logger: makeLogger(bus, stageId),
          artifacts,
          emit: (n, p) => bus.emit(n, p, stageId),
          signal,
          // Snapshot of stages completed in earlier layers. Within the same
          // parallel layer siblings are not yet visible — by design, since
          // their outputs are still in flight.
          results: stageResults as Readonly<Record<string, StageResult>>,
          tools,
        };
        try {
          const output = await impl.run(resolved, ctx);
          const ms = Date.now() - t0;
          stageOutputs[stageId] = output;
          stageResults[stageId] = { stageId, state: 'ok', ms, output: sanitizeForLog(output) };
          await artifacts.write(`${stageId}/output.json`, output);
          if (gitChainStore) {
            const stageName = stageDef.name ?? stageId;
            await gitChainStore.commitStage(stageId, `${stageName} OK (${ms}ms)`).catch(e => {
              bus.emit('log_warn', { msg: `gitchain commit failed for ${stageId}: ${e instanceof Error ? e.message : e}` }, stageId);
            });
          }
          bus.emit('stage_done', { ms, output: sanitizeForLog(output) }, stageId);
        } catch (err: unknown) {
          const ms = Date.now() - t0;
          const e = err instanceof Error ? err : new Error(String(err));
          stageResults[stageId] = {
            stageId, state: 'error', ms,
            error: { message: e.message, stack: e.stack },
          };
          bus.emit('stage_error', { ms, message: e.message }, stageId);
          overallState = 'error';
          abortedAfterError = true; // nachfolgende Layer überspringen
        }
      });
      await Promise.all(layerPromises);
    }

    const totalMs = Date.now() - runStart;
    const runResult: RunResult = { runId, workflowId: def.id, state: overallState, ms: totalMs, stages: stageResults };
    await artifacts.write('_result.json', runResult);

    if (gitChainStore) {
      await gitChainStore.finalCommit(overallState).catch(e => {
        bus.emit('log_warn', { msg: `gitchain final commit failed: ${e instanceof Error ? e.message : e}` });
      });
    }

    if (overallState === 'ok') {
      bus.emit('run_done', { ms: totalMs });
    } else {
      bus.emit('run_error', { ms: totalMs });
    }
    bus.close();
    return runResult;
  })();

  return { runId, bus, result };
}

/**
 * Log-Payloads dürfen keine Riesen-Buffer oder volle OCR-Texte enthalten.
 * Wir kürzen Strings >2000 chars und ersetzen Buffer durch `[Buffer N bytes]`.
 */
function sanitizeForLog(v: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + `…(+${v.length - 2000} chars)` : v;
  if (Buffer.isBuffer(v)) return `[Buffer ${v.length} bytes]`;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => sanitizeForLog(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeForLog(val, depth + 1);
    }
    return out;
  }
  return v;
}
