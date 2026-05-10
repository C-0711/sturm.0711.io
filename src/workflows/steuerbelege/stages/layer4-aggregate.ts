import { defineStage } from '../../../core/stage.ts';
import type { BelegErgebnis } from './belege-multi.ts';
import {
  DEFAULT_STRATEGY,
  isECode,
  type AggregateConflict,
  type AggregatedECode,
  type AggregateStrategy,
  type BundleAggregateOutput,
  type BundleAggregateSummary,
  type ContainerProof,
  type ECode,
  type ECodeContribution,
  type ECodeValue,
  type Layer1Result,
  type SubDocLayered,
} from '../../../../packages/gitchain-types/src/elster.ts';

/**
 * Stage `steuerbelege/layer4-aggregate` — Phase F.2 / Task 2.
 *
 * Walks `belege[]` from the upstream `steuerbelege/belege-multi` stage,
 * groups every non-null sub-doc field that matches the eCode pattern,
 * applies the per-code strategy from `DEFAULT_STRATEGY` (sum / max /
 * first / count / replace-on-conflict / reject-on-conflict) and produces
 * the locked `BundleAggregateOutput` defined by `@0711/gitchain-types`.
 *
 * Deterministic: no LLM, no IO beyond `ctx.artifacts.write`. Input order
 * is preserved by sorting contributions by `subDocId`.
 */

export interface Layer4AggregateInput {
  belege: BelegErgebnis[];
  /** Bundle-level run id (sturm runId). Falls back to a synthetic id. */
  runId?: string;
  /** Optional ContainerProof override; sensible defaults otherwise. */
  container?: Partial<ContainerProof>;
}

export const layer4AggregateStage = defineStage<
  Layer4AggregateInput,
  BundleAggregateOutput,
  Record<string, never>
>({
  id: 'steuerbelege/layer4-aggregate',
  name: 'Layer 4 — Bundle-Aggregat',
  description:
    'Aggregiert die per Beleg extrahierten eCode-Werte deterministisch zu einem signierbaren BundleAggregateOutput. Per-Code-Strategie via DEFAULT_STRATEGY; jede Kontribution traced subDocId + ruleDescription.',

  async run(input, ctx) {
    const t0 = Date.now();
    const subDocs = belegeToSubDocs(input.belege);
    const container = buildContainerProof(input.container);

    const contributionsByCode = new Map<string, ECodeContribution[]>();
    const skipped: BundleAggregateOutput['skipped'][number][] = [];

    for (const subDoc of subDocs) {
      const { layer1 } = subDoc;
      if (layer1.error) {
        skipped.push({
          subDocId: layer1.subDocId,
          reason: 'l1-error',
          detail: layer1.error,
        });
        continue;
      }
      const nested = layer1.nested as Record<string, unknown>;
      const nestedEntries = Object.entries(nested);
      if (nestedEntries.length === 0) {
        skipped.push({ subDocId: layer1.subDocId, reason: 'no-nested' });
        continue;
      }
      let contributed = false;
      for (const [anlage, fieldsRaw] of nestedEntries) {
        if (!fieldsRaw || typeof fieldsRaw !== 'object') continue;
        const fields = fieldsRaw as Record<string, unknown>;
        for (const [feldName, rawValue] of Object.entries(fields)) {
          if (!isECode(feldName)) continue;
          if (rawValue === null || rawValue === undefined) continue;
          if (typeof rawValue === 'string' && rawValue.trim() === '') continue;
          const value = rawValue as ECodeValue;
          const arr = contributionsByCode.get(feldName) ?? [];
          arr.push({
            subDocId: layer1.subDocId,
            docClass: layer1.docClass,
            ruleDescription: `extracted from anlage ${anlage}`,
            inputCount: 1,
            filteredCount: 1,
            value,
            ceilingApplied: false,
          });
          contributionsByCode.set(feldName, arr);
          contributed = true;
        }
      }
      if (!contributed) {
        const reason: BundleAggregateOutput['skipped'][number]['reason'] =
          subDoc.classifierHint ? 'no-rule-applied' : 'no-class';
        skipped.push({ subDocId: layer1.subDocId, reason });
      }
    }

    const aggregated: AggregatedECode[] = [];
    const conflicts: AggregateConflict[] = [];
    const codes: Record<string, ECodeValue> = {};

    const sortedCodes = [...contributionsByCode.keys()].sort();
    for (const codeStr of sortedCodes) {
      const code = codeStr as ECode;
      const contribs = sortContribsBySubDoc(contributionsByCode.get(codeStr) ?? []);
      const strategy: AggregateStrategy =
        DEFAULT_STRATEGY[codeStr] ?? 'replace-on-conflict';
      const result = applyStrategy(strategy, contribs);
      if (result.conflict) {
        conflicts.push({
          code,
          strategy,
          contributions: contribs,
          resolution: result.conflict,
        });
      }
      const aggECode: AggregatedECode = {
        code,
        value: result.value,
        strategy,
        contributions: contribs,
        ...(result.numericTotal !== undefined
          ? { numericTotal: result.numericTotal }
          : {}),
      };
      aggregated.push(aggECode);
      codes[codeStr] = result.value;

      ctx.emit('aggregate_code', {
        code: codeStr,
        strategy,
        contributions: contribs.length,
        value: result.value,
        ...(result.conflict ? { conflict: result.conflict.kind } : {}),
      });
    }

    const totalContributions = aggregated.reduce(
      (s, a) => s + a.contributions.length,
      0,
    );
    const summary: BundleAggregateSummary = {
      totalSubDocs: subDocs.length,
      subDocsWithCodes: subDocs.length - skipped.length,
      totalContributions,
      uniqueCodes: aggregated.length,
      conflictCount: conflicts.length,
      skippedSubDocs: skipped.length,
      ms: Date.now() - t0,
    };

    const out: BundleAggregateOutput = {
      codes: codes as Readonly<Record<ECode, ECodeValue>>,
      aggregated,
      conflicts,
      skipped,
      container,
      summary,
    };

    await ctx.artifacts.write('bundle_aggregate.json', out);
    return out;
  },
});

