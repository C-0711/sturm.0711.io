/**
 * embed-cascade-stage — v2 mapper. Replaces (or sits beside) funnel-stage.
 *
 * Input: free-form KPIs (or per_anlage extraktion values)
 * Output: canonical ELSTER layer with codes resolved by cosine + LLM-reason
 *
 * Semantics:
 *   - High-confidence cosine matches (≥0.78) win immediately
 *   - Ambiguous matches (0.6-0.78) escalate to LLM Reason on top-5
 *   - Anything below 0.6 falls back to v1 deterministic cascade (caller's
 *     responsibility — chain this stage BEFORE funnel-stage in the workflow)
 *   - Deterministic per_anlage values (from extraktion) are accepted as-is
 *     with confidence 0.92 (LLM-driven extraction already constrained to known eCodes)
 */
import { defineStage } from '../../../core/stage.ts';
import { resolveAll, type KPI } from '../../../lib/cascade-runtime.ts';
import { makeLayer, setCode, type CanonicalLayer } from '../../../lib/canonical-layer.ts';
import { getElsterEmbedCascadeConfig } from '../lib/embed-cascade.ts';
import { loadCatalog } from '../lib/elster-katalog.ts';

export interface EmbedCascadeInput {
  /** Free-form KPIs from auto-pipeline / belege-bundle workflow */
  kpis?: Array<{
    key: string;
    value: unknown;
    citation?: { page?: number; charOffset?: number; length?: number; text?: string };
  }>;
  /** Per-anlage eCode-keyed values from elster-v1 extraktion stage */
  per_anlage?: Record<string, { values: Record<string, string | null> }>;
  /** Doc-type hint */
  docType?: string;
  /** Anlagen hint */
  recommendedAnlagen?: string[];
  /** Source document UUID */
  sourceDoc?: string;
}

export interface EmbedCascadeOutput {
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

export interface EmbedCascadeConfig {
  shortCircuit?: boolean;
  /** Override the chat provider used in Stage E (default: env CHAT_PROVIDER or 'ollama') */
  chatProvider?: 'mistral' | 'ollama';
  chatModel?: string;
}

export const embedCascadeStage = defineStage<EmbedCascadeInput, EmbedCascadeOutput, EmbedCascadeConfig>({
  id: 'elster/embed-cascade',
  name: 'ELSTER-Embed-Cascade (v2)',
  description:
    'v2 cascade: cosine over bge-m3 catalog embeddings + LLM Reason (Gemma-4 / Mistral). ' +
    'Resolves free-form KPIs to ELSTER eCodes via semantic similarity, with LLM disambiguation ' +
    'on ambiguous candidates. Replaces or supplements the v1 deterministic funnel.',

  async run(input, ctx) {
    const t0 = Date.now();
    const config = await getElsterEmbedCascadeConfig();
    const catalog = await loadCatalog();
    const layer = makeLayer('elster', catalog.feldKatalog.catalogVersion);

    // Pass 1: per_anlage values from extraktion go in directly (LLM already
    // constrained them to known eCodes per Anlage, no need to re-cascade).
    let inputEcodes = 0;
    if (input.per_anlage) {
      for (const [anlage, bucket] of Object.entries(input.per_anlage)) {
        for (const [eCode, value] of Object.entries(bucket.values ?? {})) {
          if (value === null || value === undefined || value === '') continue;
          const f = catalog.byCode.get(eCode);
          if (!f) continue;
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

    // Pass 2: free-form KPIs go through the embed-cascade
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
    });

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
    ctx.emit('embed_cascade_done', {
      inputKpis: kpis.length,
      inputEcodes,
      matched,
      unmapped,
      perStageHits,
    });

    await ctx.artifacts.write('canonical_layer_v2.json', layer);
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
