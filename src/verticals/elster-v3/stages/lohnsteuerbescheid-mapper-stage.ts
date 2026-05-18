/**
 * elster-v3/lohnsteuerbescheid-mapper — Stage-Wrapper für die deterministische
 * VaSt-Beleg-Extraktion (Lohnsteuerbescheinigung + Religionszugehörigkeit +
 * Mitteilung freigestellte Kapitalerträge).
 *
 * Konsumiert Output von `elster-v3/label-value-parser` (BelegBlocks mit
 * doc_class + chunks), produziert eine flache eCode-Map.
 *
 * Pipeline-Position:
 *   ocr → label-value-parser → lohnsteuerbescheid-mapper → finalize-extraction
 *
 * Engine: O(1) Zeile-Number-Match → Levenshtein-Ratio-Fallback @ 0.85.
 * Person-A/B-Disambig per Steuer-Identifikationsnummer-Carry-Across.
 */
import { defineStage } from '../../../core/stage.ts';
import { felderFuerAnlage } from '../../../lib/elster-catalog.ts';
import {
  LohnsteuerbescheidMapper,
  type Atom,
  type Chunk,
  type ExtractionResult,
} from './lohnsteuerbescheid-mapper.ts';
import type { BelegBlock, LabelValueChunk } from './label-value-parser.ts';

export interface LStBMapperInput {
  /** Legacy-Pfad: BelegBlocks von elster-v3/label-value-parser. Bevorzugt
   *  wenn beide gesetzt sind. */
  belege?: BelegBlock[];
  /** v5_4-Pfad: strukturierte Dokument-Blöcke von gemma-vision-ocr-zoning.
   *  Wenn `belege` nicht gesetzt, werden diese intern konvertiert. Vorteile:
   *  - label-value-parser kann aus dem Workflow raus (1 Stage weniger)
   *  - Person-A/B-Tag ist bereits unverrückbar fest (gehoert_zu_person)
   *  - keine fragile Beleg-Header-Heuristik mehr (Vision-Modell hat
   *    bereits Layout-Zonen + Personen-Zuordnung deterministisch bestimmt) */
  erkannte_dokumente?: Array<{
    dokumenten_typ: string;
    gehoert_zu_person?: string;
    ocr_zeilen?: Array<{ zeilen_nr: number; text: string }>;
  }>;
}

export interface LStBMapperConfig {
  /** Levenshtein-Threshold für Fallback-Match. Default 0.85. */
  ratioThreshold?: number;
}

export interface LStBMapperOutput {
  /** eCode → value (cents for currency, raw string for strings). */
  ecodes: ExtractionResult;
  /** How many distinct eCodes were locked. */
  lockCount: number;
  /** Per-beleg counts (transparency for debug). */
  perBeleg: Array<{
    index: number;
    docClass: string;
    chunks: number;
    locksContributed: number;
  }>;
  ms: number;
}

// ─── Container → Atom-Shape adapter ────────────────────────────────────────

async function loadAtomsForLStB(): Promise<Atom[]> {
  // LStB-Mapper liest Anlagen N, VOR, AV
  const out: Atom[] = [];
  for (const anlage of ['N', 'VOR', 'AV', 'ESt1A', 'KAP'] as const) {
    try {
      const liste = await felderFuerAnlage(anlage);
      for (const f of liste.felder) {
        out.push({
          ecode: f.eCode,
          anlage: liste.anlage,
          drucktext: f.drucktext,
          zeile: f.vordruckzeile,
        });
      }
    } catch {
      // anlage may not exist in container — skip
    }
  }
  return out;
}

// ─── Convert LabelValueChunk → Mapper.Chunk ────────────────────────────────

function toMapperChunk(c: LabelValueChunk): Chunk {
  return {
    zeile: c.zeile ?? null,
    label: c.label,
    value: c.value,
  };
}

// ─── Convert erkannte_dokumente → BelegBlock[] ─────────────────────────────
// Map Gemma-Block-Typen auf BelegBlock.doc_class. Was nicht im Set ist
// landet als 'unknown' (Mapper-Engine überspringt diese Blocks elegant).
const BLOCK_TYPE_TO_DOC_CLASS: Record<string, BelegBlock['doc_class']> = {
  Lohnsteuerbescheinigung: 'lohnsteuerbescheinigung',
  Mitteilung_Kapitalertraege: 'mitteilung_kapitalertraege',
  Steuerbescheinigung_Bank: 'mitteilung_kapitalertraege', // Bank-Bescheinigung mit Freistellungs-Beträgen
  Religionszugehoerigkeit: 'religionszugehoerigkeit',
  Rentenbezugsmitteilung: 'rentenbezug_mitteilung',
  Spendenquittung: 'spendenquittung',
};

