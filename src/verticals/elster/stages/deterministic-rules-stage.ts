/**
 * deterministic-rules-stage — Layer 4 of v2.
 *
 * Runs PROJECTION_RULES from lib/deterministic-rules.ts against the resolved
 * nested JSON. Each rule walks an array (e.g. donations), filters by predicate
 * (e.g. is_charitable_certified === true), aggregates (sum/max/etc.), applies
 * §-ceilings, and writes one canonical eCode value into the layer.
 *
 * This is where "Hospiz Verein 25€" gets dropped from the Spenden-total
 * deterministically — no LLM judgement, just legal predicate over the resolved
 * entity flag.
 */
import { defineStage } from '../../../core/stage.ts';
import type { CanonicalLayer } from '../../../lib/canonical-layer.ts';
import { applyProjections } from '../lib/deterministic-rules.ts';

export interface DeterministicRulesInput {
  /** Nested + resolved JSON from entity-resolve-stage */
  nested: unknown;
  /** Existing canonical layer to augment (from embed-cascade-stage) */
  canonicalLayer: CanonicalLayer;
  /** Doc class for rule scoping */
  dokumenttyp_id?: string;
}

export interface DeterministicRulesOutput {
  canonicalLayer: CanonicalLayer;
  appliedRules: Array<{
    rule: string;
    targetCode: string;
    inputCount: number;
    filteredCount: number;
    aggregatedValue: number | string | boolean;
    ceilingApplied: boolean;
  }>;
  stats: { rulesApplied: number; codesWritten: number; ms: number };
}

export interface DeterministicRulesConfig {
  /** Skip rules — for unit testing */
  skipRules?: string[];
}

export const deterministicRulesStage = defineStage<
  DeterministicRulesInput,
  DeterministicRulesOutput,
  DeterministicRulesConfig
>({
  id: 'elster/deterministic-rules',
  name: 'ELSTER-Deterministic-Rules (v2 Layer 4)',
  description:
    'Applies hand-curated §-rules to the resolved nested JSON. Filters arrays by ' +
    'predicate (e.g. is_charitable_certified for Spenden), aggregates with §-aware ' +
    'ceilings (§ 10b 20%, § 35a Abs. 2 max 4.000 €), writes canonical eCode values ' +
    'into the layer. Probabilistic outputs become deterministic, audit-ready facts.',
  hints: {
    inputs: 'nested (Layer-2 output), dokumenttyp_id · optional: canonicalLayer',
    outputs: 'canonicalLayer (eCode-Map mit Traces), applied_rules[], ms',
    acceptsContainers: ['elster-catalog'],
    inputPorts: [
      { name: 'nested', type: 'nested-json' },
      { name: 'dokumenttyp_id', type: 'string' },
      { name: 'canonicalLayer', type: 'canonical-layer', description: 'Optional pre-existing layer to augment' },
    ],
    outputPorts: [
      { name: 'canonicalLayer', type: 'canonical-layer', description: 'eCode-Map mit Traces' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const result = applyProjections(input.nested, input.canonicalLayer, input.dokumenttyp_id);
    const stats = {
      rulesApplied: result.appliedRules.length,
      codesWritten: result.appliedRules.length,
      ms: Date.now() - t0,
    };
    ctx.emit('deterministic_rules_done', stats);
    await ctx.artifacts.write('deterministic_results.json', result);
    return {
      canonicalLayer: input.canonicalLayer,
      appliedRules: result.appliedRules,
      stats,
    };
  },
});
