/**
 * trace-vast-multi.ts — Forensischer Multi-Beleg-Walk durch alle Stages.
 *
 * Funktioniert für Sammel-VaSt-PDFs (mehrere Belege in einem PDF, getrennt
 * durch "Transferticket:"-Header) UND für Single-Beleg-PDFs (eine Section).
 *
 * Aufruf:
 *   PDF=/path/to/vast.pdf \
 *   ELSTER_CATALOG_PG_URL=... \
 *     npx tsx scripts/trace-vast-multi.ts
 *
 * Stages:
 *   1 — pdftotext rawText
 *   2 — vast-splitter: rawText → VastSection[]
 *   3 — household-inferenz: Section-IdNrs → Person A/B
 *   4 — per Section: detectBelegTyp + mapBeleg
 *   5 — aggregate: alle MappedFields → konsolidiert
 *   6 — preValidate gegen Catalog
 *   7 — buildE10XML
 *   8 — xmllint Schema-Validation
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  splitVastText,
  inferHousehold,
  resolvePersonForSection,
} from '../src/workflows/elster/lib/field-mapper/vast-splitter.ts';
import { mapBeleg, aggregate, detectBelegTyp } from '../src/workflows/elster/lib/field-mapper/mapper.ts';
import { preValidate } from '../src/workflows/elster/lib/field-mapper/pre-validate.ts';
import { buildE10XML } from '../src/workflows/elster/lib/field-mapper/e10-xml.ts';
import type { BelegInput, MappingResult } from '../src/workflows/elster/lib/field-mapper/types.ts';

const { Pool } = pg;

const PDF = process.env.PDF;
if (!PDF || !existsSync(PDF)) {
  console.error(`FATAL: PDF nicht gefunden. PDF=${PDF}`);
  process.exit(1);
}
const PG_URL =
  process.env.ELSTER_CATALOG_PG_URL ??
  'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
const XSD_PATH = process.env.E10_XSD_PATH ?? '';

const pdfBuf = readFileSync(PDF);
const sha = createHash('sha256').update(pdfBuf).digest('hex');
const sha8 = sha.slice(0, 8);
const dumpDir = `/tmp/trace-vast-${sha8}`;
if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });

const ruler = '═'.repeat(82);
const sub = '─'.repeat(82);
const half = '·'.repeat(82);

function header(stage: string, ms: number, what: string): void {
  console.log('');
  console.log(ruler);
  console.log(`  STAGE ${stage}  (${ms} ms)`);
  console.log(`  ${what}`);
  console.log(ruler);
}

function dump(name: string, content: string): void {
  writeFileSync(`${dumpDir}/${name}`, content);
}

async function main(): Promise<void> {
  console.log('');
  console.log(ruler);
  console.log(`  trace-vast-multi`);
  console.log(`  PDF:      ${PDF}`);
  console.log(`  Bytes:    ${pdfBuf.length}`);
  console.log(`  SHA256:   ${sha}`);
  console.log(`  Dump-Dir: ${dumpDir}`);
  console.log(ruler);

  // ── STAGE 1 ────────────────────────────────────────────────────────
  const t1 = Date.now();
  const rawText = execSync(`pdftotext -layout ${JSON.stringify(PDF!)} -`, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const t1Ms = Date.now() - t1;
  dump('01-rawtext.txt', rawText);
  header('1', t1Ms, 'PDFTOTEXT — PDF → rawText');
  console.log(`  ${rawText.length} chars, ${rawText.split('\n').length} Zeilen`);

  // ── STAGE 2 ────────────────────────────────────────────────────────
  const t2 = Date.now();
  const sections = splitVastText(rawText);
  const t2Ms = Date.now() - t2;
  dump('02-sections.json', JSON.stringify(
    sections.map((s) => ({
      index: s.index, chars: s.chars, uebernommen: s.uebernommen,
      abrufdatum: s.abrufdatum, preview: s.text.slice(0, 180),
    })),
    null, 2,
  ));
  header('2', t2Ms, 'VAST-SPLITTER — rawText → Sections');
  console.log(`  ${sections.length} Section(s) gefunden`);
  for (const s of sections) {
    const flag = s.uebernommen ? '✓' : '◐ nicht-übernommen';
    const titleLine = s.text.split('\n').slice(2, 8).find((l) => /^\s*[A-ZÄÖÜ]/.test(l) && !l.includes('Transferticket') && !l.includes('Zuletzt') && !l.includes('Diese Bescheinigung')) ?? '<no-title>';
    console.log(`    [${s.index}] ${flag}  ${s.chars}c   "${titleLine.trim().slice(0, 70)}"`);
  }

  // ── STAGE 3 ────────────────────────────────────────────────────────
  const t3 = Date.now();
  const hh = inferHousehold(sections);
  const t3Ms = Date.now() - t3;
  dump('03-household.json', JSON.stringify(hh, null, 2));
  header('3', t3Ms, 'HOUSEHOLD-INFERENZ — IdNr-Vorkommen → Person A/B');
  console.log(`  Erkannte IdNrs: ${hh.occurrences.length}`);
  for (const o of hh.occurrences) {
    console.log(
      `    ${o.idnr}  sections=[${o.sectionIndices.join(',')}]  ` +
      `typen=[${o.belegTypen.join(',')}]  ` +
      `name="${o.vorname ?? '?'} ${o.nachname ?? '?'}"`,
    );
  }
  console.log('');
  console.log(`  Household:`);
  console.log(`    Person A: ${JSON.stringify(hh.household.personA ?? null)}`);
  console.log(`    Person B: ${JSON.stringify(hh.household.personB ?? null)}`);
  for (const w of hh.warnings) console.log(`  ⚠ ${w}`);

  // ── STAGE 4 ────────────────────────────────────────────────────────
  const t4 = Date.now();
  const mappingResults: MappingResult[] = [];
  const perSectionDiag: Array<{
    sectionIndex: number; belegTyp: string; person: string;
    felder: number; missing: number; unmatched: number; warnings: number;
  }> = [];
  for (const sec of sections) {
    const belegTyp = detectBelegTyp(sec.text);
    if (belegTyp === 'Unbekannt') {
      perSectionDiag.push({
        sectionIndex: sec.index, belegTyp: 'Unbekannt', person: '-',
        felder: 0, missing: 0, unmatched: 0, warnings: 0,
      });
      continue;
    }
    const person = resolvePersonForSection(sec, hh.household);
    if (person === 'unknown') {
      perSectionDiag.push({
        sectionIndex: sec.index, belegTyp, person: 'unknown',
        felder: 0, missing: 0, unmatched: 0, warnings: 0,
      });
      continue;
    }
    const input: BelegInput = {
      belegTyp, person, rawText: sec.text,
      source: { pdfPath: PDF, sha256: sha },
    };
    const r = mapBeleg(input);
    mappingResults.push(r);
    perSectionDiag.push({
      sectionIndex: sec.index, belegTyp, person,
      felder: r.felder.length,
      missing: r.missingExpected.length,
      unmatched: r.unmatched.length,
      warnings: r.warnings.length,
    });
  }
  const t4Ms = Date.now() - t4;
  dump('04-per-section.json', JSON.stringify(perSectionDiag, null, 2));
  dump('04-mapping-results.json', JSON.stringify(mappingResults, null, 2));
  header('4', t4Ms, 'PER-SECTION MAPBELEG — Section → MappedField[]');
  console.log('  Diagnose pro Section:');
  for (const d of perSectionDiag) {
    const ok = d.belegTyp !== 'Unbekannt' && d.person !== 'unknown' && d.person !== '-';
    const flag = ok ? '✓' : '◐';
    console.log(
      `    ${flag} [${d.sectionIndex}] ${d.belegTyp.padEnd(20)} ` +
      `person=${d.person.padEnd(7)} felder=${d.felder}  ` +
      `missing=${d.missing}  unmatched=${d.unmatched}  warnings=${d.warnings}`,
    );
  }
  const totalFelder = mappingResults.reduce((s, r) => s + r.felder.length, 0);
  console.log(`  → ${mappingResults.length} Section(s) erfolgreich gemapped, ${totalFelder} Felder gesamt`);

  // ── STAGE 5 ────────────────────────────────────────────────────────
  const t5 = Date.now();
  const merged = aggregate(mappingResults);
  const t5Ms = Date.now() - t5;
  dump('05-aggregate.json', JSON.stringify(merged, null, 2));
  header('5', t5Ms, 'AGGREGATE — alle MappingResults → konsolidierte MappedField[]');
  console.log(`  ${totalFelder} → ${merged.length} konsolidierte Felder`);
  console.log('');
  console.log('  Pro (anlage|kontext|E-Code|person):');
  for (const f of merged) {
    const w = (f.warnings ?? []).length > 0 ? '⚠' : ' ';
    console.log(
      `   ${w} ${f.eCode.padEnd(10)} [${f.anlage.padEnd(5)}] ${(f.kontextSubpath ?? '').padEnd(28)} ` +
      `person=${f.person}  ${f.wert.padEnd(18)} ← ${f.pdfLabel.slice(0, 38)}`,
    );
    if (f.warnings && f.warnings.length > 0) {
      for (const ww of f.warnings) console.log(`       ⚠ ${ww}`);
    }
  }

  // ── STAGE 6 + 7 ────────────────────────────────────────────────────
  const pool = new Pool({ connectionString: PG_URL, max: 4 });
  const t6 = Date.now();
  const report = await preValidate(merged, { pool, vz: 2024 });
  const t6Ms = Date.now() - t6;
  dump('06-prevalidate.json', JSON.stringify(report, null, 2));
  header('6', t6Ms, 'PRE-VALIDATE — Catalog-Constraints');
  console.log(`  errors: ${report.errorCount}  warnings: ${report.warningCount}  ready: ${report.ready ? '✓' : '✗'}`);
  if (report.issues.length > 0) {
    for (const i of report.issues) {
      console.log(`    ${i.severity === 'error' ? '✗' : '⚠'} ${i.eCode}: ${i.detail}`);
    }
  }

  const t7 = Date.now();
  const out = await buildE10XML(merged, { vz: 2024, pool });
  const t7Ms = Date.now() - t7;
  dump('07-e10.xml', out.xml);
  await pool.end();
  header('7', t7Ms, 'BUILD-E10-XML');
  console.log(`  ${out.xml.length} bytes  •  ${out.emittedECodes.length} E-Codes  •  ${out.warnings.length} Warnungen`);
  for (const w of out.warnings) console.log(`    ⚠ ${w.eCode}: ${w.reason}`);
  console.log('');
  console.log(sub);
  console.log(out.xml.split('\n').slice(0, 60).map((l) => '  │ ' + l).join('\n'));
  if (out.xml.split('\n').length > 60) {
    console.log(`  │ … (${out.xml.split('\n').length - 60} weitere Zeilen)`);
  }

  // ── STAGE 8 ────────────────────────────────────────────────────────
  const t8 = Date.now();
  let xmllintLog = '';
  let valid = false;
  const tmpXml = `${dumpDir}/07-e10.xml`;
  if (!XSD_PATH || !existsSync(XSD_PATH)) {
    console.log('');
    console.log('  (E10_XSD_PATH leer/fehlt — xmllint übersprungen)');
  } else {
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
  }
  const t8Ms = Date.now() - t8;
  dump('08-xmllint.log', xmllintLog);
  header('8', t8Ms, 'XMLLINT');
  if (xmllintLog) console.log('  ' + xmllintLog.trim().split('\n').slice(0, 8).join('\n  '));
  console.log('');
  console.log(valid ? '  ✓ schema-valid' : '  ✗ schema-validation failed (oder geskipped)');

  // ── Summary ────────────────────────────────────────────────────────
  console.log('');
  console.log(ruler);
  console.log('  Summary');
  console.log(ruler);
  console.log(`  Sections im PDF:      ${sections.length}`);
  console.log(`  davon gemapped:       ${mappingResults.length}`);
  console.log(`  Personen erkannt:     ${hh.occurrences.length}`);
  console.log(`  Felder gesamt:        ${totalFelder}`);
  console.log(`  nach Aggregation:     ${merged.length}`);
  console.log(`  Pre-Validation ready: ${report.ready ? '✓' : '✗'}`);
  console.log(`  XML schema-valid:     ${valid ? '✓' : '✗ (oder geskipped)'}`);
  console.log('');
  console.log(`  Total elapsed:        ${t1Ms+t2Ms+t3Ms+t4Ms+t5Ms+t6Ms+t7Ms+t8Ms} ms`);
  console.log(`    pdftotext:          ${t1Ms} ms`);
  console.log(`    splitter:           ${t2Ms} ms`);
  console.log(`    household-inferenz: ${t3Ms} ms`);
  console.log(`    per-section map:    ${t4Ms} ms`);
  console.log(`    aggregate:          ${t5Ms} ms`);
  console.log(`    preValidate:        ${t6Ms} ms`);
  console.log(`    buildE10XML:        ${t7Ms} ms`);
  console.log(`    xmllint:            ${t8Ms} ms`);
  console.log(`  Dumps:                ${dumpDir}/`);
  console.log('');
  process.exit(valid || !XSD_PATH ? 0 : 2);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(3);
});