// ─── helpers ─────────────────────────────────────────────────────────────

function belegeToSubDocs(belege: BelegErgebnis[]): SubDocLayered[] {
  return belege.map((b) => {
    const subDocId = `subdoc_${String(b.index).padStart(2, '0')}`;
    const docClass = b.klassifikation.typ_id ?? 'unknown';
    const layer1: Layer1Result = {
      subDocId,
      docClass,
      schemaName: `belege/${docClass}`,
      schemaId: `belege/${docClass}`,
      nested: (b.extraktion.values ?? {}) as Readonly<Record<string, unknown>>,
      llmMs: 0,
      ms: b.extraktion.ms,
      ...(b.extraktion.skipped
        ? { error: b.extraktion.reason ?? 'skipped' }
        : {}),
    };
    return {
      subDocId,
      title: b.header,
      headerKind: b.klassifikation.label ?? docClass,
      pages: b.seiten,
      classifierHint: b.klassifikation.typ_id ?? null,
      layer1,
    };
  });
}

function buildContainerProof(p?: Partial<ContainerProof>): ContainerProof {
  const zeroSha = '0'.repeat(64);
  return {
    id: p?.id ?? '0711:elster:bmf:jahresdok-2024:v1',
    schemaVersion: p?.schemaVersion ?? 1,
    merkleRoot: p?.merkleRoot ?? zeroSha,
    containerSha256: p?.containerSha256 ?? zeroSha,
    issuerFingerprint: p?.issuerFingerprint ?? 'sha256:unknown',
    ...(p?.anchorChain ? { anchorChain: p.anchorChain } : {}),
    ...(p?.anchorTx !== undefined ? { anchorTx: p.anchorTx } : {}),
  };
}

function sortContribsBySubDoc(arr: ECodeContribution[]): ECodeContribution[] {
  return [...arr].sort((a, b) => a.subDocId.localeCompare(b.subDocId));
}

interface StrategyResult {
  value: ECodeValue;
  numericTotal?: number;
  conflict?: AggregateConflict['resolution'];
}

function applyStrategy(
  strategy: AggregateStrategy,
  contribs: ECodeContribution[],
): StrategyResult {
  switch (strategy) {
    case 'sum': {
      let total = 0;
      let any = false;
      for (const c of contribs) {
        const n = parseGermanNumber(c.value);
        if (n === null) continue;
        total += n;
        any = true;
      }
      return any ? { value: total, numericTotal: total } : { value: null };
    }
    case 'max': {
      let best: number | null = null;
      for (const c of contribs) {
        const n = parseGermanNumber(c.value);
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
      const distinctSerialized = new Set(
        contribs.map((c) => JSON.stringify(c.value)),
      );
      const last = contribs.at(-1);
      const value = last ? last.value : null;
      if (distinctSerialized.size > 1) {
        return {
          value,
          conflict: {
            kind: 'kept',
            value,
            reason: `replace-on-conflict: ${distinctSerialized.size} distinct values, last-write-wins`,
          },
        };
      }
      return { value };
    }
    case 'reject-on-conflict': {
      const distinctSerialized = new Set(
        contribs.map((c) => JSON.stringify(c.value)),
      );
      if (distinctSerialized.size > 1) {
        return {
          value: null,
          conflict: {
            kind: 'rejected',
            reason: `reject-on-conflict: ${distinctSerialized.size} distinct values`,
          },
        };
      }
      return { value: contribs[0]?.value ?? null };
    }
  }
}

/**
 * Parse a German-formatted numeric string. Returns `null` if not numeric.
 *
 *   "1.234,56"  → 1234.56  (German thousands `.`, decimal `,`)
 *   "1234,56"   → 1234.56
 *   "1234.56"   → 1234.56  (already English-format)
 *   "1.234"     → 1234     (treated as thousands; ambiguous but consistent)
 *   ""          → null
 *   "abc"       → null
 *   42          → 42       (already a number)
 */
export function parseGermanNumber(value: ECodeValue): number | null {
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
