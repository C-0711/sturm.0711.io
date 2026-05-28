#!/usr/bin/env -S npx tsx
/**
 * run-steuerfall — EIN Lauf für den ganzen Steuerfall.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  EIN Weg, austauschbarer Parser. Jedes Dokument — PDF oder Bild — geht
 *  durch runLane1(); variabel ist nur der TEXT-LIEFERANT:
 *    PDF mit Text  → pdftotext              (deterministisch, lokal)
 *    Bild / Scan   → injizierter OCR-Parser (Bild→PDF + tornado /ocr-ensemble
 *                    + reading-order)
 *  Ab dem rawText ist ALLES identisch: detect → person → mapBeleg →
 *  aggregate → validate → E10-XML → (optional) Kennzahl.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Dieser Driver injiziert NUR den OCR-Parser in runLane1 und reportet. Die
 * gesamte Mapping-/Merge-/XML-Logik lebt in runLane1 — kein eigener
 * "Lane-2"-Loop mehr.
 *
 * Aufruf:
 *   ELSTER_CATALOG_PG_URL=postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog \
 *   TORNADO_ORCHESTRATOR_URL=http://127.0.0.1:7180 \
 *     npx tsx scripts/run-steuerfall.ts [--vz 2024] [--out fall.xml] [--kennzahl] [--json] <doc...>
 *
 * Flags:
 *   --vz <jahr>          Veranlagungszeitraum (default 2024)
 *   --out <pfad>         XML-Output (default <erstes-doc-basename>.e10.xml)
 *   --kennzahl           ERiC-Adressierung (E-Code → Sachbereich.Kennzahl)
 *   --orchestrator <url> Override TORNADO_ORCHESTRATOR_URL
 *   --json               Strukturierte Ausgabe (inkl. vollständiger fields[])
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';

import { runLane1 } from '../src/workflows/elster/lib/lane1.ts';
import {
  ocrEnsembleFromPath,
  pingOrchestrator,
} from '../src/workflows/elster/lib/field-mapper/ocr-ensemble-client.ts';
import { ocrEnsembleToRawText } from '../src/workflows/elster/lib/field-mapper/lane2-adapter.ts';
import {
  annotateWithKennzahl,
  formatKennzahl,
} from '../src/workflows/elster/lib/field-mapper/kennzahl-bridge.ts';

const { Pool } = pg;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.gif', '.bmp']);

function parseArgs(argv: string[]) {
  const docs: string[] = [];
  let vz = 2024, out: string | null = null, orchestrator: string | null = null;
  let kennzahl = false, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vz') vz = Number(argv[++i]);
    else if (a === '--out') out = argv[++i];
    else if (a === '--orchestrator') orchestrator = argv[++i];
    else if (a === '--kennzahl') kennzahl = true;
    else if (a === '--json') json = true;
    else if (a.startsWith('--')) { console.error(`Unbekanntes Flag: ${a}`); process.exit(4); }
    else docs.push(a);
  }
  return { docs, vz, out, orchestrator, kennzahl, json };
}

/**
 * Bild → temporäres 1-Seiten-PDF (image-only, kein Text-Layer).
 * Cross-platform: sips (macOS) → img2pdf → ImageMagick → Python/Pillow (H200V).
 */
function imageToPdf(imgPath: string, workDir: string): string {
  const pdfPath = join(workDir, basename(imgPath).replace(/\.[^.]+$/, '') + '.pdf');
  const py = `from PIL import Image; Image.open(${JSON.stringify(imgPath)}).convert("RGB").save(${JSON.stringify(pdfPath)}, "PDF")`;
  const attempts: Array<[string, string[]]> = [
    ['sips', ['-s', 'format', 'pdf', imgPath, '--out', pdfPath]],
    ['img2pdf', [imgPath, '-o', pdfPath]],
    ['magick', [imgPath, pdfPath]],
    ['convert', [imgPath, pdfPath]],
    ['python3', ['-c', py]],
  ];
  let lastErr: unknown;
  for (const [bin, args] of attempts) {
    try { execFileSync(bin, args, { stdio: 'pipe' }); if (existsSync(pdfPath)) return pdfPath; }
    catch (e) { lastErr = e; }
  }
  throw new Error(`Bild→PDF fehlgeschlagen für ${basename(imgPath)} (kein sips/img2pdf/magick/convert/PIL): ${(lastErr as Error)?.message ?? ''}`);
}

