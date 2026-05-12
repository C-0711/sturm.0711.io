/**
 * entity-resolve-stage — Layer 2 of v2.
 *
 * Walks a nested JSON object, finds entity-typed fields (recipient, donor,
 * institute, etc.), resolves each via the LLM-driven legal-entity-registry,
 * and augments the JSON with `_resolution` shadow objects.
 *
 * Result is a richer nested JSON — the deterministic-rules stage downstream
 * reads `_resolution.is_charitable_certified` to filter for E0108405-eligible
 * donations, etc.
 */

import { defineStage } from '../../../core/stage.ts';
import { resolveEntity, type ResolutionResult } from '../lib/legal-entity-registry.ts';

export interface EntityResolveInput {
  /** Nested JSON from nested-extract-stage */
  nested: unknown;
  /** Doc-class hint for context-aware resolution */
  dokumenttyp_id?: string;
}

export interface EntityResolveOutput {
  /** Same nested JSON with `_resolution` shadow keys added on entity fields */
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

export interface EntityResolveConfig {
  /** Field-name patterns that signal an entity field (case-insensitive substrings) */
  entityFieldHints?: string[];
  /** Disable LLM and only use whitelist (for fast unit tests) */
  whitelistOnly?: boolean;
  chatProvider?: 'mistral' | 'ollama';
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

/** Walk a JSON tree; for every string-valued field whose name suggests an entity,
 *  call resolveEntity(). Mutates a deep clone of input. */
async function walkAndResolve(
  obj: unknown,
  hints: string[],
  opts: EntityResolveConfig,
  contextStack: string[],
  stats: EntityResolveOutput['stats'],
): Promise<unknown> {
  if (Array.isArray(obj)) {
    const out = [];
    for (const item of obj) {
      out.push(await walkAndResolve(item, hints, opts, contextStack, stats));
    }
    return out;
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && isEntityFieldName(k, hints) && v.trim().length > 1) {
        // Build context from sibling string values (e.g. address, type)
        const context = Object.entries(o)
          .filter(([k2, v2]) => k2 !== k && typeof v2 === 'string' && (v2 as string).length < 200)
          .map(([k2, v2]) => `${k2}: ${v2}`)
          .slice(0, 6)
          .join(' | ');
        const result = await resolveEntity(v, {
          context,
          allowLlm: !opts.whitelistOnly,
          chatProvider: opts.chatProvider,
          chatModel: opts.chatModel,
        });
        out[k] = result.canonical;     // overwrite with canonical
        out[`${k}_original`] = v;       // preserve raw for audit
        out[`${k}_resolution`] = result;
        // stats
        stats.entitiesScanned++;
        if (result.correctionApplied) stats.correctionsApplied++;
        switch (result.source) {
          case 'whitelist-exact':  stats.whitelistExact++; break;
          case 'whitelist-fuzzy':  stats.whitelistFuzzy++; break;
          case 'llm-grounded':     stats.llmGrounded++; break;
          case 'llm-uncertain':    stats.llmUncertain++; break;
          case 'unresolved':       stats.unresolved++; break;
        }
      } else {
        out[k] = await walkAndResolve(v, hints, opts, [...contextStack, k], stats);
      }
    }
    return out;
  }
  return obj;
}

export const entityResolveStage = defineStage<EntityResolveInput, EntityResolveOutput, EntityResolveConfig>({
  id: 'elster/entity-resolve',
  name: 'ELSTER-Entity-Resolution (v2 Layer 2)',
  description:
    'Walks nested JSON, resolves entity-typed fields (Spendenempfänger, Arbeitgeber, Bank, ' +
    'Leistungserbringer) against a curated whitelist + LLM disambiguation. Implicitly fixes ' +
    'OCR errors via the canonical-name substitution. Augments JSON with _resolution shadow keys ' +
    'including is_charitable_certified for the deterministic rules engine.',

  async run(input, ctx) {
    const t0 = Date.now();
    const hints = ctx.config.entityFieldHints ?? DEFAULT_HINTS;
    const stats: EntityResolveOutput['stats'] = {
      entitiesScanned: 0,
      whitelistExact: 0,
      whitelistFuzzy: 0,
      llmGrounded: 0,
      llmUncertain: 0,
      unresolved: 0,
      correctionsApplied: 0,
      ms: 0,
    };
    const resolved = await walkAndResolve(input.nested, hints, ctx.config, [], stats);
    stats.ms = Date.now() - t0;
    ctx.emit('entity_resolve_done', stats);
    await ctx.artifacts.write('nested_resolved.json', resolved);
    return { nested: resolved, stats };
  },
});
