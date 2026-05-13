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
import type { Phase1AnlageResult, Phase1RegexHit } from './phase1-regex.ts';
import type { Phase3AnlageResult, Phase3LlmHit } from './phase3-llm-fill.ts';

export interface CanonicalValue {
  eCode: string;
  value: string;
  /** Wire-Format (Currency = Integer-Cents, Date = DD.MM.YYYY, ...). */
  normalized: string | null;
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
    ms: number;
  };
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

function buildEricXml(canonical: Record<string, CanonicalValue>): string {
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
        };
        fromRegex++;
        byAnlage[h.anlage] = (byAnlage[h.anlage] ?? 0) + 1;
        byDatentyp[h.datentyp] = (byDatentyp[h.datentyp] ?? 0) + 1;
      }
    }
    // Pass 2: alle llm_hits — nur wo regex KEIN Wert hatte.
    for (const [, p3] of Object.entries(phase3)) {
      for (const [eCode, h] of Object.entries(p3.llm_hits as Record<string, Phase3LlmHit>)) {
        if (eCode in canonical) continue; // regex hat Priorität
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
        };
        fromLlm++;
        byAnlage[h.anlage] = (byAnlage[h.anlage] ?? 0) + 1;
        byDatentyp[h.datentyp] = (byDatentyp[h.datentyp] ?? 0) + 1;
      }
    }

    const xml = buildEricXml(canonical);
    await ctx.artifacts.write('canonical_layer.json', canonical);
    await ctx.artifacts.write('eric_payload.xml', xml);

    ctx.emit('phase5_done', {
      total: Object.keys(canonical).length,
      from_regex: fromRegex,
      from_llm: fromLlm,
      anlagen: Object.keys(byAnlage).length,
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
        ms: Date.now() - t0,
      },
    };
  },
});
