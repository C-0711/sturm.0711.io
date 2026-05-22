/**
 * PolarQuant End-to-End Pipeline (orchestrator over Tier-1 + Tier-2).
 *
 * Modes:
 *   - 'tier1-only':         deterministic Polar embedding + extract, no LLM
 *   - 'tier2-only':         kontextPath-filter pool → Gemma-pick → extract
 *   - 'tier1+tier2-fallback': Tier-1 confident? use it. Else Tier-2 disambiguate.
 *
 * Default for typed belege (with preferredKontextPaths): 'tier2-only'
 * Default for unknown belege:                            'tier1+tier2-fallback'
 */
import { readFile } from 'node:fs/promises';
import { ExactFp32Index } from '../../../lib/quantum-index.ts';
import {
  splitSections,
  loadContainerAtoms,
  extractBelegContext,
  polarMatchSection,
  tier1Extract,
  type AtomMeta,
  type BelegContext,
  type Section,
  type Tier1Result,
} from './polarquant-tier1.ts';
import { gemmaDisambiguate, type Tier2Audit } from './polarquant-tier2.ts';

export type PipelineMode = 'tier1-only' | 'tier2-only' | 'tier1+tier2-fallback' | 'auto';

export interface PipelineConfig {
  mode: PipelineMode;
  /** Margin gate for fallback mode: if Tier-1 margin < threshold → invoke Tier-2 */
  marginGate?: number;
  /** Top-K for polar embedding (only used by Tier-1) */
  topK?: number;
  /** Container atoms file */
  atomsPath: string;
  /** FP32 embedding index (needed for Tier-1 and fallback) */
  embeddingsPath?: string;
  /** Embedding dim */
  embeddingDim?: number;
  /** Optional Mandant-Profil-Summary, injected into Tier-2 prompt as Mandant-context */
  profileSummary?: string;
}

export interface SectionResult {
  section_idx: number;
  section_heading: string;
  section_beitragsart: string | null;
  section_offset: [number, number];

  mode_used: PipelineMode;
  pool_size: number;

  picked_ecode: string | null;
  picked_atom_id: string | null;
  wert_raw: string | null;
  wert_numeric: number | null;
  wert_elster_xml: string | null;
  vordruckzeile: string | null;
  anlage: string | null;
  kontextPaths: string[];

  tier1?: {
    polar_score: number;
    polar_margin: number;
    strategy: string;
    confidence: number;
    ms: number;
  };
  tier2?: {
    reasoning: string;
    prompt_sha256: string;
    tokens_in: number;
    tokens_out: number;
    ms: number;
  };

  status: 'hit' | 'no-match-by-rule' | 'no-extract' | 'tier1-only-uncertain';
}

export interface PipelineResult {
  total_ms: number;
  mode: PipelineMode;
  beleg_context: BelegContext;
  sections: SectionResult[];
  summary: {
    sections_total: number;
    sections_with_beitragsart: number;
    hits: number;
    no_match_by_rule: number;
    tier2_invocations: number;
  };
}

