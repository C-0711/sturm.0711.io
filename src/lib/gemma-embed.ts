/**
 * EmbeddingGemma client (Ollama /api/embed).
 *
 * EmbeddingGemma-300m (google/embeddinggemma-300m, released Sept 2025) is
 * Google's Gemma-family text embedder: 308M params, multilingual (100+ langs,
 * German included), 2K-token context, Matryoshka output (768 → 512 → 256 → 128).
 * Top of the MTEB <500M class.
 *
 * Why Ollama, not vLLM:
 *   • Already running on H200V :11434 (memory: reference_h200v.md).
 *   • Fits in GPU 1's 3.9 GB free VRAM headroom without re-sharding Gemma-4.
 *   • Same client shape as the existing `nomic-embed-text` path.
 *
 * One-time host setup: `ollama pull embeddinggemma`.
 */

/**
 * Backend für EmbeddingGemma:
 *   • 'vllm'   — dedizierter vLLM-pooling-Server (OpenAI-kompatibel /v1/embeddings).
 *                Auf H200v läuft das mit --gpu-memory-utilization 0.05 = 7 GB,
 *                batch=30 in ~48 ms (vs Ollama-CPU ~5000 ms = 100× schneller).
 *   • 'ollama' — Fallback / Dev: POST /api/embed. Optional cpuOnly um GPU-
 *                Kontention mit Gemma-4-31B zu vermeiden.
 *
 * Default per env: EMBED_PROVIDER (vllm|ollama), Default 'ollama' für
 * backward compatibility. Auf Produktion sturm-mandanten setzen wir
 * EMBED_PROVIDER=vllm + EMBED_URL=http://host.docker.internal:11436.
 */
export type GemmaEmbedProvider = 'ollama' | 'vllm';

const DEFAULT_PROVIDER: GemmaEmbedProvider =
  (process.env.EMBED_PROVIDER as GemmaEmbedProvider | undefined) ?? 'ollama';
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DEFAULT_VLLM_URL = process.env.EMBED_URL ?? process.env.VLLM_EMBED_URL ?? 'http://localhost:11436';
const DEFAULT_URL = DEFAULT_PROVIDER === 'vllm' ? DEFAULT_VLLM_URL : DEFAULT_OLLAMA_URL;
const DEFAULT_MODEL = process.env.EMBED_MODEL ?? 'embeddinggemma';
/** Native EmbeddingGemma dim. Matryoshka truncation to 512/256/128 is allowed. */
export const EMBEDDINGGEMMA_DIM = 768;

export interface GemmaEmbedOptions {
  url?: string;
  model?: string;
  signal?: AbortSignal;
  /** Matryoshka truncation length (one of 768, 512, 256, 128). */
  dimensions?: number;
  /** Truncate input to model context length instead of erroring. Default true. */
  truncate?: boolean;
  /**
   * Backend override. Default aus env EMBED_PROVIDER.
   */
  provider?: GemmaEmbedProvider;
  /**
   * Force CPU inference auf Ollama (`options.num_gpu = 0`). Nur sinnvoll
   * wenn provider='ollama' UND der vLLM-Embedder-Slot nicht verfügbar ist.
   * Ignoriert bei provider='vllm'. Defaults to env `EMBED_CPU=1`.
   */
  cpuOnly?: boolean;
}

interface EmbedResponse {
  model: string;
  embeddings: number[][];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
}

export async function embedBatch(
  texts: string[],
  opts: GemmaEmbedOptions = {},
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const url = opts.url ?? (provider === 'vllm' ? DEFAULT_VLLM_URL : DEFAULT_OLLAMA_URL);
  const model = opts.model ?? DEFAULT_MODEL;
  return provider === 'vllm'
    ? embedBatchVllm(texts, url, model, opts)
    : embedBatchOllama(texts, url, model, opts);
}

