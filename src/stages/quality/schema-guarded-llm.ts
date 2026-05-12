/**
 * Schema-Guard — generic LLM wrapper with strict JSON-schema decoding.
 *
 * Wraps a single chatJson call but enforces the response shape through the
 * provider's JSON-schema mode (vLLM `response_format=json_schema` strict,
 * Mistral `response_format=json_object`, Ollama format=json). Replaces ad-hoc
 * `chatJson` usage in domain-specific stages with a reusable designer-node.
 *
 * The schema can be:
 *   - inline JSON-schema object via `config.schema`
 *   - looked up from the schema-repo via `config.schemaRef = "<id>/<version>"`
 *
 * Design notes:
 *   - Provider is `config.provider` (designer surfaces dropdown via hints.llm).
 *   - We DON'T crash on schema-repo miss — fall back to inline if both provided.
 *   - Output `extracted` is always the parsed object; downstream stages (Critic,
 *     Span-Linker, Cross-Validator) consume `extracted` as their primary input.
 */
import { defineStage } from '../../core/stage.ts';
import { chatJson, type ChatProvider } from '../../lib/llm-chat.ts';
import { getSchemaVersion } from '../../core/schema-repo.ts';
import {
  computePromptBudget,
  contextTokensFor,
  assertFitsInBudget,
  PromptBudgetExceededError,
} from '../../lib/prompt-budget.ts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

export interface SchemaGuardInput {
  /** The user prompt — typically the OCR text plus extraction instructions. */
  prompt: string;
  /** Optional source text (passed for downstream Critic/Span-Linker). Echoed in output. */
  source?: string;
  /** Inline JSON-schema — overrides `config.schema` when present. */
  schema?: Record<string, unknown>;
  /** Optional schema name (for vLLM strict mode metadata). */
  schemaName?: string;
}

export interface SchemaGuardOutput {
  /** Parsed object that conforms to the requested schema. */
  extracted: unknown;
  /** Raw LLM response text (for debug / span linking). */
  raw: string;
  /** Provider usage stats (tokens, ms). */
  usage: unknown;
  /** Echoed source text — convenient passthrough for downstream Span-Linker. */
  source?: string;
  /** Schema name actually used (after schema-repo lookup if any). */
  schemaName: string;
  /** Wall-clock ms. */
  ms: number;
}

export interface SchemaGuardConfig {
  provider?: ChatProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Inline JSON-schema. Wins over `schemaRef` if both provided. */
  schema?: Record<string, unknown>;
  /** Schema-name passed to the provider (for vLLM strict-mode logs). */
  schemaName?: string;
  /** Reference into the schema-repo: "<id>" (current) or "<id>/v<n>". */
  schemaRef?: string;
  /** Force strict-mode (vLLM only). Default true. */
  strict?: boolean;
  /** Optional system message prefixed to the LLM call. */
  system?: string;
}

async function resolveSchema(
  cfg: SchemaGuardConfig,
  input: SchemaGuardInput,
): Promise<{ schema: Record<string, unknown>; name: string } | null> {
  // Input override wins (workflow-time dynamic schema)
  if (input.schema && typeof input.schema === 'object') {
    return { schema: input.schema, name: input.schemaName ?? cfg.schemaName ?? 'inline' };
  }
  if (cfg.schema && typeof cfg.schema === 'object') {
    return { schema: cfg.schema, name: cfg.schemaName ?? 'inline' };
  }
  if (cfg.schemaRef) {
    // Accept "<id>" or "<id>/v<n>"
    const m = cfg.schemaRef.match(/^(.+?)\/(v\d+)$/);
    const id = m ? m[1] : cfg.schemaRef;
    const version = m ? m[2] : undefined;
    try {
      const rec = await getSchemaVersion(ROOT, id, version ?? 'current');
      if (rec && rec.schema) {
        return { schema: rec.schema as Record<string, unknown>, name: cfg.schemaName ?? rec.name ?? id };
      }
    } catch {
      // fall through — caller will throw with clearer error below
    }
  }
  return null;
}

