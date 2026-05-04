/**
 * Versioned JSON-Schema storage.
 *
 * Layout:
 *   <root>/schemas/<id-segments>/<vN>.json    immutable per version
 *   <root>/schemas/<id-segments>/index.json   { current, versions, hashes }
 *
 * IDs use slash-separated path segments, lowercase alphanumeric + - _.
 * Versions auto-increment (v1, v2, …) — never overwrite.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const ID_RE = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

export interface SchemaIndex {
  current: string;
  versions: string[];
  hashes: Record<string, string>;
  name?: string;
  defaultPrompt?: string;
}

export interface SchemaRecord {
  id: string;
  version: string;
  hash: string;
  schema: unknown;
  name?: string;
  defaultPrompt?: string;
}

export interface SchemaSummary {
  id: string;
  currentVersion: string;
  versionCount: number;
}

export class SchemaRepoError extends Error {
  constructor(public code: 'invalid_id' | 'not_found' | 'conflict' | 'forbidden', msg: string) {
    super(msg);
  }
}

function validateId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new SchemaRepoError('invalid_id', `invalid schema id: must match ${ID_RE} (got "${id}")`);
  }
}

function schemasDir(root: string): string {
  return path.join(root, 'schemas');
}

function repoDir(root: string, id: string): string {
  return path.join(schemasDir(root), ...id.split('/'));
}

function indexPath(root: string, id: string): string {
  return path.join(repoDir(root, id), 'index.json');
}

function versionPath(root: string, id: string, version: string): string {
  return path.join(repoDir(root, id), `${version}.json`);
}

async function readIndex(root: string, id: string): Promise<SchemaIndex | null> {
  try {
    const raw = await fs.readFile(indexPath(root, id), 'utf8');
    return JSON.parse(raw) as SchemaIndex;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function nextVersion(versions: string[]): string {
  let max = 0;
  for (const v of versions) {
    const m = /^v(\d+)$/.exec(v);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `v${max + 1}`;
}

function sha256(value: unknown): string {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function listSchemas(root: string): Promise<SchemaSummary[]> {
  const out: SchemaSummary[] = [];
  await walkForIndexes(schemasDir(root), schemasDir(root), out);
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function walkForIndexes(rootDir: string, dir: string, out: SchemaSummary[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  const hasIndex = entries.some((e) => e.isFile() && e.name === 'index.json');
  if (hasIndex) {
    try {
      const raw = await fs.readFile(path.join(dir, 'index.json'), 'utf8');
      const idx = JSON.parse(raw) as SchemaIndex;
      const id = path.relative(rootDir, dir).split(path.sep).join('/');
      out.push({ id, currentVersion: idx.current, versionCount: idx.versions.length });
    } catch { /* skip malformed */ }
  }
  for (const e of entries) {
    if (e.isDirectory()) await walkForIndexes(rootDir, path.join(dir, e.name), out);
  }
}

export async function getSchemaIndex(root: string, id: string): Promise<SchemaIndex> {
  validateId(id);
  const idx = await readIndex(root, id);
  if (!idx) throw new SchemaRepoError('not_found', `schema not found: ${id}`);
  return idx;
}

export async function getSchemaVersion(root: string, id: string, version: string): Promise<SchemaRecord> {
  validateId(id);
  if (!/^v\d+$/.test(version)) throw new SchemaRepoError('invalid_id', `invalid version: ${version}`);
  const idx = await readIndex(root, id);
  if (!idx) throw new SchemaRepoError('not_found', `schema not found: ${id}`);
  if (!idx.versions.includes(version)) throw new SchemaRepoError('not_found', `version not found: ${id}@${version}`);
  const raw = await fs.readFile(versionPath(root, id, version), 'utf8');
  const data = JSON.parse(raw) as { schema: unknown; name?: string; defaultPrompt?: string };
  return {
    id,
    version,
    hash: idx.hashes[version],
    schema: data.schema,
    name: data.name ?? idx.name,
    defaultPrompt: data.defaultPrompt ?? idx.defaultPrompt,
  };
}

export interface PutSchemaInput {
  schema: unknown;
  name?: string;
  defaultPrompt?: string;
}

export async function putSchema(root: string, id: string, input: PutSchemaInput): Promise<{ version: string; hash: string }> {
  validateId(id);
  if (input.schema === undefined || input.schema === null || typeof input.schema !== 'object') {
    throw new SchemaRepoError('invalid_id', 'schema must be a non-null object');
  }
  await fs.mkdir(repoDir(root, id), { recursive: true });
  const idx = (await readIndex(root, id)) ?? { current: '', versions: [], hashes: {} };
  const version = nextVersion(idx.versions);
  const hash = sha256(input.schema);
  const filePath = versionPath(root, id, version);
  // wx flag → fail if file exists; immutable guarantee.
  const payload = {
    schema: input.schema,
    name: input.name,
    defaultPrompt: input.defaultPrompt,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), { flag: 'wx' });
  idx.versions.push(version);
  idx.hashes[version] = hash;
  idx.current = version;
  if (input.name) idx.name = input.name;
  if (input.defaultPrompt) idx.defaultPrompt = input.defaultPrompt;
  await fs.writeFile(indexPath(root, id), JSON.stringify(idx, null, 2));
  return { version, hash };
}