async function embedBatchVllm(
  texts: string[],
  url: string,
  model: string,
  opts: GemmaEmbedOptions,
): Promise<Float32Array[]> {
  const body: Record<string, unknown> = { model, input: texts };
  if (opts.dimensions) body.dimensions = opts.dimensions;
  const res = await fetch(`${url}/v1/embeddings`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `vllm /v1/embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const j = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  if (!Array.isArray(j.data) || j.data.length !== texts.length) {
    throw new Error(
      `vllm /v1/embeddings: expected ${texts.length} rows, got ${j.data?.length}`,
    );
  }
  return j.data.map((d) => new Float32Array(d.embedding ?? []));
}

async function embedBatchOllama(
  texts: string[],
  url: string,
  model: string,
  opts: GemmaEmbedOptions,
): Promise<Float32Array[]> {
  const body: Record<string, unknown> = {
    model,
    input: texts,
    truncate: opts.truncate ?? true,
  };
  if (opts.dimensions) body.dimensions = opts.dimensions;
  const cpuOnly = opts.cpuOnly ?? process.env.EMBED_CPU === '1';
  if (cpuOnly) body.options = { num_gpu: 0 };

  const res = await fetch(`${url}/api/embed`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `ollama /api/embed ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const j = (await res.json()) as EmbedResponse;
  if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) {
    throw new Error(
      `ollama /api/embed: expected ${texts.length} rows, got ${j.embeddings?.length}`,
    );
  }
  return j.embeddings.map((v) => new Float32Array(v));
}

/** Convenience: single-text call. */
export async function embedOne(
  text: string,
  opts: GemmaEmbedOptions = {},
): Promise<Float32Array> {
  const [v] = await embedBatch([text], opts);
  return v;
}

// ─────────────────────────────────────────────────────────────────────────
// Task-specific prefixes
// ─────────────────────────────────────────────────────────────────────────
// EmbeddingGemma is **asymmetric** — the model was trained with explicit
// task-side prompts that gate the embedding space. Calling embedBatch on
// raw text yields a degraded embedding that mixes both sides; retrieval
// quality drops 3-7 MTEB points without these. Source:
// https://huggingface.co/google/embeddinggemma-300m

/** Format a document for the corpus side. Title is optional; "none" if absent. */
export function formatDocument(text: string, title?: string): string {
  return `title: ${title && title.length > 0 ? title : 'none'} | text: ${text}`;
}

/** Format a search query for the query side. */
export function formatQuery(text: string): string {
  return `task: search result | query: ${text}`;
}

/** Re-L2-normalize a Float32Array in place. MRL-truncated vectors must be
 * renormalized — the model card is explicit: "truncate the output embedding
 * to their desired size and then re-normalize". */
export function l2normalize(v: Float32Array): Float32Array {
  let n2 = 0;
  for (let i = 0; i < v.length; i++) n2 += v[i] * v[i];
  if (n2 === 0) return v;
  const inv = 1 / Math.sqrt(n2);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

/** Truncate to MRL dim and re-L2-normalize. No-op when dim === v.length. */
export function mrlTruncate(v: Float32Array, dim: number): Float32Array {
  if (dim === v.length) return v;
  if (dim > v.length) {
    throw new Error(`mrlTruncate: target dim ${dim} > native ${v.length}`);
  }
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = v[i];
  return l2normalize(out);
}

/** Embed corpus documents with the proper task prompt. Drops in for embedBatch
 * when you're building an index. `titles` is optional; omit for "none". */
export async function embedDocuments(
  texts: string[],
  titles?: (string | undefined)[],
  opts: GemmaEmbedOptions = {},
): Promise<Float32Array[]> {
  const formatted = texts.map((t, i) => formatDocument(t, titles?.[i]));
  return embedBatch(formatted, opts);
}

/** Embed search queries with the proper task prompt. */
export async function embedQueries(
  texts: string[],
  opts: GemmaEmbedOptions = {},
): Promise<Float32Array[]> {
  return embedBatch(texts.map(formatQuery), opts);
}

export const GEMMA_EMBED_DEFAULTS = {
  provider: DEFAULT_PROVIDER,
  url: DEFAULT_URL,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  vllmUrl: DEFAULT_VLLM_URL,
  model: DEFAULT_MODEL,
  nativeDim: EMBEDDINGGEMMA_DIM,
  matryoshkaDims: [768, 512, 256, 128] as const,
} as const;
