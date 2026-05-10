/**
 * Canonical layer — the uniform output every standard-vertical produces.
 *
 * A canonical layer is "this document re-expressed in one standard's
 * identifier scheme, with full provenance back to the source". One document
 * may have multiple canonical layers (one per registered vertical that
 * processed it). Downstream consumers (BMF-Rechner for ELSTER, PIM for ETIM,
 * …) only need to know which standard they speak — they don't care how the
 * canonical IDs were resolved.
 */

export type CanonicalValue = string | number | boolean | null;

/**
 * Provenance of a single resolved code: which cascade stage produced the
 * match, with what confidence, citing which OCR span. Stored alongside the
 * value so audits and downstream merges can prefer higher-confidence sources.
 */
export interface CanonicalTrace {
  code: string;
  value: CanonicalValue;
  /** Source document UUID/path within the workspace */
  sourceDoc?: string;
  /** Verbatim span (or character offset+length) backing the value */
  ocrSpan?: { page?: number; charOffset?: number; length?: number; text?: string };
  /** Which cascade stage matched: bezeichnung-exact, semantik, regex, slug, concept, llm */
  cascadeStage?: string;
  /** Confidence the cascade stage reported, [0..1] */
  confidence?: number;
  /** Human-readable why-this-match note */
  reasoning?: string;
}

export interface ValidatorIssue {
  /** ELSTER-style Fehlercode, or vertical-specific identifier */
  ruleId: string;
  severity: 'fehler' | 'hinweis' | 'info';
  message: string;
  /** Codes that the rule cited (referenced or violated) */
  cited: string[];
}

export interface ValidatorResult {
  passes: number;
  warnings: ValidatorIssue[];
  errors: ValidatorIssue[];
}

/**
 * The canonical layer itself. Stored per-document and aggregated per-case
 * via mergeLayers() with conflict resolution.
 */
export interface CanonicalLayer {
  /** Standard identifier — 'elster', 'etim', 'eclass', 'gobd', … */
  schemaId: string;
  /** Catalog version pinned at extraction time, e.g. 'Jahresdokumentation_10_2024' */
  version: string;
  /** Map canonical-id → resolved value */
  codes: Record<string, CanonicalValue>;
  /** One entry per code, in insertion order */
  traces: CanonicalTrace[];
  /** Free-form KPIs that did NOT resolve to any canonical code (kept for audit) */
  unmapped: Array<{ key: string; value: unknown; reason?: string }>;
  /** Validator output, populated by validator-stage */
  validator: ValidatorResult;
}

export function makeLayer(schemaId: string, version: string): CanonicalLayer {
  return {
    schemaId,
    version,
    codes: {},
    traces: [],
    unmapped: [],
    validator: { passes: 0, warnings: [], errors: [] },
  };
}

/**
 * Set a code with its trace. If the code already exists, the new trace wins
 * only when its confidence is higher (deterministic tie-break: keep the first).
 */
export function setCode(layer: CanonicalLayer, trace: CanonicalTrace): void {
  const existing = layer.codes[trace.code];
  if (existing !== undefined) {
    const existingTrace = layer.traces.find((t) => t.code === trace.code);
    const existingConf = existingTrace?.confidence ?? 0;
    const newConf = trace.confidence ?? 0;
    if (newConf <= existingConf) return;
    // Replace
    const idx = layer.traces.findIndex((t) => t.code === trace.code);
    layer.traces[idx] = trace;
    layer.codes[trace.code] = trace.value;
    return;
  }
  layer.codes[trace.code] = trace.value;
  layer.traces.push(trace);
}

/**
 * Add an unresolved KPI to the unmapped list. These are kept verbatim so an
 * operator can later decide whether to extend the catalog (synonym, regex,
 * slug-alias) to capture them.
 */
export function addUnmapped(
  layer: CanonicalLayer,
  key: string,
  value: unknown,
  reason?: string,
): void {
  layer.unmapped.push({ key, value, reason });
}

/**
 * Merge multiple per-document canonical layers into one case-level layer.
 * Conflict rule (default): highest-confidence trace wins. Ties keep first.
 * Validator results are concatenated.
 */
export function mergeLayers(layers: CanonicalLayer[], opts: MergeOptions = {}): CanonicalLayer {
  if (layers.length === 0) {
    throw new Error('mergeLayers: cannot merge zero layers');
  }
  const schemaId = layers[0].schemaId;
  const version = layers[0].version;
  for (const l of layers) {
    if (l.schemaId !== schemaId) {
      throw new Error(`mergeLayers: schemaId mismatch ${l.schemaId} vs ${schemaId}`);
    }
  }
  const merged = makeLayer(schemaId, version);
  const sumStrategy = opts.sumStrategy ?? new Set<string>();
  for (const l of layers) {
    for (const t of l.traces) {
      if (sumStrategy.has(t.code) && typeof t.value === 'number') {
        const existing = merged.codes[t.code];
        if (typeof existing === 'number') {
          merged.codes[t.code] = existing + t.value;
          // Append a synthetic trace that records both contributors
          merged.traces.push({ ...t, reasoning: `summed: ${existing} + ${t.value}` });
          continue;
        }
      }
      setCode(merged, t);
    }
    for (const u of l.unmapped) merged.unmapped.push(u);
    merged.validator.passes += l.validator.passes;
    merged.validator.warnings.push(...l.validator.warnings);
    merged.validator.errors.push(...l.validator.errors);
  }
  return merged;
}

export interface MergeOptions {
  /**
   * Codes that should be SUMMED across documents instead of "highest confidence
   * wins" (e.g. capital interest from multiple banks → single ELSTER value).
   * Vertical decides which codes go here.
   */
  sumStrategy?: Set<string>;
}
