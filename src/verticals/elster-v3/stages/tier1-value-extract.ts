/**
 * Tier-1 Value-Extractor — minimal, layout-agnostisch.
 *
 * Input: Output von polar-elster-coder (polar-schema-synth.ts):
 *   • sections[]               — { id, label, ocr_excerpt }
 *   • retrieval_trace[]        — { section_id, top_ecodes: [{ecode, score}, ...] }
 *   • ecode_descriptions       — eCode → { value, anlage, value_type }
 *   • ecode_scores             — eCode → max-Cosinus
 *
 * Logik (deterministisch, kein Layout-Detektor, keine Lookup-Maps):
 *   1. Pro eCode: finde die Section mit dem hoechsten Polar-Score fuer diesen eCode.
 *   2. Aus dem Section-Text: erster EUR-Wert via lib/eur-parse.firstEurInSection.
 *   3. Confidence = Polar-Score der Section→eCode-Bindung.
 *   4. Confidence < threshold (default 0.5) → in lowConfidence statt values.
 *   5. Section-Text leer fuer EUR → in missing.
 *
 * Tier-1 ist explizit ein FALSE-POSITIVE-MASCHINENRAUM: bei Mehrdeutigkeit
 * (z.B. Layout-B-Spaltenmatrix mit 2+ EUR-Werten pro Section) wird der
 * erste EUR genommen, was *nicht* immer der richtige eCode-Wert ist. Diese
 * Faelle landen mit niedrigerer Confidence in lowConfidence oder werden
 * downstream gegen die Ground-Truth ausgewiesen. Tier-3 ist fuer Ambiguity.
 */

import { defineStage } from '../../../core/stage.ts';
import { firstEurInSection, findEurValues, roundForElster, type ElsterRole } from '../lib/eur-parse.ts';

/**
 * Klassifiziert eCode als Einnahme / Ausgabe / Anrechnung heuristisch ueber
 * Anlage + drucktext-Keywords. Quelle der Wahrheit waere ELSTER-XSD —
 * solange wir die noch nicht parsen, ist das eine Best-Effort-Heuristik.
 */
function classifyElsterRole(anlage: string | undefined, drucktext: string | undefined): ElsterRole {
  const a = (anlage ?? '').toLowerCase();
  const d = (drucktext ?? '').toLowerCase();

  // 1. Anlage-Prio: VOR/SA/AgB/HA_35a sind STRUKTURELL Ausgaben.
  //    "Beiträge laut Nr. 25 LStB" in Anlage VOR ist eine ABZUGSFAEHIGE AUSGABE,
  //    nicht eine Anrechnung — der LStB-Verweis ist nur die Quelle, nicht die Rolle.
  if (a.startsWith('vor') || a.startsWith('sa') || a.startsWith('agb') || a.startsWith('ha_35a')) {
    // Erstattung als Sonderfall: "Erstattete Beitraege" als Standalone-Wert
    // ist Einnahme. Aber "Beitraege abzueglich Erstattet" bleibt Ausgabe.
    if ((d.startsWith('von der') || d.startsWith('erstattete')) && (d.includes('erstattet') || d.includes('erstattung'))) {
      return 'income';
    }
    return 'expense';
  }

  // 2. Anrechnungen: nur explizite Steuer-Anrechnungen.
  if (
    (d.includes('lohnsteuer') && !d.includes('beitrag')) ||
    d.includes('kapitalertragsteuer') ||
    d.includes('einbehaltene') ||
    d.includes('anrechenbar')
  ) {
    return 'tax-credit';
  }

  // 3. Einnahmen: Brutto-Lohn, Erträge, Renten-Bezüge.
  if (
    d.includes('bruttoarbeitslohn') ||
    d.includes('arbeitslohn') ||
    d.includes('kapitalertr') ||
    d.includes('zinsen') ||
    d.includes('dividend') ||
    d.includes('jahresbetrag der rente') ||
    d.includes('rentenbezug') ||
    d.includes('versorgungsbezug') ||
    d.includes('einnahme')
  ) {
    return 'income';
  }

  // 4. Fallback Ausgaben: Beitrag/Aufwendung/Werbungskosten ausserhalb anderer Anlagen.
  if (
    d.includes('beitrag') ||
    d.includes('aufwendung') ||
    d.includes('werbungskosten') ||
    d.includes('spende')
  ) {
    return 'expense';
  }

  // Default: keine klare Klassifikation → expense (konservativer Default).
  return 'expense';
}