export const schemaGuardedLlmStage = defineStage<SchemaGuardInput, SchemaGuardOutput, SchemaGuardConfig>({
  id: 'extract/schema-guarded-llm',
  name: 'Schema-Guard — strict JSON LLM',
  description:
    'Wrappt einen LLM-Call mit strikter JSON-Schema-Constrain (vLLM json_schema, ' +
    'Mistral json_object, Ollama format=json). Schema kommt inline oder aus dem ' +
    'Schema-Repo. Ergebnis ist garantiert schema-konform — keine Post-hoc-Reparatur.',
  hints: {
    inputs: 'prompt (text), source? (text — echoed for span-linker), schema? (json-schema), schemaName?',
    outputs: 'extracted (nested-json), raw (text), usage (json), source (echoed), schemaName, ms',
    configExample: '{"provider": "vllm", "model": "gemma4-mm", "temperature": 0, "maxTokens": 2000, "strict": true, "schemaRef": "elster/lohnsteuerbescheinigung/v1"}',
    llm: { providers: ['vllm', 'mistral', 'ollama'], default: 'vllm' },
    inputPorts: [
      { name: 'prompt', type: 'text', description: 'Instructions + source text' },
      { name: 'source', type: 'text', description: 'Optional OCR text for downstream span-linking' },
      { name: 'schema', type: 'json-schema', description: 'Optional inline schema; overrides config' },
    ],
    outputPorts: [
      { name: 'extracted', type: 'nested-json', description: 'Schema-conformant extraction' },
      { name: 'raw', type: 'text' },
      { name: 'usage', type: 'json' },
      { name: 'source', type: 'text', description: 'Echoed for span-linker downstream' },
    ],
  },

  async run(input, ctx) {
    if (!input?.prompt || typeof input.prompt !== 'string') {
      throw new Error('schema-guarded-llm: input.prompt fehlt');
    }
    const t0 = Date.now();
    const cfg = ctx.config ?? ({} as SchemaGuardConfig);
    const resolved = await resolveSchema(cfg, input);
    if (!resolved) {
      throw new Error(
        'schema-guarded-llm: weder input.schema noch config.schema noch config.schemaRef geliefert',
      );
    }
    ctx.emit('schema_guard_started', {
      provider: cfg.provider ?? 'vllm',
      model: cfg.model,
      schemaName: resolved.name,
    });

    // If a source text is provided as a separate input, append it. The workflow
    // runner only substitutes WHOLE-string ${...} refs, so the typical pattern
    // is `prompt = "<static instructions>"`, `source = "${ocr.text}"`.
    //
    // Dynamic budget: compute source-char-cap from the target model's context
    // window, the strict-JSON-schema size, and the max_tokens output cap —
    // statt einer hardcoded `slice(0, 18000)`. Verhindert Truncation auf
    // 18k bei Gemma-4-128K-Calls (verschenkter Context) und verhindert
    // Overflow bei Mistral-Small (32K).
    // Policy: KEIN silent truncation. Wenn Source > Budget → fehler werfen.
    // Caller muss vorher auto-source-split fahren und pro Chunk einzeln aufrufen.
    let fullPrompt = input.prompt;
    if (input.source && typeof input.source === 'string') {
      const modelName = cfg.model ?? (cfg.provider === 'mistral' ? 'mistral-large-latest' : 'gemma4-mm');
      const budget = computePromptBudget({
        modelContextTokens: contextTokensFor(modelName),
        schema: resolved.schema,
        maxOutputTokens: cfg.maxTokens ?? 2_000,
        overheadTokens: 1_000 + Math.ceil(input.prompt.length / 3.5),
      });
      try {
        assertFitsInBudget(input.source, budget);
      } catch (err) {
        if (err instanceof PromptBudgetExceededError) {
          ctx.emit('source_budget_exceeded', {
            model: modelName,
            originalChars: err.textLen,
            budgetChars: err.budgetChars,
            budgetBreakdown: budget.breakdown,
            hint: 'Splitte den Source via auto-source-split und rufe schema-guarded-llm pro chunk auf.',
          });
        }
        throw err;
      }
      fullPrompt = `${input.prompt}\n\n--- QUELLTEXT ---\n${input.source}`;
    }

    const result = await chatJson<Record<string, unknown>>(fullPrompt, {
      provider: cfg.provider ?? 'vllm',
      model: cfg.model,
      temperature: cfg.temperature ?? 0,
      maxTokens: cfg.maxTokens ?? 2000,
      system: cfg.system,
      jsonSchema: {
        name: resolved.name,
        schema: resolved.schema,
        strict: cfg.strict !== false,
      },
      signal: ctx.signal,
    });

    const ms = Date.now() - t0;
    ctx.emit('schema_guard_done', {
      ms,
      schemaName: resolved.name,
      previewKeys: typeof result.parsed === 'object' && result.parsed !== null
        ? Object.keys(result.parsed as Record<string, unknown>).slice(0, 12)
        : [],
    });

    return {
      extracted: result.parsed,
      raw: result.raw,
      usage: result.usage,
      source: input.source,
      schemaName: resolved.name,
      ms,
    };
  },
});
