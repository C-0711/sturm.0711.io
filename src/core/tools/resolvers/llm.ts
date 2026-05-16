/**
 * LLM-Resolver. Wickelt `src/lib/llm-chat.ts → chatJson` in einen `LlmHandle`.
 *
 * Health-Check:
 *   - vllm/ollama  → GET ${baseUrl}/v1/models bzw. /api/tags (kein Token-Spend)
 *   - mistral      → Presence-Check für MISTRAL_API_KEY (kein Bill-fähiger Call)
 *   - anthropic    → Presence-Check für ANTHROPIC_API_KEY (dito)
 */

import { chatJson, type ChatJsonOptions, type ChatProvider } from '../../../lib/llm-chat.ts';
import type { LlmToolRef, ToolHealth } from '../types.ts';
import type { LlmHandle, ChatMessage, LlmChatOptions } from '../handles.ts';

const DEFAULT_VLLM_URL = process.env.VLLM_URL ?? 'http://localhost:11435';
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

function resolveBaseUrl(ref: LlmToolRef): string | undefined {
  const fromEnv = ref.config.envBaseUrl ? process.env[ref.config.envBaseUrl] : undefined;
  if (fromEnv) return fromEnv;
  if (ref.config.baseUrl) return ref.config.baseUrl;
  if (ref.config.provider === 'vllm') return DEFAULT_VLLM_URL;
  if (ref.config.provider === 'ollama') return DEFAULT_OLLAMA_URL;
  return undefined;
}

/** Folde ein Messages-Array auf den einfacheren `chatJson`-Aufruf (string + system). */
function fold(prompt: string | ChatMessage[]): { prompt: string; system?: string } {
  if (typeof prompt === 'string') return { prompt };
  const sys = prompt.filter((m) => m.role === 'system').map((m) => m.content).join('\n').trim();
  const rest = prompt.filter((m) => m.role !== 'system');
  // Multi-Turn-Folding: User/Assistant abwechselnd, separator-blank-line.
  const folded = rest.map((m) => (m.role === 'assistant' ? `[assistant]: ${m.content}` : m.content)).join('\n\n');
  return { prompt: folded, system: sys || undefined };
}

export async function resolveLlm(ref: LlmToolRef): Promise<LlmHandle> {
  const baseUrl = resolveBaseUrl(ref);

  const meta = { provider: ref.config.provider, model: ref.config.model };

  const chatJsonImpl: LlmHandle['chatJson'] = async <T = unknown>(
    prompt: string | ChatMessage[],
    opts: LlmChatOptions = {},
  ): Promise<T> => {
    const folded = fold(prompt);
    const chatOpts: ChatJsonOptions = {
      provider: ref.config.provider as ChatProvider,
      model: ref.config.model,
      temperature: opts.temperature ?? ref.config.defaultTemperature ?? 0,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      system: folded.system,
    };
    if (ref.config.provider === 'vllm' && baseUrl) chatOpts.vllmUrl = baseUrl;
    if (ref.config.provider === 'ollama' && baseUrl) chatOpts.ollamaUrl = baseUrl;
    if (opts.schema) {
      // Normalize to the strict `{name, schema, strict}` shape llm-chat erwartet.
      const s = opts.schema as Record<string, unknown>;
      if ('schema' in s && typeof s.schema === 'object') {
        chatOpts.jsonSchema = {
          name: (s.name as string | undefined) ?? `${ref.name}-schema`,
          schema: s.schema as Record<string, unknown>,
          strict: (s.strict as boolean | undefined) ?? true,
        };
      } else {
        chatOpts.jsonSchema = {
          name: `${ref.name}-schema`,
          schema: s,
          strict: true,
        };
      }
    }
    const res = await chatJson<T>(folded.prompt, chatOpts);
    return res.parsed;
  };

  return {
    name: ref.name,
    kind: 'llm',
    meta,
    chatJson: chatJsonImpl,
    health: () => probeLlmHealth(ref, baseUrl),
  };
}

/** Exported für Tests + Container-healthAll. */
export async function probeLlmHealth(ref: LlmToolRef, baseUrl?: string): Promise<ToolHealth> {
  const t0 = Date.now();
  const provider = ref.config.provider;
  try {
    if (provider === 'vllm') {
      if (!baseUrl) return notConfigured(ref, 'no baseUrl (envBaseUrl unset, no default)');
      const res = await fetchWithTimeout(`${baseUrl}/v1/models`, 3000);
      return shaped(ref, res.ok, Date.now() - t0, res.ok ? undefined : `HTTP ${res.status}`);
    }
    if (provider === 'ollama') {
      if (!baseUrl) return notConfigured(ref, 'no baseUrl');
      const res = await fetchWithTimeout(`${baseUrl}/api/tags`, 3000);
      return shaped(ref, res.ok, Date.now() - t0, res.ok ? undefined : `HTTP ${res.status}`);
    }
    if (provider === 'mistral') {
      const ok = !!process.env.MISTRAL_API_KEY;
      return shaped(ref, ok, Date.now() - t0, ok ? undefined : 'MISTRAL_API_KEY not set');
    }
    if (provider === 'anthropic') {
      const ok = !!process.env.ANTHROPIC_API_KEY;
      return shaped(ref, ok, Date.now() - t0, ok ? undefined : 'ANTHROPIC_API_KEY not set');
    }
    return shaped(ref, false, Date.now() - t0, `unknown provider: ${provider as string}`);
  } catch (e) {
    return shaped(ref, false, Date.now() - t0, (e as Error).message);
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('timeout')), ms);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function shaped(ref: LlmToolRef, alive: boolean, latencyMs: number, lastError?: string): ToolHealth {
  return {
    name: ref.name,
    kind: 'llm',
    configured: true,
    alive,
    latencyMs,
    ...(lastError ? { lastError } : {}),
  };
}

function notConfigured(ref: LlmToolRef, why: string): ToolHealth {
  return { name: ref.name, kind: 'llm', configured: false, alive: false, lastError: why };
}