interface AtomMetadata {
  anlage?: string;
  datentyp?: string;
  pflicht?: boolean;
  vordruckzeile?: string;
  drucktext?: string;
  formatRegex?: string;
  formatkennzeichen?: string;
  maxLaenge?: number;
  minLaenge?: number;
  kontextPaths?: string[];
}

interface PolarCodingResult {
  sections: { id: string; label: string; ocr_excerpt: string; ocr_full: string }[];
  retrieval_trace: { section_id: string; top_ecodes: { ecode: string; score: number }[] }[];
  ecode_descriptions: Record<string, { value: string; anlage: string; value_type: string; metadata?: AtomMetadata }>;
  ecode_scores: Record<string, number>;
}

// ─── Type-specific extractors (driven by atom.metadata.datentyp) ─────────

const DATUM_DE_RE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/;
const DATUM_MMYYYY_RE = /\b(\d{1,2})\.(\d{4})\b/;
const IDNR_RE = /\b\d{2}\s?\d{3}\s?\d{3}\s?\d{3}\b/;
const STEUERNR_RE = /\b\d{2,3}\/\d{3}\/\d{4,5}\b/;
const IBAN_RE = /\b[A-Z]{2}\d{2}\s?(?:\d{4}\s?){4,7}\d{0,4}\b/;

function extractValue(
  sectionText: string,
  datentyp: string | undefined,
  formatRegex: string | undefined,
  role: ElsterRole = 'expense',
): { value: unknown; rawDecimal?: number; role?: ElsterRole } | null {
  const dt = (datentyp ?? '').toLowerCase();

  if (dt === 'currency' || dt === 'geldbetrag' || dt.includes('betrag')) {
    const eur = firstEurInSection(sectionText);
    if (!eur) return null;
    const rounded = roundForElster(eur.value, role);
    return { value: rounded, rawDecimal: eur.value, role };
  }
  if (dt === 'date' || dt === 'datum' || dt === 'd') {
    const m = sectionText.match(DATUM_DE_RE) ?? sectionText.match(DATUM_MMYYYY_RE);
    return m ? { value: m[0] } : null;
  }
  if (dt === 'integer' || dt === 'zahl' || dt === 'i') {
    const m = sectionText.match(/\b-?\d{1,9}\b/);
    return m ? { value: parseInt(m[0], 10) } : null;
  }
  // String fallback — context-aware: pick the value AFTER "| " or ": "
  const tableMatch = sectionText.match(/\|\s*[^|]+\s*\|\s*([^|]+?)\s*\|/);
  if (tableMatch) return { value: tableMatch[1].trim() };
  const colonMatch = sectionText.match(/[A-Za-z][^:]+:\s*([^\n|]+)/);
  if (colonMatch) return { value: colonMatch[1].trim() };
  return null;
}

function isExtractable(datentyp: string | undefined): boolean {
  const dt = (datentyp ?? '').toLowerCase();
  return ['currency', 'geldbetrag', 'date', 'datum', 'd', 'integer', 'zahl', 'i', 'string', 'text', 't'].some((x) => dt.includes(x)) || dt === '';
}

export interface Tier1Input {
  polarCoding: PolarCodingResult;
  /** Mindest-Score damit ein eCode in values landet (statt lowConfidence). */
  confidenceThreshold?: number;
  /** Nur eCodes deren value_type ein Geldbetrag ist extrahieren. Default: all. */
  geldOnly?: boolean;
}

export interface Tier1Output {
  /** Final extrahierte (eCode → value)-Map. value type abhaengig von metadata.datentyp. */
  values: Record<string, unknown>;
  /** Pro extrahiertem Wert: aus welcher Section, mit welcher Confidence, welcher Datentyp. */
  provenance: Record<string, { section_id: string; score: number; datentyp: string; raw_match: string }>;
  /** eCodes die wir gerne extrahiert haetten, aber kein EUR in der Best-Section. */
  missing: { ecode: string; section_id: string; score: number; reason: string }[];
  /** eCodes mit Score unter Threshold — nicht extrahiert, fuer Tier-3-Eskalation. */
  lowConfidence: { ecode: string; score: number }[];
  stats: {
    extracted: number;
    missing: number;
    lowConfidence: number;
    wallClockMs: number;
  };
}

