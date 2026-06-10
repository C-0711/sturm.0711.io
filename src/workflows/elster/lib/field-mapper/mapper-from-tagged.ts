/**
 * mapper-from-tagged — Lane-2-Entry-Point ohne rawText-Rekonstruktion.
 *
 * Architektur-Vergleich:
 *
 *   Lane 1 (TS deterministisch):
 *     rawText → extractor.ts (Label-Wert-Paare) → schema-driven match
 *     → normalize → MappedField[]
 *
 *   Lane 2 (vor P3b):
 *     OCR-Response → lane2-adapter (rawText-Synthese) → mapBeleg()
 *     Problem: rawText-Synthese verliert Layout-Struktur, viele False-
 *              Misses bei Belegen mit komplexer Spaltenführung.
 *
 *   Lane 2 (jetzt — P3b):
 *     OCR-Response → mapBelegFromTagged() arbeitet direkt auf
 *     (record, bbox, candidate_eCodes)-Tupeln.
 *
 * Algorithmus:
 *   1. Lade BelegSchema → Set der bekannten E-Codes.
 *   2. Pro TaggedPage, pro TaggedRecord mit non-empty candidates:
 *      a. Nimm Top-1-Kandidat (eCode, score).
 *      b. Wenn score ≥ minScore UND eCode im Schema:
 *         - Finde "Wert-Record": spatial-rechter Nachbar auf gleicher
 *           Y-Linie (BBox-basiert).
 *         - Normalisiere per FieldMapping.valueType.
 *         - Emit MappedField.
 *   3. Aggregat-Duplikate per (eCode, person) im Caller via aggregate().
 *
 * Anti-Goals:
 *   - Keine eigene Beleg-Typ-Erkennung — Caller liefert belegTyp.
 *   - Keine LLM-Fallbacks — wenn der Top-1-Kandidat keinen passenden
 *     Schema-Eintrag hat, wird nichts emittiert (HiTL-Queue zuständig).
 *   - Keine Multi-Engine-Voter-Behandlung — orchestrator hat schon
 *     consensus.rs::vote() durchlaufen, wir kriegen den geeinten Output.
 */
import { normalize } from './normalizer.ts';
import { ALL_SCHEMAS, getSchema } from './schemas.ts';
import type {
  BelegTyp,
  FieldMapping,
  MappedField,
  MappingResult,
  Person,
} from './types.ts';
import type {
  BBoxWire,
  ConsensusRecord,
  TaggedPage,
  TaggedRecord,
} from './ocr-ensemble-client.ts';

export interface MapFromTaggedOptions {
  /** Schwelle für Top-1-Candidate-Score (0..1). Default 0.50. */
  minScore?: number;
  /** Y-Toleranz in Pixel für "auf gleicher Zeile". Default 8 px. */
  rowTolPx?: number;
  /** Maximaler horizontaler Abstand vom Label-Right-Edge zum Value. */
  maxValueDxPx?: number;
}

/** Center-Punkt einer BBox. */
function bboxCenter(b: BBoxWire): { cx: number; cy: number } {
  const [x0, y0, x1, y1] = b;
  return { cx: (x0 + x1) * 0.5, cy: (y0 + y1) * 0.5 };
}

/** Sieht der Text-Inhalt nach einem Wert (Zahl/Datum/kurzer Token) aus? */
function looksLikeValueText(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 80) return false;
  return (
    /^-?\d[\d.,\s]*€?$/.test(t) ||             // Zahl mit Tausender-/Komma
    /^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(t) ||   // TT.MM.JJJJ
    /^\d{1,2}\.\d{4}$/.test(t) ||              // MM.JJJJ
    /^\d{4}$/.test(t) ||                       // Jahr
    /^\d{2}$/.test(t) ||                       // Monat / Steuerklasse-Ziffer
    /^\d{2}\s?\d{3}\s?\d{3}\s?\d{3}$/.test(t) ||  // IdNr 11-stellig
    /^[A-Z]{2}\d{2}[\d ]+[A-Z0-9]*$/.test(t) ||   // IBAN-artig
    /^[A-ZÄÖÜa-zäöü][\wäöüÄÖÜß .,'-]{0,50}$/.test(t)  // kurzer Text (Name, Bank, "Evangelisch")
  );
}

