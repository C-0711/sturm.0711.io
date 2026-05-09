/**
 * @0711/gitchain-types — ELSTER deterministic data contract
 *
 * Locked contract (Phase F.2) for the `layer4-aggregate` stage of
 * `elster-v3-multi`. Defines, in order:
 *   1. The output shape of Layer 1 (per sub-doc nested extraction).
 *   2. The output shape of Layer 2 (entity-resolved, per sub-doc).
 *   3. The aggregate input fed to layer4-aggregate (collection of L1+L2).
 *   4. The aggregate output (final eCode map with full provenance).
 *
 * Every type is intentionally narrow: nothing is `any`, every union
 * is closed, every numeric eCode value carries a known unit and source.
 * Audit: @Architect 🏗️
 * Implementation: @Bombas 👨‍💻
 *
 * Source-of-truth references (DO NOT diverge — mirror these shapes):
 *   - src/verticals/elster-v3/stages/layer1-extract.ts  → Layer1Output
 *   - src/verticals/elster-v3/stages/layer2-resolve.ts  → Layer2Output
 *   - src/verticals/elster/lib/deterministic-rules.ts   → ProjectionRule, ProjectionResult
 *   - src/lib/canonical-layer.ts                        → CanonicalTrace, CanonicalValue
 *
 * Container provenance reference:
 *   - 0711:elster:bmf:jahresdok-2024:v1
 *     merkle 66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd
 *     issuer sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea
 */

// ─────────────────────────────────────────────────────────────────────────────
// 0. Primitive types — frozen vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** ELSTER eCode pattern: `E` + 7 digits. Branded for type-level safety. */
export type ECode = string & { readonly __brand: 'ECode' };

/** Compile-time validator helper (runtime guard lives next to it). */
export const isECode = (v: unknown): v is ECode =>
  typeof v === 'string' && /^E\d{7}$/.test(v);

/** Closed enum of doc classes the multi-stage may emit (mirrors resolveSchemaName aliases). */
export type ElsterDocClass =
  | 'lohnsteuerbescheinigung'
  | 'rentenbezugsmitteilung'
  | 'spendenquittung'
  | 'religionszugehoerigkeit'
  | 'mitteilung_kapitalertraege'
  | 'steuerbescheinigung_kapitalertraege'
  | 'personaldaten_hauptvordruck';

/** Closed enum of L2 entity-resolution sources (mirrors layer2-resolve.ts stats). */
export type EntityResolutionSource =
  | 'whitelist-exact'
  | 'whitelist-fuzzy'
  | 'llm-grounded'
  | 'llm-uncertain'
  | 'unresolved';

/** Closed enum of aggregator strategies the bundle aggregator may apply per code. */
export type AggregateStrategy =
  | 'sum'           // numeric add across sub-docs (e.g. Sparer-Pauschbetrag)
  | 'max'           // pick largest (e.g. Bemessungsgrundlage)
  | 'first'         // keep first non-null (e.g. Konfession)
  | 'count'         // count non-null occurrences (e.g. Kirchensteuer-Flag)
  | 'replace-on-conflict' // last write wins; surfaces a conflict warning
  | 'reject-on-conflict'; // emits an aggregateConflict; value stays null

/** Permitted scalar values for an eCode (mirrors CanonicalValue). */
export type ECodeValue = string | number | boolean | null;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Layer 1 — strict json_schema nested extraction (per sub-doc)
//    Mirrors: src/verticals/elster-v3/stages/layer1-extract.ts:Layer1Output
// ─────────────────────────────────────────────────────────────────────────────

