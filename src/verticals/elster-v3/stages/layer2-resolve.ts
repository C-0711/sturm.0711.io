/**
 * elster-v3 Layer 2 — entity resolution.
 *
 * Walks the nested JSON from Layer 1, finds entity-typed fields (recipient,
 * donor.name, employer.name, institute, ...), resolves each via the v2
 * legal-entity-registry (curated whitelist + Gemma-4 disambig fallback).
 *
 * Output: same nested JSON augmented with `*_original` and `*_resolution`
 * shadow keys; the canonical name overwrites the original. Layer 4's
 * deterministic rules read `_resolution.isCharitableCertified` to filter.
 */
import { defineStage } from '../../../core/stage.ts';
import { resolveEntity } from '../../elster/lib/legal-entity-registry.ts';

export interface Layer2Input {
  /** Nested JSON from layer1-extract */
  nested: unknown;
  /** Doc-class for context-aware resolution (passed through to LLM if used) */
  dokumenttyp_id?: string;
}

export interface Layer2Output {
  nested: unknown;
  stats: {
    entitiesScanned: number;
    whitelistExact: number;
    whitelistFuzzy: number;
    llmGrounded: number;
    llmUncertain: number;
    unresolved: number;
    correctionsApplied: number;
    ms: number;
  };
}

export interface Layer2Config {
  /** Field-name substrings that mark an entity field. Case-insensitive. */
  entityFieldHints?: string[];
  /** Skip the LLM disambig fallback (whitelist-only, fast). */
  whitelistOnly?: boolean;
  /** chat provider for disambig calls */
  chatProvider?: 'mistral' | 'ollama' | 'vllm';
  chatModel?: string;
}

const DEFAULT_HINTS = [
  'recipient', 'empfaenger', 'empfänger', 'spendenempfanger', 'spendenempfänger',
  'donor', 'spender', 'institute', 'institut', 'bank',
  'arbeitgeber', 'employer', 'rentenerbringer', 'leistungserbringer',
  'versicherer', 'kreditinstitut', 'finanzamt', 'organisation', 'verein',
];

function isEntityFieldName(name: string, hints: string[]): boolean {
  const n = name.toLowerCase();
  return hints.some((h) => n.includes(h));
}

async function walkAndResolve(
  obj: unknown,
  hints: string[],
  cfg: Layer2Config,
  stats: Layer2Output['stats'],
): Promise<unknown> {
  if (Array.isArray(obj)) {
    const out: unknown[] = [];
    for (const item of obj) out.push(await walkAndResolve(item, hints, cfg, stats));
    return out;
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && isEntityFieldName(k, hints) && v.trim().length > 1) {
        const context = Object.entries(o)
          .filter(([k2, v2]) => k2 !== k && typeof v2 === 'string' && (v2 as string).length < 200)
          .map(([k2, v2]) => `${k2}: ${v2}`)
          .slice(0, 6)
          .join(' | ');
        const result = await resolveEntity(v, {
          context,
          allowLlm: !cfg.whitelistOnly,
          chatProvider: cfg.chatProvider,
          chatModel: cfg.chatModel,
        });
        out[k] = result.canonical;
        out[`${k}_original`] = v;
        out[`${k}_resolution`] = result;
        stats.entitiesScanned++;
        if (result.correctionApplied) stats.correctionsApplied++;
        switch (result.source) {
          case 'whitelist-exact': stats.whitelistExact++; break;
          case 'whitelist-fuzzy': stats.whitelistFuzzy++; break;
          case 'llm-grounded':    stats.llmGrounded++; break;
          case 'llm-uncertain':   stats.llmUncertain++; break;
          case 'unresolved':      stats.unresolved++; break;
        }
      } else {
        out[k] = await walkAndResolve(v, hints, cfg, stats);
      }
    }
    return out;
  }
  return obj;
}

export const layer2ResolveStage = defineStage<Layer2Input, Layer2Output, Layer2Config>({
  id: 'elster-v3/layer2-resolve',
  name: 'ELSTER-v3 Layer 2 — entity resolution',
  description:
    'Walks the nested JSON, resolves entity fields (Spendenempfänger, Arbeitgeber, Bank) ' +
    'against the curated legal-entity whitelist with Gemma-4 disambig fallback. Augments ' +
    'JSON with _resolution shadow keys (canonical, isCharitableCertified, source).',
  hints: {
    inputs: 'nested (Layer-1 output), dokumenttyp_id',
    outputs: 'nested (augmented with _resolution shadow keys), entities_resolved, ms',
    configExample: '{"chatProvider": "vllm", "chatModel": "gemma4-mm"}',
    llm: { providers: ['vllm', 'mistral', 'ollama'], default: 'vllm' },
    acceptsContainers: ['elster-catalog', 'embedding-index'],
    inputPorts: [
      { name: 'nested', type: 'nested-json' },
      { name: 'dokumenttyp_id', type: 'string' },
    ],
    outputPorts: [
      { name: 'nested', type: 'nested-json', description: 'Augmented with _resolution shadow keys' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const hints = ctx.config.entityFieldHints ?? DEFAULT_HINTS;
    const stats: Layer2Output['stats'] = {
      entitiesScanned: 0,
      whitelistExact: 0,
      whitelistFuzzy: 0,
      llmGrounded: 0,
      llmUncertain: 0,
      unresolved: 0,
      correctionsApplied: 0,
      ms: 0,
    };
    const cfg: Layer2Config = {
      whitelistOnly: ctx.config.whitelistOnly === true,
      chatProvider: ctx.config.chatProvider ?? 'vllm',
      chatModel: ctx.config.chatModel ?? 'gemma4-mm',
    };
    const resolved = await walkAndResolve(input.nested, hints, cfg, stats);
    stats.ms = Date.now() - t0;
    await ctx.artifacts.write('layer2_resolved.json', resolved);
    ctx.emit('layer2_done', stats);
    return { nested: resolved, stats };
  },
});
