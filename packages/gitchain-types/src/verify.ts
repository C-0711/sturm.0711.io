/**
 * @0711/gitchain-types — provenance verifier
 *
 * Phase F.2 / Task 4. Self-validates a BundleAggregateOutput against the
 * BundleAggregateInput that produced it. Designed to be run:
 *
 *   - in unit tests (parity matrix, Task 6)
 *   - in CI as the final gate before a container is signed
 *   - inside the on-chain attestation worker before merkleRoot computation
 *
 * The contract is intentionally pure: no IO, no time, no randomness.
 * Every claim in `output.aggregated[]` must reduce to claims that already
 * exist in `input.subDocs[].layer1.nested`. If the check passes, the
 * output is reconstructable from the input alone.
 */

import {
  isECode,
  type AggregatedECode,
  type AggregateStrategy,
  type BundleAggregateInput,
  type BundleAggregateOutput,
  type ECode,
  type ECodeContribution,
  type ECodeValue,
  type SubDocLayered,
} from './elster.ts';

export interface VerifyIssue {
  readonly severity: 'error' | 'warning';
  readonly code:
    | 'unknown-subdoc'
    | 'docclass-mismatch'
    | 'value-not-in-source'
    | 'aggregate-mismatch'
    | 'numeric-total-mismatch'
    | 'codes-map-mismatch'
    | 'conflict-not-in-aggregated'
    | 'skipped-subdoc-still-contributing'
    | 'invalid-ecode'
    | 'container-mismatch';
  readonly subDocId?: string;
  readonly eCode?: ECode;
  readonly detail: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<VerifyIssue>;
}

/**
 * Walk every contribution in `output.aggregated[]` + `output.conflicts[]`
 * and assert it's traceable to `input`. Also re-runs the strategy on each
 * code's contributions and compares against the recorded `value` /
 * `numericTotal`.
 *
 * Returns `{ ok: false, issues }` on any error-severity issue. Warnings
 * never flip ok to false but are surfaced for telemetry.
 */
