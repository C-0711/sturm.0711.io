/**
 * In-process FIFO Job-Runner with persistent state.
 *
 * Storage:
 *   workspaces/<wsId>/.jobs/<jobId>.json         — Job record (state)
 *   workspaces/<wsId>/.jobs/<jobId>.events.jsonl — Append-only event log
 *
 * Single global queue. One worker. Restart-safety: on boot, all jobs with
 * status='running' are marked 'failed' (server_restarted), 'queued' jobs are
 * re-enqueued.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Job, JobEvent, JobHandler, JobInputs, JobKind, JobStatus, JobContext, JobError } from './job-types.ts';

const JOBS_SUBDIR = '.jobs';
/** Idempotency lookback window: identical inputHash within N ms returns the existing job. */
const IDEMPOTENCY_WINDOW_MS = 60_000;

/** Canonical-JSON for inputHash: sorts keys recursively. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
}

function hashInputs(workspaceId: string, kind: JobKind, inputs: JobInputs): string {
  const canon = canonicalJson({ workspaceId, kind, inputs });
  return 'sha256:' + createHash('sha256').update(canon).digest('hex');
}

function jobsDir(workspacesDir: string, wsId: string): string {
  return path.join(workspacesDir, wsId, JOBS_SUBDIR);
}
function jobJsonPath(workspacesDir: string, wsId: string, jobId: string): string {
  return path.join(jobsDir(workspacesDir, wsId), `${jobId}.json`);
}
function jobEventsPath(workspacesDir: string, wsId: string, jobId: string): string {
  return path.join(jobsDir(workspacesDir, wsId), `${jobId}.events.jsonl`);
}

export class JobRunner {
  private workspacesDir: string;
  private handlers = new Map<JobKind, JobHandler>();
  private queue: { wsId: string; jobId: string }[] = [];
  private active: { wsId: string; jobId: string } | null = null;
  private cancelFlags = new Map<string, boolean>(); // jobId → true if cancelled
  /** Emits "job:<jobId>" with JobEvent for live SSE streams. */
  private bus = new EventEmitter();

  constructor(workspacesDir: string) {
    this.workspacesDir = workspacesDir;
    this.bus.setMaxListeners(0); // many SSE clients possible
  }

  registerHandler(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Boot-time recovery: mark in-flight jobs as failed, re-enqueue queued. */
  async recover(): Promise<void> {
    const wsRoot = this.workspacesDir;
    let wsIds: string[];
    try { wsIds = await fs.readdir(wsRoot); } catch { return; }
    for (const wsId of wsIds) {
      const dir = jobsDir(wsRoot, wsId);
      let entries: string[];
      try { entries = await fs.readdir(dir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        const jobId = f.slice(0, -5);
        const job = await this.readJob(wsId, jobId);
        if (!job) continue;
        if (job.status === 'running') {
          await this.updateJob(wsId, jobId, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: { message: 'server restarted while job was running', code: 'server_restarted' },
          });
        } else if (job.status === 'queued') {
          this.queue.push({ wsId, jobId });
        }
      }
    }
    void this.tick();
  }

  /** Enqueue a new job (or return an idempotent existing one). */
  async enqueue(args: {
    workspaceId: string;
    kind: JobKind;
    inputs: JobInputs;
    pipelineRef?: string;
    createdBy?: string;
    idempotencyKey?: string;
  }): Promise<{ job: Job; deduplicated: boolean }> {
    const inputHash = args.idempotencyKey
      ? `idem:${args.idempotencyKey}`
      : hashInputs(args.workspaceId, args.kind, args.inputs);
    // Check for an existing job in the idempotency window.
    const existing = await this.findRecentByHash(args.workspaceId, inputHash, IDEMPOTENCY_WINDOW_MS);
    if (existing) return { job: existing, deduplicated: true };

    const jobId = randomUUID();
    const job: Job = {
      jobId,
      workspaceId: args.workspaceId,
      kind: args.kind,
      pipelineRef: args.pipelineRef,
      inputs: args.inputs,
      inputHash,
      status: 'queued',
      progress: { current: 0, total: this.estimateTotal(args.kind, args.inputs) },
      createdAt: new Date().toISOString(),
      createdBy: args.createdBy,
    };
    await fs.mkdir(jobsDir(this.workspacesDir, args.workspaceId), { recursive: true });
    await this.writeJob(args.workspaceId, jobId, job);
    await this.appendEvent(args.workspaceId, jobId, 'queued', { inputHash });
    this.queue.push({ wsId: args.workspaceId, jobId });
    void this.tick();
    return { job, deduplicated: false };
  }

  private estimateTotal(kind: JobKind, inputs: JobInputs): number {
    const docCount = inputs.docUuids?.length ?? 0;
    return Math.max(1, docCount);
  }

  /** Pick next queued job and run it. Single-worker. */
  private async tick(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    const { wsId, jobId } = next;
    const job = await this.readJob(wsId, jobId);
    if (!job) { this.active = null; void this.tick(); return; }
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      await this.fail(wsId, jobId, { message: `no handler registered for kind=${job.kind}`, code: 'no_handler' });
      this.active = null;
      void this.tick();
      return;
    }
    await this.updateJob(wsId, jobId, { status: 'running', startedAt: new Date().toISOString() });
    await this.appendEvent(wsId, jobId, 'started', {});
    const ctx: JobContext = {
      job: (await this.readJob(wsId, jobId))!,
      emit: async (type, data) => { await this.appendEvent(wsId, jobId, type, data); },
      bumpProgress: async (current, total) => {
        const patch: Partial<Job> = { progress: { current, total: total ?? job.progress.total } };
        await this.updateJob(wsId, jobId, patch);
        await this.appendEvent(wsId, jobId, 'progress', patch.progress);
      },
      cancelRequested: () => this.cancelFlags.get(jobId) === true,
    };
    try {
      const result = await handler(ctx);
      if (this.cancelFlags.get(jobId)) {
        await this.updateJob(wsId, jobId, { status: 'cancelled', completedAt: new Date().toISOString(), result });
        await this.appendEvent(wsId, jobId, 'cancelled', {});
      } else {
        await this.updateJob(wsId, jobId, { status: 'completed', completedAt: new Date().toISOString(), result });
        await this.appendEvent(wsId, jobId, 'completed', { result });
      }
    } catch (e) {
      const err = e as Error;
      await this.fail(wsId, jobId, { message: err.message ?? String(err), stack: err.stack });
    } finally {
      this.cancelFlags.delete(jobId);
      this.active = null;
      void this.tick();
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const found = await this.find(jobId);
    if (!found) return false;
    this.cancelFlags.set(jobId, true);
    await this.updateJob(found.wsId, jobId, { cancelRequested: true });
    await this.appendEvent(found.wsId, jobId, 'cancel_requested', {});
    return true;
  }

  /** Direct job read by jobId (workspace-scope discovered via .jobs/ scan). */
  async find(jobId: string): Promise<{ wsId: string; job: Job } | null> {
    let wsIds: string[];
    try { wsIds = await fs.readdir(this.workspacesDir); } catch { return null; }
    for (const wsId of wsIds) {
      const job = await this.readJob(wsId, jobId);
      if (job) return { wsId, job };
    }
    return null;
  }

  async list(workspaceId?: string, filter?: { status?: JobStatus; kind?: JobKind; limit?: number }): Promise<Job[]> {
    const wsIds = workspaceId ? [workspaceId] : await this.listWorkspaceIds();
    const out: Job[] = [];
    for (const wsId of wsIds) {
      const dir = jobsDir(this.workspacesDir, wsId);
      let entries: string[];
      try { entries = await fs.readdir(dir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        const job = await this.readJob(wsId, f.slice(0, -5));
        if (!job) continue;
        if (filter?.status && job.status !== filter.status) continue;
        if (filter?.kind && job.kind !== filter.kind) continue;
        out.push(job);
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter?.limit ? out.slice(0, filter.limit) : out;
  }

  /** Read events from disk, optionally from a given seq cursor. */
  async readEvents(wsId: string, jobId: string, fromSeq = 0): Promise<JobEvent[]> {
    const ep = jobEventsPath(this.workspacesDir, wsId, jobId);
    let raw: string;
    try { raw = await fs.readFile(ep, 'utf8'); } catch { return []; }
    const out: JobEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as JobEvent;
        if (ev.seq >= fromSeq) out.push(ev);
      } catch { /* skip malformed line */ }
    }
    return out;
  }

  /** Subscribe to live events for a job. Returns an unsubscribe fn. */
  subscribeLive(jobId: string, listener: (ev: JobEvent) => void): () => void {
    const handler = (ev: JobEvent) => listener(ev);
    this.bus.on(`job:${jobId}`, handler);
    return () => this.bus.off(`job:${jobId}`, handler);
  }

  // ---------- internal helpers ----------

  private async listWorkspaceIds(): Promise<string[]> {
    try { return (await fs.readdir(this.workspacesDir)).filter((n) => !n.startsWith('.') && !n.endsWith('.json')); }
    catch { return []; }
  }

  private async readJob(wsId: string, jobId: string): Promise<Job | null> {
    try { return JSON.parse(await fs.readFile(jobJsonPath(this.workspacesDir, wsId, jobId), 'utf8')) as Job; }
    catch { return null; }
  }

  private async writeJob(wsId: string, jobId: string, job: Job): Promise<void> {
    const fp = jobJsonPath(this.workspacesDir, wsId, jobId);
    const tmp = `${fp}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(job, null, 2));
    await fs.rename(tmp, fp);
  }

  private async updateJob(wsId: string, jobId: string, patch: Partial<Job>): Promise<Job | null> {
    const cur = await this.readJob(wsId, jobId);
    if (!cur) return null;
    const next: Job = { ...cur, ...patch };
    await this.writeJob(wsId, jobId, next);
    return next;
  }

  private async appendEvent(wsId: string, jobId: string, type: string, data: unknown): Promise<void> {
    const events = await this.readEvents(wsId, jobId);
    const seq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) + 1 : 0;
    const ev: JobEvent = { seq, at: new Date().toISOString(), type, data };
    await fs.appendFile(jobEventsPath(this.workspacesDir, wsId, jobId), JSON.stringify(ev) + '\n');
    this.bus.emit(`job:${jobId}`, ev);
  }

  private async fail(wsId: string, jobId: string, error: JobError): Promise<void> {
    await this.updateJob(wsId, jobId, { status: 'failed', completedAt: new Date().toISOString(), error });
    await this.appendEvent(wsId, jobId, 'failed', { error });
  }

  private async findRecentByHash(workspaceId: string, inputHash: string, withinMs: number): Promise<Job | null> {
    const jobs = await this.list(workspaceId);
    const cutoff = Date.now() - withinMs;
    for (const j of jobs) {
      if (j.inputHash !== inputHash) continue;
      const t = new Date(j.createdAt).getTime();
      if (t >= cutoff) return j;
    }
    return null;
  }
}