/**
 * Findet den am wahrscheinlichsten zum Label gehörenden Wert-Record:
 * rechter Nachbar auf gleicher Y-Linie. Filtert das Label selbst raus.
 */
function findValueRecord(
  labelRecord: ConsensusRecord,
  pageRecords: ReadonlyArray<ConsensusRecord>,
  rowTolPx: number,
  maxValueDxPx: number,
): ConsensusRecord | null {
  if (!labelRecord.bbox) return null;
  const lc = bboxCenter(labelRecord.bbox);
  const [, , lx1] = labelRecord.bbox;
  let best: { rec: ConsensusRecord; x0: number } | null = null;
  for (const r of pageRecords) {
    if (r === labelRecord) continue;
    if (!r.bbox) continue;
    const [x0] = r.bbox;
    if (x0 < lx1) continue; // muss strikt rechts vom Label sein
    if (x0 - lx1 > maxValueDxPx) continue;
    const rc = bboxCenter(r.bbox);
    if (Math.abs(rc.cy - lc.cy) > rowTolPx) continue;
    if (!looksLikeValueText(r.text)) continue;
    if (best === null || x0 < best.x0) best = { rec: r, x0 };
  }
  return best?.rec ?? null;
}

export interface ClassifySchemaScore {
  belegTyp: BelegTyp;
  /** Distinct E-Codes aus dem Schema, die in den Tagged-Candidates auftauchen. */
  matched: number;
  /** Anteil am Schema (matched / schema.felder.length). */
  coverage: number;
  /** Geometric mean √(matched × coverage) — balanciert absolute Hits
   *  und schema-Anteil und ist die Sortier-Größe. */
  score: number;
}

export interface ClassifyResult {
  belegTyp: BelegTyp;
  /** Anzahl distinct-E-Code-Treffer im Schema. */
  matchedECodes: number;
  /** Verhältnis: matchedECodes / schema.felder.length (0..1). */
  coverage: number;
  /** √(matched × coverage) für das Gewinner-Schema. */
  score: number;
  /** Alle BelegTyp-Scores (für Debug, sortiert absteigend nach score). */
  scores: ClassifySchemaScore[];
}

/**
 * Klassifiziert BelegTyp anhand der semantic-overlay-Kandidaten — robuster
 * als detectBelegTyp(rawText) für OCR'd PDFs wo die Titel-Patterns oft
 * nicht zuverlässig matchen.
 *
 * Algorithmus:
 *   1. Sammle "geseheneN" E-Codes: top-1-Kandidat pro Tagged-Record,
 *      Score ≥ minScore.
 *   2. Pro BelegSchema: matched = |seen ∩ schemaECodes|,
 *      coverage = matched / schemaSize.
 *   3. Score = √(matched × coverage) — geometric mean (balanciert
 *      absolute Hits mit dem schema-Anteil; verhindert dass kleine
 *      Schemas mit 1 Trivial-Hit (IdNr) gewinnen).
 *   4. Filter: minMatched=2 — wenn das Gewinner-Schema weniger als 2
 *      DISTINCT E-Codes matched, → 'Unbekannt' (Schutz vor IdNr-only
 *      false positives).
 *
 * Sortiert absteigend nach score; tie-break über höhere coverage,
 * dann höhere matched-Anzahl.
 */
