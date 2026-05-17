/**
 * elster-v5/phase5-merge — Canonical Merge + ERiC-XML-Output.
 *
 * Vereinigt:
 *   • Phase 1 regex_hits  (origin=REGEX_100%, höchste Priorität)
 *   • Phase 3 llm_hits    (origin=LLM_FSM, Priority 2)
 *
 * Pro eCode: regex-hit überschreibt llm-hit (deterministisch > stochastisch).
 *
 * Output:
 *   • canonical_layer: flacher eCode → CanonicalValue mit Provenance
 *   • xml_payload: ERiC-kompatibler XML-String, bereit für den C++-Client
 *   • stats: counts + Phase-Verteilung
 *
 * Eric-XML-Format (vereinfacht, basiert auf der BMF-Konvention):
 *   <Erklaerung art="ESt">
 *     <E0200201 anlage="N" zeile="5" kontext="ArbL/LStB_1_5_Sum"
 *               datentyp="currency" origin="REGEX_100%">63.559,90</E0200201>
 *     ...
 *   </Erklaerung>
 */
import { defineStage } from '../../../core/stage.ts';
import {
  normalizeForElster,
  type ElsterDatentyp,
} from '../../../lib/elster-catalog.ts';
import { parseGermanMoney } from '../../../lib/normalize-number.ts';
import type { Phase1AnlageResult, Phase1RegexHit } from './phase1-regex.ts';
import type { Phase3AnlageResult, Phase3LlmHit } from './phase3-llm-fill.ts';

export interface CanonicalValue {
  eCode: string;
  value: string;
  /** Wire-Format (Currency = Integer-Cents, Date = DD.MM.YYYY, ...). */
  normalized: string | null;
  /**
   * Numerischer Wert für arithmetische Konsumenten (BMF-Rechner,
   * Ground-Truth-Vergleich, Cross-Validator-Summen). Nur gesetzt für
   * numerische Datentypen (currency, integer, amount, percent). `value`
   * und `normalized` bleiben unangetastet — `normalizedNumber` ist additiv.
   *
   *   "1.781,98 EUR" → 1781.98
   *   "6.011"        → 6011
   *   "Nicht zutr."  → undefined
   */
  normalizedNumber?: number;
  origin: 'REGEX_100%' | 'REGEX_3F' | 'LLM_FSM' | 'BMF_RECHNER';
  anlage: string;
  drucktext: string;
  vordruckzeile: string;
  datentyp: ElsterDatentyp;
  /** §EStG-/BMF-kontextPath (Einkunftsart-Prefix). */
  kontextPath: string | null;
  /** Bei origin=REGEX_100%: die OCR-Zeile aus der's stammt. */
  evidence_line?: string;
  /** origin=BMF_RECHNER: ID des Lane-1-Rechners (z.B. `tarif_32a`). */
  rechner_id?: string;
  /** origin=BMF_RECHNER: Verwendete Formel mit eingesetzten Werten (Audit). */
  formula_string?: string;
  /** origin=BMF_RECHNER: §EStG-Zitat aus dem Rechner. */
  paragraph_estg?: string;
  /** origin=BMF_RECHNER: Map slot_name → eCode der genutzten Inputs. */
  inputs_used?: Record<string, string>;
  /** UI-Hint: wie verlässlich ist der Wert?
   *   • high       — REGEX_100% mit Belegzeile, oder BMF deterministisch
   *   • medium     — REGEX_3F oder LLM_FSM mit Drucktext-Bezug
   *   • low        — LLM_FSM ohne klaren Anker (z.B. generisches "Betrag")
   *   • suspicious — Wert wirkt nach Halluzination (Wert = Vordruckzeile,
   *                  oder Wert tritt in ≥3 eCodes mit generischem Drucktext auf)
   *  Wird im UI für Priorisierung der manuellen Prüfung benutzt. */
  trust: 'high' | 'medium' | 'low' | 'suspicious';
  /** Maschinen-lesbare Gründe für den Trust-Level (UI kann Hover/Badge zeigen). */
  trust_reasons: string[];
  /** Übernommen von phase1: leading Label-Token == vordruckzeile. Undefined =
   *  Anchor nicht prüfbar (vordruckzeile fehlt). False = REGEX_3F-Fallback,
   *  triggert trust='suspicious'. */
  zeile_anchored?: boolean;
  /** Übernommen von phase1: (value, drucktext) tritt in ≥3 eCodes über ≥2
   *  Anlagen auf → WISO-Platzhalter-Verdacht, triggert trust='suspicious'. */
  repeat_suspicious?: boolean;
}