/**
 * Parst eine Vision-OCR-Zeile in {zeile?, label, value}.
 *
 * Vision-OCR-Format-Beispiele (gemma-vision-ocr-zoning):
 *   "5. Bruttoarbeitslohn (ohne 9. und 10.) 69.291,80 €"
 *      → {zeile:"5", label:"Bruttoarbeitslohn (ohne 9. und 10.)", value:"69.291,80 €"}
 *   "Nachname Stricker"
 *      → {zeile:null, label:"Nachname", value:"Stricker"}
 *   "Steuerklasse 3"
 *      → {zeile:null, label:"Steuerklasse", value:"3"}
 *   "Identifikationsnummer 85236749007"
 *      → {zeile:null, label:"Identifikationsnummer", value:"85236749007"}
 *   "Übermittlung der Bescheinigung an die Finanzverwaltung 18.12.2024 11:50:41"
 *      → {zeile:null, label:"Übermittlung ...", value:"18.12.2024 11:50:41"}
 *
 * Strategie: value-Pattern-Suche von rechts (Currency, Datum, IdNr, Jahr,
 * Integer), Label = alles davor. Wenn kein Pattern matched: leere value
 * (Mapper kann via Levenshtein-Ratio gegen drucktext trotzdem locken,
 * oder Zeile wird übersprungen).
 *
 * Format-Reihenfolge (spezifisch zuerst):
 *   1. Currency mit €: "(\d[\d.]*,\d{2})\s*€"
 *   2. Datum + Uhrzeit: "(\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}:\d{2})"
 *   3. Datum: "(\d{1,2}\.\d{1,2}\.\d{4})"
 *   4. IdNr 11-stellig: "(\d{11})"
 *   5. Integer am Ende: "(\d{1,4})"  (z.B. "Steuerklasse 3", "Anzahl U 0")
 *   6. Konfessions-Strings: "(Evangelisch|Römisch-Katholisch|...)"
 *   7. Single-token name: "([A-Z][a-zäöüß]+)"  (z.B. "Stricker", "Rainer")
 */
const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'currency', re: /\s(\d{1,3}(?:\.\d{3})*,\d{2})\s*€?\s*$/ },
  { name: 'datetime', re: /\s(\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)\s*$/ },
  { name: 'date', re: /\s(\d{1,2}\.\d{1,2}\.\d{4})\s*$/ },
  { name: 'idnr', re: /\s(\d{11})\s*$/ },
  { name: 'year', re: /\s(20\d{2})\s*$/ },
  { name: 'konfession', re: /\s(Evangelisch|Römisch-Katholisch|Altkatholisch|Israelitisch|Freireligiös|Lutherisch|Reformiert|keine)\s*$/i },
  { name: 'integer', re: /\s(\d{1,4})\s*$/ },
  // Single-token alpha am Ende — z.B. "Nachname Stricker"
  { name: 'name', re: /\s([A-ZÄÖÜ][a-zäöüß]{2,}(?:[-\s][A-ZÄÖÜ][a-zäöüß]+)*)\s*$/ },
];

function parseOcrLine(rawText: string, lineIndex: number): LabelValueChunk {
  const text = rawText.trim();
  // Zeile-Number-Prefix mit optionalem Sub-Buchstaben:
  //   "5. Bruttoarbeitslohn 69.291,80 €"           → zeile = "5"
  //   "22. a) Arbeitgeberanteil ... 6.544,01 €"    → zeile = "22 a"
  //   "23. b) Arbeitnehmeranteil zu ...berufsständ. → zeile = "23 b"
  // LSTB_ZEILE_TO_ECODE hat beide Varianten ("22 a" + "22") als Keys, damit
  // sowohl Sub-Buchstabe-spezifisches als auch Fallback-Mapping greift.
  const zeileMatch = text.match(/^(\d{1,3})\.\s+(?:([abc])\)\s+)?(.+)$/);
  let zeile: string | null = null;
  let rest = text;
  if (zeileMatch) {
    const num = Number(zeileMatch[1]);
    if (num >= 1 && num <= 100) {
      zeile = zeileMatch[2] ? `${num} ${zeileMatch[2]}` : String(num);
      rest = zeileMatch[3];
    }
  }
  // Value-Pattern-Suche von rechts
  let label = rest;
  let value = '';
  for (const { re } of VALUE_PATTERNS) {
    const m = rest.match(re);
    if (m) {
      value = m[1];
      label = rest.slice(0, m.index!).trim();
      break;
    }
  }
  // Cleanup: trailing colon/comma am label entfernen
  label = label.replace(/[:,;]\s*$/, '').trim();
  return {
    zeile: zeile ?? undefined,
    label,
    value,
    rawLine: rawText,
    lineIndex,
  };
}

import { createHash } from 'node:crypto';

