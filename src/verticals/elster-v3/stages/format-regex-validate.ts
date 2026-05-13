/**
 * elster-v3/format-regex-validate — deterministische Wert-Validierung pro Chunk.
 *
 * Für jeden (Chunk × Top-Kandidat) lauf:
 *   1. normalizeForElster(value, atom.datentyp) — z.B. "1.234,56 €" → "123456"
 *   2. checkFormat(normalized, atom.formatRegex + min/maxLaenge)
 *   3. Konsens-Score zusammensetzen aus:
 *      • cosine-Score   (Cascade-Top-1, range 0..1)
 *      • format-valid   (boolean → 0.0 oder 0.3 Bonus)
 *      • separation     (top1/top2 → bonus 0..0.2)
 *      • zeile-match    (vordruckzeile == chunk.zeile → bonus 0..0.15)
 *
 *   confidence = cosine + format_bonus + separation_bonus + zeile_bonus,
 *                clamped to [0, 1]
 *
 * Ein guter Treffer für "3. Bruttoarbeitslohn   69.291,80 €" gegen E0200201:
 *   cosine ≈ 0.85 (drucktext-match)
 *   format_valid = true (currency "6929180" passt /\d{1,12}/) → +0.10
 *   separation > 1.4 (klarer Sieger) → +0.05
 *   vordruckzeile = "3" == chunk.zeile "3." → +0.10
 *   → confidence ≈ 1.0
 *
 * Schlechter Treffer (Label "Identifikationsnummer" — 30+ Atome im Container):
 *   cosine ≈ 0.42, separation ≈ 1.05 (Tie), format passt → confidence ≈ 0.5
 *   → Confidence-Gate routet zu Disambig.
 *
 * Output: Per-Chunk eine `winner`-Entscheidung mit der besten (eCode, value,
 * confidence)-Tupel plus Begründungs-Trace.
 */
import { defineStage } from '../../../core/stage.ts';
import { checkFormat, normalizeForElster, type CatalogAtom } from '../../../lib/elster-catalog.ts';

import type {
  AnnotatedBeleg,
  AnnotatedChunk,
  AtomCandidate,
} from './atoms-cascade-search.ts';

/**
 * Ein Cascade-Kandidat angereichert mit ELSTER-Format-Validation pro
 * (Wert × Atom)-Paar. Wird vom llm-disambig konsumiert: der LLM picked
 * mit Format-Awareness, statt nur semantischer Ähnlichkeit.
 */
export interface EnrichedAtomCandidate extends AtomCandidate {
  /** Hat der Wert das atom.metadata.formatRegex bestanden (nach Normalisierung)? */
  format_valid: boolean;
  /** Wert in ELSTER-Submission-Form ("69.291,80 €" → "6929180"). null wenn format_valid=false. */
  normalized_value: string | null;
  /** Bei !format_valid: warum (Regex-fail, length-fail, parse-fail). */
  format_reason?: string;
}

/** Beleg mit format-annotierten Kandidaten — das was llm-disambig konsumiert. */
export interface EnrichedAnnotatedBeleg extends Omit<AnnotatedBeleg, 'chunks'> {
  chunks: Array<Omit<AnnotatedChunk, 'candidates'> & { candidates: EnrichedAtomCandidate[] }>;
}

// ─── Per-Chunk Resultat ────────────────────────────────────────────────────

export interface ChunkVerdict {
  belegIdx: number;
  chunkIdx: number;
  /** Zeile im Beleg (1-based). */
  lineIndex: number;
  label: string;
  rawValue: string;
  zeile?: string;
  /** Gewählter eCode (oder null wenn kein Kandidat brauchbar). */
  winner?: {
    ecode: string;
    drucktext: string;
    anlage: string;
    datentyp: string;
    pflicht: boolean;
    vordruckzeile: string;
    /** Cascade-Cosine (range 0..1). */
    cosine: number;
    /** Normalisierter Wert (z.B. "6929180" für "69.291,80 €"). */
    normalized: string;
    /** Validation OK gegen formatRegex + min/maxLaenge? */
    format_valid: boolean;
    /** Konsens-Confidence über alle Signale (0..1). */
    confidence: number;
    /** Trace pro Komponente — Audit. */
    components: {
      cosine: number;
      format_bonus: number;
      separation_bonus: number;
      zeile_bonus: number;
    };
    /** format-validation-Fehler (falls invalid). */
    format_reason?: string;
  };
  /** Wenn winner=null: warum kein Treffer? */
  reject_reason?: string;
}

// ─── Bonus-Hilfsfunktionen ─────────────────────────────────────────────────

const FORMAT_BONUS = 0.10;       // erfolgreiche Format-Validation
const SEPARATION_BONUS_MAX = 0.10; // separation 1.0 → 0.0, ≥1.5 → max
const ZEILE_BONUS = 0.10;        // vordruckzeile == chunk.zeile exakt

function separationBonus(sep?: number): number {
  if (!sep || !Number.isFinite(sep) || sep <= 1.0) return 0;
  // Linear ramp 1.0 → 1.5, danach geclampt.
  return Math.min(SEPARATION_BONUS_MAX, ((sep - 1.0) / 0.5) * SEPARATION_BONUS_MAX);
}