export async function runPipeline(md: string, config: PipelineConfig): Promise<PipelineResult> {
  const t0 = Date.now();
  const { atomsByEcode, atomsByIdx } = await loadContainerAtoms(config.atomsPath);
  const belegCtx = extractBelegContext(md);
  if (config.profileSummary) belegCtx.profileSummary = config.profileSummary;
  const sections = splitSections(md);

  // Effective mode
  let mode = config.mode;
  if (mode === 'auto') {
    mode = (belegCtx.preferredKontextPaths && belegCtx.preferredKontextPaths.length > 0)
      ? 'tier2-only'
      : 'tier1+tier2-fallback';
  }

  const needsIndex = mode === 'tier1-only' || mode === 'tier1+tier2-fallback';
  const index = (needsIndex && config.embeddingsPath)
    ? await ExactFp32Index.load(config.embeddingsPath, config.embeddingDim ?? 768)
    : null;

  // Pre-build filtered pool for tier2-only
  const allowed = new Set(belegCtx.allowedAnlagen);
  const preferred = new Set(belegCtx.preferredKontextPaths || []);
  const tier2Pool = atomsByIdx.filter(a => {
    if (!allowed.has(a.anlage)) return false;
    if (preferred.size === 0) return true;
    return (a.kontextPaths || []).some(p => preferred.has(p));
  });

  const marginGate = config.marginGate ?? 0.02;
  const topK = config.topK ?? 10;
  const out: SectionResult[] = [];
  let tier2Invocations = 0;

  for (const [i, s] of sections.entries()) {
    const ba = s.body.match(/Beitragsart\s*\|\s*([^|\n]+)/);
    const baText = ba ? ba[1].trim() : null;
    const baseRes: Partial<SectionResult> = {
      section_idx: i,
      section_heading: s.heading,
      section_beitragsart: baText,
      section_offset: [s.offset_start, s.offset_end],
      mode_used: mode,
    };
    if (!baText) {
      out.push({ ...baseRes, pool_size: 0, picked_ecode: null, picked_atom_id: null, wert_raw: null, wert_numeric: null, wert_elster_xml: null, vordruckzeile: null, anlage: null, kontextPaths: [], status: 'no-extract' } as SectionResult);
      continue;
    }

    let pickedEcode: string | null = null;
    let pickedAtom: AtomMeta | null = null;
    let extract: Tier1Result | null = null;
    let poolSize = 0;
    let tier1Audit: SectionResult['tier1'];
    let tier2Audit: SectionResult['tier2'];
    let usedMode: PipelineMode = mode;

    if (mode === 'tier2-only') {
      poolSize = tier2Pool.length;
      const candidates = tier2Pool.map(a => ({ atom: a, score: 1.0 }));
      const t2 = await gemmaDisambiguate(s, candidates, belegCtx);
      tier2Invocations++;
      tier2Audit = { reasoning: t2.reasoning, prompt_sha256: t2.audit.prompt_sha256, tokens_in: t2.audit.tokens_in, tokens_out: t2.audit.tokens_out, ms: t2.audit.ms };
      if (t2.picked_ecode) {
        pickedAtom = tier2Pool.find(a => a.ecode === t2.picked_ecode) || null;
        pickedEcode = t2.picked_ecode;
      }
    } else if (mode === 'tier1-only') {
      if (!index) throw new Error('tier1-only requires embeddings');
      const { candidates, margin } = await polarMatchSection(s, index, atomsByIdx, belegCtx, topK);
      poolSize = candidates.length;
      const top1 = candidates[0];
      tier1Audit = { polar_score: top1?.score ?? 0, polar_margin: margin, strategy: 'tier1', confidence: top1?.score ?? 0, ms: 0 };
      if (top1 && margin >= marginGate) {
        pickedAtom = top1.atom;
        pickedEcode = top1.atom.ecode;
      }
    } else {
      // tier1+tier2-fallback
      if (!index) throw new Error('fallback mode requires embeddings');
      const { candidates, margin } = await polarMatchSection(s, index, atomsByIdx, belegCtx, topK);
      poolSize = candidates.length;
      const top1 = candidates[0];
      tier1Audit = { polar_score: top1?.score ?? 0, polar_margin: margin, strategy: 'tier1-confident', confidence: top1?.score ?? 0, ms: 0 };
      if (top1 && margin >= marginGate && top1.score >= 0.5) {
        pickedAtom = top1.atom;
        pickedEcode = top1.atom.ecode;
      } else {
        // Disambiguate via Tier-2 with the candidates from Polar
        const t2 = await gemmaDisambiguate(s, candidates, belegCtx);
        tier2Invocations++;
        usedMode = 'tier1+tier2-fallback';
        tier2Audit = { reasoning: t2.reasoning, prompt_sha256: t2.audit.prompt_sha256, tokens_in: t2.audit.tokens_in, tokens_out: t2.audit.tokens_out, ms: t2.audit.ms };
        if (t2.picked_ecode) {
          pickedAtom = candidates.find(c => c.atom.ecode === t2.picked_ecode)?.atom || null;
          pickedEcode = t2.picked_ecode;
        }
      }
    }

    let status: SectionResult['status'] = 'no-match-by-rule';
    if (pickedAtom) {
      extract = tier1Extract(s, pickedAtom, 1.0, 1.0);
      if (extract.wert) status = 'hit';
      else status = 'no-extract';
    }

    out.push({
      section_idx: i,
      section_heading: s.heading,
      section_beitragsart: baText,
      section_offset: [s.offset_start, s.offset_end],
      mode_used: usedMode,
      pool_size: poolSize,
      picked_ecode: pickedEcode,
      picked_atom_id: pickedAtom?.atom_id ?? null,
      wert_raw: extract?.wert ?? null,
      wert_numeric: extract?.wert_numeric ?? null,
      wert_elster_xml: extract?.wert_elster_xml ?? null,
      vordruckzeile: pickedAtom?.vordruckzeile ?? null,
      anlage: pickedAtom?.anlage ?? null,
      kontextPaths: pickedAtom?.kontextPaths ?? [],
      tier1: tier1Audit,
      tier2: tier2Audit,
      status,
    });
  }

  const totalMs = Date.now() - t0;
  return {
    total_ms: totalMs,
    mode,
    beleg_context: belegCtx,
    sections: out,
    summary: {
      sections_total: out.length,
      sections_with_beitragsart: out.filter(s => s.section_beitragsart).length,
      hits: out.filter(s => s.status === 'hit').length,
      no_match_by_rule: out.filter(s => s.status === 'no-match-by-rule').length,
      tier2_invocations: tier2Invocations,
    },
  };
}
