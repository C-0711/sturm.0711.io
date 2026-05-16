/**
 * Catalog-Resolver. Lädt zur Boot-Zeit die deklarierten JSON-Dateien aus dem
 * Anwendungs-Container (atoms, container, nested_schemas/*.json) und cached
 * sie in einem `CatalogHandle`. `get('nested')` liefert ein Dict
 * `{ <basename>: <inhalt> }`.
 *
 * Health-Check: Mindestens eine deklarierte Datei muss existieren (sonst ist
 * der Katalog wertlos). Existiert eine optionale Datei nicht, ist das ok.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve as pathResolve, join, basename } from 'node:path';

import type { CatalogToolRef, ToolHealth } from '../types.ts';
import type { CatalogHandle } from '../handles.ts';

interface CatalogCache {
  atoms?: unknown;
  container?: unknown;
  nested: Record<string, unknown>;
}

async function loadFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

async function loadNestedDir(dir: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const full = join(dir, f);
    try {
      const s = await stat(full);
      if (!s.isFile()) continue;
      out[basename(f, '.json')] = await loadFile(full);
    } catch {
      // Single-file load-Fehler nicht fatal; das nested-Set ist additiv.
    }
  }
  return out;
}

async function loadCatalog(ref: CatalogToolRef): Promise<CatalogCache> {
  const cwd = process.cwd();
  const cache: CatalogCache = { nested: {} };
  const files = ref.config.files;
  if (files.atoms) {
    cache.atoms = await loadFile(pathResolve(cwd, files.atoms));
  }
  if (files.container) {
    cache.container = await loadFile(pathResolve(cwd, files.container));
  }
  if (files.nested) {
    cache.nested = await loadNestedDir(pathResolve(cwd, files.nested));
  }
  return cache;
}

export async function resolveCatalog(ref: CatalogToolRef): Promise<CatalogHandle> {
  // Eager load — Catalog ist statisch + klein genug, Lazy bringt nichts.
  const cache = await loadCatalog(ref);

  return {
    name: ref.name,
    kind: 'catalog',
    meta: { containerId: ref.config.containerId },
    get<T = unknown>(key: 'atoms' | 'container' | 'nested'): T {
      if (key === 'atoms') {
        if (cache.atoms === undefined) {
          throw new Error(`[catalog:${ref.name}] no atoms file declared`);
        }
        return cache.atoms as T;
      }
      if (key === 'container') {
        if (cache.container === undefined) {
          throw new Error(`[catalog:${ref.name}] no container file declared`);
        }
        return cache.container as T;
      }
      // 'nested'
      return cache.nested as T;
    },
    health: () => probeCatalogHealth(ref, cache),
  };
}

export async function probeCatalogHealth(
  ref: CatalogToolRef,
  cache?: CatalogCache,
): Promise<ToolHealth> {
  const t0 = Date.now();
  try {
    const c = cache ?? (await loadCatalog(ref));
    const have =
      (c.atoms !== undefined ? 1 : 0) +
      (c.container !== undefined ? 1 : 0) +
      Object.keys(c.nested).length;
    if (have === 0) {
      return {
        name: ref.name,
        kind: 'catalog',
        configured: false,
        alive: false,
        latencyMs: Date.now() - t0,
        lastError: 'no catalog files found',
      };
    }
    return {
      name: ref.name,
      kind: 'catalog',
      configured: true,
      alive: true,
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      name: ref.name,
      kind: 'catalog',
      configured: false,
      alive: false,
      latencyMs: Date.now() - t0,
      lastError: (e as Error).message,
    };
  }
}
