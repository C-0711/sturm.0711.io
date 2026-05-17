/**
 * ctx-store — kleine Registry für lokale ctx-Container.
 *
 * Persistiert unter `runs/ctx/index.json`:
 *   [{ id, name, atomCount, builtAt, outDir }]
 *
 * Jeder Container lebt unter `runs/ctx/<short-id>/` mit der gleichen
 * Layout-Konvention wie runs/project-context/abrechnung/ (atoms/code/,
 * index/cascade.json, index/atom-ids.json, optional events.jsonl).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

export interface CtxRecord {
  id: string;             // 0711:ctx:local:<slug>-<short>
  shortId: string;        // <slug>-<short> — used as on-disk folder
  name: string;
  atomCount: number;
  nativeDim: number | null;
  builtAt: string;
  status: 'pending' | 'indexed';
  outDir: string;         // absolute path
  notes?: string;
}

const REPO_ROOT = resolve(process.cwd());
const STORE_ROOT = process.env.CTX_STORE_ROOT
  ? resolve(process.env.CTX_STORE_ROOT)
  : resolve(REPO_ROOT, 'runs/ctx');
const INDEX_PATH = join(STORE_ROOT, 'index.json');

export async function listContainers(): Promise<CtxRecord[]> {
  if (!existsSync(INDEX_PATH)) return [];
  const raw = await readFile(INDEX_PATH, 'utf8');
  return JSON.parse(raw) as CtxRecord[];
}

export async function getContainer(idOrShort: string): Promise<CtxRecord | null> {
  const all = await listContainers();
  return all.find((r) => r.id === idOrShort || r.shortId === idOrShort || r.name === idOrShort) ?? null;
}

export async function upsertContainer(rec: CtxRecord): Promise<void> {
  await mkdir(STORE_ROOT, { recursive: true });
  const all = await listContainers();
  const idx = all.findIndex((r) => r.id === rec.id);
  if (idx >= 0) all[idx] = rec; else all.push(rec);
  await writeFile(INDEX_PATH, JSON.stringify(all, null, 2));
}

export function allocateShortId(name: string): { shortId: string; id: string; outDir: string } {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'ctx';
  const suffix = randomBytes(3).toString('hex');
  const shortId = `${slug}-${suffix}`;
  return {
    shortId,
    id: `0711:ctx:local:${shortId}`,
    outDir: join(STORE_ROOT, shortId),
  };
}

export function storeRoot(): string {
  return STORE_ROOT;
}