export interface Phase5MergeInput {
  phase1_per_anlage: Record<string, Phase1AnlageResult>;
  phase3_per_anlage: Record<string, Phase3AnlageResult>;
}

export interface Phase5MergeOutput {
  /** Map eCode → CanonicalValue, gemerged + sortiert. */
  canonical_layer: Record<string, CanonicalValue>;
  /** ERiC-XML-String bereit für den C++-Client. */
  xml_payload: string;
  stats: {
    total: number;
    from_regex: number;
    from_llm: number;
    by_anlage: Record<string, number>;
    by_datentyp: Record<string, number>;
    by_trust: Record<string, number>;
    ms: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Trust-Scoring — pro Wert ein Trust-Level für den Review-UI
// ─────────────────────────────────────────────────────────────────────────

/** Generische Drucktexts ohne semantischen Anker. Häufige Halluzinations-Magneten. */
const GENERIC_DRUCKTEXTS = new Set([
  'Bezeichnung', 'Betrag', 'Summe', 'Art', 'Datum', 'Anzahl', 'Bemerkung',
]);

/** In-place: setzt trust + trust_reasons auf jedem canonical-Eintrag.
 *
 * Heuristiken:
 *   • Wert-Halluzination: identischer Wert in ≥3 generischen Drucktext-Feldern
 *     (z.B. "456" in Bezeichnung+Betrag+Summe — OCR-Boilerplate aus WISO/ERiC).
 *   • Zeilennummer als Wert: value === vordruckzeile und beides 1-3 Ziffern.
 *   • Currency-Mismatch: datentyp=currency aber value nicht numerisch.
 *   • BMF_RECHNER + REGEX_100% mit evidence_line → high
 *   • REGEX_3F + LLM_FSM mit spezifischem Drucktext → medium
 *   • LLM_FSM mit generischem Drucktext → low
 */
function computeTrust(canonical: Record<string, CanonicalValue>): void {
  // Pass A: index identischer Werte über generische Drucktext-Felder.
  const valueOccurrences = new Map<string, CanonicalValue[]>();
  for (const v of Object.values(canonical)) {
    if (!v.value) continue;
    if (!GENERIC_DRUCKTEXTS.has(v.drucktext.trim())) continue;
    const key = String(v.value).trim();
    if (!key) continue;
    let arr = valueOccurrences.get(key);
    if (!arr) { arr = []; valueOccurrences.set(key, arr); }
    arr.push(v);
  }
  const hallucinatedValues = new Set<string>();
  for (const [val, vs] of valueOccurrences) {
    if (vs.length >= 3) hallucinatedValues.add(val);
  }

  // Pass B: trust pro Eintrag.
  for (const v of Object.values(canonical)) {
    const reasons: string[] = [];
    const valStr = String(v.value ?? '').trim();
    let trust: CanonicalValue['trust'];

    if (hallucinatedValues.has(valStr) && GENERIC_DRUCKTEXTS.has(v.drucktext.trim())) {
      trust = 'suspicious';
      reasons.push(`Wert "${valStr}" tritt in mehreren generischen Drucktext-Feldern auf — vermutlich OCR-Platzhalter`);
    } else if (v.repeat_suspicious) {
      // Cross-Anlage repeat detection aus phase1: gleiche (value, drucktext)
      // in ≥3 eCodes über ≥2 Anlagen → WISO-Platzhalter (z.B. "Bezeichnung 456").
      trust = 'suspicious';
      reasons.push(`Wert "${valStr}" + Drucktext "${v.drucktext}" tritt in mehreren Anlagen auf — Platzhalter-Verdacht`);
    } else if (
      valStr === v.vordruckzeile &&
      /^\d{1,3}$/.test(valStr) &&
      v.datentyp !== 'currency' // 0,00 € als Lohnsteuer ist OK
    ) {
      trust = 'suspicious';
      reasons.push(`Wert entspricht Zeilennummer ${v.vordruckzeile} — Zeilennummer als Wert misinterpretiert`);
    } else if (v.origin === 'BMF_RECHNER') {
      trust = 'high';
      reasons.push('BMF Lane-1 deterministisch berechnet');
    } else if (v.origin === 'REGEX_100%' && v.zeile_anchored === false) {
      // 4-Faktor-Match aber führende Label-Nummer != vordruckzeile (z.B.
      // Treffer in Tabellen-Header, der die Zeilennummer woanders enthält).
      trust = 'suspicious';
      reasons.push('Regex-Match ohne führenden Zeilen-Anker (vordruckzeile-Mismatch)');
    } else if (v.origin === 'REGEX_100%' && v.evidence_line) {
      trust = 'high';
      reasons.push('Regex-Match mit Belegzeile');
    } else if (v.origin === 'REGEX_100%') {
      trust = 'medium';
      reasons.push('Regex-Match (Belegzeile fehlt)');
    } else if (v.origin === 'REGEX_3F') {
      // 3-Faktor-Fallback: nur dann 'medium' wenn der Treffer auch
      // anchored ist (führende Zeilen-Nummer matched vordruckzeile).
      // Sonst 'suspicious' — fängt WISO-Platzhalter "48 Bezeichnung 456"
      // ab die auf Bezeichnung-eCodes anderer Anlagen matchen würden.
      if (v.zeile_anchored === true) {
        trust = 'medium';
        reasons.push('Regex-Match mit 3-Feld-Kontext (Zeilen-Anker)');
      } else if (v.zeile_anchored === undefined) {
        // vordruckzeile unbekannt → Altverhalten beibehalten
        trust = 'medium';
        reasons.push('Regex-Match mit 3-Feld-Kontext (kein Zeilen-Anker prüfbar)');
      } else {
        trust = 'suspicious';
        reasons.push('Regex-3F-Match ohne Zeilen-Anker — vordruckzeile-Mismatch');
      }
    } else if (v.origin === 'LLM_FSM') {
      if (v.datentyp === 'currency' && valStr && !/^-?[\d.,]/.test(valStr)) {
        trust = 'suspicious';
        reasons.push(`Datentyp currency aber Wert "${valStr}" nicht numerisch`);
      } else if (GENERIC_DRUCKTEXTS.has(v.drucktext.trim())) {
        trust = 'low';
        reasons.push(`LLM-Fill auf generisches Feld "${v.drucktext}" — kein eindeutiger Anker`);
      } else {
        trust = 'medium';
        reasons.push('LLM-Fill mit spezifischem Drucktext');
      }
    } else {
      trust = 'low';
      reasons.push('Unbekannte Origin');
    }

    v.trust = trust;
    v.trust_reasons = reasons;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Numeric normalization — populate CanonicalValue.normalizedNumber
// ─────────────────────────────────────────────────────────────────────────

/**
 * Numerische ELSTER-Datentypen, für die `normalizedNumber` gesetzt wird.
 *
 * Heute liefert der Katalog nur `currency` (siehe data/atoms.json). Die
 * Liste deckt zusätzliche numerische Tags ab, die in anderen Workflows /
 * BMF-Rechner-Outputs auftauchen können — additiv, kein Verhalten ändert
 * sich für nicht-numerische Felder.
 */
const NUMERIC_DATENTYPS = new Set<string>([
  'currency',
  'amount',
  'integer',
  'percent',
  'number',
]);

/** In-place: setzt normalizedNumber auf jedem numerischen Eintrag.
 *
 * Bevorzugt das bereits gewirte `normalized`-Feld (Integer-Cents für
 * currency → /100 zurückrechnen). Fällt zurück auf den Roh-`value` via
 * parseGermanMoney, falls `normalized` nicht numerisch parseable ist
 * (z.B. bei LLM-Fills die normalizeForElster nicht durchlaufen haben).
 */
function populateNormalizedNumber(canonical: Record<string, CanonicalValue>): void {
  for (const cv of Object.values(canonical)) {
    if (!NUMERIC_DATENTYPS.has(cv.datentyp)) continue;
    let n: number | null = null;
    if (cv.datentyp === 'currency' && cv.normalized && /^-?\d+$/.test(cv.normalized)) {
      // normalized ist Integer-Cents (siehe normalizeForElster) — zurück nach Euro.
      n = parseInt(cv.normalized, 10) / 100;
    } else {
      // Andere numerische Typen oder unnormalisierte currency: parse value direkt.
      n = parseGermanMoney(cv.value);
    }
    if (n !== null && Number.isFinite(n)) {
      cv.normalizedNumber = n;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// XML-Builder
// ─────────────────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attrEscape(s: string | null | undefined): string {
  return xmlEscape((s ?? '').toString());
}

export function buildEricXml(canonical: Record<string, CanonicalValue>): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Erklaerung art="ESt" schema="0711:elster:bmf:jahresdok-2024:v1">',
  ];
  // Sortiert nach Anlage + Vordruckzeile (BMF-kompatibel, deterministischer Diff).
  const sorted = Object.values(canonical).sort((a, b) => {
    if (a.anlage !== b.anlage) return a.anlage.localeCompare(b.anlage);
    const za = Number(a.vordruckzeile) || Number.MAX_SAFE_INTEGER;
    const zb = Number(b.vordruckzeile) || Number.MAX_SAFE_INTEGER;
    if (za !== zb) return za - zb;
    return a.eCode.localeCompare(b.eCode);
  });
  for (const v of sorted) {
    const attrs = [
      `anlage="${attrEscape(v.anlage)}"`,
      `zeile="${attrEscape(v.vordruckzeile)}"`,
      `datentyp="${attrEscape(v.datentyp)}"`,
      `kontext="${attrEscape(v.kontextPath)}"`,
      `origin="${attrEscape(v.origin)}"`,
    ].join(' ');
    const wire = v.normalized ?? v.value;
    lines.push(`  <${v.eCode} ${attrs}>${xmlEscape(wire)}</${v.eCode}>`);
  }
  lines.push('</Erklaerung>');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const phase5MergeStage = defineStage<Phase5MergeInput, Phase5MergeOutput, Record<string, never>>({
  id: 'elster-v5/phase5-merge',
  name: 'Phase 5 — Canonical Merge + ERiC-XML',
  description:
    'Vereinigt Phase-1-regex_hits (priority 1) + Phase-3-llm_hits (priority 2) ' +
    'pro eCode. Generiert ERiC-XML bereit für den BMF-Client. Pure logic, kein ' +
    'LLM. Output: canonical_layer (eCode → wert + provenance) + xml_payload.',
  hints: {
    inputs: 'phase1_per_anlage, phase3_per_anlage',
    outputs: 'canonical_layer (eCode-map), xml_payload (string), stats',
    configExample: '{}',
    inputPorts: [
      { name: 'phase1_per_anlage', type: 'json' },
      { name: 'phase3_per_anlage', type: 'json' },
    ],
    outputPorts: [
      { name: 'canonical_layer', type: 'json' },
      { name: 'xml_payload', type: 'text' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    // P10: phase5-merge consumes phase1+phase3 outputs as already-built values
    // — no direct atoms/container lookup needed. The P7 probe was dropped —
    // re-add a `ctx.tools.get('elster-catalog')` here when this stage needs
    // cat.get('atoms').
    const phase1 = input.phase1_per_anlage ?? {};
    const phase3 = input.phase3_per_anlage ?? {};
    const canonical: Record<string, CanonicalValue> = {};
    let fromRegex = 0;
    let fromLlm = 0;
    const byAnlage: Record<string, number> = {};
    const byDatentyp: Record<string, number> = {};

    // Pass 1: alle regex_hits — höchste Priorität.
    for (const [, p1] of Object.entries(phase1)) {
      for (const [eCode, h] of Object.entries(p1.regex_hits as Record<string, Phase1RegexHit>)) {
        canonical[eCode] = {
          eCode,
          value: h.value,
          normalized: h.normalized,
          origin: h.origin,
          anlage: h.anlage,
          drucktext: h.drucktext,
          vordruckzeile: h.vordruckzeile,
          datentyp: h.datentyp,
          kontextPath: h.kontextPath,
          evidence_line: h.evidence_line,
          trust: 'medium',
          trust_reasons: [],
          zeile_anchored: h.zeile_anchored,
          repeat_suspicious: h.repeat_suspicious,
        };
        fromRegex++;
        byAnlage[h.anlage] = (byAnlage[h.anlage] ?? 0) + 1;
        byDatentyp[h.datentyp] = (byDatentyp[h.datentyp] ?? 0) + 1;
      }
    }
    // Pass 2: alle llm_hits — nur wo regex KEIN Wert hatte ODER der
    // Regex-Wert suspekt war (WISO-Platzhalter / kein Zeilen-Anker). In dem
    // Fall darf LLM den Regex-Hit überschreiben — sonst bleibt z.B. die VOR-
    // Zeile 11 dauerhaft auf "456" stehen, obwohl Vision "4.703" gelesen hat.
    for (const [, p3] of Object.entries(phase3)) {
      for (const [eCode, h] of Object.entries(p3.llm_hits as Record<string, Phase3LlmHit>)) {
        const existing = canonical[eCode];
        if (existing) {
          const existingSuspect =
            existing.repeat_suspicious === true ||
            existing.zeile_anchored === false;
          if (!existingSuspect) continue; // regex hat Priorität
          // sonst: LLM überschreibt suspekten Regex-Hit
        }
        const normalized = normalizeForElster(h.value, h.datentyp);
        canonical[eCode] = {
          eCode,
          value: h.value,
          normalized,
          origin: 'LLM_FSM',
          anlage: h.anlage,
          drucktext: h.drucktext,
          vordruckzeile: h.vordruckzeile,
          datentyp: h.datentyp,
          kontextPath: h.kontextPath,
          trust: 'medium',
          trust_reasons: [],
        };
        fromLlm++;
        byAnlage[h.anlage] = (byAnlage[h.anlage] ?? 0) + 1;
        byDatentyp[h.datentyp] = (byDatentyp[h.datentyp] ?? 0) + 1;
      }
    }

    // Numerische Werte vorparsen → normalizedNumber. Eine einzige Stelle,
    // damit BMF-Rechner, Cross-Validator und Ground-Truth-Vergleich nicht
    // jedes Mal das deutsche Format reverse-engineeren.
    populateNormalizedNumber(canonical);

    // Trust-Scoring vor XML-Build, damit es in canonical_layer.json persistiert.
    computeTrust(canonical);
    const trustCounts = { high: 0, medium: 0, low: 0, suspicious: 0 } as Record<string, number>;
    for (const v of Object.values(canonical)) trustCounts[v.trust] = (trustCounts[v.trust] ?? 0) + 1;

    const xml = buildEricXml(canonical);
    await ctx.artifacts.write('canonical_layer.json', canonical);
    await ctx.artifacts.write('eric_payload.xml', xml);

    ctx.emit('phase5_done', {
      total: Object.keys(canonical).length,
      from_regex: fromRegex,
      from_llm: fromLlm,
      anlagen: Object.keys(byAnlage).length,
      trust: trustCounts,
    });

    return {
      canonical_layer: canonical,
      xml_payload: xml,
      stats: {
        total: Object.keys(canonical).length,
        from_regex: fromRegex,
        from_llm: fromLlm,
        by_anlage: byAnlage,
        by_datentyp: byDatentyp,
        by_trust: trustCounts,
        ms: Date.now() - t0,
      },
    };
  },
});
