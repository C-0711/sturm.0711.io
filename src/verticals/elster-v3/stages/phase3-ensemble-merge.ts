/**
 * elster-v5_2-rag-ensemble/phase3-ensemble-merge — Voting Stage über N parallele
 * phase3-llm-fill-Outputs. Pro (anlage, eCode) wird der häufigste Wert (string-
 * gleichheit nach trim+lowercase) ausgewählt:
 *
 *   ≥ minAgreement Modelle stimmen → ENSEMBLE_OK,  origin auf `LLM_FSM` belassen
 *   Genau N/2 vs N/2 Split           → ENSEMBLE_TIE (Wert vom ersten Model)
 *   Sonst                            → ENSEMBLE_DISAGREE (Wert vom ersten Model)
 *
 * Output ist im Shape von `Phase3LlmFillOutput` — drop-in-Ersatz für den
 * Downstream phase4Disambig / phase5Merge. Die Origin-Flags werden via
 * `consensus_origin` auf jedem Hit angereichert (phase5Merge ignoriert das,
 * canonical_layer behält die Audit-Spur in `_ensemble_audit`).
 */
import { defineStage } from '../../../core/stage.ts';
import type {
  Phase3AnlageResult,
  Phase3LlmFillOutput,
  Phase3LlmHit,
} from './phase3-llm-fill.ts';

export interface Phase3EnsembleMergeInput {
  /** Einzelne Branches als top-level Inputs (Workflow-DAG-Limit:
   *  StageDef.inputs ist Record<string, string>, kein Nested-Object).
   *  Fehlende Branches werden im Voting einfach übersprungen. */
  vllm?: Phase3LlmFillOutput;
  mistral_small?: Phase3LlmFillOutput;
  mistral_large?: Phase3LlmFillOutput;
  claude_haiku?: Phase3LlmFillOutput;
  /** Optional weitere benannte Branches. */
  [extraBranch: string]: Phase3LlmFillOutput | undefined;
}

export interface Phase3EnsembleMergeConfig {
  /** Minimale Übereinstimmung für ENSEMBLE_OK. Default 3 (von 4). */
  minAgreement?: number;
}

export type ConsensusOrigin = 'ENSEMBLE_OK' | 'ENSEMBLE_TIE' | 'ENSEMBLE_DISAGREE';

export interface EnsembleAuditEntry {
  eCode: string;
  anlage: string;
  consensus: ConsensusOrigin;
  agreement: number;
  totalBranches: number;
  candidates: Array<{ value: string; models: string[] }>;
}

export interface Phase3EnsembleMergeOutput extends Phase3LlmFillOutput {
  _ensemble_audit: EnsembleAuditEntry[];
  _ensemble_stats: {
    branches: string[];
    ok: number;
    tie: number;
    disagree: number;
    totalConsensusKeys: number;
  };
}

function normalize(s: string): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export const phase3EnsembleMergeStage = defineStage<
  Phase3EnsembleMergeInput,
  Phase3EnsembleMergeOutput,
  Phase3EnsembleMergeConfig
