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
}

/** MappedField[] → kompakte Web-Form für die Dokument-Detailansicht. */
function toFelderListe(felder: MappedField[]): NonNullable<Lane1BelegOutcome['felderListe']> {
  return felder.map((f) => ({
    eCode: f.eCode, label: f.pdfLabel ?? '', wert: f.wert,
    person: String(f.person), anlage: f.anlage ?? '',
  }));
}

export interface Lane1Deferred {
  source: string;
  reason: string;
  /** Welcher Lane gehört die Weiterverarbeitung? */
  route: 'lane2-ocr' | 'hitl';
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
  /** Kompakte Statistik für Logging/Monitoring. */
  stats: {
    pdfs: number;
    sections: number;
    mapped: number;
    deferred: number;
    felderRaw: number;
    felderAggregated: number;
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
  const ocrFieldKeys = new Set<string>();
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
    // Ganze ausgefüllte Erklärung (multi-Anlage Druck) → Vordruckzeile-Anker
    // statt Einzel-Beleg-Schema. Felder tragen Person je E-Code/Section.
    if (isFilledReturn(c.text)) {
      if (!vordruckMap) vordruckMap = await loadVordruckMap(opts.pool, opts.vz);
      const { felder } = extractByVordruckzeile(c.text, vordruckMap);
      mappingResults.push({
        belegTyp: 'Einkommensteuererklaerung', person: 'A',
        felder, missingExpected: [], unmatched: [], warnings: [],
      });
      if (c.method === 'ocr') for (const f of felder) ocrFieldKeys.add(`${f.eCode}|${f.person}`);
      belege.push({
        source: c.source, belegTyp: 'Einkommensteuererklaerung', person: 'A',
        status: 'mapped', felder: felder.length, method: c.method,
        felderListe: toFelderListe(felder),
      });
      warnings.push(
        `Voll-Erklärung erkannt (${c.source}) → Vordruckzeile-Extraktor: ${felder.length} Felder. ` +
        `⚠ VZ/Steuerjahr prüfen — der Druck kann ein anderes Jahr betreffen als die Belege.`,
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
    mappingResults.push(r);
    if (c.method === 'ocr') {
      for (const f of r.felder) ocrFieldKeys.add(`${f.eCode}|${f.person}`);
    }
    belege.push({
      source: c.source, belegTyp, person,
      status: 'mapped', felder: r.felder.length, method: c.method,
      felderListe: toFelderListe(r.felder),
    });
  }

  // ── 4. Aggregieren (Text- + OCR-Felder gemeinsam) ─────────────────────
  const felderRaw = mappingResults.reduce((s, r) => s + r.felder.length, 0);
  const aggregated = aggregate(mappingResults);

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
    stats: {
      pdfs: pdfPaths.length,
      sections: collected.length,
      mapped: belege.filter((b) => b.status === 'mapped').length,
      deferred: deferred.length,
      felderRaw,
      felderAggregated: aggregated.length,
      xmlBytes: xml?.length ?? 0,
    },
  };
}
