/**
 * funnel-stage — converts free-form KPIs (or extraktion's per_anlage values)
 * into a canonical ELSTER layer using the 7-stage cascade.
 *
 * Input shape is intentionally flexible: it accepts either
 *   { kpis: KPI[] }                    (auto-pipeline / belege-bundle output)
 *   { per_anlage: Record<...> }        (elster-v1 extraktion output)
 *   { both }                            (mixed)
 *
 * Output: a canonical-layer object with codes, traces, unmapped, validator
 * (validator is empty here — it's filled by validator-stage downstream).
 */
import { defineStage } from '../../../core/stage.ts';
import { resolveAll, type KPI } from '../../../lib/cascade-runtime.ts';
import { makeLayer, setCode, type CanonicalLayer } from '../../../lib/canonical-layer.ts';
import { getElsterCascadeConfig } from '../lib/cascade-config.ts';
import { loadCatalog } from '../lib/elster-katalog.ts';

export interface FunnelInput {
  /** Free-form KPIs (from auto-pipeline or belege-bundle workflow) */
  kpis?: Array<{
    key: string;
    value: unknown;
    citation?: { page?: number; charOffset?: number; length?: number; text?: string };
  }>;
  /** Per-anlage eCode-keyed values (from elster-v1 extraktion stage) */
  per_anlage?: Record<string, { values: Record<string, string | null> }>;
  /** Doc-type hint from classification */
  docType?: string;
  /** Anlagen hint from classification */
  recommendedAnlagen?: string[];
  /** Source document UUID (workspace assigns one per upload) */
  sourceDoc?: string;
}

export interface FunnelOutput {
  canonicalLayer: CanonicalLayer;
  stats: {
    inputKpis: number;
    inputEcodes: number;
    matched: number;
    unmapped: number;
    perStageHits: Record<string, number>;
    ms: number;
  };
}

export interface FunnelConfig {
  shortCircuit?: boolean;
  recordDeclines?: boolean;
}

export const funnelStage = defineStage<FunnelInput, FunnelOutput, FunnelConfig>({
  id: 'elster/funnel',
  name: 'ELSTER-Funnel-Cascade',
  description:
    'Resolves free-form KPIs (or extraktion-eCode-values) into the canonical ELSTER layer via a 7-stage cascade: bezeichnung-exact → fuzzy → semantik-schlagworte → format-regex → bmf-slug → llm-fallback. Output is the per-document canonical layer.',

  async run(input, ctx) {
    const t0 = Date.now();
    const config = await getElsterCascadeConfig();
    const catalog = await loadCatalog();
    const layer = makeLayer('elster', catalog.feldKatalog.catalogVersion);

    // Pass 1: per_anlage values from extraktion go in directly with high
    // confidence (LLM already constrained them to known eCodes per Anlage).
    let inputEcodes = 0;
    if (input.per_anlage) {
      for (const [anlage, bucket] of Object.entries(input.per_anlage)) {
        for (const [eCode, value] of Object.entries(bucket.values ?? {})) {
          if (value === null || value === undefined || value === '') continue;
          const f = catalog.byCode.get(eCode);
          if (!f) continue; // unknown eCode — drop silently
          inputEcodes++;
          setCode(layer, {
            code: eCode,
            value: value as string,
            sourceDoc: input.sourceDoc,
            cascadeStage: 'extraktion-direct',
            confidence: 0.92,
            reasoning: `extraktion (Anlage ${anlage})`,
          });
        }
      }
    }

    // Pass 2: free-form KPIs go through the cascade
    const kpis: KPI[] = (input.kpis ?? []).map((k) => ({
      key: k.key,
      value: k.value,
      docType: input.docType,
      recommendedAnlagen: input.recommendedAnlagen,
      sourceDoc: input.sourceDoc,
      ocrSpan: k.citation,
    }));

    const details = await resolveAll(kpis, config, catalog, layer, {
      shortCircuit: ctx.config.shortCircuit !== false,
      recordDeclines: ctx.config.recordDeclines === true,
    });

    // Per-stage counter for telemetry
    const perStageHits: Record<string, number> = {};
    for (const d of details) {
      if (!d.matched || !d.winner) continue;
      perStageHits[d.winner.stage] = (perStageHits[d.winner.stage] ?? 0) + 1;
    }
    if (input.per_anlage) {
      perStageHits['extraktion-direct'] = inputEcodes;
    }

    const matched = Object.keys(layer.codes).length;
    const unmapped = layer.unmapped.length;
    ctx.emit('funnel_done', {
      inputKpis: kpis.length,
      inputEcodes,
      matched,
      unmapped,
      perStageHits,
    });

    await ctx.artifacts.write('canonical_layer.json', layer);
    return {
      canonicalLayer: layer,
      stats: {
        inputKpis: kpis.length,
        inputEcodes,
        matched,
        unmapped,
        perStageHits,
        ms: Date.now() - t0,
      },
    };
  },
});
