/**
 * EmbeddingGemma client (Ollama /api/embed).
 *
 * EmbeddingGemma-300m (google/embeddinggemma-300m, released Sept 2025) is
 * Google's Gemma-family text embedder: 308M params, multilingual (100+ langs,
 * German included), 2K-token context, Matryoshka output (768 → 512 → 256 → 128).
 * Top of the MTEB <500M class.
 *
 * Why Ollama (and ONLY Ollama):
 *   • The v0.5.8 catalog was built against Ollama's BF16 GGUF variant
 *     (`embeddinggemma:300m-bf16`, gemma3 architecture, pooling_type=1=MEAN).
 *   • Ollama's llama.cpp tokenizer auto-prepends BOS + appends EOS
 *     (`add_bos_token=true, add_eos_token=true`). A vLLM-served instance of
 *     the same `google/embeddinggemma-300m` does NOT add those by default,
 *     so the same input text produces different token sequences and
 *     therefore different embeddings — cosines drop ~0.2 across the board.
 *   • Bottom line: catalog and query embed MUST come from the same backend.
 *     The catalog is sealed at v0.5.8; query side stays on Ollama.
 *
 * Setup (one-time on H200V):
 *   ssh h200v 'curl -X POST localhost:11434/api/pull -d "{\"name\":\"embeddinggemma\"}"'
 *
 * Container path: `OLLAMA_URL=http://host.docker.internal:11434` in env.
 */

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DEFAULT_MODEL = process.env.EMBED_MODEL ?? 'embeddinggemma';
const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.EMBED_FETCH_TIMEOUT_MS ?? 30000);
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
   * Force CPU inference (`options.num_gpu = 0`). Needed when GPUs are
   * saturated by vLLM Gemma-4 — Ollama embed OOMs on GPU load.
   * Defaults to env `EMBED_CPU=1` if set.
   */
  cpuOnly?: boolean;
  /** Per-fetch timeout in ms. Default 30000 (env EMBED_FETCH_TIMEOUT_MS). */
  fetchTimeoutMs?: number;
}

interface EmbedResponse {
  model: string;
  embeddings: number[][];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`embed fetch timeout after ${timeoutMs}ms`)), timeoutMs);
  const onExternalAbort = () => ctrl.abort(externalSignal?.reason ?? new Error('aborted'));
  externalSignal?.addEventListener('abort', onExternalAbort);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function embedBatch(
  texts: string[],
  opts: GemmaEmbedOptions = {},
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const url = (opts.url ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const model = opts.model ?? DEFAULT_MODEL;
  const body: Record<string, unknown> = {
    model,
    input: texts,
    truncate: opts.truncate ?? true,
  };
  if (opts.dimensions) body.dimensions = opts.dimensions;
  const cpuOnly = opts.cpuOnly ?? process.env.EMBED_CPU === '1';
  if (cpuOnly) body.options = { num_gpu: 0 };

  const timeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const res = await fetchWithTimeout(
    `${url}/api/embed`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
    opts.signal,
  );
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
  url: DEFAULT_OLLAMA_URL,
  model: DEFAULT_MODEL,
  nativeDim: EMBEDDINGGEMMA_DIM,
  matryoshkaDims: [768, 512, 256, 128] as const,
} as const;