function normalizeZeile(z?: string): string | null {
  if (!z) return null;
  // " 3.", "22. b)", " a)" → "3", "22b", "a"
  const m = z.match(/^(\d+)\.\s*(?:([a-z])\))?$/i);
  if (!m) return null;
  return m[2] ? `${m[1]}${m[2].toLowerCase()}` : m[1];
}

function zeileMatchBonus(chunkZeile: string | undefined, atomZeile: string): number {
  const c = normalizeZeile(chunkZeile);
  if (!c) return 0;
  // Atom-Zeile kann "3", "3a", "22 b" etc. sein — normalisieren.
  const a = atomZeile.replace(/\s+/g, '').toLowerCase();
  if (c === a) return ZEILE_BONUS;
  // Partial: Chunk "3" und Atom "3" oder "3a" — wenn die Hauptzahl stimmt
  const cNum = c.match(/^(\d+)/)?.[1];
  const aNum = a.match(/^(\d+)/)?.[1];
  if (cNum && aNum && cNum === aNum) return ZEILE_BONUS * 0.5;
  return 0;
}

// ─── Per-Chunk Bewertung ───────────────────────────────────────────────────

function evaluateChunk(
  chunk: AnnotatedChunk,
  belegIdx: number,
  chunkIdx: number,
): ChunkVerdict {
  const base: ChunkVerdict = {
    belegIdx,
    chunkIdx,
    lineIndex: chunk.lineIndex,
    label: chunk.label,
    rawValue: chunk.value,
    zeile: chunk.zeile,
  };
  if (!chunk.candidates || chunk.candidates.length === 0) {
    return { ...base, reject_reason: 'no-candidates' };
  }

  // Über ALLE Top-K Kandidaten bewerten — der mit höchster confidence gewinnt.
  let best: ChunkVerdict['winner'] | undefined;
  let bestScore = -Infinity;

  for (const cand of chunk.candidates) {
    // Pseudo-Atom für checkFormat — wir haben die nötigen Felder hier.
    const pseudoAtom: CatalogAtom = {
      atom_id: '', container_id: '', layer_id: '', field_path: '',
      field_name: cand.ecode,
      value: cand.drucktext,
      value_type: cand.datentyp, lang: 'de',
      citation_document: '', citation_section: '', citation_excerpt: '',
      citation_confidence: 1, citation_method: '',
      trust_level: 'verified', source_type: 'primary-source',
      contributor_id: '', commit_hash: '',
      metadata: {
        anlage: cand.anlage,
        datentyp: cand.datentyp as 'string' | 'date' | 'currency',
        pflicht: cand.pflicht,
        vordruckzeile: cand.vordruckzeile,
        drucktext: cand.drucktext,
        formatRegex: cand.formatRegex,
      },
    };
    const fc = checkFormat(chunk.value, pseudoAtom);
    const cosine = Math.max(0, Math.min(1, cand.score));
    const format_bonus = fc.ok ? FORMAT_BONUS : 0;
    const separation_bonus = separationBonus(chunk.separation);
    const zeile_bonus = zeileMatchBonus(chunk.zeile, cand.vordruckzeile);
    const confidence = Math.min(1, cosine + format_bonus + separation_bonus + zeile_bonus);

    if (confidence > bestScore) {
      bestScore = confidence;
      best = {
        ecode: cand.ecode,
        drucktext: cand.drucktext,
        anlage: cand.anlage,
        datentyp: cand.datentyp,
        pflicht: cand.pflicht,
        vordruckzeile: cand.vordruckzeile,
        cosine,
        normalized: fc.normalized ?? '',
        format_valid: fc.ok,
        confidence: Number(confidence.toFixed(4)),
        components: {
          cosine: Number(cosine.toFixed(4)),
          format_bonus,
          separation_bonus: Number(separation_bonus.toFixed(4)),
          zeile_bonus: Number(zeile_bonus.toFixed(4)),
        },
        format_reason: fc.ok ? undefined : fc.reason,
      };
    }
  }

  return { ...base, winner: best };
}

// ─── Stage ─────────────────────────────────────────────────────────────────

export interface FormatRegexValidateInput {
  belege: AnnotatedBeleg[];
}

export interface FormatRegexValidateConfig {
  /**
   * Minimaler `winner.cosine` damit ein Verdict überhaupt rausgegeben wird.
   * Default 0.20 (sehr permissiv — Disambig-Gate filtert später strenger).
   */
  minCosine?: number;
}

export interface FormatRegexValidateOutput {
  /**
   * NEU (Variante B): belege mit format-annotierten Kandidaten. Primärer
   * Konsument: llm-disambig. Jeder Kandidat eines jeden Chunks bekommt
   * `format_valid`, `normalized_value`, `format_reason` dranannotiert.
   */
  enrichedBelege: EnrichedAnnotatedBeleg[];
  /**
   * Legacy/diagnostic: pro-Chunk-Verdict mit dem cascade-Top-1 + Bonus-Score.
   * Wird nicht mehr fürs Routing genutzt, aber bleibt für Debug/UI sichtbar.
   */
  verdicts: ChunkVerdict[];
  stats: {
    chunksTotal: number;
    candidatesTotal: number;
    candidatesFormatValid: number;
    winnersFound: number;
    formatValid: number;
    formatInvalid: number;
    avgConfidence: number;
    histogramByConfidence: { high: number; mid: number; low: number };
    ms: number;
  };
}

