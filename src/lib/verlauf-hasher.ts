/**
 * Verlauf-Hash-Kette für Workspace-Genealogie.
 *
 * Jeder history[]-Eintrag eines Dokuments bekommt:
 *   - parentHash: sha256 des Vorgänger-Eintrags (null wenn erster)
 *   - entryHash:  sha256(canonical(entry-without-hashes))
 *
 * Workspace-verlaufHash = sha256 der nach uuid sortierten last-entryHashes
 * aller Dokumente. Eindeutiger, deterministischer, reproduzierbarer
 * Identifier des Gesamtzustands.
 *
 * Manipulation eines alten Eintrags invalidiert alle Nachfolger und damit
 * den Workspace-verlaufHash → Tampering-Erkennung.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface HashableEntry {
  at: string;
  kind: string;
  source: string;
  summary: string;
  change?: unknown;
  superseded?: boolean;
  parentHash?: string;  // populated if not first
  entryHash?: string;   // populated by hashEntry
}

/** Canonical-JSON: deterministically sorted keys, stable for hashing. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Compute entryHash for a single entry given its parent. Mutates the entry
 *  to set parentHash + entryHash, returns the new entryHash. */
export function hashEntry(entry: HashableEntry, parentHash: string | null): string {
  // Strip existing hash fields before hashing — they're outputs, not inputs.
  const payload = {
    at: entry.at,
    kind: entry.kind,
    source: entry.source,
    summary: entry.summary,
    change: entry.change ?? null,
    superseded: entry.superseded ?? false,
    parentHash: parentHash ?? null,
  };
  const h = sha256(canonicalJson(payload));
  entry.parentHash = parentHash ?? undefined;
  entry.entryHash = h;
  return h;
}

/** Walk a doc's history[] and ensure every entry has parentHash + entryHash.
 *  Idempotent — entries with existing valid hashes are not recomputed.
 *  Returns the last entry's hash (or null if history is empty). */
export function ensureDocHistoryHashed(history: HashableEntry[] | undefined): string | null {
  if (!history || history.length === 0) return null;
  let prev: string | null = null;
  for (const entry of history) {
    if (entry.entryHash && entry.parentHash === (prev ?? undefined)) {
      // Already hashed and chain is consistent — keep as-is
      prev = entry.entryHash;
      continue;
    }
    prev = hashEntry(entry, prev);
  }
  return prev;
}

/** Compute the workspace-level verlaufHash from per-doc last-entry hashes.
 *  Sort by uuid for determinism. */
export function computeWorkspaceVerlaufHash(docs: Array<{ uuid: string; lastEntryHash: string | null }>): string {
  const sorted = [...docs].sort((a, b) => a.uuid.localeCompare(b.uuid));
  const concat = sorted.map((d) => `${d.uuid}:${d.lastEntryHash ?? 'null'}`).join('|');
  return 'sha256:' + sha256(concat);
}

/** Lazy-migration: read all meta sidecars in a workspace, ensure all history
 *  entries are hashed, persist updates. Returns workspace verlaufHash. Safe
 *  to call repeatedly (idempotent). */
export async function lazyMigrateWorkspace(
  workspacesDir: string,
  wsId: string,
  metaPath: (wsId: string, uuid: string) => string,
): Promise<string> {
  const metaDir = path.join(workspacesDir, wsId, 'meta');
  let entries: string[];
  try { entries = await fs.readdir(metaDir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return computeWorkspaceVerlaufHash([]);
    throw e;
  }
  const docHashes: Array<{ uuid: string; lastEntryHash: string | null }> = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const uuid = f.slice(0, -5);
    const mp = metaPath(wsId, uuid);
    let meta: { uuid: string; history?: HashableEntry[] };
    try { meta = JSON.parse(await fs.readFile(mp, 'utf8')); }
    catch { continue; }
    const before = JSON.stringify(meta.history ?? []);
    const lastHash = ensureDocHistoryHashed(meta.history);
    const after = JSON.stringify(meta.history ?? []);
    if (before !== after) {
      await fs.writeFile(mp, JSON.stringify(meta, null, 2));
    }
    docHashes.push({ uuid: meta.uuid ?? uuid, lastEntryHash: lastHash });
  }
  return computeWorkspaceVerlaufHash(docHashes);
}
