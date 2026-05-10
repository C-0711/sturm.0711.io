/**
 * Generic LLM JSON-chat wrapper. Two first-class providers:
 *   - 'mistral'  → api.mistral.ai/v1/chat/completions (cloud, billed,
 *                  best quality on German tax language)
 *   - 'ollama'   → {OLLAMA_URL}/api/chat (on-prem, free, GPU-accelerated;
 *                  default for dev / high-throughput)
 *
 * Default model per provider:
 *   mistral → 'mistral-small-latest' (fast/cheap), 'mistral-large-latest' (quality)
 *   ollama  → 'gemma4:e4b' (fast classify), 'gemma4:31b-128k' (quality Reason)
 *
 * Standard verticals use this for cascade LLM-fallback, nested-JSON extraction
 * (Layer 1), entity-resolution (Layer 2), embed-cascade Reason (Layer 3 Stage E).
 * The contract is intentionally small: text in, JSON out.
 */

const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

function mistralKey(): string {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY is not set');
  return key;
}

export type ChatProvider = 'mistral' | 'ollama' | 'vllm';

export interface ChatJsonOptions {
  provider?: ChatProvider;
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  /** Override Ollama base URL */
  ollamaUrl?: string;
  /** Override vLLM base URL (OpenAI-compatible /v1) */
  vllmUrl?: string;
  /** Optional system prompt prefixed before the user prompt */
  system?: string;
  /** max_tokens (vLLM/Mistral). Default 1024 */
  maxTokens?: number;
  /** Strict JSON-schema for constrained decoding. Supported by vLLM via
   *  response_format.json_schema. Mistral has limited support. Ollama ignores. */
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

const DEFAULT_VLLM_URL = process.env.VLLM_URL ?? 'http://localhost:11435';

export interface ChatJsonResult<T> {
  parsed: T;
  raw: string;
  usage: unknown;
}

/**
 * Call provider with response_format=json_object. Returns parsed JSON
 * (or empty object if reply is unparseable). Throws on HTTP error.
 */
export async function chatJson<T = unknown>(
  prompt: string,
  opts: ChatJsonOptions = {},
): Promise<ChatJsonResult<T>> {
  const provider = opts.provider ?? (process.env.CHAT_PROVIDER as ChatProvider | undefined) ?? 'mistral';
  switch (provider) {
    case 'mistral':
      return chatJsonMistral<T>(prompt, opts);
    case 'ollama':
      return chatJsonOllama<T>(prompt, opts);
    case 'vllm':
      return chatJsonVllm<T>(prompt, opts);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

/**
 * vLLM OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Used for Gemma-4 served by the H200V vLLM instance (model name 'gemma4-mm',
 * google/gemma-4-31b-it, tensor-parallel-size 2 across 2 H200 GPUs).
 *
 * vLLM does NOT support Mistral's `response_format: json_object` natively for
 * all models. We instead instruct via the prompt to emit JSON and parse-best-
 * effort. For models that DO support guided decoding (some vLLM builds), set
 * `guided_json` in the body.
 */
async function chatJsonVllm<T>(
  prompt: string,
  opts: ChatJsonOptions,
): Promise<ChatJsonResult<T>> {
  const baseUrl = opts.vllmUrl ?? DEFAULT_VLLM_URL;
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  // Append a strict-JSON nudge to the user prompt for non-guided builds
  const userContent = prompt.includes('NUR JSON') || prompt.includes('only JSON')
    ? prompt
    : prompt + '\n\nWICHTIG: Antworte ausschließlich mit gültigem JSON ohne Markdown-Codeblöcke und ohne Erklärungstext davor oder danach.';
  messages.push({ role: 'user', content: userContent });
  const body: Record<string, unknown> = {
    model: opts.model ?? 'gemma4-mm',
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 1024,
    messages,
  };
  // vLLM-Gemma supports OpenAI response_format.json_schema with strict mode —
  // GUARANTEES schema-compliant output at the token-generation level (no post-hoc parsing).
  if (opts.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: opts.jsonSchema.name,
        strict: opts.jsonSchema.strict !== false,
        schema: opts.jsonSchema.schema,
      },
    };
  }
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`vLLM chat ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  const raw = data.choices?.[0]?.message?.content ?? '{}';
  // Strip ```json fences if present
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Find the first { … } block
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let parsed: T;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(stripped.slice(start, end + 1)) as T; }
    catch { parsed = {} as T; }
  } else {
    parsed = {} as T;
  }
  return { parsed, raw, usage: data.usage };
}

async function chatJsonMistral<T>(
  prompt: string,
  opts: ChatJsonOptions,
): Promise<ChatJsonResult<T>> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });
  const res = await fetch(`${MISTRAL_API_BASE}/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${mistralKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model ?? 'mistral-small-latest',
      response_format: { type: 'json_object' },
      temperature: opts.temperature ?? 0,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mistral chat ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  const raw = data.choices?.[0]?.message?.content ?? '{}';
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    parsed = {} as T;
  }
  return { parsed, raw, usage: data.usage };
}

async function chatJsonOllama<T>(
  prompt: string,
  opts: ChatJsonOptions,
): Promise<ChatJsonResult<T>> {
  const baseUrl = opts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? 'gemma4:e4b',
      // Ollama supports format:json since v0.1.20 — forces strict JSON
      format: 'json',
      options: { temperature: opts.temperature ?? 0 },
      messages,
      stream: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama chat ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    message?: { content?: string };
    eval_count?: number;
    prompt_eval_count?: number;
  };
  const raw = data.message?.content ?? '{}';
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    parsed = {} as T;
  }
  return {
    parsed,
    raw,
    usage: { prompt_tokens: data.prompt_eval_count, completion_tokens: data.eval_count },
  };
}
