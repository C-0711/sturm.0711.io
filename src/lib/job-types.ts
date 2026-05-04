/**
 * Job-System Types — first-class persistent jobs for long-running operations.
 *
 * Jobs sind workspace-scoped und leben als Sidecar unter
 * `workspaces/<wsId>/.jobs/<jobId>.json` + `.jobs/<jobId>.events.jsonl`.
 */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobKind =
  | 'reclassify'              // re-run mistral-small classify on a doc (or set)
  | 'extract'                 // mistral-ocr-latest annotation against template
  | 'audit'                   // structural / semantic / visual / vision / cross-model audit
  | 'batch'                   // multi-doc batch over one of the above
  | 'import-cb-chat-case'     // import all docs from a cb-chat Fall into a workspace
  | 'citations';              // generate citation pointers for all KPIs (Phase H)

export interface JobInputs {
  /** Doc-uuids the job operates on (empty for whole-workspace ops). */
  docUuids?: string[];
  /** For audit: which audit-kind. */
  auditKind?: 'consistency' | 'structural' | 'semantic' | 'visual' | 'vision' | 'cross-model';
  /** For batch: which step to apply to each doc. */
  step?: 'reclassify' | 'extract' | 'audit';
  /** For import-cb-chat-case: source case + cookie. */
  cbChatFallId?: string;
  cbChatCookie?: string;
  cbChatBaseUrl?: string;
  /** Free-form: handler-specific options. */
  [key: string]: unknown;
}

export interface JobError {
  message: string;
  code?: string;
  stack?: string;
}

export interface Job {
  jobId: string;
  workspaceId: string;
  kind: JobKind;
  pipelineRef?: string;             // e.g. "tax-de-2024@v0" — traceability
  inputs: JobInputs;
  inputHash: string;                // sha256(canonical(inputs+kind+wsId)) for idempotency
  status: JobStatus;
  progress: { current: number; total: number };
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: JobError;
  cancelRequested?: boolean;
  createdAt: string;
  createdBy?: string;
}

export interface JobEvent {
  /** Monotonic per-job sequence (0, 1, 2, …) so clients can resume from cursor. */
  seq: number;
  at: string;
  /** Convention: 'started' | 'progress' | 'doc_done' | 'doc_failed' | 'completed' | 'failed' | 'cancelled' | … */
  type: string;
  data: unknown;
}

/** Server-facing handler signature. Receives the job + an emit() to push events. */
export interface JobContext {
  job: Job;
  emit: (type: string, data?: unknown) => Promise<void>;
  bumpProgress: (current: number, total?: number) => Promise<void>;
  /** Returns true if cancellation has been requested — handlers should poll between sub-steps. */
  cancelRequested: () => boolean;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;