export interface Layer1Result {
  /** Stable sub-doc id from page-split (e.g. `subdoc_03`). */
  readonly subDocId: string;
  /** Doc class fed into Gemma; matches the schema file picked. */
  readonly docClass: ElsterDocClass | string; // string fallback for unknown header hints
  /** Nested-schema name actually loaded (`<schema>.json`). */
  readonly schemaName: string;
  /** vLLM/json_schema payload `name` field (acts as schemaId for trace). */
  readonly schemaId: string;
  /** Raw structured nested JSON exactly as produced by Gemma-4 strict mode. */
  readonly nested: Readonly<Record<string, unknown>>;
  /** Time spent in vLLM call (milliseconds). */
  readonly llmMs: number;
  /** Total stage time (ms). */
  readonly ms: number;
  /** Optional error if extraction failed for this sub-doc. */
  readonly error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Layer 2 — entity resolution (per sub-doc)
//    Mirrors: src/verticals/elster-v3/stages/layer2-resolve.ts:Layer2Output
// ─────────────────────────────────────────────────────────────────────────────

export interface EntityResolution {
  readonly canonical: string;
  readonly source: EntityResolutionSource;
  readonly correctionApplied: boolean;
  readonly isCharitableCertified?: boolean;
  readonly type?: string;   // e.g. 'verein', 'bank', 'arbeitgeber'
  readonly country?: string;
  readonly region?: string; // 'EU' | 'EWR' | other
  /** Free-form whitelist id when an exact match was found. */
  readonly whitelistId?: string;
}

export interface Layer2Stats {
  readonly entitiesScanned: number;
  readonly whitelistExact: number;
  readonly whitelistFuzzy: number;
  readonly llmGrounded: number;
  readonly llmUncertain: number;
  readonly unresolved: number;
  readonly correctionsApplied: number;
  readonly ms: number;
}

export interface Layer2Result {
  readonly subDocId: string;
  /** Same shape as Layer1Result.nested but with `*_resolution` shadow keys. */
  readonly nested: Readonly<Record<string, unknown>>;
  readonly stats: Layer2Stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Layer 4 — bundle aggregate input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pair of L1+L2 results for a single sub-doc, plus split metadata. The
 * aggregator never sees raw OCR or page-split objects — only this typed pair.
 */
export interface SubDocLayered {
  readonly subDocId: string;
  readonly title: string;
  readonly headerKind: string;
  readonly pages: ReadonlyArray<number>;
  readonly classifierHint: ElsterDocClass | string | null;
  readonly layer1: Layer1Result;
  /** Optional — bundle path may skip L2 today; aggregator must handle absence. */
  readonly layer2?: Layer2Result;
}

export interface BundleAggregateInput {
  readonly subDocs: ReadonlyArray<SubDocLayered>;
  /** Container the aggregator must cite as authority for every emitted eCode. */
  readonly container: ContainerProof;
  /** Bundle-level run id (sturm runId). */
  readonly runId: string;
}

export interface ContainerProof {
  readonly id: string;          // e.g. '0711:elster:bmf:jahresdok-2024:v1'
  readonly schemaVersion: number;
  readonly merkleRoot: string;  // hex, no 0x prefix
  readonly containerSha256: string;
  readonly issuerFingerprint: string; // 'sha256:...'
  readonly anchorChain?: string;
  readonly anchorTx?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Layer 4 — aggregate output (THE contract Architect locks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-eCode provenance entry. EVERY contribution from a sub-doc to the
 * final aggregate is recorded here. Auditors must be able to reconstruct
 * the aggregateValue from contributions[] alone.
 */
export interface ECodeContribution {
  readonly subDocId: string;
  readonly docClass: ElsterDocClass | string;
  readonly ruleDescription: string;
  readonly ruleRechtsgrundlage?: string;
  readonly inputCount: number;     // raw items considered
  readonly filteredCount: number;  // items that passed rule.filter
  readonly value: ECodeValue;
  readonly ceilingApplied: boolean;
  /** Resolved entity that drove the contribution, when applicable. */
  readonly entity?: EntityResolution;
}

/** Conflict surfaced when two sub-docs disagree on a non-summable code. */
export interface AggregateConflict {
  readonly code: ECode;
  readonly strategy: AggregateStrategy;
  readonly contributions: ReadonlyArray<ECodeContribution>;
  readonly resolution:
    | { readonly kind: 'kept'; readonly value: ECodeValue; readonly reason: string }
    | { readonly kind: 'rejected'; readonly reason: string };
}

export interface AggregatedECode {
  readonly code: ECode;
  readonly value: ECodeValue;
  readonly strategy: AggregateStrategy;
  readonly contributions: ReadonlyArray<ECodeContribution>;
  /** Sum-strategy codes carry the rolled-up numeric total here for fast lookup. */
  readonly numericTotal?: number;
}

export interface BundleAggregateSummary {
  readonly totalSubDocs: number;
  readonly subDocsWithCodes: number;
  readonly totalContributions: number;
  readonly uniqueCodes: number;
  readonly conflictCount: number;
  readonly skippedSubDocs: number;
  readonly ms: number;
}

/**
 * Final, deterministic output of `elster-v3/multi-aggregate`. Consumers
 * (validator, ELSTER-export, c-pro UI) read ONLY this shape.
 */
export interface BundleAggregateOutput {
  /** Flat eCode → value, identical semantics to CanonicalLayer.codes. */
  readonly codes: Readonly<Record<ECode, ECodeValue>>;
  /** Full per-eCode aggregate detail; codes[] above is derived from this. */
  readonly aggregated: ReadonlyArray<AggregatedECode>;
  /** Surfaced conflicts; empty array means clean run. */
  readonly conflicts: ReadonlyArray<AggregateConflict>;
  /** Sub-docs that produced no code contributions and why. */
  readonly skipped: ReadonlyArray<{
    readonly subDocId: string;
    readonly reason: 'no-nested' | 'no-class' | 'no-rule-applied' | 'l1-error';
    readonly detail?: string;
  }>;
  /** Container that authorized the eCode catalog used by every rule. */
  readonly container: ContainerProof;
  /** Aggregate-level summary stats. */
  readonly summary: BundleAggregateSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Strategy lookup table — single source of truth for non-numeric semantics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default aggregation strategy per eCode. Codes NOT listed here default to
 * `replace-on-conflict` (last write wins, conflict logged). The aggregator
 * MUST consult this table; rule authors override per-rule via attaching a
 * strategy hint to PROJECTION_RULES (out of scope of this contract).
 */
export const DEFAULT_STRATEGY: Readonly<Record<string, AggregateStrategy>> = Object.freeze({
  // Capital interest cluster — sum across banks
  E1900701: 'sum',
  E1900702: 'sum',
  E1901401: 'sum',
  E1901501: 'sum',
  E1901702: 'sum',
  E1904701: 'sum',
  E1904801: 'sum',
  // Donations — sum across receipts
  E0108405: 'sum',
  E0108508: 'sum',
  // Wage — first wins (one Lohnsteuerbescheinigung per employer is canonical)
  E0200201: 'first',
  // Religion / church-tax flag — count non-null
  E1900601: 'count',
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Type guards (runtime, exported for the aggregator + tests)
// ─────────────────────────────────────────────────────────────────────────────

export const isAggregatedECode = (v: unknown): v is AggregatedECode =>
  typeof v === 'object' && v !== null
  && isECode((v as AggregatedECode).code)
  && Array.isArray((v as AggregatedECode).contributions);

export const isBundleAggregateOutput = (v: unknown): v is BundleAggregateOutput =>
  typeof v === 'object' && v !== null
  && typeof (v as BundleAggregateOutput).codes === 'object'
  && Array.isArray((v as BundleAggregateOutput).aggregated)
  && Array.isArray((v as BundleAggregateOutput).conflicts)
  && Array.isArray((v as BundleAggregateOutput).skipped);
