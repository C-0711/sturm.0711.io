/**
 * Periodic janitor: deletes leftover uploads + run-input copies.
 *
 *   uploads/<file>            older than UPLOAD_MAX_AGE_MS  → unlink
 *   runs/<wf>/<run>/_input/*  older than INPUT_RETENTION_DAYS → unlink
 *
 * Runs in-process; cheap stat-walk every 10 min.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

export interface SweepOptions {
  uploadsDir: string;
  runsDir: string;
  inputRetentionDays?: number;
  intervalMs?: number;
}

export function startUploadSweep(opts: SweepOptions): NodeJS.Timeout {
  const interval = opts.intervalMs ?? SWEEP_INTERVAL_MS;
  // Run once at startup so a fresh boot also cleans, then on schedule.
  void runSweep(opts);
  const t = setInterval(() => void runSweep(opts), interval);
  // Don't keep the event loop alive just for sweeps.
  if (typeof t.unref === 'function') t.unref();
  return t;
}

export async function runSweep(opts: SweepOptions): Promise<{ uploadsRemoved: number; inputsRemoved: number }> {
  const retentionDays = opts.inputRetentionDays ?? 7;
  const uploadsRemoved = await sweepDirectory(opts.uploadsDir, UPLOAD_MAX_AGE_MS, false);
  const inputsRemoved = await sweepRunInputs(opts.runsDir, retentionDays * 24 * 60 * 60 * 1000);
  console.log(`[sweep] uploads removed=${uploadsRemoved} run_inputs removed=${inputsRemoved} retentionDays=${retentionDays}`);
  return { uploadsRemoved, inputsRemoved };
}

async function sweepDirectory(dir: string, maxAgeMs: number, recurse: boolean): Promise<number> {
  let removed = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recurse) removed += await sweepDirectory(full, maxAgeMs, true);
      continue;
    }
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) {
        await fs.unlink(full);
        removed++;
      }
    } catch {
      /* race: file vanished between readdir and stat */
    }
  }
  return removed;
}

async function sweepRunInputs(runsDir: string, maxAgeMs: number): Promise<number> {
  let removed = 0;
  let workflows: import('node:fs').Dirent[];
  try {
    workflows = await fs.readdir(runsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const wf of workflows) {
    if (!wf.isDirectory()) continue;
    const wfDir = path.join(runsDir, wf.name);
    let runs: import('node:fs').Dirent[];
    try { runs = await fs.readdir(wfDir, { withFileTypes: true }); } catch { continue; }
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const inputDir = path.join(wfDir, run.name, '_input');
      removed += await sweepDirectory(inputDir, maxAgeMs, false);
    }
  }
  return removed;
}
