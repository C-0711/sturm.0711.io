/**
 * llm/ensemble-vote — generischer N-Modell-Ensemble-Vote.
 *
 * Ruft N LLM-Provider parallel mit demselben Prompt (+ optionalem JSON-Schema)
 * auf, normalisiert die Antworten zu flachen Key→Value-Maps und stimmt pro
 * Top-Level-Key ab. Voting-Regel (default):
 *   • ≥3 von 4 stimmen überein → accept (origin: ENSEMBLE_OK, agreement: n)
 *   • 2/2-Split                → flag (origin: ENSEMBLE_TIE, agreement: 2)
 *   • alle uneinig              → flag (origin: ENSEMBLE_DISAGREE)
 *
 * Werte-Vergleich ist string-basiert (case- + whitespace-normalisiert). Für
 * tax-Felder (currency/date) ist das robust, weil die LLMs schon FSM-
 * constrained ausgeben. Für Freitextfelder ggf. tolerante Vergleichsmetrik
 * via cfg.equalityFn (TODO; aktuell nur strict).
 *
 * Diese Stage ist generisch: sie kennt den fachlichen Schema-Inhalt nicht.
 * Wer sie für ELSTER-Phase-3 wrappen will, baut darauf einen domänen-
 * spezifischen Wrapper, der canonical_layer-shape aus dem Ensemble-Ergebnis
 * zusammensetzt.
 */
import { defineStage } from '../core/stage.ts';
import { chatJson, type ChatProvider } from '../lib/llm-chat.ts';

export interface EnsembleModel {
  /** Frei wählbarer Bezeichner für die Voting-Tabelle. */
  name: string;
  provider: ChatProvider;
  /** Modell-ID beim Provider (z.B. 'gemma4-mm', 'claude-haiku-4-5'). */
  model: string;
  /** Optional: Provider-spezifische URL-Override (vllmUrl, ollamaUrl). */
  vllmUrl?: string;
  ollamaUrl?: string;
}

