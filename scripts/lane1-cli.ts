#!/usr/bin/env -S npx tsx
/**
 * lane1-cli — CLI-Endpoint für Lane 1 (deterministischer VaSt → E10-XML).
 *
 * EIN Befehl, ein Steuerfall, ein XML. Nimmt 1..N PDF-Pfade (Einzelbelege
 * oder Sammel-VaSt), läuft den kompletten deterministischen Lane-1-Pfad,
 * schreibt das E10-XML und einen Report.
 *
 * Aufruf:
 *   ELSTER_CATALOG_PG_URL=postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog \
 *     npx tsx scripts/lane1-cli.ts [--vz 2024] [--out fall.xml] <pdf...>
 *
 * Flags:
 *   --vz <jahr>      Veranlagungszeitraum (default 2024)
 *   --out <pfad>     XML-Output-Pfad (default: <erste-pdf-basename>.e10.xml)
 *   --json           Strukturierte Lane1Result-Ausgabe statt Report
 *   --xsd <pfad>     Optional: nach Schreiben gegen E10-2024.xsd validieren
 *
 * Exit-Codes:
 *   0  XML gebaut + (falls --xsd) schema-valid
 *   1  keine PDFs / keine Felder extrahiert
 *   2  Pre-Validation NICHT ready (errors) — XML nicht gebaut
 *   3  --xsd gesetzt + xmllint fail
 *   4  DB/Setup-Fehler
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import pg from 'pg';
import { runLane1 } from '../src/workflows/elster/lib/lane1.ts';

const { Pool } = pg;

function parseArgs(argv: string[]) {
  const pdfs: string[] = [];
  let vz = 2024;
  let out: string | null = null;
  let xsd: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vz') { vz = Number(argv[++i]); }
    else if (a === '--out') { out = argv[++i]; }
    else if (a === '--xsd') { xsd = argv[++i]; }
    else if (a === '--json') { json = true; }
    else if (a.startsWith('--')) { console.error(`Unbekanntes Flag: ${a}`); process.exit(4); }
    else { pdfs.push(a); }
  }
  return { pdfs, vz, out, xsd, json };
}

async function main(): Promise<void> {
  const { pdfs, vz, out, xsd, json } = parseArgs(process.argv.slice(2));
  if (pdfs.length === 0) {
    console.error('Usage: lane1-cli [--vz 2024] [--out fall.xml] [--xsd E10.xsd] [--json] <pdf...>');
    process.exit(1);
  }
  const url =
    process.env.ELSTER_CATALOG_PG_URL ??
    'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
  const pool = new Pool({ connectionString: url, max: 4 });

  let result;
  try {
    result = await runLane1(pdfs, { vz, pool });
  } catch (err) {
    console.error('FATAL:', (err as Error).message);
    await pool.end();
    process.exit(4);
  } finally {
    await pool.end();
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const ruler = '═'.repeat(78);
    console.log('');
    console.log(ruler);
    console.log('  Lane 1 — deterministischer VaSt → E10-XML');
    console.log(ruler);
    console.log(`  PDFs:        ${result.stats.pdfs}`);
    console.log(`  Sections:    ${result.stats.sections}`);
    console.log(`  gemapped:    ${result.stats.mapped}`);
    console.log(`  deferred:    ${result.stats.deferred}  (→ Lane 2 / HiTL)`);
    console.log(`  Felder:      ${result.stats.felderRaw} roh → ${result.stats.felderAggregated} aggregiert`);
    console.log('');
    console.log(`  Household:`);
    console.log(`    Person A: ${JSON.stringify(result.household.personA ?? null)}`);
    console.log(`    Person B: ${JSON.stringify(result.household.personB ?? null)}`);
    console.log('');
    console.log('  Belege:');
    for (const b of result.belege) {
      const flag = b.status === 'mapped' ? '✓' : '◐';
      console.log(
        `    ${flag} ${b.belegTyp.padEnd(22)} [${String(b.person).padEnd(7)}] ` +
        `${b.status.padEnd(15)} felder=${b.felder}  ${basename(b.source)}`,
      );
    }
    if (result.deferred.length > 0) {
      console.log('');
      console.log('  Deferred (NICHT Lane 1):');
      for (const d of result.deferred) {
        console.log(`    → ${d.route.padEnd(10)} ${basename(d.source)}  — ${d.reason}`);
      }
    }
    console.log('');
    console.log(`  Pre-Validation: ${result.validation.errorCount} errors, ${result.validation.warningCount} warnings → ready=${result.validation.ready ? '✓' : '✗'}`);
    if (result.validation.issues.length > 0) {
      for (const i of result.validation.issues) {
        console.log(`    ${i.severity === 'error' ? '✗' : '⚠'} ${i.eCode}: ${i.detail}`);
      }
    }
    if (result.warnings.length > 0) {
      console.log('');
      console.log('  Warnings:');
      for (const w of result.warnings) console.log(`    ⚠ ${w}`);
    }
  }

  // XML schreiben
  if (!result.xml) {
    console.error('');
    console.error('  ✗ Kein XML gebaut (Pre-Validation nicht ready oder 0 Felder).');
    process.exit(result.aggregated.length === 0 ? 1 : 2);
  }
  const outPath = out ?? `${basename(pdfs[0]).replace(/\.[^.]+$/, '')}.e10.xml`;
  writeFileSync(outPath, result.xml, 'utf8');
  if (!json) {
    console.log('');
    console.log(`  ✓ XML geschrieben: ${outPath}  (${result.xml.length} bytes, ${result.aggregated.length} E-Codes)`);
  }

  // Optional: xmllint
  if (xsd) {
    if (!existsSync(xsd)) {
      console.error(`  ⚠ XSD nicht gefunden: ${xsd} — Validierung übersprungen.`);
      process.exit(0);
    }
    try {
      execSync(`xmllint --schema ${JSON.stringify(xsd)} ${JSON.stringify(outPath)} --noout 2>&1`, { encoding: 'utf8' });
      if (!json) console.log(`  ✓ schema-valid gegen ${basename(xsd)}`);
      process.exit(0);
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      console.error((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''));
      console.error('  ✗ Schema-Validierung fehlgeschlagen');
      process.exit(3);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(4);
});
