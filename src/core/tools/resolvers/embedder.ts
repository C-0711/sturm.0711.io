/**
 * Embedder-Resolver. Wickelt `src/lib/gemma-embed.ts` (Ollama) und
 * `src/lib/embedding-runtime.ts` (Mistral) in einen `EmbedderHandle`.
 *
 * Health-Check: GET ${OLLAMA_URL}/api/tags für Ollama, MISTRAL_API_KEY-Presence
 * für Mistral.
 */

import { embedBatch as gemmaEmbedBatch, mrlTruncate } from '../../../lib/gemma-embed.ts';
import { embedBatch as mistralEmbedBatch } from '../../../lib/embedding-runtime.ts';
import type { EmbedderToolRef, ToolHealth } from '../types.ts';
import type { EmbedderHandle } from '../handles.ts';

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export async function resolveEmbedder(ref: EmbedderToolRef): Promise<EmbedderHandle> {
  const provider = ref.config.provider;
  const meta = { provider, model: ref.config.model };

  const embedImpl: EmbedderHandle['embed'] = async (text, opts = {}) => {
    const texts = Array.isArray(text) ? text : [text];
    if (texts.length === 0) return [];
    let vectors: Float32Array[];
    if (provider === 'ollama') {
      vectors = await gemmaEmbedBatch(texts, {
        url: DEFAULT_OLLAMA_URL,
        model: ref.config.model,
        cpuOnly: ref.config.cpuOnly,
        signal: opts.signal,
      });
    } else {
      // Mistral path
      vectors = await mistralEmbedBatch(texts, {
        provider: 'mistral',
        model: ref.config.model,
        signal: opts.signal,
      });
    }
    // Matryoshka-Truncation, falls Caller `dim` setzt UND der Embedder das laut
    // Konfig auch erlaubt. Re-L2-Normalisierung übernimmt mrlTruncate.
    if (opts.dim && ref.config.matryoshka?.includes(opts.dim)) {
      vectors = vectors.map((v) => mrlTruncate(v, opts.dim!));
    }
    return vectors.map((v) => Array.from(v));
  };

  return {
    name: ref.name,
    kind: 'embedder',
    meta,
    embed: embedImpl,
    health: () => probeEmbedderHealth(ref),
  };
}

export async function probeEmbedderHealth(ref: EmbedderToolRef): Promise<ToolHealth> {
  const t0 = Date.now();
  try {
    if (ref.config.provider === 'ollama') {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), 3000);
      try {
        const r = await fetch(`${DEFAULT_OLLAMA_URL}/api/tags`, { signal: ac.signal });
        return {
          name: ref.name, kind: 'embedder',
          configured: true, alive: r.ok,
          latencyMs: Date.now() - t0,
          ...(r.ok ? {} : { lastError: `HTTP ${r.status}` }),
        };
      } finally {
        clearTimeout(timer);
      }
    }
    // mistral
    const ok = !!process.env.MISTRAL_API_KEY;
    return {
      name: ref.name, kind: 'embedder',
      configured: true, alive: ok,
      latencyMs: Date.now() - t0,
      ...(ok ? {} : { lastError: 'MISTRAL_API_KEY not set' }),
    };
  } catch (e) {
    return {
      name: ref.name, kind: 'embedder',
      configured: true, alive: false,
      latencyMs: Date.now() - t0,
      lastError: (e as Error).message,
    };
  }
}
