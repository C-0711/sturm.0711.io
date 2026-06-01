/**
 * lane1 — DER konsolidierte deterministische Extraktions-Pfad.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  Lane 1 = "Digital-Text-VaSt → submittable E10-XML, deterministisch."
 * ════════════════════════════════════════════════════════════════════════
 *
 * Das ist der EINZIGE benannte Eingang. Wer einen Steuerfall verarbeiten
 * will, ruft `runLane1()`.
 *
 * EIN Weg, austauschbarer Parser:
 *   Jedes Dokument — egal ob Digital-Text-PDF, gescanntes PDF oder Bild —
 *   geht denselben Weg. Variabel ist nur der TEXT-LIEFERANT:
 *
 *     PDF mit Text         → pdftotext            (deterministisch, lokal)
 *     gescanntes PDF / Bild → opts.parseImage()    (injizierter OCR-Parser)
 *
 *   Ab dem rawText ist ALLES identisch:
 *     splitVastText → detectBelegTyp → resolvePerson → mapBeleg
 *       → aggregate → preValidate → buildE10XML
 *
 * Dependency-Injection für OCR: `opts.parseImage` ist optional. Ohne ihn
 * bleibt der Kern netzfrei (image-only Belege → deferred[]); mit ihm werden
 * Bilder INLINE im selben Lauf geparst (z.B. via tornado /ocr-ensemble).
 * So bleibt der deterministische Kern testbar/netzfrei, ohne den Bild-Pfad
 * künstlich abzuspalten.
 *
 * Granularität: ganzer Steuerfall. runLane1(docPaths[]) nimmt 1..N Dokumente
 * (Einzelbelege ODER Sammel-VaSt mit mehreren Sections), splittet, inferiert
 * Household (Person A/B), löst Person je Beleg (IdNr/Vorname für Text-VaSt,
 * Gläubiger-Name für gescannte Bank-Belege), aggregiert über alles, baut EIN
 * E10-XML. "Fall rein, XML raus."
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import type pg from 'pg';

import { mapBeleg, aggregate, detectBelegTyp, isFilledReturn } from './field-mapper/mapper.ts';
import { loadVordruckMap, extractByVordruckzeile } from './field-mapper/extractor-vordruckzeile.ts';
import type { VordruckMap } from './field-mapper/extractor-vordruckzeile.ts';
import { detectDokumentJahr } from './field-mapper/dokument-jahr.ts';
import type { DokumentJahr, JahrConfidence } from './field-mapper/dokument-jahr.ts';
import { preValidate } from './field-mapper/pre-validate.ts';
import type { ValidationReport } from './field-mapper/pre-validate.ts';
import { buildE10XML } from './field-mapper/e10-xml.ts';
import {
  splitVastText,
  inferHousehold,
  resolvePersonForSection,
  resolvePersonByName,
} from './field-mapper/vast-splitter.ts';

/** Bild-Endungen — werden gar nicht erst durch pdftotext gejagt, sondern
 *  direkt an den injizierten OCR-Parser (opts.parseImage) gereicht. */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.gif', '.bmp']);
import type { HouseholdResolution } from './field-mapper/vast-splitter.ts';
import type { HouseholdInfo } from './field-mapper/triage.ts';
import type {
  BelegInput,
  BelegTyp,
  MappedField,
  MappingResult,
  Person,
  ValueType,
} from './field-mapper/types.ts';

// ─── Public API-Typen ────────────────────────────────────────────────────

