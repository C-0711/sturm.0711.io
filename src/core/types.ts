/**
 * STURM — Kern-Typen
 *
 * Ein Workflow ist eine Definition (Daten). Stages sind Funktionen.
 * Der Runner führt aus, emittiert Events, persistiert Artefakte.
 */

// ============ Workflow-Definition ============

export type WorkflowId = string;
export type StageId = string;

export interface WorkflowInputSpec {
  type: 'file' | 'text' | 'json';
  accept?: string[]; // für type=file: ["pdf", "png", ...]
  maxSizeMb?: number;
}

export interface StageDef<TConfig = unknown> {
  /** Name einer registrierten Stage (z.B. "mistral-ocr"). */
  uses: string;
  /** Stage-spezifische Konfiguration (wird der Stage als ctx.config übergeben). */
  config?: TConfig;
  /**
   * Input-Mappings: Object-Keys werden per `${stage.field}` aufgelöst.
   * `${input.X}` liest aus dem Workflow-Input.
   */
  inputs?: Record<string, string>;
  /** Menschenlesbarer Name; default = uses. */
  name?: string;
  /** Ein-Satz-Beschreibung für UI-Hovertexts etc. */
  description?: string;
}

export interface WorkflowDef {
  id: WorkflowId;
  name: string;
  description: string;
  input: WorkflowInputSpec;
  stages: Record<StageId, StageDef>;
  /** [from, to]-Paare. Topologische Sortierung bestimmt Ausführungsreihenfolge. */
  edges: Array<[StageId, StageId]>;
}

// ============ Stage-Contract ============

/** Loggerschnittstelle — bewusst dünn, damit Stages nicht auf winston etc. angewiesen sind. */
export interface StageLogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Artefakt-Speicher pro Run. Pfade sind relativ zum Run-Ordner. */
export interface ArtifactStore {
  write(path: string, data: unknown): Promise<void>;
  writeBuffer(path: string, data: Buffer): Promise<void>;
  read<T = unknown>(path: string): Promise<T>;
  readBuffer(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  /** Absoluter Pfad für Dinge, die einen Dateipfad wollen (z.B. OCR-APIs). */
  absolutePath(path: string): string;
}

export type StageState = 'idle' | 'running' | 'ok' | 'error' | 'skipped';

export interface StageContext<TConfig = unknown> {
  runId: string;
  workflowId: WorkflowId;
  stageId: StageId;
  config: TConfig;
  logger: StageLogger;
  artifacts: ArtifactStore;
  /** Beliebige Zusatz-Events an den SSE-Stream senden. */
  emit(eventName: string, payload?: unknown): void;
  /** AbortSignal — kann von langen Operationen respektiert werden. */
  signal: AbortSignal;
}

export interface StageDefinition<TIn = unknown, TOut = unknown, TConfig = unknown> {
  id: string;
  name: string;
  description?: string;
  run(input: TIn, ctx: StageContext<TConfig>): Promise<TOut>;
}

// ============ Events ============

export type EventName =
  | 'run_start'
  | 'run_done'
  | 'run_error'
  | 'stage_start'
  | 'stage_done'
  | 'stage_error'
  | 'stage_skipped'
  | string; // custom-Events von Stages

export interface EventEnvelope {
  name: EventName;
  runId: string;
  workflowId: WorkflowId;
  stageId?: StageId;
  at: string; // ISO-timestamp
  payload?: unknown;
}

// ============ Runner-Ergebnis ============

export interface StageResult {
  stageId: StageId;
  state: StageState;
  ms?: number;
  output?: unknown;
  error?: { message: string; stack?: string };
}

export interface RunResult {
  runId: string;
  workflowId: WorkflowId;
  state: 'ok' | 'error' | 'partial';
  ms: number;
  stages: Record<StageId, StageResult>;
}