function erkannteDokumenteToBeleg(
  blocks: NonNullable<LStBMapperInput['erkannte_dokumente']>,
): BelegBlock[] {
  const out: BelegBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const docClass: BelegBlock['doc_class'] =
      BLOCK_TYPE_TO_DOC_CLASS[b.dokumenten_typ] ?? 'unknown';
    const zeilen = b.ocr_zeilen ?? [];
    const rawText = zeilen.map((z) => z.text).join('\n');
    const chunks = zeilen.map((z, idx) => parseOcrLine(z.text, idx));
    // Person-A/B-Hint im title kodieren: der Mapper trackt personMapping
    // intern via Steuer-IdNr; der Vision-Tag ist zusätzliche Bestätigung
    // (in einer späteren Iteration ggf. als hard-override gegen IdNr-Carry).
    const personTag = b.gehoert_zu_person ? ` [Person ${b.gehoert_zu_person}]` : '';
    out.push({
      index: i,
      doc_class: docClass,
      title: `${b.dokumenten_typ}${personTag}`,
      rawText,
      chunks,
      text_sha256: createHash('sha256').update(rawText).digest('hex'),
    });
  }
  return out;
}

// ─── Stage ─────────────────────────────────────────────────────────────────

export const lohnsteuerbescheidMapperStage = defineStage<
  LStBMapperInput,
  LStBMapperOutput,
  LStBMapperConfig
>({
  id: 'elster-v3/lohnsteuerbescheid-mapper',
  name: 'Lohnsteuerbescheid-Mapper (VaSt-Belege → eCodes)',
  description:
    'Deterministische eCode-Zuordnung für VaSt-Belege (Lohnsteuerbescheinigung, ' +
    'Religionszugehörigkeit, Mitteilung freigestellte Kapitalerträge). ' +
    'Fast-Path über atom.zeile, Fallback Levenshtein-Ratio gegen drucktext.',
  hints: {
    inputs:
      'belege?: BelegBlock[] (legacy: label-value-parser) | erkannte_dokumente?: Block[] (v5_4: gemma-vision-ocr-zoning)',
    outputs: 'ecodes: { [ecode]: cents | string }, lockCount, perBeleg[], ms',
    configExample: '{"ratioThreshold": 0.85}',
    inputPorts: [
      { name: 'belege', type: 'belege', description: 'BelegBlocks aus label-value-parser (legacy)' },
      { name: 'erkannte_dokumente', type: 'json', description: 'Block-Liste aus gemma-vision-ocr-zoning (v5_4)' },
    ],
    outputPorts: [
      { name: 'ecodes', type: 'ecodes', description: 'Flache eCode-Map (cents für currency)' },
      { name: 'lockCount', type: 'number' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    // Input-Quelle: belege (legacy) bevorzugt, fallback auf erkannte_dokumente
    // (v5_4 via Vision-OCR-Zoning).
    let belege: BelegBlock[] = input?.belege ?? [];
    if (belege.length === 0 && (input?.erkannte_dokumente?.length ?? 0) > 0) {
      belege = erkannteDokumenteToBeleg(input!.erkannte_dokumente!);
      ctx.emit('lstb_mapper_converted_from_zoning', {
        blockCount: belege.length,
        docClasses: belege.map((b) => b.doc_class),
      });
    }
    if (belege.length === 0) {
      ctx.logger.warn('lohnsteuerbescheid-mapper: keine Belege im Input (weder belege noch erkannte_dokumente)');
      return { ecodes: {}, lockCount: 0, perBeleg: [], ms: 0 };
    }

    const threshold = ctx.config?.ratioThreshold ?? 0.85;
    const atoms = await loadAtomsForLStB();
    ctx.logger.info(`Loaded ${atoms.length} LStB-relevant atoms (N/VOR/AV/ESt1A/KAP)`);

    const mapper = new LohnsteuerbescheidMapper(atoms, threshold);
    const perBeleg: LStBMapperOutput['perBeleg'] = [];

    for (const beleg of belege) {
      const before = Object.keys(mapper.extractedData).length;
      const chunks = beleg.chunks.map(toMapperChunk);
      mapper.processBeleg(beleg.doc_class, chunks);
      const after = Object.keys(mapper.extractedData).length;
      perBeleg.push({
        index: beleg.index,
        docClass: beleg.doc_class,
        chunks: beleg.chunks.length,
        locksContributed: after - before,
      });
    }

    const ecodes = mapper.extractedData;
    const lockCount = Object.keys(ecodes).length;
    const ms = Date.now() - t0;

    ctx.emit('lstb_mapper_completed', {
      lockCount,
      belege: belege.length,
      personMapping: mapper.personMapping,
      ms,
    });

    return { ecodes, lockCount, perBeleg, ms };
  },
});