export interface Lane1Options {
  /** Veranlagungszeitraum (für Catalog-Lookups). */
  vz: number;
  /** Postgres-Pool gegen elster.* Schema. */
  pool: pg.Pool;
  /** Optional: vorgegebenes Household. Wenn weggelassen → aus den PDFs
   *  inferiert (IdNr-Häufigkeit + Beleg-Typ-Stärke). */
  household?: HouseholdInfo;
  /** Schwelle: liefert pdftotext weniger Zeichen, gilt das Dokument als
   *  Bild/Scan → es geht an `parseImage` (falls gesetzt), sonst deferred.
   *  Default 200. */
  minTextChars?: number;
  /** Override pdftotext-Binary. Default 'pdftotext'. */
  pdftotextBin?: string;
  /**
   * Injizierter OCR-/Bild-Parser. Bekommt den Dokumentpfad (Bild ODER
   * gescanntes PDF) und liefert reading-order rawText zurück. Wenn gesetzt,
   * werden Bild-/Scan-Belege INLINE im selben Lauf verarbeitet statt nur
   * deferred. Wenn nicht gesetzt, bleibt der Kern netzfrei (deferred[]).
   */
  parseImage?: (docPath: string) => Promise<string>;
  /**
   * Optional document-text cache hook. If it returns a non-null
   * `{ rawText, method }`, that text is used directly — bypassing BOTH
   * pdftotext and `parseImage`. OCR/pdftotext are deterministic per
   * document, so a content-addressed cache makes warm re-processing of a
   * case fully I/O-free (no subprocess spawn, no orchestrator round-trip).
   * `method` is preserved so household inference (text-only) behaves
   * identically to a live run.
   */
  parseDoc?: (docPath: string) => Promise<{ rawText: string; method: 'text' | 'ocr' } | null>;
}

export type Lane1BelegStatus =
  | 'mapped'           // erfolgreich Lane-1-gemapped
  | 'deferred-ocr'     // image-only → Lane 2 zuständig
  | 'unknown-typ'      // Text da, aber kein Schema matched den Titel
  | 'unknown-person';  // BelegTyp ok, aber Person nicht auflösbar

export interface Lane1BelegOutcome {
  /** Quelle: pdfPath, bei Sammel-VaSt "pdfPath#sectionN". */
  source: string;
  belegTyp: BelegTyp;
  person: Person | 'unknown';
  status: Lane1BelegStatus;
  /** Anzahl extrahierter Felder (nur bei status='mapped' > 0). */
  felder: number;
  /** Welcher Parser lieferte den Text: 'text' (pdftotext) oder 'ocr' (parseImage). */
  method: 'text' | 'ocr';
  /** Die je Dokument extrahierten Felder — für die Dokument-Detailansicht der
   *  Web-UI (Klick auf eine Beleg-Karte zeigt genau diese Felder). */
  felderListe?: { eCode: string; label: string; wert: string; person: string; anlage: string;
    /** Provenienz: Box dieses Feldes IM EIGENEN Beleg-Dokument (vom Web-Server
     *  nachgerüstet, pro Beleg gematcht — treibt die Beleg-Detailansicht). */
    prov?: { hash: string; page: number; box: [number, number, number, number] } }[];
  /** Erkanntes Steuerjahr des Belegs (Detektor; undefined wenn kein Signal). */
  dokumentJahr?: number;
  /** true = fremdjähriger Beleg (≠ VZ) → NICHT in der Berechnung, als
   *  Vorjahres-Kontext geführt (Prefill/Rückfrage). */
  vorjahr?: boolean;
}

/** MappedField[] → kompakte Web-Form für die Dokument-Detailansicht. */
function toFelderListe(felder: MappedField[]): NonNullable<Lane1BelegOutcome['felderListe']> {
  return felder.map((f) => ({
    eCode: f.eCode, label: f.pdfLabel ?? '', wert: f.wert,
    person: String(f.person), anlage: f.anlage ?? '',
  }));
}

/** Beträge (aufsummierbar) vs. stabile Stammdaten — steuert prefill vs. frage. */
const AMOUNT_TYPES = new Set<ValueType>(['int_euro', 'decimal_eur_cent']);
const fieldKey = (f: { anlage?: string; kontextSubpath?: string; eCode: string; person: Person }): string =>
  `${f.anlage ?? ''}|${f.kontextSubpath ?? ''}|${f.eCode}|${f.person}`;

