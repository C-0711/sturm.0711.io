import { defineStage } from '../core/stage.ts';
import type { FanoutOutput } from './compare-fanout.ts';

export interface KpiConfig {
  /**
   * Optional id of a fanout/merge stage whose branches should be cross-compared.
   * If set, `cross_branch_agreement` is computed against `fanout.branches`.
   */
  fanoutStageId?: string;
  /**
   * Optional id of an upstream `eval/critic-llm` stage. If set, KPI pulls its
   * `score` out of ctx.results and blends it into the composite score with
   * weight `scoreWeights.critic` (default 0.2). Lets Quality-Trias pipelines
   * surface critic-trust as a first-class KPI signal.
   */
  criticStageId?: string;
  /**
   * Optional id of an upstream `extract/span-linker` stage. If set, KPI pulls
   * its `coverage` into the composite under `scoreWeights.span_coverage`
   * (default 0.1).
   */
  spanLinkerStageId?: string;
  /**
   * Optional id of an upstream `extract/cross-validator` stage. If set, KPI
   * surfaces its `violations.length` and per-severity counts; failing block
   * violations drag the composite score down via `scoreWeights.validator`.
   */
  crossValidatorStageId?: string;
  /**
   * Optional list of field names that must be present in the final output.
   * When set, schema_coverage = (#required found) / (#required).
   */
  requiredFields?: string[];
  /**
   * Optional regex per field name to assert format conformance.
   * Example: { idnr: '^[0-9]{11}$', betrag: '^[0-9.,]+ ?€?$' }
   */
  formatRegex?: Record<string, string>;
  /**
   * Weights for the final composite score. Missing keys default to 0.
   * Score = sum(weight_i * metric_i) — clamped to [0, 1].
   */
  scoreWeights?: {
    schema_coverage?: number;
    format_conformance?: number;
    cross_branch_agreement?: number;
    speed?: number; // 1 / (1 + total_seconds)
    critic?: number;          // LLM-judge score, 0..1
    span_coverage?: number;   // fraction of leaves linked to source, 0..1
    validator?: number;       // 1 - (#block / max(#rules, 1))
  };
  /** Score >= passThreshold ⇒ verdict='pass'. Default 0.85. */
  passThreshold?: number;
}

export interface KpiBranchReport {
  ms: number;
  fields: number;
  schema_coverage: number;
  format_conformance: number;
  cost_usd: number; // 0 for local; cloud stages can populate via emit later
  error?: string;
}

export interface KpiReport {
  total_duration_ms: number;
  stage_durations_ms: Record<string, number>;
  field_count: number;
  schema_coverage: number;
  format_conformance: number;
  cross_branch: null | {
    fanoutStageId: string;
    branches: string[];
    fields_unanimous: number;
    fields_partial: number;
    fields_disputed: number;
    disputed_keys: string[];
    per_branch: Record<string, KpiBranchReport>;
  };
  score: number;
  verdict: 'pass' | 'fail';
  /** Quality-Trias signals (populated when upstream stage IDs configured). */
  quality?: {
    critic_score?: number;
    critic_accept?: boolean;
    span_coverage?: number;
    validator_pass?: boolean;
    validator_block_count?: number;
    validator_total_violations?: number;
  };
  // Verbose components for UI transparency.
  components: {
    schema_coverage: number;
    format_conformance: number;
    cross_branch_agreement: number;
    speed: number;
    critic: number;
    span_coverage: number;
    validator: number;
  };
}

function flattenToValues(obj: unknown, out: Record<string, string> = {}, prefix = ''): Record<string, string> {
  if (obj == null) return out;
  if (typeof obj !== 'object') {
    if (prefix) out[prefix] = String(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenToValues(v, out, prefix ? `${prefix}[${i}]` : `[${i}]`));
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      flattenToValues(v, out, key);
    } else if (v !== undefined && v !== null && v !== '') {
      out[key] = String(v);
    }
  }
  return out;
}

function countNonEmpty(obj: unknown): number {
  return Object.keys(flattenToValues(obj)).length;
}

function computeSchemaCoverage(obj: unknown, required: string[] | undefined): number {
  if (!required || required.length === 0) return 1;
  const flat = flattenToValues(obj);
  // Match by leaf-key OR by full dotted path.
  const leaves = new Set<string>();
  for (const k of Object.keys(flat)) {
    leaves.add(k);
    const last = k.split('.').pop();
    if (last) leaves.add(last);
  }
  const found = required.filter((r) => leaves.has(r)).length;
  return required.length === 0 ? 1 : found / required.length;
}

function computeFormatConformance(obj: unknown, rxMap: Record<string, string> | undefined): number {
  if (!rxMap) return 1;
  const entries = Object.entries(rxMap);
  if (entries.length === 0) return 1;
  const flat = flattenToValues(obj);
  let total = 0;
  let pass = 0;
  for (const [fieldName, pattern] of entries) {
    let rx: RegExp;
    try { rx = new RegExp(pattern); } catch { continue; }
    // Match any flat key whose leaf matches fieldName, or the full path.
    for (const [k, v] of Object.entries(flat)) {
      const leaf = k.split('.').pop();
      if (k === fieldName || leaf === fieldName) {
        total += 1;
        if (rx.test(v)) pass += 1;
      }
    }
  }
  return total === 0 ? 1 : pass / total;
}

