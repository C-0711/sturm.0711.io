#!/usr/bin/env -S npx tsx
/**
 * run-steuerfall — DER "alles in einer Reihe"-Endpoint für einen ganzen
 * Steuerfall. Lane 1 + Lane 2 + Merge in EINEM Lauf.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  Problem das das löst:
 *    runLane1() liest nur Digital-Text-PDFs (VaSt). Gescannte Belege
 *    (Foto/JPG/Scan einer Bank-Steuerbescheinigung) liefern via pdftotext
 *    ~nichts → Lane 1 markiert sie nur als deferred:lane2-ocr, verarbeitet
 *    sie aber NIE. Damit fehlt "wirklich alle Information".
 *
 *  Was dieser Driver tut (in einer Reihe):
 *    1. Bilder (jpg/png/tiff) → temporäre 1-Seiten-PDFs (sips).
 *    2. Lane 1 über ALLE PDFs (Text-VaSt liefert Felder + Household;
 *       die Bild-PDFs fallen automatisch in deferred:lane2-ocr).
 *    3. Lane 2 über JEDEN deferred:lane2-ocr-Beleg:
 *         PDF-Bytes → tornado /api/v1/ocr-ensemble (OCR + Semantic-Overlay)
 *         → classifyFromTagged (BelegTyp) → mapBelegFromTagged (Felder).
 *    4. Merge: aggregate([Lane1-Aggregat, ...Lane2-Resultate]).
 *         Numerische Felder summieren über Belege; Person-Dedup über
 *         (anlage|kontext|eCode|person).
 *    5. Pre-Validate → E10-XML (nur wenn ready) → optional Kennzahl.
 *    6. Report: pro Doc Lane+Felder, Merge-Total, Lane-2-Zusatz, HiTL-Rest.
 *
 * Aufruf:
 *   ELSTER_CATALOG_PG_URL=postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog \
 *   TORNADO_ORCHESTRATOR_URL=http://127.0.0.1:7180 \
 *     npx tsx scripts/run-steuerfall.ts [--vz 2024] [--out fall.xml] [--kennzahl] <doc...>
 *
 * Flags:
 *   --vz <jahr>          Veranlagungszeitraum (default 2024)
 *   --out <pfad>         XML-Output (default <erste-pdf-basename>.e10.xml)
 *   --kennzahl           ERiC-Adressierung (E-Code → Sachbereich.Kennzahl)
 *   --orchestrator <url> Override TORNADO_ORCHESTRATOR_URL
 *   --json               Strukturierte Ausgabe statt Report
 *   --min-score <0..1>   Lane-2 Top-1-Candidate-Schwelle (default 0.5)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import { runLane1 } from '../src/workflows/elster/lib/lane1.ts';
import { aggregate, mapBeleg, detectBelegTyp } from '../src/workflows/elster/lib/field-mapper/mapper.ts';
import { ocrEnsembleToRawText } from '../src/workflows/elster/lib/field-mapper/lane2-adapter.ts';
import {
  ocrEnsembleFromPath,
  pingOrchestrator,
} from '../src/workflows/elster/lib/field-mapper/ocr-ensemble-client.ts';
import { preValidate } from '../src/workflows/elster/lib/field-mapper/pre-validate.ts';
import { buildE10XML } from '../src/workflows/elster/lib/field-mapper/e10-xml.ts';
import {
  annotateWithKennzahl,
  formatKennzahl,
} from '../src/workflows/elster/lib/field-mapper/kennzahl-bridge.ts';
import type {
  BelegTyp,
  MappedField,
  MappingResult,
  Person,
} from '../src/workflows/elster/lib/field-mapper/types.ts';
import type { HouseholdInfo } from '../src/workflows/elster/lib/field-mapper/triage.ts';

const { Pool } = pg;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.gif']);

interface Lane2Doc {
  source: string;          // Originalpfad (Bild oder PDF)
  pdfPath: string;         // (ggf. konvertiertes) PDF, das an OCR geht
  belegTyp: BelegTyp;
  person: Person;
  ocrRecords: number;      // consensus records gesamt
  taggedRecords: number;   // records mit ≥1 Kandidat
  felder: number;          // Lane-2 gemappte Felder
  status: 'mapped' | 'no-tags' | 'unknown-typ' | 'error';
  detail?: string;
}

function parseArgs(argv: string[]) {
  const docs: string[] = [];
  let vz = 2024, out: string | null = null, orchestrator: string | null = null;
  let kennzahl = false, json = false, minScore = 0.5;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vz') vz = Number(argv[++i]);
    else if (a === '--out') out = argv[++i];
    else if (a === '--orchestrator') orchestrator = argv[++i];
    else if (a === '--min-score') minScore = Number(argv[++i]);
    else if (a === '--kennzahl') kennzahl = true;
    else if (a === '--json') json = true;
    else if (a.startsWith('--')) { console.error(`Unbekanntes Flag: ${a}`); process.exit(4); }
    else docs.push(a);
  }
  return { docs, vz, out, orchestrator, kennzahl, json, minScore };
}

/**
 * Bild → temporäres 1-Seiten-PDF (image-only, kein Text-Layer → Lane 2).
 * Cross-platform: sips (macOS) → img2pdf → ImageMagick → Python/Pillow.
 * H200V (Linux) hat kein sips, aber python3+PIL — daher der Fallback.
 */
