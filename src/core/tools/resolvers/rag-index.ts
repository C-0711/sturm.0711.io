/**
 * RAG-Index-Resolver. Lazy-Load des `QuantumCascade` via
 * `loadFromManifest(dir, manifest, finalK)`. Pro Anwendung wird das Manifest
 * geparst, der Cascade aber erst beim ersten `retrieve()`-Call materialisiert,
 * **es sei denn** `ref.alwaysOn === true` (dann eager beim Resolve).
 *
 * **Sharing** über alle Anwendungen hinweg: gleiche `containerId + manifest`
 * → gleiches `Promise<QuantumCascade>`. Damit teilen sich zwei Anwendungen,
 * die denselben Container ansprechen, den In-Memory-Index — kein Doppel-Load.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve as pathResolve } from 'node:path';

import { QuantumCascade, type CascadeManifest } from '../../../lib/quantum-index.ts';
import {
  embedOne as gemmaEmbedOne,
  formatQuery,
  mrlTruncate,
} from '../../../lib/gemma-embed.ts';
import type { RagIndexToolRef, ToolHealth } from '../types.ts';
import type { RagIndexHandle, RagHit } from '../handles.ts';

// ── Modul-scope Index-Registry (per-Prozess-Sharing) ───────────────────

interface LoadedCascade {
  cascade: QuantumCascade;
  nativeDim: number;
  totalVectors: number;
}

const cascadeRegistry = new Map<string, Promise<LoadedCascade>>();

function registryKey(ref: RagIndexToolRef): string {
  return `${ref.config.containerId}::${ref.config.manifest}`;
}

function defaultFinalK(ref: RagIndexToolRef): number {
  // Bevorzuge fp32-tier, dann d768, dann d256, sonst d128.
  return (
    ref.config.topK.fp32 ?? ref.config.topK.d768 ?? ref.config.topK.d256 ?? ref.config.topK.d128 ?? 16
  );
}

async function loadCascade(ref: RagIndexToolRef): Promise<LoadedCascade> {
  const manifestPath = pathResolve(process.cwd(), ref.config.manifest);
  const raw = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw) as CascadeManifest;
  const dir = dirname(manifestPath);
  const finalK = defaultFinalK(ref);
  const cascade = await QuantumCascade.loadFromManifest(dir, manifest, finalK);
  const lastTier = manifest.tiers[manifest.tiers.length - 1];
  return {
    cascade,
    nativeDim: manifest.nativeDim,
    totalVectors: lastTier?.n ?? 0,
  };
}

/** Holt (oder erzeugt) die geteilte `Promise<LoadedCascade>` für diesen Ref. */
function shared(ref: RagIndexToolRef): Promise<LoadedCascade> {
  const key = registryKey(ref);
  let p = cascadeRegistry.get(key);
  if (!p) {
    p = loadCascade(ref);
    cascadeRegistry.set(key, p);
    // Wenn der Load fehlschlägt, Eintrag wieder freigeben — sonst bleibt der
    // Fehler bis Prozess-Ende cached.
    p.catch(() => cascadeRegistry.delete(key));
  }
  return p;
}

/** Nur für Tests: registry leeren. */
export function _resetRagRegistry(): void {
  cascadeRegistry.clear();
}

/** Nur für Tests: Anzahl gecachter Einträge. */
export function _ragRegistrySize(): number {
  return cascadeRegistry.size;
}

// ── Embedder für Queries ───────────────────────────────────────────────

async function embedQuery(text: string, dim: number, signal?: AbortSignal): Promise<Float32Array> {
  const v = await gemmaEmbedOne(formatQuery(text), { signal });
  // EmbeddingGemma native = 768, wir trunc'en auf nativeDim des Cascades.
  if (v.length === dim) return v;
  return mrlTruncate(v, dim);
}

// ── Public Resolver ────────────────────────────────────────────────────

export async function resolveRagIndex(ref: RagIndexToolRef): Promise<RagIndexHandle> {
  // Eager load wenn alwaysOn=true
  if (ref.alwaysOn) {
    // Fire-and-forget, Fehler bubble'n beim ersten retrieve() hoch.
    void shared(ref);
  }

  const retrieveImpl: RagIndexHandle['retrieve'] = async (query, opts = {}) => {
    const loaded = await shared(ref);
    const topK = opts.topK ?? defaultFinalK(ref);
    let qVec: Float32Array;
    if (typeof query === 'string') {
      qVec = await embedQuery(query, loaded.nativeDim, opts.signal);
    } else {
      qVec = new Float32Array(query);
    }
    // tier wird im P2 als "use cascade and trim to topK" interpretiert — eine
    // explizite Single-Tier-API kommt erst, wenn ein Stage das wirklich braucht.
    const hits = loaded.cascade.topK(qVec, topK);
    return hits.map<RagHit>((h) => ({
      id: String(h.idx),
      score: h.score,
    }));
  };

  const retrieveCascadeImpl: RagIndexHandle['retrieveCascade'] = async (query, opts = {}) => {
    return retrieveImpl(query, { topK: opts.topK, signal: opts.signal });
  };

  return {
    name: ref.name,
    kind: 'rag-index',
    meta: { containerId: ref.config.containerId, vectors: 0 },
    retrieve: retrieveImpl,
    retrieveCascade: retrieveCascadeImpl,
    health: () => probeRagHealth(ref),
  };
}

export async function probeRagHealth(ref: RagIndexToolRef): Promise<ToolHealth> {
  const t0 = Date.now();
  try {
    // Manifest-Datei muss existieren + parsebar sein. Wir lesen sie nur, ohne
    // .bin-Tiers zu laden — das macht der erste Retrieve.
    const manifestPath = pathResolve(process.cwd(), ref.config.manifest);
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as CascadeManifest;
    const configured = Array.isArray(manifest.tiers) && manifest.tiers.length > 0;
    return {
      name: ref.name,
      kind: 'rag-index',
      configured,
      alive: configured,
      latencyMs: Date.now() - t0,
      ...(configured ? {} : { lastError: 'manifest has no tiers' }),
    };
  } catch (e) {
    return {
      name: ref.name,
      kind: 'rag-index',
      configured: false,
      alive: false,
      latencyMs: Date.now() - t0,
      lastError: (e as Error).message,
    };
  }
}