function isGeldTyp(value_type: string): boolean {
  const vt = value_type.toLowerCase();
  return (
    vt.includes('geld') ||
    vt.includes('betrag') ||
    vt.includes('euro') ||
    vt.includes('decimal') ||
    vt.includes('currency')
  );
}

export const tier1ValueExtractStage = defineStage<Tier1Input, Tier1Output>({
  id: 'elster-v3/tier1-value-extract',
  name: 'Tier-1 Value-Extractor (deterministisch, layout-agnostisch)',
  description:
    'Konsumiert polar-elster-coder Output, picked pro eCode die hoechst-scorende ' +
    'Section, extrahiert den ersten EUR-Wert. Kein Layout-Detektor, keine Maps. ' +
    'Tier-3-Eskalation bei Score-Threshold oder fehlendem EUR-Match.',

  async run(input, ctx) {
    const t0 = Date.now();
    const threshold = input.confidenceThreshold ?? 0.5;
    const geldOnly = input.geldOnly ?? false;
    const polar = input.polarCoding;

    // Build section-text lookup — FULL text for extraction.
    const sectionText = new Map<string, string>();
    for (const s of polar.sections) sectionText.set(s.id, s.ocr_full);

    // Pro eCode: finde die best Section (hoechster Polar-Score)
    const bestSectionForEcode = new Map<string, { section_id: string; score: number }>();
    for (const tr of polar.retrieval_trace) {
      for (const hit of tr.top_ecodes) {
        const prev = bestSectionForEcode.get(hit.ecode);
        if (!prev || hit.score > prev.score) {
          bestSectionForEcode.set(hit.ecode, { section_id: tr.section_id, score: hit.score });
        }
      }
    }

    ctx.emit('tier1.start', {
      eCodesTotal: bestSectionForEcode.size,
      sections: polar.sections.length,
      threshold,
    });

    const values: Tier1Output['values'] = {};
    const provenance: Tier1Output['provenance'] = {};
    const missing: Tier1Output['missing'] = [];
    const lowConfidence: Tier1Output['lowConfidence'] = [];

    for (const [ecode, best] of bestSectionForEcode) {
      const desc = polar.ecode_descriptions[ecode];
      if (geldOnly && desc && !isGeldTyp(desc.value_type)) continue;

      if (best.score < threshold) {
        lowConfidence.push({ ecode, score: best.score });
        continue;
      }

      const text = sectionText.get(best.section_id) ?? '';
      if (!text) {
        missing.push({ ecode, section_id: best.section_id, score: best.score, reason: 'empty section' });
        continue;
      }

      const metadata = desc?.metadata;
      const datentyp = metadata?.datentyp ?? '';
      const role = classifyElsterRole(metadata?.anlage ?? desc?.anlage, metadata?.drucktext ?? desc?.value);

      const extracted = extractValue(text, datentyp, metadata?.formatRegex, role);
      if (!extracted || extracted.value === null || extracted.value === undefined || extracted.value === '') {
        missing.push({
          ecode,
          section_id: best.section_id,
          score: best.score,
          reason: `no ${datentyp || 'value'} match in section`,
        });
        continue;
      }

      values[ecode] = extracted.value;
      const rawLabel = extracted.rawDecimal !== undefined
        ? `${extracted.value} ← ${extracted.rawDecimal} (${role})`
        : String(extracted.value);
      provenance[ecode] = {
        section_id: best.section_id,
        score: best.score,
        datentyp: datentyp || 'unknown',
        raw_match: rawLabel,
      };
    }

    const wallClockMs = Date.now() - t0;
    ctx.emit('tier1.done', {
      extracted: Object.keys(values).length,
      missing: missing.length,
      lowConfidence: lowConfidence.length,
      wallClockMs,
    });

    return {
      values,
      provenance,
      missing,
      lowConfidence,
      stats: {
        extracted: Object.keys(values).length,
        missing: missing.length,
        lowConfidence: lowConfidence.length,
        wallClockMs,
      },
    };
  },
});
