/**
 * Per-Run/Stage Trace-Kontext via AsyncLocalStorage.
 *
 * Cross-cutting Instrumentierung für volle Prozess-Transparenz: LLM-Calls
 * (`chatJson`, Streaming-Extraktion), MCP-Calls (BMF-Rechner) etc. rufen
 * `recordTrace(...)` auf — ohne den Run/Stage-Kontext explizit durchreichen zu
 * müssen. Der Runner aktiviert pro Stage via `runWithTrace(...)` einen Kontext;
 * außerhalb eines Runs (z.B. Orchestrator-Chat, Standalone-Skripte) ist
 * `recordTrace` ein reiner No-Op.
 *
 * Ergebnis: ein persistiertes `_trace.json`-Artefakt pro Run mit Prompts,
 * externen Request/Response-Paaren, Token-Usage und Dauer — Grundlage der
 * ReactFlow-Prozessansicht (Tab 2 der Fallansicht).
 *
 * Leaf-Modul: importiert NUR `node:async_hooks`, damit sowohl `core/` (Runner)
 * als auch `lib/` (llm-chat, bmf-mcp-client) es zyklusfrei nutzen können.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceEntry {
  /** Monotone Sequenz innerhalb des Runs (Aufrufreihenfolge). */
  seq: number;
  /** ISO-Zeitstempel bei Abschluss des Calls. */
  at: string;
  /** Stage, in deren Kontext der Call lief. */
  stageId?: string;
  /** Art des Calls. */
  kind: 'llm' | 'mcp' | 'embed' | 'rag' | 'http' | string;
  provider?: string;
  model?: string;
  url?: string;
  /** True bei Streaming-Antwort (z.B. vLLM SSE). */
  stream?: boolean;
  /** Request-Nutzlast (z.B. `{ prompt, system }` oder `{ tool, arguments }`). */
  request?: unknown;
  /** Roh-Antwort (Text/JSON). */
  response?: unknown;
  /** Token-Usage o.Ä. (provider-spezifisch). */
  usage?: unknown;
  /** Dauer in ms. */
  ms?: number;
  ok?: boolean;
  error?: string;
}

/** Was `recordTrace` entgegennimmt — `seq`/`at`/`stageId` stempelt der Kontext. */
export type TraceInput = Omit<TraceEntry, 'seq' | 'at' | 'stageId'>;

export interface TraceCtx {
  runId: string;
  workflowId: string;
  stageId?: string;
  /** Senke für fertige Einträge (vom Runner: push in den Run-Akkumulator). */
  sink: (entry: TraceEntry) => void;
  /** Monotone Sequenz, vom Runner über alle Stages eines Runs geteilt. */
  nextSeq: () => number;
}

const als = new AsyncLocalStorage<TraceCtx>();

/** Aktiviert einen Trace-Kontext für die Dauer von `fn` (inkl. aller awaits). */
export function runWithTrace<T>(ctx: TraceCtx, fn: () => T): T {
  return als.run(ctx, fn);
}

/**
 * Schreibt einen Trace-Eintrag, falls ein Run/Stage-Kontext aktiv ist.
 * No-Op außerhalb eines Runs. Wirft nie — Trace darf den eigentlichen Call
 * niemals kippen.
 */
export function recordTrace(input: TraceInput): void {
  const ctx = als.getStore();
  if (!ctx) return;
  try {
    ctx.sink({
      seq: ctx.nextSeq(),
      at: new Date().toISOString(),
      stageId: ctx.stageId,
      ...input,
    });
  } catch {
    /* absichtlich verschluckt */
  }
}

/** True, wenn gerade ein Trace-Kontext aktiv ist (z.B. innerhalb einer Stage). */
export function traceActive(): boolean {
  return als.getStore() != null;
}