/**
 * Klassifiziert die fremdjährigen Felder gegen das aktuelle Aggregat:
 *   schon im aktuellen Jahr vorhanden  → 'vorhanden' (reiner Kontext)
 *   fehlt + Betrag                     → 'frage'   (nachfragen, NICHT übernehmen)
 *   fehlt + Stammdatum                 → 'prefill' (zum Übernehmen anbieten)
 */
function buildVorjahr(
  sections: Array<{ source: string; belegTyp: BelegTyp; person: Person; jahr: number; confidence: JahrConfidence; felder: MappedField[] }>,
  aktuell: MappedField[],
): Lane1Vorjahr | undefined {
  if (!sections.length) return undefined;
  const curKeys = new Set(aktuell.map(fieldKey));
  const felder: VorjahrFeld[] = [];
  for (const s of sections) {
    for (const f of s.felder) {
      const vorhandenAktuell = curKeys.has(fieldKey(f));
      const kind: VorjahrFeld['kind'] = vorhandenAktuell
        ? 'vorhanden'
        : AMOUNT_TYPES.has(f.valueType) ? 'frage' : 'prefill';
      felder.push({
        eCode: f.eCode, anlage: f.anlage ?? '', kontextSubpath: f.kontextSubpath,
        person: f.person, wert: f.wert, pdfLabel: f.pdfLabel ?? '', valueType: f.valueType,
        dokumentJahr: s.jahr, kind, vorhandenAktuell,
      });
    }
  }
  const jahre = [...new Set(sections.map((s) => s.jahr))];
  return {
    jahr: jahre.length === 1 ? jahre[0] : null,
    belege: sections.map((s) => ({ source: s.source, belegTyp: s.belegTyp, jahr: s.jahr, confidence: s.confidence, felder: s.felder.length })),
    felder,
  };
}

export interface Lane1Deferred {
  source: string;
  reason: string;
  /** Welcher Lane gehört die Weiterverarbeitung? */
  route: 'lane2-ocr' | 'hitl';
}

/** Ein fremdjähriges Feld, klassifiziert nach Verwertung im aktuellen VZ. */
export interface VorjahrFeld {
  eCode: string;
  anlage: string;
  kontextSubpath?: string;
  person: Person;
  wert: string;
  pdfLabel: string;
  valueType: ValueType;
  /** Jahr des Belegs, aus dem dieses Feld stammt. */
  dokumentJahr: number;
  /**
   * prefill   — stabiles Stammdatum (IdNr, Konfession, IBAN, Geburtsdatum …),
   *             im aktuellen Jahr NICHT vorhanden → zum Übernehmen anbieten.
   * frage     — Betrag (int_euro/decimal), im aktuellen Jahr NICHT vorhanden →
   *             nachfragen; Wert NIE automatisch in die Berechnung übernehmen.
   * vorhanden — im aktuellen Jahr bereits belegt → reiner Kontext.
   */
  kind: 'prefill' | 'frage' | 'vorhanden';
  vorhandenAktuell: boolean;
}

/** Vorjahres-Kontext: fremdjährige Belege/Felder, NIE Teil der Berechnung. */
export interface Lane1Vorjahr {
  /** Einheitliches Vorjahr, null wenn mehrere verschiedene Jahre. */
  jahr: number | null;
  belege: Array<{ source: string; belegTyp: BelegTyp; jahr: number; confidence: JahrConfidence; felder: number }>;
  felder: VorjahrFeld[];
}

export interface Lane1Result {
  /** Pro Beleg/Section ein Outcome. */
  belege: Lane1BelegOutcome[];
  /** Inferiertes (oder übergebenes) Household. */
  household: HouseholdInfo;
  /** Aggregierte Felder über ALLE erfolgreich gemappten Belege. */
  aggregated: MappedField[];
  /** Catalog-Constraint-Validierung des Aggregats. */
  validation: ValidationReport;
  /** Submittable E10-XML — nur gesetzt wenn validation.ready === true. */
  xml: string | null;
  /** Belege die NICHT verarbeitet werden konnten (→ OCR-Parser fehlt / HiTL). */
  deferred: Lane1Deferred[];
  /** Feld-Keys (`eCode|person`), die aus OCR-Belegen stammen — für die
   *  Herkunfts-Markierung (text vs. ocr) im Report/JSON. */
  ocrFields: string[];
  warnings: string[];
  /** Fremdjährige Belege/Felder (≠ VZ) — NIE Teil von aggregated/xml/calc;
   *  Quelle für Prefill + gezielte Rückfragen. undefined wenn keine. */
  vorjahr?: Lane1Vorjahr;
  /** Kompakte Statistik für Logging/Monitoring. */
  stats: {
    pdfs: number;
    sections: number;
    mapped: number;
    deferred: number;
    felderRaw: number;
    felderAggregated: number;
    vorjahrFelder: number;
    xmlBytes: number;
  };
}

