/**
 * lane1 — DER konsolidierte deterministische Extraktions-Pfad.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  Lane 1 = "Digital-Text-VaSt → submittable E10-XML, deterministisch."
 * ════════════════════════════════════════════════════════════════════════
 *
 * Das ist der EINZIGE benannte Eingang für Lane 1. Wer Lane 1 will, ruft
 * `runLane1()`. Kein Script verdrahtet die Kette mehr selbst.
 *
 * Abgrenzung zu anderen Prozessen (damit nichts verwechselt wird):
 *
 *   Lane 1 (DIESES Modul)
 *     • Input:  digital-text VaSt-PDF(s) — pdftotext liefert echten Text
 *     • Engine: deterministisches Schema-Mapping gegen Postgres-Catalog
 *     • Kein OCR, kein LLM, kein Netzwerk außer dem lokalen Postgres
 *     • Output: aggregierte MappedField[] + schema-valides E10-XML
 *
 *   Lane 2  (mapper-from-tagged.ts + ocr-ensemble-client.ts)
 *     • Input:  image-only PDF(s) — pdftotext liefert ~nichts
 *     • Engine: tornado-orchestrator OCR + semantic overlay → spatial map
 *     • Wird von Lane 1 NUR identifiziert (deferred[]), nie ausgeführt.
 *
 *   Tornado /api/v1/extract  (Rust, crates/orchestrator)
 *     • komplett separater Rust-Stack, Phasen 0-4, eigenes Windowing.
 *     • Lane 1 ruft NUR /api/v1/ocr-ensemble (Phasen 0-2b) — und auch das
 *       nur indirekt über Lane 2.
 *
 * Granularität: ganzer Steuerfall. runLane1(pdfPaths[]) nimmt 1..N PDFs
 * (Einzelbelege ODER Sammel-VaSt mit mehreren Sections), splittet,
 * inferiert Household (Person A/B), aggregiert über alles, baut EIN
 * E10-XML. "Fall rein, XML raus."
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type pg from 'pg';

import { mapBeleg, aggregate, detectBelegTyp } from './field-mapper/mapper.ts';
import { preValidate } from './field-mapper/pre-validate.ts';
import type { ValidationReport } from './field-mapper/pre-validate.ts';
import { buildE10XML } from './field-mapper/e10-xml.ts';
import {
  splitVastText,
  inferHousehold,
  resolvePersonForSection,
} from './field-mapper/vast-splitter.ts';
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
  /** Schwelle: PDF mit weniger Zeichen aus pdftotext → ocr-required
   *  (wird als deferred markiert, nicht von Lane 1 verarbeitet). Default 200. */
  minTextChars?: number;
  /** Override pdftotext-Binary. Default 'pdftotext'. */
  pdftotextBin?: string;
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
  /** Belege die Lane 1 NICHT verarbeiten konnte (→ Lane 2 / HiTL). */
  deferred: Lane1Deferred[];
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
  /** true wenn das PDF als ganzes zu wenig Text hatte → ocr-required. */
  ocrRequired: boolean;
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

  // ── 1. PDFs → Text → Sections sammeln ─────────────────────────────────
  const collected: CollectedSection[] = [];
  for (const pdfPath of pdfPaths) {
    if (!existsSync(pdfPath)) {
      warnings.push(`PDF nicht gefunden, übersprungen: ${pdfPath}`);
      continue;
    }
    const rawText = extractText(pdfPath, pdftotextBin);
    if (rawText.length < minTextChars) {
      // ganzes PDF ist image-only → eine deferred-Section
      collected.push({ source: pdfPath, text: rawText, ocrRequired: true });
      continue;
    }
    // Sammel-VaSt: in Sections splitten. Single-Beleg → 1 Section.
    const sections = splitVastText(rawText);
    if (sections.length === 1) {
      collected.push({ source: pdfPath, text: sections[0].text, ocrRequired: false });
    } else {
      for (const sec of sections) {
        collected.push({
          source: `${pdfPath}#section${sec.index}`,
          text: sec.text,
          ocrRequired: false,
        });
      }
    }
  }

  // ── 2. Household inferieren (über alle text-Sections) ─────────────────
  const textSections = collected
    .filter((c) => !c.ocrRequired)
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

  // ── 3. Pro Section: detect + person + mapBeleg ────────────────────────
  const belege: Lane1BelegOutcome[] = [];
  const deferred: Lane1Deferred[] = [];
  const mappingResults: MappingResult[] = [];

  for (const c of collected) {
    if (c.ocrRequired) {
      belege.push({
        source: c.source, belegTyp: 'Unbekannt', person: 'unknown',
        status: 'deferred-ocr', felder: 0,
      });
      deferred.push({
        source: c.source,
        reason: `pdftotext < ${minTextChars} Zeichen — image-only PDF`,
        route: 'lane2-ocr',
      });
      continue;
    }
    const belegTyp = detectBelegTyp(c.text);
    if (belegTyp === 'Unbekannt') {
      belege.push({
        source: c.source, belegTyp, person: 'unknown',
        status: 'unknown-typ', felder: 0,
      });
      deferred.push({
        source: c.source,
        reason: 'Text vorhanden, aber kein Schema-Titel-Pattern matched',
        route: 'hitl',
      });
      continue;
    }
    const person = resolvePersonForSection(
      { index: 0, text: c.text, chars: c.text.length, uebernommen: true },
      household,
    );
    if (person === 'unknown') {
      belege.push({
        source: c.source, belegTyp, person: 'unknown',
        status: 'unknown-person', felder: 0,
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
    belege.push({
      source: c.source, belegTyp, person,
      status: 'mapped', felder: r.felder.length,
    });
  }

  // ── 4. Aggregieren ─────────────────────────────────────────────────────
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
