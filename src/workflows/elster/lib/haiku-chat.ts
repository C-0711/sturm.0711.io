const API_BASE = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return key;
}

export interface ChatJsonOptions {
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  maxTokens?: number;
}

/**
 * Ruft die Anthropic-API mit einem User-Prompt auf und erwartet ein JSON-Objekt
 * als Text-Antwort (response_format gibt's bei Anthropic nicht; wir parsen
 * defensiv den ersten {...}-Block aus dem Content).
 *
 * Default-Modell ist claude-haiku-4-5 (schnell, günstig, präzise bei klar
 * strukturierten Extraktions-Prompts).
 */
export async function chatJson<T = unknown>(
  prompt: string,
  opts: ChatJsonOptions = {},
): Promise<{ parsed: T; raw: string; usage: unknown }> {
  const model = opts.model ?? 'claude-haiku-4-5';
  const body = {
    model,
    max_tokens: opts.maxTokens ?? 8000,
    messages: [{ role: 'user', content: prompt }],
    // Haiku unterstützt temperature weiterhin; nur Opus-4-7 schloss das aus.
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };

  const res = await fetch(API_BASE, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'x-api-key': apiKey(),
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Haiku chat ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: unknown;
  };

  const raw = (data.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');

  // JSON-Block extrahieren — Haiku antwortet manchmal mit ```json fences oder
  // einem erklärenden Satz davor. Wir greifen das erste {...} auf.
  let parsed: T = {} as T;
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      parsed = JSON.parse(match[0]) as T;
    } catch {
      parsed = {} as T;
    }
  }

  return { parsed, raw, usage: data.usage };
}
