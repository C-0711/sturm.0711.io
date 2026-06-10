/**
 * render-hildburg-xml.ts — Live-Run + E10-XML-Render gegen Hildburg-Belege
 *
 * Ablauf:
 *   1. field-mapper gegen die 10 echten Hildburg-PDFs laufen lassen
 *      (selbe Logik wie scripts/live-run-hildburg.ts).
 *   2. Aggregat über alle MappingResults bilden.
 *   3. buildE10XML(aggregat, vz) → XML-String.
 *   4. XML auf Platte schreiben + xmllint --schema gegen E10-2024.xsd.
 *
 * Aufruf:
 *   ELSTER_CATALOG_PG_URL=postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog \
 *     tsx scripts/render-hildburg-xml.ts
 *
 * Exit-Codes:
 *   0 — XML generiert + Schema-validiert
 *   1 — Beleg-Mapping fehlgeschlagen
 *   2 — XML generiert, aber xmllint findet Schema-Verletzungen
 *   3 — DB unreachable / Catalog-Lookup-Fehler
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { mapBeleg, aggregate } from '../src/workflows/elster/lib/field-mapper/mapper.ts';
import { buildE10XML } from '../src/workflows/elster/lib/field-mapper/e10-xml.ts';
import { preValidate } from '../src/workflows/elster/lib/field-mapper/pre-validate.ts';
import type {
  BelegInput,
  BelegTyp,
  MappingResult,
} from '../src/workflows/elster/lib/field-mapper/types.ts';

const { Pool } = pg;

const BELEGE_DIR = '/Users/christophbertsch/Desktop/Belege/Erklärung HH';
const XSD_PATH = '/Users/christophbertsch/Desktop/DESKTOP/Elster/Taxcatalog_Elster/E10-2024.xsd';
const OUT_PATH = '/tmp/hildburg-e10.xml';

const DEFAULT_PG_URL =
  'postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog';

interface Fixture {
  filename: string;
  belegTyp: BelegTyp;
  person: 'A' | 'B';
}

const FIXTURES: Fixture[] = [
  { filename: 'Lohnsteuerbescheinigung_2024_57438590613_LBV_NRW.pdf', belegTyp: 'VaSt_LStB', person: 'A' },
  { filename: 'Lohnsteuerbescheinigung_2024_57438590613_Philips_GmbH.pdf', belegTyp: 'VaSt_LStB', person: 'A' },
  { filename: 'Rentenbezugsmitteilung_2024_57438590613_Deutsche_Rentenversicherung_Bund.pdf', belegTyp: 'VaSt_RBM', person: 'A' },
  { filename: 'Rentenbezugsmitteilung_2024_57438590613_Philips_Pensionskasse__VVaG_.pdf', belegTyp: 'VaSt_RBM', person: 'A' },
  { filename: 'Krankenversicherung_2024_57438590613_Debeka_Krankenversicherungsverein_a._G..pdf', belegTyp: 'VaSt_KRV', person: 'A' },
  { filename: 'Kapitalertraege_mit_Freistellungsauftrag_2024_57438590613_Kreissparkasse_Ahrweiler.pdf', belegTyp: 'VaSt_FSA', person: 'A' },
  { filename: 'Kapitalertraege_mit_Freistellungsauftrag_2024_57438590613_VR_Bank_RheinAhrEifel_eG.pdf', belegTyp: 'VaSt_FSA', person: 'A' },
  { filename: 'Religionszugehoerigkeit_2024_57438590613_Finanzverwaltung.pdf', belegTyp: 'VaSt_Religion', person: 'A' },
  { filename: 'Stammdaten_2024_57438590613_Finanzverwaltung.pdf', belegTyp: 'VaSt_Pers', person: 'A' },
  { filename: 'Steuerbescheinigung Volksbank 2024.pdf', belegTyp: 'Steuerbescheinigung_Bank', person: 'A' },
];

function extractText(pdfPath: string): string {
  return execSync(`pdftotext -layout ${JSON.stringify(pdfPath)} -`, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runOne(f: Fixture): MappingResult | null {
  const pdfPath = `${BELEGE_DIR}/${f.filename}`;
  if (!existsSync(pdfPath)) return null;
  let rawText: string;
  try {
    rawText = extractText(pdfPath);
  } catch {
    return null;
  }
  const input: BelegInput = {
    belegTyp: f.belegTyp,
    person: f.person,
    rawText,
    source: { pdfPath },
  };
  return mapBeleg(input);
}

async function main(): Promise<void> {
  console.log('');
  console.log('═'.repeat(82));
  console.log('  render-hildburg-xml  —  field-mapper → E10-XML');
  console.log('═'.repeat(82));
  console.log('');

  // 1. Live-Mapping
  const results: MappingResult[] = [];
  for (const fx of FIXTURES) {
    const r = runOne(fx);
    if (r) results.push(r);
  }
  console.log(`  Mapping: ${results.length}/${FIXTURES.length} Belege erfolgreich verarbeitet`);

  // 2. Aggregat über alle Belege
  const merged = aggregate(results);
  console.log(`  Aggregat: ${merged.length} konsolidierte Felder`);

  if (merged.length === 0) {
    console.error('  KEINE Felder extrahiert — Abbruch.');
    process.exit(1);
  }

  // 3. Pre-Validation gegen Catalog-Constraints (P6)
  const url = process.env.ELSTER_CATALOG_PG_URL ?? DEFAULT_PG_URL;
  const pool = new Pool({ connectionString: url, max: 4 });
  let xml: string;
  let warnings: { eCode: string; reason: string }[];
  let emittedECodes: string[];
  try {
    const report = await preValidate(merged, { vz: 2024, pool });
    console.log('');
    console.log('─'.repeat(82));
    console.log('  Pre-Validation (catalog-constraints, P6)');
    console.log('─'.repeat(82));
    console.log(
      `  Issues: ${report.issues.length} (${report.errorCount} errors, ${report.warningCount} warnings)`,
    );
    console.log(`  Lane-1-ready: ${report.ready ? '✓ ja' : '✗ nein'}`);
    if (report.issues.length > 0) {
      for (const cat of Object.keys(report.byCategory) as Array<keyof typeof report.byCategory>) {
        const list = report.byCategory[cat];
        if (list.length === 0) continue;
        console.log(`  ─── ${cat} (${list.length}) ─────`);
        for (const i of list) {
          const flag = i.severity === 'error' ? '✗' : '⚠';
          console.log(
            `    ${flag} [${i.anlage.padEnd(5)}] ${i.eCode.padEnd(10)} ${i.pdfLabel.slice(0, 35).padEnd(35)} ` +
            `"${i.normalizedValue.slice(0, 30)}"`,
          );
          console.log(`        ${i.detail}`);
        }
      }
    }

    // 4. XML generieren (auch wenn Validation Fehler hat — User darf inspizieren)
    const out = await buildE10XML(merged, { vz: 2024, pool });
    xml = out.xml;
    warnings = out.warnings;
    emittedECodes = out.emittedECodes;
  } catch (err) {
    console.error('  Catalog-Lookup / XML-Build fehlgeschlagen:', (err as Error).message);
    await pool.end();
    process.exit(3);
  } finally {
    await pool.end();
  }

  writeFileSync(OUT_PATH, xml, 'utf8');
  console.log('');
  console.log(`  XML geschrieben: ${OUT_PATH}  (${xml.length} bytes, ${emittedECodes.length} E-Codes)`);

  if (warnings.length > 0) {
    console.log('');
    console.log(`  ⚠ ${warnings.length} Generator-Warnungen:`);
    for (const w of warnings) console.log(`    • ${w.eCode}: ${w.reason}`);
  }

  // 4. xmllint --schema gegen E10-2024.xsd
  console.log('');
  console.log('─'.repeat(82));
  console.log('  xmllint --schema E10-2024.xsd');
  console.log('─'.repeat(82));
  if (!existsSync(XSD_PATH)) {
    console.warn(`  ⚠ XSD nicht gefunden: ${XSD_PATH} — Schema-Validierung übersprungen.`);
    process.exit(0);
  }
  try {
    const out = execSync(
      `xmllint --schema ${JSON.stringify(XSD_PATH)} ${JSON.stringify(OUT_PATH)} --noout 2>&1`,
      { encoding: 'utf8' },
    );
    console.log(`  ${out.trim() || OUT_PATH + ' validates'}`);
    console.log('');
    console.log('═'.repeat(82));
    console.log('  ✓ XML ist gegen E10-2024.xsd schema-valid');
    console.log('═'.repeat(82));
    process.exit(0);
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message: string };
    const stdout = e.stdout?.toString() ?? '';
    const stderr = e.stderr?.toString() ?? '';
    console.log(stdout);
    console.log(stderr);
    console.log('');
    console.log('═'.repeat(82));
    console.log('  ✗ Schema-Validierung fehlgeschlagen (siehe oben)');
    console.log('═'.repeat(82));
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(3);
});
