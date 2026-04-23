const API_BASE = 'https://api.mistral.ai/v1';

function apiKey(): string {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY is not set');
  return key;
}

export interface ChatJsonOptions {
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Calls Mistral /v1/chat/completions with response_format=json_object.
 * Returns the parsed JSON (or an empty object if the reply is unparseable).
 */
export async function chatJson<T = unknown>(
  prompt: string,
  opts: ChatJsonOptions = {},
): Promise<{ parsed: T; raw: string; usage: unknown }> {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model ?? 'mistral-small-latest',
      response_format: { type: 'json_object' },
      temperature: opts.temperature ?? 0,
      messages: [{ role: 'user', content: prompt }],
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
