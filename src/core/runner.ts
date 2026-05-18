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

/**
 * Evaluates a `skipWhen` condition expression. Returns true → Stage wird skipped.
 *
 * Unterstützte Grammatik:
 *   - `${path}`                       → truthy-Check
 *   - `${path} == "literal"`          → string-equality
 *   - `${path} != "literal"`          → string-inequality
 *   - `${a.x} == ${b.y}`              → cross-stage equality
 *   - `<sub> && <sub>` / `<sub> || <sub>` → boolean-combine (left-to-right, no precedence)
 *
 * Strict: bei Syntax-Fehler wird `false` zurückgegeben + ein log-warn emittiert
 * (Caller bekommt nicht-skipped → Stage läuft → liefert ggf. Stage-Error, was
 * besser ist als silentlich auf der falschen Pipeline-Seite zu hängen).
 */
export function evaluateCondition(
  expr: string,
  stageOutputs: Record<string, unknown>,
  input: unknown,
  onWarn?: (msg: string) => void,
): boolean {
  if (!expr || typeof expr !== 'string') return false;
  const trimmed = expr.trim();
  // Boolean-combine: && / || — left-to-right ohne Klammern
  // Wir splitten an && / || top-level (keine Verschachtelung mit Klammern unterstützt)
  for (const op of ['&&', '||'] as const) {
    const parts = splitTopLevel(trimmed, op);
    if (parts.length > 1) {
      const evals = parts.map((p) => evaluateCondition(p, stageOutputs, input, onWarn));
      return op === '&&' ? evals.every(Boolean) : evals.some(Boolean);
    }
  }
  // Comparison: == / !=
  const eqMatch = trimmed.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (eqMatch) {
    const lhs = parseTerm(eqMatch[1].trim(), stageOutputs, input);
    const op = eqMatch[2];
    const rhs = parseTerm(eqMatch[3].trim(), stageOutputs, input);
    return op === '==' ? lhs === rhs : lhs !== rhs;
  }
  // Plain truthy-Check
  const v = parseTerm(trimmed, stageOutputs, input);
  return !!v;
}

/** Split an expression at the top-level occurrence of `op`. Keeps ${...} groups
 * intact (we don't have parens, but we want to not split inside a `${...}`). */
function splitTopLevel(s: string, op: '&&' | '||'): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '$' && s[i + 1] === '{') { depth++; i++; continue; }
    if (s[i] === '}' && depth > 0) { depth--; continue; }
    if (depth === 0 && s.slice(i, i + 2) === op) {
      out.push(s.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  out.push(s.slice(start));
  return out.length > 1 ? out.map((p) => p.trim()) : [s];
}

/** Parse a term: either ${path} (resolved against outputs/input), or a string-literal
 *  in double-quotes, or a bare number/boolean. */
function parseTerm(term: string, stageOutputs: Record<string, unknown>, input: unknown): unknown {
  const t = term.trim();
  if (t.startsWith('${') && t.endsWith('}')) {
    return resolveExpr(t, stageOutputs, input);
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === 'undefined') return undefined;
  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  // Fallback: bareword as string (rare)
  return t;
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
        // skipWhen-Check: wenn condition truthy → Stage übersprungen, output bleibt undefined
        if (stageDef.skipWhen) {
          const onWarn = (msg: string) => bus.emit('log_warn', { msg: `skipWhen[${stageId}]: ${msg}` }, stageId);
          const shouldSkip = evaluateCondition(stageDef.skipWhen, stageOutputs, opts.input, onWarn);
          if (shouldSkip) {
            stageResults[stageId] = { stageId, state: 'skipped' };
            bus.emit('stage_skipped', { reason: 'condition', skipWhen: stageDef.skipWhen }, stageId);
            return;
          }
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
