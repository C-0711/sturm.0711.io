/**
 * Anthropic Claude JSON client.
 * Mirrors mistral-chat.ts shape so callsites can swap providers per-stage.
 * Supports Opus / Sonnet / Haiku 4.x.  Opus 4.7 rejects `temperature`, so we
 * only send it when the model string contains "4-5" / "sonnet" / "haiku".
 */

const API_BASE = 'https://api.anthropic.com/v1';

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return key;
}

export type ClaudeModel =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-5'
  | 'claude-opus-4-5'
  | 'claude-opus-4-7';

export interface ClaudeChatJsonOptions {
  model?: ClaudeModel | string;
  /** Only applied to models that accept it (everything except opus-4-7). */
  temperature?: number;
  /** Max output tokens (default 2000). */
  maxTokens?: number;
  signal?: AbortSignal;
}

function acceptsTemperature(model: string): boolean {
  // Opus 4-7 "adaptive thinking" family doesn't accept temperature.
  return !/opus-4-7/.test(model);
}

/**
 * Calls Anthropic /v1/messages and extracts the first JSON object from the reply.
 * The prompt should instruct the model to answer with JSON only — we parse defensively.
 */
export async function claudeChatJson<T = unknown>(
  prompt: string,
  opts: ClaudeChatJsonOptions = {},
): Promise<{ parsed: T; raw: string; usage: unknown; model: string }> {
  const model = opts.model ?? 'claude-haiku-4-5';
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 2000,
    messages: [{ role: 'user', content: prompt }],
  };
  if (acceptsTemperature(model)) {
    body.temperature = opts.temperature ?? 0;
  }

  const res = await fetch(`${API_BASE}/messages`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'x-api-key': apiKey(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic chat ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: unknown;
    model?: string;
  };
  const textBlock = data.content?.find((c) => c.type === 'text');
  const raw = textBlock?.text ?? '{}';

  let parsed: T;
  try {
    // Strip possible markdown code fences, then grab outermost JSON object.
    const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    const jsonSlice = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
    parsed = JSON.parse(jsonSlice) as T;
  } catch {
    parsed = {} as T;
  }

  return { parsed, raw, usage: data.usage, model: data.model ?? model };
}
