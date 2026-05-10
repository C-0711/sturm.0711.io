/**
 * Cascade runtime — generic N-stage resolver used by every standard-vertical.
 *
 * A vertical supplies a CascadeConfig (ordered list of stages, each with a
 * match function). For each input KPI, run() walks the stages until one
 * returns a Match above its minConfidence; that Match becomes the resolved
 * trace. If all stages decline, the KPI is added to the layer's `unmapped`
 * list.
 *
 * Pure runtime — no I/O, no side effects beyond the layer mutation. Catalogs
 * are loaded by the vertical and passed in as the second argument.
 *
 * Stages are executed sequentially per KPI but the runtime is callable from
 * stage code in any concurrency model the surrounding sturm Stage chooses
 * (typically Promise.all over a worker pool).
 */
import type { CanonicalLayer, CanonicalTrace, CanonicalValue } from './canonical-layer.ts';
import { addUnmapped, setCode } from './canonical-layer.ts';

export interface KPI {
  /** Free-form label as extracted, e.g. "Bruttoarbeitslohn" or "km Arbeitsweg" */
  key: string;
  /** Free-form value as extracted, may be string/number/etc. */
  value: unknown;
  /** Optional doc-type hint from classification, e.g. "lohnsteuerbescheinigung" */
  docType?: string;
  /** Optional anlagen hints from classification, e.g. ["N", "VOR"] */
  recommendedAnlagen?: string[];
  /** Optional source-document UUID */
  sourceDoc?: string;
  /** Optional OCR span citation */
  ocrSpan?: CanonicalTrace['ocrSpan'];
}

/** A successful match from one cascade stage */
export interface Match {
  code: string;
  /** Coerced value if the stage normalized it (e.g. "12.345,67" → 12345.67); otherwise pass-through */
  value: CanonicalValue;
  /** Reported confidence, [0..1] */
  confidence: number;
  /** Why-this-match reasoning */
  reasoning?: string;
}

export interface CascadeStage<Catalog = unknown> {
  /** Stage identifier, e.g. 'bezeichnung-exact', 'semantik-schlagworte', 'llm-fallback' */
  id: string;
  /** Minimum confidence for this stage to "win" (and short-circuit later stages) */
  minConfidence: number;
  /** Whether this stage requires async I/O (LLM call, network) */
  async?: boolean;
  /** The match function. Returns null when the stage declines. */
  match(kpi: KPI, catalog: Catalog): Match | null | Promise<Match | null>;
}

export interface CascadeConfig<Catalog = unknown> {
  schemaId: string;
  version: string;
  stages: CascadeStage<Catalog>[];
}

export interface ResolveOptions {
  /** Stop walking after the first stage at-or-above its minConfidence (default true) */
  shortCircuit?: boolean;
  /** If true, even a failed match becomes a trace with confidence 0 (debug mode) */
  recordDeclines?: boolean;
}

export interface ResolutionDetail {
  matched: boolean;
  winner?: { stage: string; match: Match };
  attempts: Array<{ stage: string; match: Match | null; thresholdMet: boolean }>;
}

export async function resolveOne<Catalog>(
  kpi: KPI,
  config: CascadeConfig<Catalog>,
  catalog: Catalog,
  opts: ResolveOptions = {},
): Promise<ResolutionDetail> {
  const shortCircuit = opts.shortCircuit !== false;
  const detail: ResolutionDetail = { matched: false, attempts: [] };
  for (const stage of config.stages) {
    const result = await stage.match(kpi, catalog);
    const thresholdMet = result !== null && result.confidence >= stage.minConfidence;
    detail.attempts.push({ stage: stage.id, match: result, thresholdMet });
    if (thresholdMet && result) {
      detail.matched = true;
      detail.winner = { stage: stage.id, match: result };
      if (shortCircuit) break;
    }
  }
  return detail;
}

/**
 * Run the full cascade over a list of KPIs and write results into a layer.
 * Returns per-KPI resolution detail so callers can stream progress events.
 */
export async function resolveAll<Catalog>(
  kpis: KPI[],
  config: CascadeConfig<Catalog>,
  catalog: Catalog,
  layer: CanonicalLayer,
  opts: ResolveOptions = {},
): Promise<ResolutionDetail[]> {
  const out: ResolutionDetail[] = [];
  for (const kpi of kpis) {
    const detail = await resolveOne(kpi, config, catalog, opts);
    if (detail.matched && detail.winner) {
      const trace: CanonicalTrace = {
        code: detail.winner.match.code,
        value: detail.winner.match.value,
        sourceDoc: kpi.sourceDoc,
        ocrSpan: kpi.ocrSpan,
        cascadeStage: detail.winner.stage,
        confidence: detail.winner.match.confidence,
        reasoning: detail.winner.match.reasoning,
      };
      setCode(layer, trace);
    } else {
      const lastReason = detail.attempts
        .filter((a) => a.match !== null)
        .map((a) => `${a.stage}: ${a.match!.confidence.toFixed(2)} < ${'min'}`)
        .join('; ');
      addUnmapped(layer, kpi.key, kpi.value, lastReason || 'no stage matched');
    }
    out.push(detail);
  }
  return out;
}