// ─── interne Helfer ───────────────────────────────────────────────────────

function extractText(pdfPath: string, bin: string): string {
  try {
    return execFileSync(bin, ['-layout', pdfPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

interface CollectedSection {
  source: string;
  text: string;
  /** true wenn weder pdftotext noch parseImage verwertbaren Text lieferte. */
  ocrRequired: boolean;
  /** Welcher Parser lieferte den Text. */
  method: 'text' | 'ocr';
}

// ─── Public Entry ──────────────────────────────────────────────────────────

/**
 * DER Lane-1-Endpoint. Ein Steuerfall (1..N PDFs) → ein E10-XML.
 *
 * @param pdfPaths  Liste von PDF-Pfaden (Einzelbelege und/oder Sammel-VaSt).
 * @param opts      vz + pool sind Pflicht; household optional (sonst inferiert).
 */
export async function runLane1(
  pdfPaths: string[],
  opts: Lane1Options,
): Promise<Lane1Result> {
  const warnings: string[] = [];
  const minTextChars = opts.minTextChars ?? 200;
  const pdftotextBin = opts.pdftotextBin ?? 'pdftotext';

  // ── 1. Dokumente → Text (Parser je Typ). OCR läuft NEBENLÄUFIG ────────
  //   PDF mit Text → pdftotext (sync);  Bild/Scan → injizierter parseImage().
  //   Alle parseImage-Calls werden parallel gefeuert (Promise.all), nicht
  //   seriell — der Engpass OCR skaliert so über die Dokumente.
  interface DocText {
    docPath: string; rawText: string; method: 'text' | 'ocr';
    ocrRequired: boolean; missing?: boolean; error?: string;
  }
  const docTexts: DocText[] = await Promise.all(pdfPaths.map(async (docPath): Promise<DocText> => {
    if (!existsSync(docPath)) return { docPath, rawText: '', method: 'text', ocrRequired: false, missing: true };
    // Document-text cache hook (warm path): a cache hit skips pdftotext +
    // OCR entirely, preserving the original text|ocr method.
    if (opts.parseDoc) {
      const cached = await opts.parseDoc(docPath);
      if (cached) return { docPath, rawText: cached.rawText, method: cached.method, ocrRequired: false };
    }
    const isImage = IMAGE_EXT.has(extname(docPath).toLowerCase());
    const rawText = isImage ? '' : extractText(docPath, pdftotextBin);
    if (rawText.length >= minTextChars) return { docPath, rawText, method: 'text', ocrRequired: false };
    if (opts.parseImage) {
      try { return { docPath, rawText: await opts.parseImage(docPath), method: 'ocr', ocrRequired: false }; }
      catch (err) { return { docPath, rawText: '', method: 'ocr', ocrRequired: true, error: (err as Error).message }; }
    }
    return { docPath, rawText, method: 'text', ocrRequired: true };
  }));

  // Reihenfolge erhalten, splitten, Warnings sammeln (deterministisch, seriell).
  const collected: CollectedSection[] = [];
  for (const d of docTexts) {
    if (d.missing) { warnings.push(`Datei nicht gefunden, übersprungen: ${d.docPath}`); continue; }
    if (d.ocrRequired) {
      if (d.error) warnings.push(`OCR-Parser fehlgeschlagen (${d.docPath}): ${d.error}`);
      collected.push({ source: d.docPath, text: '', ocrRequired: true, method: d.method });
      continue;
    }
    // Sammel-VaSt: in Sections splitten. Single-Beleg / Bild → 1 Section.
    const sections = splitVastText(d.rawText);
    if (sections.length === 1) {
      collected.push({ source: d.docPath, text: sections[0].text, ocrRequired: false, method: d.method });
    } else {
      for (const sec of sections) {
        collected.push({ source: `${d.docPath}#section${sec.index}`, text: sec.text, ocrRequired: false, method: d.method });
      }
    }
  }

  // ── 2. Household inferieren — NUR aus Digital-Text-VaSt (IdNr-Häufigkeit).
  //   Gescannte Bank-Belege (method='ocr') tragen keine Steuer-IdNr und
  //   würden die Inferenz nur mit Bank-/Adress-Tokens stören; deren Person
  //   wird unten per Gläubiger-Name aufgelöst.
  const textSections = collected
    .filter((c) => !c.ocrRequired && c.method === 'text')
    .map((c, i) => ({ index: i, text: c.text, chars: c.text.length, uebernommen: true }));
  let household: HouseholdInfo;
  let hhResolution: HouseholdResolution | null = null;
  if (opts.household) {
    household = opts.household;
  } else {
    hhResolution = inferHousehold(textSections);
    household = hhResolution.household;
    warnings.push(...hhResolution.warnings);
  }

  // ── 3. Pro Section: detect + person + mapBeleg (text & ocr identisch) ──
  const belege: Lane1BelegOutcome[] = [];
  const deferred: Lane1Deferred[] = [];
  const mappingResults: MappingResult[] = [];
  const vorjahrSections: Array<{ source: string; belegTyp: BelegTyp; person: Person; jahr: number; confidence: JahrConfidence; felder: MappedField[] }> = [];
  const ocrFieldKeys = new Set<string>();

  /** Gate: gehört der Beleg (Jahr j) in die VZ-Berechnung — oder als Vorjahres-
   *  Kontext raus? high & abweichend → raus. low & abweichend → bei Voll-
   *  Erklärungen (Bulk, hohe Wirkung) sicherheitshalber raus + Rückfrage; bei
   *  Einzelbelegen drin (nur Warnung, sonst Datenverlust). kein/VZ-Jahr → drin. */
  const gateVorjahr = (j: DokumentJahr, typ: BelegTyp): { raus: boolean; rueckfrage: boolean } => {
    if (j.jahr == null || j.jahr === opts.vz) return { raus: false, rueckfrage: false };
    if (j.confidence === 'high') return { raus: true, rueckfrage: false };
    if (typ === 'Einkommensteuererklaerung') return { raus: true, rueckfrage: true };
    return { raus: false, rueckfrage: true };
  };
  let vordruckMap: VordruckMap | null = null; // lazy — nur wenn eine Voll-Erklärung auftaucht

  /** Person B aus einem Beleg lernen, wenn die VaSt nur ihre IdNr kannte. */
  const learnPersonB = (learned?: { vorname: string; nachname: string }) => {
    if (learned && !household.personB?.vorname) {
      household.personB = { ...(household.personB ?? {}), vorname: learned.vorname, nachname: learned.nachname };
    }
  };

  for (const c of collected) {
    if (c.ocrRequired) {
      belege.push({
        source: c.source, belegTyp: 'Unbekannt', person: 'unknown',
        status: 'deferred-ocr', felder: 0, method: c.method,
      });
      deferred.push({
        source: c.source,
        reason: opts.parseImage
          ? 'OCR-Parser lieferte keinen verwertbaren Text'
          : `pdftotext < ${minTextChars} Zeichen, kein OCR-Parser injiziert — image-only`,
        route: 'lane2-ocr',
      });
      continue;
    }
    // Belegjahr erkennen — fremdjährige Belege (≠ VZ) dürfen NICHT in die
    // Berechnung; sie würden im aggregate() auf die VZ-Werte aufsummiert
    // (z.B. Bruttoarbeitslohn 2023 + 2024). Stattdessen Vorjahres-Kontext.
    const jr = detectDokumentJahr(c.text, c.source);

    // Ganze ausgefüllte Erklärung (multi-Anlage Druck) → Vordruckzeile-Anker
    // statt Einzel-Beleg-Schema. Felder tragen Person je E-Code/Section.
    if (isFilledReturn(c.text)) {
      if (!vordruckMap) vordruckMap = await loadVordruckMap(opts.pool, opts.vz);
      const { felder } = extractByVordruckzeile(c.text, vordruckMap);
      const gate = gateVorjahr(jr, 'Einkommensteuererklaerung');
      if (gate.raus) {
        // Vorjahres-Erklärung: NICHT in die Berechnung (sonst Aufsummierung auf
        // die VZ-Werte). Als Vorjahres-Kontext (Prefill/Rückfrage) bereitstellen.
        vorjahrSections.push({ source: c.source, belegTyp: 'Einkommensteuererklaerung', person: 'A', jahr: jr.jahr!, confidence: jr.confidence, felder });
        belege.push({
          source: c.source, belegTyp: 'Einkommensteuererklaerung', person: 'A',
          status: 'mapped', felder: felder.length, method: c.method,
          felderListe: toFelderListe(felder), dokumentJahr: jr.jahr!, vorjahr: true,
        });
        warnings.push(
          `Vorjahres-Erklärung erkannt (${c.source}, Jahr ${jr.jahr} ≠ VZ ${opts.vz})` +
          `${gate.rueckfrage ? ' — Jahr bitte bestätigen' : ''} → NICHT in die Berechnung übernommen; ` +
          `${felder.length} Felder als Vorjahres-Kontext (Prefill/Rückfrage) bereitgestellt.`,
        );
        continue;
      }
      mappingResults.push({
        belegTyp: 'Einkommensteuererklaerung', person: 'A',
        felder, missingExpected: [], unmatched: [], warnings: [],
      });
      if (c.method === 'ocr') for (const f of felder) ocrFieldKeys.add(`${f.eCode}|${f.person}`);
      belege.push({
        source: c.source, belegTyp: 'Einkommensteuererklaerung', person: 'A',
        status: 'mapped', felder: felder.length, method: c.method,
        felderListe: toFelderListe(felder), dokumentJahr: jr.jahr ?? undefined,
      });
      if (jr.jahr == null)
        warnings.push(
          `Voll-Erklärung erkannt (${c.source}) → Vordruckzeile-Extraktor: ${felder.length} Felder. ` +
          `⚠ Steuerjahr nicht erkannt — als VZ ${opts.vz} angenommen.`,
        );
      continue;
    }

    const belegTyp = detectBelegTyp(c.text);
    if (belegTyp === 'Unbekannt') {
      belege.push({
        source: c.source, belegTyp, person: 'unknown',
        status: 'unknown-typ', felder: 0, method: c.method,
      });
      deferred.push({
        source: c.source,
        reason: 'Text vorhanden, aber kein Schema-Titel-Pattern matched',
        route: 'hitl',
      });
      continue;
    }

    // Person-Auflösung — gleicher Beleg, je nach Quelle anderes Signal:
    //   OCR-Belege (Bank): Gläubiger-Name (resolvePersonByName, Default A).
    //   Text-VaSt: IdNr/Vorname (resolvePersonForSection) + Name-Fallback.
    let person: Person | 'unknown';
    if (c.method === 'ocr') {
      const pr = resolvePersonByName(c.text, household);
      person = pr.person;
      learnPersonB(pr.learned);
    } else {
      person = resolvePersonForSection(
        { index: 0, text: c.text, chars: c.text.length, uebernommen: true },
        household,
      );
      if (person === 'unknown') {
        const pr = resolvePersonByName(c.text, household);
        if (pr.matched) { person = pr.person; learnPersonB(pr.learned); }
      }
    }
    if (person === 'unknown') {
      belege.push({
        source: c.source, belegTyp, person: 'unknown',
        status: 'unknown-person', felder: 0, method: c.method,
      });
      deferred.push({
        source: c.source,
        reason: 'BelegTyp erkannt, aber Person (A/B) nicht auflösbar',
        route: 'hitl',
      });
      continue;
    }

    const input: BelegInput = {
      belegTyp, person, rawText: c.text, source: { pdfPath: c.source },
    };
    const r = mapBeleg(input);
    const gate = gateVorjahr(jr, belegTyp);
    if (gate.raus) {
      // Fremdjähriger Einzelbeleg (z.B. Vorjahres-Lohnsteuerbescheinigung):
      // aus der Berechnung halten, als Vorjahres-Kontext führen.
      vorjahrSections.push({ source: c.source, belegTyp, person, jahr: jr.jahr!, confidence: jr.confidence, felder: r.felder });
      belege.push({
        source: c.source, belegTyp, person,
        status: 'mapped', felder: r.felder.length, method: c.method,
        felderListe: toFelderListe(r.felder), dokumentJahr: jr.jahr!, vorjahr: true,
      });
      warnings.push(
        `Vorjahres-Beleg erkannt (${c.source}, ${belegTyp}, Jahr ${jr.jahr} ≠ VZ ${opts.vz}) → ` +
        `NICHT in die Berechnung übernommen; als Vorjahres-Kontext geführt.`,
      );
      continue;
    }
    mappingResults.push(r);
    if (c.method === 'ocr') {
      for (const f of r.felder) ocrFieldKeys.add(`${f.eCode}|${f.person}`);
    }
    if (gate.rueckfrage)
      warnings.push(`Belegjahr unklar (${c.source}, Tipp ${jr.jahr} ≠ VZ ${opts.vz}) — als VZ behandelt; bitte prüfen.`);
    belege.push({
      source: c.source, belegTyp, person,
      status: 'mapped', felder: r.felder.length, method: c.method,
      felderListe: toFelderListe(r.felder), dokumentJahr: jr.jahr ?? undefined,
    });
  }

  // ── 4. Aggregieren (Text- + OCR-Felder gemeinsam) ─────────────────────
  //   NUR aktuelle-VZ-Felder: fremdjährige Sections sind bereits in
  //   vorjahrSections abgezweigt und erreichen aggregate()/xml/calc nie.
  const felderRaw = mappingResults.reduce((s, r) => s + r.felder.length, 0);
  const aggregated = aggregate(mappingResults);

  // ── 4b. Vorjahres-Kontext klassifizieren (prefill vs. frage) gegen das
  //   aktuelle Aggregat. Diese Felder fließen NIE in Bescheid/XML. ─────────
  const vorjahr = buildVorjahr(vorjahrSections, aggregated);

  // ── 5. Pre-Validate ─────────────────────────────────────────────────────
  const validation = await preValidate(aggregated, { pool: opts.pool, vz: opts.vz });

  // ── 6. XML bauen (nur wenn ready) ───────────────────────────────────────
  let xml: string | null = null;
  if (validation.ready && aggregated.length > 0) {
    const out = await buildE10XML(aggregated, { vz: opts.vz, pool: opts.pool });
    xml = out.xml;
    for (const w of out.warnings) {
      warnings.push(`xml-gen ${w.eCode}: ${w.reason}`);
    }
  } else if (!validation.ready) {
    warnings.push(
      `XML nicht gebaut — Pre-Validation hat ${validation.errorCount} error(s).`,
    );
  }

  return {
    belege,
    household,
    aggregated,
    validation,
    xml,
    deferred,
    ocrFields: [...ocrFieldKeys],
    warnings,
    vorjahr,
    stats: {
      pdfs: pdfPaths.length,
      sections: collected.length,
      mapped: belege.filter((b) => b.status === 'mapped').length,
      deferred: deferred.length,
      felderRaw,
      felderAggregated: aggregated.length,
      vorjahrFelder: vorjahr?.felder.length ?? 0,
      xmlBytes: xml?.length ?? 0,
    },
  };
}