export function verifyProvenance(
  output: BundleAggregateOutput,
  input: BundleAggregateInput,
): VerifyResult {
  const issues: VerifyIssue[] = [];
  const subDocsById = indexSubDocsById(input.subDocs);
  const skippedIds = new Set(output.skipped.map((s) => s.subDocId));

  // 0) Container identity must agree (id, schemaVersion, merkleRoot).
  if (
    input.container.id !== output.container.id ||
    input.container.schemaVersion !== output.container.schemaVersion ||
    input.container.merkleRoot !== output.container.merkleRoot
  ) {
    issues.push({
      severity: 'error',
      code: 'container-mismatch',
      detail:
        'output.container disagrees with input.container on id/schemaVersion/merkleRoot',
    });
  }

  // 1) Walk aggregated codes and check every contribution.
  for (const agg of output.aggregated) {
    if (!isECode(agg.code)) {
      issues.push({
        severity: 'error',
        code: 'invalid-ecode',
        eCode: agg.code,
        detail: `aggregated[].code does not match /^E\\d{7}$/: ${String(agg.code)}`,
      });
    }
    for (const c of agg.contributions) {
      verifyOneContribution(c, agg.code, subDocsById, skippedIds, issues);
    }
    // Re-run the strategy and compare the recorded result.
    const recomputed = simulateStrategy(agg.strategy, agg.contributions);
    if (!eq(agg.value, recomputed.value)) {
      issues.push({
        severity: 'error',
        code: 'aggregate-mismatch',
        eCode: agg.code,
        detail: `recorded value ${stringify(agg.value)} != recomputed ${stringify(recomputed.value)} for strategy ${agg.strategy}`,
      });
    }
    if (agg.numericTotal !== undefined && agg.numericTotal !== recomputed.numericTotal) {
      issues.push({
        severity: 'error',
        code: 'numeric-total-mismatch',
        eCode: agg.code,
        detail: `recorded numericTotal ${agg.numericTotal} != recomputed ${String(recomputed.numericTotal)}`,
      });
    }
    // codes[] must mirror aggregated[].value
    if (!eq(output.codes[agg.code], agg.value)) {
      issues.push({
        severity: 'error',
        code: 'codes-map-mismatch',
        eCode: agg.code,
        detail: `output.codes[${agg.code}] = ${stringify(output.codes[agg.code])} ≠ aggregated.value = ${stringify(agg.value)}`,
      });
    }
  }

  // 2) Conflicts must reference codes that are also in aggregated[].
  const aggregatedByCode = new Map(output.aggregated.map((a) => [a.code, a]));
  for (const conflict of output.conflicts) {
    if (!aggregatedByCode.has(conflict.code)) {
      issues.push({
        severity: 'error',
        code: 'conflict-not-in-aggregated',
        eCode: conflict.code,
        detail: `conflict on code ${conflict.code} but no matching aggregated[] entry`,
      });
    }
    for (const c of conflict.contributions) {
      verifyOneContribution(c, conflict.code, subDocsById, skippedIds, issues);
    }
  }

  // 3) codes map should not contain codes absent from aggregated[].
  for (const code of Object.keys(output.codes)) {
    if (!aggregatedByCode.has(code as ECode)) {
      issues.push({
        severity: 'error',
        code: 'codes-map-mismatch',
        eCode: code as ECode,
        detail: `output.codes has ${code} but aggregated[] does not`,
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return { ok: errorCount === 0, issues };
}

// ─── internals ───────────────────────────────────────────────────────────

function verifyOneContribution(
  c: ECodeContribution,
  eCode: ECode,
  subDocsById: ReadonlyMap<string, SubDocLayered>,
  skippedIds: ReadonlySet<string>,
  issues: VerifyIssue[],
): void {
  const subDoc = subDocsById.get(c.subDocId);
  if (!subDoc) {
    issues.push({
      severity: 'error',
      code: 'unknown-subdoc',
      subDocId: c.subDocId,
      eCode,
      detail: `contribution references subDocId not in input.subDocs[]`,
    });
    return;
  }
  if (skippedIds.has(c.subDocId)) {
    issues.push({
      severity: 'error',
      code: 'skipped-subdoc-still-contributing',
      subDocId: c.subDocId,
      eCode,
      detail: `contribution from subDocId that appears in output.skipped[]`,
    });
  }
  if (subDoc.layer1.docClass !== c.docClass) {
    issues.push({
      severity: 'warning',
      code: 'docclass-mismatch',
      subDocId: c.subDocId,
      eCode,
      detail: `contribution.docClass="${c.docClass}" but layer1.docClass="${subDoc.layer1.docClass}"`,
    });
  }
  // Walk the layer1.nested for the value.
  if (!nestedHasValue(subDoc.layer1.nested, eCode, c.value)) {
    issues.push({
      severity: 'error',
      code: 'value-not-in-source',
      subDocId: c.subDocId,
      eCode,
      detail: `value ${stringify(c.value)} for ${eCode} not present in layer1.nested`,
    });
  }
}

function indexSubDocsById(
  subDocs: ReadonlyArray<SubDocLayered>,
): Map<string, SubDocLayered> {
  const m = new Map<string, SubDocLayered>();
  for (const sd of subDocs) m.set(sd.subDocId, sd);
  return m;
}

/**
 * `layer1.nested` is `Record<anlage, Record<feldName, value>>` for the
 * `belege-multi → layer4-aggregate` flow, but the contract permits any
 * shape. Walk it depth-first and check whether any leaf at any path with
 * key === `eCode` has the given value.
 */
function nestedHasValue(
  nested: Readonly<Record<string, unknown>>,
  eCode: ECode,
  value: ECodeValue,
): boolean {
  return walk(nested);

  function walk(node: unknown, keyOnPath?: string): boolean {
    if (node === null || node === undefined) return false;
    if (typeof node !== 'object') {
      if (keyOnPath !== eCode) return false;
      return eqLoose(node as ECodeValue, value);
    }
    if (Array.isArray(node)) return node.some((item) => walk(item, keyOnPath));
    for (const [k, v] of Object.entries(node)) {
      if (walk(v, k)) return true;
    }
    return false;
  }
}

interface SimResult {
  value: ECodeValue;
  numericTotal?: number;
}

/**
 * Re-runs the per-code strategy on the contribution list. Mirror of the
 * implementation in the aggregator stage; kept here so the verifier
 * doesn't depend on the runtime package.
 */
function simulateStrategy(
  strategy: AggregateStrategy,
  contribs: ReadonlyArray<ECodeContribution>,
): SimResult {
  switch (strategy) {
    case 'sum': {
      let total = 0;
      let any = false;
      for (const c of contribs) {
        const n = parseGermanNumberLocal(c.value);
        if (n === null) continue;
        total += n;
        any = true;
      }
      return any ? { value: total, numericTotal: total } : { value: null };
    }
    case 'max': {
      let best: number | null = null;
      for (const c of contribs) {
        const n = parseGermanNumberLocal(c.value);
        if (n === null) continue;
        if (best === null || n > best) best = n;
      }
      return best !== null
        ? { value: best, numericTotal: best }
        : { value: null };
    }
    case 'first': {
      for (const c of contribs) {
        if (c.value !== null && c.value !== '') return { value: c.value };
      }
      return { value: null };
    }
    case 'count': {
      const n = contribs.filter(
        (c) => c.value !== null && c.value !== '',
      ).length;
      return { value: n, numericTotal: n };
    }
    case 'replace-on-conflict': {
      const last = contribs.at(-1);
      return { value: last ? last.value : null };
    }
    case 'reject-on-conflict': {
      const distinct = new Set(contribs.map((c) => stringify(c.value)));
      if (distinct.size > 1) return { value: null };
      return { value: contribs[0]?.value ?? null };
    }
  }
}

function parseGermanNumberLocal(value: ECodeValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const cleaned = trimmed.includes(',')
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed;
  const stripped = cleaned.replace(/[€\s]/g, '');
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

function eq(a: ECodeValue, b: ECodeValue): boolean {
  if (a === null && b === null) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  return a === b;
}

function eqLoose(a: ECodeValue, b: ECodeValue): boolean {
  if (eq(a, b)) return true;
  // numeric equality across formatting (e.g. "1.234,56" === 1234.56)
  const na = parseGermanNumberLocal(a);
  const nb = parseGermanNumberLocal(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < 1e-9;
  return false;
}

function stringify(v: ECodeValue): string {
  return JSON.stringify(v);
}