export interface LlmEnsembleVoteInput {
  /** Prompt, der allen Modellen identisch geschickt wird. */
  prompt: string;
  /** Optionales Strict-JSON-Schema (nur Provider mit Guided-Decoding nutzen es). */
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface LlmEnsembleVoteConfig {
  models: EnsembleModel[];
  /** Minimale Übereinstimmung für `ENSEMBLE_OK`. Default 3. */
  minAgreement?: number;
  /** Optional: System-Prompt (alle Modelle erhalten den gleichen). */
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Per-Modell-Timeout. Default 30s. */
  perModelTimeoutMs?: number;
}

export interface ConsensusValue {
  value: string | null;
  origin: 'ENSEMBLE_OK' | 'ENSEMBLE_TIE' | 'ENSEMBLE_DISAGREE' | 'ENSEMBLE_MISSING';
  agreement: number;
  totalModels: number;
  candidates: Array<{ value: string | null; models: string[] }>;
}

export interface LlmEnsembleVoteOutput {
  consensus: Record<string, ConsensusValue>;
  perModelRaw: Record<string, unknown>;
  perModelMs: Record<string, number>;
  errors: Record<string, string>;
  stats: {
    modelsCalled: number;
    modelsSucceeded: number;
    keysVoted: number;
    okKeys: number;
    tieKeys: number;
    disagreeKeys: number;
  };
  ms: number;
}

function normalize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim().toLowerCase();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export const llmEnsembleVoteStage = defineStage<
  LlmEnsembleVoteInput,
  LlmEnsembleVoteOutput,
  LlmEnsembleVoteConfig
>({
  id: 'llm/ensemble-vote',
  name: 'LLM Ensemble Vote — N-model parallel + per-key consensus',
  description:
    'Ruft N LLM-Provider parallel mit demselben Prompt + Schema auf und ' +
    'stimmt pro Top-Level-Key ab. Voting-Regel: ≥minAgreement (Default 3) ' +
    'gleiche Werte → ENSEMBLE_OK; 2/2-Split → ENSEMBLE_TIE; alle anders → ' +
    'ENSEMBLE_DISAGREE. Provider-Mix typisch: vLLM Gemma-4, Mistral-Small, ' +
    'Mistral-Large, Anthropic Claude Haiku.',
  hints: {
    inputs: 'prompt (string), optional jsonSchema',
    outputs: 'consensus map (per-key), perModelRaw, errors, stats',
    configExample: JSON.stringify(
      {
        models: [
          { name: 'gemma4', provider: 'vllm', model: 'gemma4-mm' },
          { name: 'mistral-small', provider: 'mistral', model: 'mistral-small-latest' },
          { name: 'mistral-large', provider: 'mistral', model: 'mistral-large-latest' },
          { name: 'claude-haiku', provider: 'anthropic', model: 'claude-haiku-4-5' },
        ],
        minAgreement: 3,
      },
      null,
      2,
    ),
    inputPorts: [
      { name: 'prompt', type: 'text' },
      { name: 'jsonSchema', type: 'json' },
    ],
    outputPorts: [
      { name: 'consensus', type: 'json' },
      { name: 'perModelRaw', type: 'json' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? ({} as LlmEnsembleVoteConfig);
    const models = cfg.models ?? [];
    const minAgreement = cfg.minAgreement ?? 3;
    const perModelTimeoutMs = cfg.perModelTimeoutMs ?? 30_000;

    if (!input.prompt || typeof input.prompt !== 'string') {
      throw new Error('llm/ensemble-vote: input.prompt required');
    }
    if (models.length === 0) {
      throw new Error('llm/ensemble-vote: config.models must have at least one entry');
    }

    const perModelRaw: Record<string, unknown> = {};
    const perModelMs: Record<string, number> = {};
    const errors: Record<string, string> = {};

    ctx.emit('ensemble_start', { models: models.map((m) => m.name) });

    // ── (1) Parallel calls ──────────────────────────────────────────────
    await Promise.all(
      models.map(async (m) => {
        const tM = Date.now();
        try {
          const timeoutAbort = new AbortController();
          const t = setTimeout(() => timeoutAbort.abort('timeout'), perModelTimeoutMs);
          // Tie our context signal to the per-model abort
          const onCtxAbort = () => timeoutAbort.abort('ctx-abort');
          ctx.signal.addEventListener('abort', onCtxAbort);
          try {
            const { parsed } = await chatJson<Record<string, unknown>>(input.prompt, {
              provider: m.provider,
              model: m.model,
              system: cfg.system,
              temperature: cfg.temperature ?? 0,
              maxTokens: cfg.maxTokens ?? 1024,
              vllmUrl: m.vllmUrl,
              ollamaUrl: m.ollamaUrl,
              jsonSchema: input.jsonSchema,
              signal: timeoutAbort.signal,
            });
            perModelRaw[m.name] = parsed ?? {};
            ctx.emit('ensemble_model_done', { model: m.name, ms: Date.now() - tM, keys: Object.keys(parsed ?? {}).length });
          } finally {
            ctx.signal.removeEventListener('abort', onCtxAbort);
            clearTimeout(t);
          }
        } catch (err) {
          errors[m.name] = (err as Error).message;
          ctx.emit('ensemble_model_error', { model: m.name, ms: Date.now() - tM, error: errors[m.name] });
        } finally {
          perModelMs[m.name] = Date.now() - tM;
        }
      }),
    );

    const modelsSucceeded = Object.keys(perModelRaw).length;

    // ── (2) Per-key vote ────────────────────────────────────────────────
    // Union of all keys across all model outputs.
    const allKeys = new Set<string>();
    for (const out of Object.values(perModelRaw)) {
      if (out && typeof out === 'object') {
        for (const k of Object.keys(out as Record<string, unknown>)) allKeys.add(k);
      }
    }

    const consensus: Record<string, ConsensusValue> = {};
    let okKeys = 0;
    let tieKeys = 0;
    let disagreeKeys = 0;

    for (const key of allKeys) {
      // Collect (normalized) values per model.
      const bucket = new Map<string, { value: string | null; rawValue: unknown; models: string[] }>();
      for (const [modelName, out] of Object.entries(perModelRaw)) {
        if (!out || typeof out !== 'object') continue;
        const v = (out as Record<string, unknown>)[key];
        const n = normalize(v);
        const k = n ?? '__NULL__';
        const ex = bucket.get(k);
        if (ex) ex.models.push(modelName);
        else bucket.set(k, { value: n, rawValue: v, models: [modelName] });
      }
      const candidates = Array.from(bucket.values()).map((b) => ({
        value: (b.rawValue ?? null) as string | null,
        models: b.models,
      }));
      // Rank by # of models supporting the candidate.
      candidates.sort((a, b) => b.models.length - a.models.length);
      const top = candidates[0];
      const secondCount = candidates[1]?.models.length ?? 0;
      const agreement = top.models.length;

      let origin: ConsensusValue['origin'];
      if (top.value === null && agreement === models.length) {
        origin = 'ENSEMBLE_MISSING';
      } else if (agreement >= minAgreement) {
        origin = 'ENSEMBLE_OK';
        okKeys++;
      } else if (agreement === secondCount && agreement >= 2) {
        origin = 'ENSEMBLE_TIE';
        tieKeys++;
      } else {
        origin = 'ENSEMBLE_DISAGREE';
        disagreeKeys++;
      }

      consensus[key] = {
        value: top.value,
        origin,
        agreement,
        totalModels: models.length,
        candidates,
      };
    }

    await ctx.artifacts.write('consensus.json', consensus);
    await ctx.artifacts.write('per_model_raw.json', perModelRaw);
    ctx.emit('ensemble_done', {
      modelsCalled: models.length,
      modelsSucceeded,
      keysVoted: allKeys.size,
      okKeys,
      tieKeys,
      disagreeKeys,
    });

    return {
      consensus,
      perModelRaw,
      perModelMs,
      errors,
      stats: {
        modelsCalled: models.length,
        modelsSucceeded,
        keysVoted: allKeys.size,
        okKeys,
        tieKeys,
        disagreeKeys,
      },
      ms: Date.now() - t0,
    };
  },
});