export const formatRegexValidateStage = defineStage<
  FormatRegexValidateInput,
  FormatRegexValidateOutput,
  FormatRegexValidateConfig
>({
  id: 'elster-v3/format-regex-validate',
  name: 'Format-Regex-Validate + Konsens-Score',
  description:
    'Pro Chunk: bewertet alle Cascade-Kandidaten gleichzeitig. Confidence = cosine + ' +
    'format_bonus (ELSTER-formatRegex ok) + separation_bonus (top1/top2-Sieger) + ' +
    'zeile_bonus (vordruckzeile-Match). Wählt den besten Kandidat als winner. ' +
    'Deterministisch, kein LLM, ~5ms pro 50 Chunks.',
  hints: {
    inputs: 'belege[] mit annotierten chunks (von atoms-cascade-search)',
    outputs: 'verdicts[{belegIdx, chunkIdx, winner?{ecode, confidence, components}}], stats',
    configExample: '{"minCosine": 0.20}',
    inputPorts: [{ name: 'belege', type: 'belege', description: 'Annotierte Belege' }],
    outputPorts: [
      { name: 'verdicts', type: 'verdicts', description: 'Per-Chunk Verdict' },
      { name: 'stats', type: 'json' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const minCosine = ctx.config?.minCosine ?? 0.20;
    const verdicts: ChunkVerdict[] = [];
    const enrichedBelege: EnrichedAnnotatedBeleg[] = [];
    let candidatesTotal = 0;
    let candidatesFormatValid = 0;

    for (let bi = 0; bi < input.belege.length; bi++) {
      const b = input.belege[bi];
      // Build enriched-belege: annotate EACH candidate with format-validity
      const enrichedChunks = b.chunks.map((chunk) => {
        const enrichedCands: EnrichedAtomCandidate[] = (chunk.candidates ?? []).map((c) => {
          candidatesTotal++;
          // Re-use checkFormat from elster-catalog via a pseudo-atom.
          const pseudoAtom: CatalogAtom = {
            atom_id: '', container_id: '', layer_id: '', field_path: '',
            field_name: c.ecode, value: c.drucktext,
            value_type: c.datentyp, lang: 'de',
            citation_document: '', citation_section: '', citation_excerpt: '',
            citation_confidence: 1, citation_method: '',
            trust_level: 'verified', source_type: 'primary-source',
            contributor_id: '', commit_hash: '',
            metadata: {
              anlage: c.anlage,
              datentyp: c.datentyp as 'string' | 'date' | 'currency',
              pflicht: c.pflicht,
              vordruckzeile: c.vordruckzeile,
              drucktext: c.drucktext,
              formatRegex: c.formatRegex,
            },
          };
          const fc = checkFormat(chunk.value, pseudoAtom);
          if (fc.ok) candidatesFormatValid++;
          return {
            ...c,
            format_valid: fc.ok,
            normalized_value: fc.ok ? (fc.normalized ?? null) : null,
            format_reason: fc.ok ? undefined : fc.reason,
          };
        });
        return { ...chunk, candidates: enrichedCands };
      });
      enrichedBelege.push({ ...b, chunks: enrichedChunks });

      // Build legacy verdicts (cascade-top-1 + bonus-score) for diagnostic
      for (let ci = 0; ci < b.chunks.length; ci++) {
        const v = evaluateChunk(b.chunks[ci], bi, ci);
        if (v.winner && v.winner.cosine < minCosine) {
          delete v.winner;
          v.reject_reason = `cosine top1 < ${minCosine}`;
        }
        verdicts.push(v);
      }
    }

    let formatValid = 0, formatInvalid = 0, confSum = 0;
    const histogramByConfidence = { high: 0, mid: 0, low: 0 };
    let winners = 0;
    for (const v of verdicts) {
      if (!v.winner) { histogramByConfidence.low++; continue; }
      winners++;
      confSum += v.winner.confidence;
      if (v.winner.format_valid) formatValid++; else formatInvalid++;
      if (v.winner.confidence >= 0.80) histogramByConfidence.high++;
      else if (v.winner.confidence >= 0.40) histogramByConfidence.mid++;
      else histogramByConfidence.low++;
    }

    const stats = {
      chunksTotal: verdicts.length,
      candidatesTotal,
      candidatesFormatValid,
      winnersFound: winners,
      formatValid,
      formatInvalid,
      avgConfidence: winners > 0 ? Number((confSum / winners).toFixed(4)) : 0,
      histogramByConfidence,
      ms: Date.now() - t0,
    };
    ctx.emit('format_validate_done', stats);
    return { enrichedBelege, verdicts, stats };
  },
});
