/**
 * Provider-agnostic embedding wrapper. Two backends:
 *   - 'ollama'  → POST {OLLAMA_URL}/api/embeddings (default for local / on-prem)
 *   - 'mistral' → POST https://api.mistral.ai/v1/embeddings (cloud, billed)
 *
 * Used by the v2 embed-cascade Stage C (cosine similarity over precomputed
 * catalog embeddings) and by Stage E LLM-Reason for query construction.
 *
 * Design notes:
 *   - bge-m3 (Ollama) and mistral-embed both produce 1024-dim vectors. The
 *     cosineTopK helper assumes both query and index were embedded with the
 *     SAME model — caller is responsible for matching.
 *   - In-memory ANN is unnecessary at the catalog scale (4-35k vectors). We
 *     do brute-force cosine; ~5 ms per query for 5k vectors at 1024 dim.
 *   - Embeddings are cached per-text (sha256 → vector) so repeat queries
 *     don't re-bill / re-compute. Cache is process-local; for batch
 *     preprocessing scripts the cache lives for the script's lifetime.
 */

import { createHash } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export type EmbedProvider = 'ollama' | 'mistral';

export interface EmbedOptions {
  provider?: EmbedProvider;
  /** Ollama: 'bge-m3' or 'nomic-embed-text'. Mistral: 'mistral-embed' */
  model?: string;
  /** Override Ollama base URL. Default uses env or http://localhost:11434 */
  ollamaUrl?: string;
  signal?: AbortSignal;
}

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = process.env.EMBED_MODEL_OLLAMA ?? 'bge-m3';
const DEFAULT_MISTRAL_MODEL = process.env.EMBED_MODEL_MISTRAL ?? 'mistral-embed';
const DEFAULT_PROVIDER: EmbedProvider =
  (process.env.EMBED_PROVIDER as EmbedProvider | undefined) ?? 'ollama';

// ─────────────────────────────────────────────────────────────────────────────
// Provider implementations
// ─────────────────────────────────────────────────────────────────────────────

async function embedOllama(
  text: string,
  model: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Ollama embed ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { embedding?: number[] };
  if (!data.embedding) throw new Error('Ollama returned no embedding');
  return new Float32Array(data.embedding);
}

async function embedMistral(
  text: string,
  model: string,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set (required for mistral provider)');
  const res = await fetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: [text] }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Mistral embed ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const emb = data.data?.[0]?.embedding;
  if (!emb) throw new Error('Mistral returned no embedding');
  return new Float32Array(emb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, Float32Array>();

function cacheKey(text: string, provider: string, model: string): string {
  return createHash('sha256').update(`${provider}:${model}:${text}`).digest('hex');
}

export async function embed(text: string, opts: EmbedOptions = {}): Promise<Float32Array> {
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const model = opts.model ??
    (provider === 'mistral' ? DEFAULT_MISTRAL_MODEL : DEFAULT_OLLAMA_MODEL);
  const baseUrl = opts.ollamaUrl ?? DEFAULT_OLLAMA_URL;

  const k = cacheKey(text, provider, model);
  const cached = cache.get(k);
  if (cached) return cached;

  const result = provider === 'mistral'
    ? await embedMistral(text, model, opts.signal)
    : await embedOllama(text, model, baseUrl, opts.signal);
  cache.set(k, result);
  return result;
}

/** Embed many texts; sequential per-call but caches. For batch, use embedBatch */
export async function embedAll(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const t of texts) out.push(await embed(t, opts));
  return out;
}

/**
 * Mistral supports batch via the same /v1/embeddings endpoint with input: [...].
 * Ollama does not (yet); use embedAll for that.
 */
export async function embedBatch(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<Float32Array[]> {
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  if (provider !== 'mistral') return embedAll(texts, opts);
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set');
  const model = opts.model ?? DEFAULT_MISTRAL_MODEL;
  const res = await fetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST',
    signal: opts.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Mistral batch embed ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  return (data.data ?? []).map((d) => new Float32Array(d.embedding ?? []));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cosine search
// ─────────────────────────────────────────────────────────────────────────────

/** Compute cosine similarity. Both vectors must be the same length. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface IndexEntry {
  id: string;        // arbitrary identifier — typically eCode
  vector: Float32Array;
  meta?: Record<string, unknown>;
}

/** Top-K by cosine similarity. Brute force, O(n * dim). */
export function cosineTopK(
  query: Float32Array,
  index: IndexEntry[],
  k = 10,
): Array<{ id: string; score: number; meta?: Record<string, unknown> }> {
  const scored = index.map((e) => ({
    id: e.id,
    score: cosine(query, e.vector),
    meta: e.meta,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundled index loader: reads a binary-blob + JSON sidecar produced by
// scripts/preprocess-lane3-embeddings.mjs and similar.
//
// File layout:
//   <name>.bin      — Float32Array concatenation: count * dim * 4 bytes
//   <name>.meta.json — { dim, count, model, provider, entries: [{id, meta?}, ...] }
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';

export interface BundledIndex {
  dim: number;
  model: string;
  provider: EmbedProvider;
  entries: IndexEntry[];
}

export async function loadBundledIndex(
  binPath: string,
  metaPath: string,
): Promise<BundledIndex> {
  const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as {
    dim: number;
    count: number;
    model: string;
    provider: EmbedProvider;
    entries: Array<{ id: string; meta?: Record<string, unknown> }>;
  };
  const buf = await readFile(binPath);
  if (buf.length !== meta.count * meta.dim * 4) {
    throw new Error(
      `Bundled index size mismatch: ${binPath} is ${buf.length} bytes, ` +
      `expected ${meta.count} * ${meta.dim} * 4 = ${meta.count * meta.dim * 4}`,
    );
  }
  // View as Float32. Aligned read since Buffer's underlying ArrayBuffer is
  // 8-byte aligned in modern Node.
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, meta.count * meta.dim);
  const entries: IndexEntry[] = meta.entries.map((e, i) => ({
    id: e.id,
    vector: f32.subarray(i * meta.dim, (i + 1) * meta.dim),
    meta: e.meta,
  }));
  return { dim: meta.dim, model: meta.model, provider: meta.provider, entries };
}
