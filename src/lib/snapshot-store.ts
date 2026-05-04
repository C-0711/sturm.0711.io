/**
 * Content-addressed snapshot storage for master.json.
 *
 * Layout:
 *   workspaces/<wsId>/.snapshots/
 *     <verlaufHash>.json        — immutable, never overwritten
 *     latest.json               — { hash, savedAt } pointing to current
 *     log.jsonl                 — append-only genealogy: one line per snapshot {hash,savedAt,prevHash}
 *
 * Calls are idempotent: setSnapshot with an existing hash is a no-op (the
 * content is already there, by definition the same).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SNAPSHOTS_SUBDIR = '.snapshots';

function snapshotsDir(workspacesDir: string, wsId: string): string {
  return path.join(workspacesDir, wsId, SNAPSHOTS_SUBDIR);
}

export interface SnapshotLogEntry {
  hash: string;
  savedAt: string;
  prevHash: string | null;
  /** Optional summary fields for genealogy UI without loading the full snapshot. */
  approvedCount?: number;
  totalCount?: number;
}

export async function getSnapshot(workspacesDir: string, wsId: string, hash: string): Promise<unknown | null> {
  // Strip "sha256:" prefix if present — file is named with raw hex.
  const key = hash.startsWith('sha256:') ? hash.slice(7) : hash;
  const fp = path.join(snapshotsDir(workspacesDir, wsId), `${key}.json`);
  try { return JSON.parse(await fs.readFile(fp, 'utf8')); }
  catch { return null; }
}

export async function setSnapshot(workspacesDir: string, wsId: string, hash: string, snapshot: unknown, summary?: Pick<SnapshotLogEntry, 'approvedCount' | 'totalCount'>): Promise<void> {
  const dir = snapshotsDir(workspacesDir, wsId);
  await fs.mkdir(dir, { recursive: true });
  const key = hash.startsWith('sha256:') ? hash.slice(7) : hash;
  const fp = path.join(dir, `${key}.json`);
  // Idempotent: if file exists, skip the write (content-addressed = same hash means same content)
  try { await fs.access(fp); return; } catch { /* not there, write */ }
  const tmp = `${fp}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2));
  await fs.rename(tmp, fp);
  // Update latest pointer + append to log
  const prev = await getLatestHash(workspacesDir, wsId);
  const latestFp = path.join(dir, 'latest.json');
  await fs.writeFile(latestFp, JSON.stringify({ hash, savedAt: new Date().toISOString() }, null, 2));
  const logEntry: SnapshotLogEntry = {
    hash,
    savedAt: new Date().toISOString(),
    prevHash: prev,
    approvedCount: summary?.approvedCount,
    totalCount: summary?.totalCount,
  };
  await fs.appendFile(path.join(dir, 'log.jsonl'), JSON.stringify(logEntry) + '\n');
}

export async function getLatestHash(workspacesDir: string, wsId: string): Promise<string | null> {
  const fp = path.join(snapshotsDir(workspacesDir, wsId), 'latest.json');
  try {
    const raw = await fs.readFile(fp, 'utf8');
    const parsed = JSON.parse(raw) as { hash?: string };
    return parsed.hash ?? null;
  } catch { return null; }
}

export async function readLog(workspacesDir: string, wsId: string): Promise<SnapshotLogEntry[]> {
  const fp = path.join(snapshotsDir(workspacesDir, wsId), 'log.jsonl');
  let raw: string;
  try { raw = await fs.readFile(fp, 'utf8'); } catch { return []; }
  const out: SnapshotLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as SnapshotLogEntry); } catch { /* skip */ }
  }
  return out;
}