export function classifyFromTagged(
  taggedPages: TaggedPage[],
  opts: { minScore?: number; minMatched?: number; minScoreFloor?: number } = {},
): ClassifyResult {
  const minScore = opts.minScore ?? 0.5;
  const minMatched = opts.minMatched ?? 2;
  const minScoreFloor = opts.minScoreFloor ?? 0.5;

  const seenECodes = new Set<string>();
  for (const page of taggedPages) {
    for (const tr of page.records) {
      if (tr.candidates.length === 0) continue;
      const [eCode, score] = tr.candidates[0];
      if (score >= minScore) seenECodes.add(eCode);
    }
  }

  const scores: ClassifySchemaScore[] = [];
  for (const [_, schema] of Object.entries(ALL_SCHEMAS)) {
    const schemaECodes = new Set(schema.felder.map((f) => f.eCode));
    let matched = 0;
    for (const e of seenECodes) if (schemaECodes.has(e)) matched += 1;
    const coverage = schemaECodes.size > 0 ? matched / schemaECodes.size : 0;
    const score = Math.sqrt(matched * coverage);
    scores.push({ belegTyp: schema.belegTyp, matched, coverage, score });
  }
  // Sort by score desc, then coverage desc, then matched desc
  scores.sort((a, b) => b.score - a.score || b.coverage - a.coverage || b.matched - a.matched);

  const top = scores[0];
  const belegTyp =
    top && top.matched >= minMatched && top.score >= minScoreFloor
      ? top.belegTyp
      : ('Unbekannt' as BelegTyp);
  return {
    belegTyp,
    matchedECodes: top?.matched ?? 0,
    coverage: top?.coverage ?? 0,
    score: top?.score ?? 0,
    scores: scores.slice(0, 5),
  };
}

/** Hauptfunktion. */
export function mapBelegFromTagged(
  taggedPages: TaggedPage[],
  belegTyp: BelegTyp,
  person: Person,
  opts: MapFromTaggedOptions = {},
): MappingResult {
  const warnings: string[] = [];
  const schema = getSchema(belegTyp);
  if (!schema) {
    return {
      belegTyp,
      person,
      felder: [],
      missingExpected: [],
      unmatched: [],
      warnings: [`Kein Schema für Beleg-Typ ${belegTyp} verfügbar.`],
    };
  }

  const minScore = opts.minScore ?? 0.5;
  const rowTolPx = opts.rowTolPx ?? 8;
  const maxValueDxPx = opts.maxValueDxPx ?? 600;

  const schemaByECode = new Map<string, FieldMapping>();
  for (const f of schema.felder) {
    // Bei Schemen mit derselben E-Code in mehreren Kontexten gewinnt der
    // erste — das ist akzeptabel weil die Schemas das anders modellieren
    // (aliases statt Mehrfach-Einträge).
    if (!schemaByECode.has(f.eCode)) schemaByECode.set(f.eCode, f);
  }

  const out: MappedField[] = [];
  const missingExpected = new Set<string>();
  schema.felder.filter((f) => f.required).forEach((f) => missingExpected.add(f.pdfLabel));
  const unmatched: Array<{ label: string; value: string }> = [];

  for (const page of taggedPages) {
    const pageRecords: ConsensusRecord[] = page.records.map((tr) => tr.record);
    for (const tagged of page.records) {
      if (tagged.candidates.length === 0) continue;
      const [topECode, topScore] = tagged.candidates[0];
      if (topScore < minScore) continue;
      const field = schemaByECode.get(topECode);
      if (!field) continue;

      const valueRec = findValueRecord(tagged.record, pageRecords, rowTolPx, maxValueDxPx);
      if (!valueRec) {
        // Label gefunden, aber kein spatial-Wert dran — Pflichtfeld bleibt
        // als missingExpected gemerkt.
        continue;
      }

      const norm = normalize(valueRec.text, field.valueType);
      out.push({
        eCode: topECode,
        anlage: field.anlage,
        kontextSubpath: field.kontextSubpath,
        wert: norm.wert,
        rawValue: valueRec.text,
        person,
        pdfLabel: field.pdfLabel,
        valueType: field.valueType,
        method: 'schema',
        confidence: topScore,
        warnings: norm.warnings.length > 0 ? norm.warnings : undefined,
      });
      missingExpected.delete(field.pdfLabel);
    }
  }

  return {
    belegTyp,
    person,
    felder: out,
    missingExpected: [...missingExpected],
    unmatched,
    warnings,
  };
}