function crossBranchAgreement(branches: Record<string, unknown>): {
  unanimous: number;
  partial: number;
  disputed: number;
  disputedKeys: string[];
  perBranch: Record<string, { fields: number }>;
} {
  const branchIds = Object.keys(branches);
  const perBranchFlat: Record<string, Record<string, string>> = {};
  const allKeys = new Set<string>();
  for (const id of branchIds) {
    const flat = flattenToValues(branches[id]);
    perBranchFlat[id] = flat;
    for (const k of Object.keys(flat)) allKeys.add(k);
  }
  let unanimous = 0;
  let partial = 0;
  let disputed = 0;
  const disputedKeys: string[] = [];
  for (const k of allKeys) {
    const valuesSeen = new Set<string>();
    let presentCount = 0;
    for (const id of branchIds) {
      const v = perBranchFlat[id]?.[k];
      if (v !== undefined) { valuesSeen.add(v); presentCount += 1; }
    }
    if (presentCount < 2) continue; // need at least 2 branches to call agreement
    if (valuesSeen.size === 1 && presentCount === branchIds.length) unanimous += 1;
    else if (valuesSeen.size === 1) partial += 1;
    else { disputed += 1; disputedKeys.push(k); }
  }
  const perBranch: Record<string, { fields: number }> = {};
  for (const id of branchIds) perBranch[id] = { fields: Object.keys(perBranchFlat[id] ?? {}).length };
  return { unanimous, partial, disputed, disputedKeys: disputedKeys.sort(), perBranch };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

/**
 * eval/kpi — reads ctx.results to compute pipeline-level KPIs and writes a
 * structured report. Designed to sit at the end of a workflow.
 *
 * Input: any upstream output (used as "the document under measurement").
 * Output: KpiReport with composite score and (optionally) cross-branch
 * agreement when a compare/fanout stage is referenced via fanoutStageId.
 */
export const evalKpiStage = defineStage<unknown, KpiReport, KpiConfig>({
  id: 'eval/kpi',
  name: 'KPI — score the pipeline run',
  description:
    'Reads stage durations from ctx.results, counts fields, checks format ' +
    'conformance, computes cross-branch agreement if a fanout is referenced, ' +
    'and writes kpi_report.json with a composite score.',
  hints: {
    inputs: 'any upstream object — used as the "document under measurement" for schema_coverage / format_conformance',
    outputs: 'total_duration_ms, stage_durations_ms, field_count, schema_coverage, format_conformance, cross_branch?, score (0..1), verdict (pass|fail)',
    configExample: '{"fanoutStageId": "ocr_fanout", "requiredFields": ["identifikationsnummer","bruttoarbeitslohn"], "formatRegex": {"identifikationsnummer": "^[0-9]{11}$"}, "passThreshold": 0.75}',
    inputPorts: [
      { name: 'input', type: 'any', description: 'Document under measurement' },
    ],
    outputPorts: [
      { name: 'report', type: 'kpi-report' },
      { name: 'score', type: 'number' },
      { name: 'verdict', type: 'enum:pass|fail' },
    ],
  },

  async run(input, ctx) {
    const cfg = ctx.config ?? ({} as KpiConfig);
    const stageDurations: Record<string, number> = {};
    let totalMs = 0;
    for (const [sid, r] of Object.entries(ctx.results)) {
      if (typeof r.ms === 'number') {
        stageDurations[sid] = r.ms;
        totalMs += r.ms;
      }
    }

    // "Final output under measurement" — the input to the KPI node.
    const fieldCount = countNonEmpty(input);
    const schemaCoverage = computeSchemaCoverage(input, cfg.requiredFields);
    const formatConformance = computeFormatConformance(input, cfg.formatRegex);

    let crossBranch: KpiReport['cross_branch'] = null;
    let crossBranchAgreementScore = 1;
    if (cfg.fanoutStageId) {
      const fanoutResult = ctx.results[cfg.fanoutStageId]?.output as FanoutOutput | undefined;
      if (fanoutResult && fanoutResult.branches) {
        const cba = crossBranchAgreement(fanoutResult.branches);
        const totalCompared = cba.unanimous + cba.partial + cba.disputed;
        crossBranchAgreementScore = totalCompared === 0 ? 1
          : (cba.unanimous + 0.5 * cba.partial) / totalCompared;
        const perBranchReport: Record<string, KpiBranchReport> = {};
        for (const [id, bo] of Object.entries(fanoutResult.branches)) {
          perBranchReport[id] = {
            ms: fanoutResult.perBranchMs[id] ?? 0,
            fields: countNonEmpty(bo),
            schema_coverage: computeSchemaCoverage(bo, cfg.requiredFields),
            format_conformance: computeFormatConformance(bo, cfg.formatRegex),
            cost_usd: 0,
          };
        }
        for (const [id, err] of Object.entries(fanoutResult.errors)) {
          perBranchReport[id] = perBranchReport[id] ?? {
            ms: fanoutResult.perBranchMs[id] ?? 0,
            fields: 0, schema_coverage: 0, format_conformance: 0, cost_usd: 0,
          };
          perBranchReport[id].error = err;
        }
        crossBranch = {
          fanoutStageId: cfg.fanoutStageId,
          branches: Object.keys(fanoutResult.branches),
          fields_unanimous: cba.unanimous,
          fields_partial: cba.partial,
          fields_disputed: cba.disputed,
          disputed_keys: cba.disputedKeys,
          per_branch: perBranchReport,
        };
      }
    }

    const speed = 1 / (1 + totalMs / 1000);

    // Quality-Trias signal pickup. Each is optional; default to "neutral 1.0" so
    // un-configured pipelines aren't dragged down by missing data.
    let criticScore = 1;
    let spanCoverage = 1;
    let validatorScore = 1;
    let quality: KpiReport['quality'] = undefined;
    if (cfg.criticStageId || cfg.spanLinkerStageId || cfg.crossValidatorStageId) {
      quality = {};
      if (cfg.criticStageId) {
        const out = ctx.results[cfg.criticStageId]?.output as { score?: number; accept?: boolean } | undefined;
        if (out && typeof out.score === 'number') {
          criticScore = clamp01(out.score);
          quality.critic_score = out.score;
          quality.critic_accept = out.accept;
        }
      }
      if (cfg.spanLinkerStageId) {
        const out = ctx.results[cfg.spanLinkerStageId]?.output as { coverage?: number } | undefined;
        if (out && typeof out.coverage === 'number') {
          spanCoverage = clamp01(out.coverage);
          quality.span_coverage = out.coverage;
        }
      }
      if (cfg.crossValidatorStageId) {
        const out = ctx.results[cfg.crossValidatorStageId]?.output as {
          pass?: boolean; violations?: Array<{ severity?: string }>;
        } | undefined;
        if (out) {
          const violations = out.violations ?? [];
          const blocks = violations.filter((v) => v?.severity === 'block').length;
          // Score = 1 if no blocks; degrades linearly with block count up to 5.
          validatorScore = clamp01(1 - blocks * 0.2);
          quality.validator_pass = !!out.pass;
          quality.validator_block_count = blocks;
          quality.validator_total_violations = violations.length;
        }
      }
    }

    // Quality-only composite. Speed is reported as a stage-duration breakdown
    // in `total_duration_ms` + `stage_durations_ms` but is NOT a score-component
    // by default — it's a latency/SLA signal, not a defensibility signal.
    // Callers can still opt-in by setting `scoreWeights.speed > 0`.
    const w = {
      schema_coverage: cfg.scoreWeights?.schema_coverage ?? 0.20,
      format_conformance: cfg.scoreWeights?.format_conformance ?? 0.15,
      cross_branch_agreement: cfg.scoreWeights?.cross_branch_agreement ?? 0.20,
      speed: cfg.scoreWeights?.speed ?? 0,           // ← out of quality composite by default
      critic: cfg.scoreWeights?.critic ?? (cfg.criticStageId ? 0.25 : 0),
      span_coverage: cfg.scoreWeights?.span_coverage ?? (cfg.spanLinkerStageId ? 0.15 : 0),
      validator: cfg.scoreWeights?.validator ?? (cfg.crossValidatorStageId ? 0.25 : 0),
    };
    // Normalise weights so they sum to ≤ 1 (otherwise composite can exceed 1).
    const totalW = w.schema_coverage + w.format_conformance + w.cross_branch_agreement
      + w.speed + w.critic + w.span_coverage + w.validator;
    const norm = totalW > 1 ? totalW : 1;
    const score = clamp01(
      (w.schema_coverage * schemaCoverage +
       w.format_conformance * formatConformance +
       w.cross_branch_agreement * crossBranchAgreementScore +
       w.speed * speed +
       w.critic * criticScore +
       w.span_coverage * spanCoverage +
       w.validator * validatorScore) / norm,
    );
    const passThreshold = cfg.passThreshold ?? 0.85;

    const report: KpiReport = {
      total_duration_ms: totalMs,
      stage_durations_ms: stageDurations,
      field_count: fieldCount,
      schema_coverage: schemaCoverage,
      format_conformance: formatConformance,
      cross_branch: crossBranch,
      score,
      verdict: score >= passThreshold ? 'pass' : 'fail',
      quality,
      components: {
        schema_coverage: schemaCoverage,
        format_conformance: formatConformance,
        cross_branch_agreement: crossBranchAgreementScore,
        speed,
        critic: criticScore,
        span_coverage: spanCoverage,
        validator: validatorScore,
      },
    };

    await ctx.artifacts.write('kpi_report.json', report);
    ctx.emit('kpi_report', report);
    return report;
  },
});