async function main(): Promise<void> {
  const { docs, vz, out, orchestrator, kennzahl, json } = parseArgs(process.argv.slice(2));
  if (docs.length === 0) {
    console.error('Usage: run-steuerfall [--vz 2024] [--out fall.xml] [--kennzahl] [--json] <doc...>');
    process.exit(1);
  }
  const baseUrl = orchestrator ?? process.env.TORNADO_ORCHESTRATOR_URL ?? 'http://127.0.0.1:7180';
  const url = process.env.ELSTER_CATALOG_PG_URL ?? 'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
  const pool = new Pool({ connectionString: url, max: 4 });
  const workDir = mkdtempSync(join(tmpdir(), 'steuerfall-'));

  // ── DER injizierte OCR-Parser (Bild/Scan → reading-order rawText) ──────
  //   Nur aktiv wenn der Orchestrator erreichbar ist; sonst bleibt der Kern
  //   netzfrei und Bild-Belege landen in deferred[].
  const orchUp = await pingOrchestrator(baseUrl);
  const parseImage = async (docPath: string): Promise<string> => {
    const pdf = IMAGE_EXT.has(extname(docPath).toLowerCase()) ? imageToPdf(docPath, workDir) : docPath;
    const ocr = await ocrEnsembleFromPath(pdf, { baseUrl });
    return ocrEnsembleToRawText(ocr);
  };

  let lane1: Awaited<ReturnType<typeof runLane1>>;
  try {
    lane1 = await runLane1(docs, { vz, pool, parseImage: orchUp ? parseImage : undefined });
  } catch (err) {
    console.error('FATAL:', (err as Error).message);
    await pool.end();
    process.exit(4);
  }

  // ── Kennzahl-Anreicherung (optional) ───────────────────────────────────
  let kennzahlRows: Array<{ eCode: string; person: string; anlage: string; sbkz: string }> = [];
  if (kennzahl && lane1.aggregated.length > 0) {
    const kz = await annotateWithKennzahl(lane1.aggregated, { pool, vz });
    kennzahlRows = kz.enriched.map((f) => ({
      eCode: f.eCode, person: String(f.person), anlage: f.anlage, sbkz: formatKennzahl(f.kennzahl),
    }));
  }
  await pool.end();

  // ── Vollständige Feld-Tabelle (mit Herkunft text|ocr + Kennzahl) ───────
  const ocrSet = new Set(lane1.ocrFields);
  const kzByKey = new Map(kennzahlRows.map((k) => [`${k.eCode}|${k.person}|${k.anlage}`, k.sbkz]));
  const fields = lane1.aggregated.map((f) => ({
    eCode: f.eCode, label: f.pdfLabel, wert: f.wert, person: f.person, anlage: f.anlage,
    kontext: f.kontextSubpath ?? null,
    method: ocrSet.has(`${f.eCode}|${f.person}`) ? 'ocr' : 'text',
    kennzahl: kzByKey.get(`${f.eCode}|${f.person}|${f.anlage}`) ?? '—',
  }));

  // ── Ausgabe ─────────────────────────────────────────────────────────────
  if (json) {
    console.log(JSON.stringify({
      household: lane1.household,
      orchestrator: { url: baseUrl, reachable: orchUp },
      belege: lane1.belege,
      fields,
      mergedFields: lane1.aggregated.length,
      validation: { ready: lane1.validation.ready, errors: lane1.validation.errorCount },
      kennzahlCoverage: kennzahlRows.length
        ? { resolved: kennzahlRows.filter((k) => k.sbkz !== '—').length, total: kennzahlRows.length } : null,
      deferred: lane1.deferred,
      warnings: lane1.warnings,
    }, null, 2));
  } else {
    const ruler = '═'.repeat(78);
    console.log('\n' + ruler);
    console.log('  Steuerfall — EIN Weg, austauschbarer Parser (Text | OCR)');
    console.log(ruler);
    console.log(`  Dokumente:    ${docs.length}`);
    console.log(`  Orchestrator: ${baseUrl}  ${orchUp ? '✓ (OCR-Parser aktiv)' : '✗ (nur Text — Bilder deferred)'}`);
    console.log('');
    console.log('  Household:');
    console.log(`    Person A: ${JSON.stringify(lane1.household.personA ?? null)}`);
    console.log(`    Person B: ${JSON.stringify(lane1.household.personB ?? null)}`);
    console.log('');
    console.log('  Belege (ein Loop, Parser je Dokument):');
    for (const b of lane1.belege) {
      const flag = b.status === 'mapped' ? '✓' : '◐';
      const m = b.method === 'ocr' ? 'OCR ' : 'TEXT';
      console.log(`    ${flag} [${m}] ${b.belegTyp.padEnd(22)} [${String(b.person).padEnd(7)}] ${b.status.padEnd(13)} felder=${b.felder}  ${basename(b.source)}`);
    }
    const txt = lane1.belege.filter((b) => b.method === 'text' && b.status === 'mapped').length;
    const ocrN = lane1.belege.filter((b) => b.method === 'ocr' && b.status === 'mapped').length;
    console.log(`    → ${lane1.aggregated.length} E-Codes aggregiert  (${txt} Text- + ${ocrN} OCR-Belege)`);
    if (lane1.deferred.length > 0) {
      console.log('');
      console.log('  Deferred (nicht verarbeitet):');
      for (const d of lane1.deferred) console.log(`    → ${d.route.padEnd(10)} ${basename(d.source)} — ${d.reason}`);
    }
    console.log('');
    console.log(`  Pre-Validation: ${lane1.validation.errorCount} errors, ${lane1.validation.warningCount} warnings → ready=${lane1.validation.ready ? '✓' : '✗'}`);
    for (const i of lane1.validation.issues) {
      console.log(`    ${i.severity === 'error' ? '✗' : '⚠'} ${i.eCode}: ${i.detail}`);
    }
    if (kennzahlRows.length > 0) {
      console.log('');
      console.log('  Extrahierte Felder (E-Code · Anlage · Person · Quelle · Wert · Kennzahl):');
      for (const f of fields) {
        console.log(`    ${f.eCode.padEnd(10)} [${f.anlage.padEnd(5)}] P${f.person} ${(f.method === 'ocr' ? 'OCR' : 'TXT')}  ${String(f.wert).padEnd(14)} Kz ${f.kennzahl}`);
      }
      const resolved = kennzahlRows.filter((k) => k.sbkz !== '—').length;
      console.log(`    Kennzahl-Coverage: ${resolved}/${kennzahlRows.length}`);
    }
    if (lane1.warnings.length > 0) {
      console.log('');
      console.log('  Warnings:');
      for (const w of lane1.warnings) console.log(`    ⚠ ${w}`);
    }
  }

  // ── XML schreiben (von runLane1 bereits gebaut) ────────────────────────
  if (lane1.xml) {
    const outPath = out ?? `${basename(docs[0] ?? 'fall').replace(/\.[^.]+$/, '')}.e10.xml`;
    writeFileSync(outPath, lane1.xml, 'utf8');
    if (!json) console.log(`\n  ✓ XML geschrieben: ${outPath}  (${lane1.xml.length} bytes, ${lane1.aggregated.length} E-Codes)`);
  } else if (!json) {
    console.log('\n  ✗ Kein XML (Pre-Validation nicht ready oder 0 Felder).');
  }
  process.exit(0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(4); });
