/**
 * trace-single-beleg.ts — Forensischer Walk durch alle Pipeline-Stages.
 *
 * Ziel: dokumentiert jede einzelne Transformation pro Beleg, mit
 * Sample-Daten am Stage-Boundary. Nicht für CI — für Debugging und
 * Architecture-Erklärung.
 *
 * Aufruf:
 *   PDF=/path/to/beleg.pdf \
 *   ELSTER_CATALOG_PG_URL=... \
 *     npx tsx scripts/trace-single-beleg.ts
 *
 * Ausgabe pro Stage:
 *   [Stage N] <name>  (Δt=Xms)
 *   <kurzer Erklärungstext>
 *   <Sample-Daten oder relevanter Slice>
 *
 * Dump-Files unter /tmp/trace-<sha8>/:
 *   01-rawtext.txt
 *   02-triage.json
 *   03-extractor-dict.json
 *   04-mapped-fields.json
 *   05-prevalidate.json
 *   06-e10.xml
 *   07-xmllint.log
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import pg from 'pg';
import { triageBeleg, type HouseholdInfo } from '../src/workflows/elster/lib/field-mapper/triage.ts';
import { extractLabelValues } from '../src/workflows/elster/lib/field-mapper/extractor.ts';
import { mapBeleg } from '../src/workflows/elster/lib/field-mapper/mapper.ts';
import { preValidate } from '../src/workflows/elster/lib/field-mapper/pre-validate.ts';
import { buildE10XML } from '../src/workflows/elster/lib/field-mapper/e10-xml.ts';
import type { BelegInput } from '../src/workflows/elster/lib/field-mapper/types.ts';

const { Pool } = pg;

const HOUSEHOLD: HouseholdInfo = {
  personA: { idnr: '57438590613', vorname: 'Hildburg', nachname: 'Haubrich-Koch' },
};

const PDF = process.env.PDF ?? `${process.env.BELEGE_DIR ?? '/Users/christophbertsch/Desktop/Belege/Erklärung HH'}/Lohnsteuerbescheinigung_2024_57438590613_LBV_NRW.pdf`;
const PG_URL =
  process.env.ELSTER_CATALOG_PG_URL ??
  'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
const XSD_PATH = process.env.E10_XSD_PATH ?? '/home/christoph.bertsch/0711-sturm-elster/E10-2024.xsd';

if (!existsSync(PDF)) {
  console.error(`FATAL: PDF nicht gefunden: ${PDF}`);
  process.exit(1);
}

const pdfBuf = readFileSync(PDF);
const sha = createHash('sha256').update(pdfBuf).digest('hex');
const sha8 = sha.slice(0, 8);
const dumpDir = `/tmp/trace-${sha8}`;
if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });

const ruler = '═'.repeat(82);
const sub = '─'.repeat(82);

function header(stage: string, ms: number, what: string): void {
  console.log('');
  console.log(ruler);
  console.log(`  STAGE ${stage}  (${ms} ms)`);
  console.log(`  ${what}`);
  console.log(ruler);
}

function section(s: string): void {
  console.log('');
  console.log(sub);
  console.log(`  ${s}`);
  console.log(sub);
}

function dump(name: string, content: string): void {
  writeFileSync(`${dumpDir}/${name}`, content);
}

async function main(): Promise<void> {
  console.log('');
  console.log(ruler);
  console.log(`  trace-single-beleg`);
  console.log(`  PDF:      ${PDF}`);
  console.log(`  Bytes:    ${pdfBuf.length}`);
  console.log(`  SHA256:   ${sha}`);
  console.log(`  Dump-Dir: ${dumpDir}`);
  console.log(ruler);

  // ── STAGE 1: Triage (PDF → BelegTyp + Person + rawText) ─────────────
  const t1 = Date.now();
  const triage = triageBeleg(PDF, { household: HOUSEHOLD });
  const t1Ms = Date.now() - t1;
  dump('02-triage.json', JSON.stringify(triage, null, 2));
  dump('01-rawtext.txt', triage.rawText ?? '');

  header('1', t1Ms, 'TRIAGE — PDF → BelegTyp + Person + rawText');
  console.log('');
  console.log('Was passiert:');
  console.log('  • pdftotext -layout extrahiert Text aus dem PDF');
  console.log('  • detectBelegTyp() matched titlePatterns gegen den Text-Header');
  console.log('  • findIdNr() + findName() extrahieren Stammdaten');
  console.log('  • Person-Routing: gefundene IdNr/Name gegen Household.personA/B matchen');
  console.log('  • Render-Modus: text-extract (Schwellwert 200 chars) oder ocr-required');
  console.log('');
  console.log(`Result:`);
  console.log(`  belegTyp:        ${triage.belegTyp}`);
  console.log(`  person:          ${triage.person}`);
  console.log(`  renderMode:      ${triage.renderMode}`);
  console.log(`  textChars:       ${triage.detected.textChars}`);
  console.log(`  belegTypConf:    ${triage.detected.belegTypConfidence}`);
  console.log(`  detected.idnr:   ${triage.detected.idnr ?? '∅'}`);
  console.log(`  detected.name:   ${triage.detected.vorname ?? '∅'} ${triage.detected.nachname ?? '∅'}`);
  if (triage.warnings.length > 0) {
    console.log('  warnings:');
    for (const w of triage.warnings) console.log(`    ⚠ ${w}`);
  }
  if (triage.rawText) {
    section(`rawText (erste 25 Zeilen von ${triage.rawText.split('\n').length})`);
    console.log(triage.rawText.split('\n').slice(0, 25).map((l) => `  │ ${l}`).join('\n'));
  }

  if (triage.renderMode !== 'text-extract' || !triage.rawText || triage.belegTyp === 'Unbekannt' || triage.person === 'unknown') {
    console.log('');
    console.log('  ✗ Triage liefert keinen Lane-1-Run-fähigen Output. Stopp.');
    process.exit(0);
  }

  // ── STAGE 2: Extractor (Text → Label-Wert-Dict) ─────────────────────
  const t2 = Date.now();
  const dict = extractLabelValues(triage.rawText);
  const t2Ms = Date.now() - t2;
  dump('03-extractor-dict.json', JSON.stringify(dict, null, 2));
  header('2', t2Ms, 'EXTRACTOR — rawText → Label→Wert-Dict');
  console.log('');
  console.log('Was passiert:');
  console.log('  • extractLabelValues() liest jede Zeile, sucht "Label  Wert"-Paare');
  console.log('    (Strategy 1: ≥2 Spaces Trenner) und "Label\\nWert"-Stacks');
  console.log('    (Strategy 2: vertical) und filtert Header/Footer raus');
  console.log('  • Mehrfach-Vorkommen werden als Array gehalten (z.B. Beitragsdaten-Blöcke)');
  console.log('');
  const dictKeys = Object.keys(dict);
  console.log(`Result:`);
  console.log(`  ${dictKeys.length} eindeutige Labels`);
  console.log('');
  console.log('  Sample (erste 12 Labels):');
  for (const key of dictKeys.slice(0, 12)) {
    const vals = dict[key];
    const valStr = vals.length === 1 ? vals[0] : `[${vals.length}× ${vals.join(' | ')}]`;
    console.log(`    "${key.slice(0, 50).padEnd(50)}" → "${valStr.slice(0, 60)}"`);
  }

  // ── STAGE 3: mapBeleg (Schema-driven match + normalize + branch) ────
  const t3 = Date.now();
  const input: BelegInput = {
    belegTyp: triage.belegTyp,
    person: triage.person,
    rawText: triage.rawText,
    source: { pdfPath: PDF, sha256: sha },
  };
  const mapped = mapBeleg(input);
  const t3Ms = Date.now() - t3;
  dump('04-mapped-fields.json', JSON.stringify(mapped, null, 2));
  header('3', t3Ms, 'MAP-BELEG — Schema-driven Match + Normalize + Branch');
  console.log('');
  console.log('Was passiert:');
  console.log('  • getSchema(belegTyp) liefert die BelegSchema mit FieldMapping[]');
  console.log('  • Pro Schema-Feld: pdfLabel + pdfLabelAliases gegen dict matchen');
  console.log('  • normalize() per valueType: int_euro rundet kaufmännisch,');
  console.log('    decimal_eur_cent setzt deutsches Komma, idnr strippt Spaces, etc.');
  console.log('  • resolveContextBranch() — z.B. RBM bAV-Routing, swap E1800301→E1803102');
  console.log('  • postProcessLstbSteuerklasse6() — bei StKl=6 routet E0200201→E0200203 etc.');
  console.log('  • postProcessKrvWahlleistung() — Differenz Gesamt−Basis für KRV');
  console.log('');
  console.log(`Result:`);
  console.log(`  belegTyp:         ${mapped.belegTyp}`);
  console.log(`  person:           ${mapped.person}`);
  console.log(`  felder:           ${mapped.felder.length} extrahiert`);
  console.log(`  missing-required: ${mapped.missingExpected.length}`);
  console.log(`  unmatched-labels: ${mapped.unmatched.length}`);
  console.log(`  warnings:         ${mapped.warnings.length}`);
  if (mapped.warnings.length > 0) {
    for (const w of mapped.warnings) console.log(`    ⚠ ${w}`);
  }
  section('Extrahierte Felder:');
  for (const f of mapped.felder) {
    const conf = f.confidence.toFixed(2);
    const fw = (f.warnings ?? []).length > 0 ? ' ⚠' : '  ';
    console.log(
      `   ${fw} ${f.eCode.padEnd(10)} [${f.anlage.padEnd(5)}] ${(f.kontextSubpath ?? '').padEnd(28)} ` +
      `${f.valueType.padEnd(20)} conf=${conf}  ${f.wert.padEnd(15)} ← ${f.pdfLabel.slice(0, 38)}`,
    );
    if (f.rawValue !== f.wert) {
      console.log(`     normalized: "${f.rawValue}" → "${f.wert}"`);
    }
    if (f.warnings && f.warnings.length > 0) {
      for (const w of f.warnings) console.log(`     ⚠ ${w}`);
    }
  }

  // ── STAGE 4: pg.Pool boot + Pre-Validation ──────────────────────────
  const pool = new Pool({ connectionString: PG_URL, max: 4 });
  const t4 = Date.now();
  const report = await preValidate(mapped.felder, { pool, vz: 2024 });
  const t4Ms = Date.now() - t4;
  dump('05-prevalidate.json', JSON.stringify(report, null, 2));
  header('4', t4Ms, 'PRE-VALIDATE — Catalog-Constraints-Gate (Lane-1-Ready?)');
  console.log('');
  console.log('Was passiert:');
  console.log('  • loadConstraints(): EIN batched PG-Query lädt feld + format_typ');
  console.log('    + enumeration_wert für ALLE im MappedField[] vorkommenden E-Codes');
  console.log('  • Pro Feld: pflichtfeld + min/max_laenge + max_vorkomma + regex + enum-Wert');
  console.log('  • XSD-Pattern wird optional gegen "stripped" Wert geprüft (für IBAN)');
  console.log('');
  console.log('Result:');
  console.log(`  errors:    ${report.errorCount}`);
  console.log(`  warnings:  ${report.warningCount}`);
  console.log(`  ready:     ${report.ready ? '✓ ja' : '✗ nein'}`);
  if (report.issues.length > 0) {
    for (const cat of Object.keys(report.byCategory) as Array<keyof typeof report.byCategory>) {
      const list = report.byCategory[cat];
      if (list.length === 0) continue;
      console.log(`  ─ ${cat} (${list.length}) ─`);
      for (const i of list) {
        console.log(`    ${i.severity === 'error' ? '✗' : '⚠'} ${i.eCode}: ${i.detail}`);
      }
    }
  }

  // ── STAGE 5: E10-XML-Generator ──────────────────────────────────────
  const t5 = Date.now();
  const out = await buildE10XML(mapped.felder, { vz: 2024, pool });
  const t5Ms = Date.now() - t5;
  dump('06-e10.xml', out.xml);
  header('5', t5Ms, 'E10-XML-GENERATOR — MappedField[] → submittable XML');
  console.log('');
  console.log('Was passiert:');
  console.log('  • loadCatalogLookup(): JOIN elster.feld + kontext.pfad + format_typ.kanonisch');
  console.log('    + format_typ.regex + feld.feld_id (= XSD-Sequence-Position)');
  console.log('  • Pro MappedField: resolveCatalogEntry() matched kontextSubpath an pfad');
  console.log('  • formatValue() formatiert nach kanonisch (int/decimal/date/idnr/iban)');
  console.log('  • TreeNode-Konstruktion: pro Pfad-Segment ein Container,');
  console.log('    Person-Indexfeld bei max_wiederhol=2');
  console.log('  • Children sortieren: min-feldId-of-descendants (XSD-Sequence-Position)');
  console.log('  • Serialisierung mit xs:enum-Reihenfolge des E10_CType (35 Anlagen)');
  console.log('');
  console.log(`Result:`);
  console.log(`  XML-Größe: ${out.xml.length} bytes`);
  console.log(`  E-Codes emitted: ${out.emittedECodes.length}`);
  console.log(`  Generator-Warnungen: ${out.warnings.length}`);
  for (const w of out.warnings) console.log(`    ⚠ ${w.eCode}: ${w.reason}`);
  await pool.end();

  section('XML (erste 60 Zeilen):');
  console.log(out.xml.split('\n').slice(0, 60).map((l) => `  │ ${l}`).join('\n'));

  // ── STAGE 6: xmllint Schema-Validation ──────────────────────────────
  if (!existsSync(XSD_PATH)) {
    console.log('');
    console.log(`(XSD ${XSD_PATH} nicht vorhanden — xmllint übersprungen)`);
    process.exit(0);
  }
  const t6 = Date.now();
  const tmpXml = `${dumpDir}/06-e10.xml`;
  let xmllintLog = '';
  let valid = false;
  try {
    let cmd = '';
    try {
      execSync('which xmllint', { stdio: 'pipe' });
      cmd = `xmllint --schema ${JSON.stringify(XSD_PATH)} ${JSON.stringify(tmpXml)} --noout`;
    } catch {
      const home = process.env.HOME ?? '/home';
      cmd = `docker run --rm -v ${home}:${home} -v /tmp:/tmp alpine:latest sh -c 'apk add --quiet --no-cache libxml2-utils && xmllint --schema ${XSD_PATH} ${tmpXml} --noout'`;
    }
    xmllintLog = execSync(`${cmd} 2>&1`, { encoding: 'utf8' });
    valid = true;
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    xmllintLog = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    valid = false;
  }
  const t6Ms = Date.now() - t6;
  dump('07-xmllint.log', xmllintLog);
  header('6', t6Ms, 'XMLLINT — Schema-Validierung gegen E10-2024.xsd');
  console.log('');
  console.log(`xmllint output:`);
  console.log(`  ${xmllintLog.trim().split('\n').slice(0, 8).join('\n  ')}`);
  console.log('');
  console.log(valid ? '  ✓ XML schema-valid gegen E10-2024.xsd' : '  ✗ Schema-Validierung fehlgeschlagen');

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('');
  console.log(ruler);
  console.log('  Summary');
  console.log(ruler);
  console.log(`  Total elapsed:    ${t1Ms + t2Ms + t3Ms + t4Ms + t5Ms + t6Ms} ms`);
  console.log(`    Triage:         ${t1Ms} ms`);
  console.log(`    Extractor:      ${t2Ms} ms`);
  console.log(`    mapBeleg:       ${t3Ms} ms`);
  console.log(`    preValidate:    ${t4Ms} ms  (1 PG round-trip)`);
  console.log(`    buildE10XML:    ${t5Ms} ms  (1 PG round-trip)`);
  console.log(`    xmllint:        ${t6Ms} ms`);
  console.log(`  Dump files:       ${dumpDir}/{01..07}-*`);
  console.log(`  Schema-valid:     ${valid ? '✓' : '✗'}`);
  console.log('');
  process.exit(valid ? 0 : 2);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(3);
});
