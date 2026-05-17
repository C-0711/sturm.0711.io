/**
 * llm-bench — minimaler Unified-Chat-Client für das Token-Savings-Experiment.
 *
 * Backends:
 *   • mistral  — cloud (MISTRAL_API_KEY)
 *   • ollama   — H200V (OLLAMA_URL, default http://localhost:11434)
 *
 * Beide Backends liefern echtes prompt/output Token-Accounting:
 *   • Mistral: response.usage.{prompt_tokens, completion_tokens, total_tokens}
 *   • Ollama:  response.{prompt_eval_count, eval_count} (renamed to prompt_tokens/completion_tokens)
 *
 * Kein Streaming hier — wir wollen die kompletten Antworten + Token-Counts
 * synchron für den Vergleich.
 */
import { retrieveFromContainer } from './ctx-shared.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ChatModel {
  label: string;            // for the results table, e.g. "mistral-small-latest"
  provider: 'mistral' | 'ollama';
  model: string;            // backend-side model id
  contextHint?: number;     // approximate context window in tokens (for headroom checks)
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  truncated: boolean;       // did we hit max_tokens?
  error?: string;
}

const MISTRAL_BASE = process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai';
const OLLAMA_BASE = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export async function chat(
  m: ChatModel,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 400;
  const temperature = opts.temperature ?? 0.2;
  const t0 = Date.now();
  try {
    if (m.provider === 'mistral') return await chatMistral(m.model, messages, maxTokens, temperature, opts.timeoutMs, t0);
    if (m.provider === 'ollama')  return await chatOllama(m.model, messages, maxTokens, temperature, opts.timeoutMs, t0);
    throw new Error(`unknown provider: ${m.provider}`);
  } catch (e) {
    return {
      content: '',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: Date.now() - t0,
      truncated: false,
      error: (e as Error).message,
    };
  }
}

async function chatMistral(
  model: string, messages: ChatMessage[], maxTokens: number, temperature: number,
  timeoutMs = 60000, t0 = Date.now(),
): Promise<ChatResult> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set');
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(`${MISTRAL_BASE}/v1/chat/completions`, {
    method: 'POST',
    signal: ac.signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });
  clearTimeout(tid);
  if (!res.ok) throw new Error(`mistral ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as {
    choices: Array<{ message: { content: string }; finish_reason?: string }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  const choice = j.choices[0];
  return {
    content: choice.message.content,
    promptTokens: j.usage.prompt_tokens,
    completionTokens: j.usage.completion_tokens,
    totalTokens: j.usage.total_tokens,
    latencyMs: Date.now() - t0,
    truncated: choice.finish_reason === 'length',
  };
}

async function chatOllama(
  model: string, messages: ChatMessage[], maxTokens: number, temperature: number,
  timeoutMs = 240000, t0 = Date.now(),
): Promise<ChatResult> {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    signal: ac.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: false,
      options: { num_predict: maxTokens, temperature },
    }),
  });
  clearTimeout(tid);
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as {
    message: { content: string };
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const prompt_tokens = j.prompt_eval_count ?? 0;
  const completion_tokens = j.eval_count ?? 0;
  return {
    content: j.message?.content ?? '',
    promptTokens: prompt_tokens,
    completionTokens: completion_tokens,
    totalTokens: prompt_tokens + completion_tokens,
    latencyMs: Date.now() - t0,
    truncated: j.done_reason === 'length',
  };
}

// ─────────────────────────────────────────────────────────────────────
// Context-building helpers for the bench
// ─────────────────────────────────────────────────────────────────────

export async function buildBaselineContext(containerOutDir: string): Promise<string> {
  // Baseline = "dump the whole transcript as context"
  return readFile(join(containerOutDir, 'source.txt'), 'utf8');
}

export interface CtxRetrieval {
  hits: Array<{ slug: string; score: number; preview: string; path?: string; symbol?: string; body: string }>;
  context: string;          // concatenated atom bodies, marker-separated
}

export async function buildCtxRetrievedContext(
  containerOutDir: string,
  query: string,
  k: number,
  opts: { ollamaUrl?: string; embedCpu?: boolean } = {},
): Promise<CtxRetrieval> {
  const previews = await retrieveFromContainer(containerOutDir, query, k, opts);
  // For the LLM prompt we need the FULL atom body, not just previews.
  const hits = await Promise.all(previews.map(async (h) => {
    const text = await readFile(join(containerOutDir, 'atoms', 'code', `${h.slug}.md`), 'utf8').catch(() => '');
    const body = text.replace(/^---\n[\s\S]*?\n---\n\n?/, '').trim();
    return { ...h, body };
  }));
  const context = hits.map((h, i) =>
    `### atom ${i + 1} — ${h.path ?? '?'}#${h.symbol ?? '?'} (score=${h.score.toFixed(3)})\n${h.body}`,
  ).join('\n\n---\n\n');
  return { hits, context };
}