function imageToPdf(imgPath: string, workDir: string): string {
  const pdfPath = join(workDir, basename(imgPath).replace(/\.[^.]+$/, '') + '.pdf');
  const pyScript = `from PIL import Image; Image.open(${JSON.stringify(imgPath)}).convert("RGB").save(${JSON.stringify(pdfPath)}, "PDF")`;
  const attempts: Array<[string, string[]]> = [
    ['sips', ['-s', 'format', 'pdf', imgPath, '--out', pdfPath]],
    ['img2pdf', [imgPath, '-o', pdfPath]],
    ['magick', [imgPath, pdfPath]],
    ['convert', [imgPath, pdfPath]],
    ['python3', ['-c', pyScript]],
  ];
  let lastErr: unknown;
  for (const [bin, args] of attempts) {
    try {
      execFileSync(bin, args, { stdio: 'pipe' });
      if (existsSync(pdfPath)) return pdfPath;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Bild→PDF fehlgeschlagen für ${basename(imgPath)} (kein sips/img2pdf/magick/convert/PIL): ${(lastErr as Error)?.message ?? ''}`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Person-Attribution für einen Lane-2-Beleg über den GLÄUBIGER-Namen.
 * Bank-Belege drucken den Konto-Inhaber ("Für (Gläubiger) Maria Ute Stricker").
 * Da die VaSt für Person B oft nur die IdNr (keinen Namen) liefert, wird der
 * Vorname am Haushalts-Nachnamen erkannt und ggf. als Person B GELERNT:
 *   - Steuer-IdNr im Beleg → eindeutiges A/B-Match (falls vorhanden)
 *   - Vorname == personA.vorname → A;  == personB.vorname → B
 *   - anderer Vorname + Haushalts-Nachname → B (Name wird zurückgegeben)
 *   - sonst → A (Default Hauptperson)
 */
function resolvePersonByName(
  rawText: string,
  household: HouseholdInfo,
): { person: Person; learned?: { vorname: string; nachname: string } } {
  const a = household.personA;
  const b = household.personB;
  // (1) Steuer-IdNr-Match (selten auf Bank-Belegen, aber eindeutig)
  const compact = rawText.replace(/\s+/g, '');
  if (b?.idnr && compact.includes(b.idnr.replace(/\s+/g, ''))) return { person: 'B' };
  if (a?.idnr && compact.includes(a.idnr.replace(/\s+/g, ''))) return { person: 'A' };
  // (2) Gläubiger-Vorname am Haushalts-Nachnamen.
  const surname = a?.nachname ?? b?.nachname;
  if (!surname) return { person: 'A' };
  const first = (s?: string) => s?.trim().split(/\s+/)[0]?.toLowerCase();
  const aFirst = first(a?.vorname);
  const bFirst = first(b?.vorname);
  // "<Vorname[ Zweitname]> <Nachname>" — NUR auf EINER Zeile ([^\S\n] = WS
  // ohne Newline), Titlecase-Tokens; sonst zieht \s+ über Zeilenumbrüche
  // Adress-/Stadt-Tokens ("…Mainz\nHerrn Rainer Stricker") in den Namen.
  const re = new RegExp(`([A-ZÄÖÜ][a-zäöüß]+(?:[^\\S\\n]+[A-ZÄÖÜ][a-zäöüß]+){0,2})[^\\S\\n]+${escapeRe(surname)}`, 'gu');
  const givens: string[] = [];
  for (const mm of rawText.matchAll(re)) {
    const gv = mm[1].replace(/^(Herrn?|Frau|Fräulein|An)\b[^\S\n]*/i, '').trim();
    if (gv) givens.push(gv);
  }
  // (a) Bekannter Vorname gewinnt (zuverlässigstes Signal).
  for (const gv of givens) {
    const gf = first(gv);
    if (aFirst && gf === aFirst) return { person: 'A' };
    if (bFirst && gf === bFirst) return { person: 'B' };
  }
  // (b) Unbekannter Vorname + Haushalts-Nachname → Person B (Name lernen).
  for (const gv of givens) {
    const gf = first(gv);
    if (gf && aFirst && gf !== aFirst) {
      return { person: 'B', learned: { vorname: gv, nachname: surname } };
    }
  }
  return { person: 'A' };
}

async function main(): Promise<void> {
  const { docs, vz, out, orchestrator, kennzahl, json, minScore } = parseArgs(process.argv.slice(2));
  if (docs.length === 0) {
    console.error('Usage: run-steuerfall [--vz 2024] [--out fall.xml] [--kennzahl] <doc...>');
    process.exit(1);
  }
  const baseUrl = orchestrator ?? process.env.TORNADO_ORCHESTRATOR_URL ?? 'http://127.0.0.1:7180';
  const url = process.env.ELSTER_CATALOG_PG_URL ?? 'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
  const pool = new Pool({ connectionString: url, max: 4 });

  const workDir = mkdtempSync(join(tmpdir(), 'steuerfall-'));
  const warnings: string[] = [];

  // ── 0. Bilder → PDFs; Map (konvertiertes PDF → Originalname) ───────────
  const pdfPaths: string[] = [];
  const originOf = new Map<string, string>();
  for (const d of docs) {
    if (!existsSync(d)) { warnings.push(`Datei nicht gefunden: ${d}`); continue; }
    if (IMAGE_EXT.has(extname(d).toLowerCase())) {
      try {
        const pdf = imageToPdf(d, workDir);
        pdfPaths.push(pdf);
        originOf.set(pdf, d);
      } catch (e) {
        warnings.push(`Bild→PDF fehlgeschlagen (${basename(d)}): ${(e as Error).message}`);
      }
    } else {
      pdfPaths.push(d);
      originOf.set(d, d);
    }
  }

  // ── 1. Lane 1 über alle PDFs ───────────────────────────────────────────
  const lane1 = await runLane1(pdfPaths, { vz, pool });

  // ── 2. Lane 2 über jeden deferred:lane2-ocr-Beleg ──────────────────────
  const orchUp = await pingOrchestrator(baseUrl);
  const lane2Docs: Lane2Doc[] = [];
  const lane2Results: MappingResult[] = [];
  const lane2Targets = lane1.deferred.filter((d) => d.route === 'lane2-ocr');

  if (lane2Targets.length > 0 && !orchUp) {
    warnings.push(`Orchestrator nicht erreichbar (${baseUrl}) — ${lane2Targets.length} Bild-Belege NICHT OCR-verarbeitet.`);
  }

  if (orchUp) {
    for (const t of lane2Targets) {
      const pdfPath = t.source; // bei Bild-PDFs == ganzer PDF-Pfad
      const origin = originOf.get(pdfPath) ?? pdfPath;
      try {
        const ocr = await ocrEnsembleFromPath(pdfPath, { baseUrl });
        const ocrRecords = ocr.consensus_pages.reduce((s, p) => s + p.records.length, 0);
        const taggedRecords = ocr.tagged_pages.reduce(
          (s, p) => s + p.records.filter((r) => r.candidates.length > 0).length, 0);
        // Deterministischer Pfad: OCR-Records → reading-order rawText (lane2-
        // adapter, bbox-sortiert) → detectBelegTyp → mapBeleg. Der semantic-
        // overlay-Tag-Pfad ist auf realen Scans noch zu verrauscht (matcht
        // Boilerplate auf falsche E-Codes); der deterministische Mapper inkl.
        // Anlage-Zeile-Anker (mit OCR-Spalten-Look-Back) ist präziser.
        const rawText = ocrEnsembleToRawText(ocr);
        if (rawText.trim().length === 0) {
          lane2Docs.push({ source: origin, pdfPath, belegTyp: 'Unbekannt', person: 'A',
            ocrRecords, taggedRecords, felder: 0, status: 'no-tags',
            detail: 'OCR lieferte keinen verwertbaren Text' });
          continue;
        }
        const belegTyp = detectBelegTyp(rawText);
        if (belegTyp === 'Unbekannt') {
          lane2Docs.push({ source: origin, pdfPath, belegTyp: 'Unbekannt', person: 'A',
            ocrRecords, taggedRecords, felder: 0, status: 'unknown-typ',
            detail: 'detectBelegTyp: kein Titel-Pattern erkannt' });
          continue;
        }
        const pr = resolvePersonByName(rawText, lane1.household);
        const person = pr.person;
        // Person B aus dem Beleg lernen (VaSt liefert oft nur B's IdNr, keinen Namen)
        if (pr.learned && !lane1.household.personB?.vorname) {
          lane1.household.personB = { ...(lane1.household.personB ?? {}), vorname: pr.learned.vorname, nachname: pr.learned.nachname };
        }
        const r = mapBeleg({ belegTyp, person, rawText, source: { pdfPath: origin } });
        lane2Results.push(r);
        lane2Docs.push({ source: origin, pdfPath, belegTyp, person,
          ocrRecords, taggedRecords, felder: r.felder.length, status: 'mapped',
          detail: `deterministisch: ${r.felder.length} Felder` });
      } catch (e) {
        lane2Docs.push({ source: origin, pdfPath, belegTyp: 'Unbekannt', person: 'A',
          ocrRecords: 0, taggedRecords: 0, felder: 0, status: 'error',
          detail: (e as Error).message });
      }
    }
  }

  // ── 3. Merge: Lane-1-Aggregat als ein Resultat + Lane-2-Resultate ──────
  const lane1AsResult: MappingResult = {
    belegTyp: 'Unbekannt', person: 'A',
    felder: lane1.aggregated, missingExpected: [], unmatched: [], warnings: [],
  };
  const lane1Keys = new Set(lane1.aggregated.map((f) => `${f.eCode}|${f.person}`));
  const merged = aggregate([lane1AsResult, ...lane2Results]);
  const lane2NewFields = merged.filter((f) => {
    const k = `${f.eCode}|${f.person}`;
    return !lane1Keys.has(k) && lane2Results.some((r) => r.felder.some((x) => x.eCode === f.eCode && x.person === f.person));
  });

  // ── 4. Pre-Validate + XML ──────────────────────────────────────────────
  const validation = await preValidate(merged, { pool, vz });
  let xml: string | null = null;
  if (validation.ready && merged.length > 0) {
    const built = await buildE10XML(merged, { vz, pool });
    xml = built.xml;
  }

  // ── 5. Kennzahl (optional) ─────────────────────────────────────────────
  let kennzahlCoverage: { resolved: number; total: number } | null = null;
  let kennzahlRows: Array<{ eCode: string; person: string; anlage: string; sbkz: string }> = [];
  if (kennzahl && merged.length > 0) {
    const kz = await annotateWithKennzahl(merged, { pool, vz });
    kennzahlRows = kz.enriched.map((f) => ({
      eCode: f.eCode, person: String(f.person), anlage: f.anlage, sbkz: formatKennzahl(f.kennzahl),
    }));
    kennzahlCoverage = { resolved: kennzahlRows.filter((k) => k.sbkz !== '—').length, total: kennzahlRows.length };
  }

  await pool.end();

  // ── 6. Output ──────────────────────────────────────────────────────────
  if (json) {
    console.log(JSON.stringify({
      household: lane1.household, lane1Fields: lane1.aggregated.length,
      lane2Docs, lane2NewFields: lane2NewFields.map((f) => f.eCode),
      mergedFields: merged.length, validation: { ready: validation.ready, errors: validation.errorCount },
      kennzahlCoverage, warnings: [...warnings, ...lane1.warnings],
    }, null, 2));
  } else {
    const ruler = '═'.repeat(78);
    console.log('\n' + ruler);
    console.log('  Steuerfall — Lane 1 + Lane 2 in einer Reihe');
    console.log(ruler);
    console.log(`  Dokumente:   ${docs.length}  (${pdfPaths.length} PDF nach Bild-Konvertierung)`);
    console.log(`  Orchestrator: ${baseUrl}  ${orchUp ? '✓ erreichbar' : '✗ NICHT erreichbar'}`);
    console.log('');
    console.log(`  Household:`);
    console.log(`    Person A: ${JSON.stringify(lane1.household.personA ?? null)}`);
    console.log(`    Person B: ${JSON.stringify(lane1.household.personB ?? null)}`);
    console.log('');
    console.log('  ── Lane 1 (deterministisch, Digital-Text) ──');
    for (const b of lane1.belege) {
      const flag = b.status === 'mapped' ? '✓' : '◐';
      console.log(`    ${flag} ${b.belegTyp.padEnd(22)} [${String(b.person).padEnd(7)}] ${b.status.padEnd(13)} felder=${b.felder}  ${basename(b.source)}`);
    }
    console.log(`    → Lane-1-Felder (aggregiert): ${lane1.aggregated.length}`);
    console.log('');
    console.log('  ── Lane 2 (OCR → deterministischer Mapper, gescannte Belege) ──');
    if (lane2Targets.length === 0) {
      console.log('    (keine Bild-/Scan-Belege — nichts für Lane 2)');
    } else {
      for (const d of lane2Docs) {
        const flag = d.status === 'mapped' ? '✓' : d.status === 'error' ? '✗' : '◐';
        console.log(`    ${flag} ${d.belegTyp.padEnd(22)} [${d.person}] ${d.status.padEnd(11)} ocr=${d.ocrRecords} tagged=${d.taggedRecords} felder=${d.felder}  ${basename(d.source)}`);
        if (d.detail && d.status !== 'mapped') console.log(`        ↳ ${d.detail}`);
      }
      const l2f = lane2Results.reduce((s, r) => s + r.felder.length, 0);
      console.log(`    → Lane-2-Felder (roh): ${l2f}`);
    }
    console.log('');
    console.log('  ── Merge ──');
    console.log(`    Lane 1: ${lane1.aggregated.length} Felder`);
    console.log(`    Lane 2 NEU (nicht in Lane 1): ${lane2NewFields.length}  ${lane2NewFields.length ? '→ ' + lane2NewFields.map((f) => f.eCode).join(', ') : ''}`);
    console.log(`    ─────────────────────────────`);
    console.log(`    GESAMT (merged): ${merged.length} Felder`);
    console.log('');
    console.log(`  Pre-Validation: ${validation.errorCount} errors, ${validation.warningCount} warnings → ready=${validation.ready ? '✓' : '✗'}`);
    for (const i of validation.issues) {
      console.log(`    ${i.severity === 'error' ? '✗' : '⚠'} ${i.eCode}: ${i.detail}`);
    }
    if (kennzahlCoverage) {
      console.log('');
      console.log('  ── ERiC-Adressierung (E-Code → Sachbereich.Kennzahl) ──');
      for (const k of kennzahlRows) {
        console.log(`    ${k.eCode.padEnd(10)} [${k.anlage.padEnd(5)}] P${k.person}  →  Kz ${k.sbkz}`);
      }
      console.log(`    Kennzahl-Coverage (Wert-Felder): ${kennzahlCoverage.resolved}/${kennzahlCoverage.total}  (Rest = ESt1A-Identität, positionell adressiert)`);
    }
    const allWarn = [...warnings, ...lane1.warnings];
    if (allWarn.length > 0) {
      console.log('');
      console.log('  Warnings:');
      for (const w of allWarn) console.log(`    ⚠ ${w}`);
    }
  }

  // XML schreiben
  if (xml) {
    const outPath = out ?? `${basename(pdfPaths[0] ?? 'fall').replace(/\.[^.]+$/, '')}.e10.xml`;
    writeFileSync(outPath, xml, 'utf8');
    if (!json) console.log(`\n  ✓ XML geschrieben: ${outPath}  (${xml.length} bytes, ${merged.length} E-Codes)`);
  } else if (!json) {
    console.log('\n  ✗ Kein XML (Pre-Validation nicht ready oder 0 Felder).');
  }
  process.exit(0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(4); });