>({
  id: 'elster-v5_2-rag-ensemble/phase3-ensemble-merge',
  name: 'Phase 3 Ensemble — N-Branch Consensus Merge',
  description:
    'Sammelt N parallele phase3-llm-fill-Outputs (vLLM Gemma + Mistral-S + ' +
    'Mistral-L + Claude Haiku) und stimmt pro (anlage, eCode) ab. ≥minAgreement → ' +
    'ENSEMBLE_OK; Split → ENSEMBLE_TIE; alle anders → ENSEMBLE_DISAGREE. ' +
    'Output ist drop-in-kompatibel mit Phase3LlmFillOutput.',
  hints: {
    inputs: 'branches (Record<modelName, Phase3LlmFillOutput>)',
    outputs: 'per_anlage map (drop-in for phase4/phase5) + _ensemble_audit',
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? {};
    const minAgreement = cfg.minAgreement ?? 3;
    // Branches aus top-level Input-Keys ableiten, alle definierten und mit
    // `per_anlage` versehenen Branches behalten.
    const branches: Record<string, Phase3LlmFillOutput> = {};
    for (const [k, v] of Object.entries(input ?? {})) {
      if (v && typeof v === 'object' && (v as Phase3LlmFillOutput).per_anlage) {
        branches[k] = v as Phase3LlmFillOutput;
      }
    }
    const branchNames = Object.keys(branches);

    if (branchNames.length === 0) {
      throw new Error('phase3-ensemble-merge: input.branches must have ≥1 entry');
    }

    ctx.emit('ensemble_start', { branches: branchNames, minAgreement });

    // ── 1. Union aller Anlagen über alle Branches ──────────────────────
    const anlageSet = new Set<string>();
    for (const branch of Object.values(branches)) {
      for (const a of Object.keys(branch.per_anlage ?? {})) anlageSet.add(a);
    }

    // ── 2. Pro Anlage: Union aller eCodes, dann Vote ───────────────────
    const merged: Record<string, Phase3AnlageResult> = {};
    const audit: EnsembleAuditEntry[] = [];
    let okCount = 0, tieCount = 0, disagreeCount = 0;
    let totalFilled = 0;

    for (const anlage of anlageSet) {
      // Alle Hits aller Branches für diese Anlage sammeln
      const eCodeMap = new Map<string, Map<string, { value: string; hit: Phase3LlmHit; models: string[] }>>();
      let prefilledRef = 0;
      let missingAtStartRef = 0;
      const stillMissingUnion = new Set<string>();

      for (const [model, branch] of Object.entries(branches)) {
        const anlageRes = branch.per_anlage?.[anlage];
        if (!anlageRes) continue;
        prefilledRef = Math.max(prefilledRef, anlageRes.prefilled_count ?? 0);
        missingAtStartRef = Math.max(missingAtStartRef, anlageRes.missing_at_start ?? 0);
        for (const eCode of anlageRes.still_missing ?? []) stillMissingUnion.add(eCode);
        for (const [eCode, hit] of Object.entries(anlageRes.llm_hits ?? {})) {
          if (!eCodeMap.has(eCode)) eCodeMap.set(eCode, new Map());
          const valueMap = eCodeMap.get(eCode)!;
          const key = normalize(hit.value);
          const existing = valueMap.get(key);
          if (existing) existing.models.push(model);
          else valueMap.set(key, { value: hit.value, hit, models: [model] });
        }
      }

      // Pro eCode voten
      const winningHits: Record<string, Phase3LlmHit> = {};
      const stillMissing: string[] = Array.from(stillMissingUnion);

      for (const [eCode, valueMap] of eCodeMap) {
        const candidates = Array.from(valueMap.values())
          .map((v) => ({ value: v.value, models: v.models, hit: v.hit }))
          .sort((a, b) => b.models.length - a.models.length);
        const top = candidates[0];
        const second = candidates[1]?.models.length ?? 0;
        const agreement = top.models.length;
        let consensus: ConsensusOrigin;
        if (agreement >= minAgreement) { consensus = 'ENSEMBLE_OK'; okCount++; }
        else if (agreement === second && agreement >= 2) { consensus = 'ENSEMBLE_TIE'; tieCount++; }
        else { consensus = 'ENSEMBLE_DISAGREE'; disagreeCount++; }

        winningHits[eCode] = top.hit;
        audit.push({
          eCode, anlage,
          consensus, agreement,
          totalBranches: branchNames.length,
          candidates: candidates.map((c) => ({ value: c.value, models: c.models })),
        });
        totalFilled++;
        // Wenn eCode in winningHits ist, raus aus stillMissing
        const idx = stillMissing.indexOf(eCode);
        if (idx >= 0) stillMissing.splice(idx, 1);
      }

      merged[anlage] = {
        anlage,
        llm_hits: winningHits,
        still_missing: stillMissing,
        prefilled_count: prefilledRef,
        missing_at_start: missingAtStartRef,
        durationMs: 0,
      };
    }

    const stats = {
      branches: branchNames,
      ok: okCount,
      tie: tieCount,
      disagree: disagreeCount,
      totalConsensusKeys: audit.length,
    };
    await ctx.artifacts.write('ensemble_audit.json', { audit, stats });
    ctx.emit('ensemble_done', stats);

    return {
      per_anlage: merged,
      totalFilled,
      ms: Date.now() - t0,
      _ensemble_audit: audit,
      _ensemble_stats: stats,
    };
  },
});
