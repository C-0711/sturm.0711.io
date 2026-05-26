/**
 * render-hildburg-auto.ts — E2E: Hildburg-Belege OHNE manuelle Fixtures.
 *
 * Im Gegensatz zu render-hildburg-xml.ts (das die FIXTURES-Liste mit
 * BelegTyp + Person als Konstanten hatte), läuft hier alles über die
 * Triage:
 *
 *   directory  →  triageDirectory()
 *      ↓ pro Beleg: { belegTyp, person, renderMode, rawText }
 *      ↓ (filter: renderMode === 'text-extract')
 *   mapBeleg()  →  MappingResult[]
 *      ↓
 *   aggregate() →  MappedField[]
 *      ↓
 *   preValidate() →  ValidationReport
 *      ↓ (auch bei Issues: weiter, User darf inspizieren)
 *   buildE10XML()
 *      ↓
 *   xmllint --schema E10-2024.xsd
 *
 * Aufruf:
 *   ELSTER_CATALOG_PG_URL=postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog \
 *     tsx scripts/render-hildburg-auto.ts
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { mapBeleg, aggregate, detectBelegTyp } from '../src/workflows/elster/lib/field-mapper/mapper.ts';
import { buildE10XML } from '../src/workflows/elster/lib/field-mapper/e10-xml.ts';
import { preValidate } from '../src/workflows/elster/lib/field-mapper/pre-validate.ts';
import { triageDirectory } from '../src/workflows/elster/lib/field-mapper/triage.ts';
import {
  callOcrEnsemble,
  pingOrchestrator,
} from '../src/workflows/elster/lib/field-mapper/ocr-ensemble-client.ts';
import { ocrEnsembleToRawText } from '../src/workflows/elster/lib/field-mapper/lane2-adapter.ts';
import {
  classifyFromTagged,
  mapBelegFromTagged,
} from '../src/workflows/elster/lib/field-mapper/mapper-from-tagged.ts';
import type { BelegInput, MappingResult } from '../src/workflows/elster/lib/field-mapper/types.ts';
import type { HouseholdInfo, TriageResult } from '../src/workflows/elster/lib/field-mapper/triage.ts';

const { Pool } = pg;

const BELEGE_DIR =
  process.env.BELEGE_DIR ?? '/Users/christophbertsch/Desktop/Belege/Erklärung HH';
const XSD_PATH =
  process.env.E10_XSD_PATH ??
  '/Users/christophbertsch/Desktop/DESKTOP/Elster/Taxcatalog_Elster/E10-2024.xsd';
const OUT_PATH = process.env.E10_OUT_PATH ?? '/tmp/hildburg-e10-auto.xml';

const DEFAULT_PG_URL =
  'postgresql://elster:elster_dev_pw@localhost:11111/elster_catalog';

// Household-Info kommt aus Stammdaten in Produktion — hier hartkodiert für
// den Hildburg-Run. (Person-B wäre der Ehegatte; alleinveranlagt → undefined.)
const HOUSEHOLD: HouseholdInfo = {
  personA: { idnr: '57438590613', vorname: 'Hildburg', nachname: 'Haubrich-Koch' },
};

/**
 * Lane 2: PDF an tornado-orchestrator schicken, rawText rekonstruieren,
 * mapBeleg() drüberlaufen lassen. BelegTyp wird aus dem OCR-Text
 * neu klassifiziert (Triage's textChars=0 hatte das nicht ermöglicht).
 */
async function lane2OneBeleg(
  t: TriageResult,
  household: HouseholdInfo,
): Promise<MappingResult | null> {
  const name = t.pdfPath.split('/').pop()!;
  try {
    const pdf = readFileSync(t.pdfPath);
    const resp = await callOcrEnsemble(pdf);
    const rawText = ocrEnsembleToRawText(resp);
    // Beleg-Typ-Erkennung: zuerst über tagged-candidates (robuster als
    // Titel-Pattern auf rawText), fallback detectBelegTyp(rawText).
    const cls = classifyFromTagged(resp.tagged_pages);
    let belegTyp = cls.belegTyp;
    if (belegTyp === 'Unbekannt') {
      belegTyp = detectBelegTyp(rawText);
    }
    if (belegTyp === 'Unbekannt') {
      const scoreSummary = cls.scores
        .filter((s) => s.matched > 0)
        .slice(0, 3)
        .map((s) => `${s.belegTyp}:${s.matched}/${(s.coverage * 100).toFixed(0)}%`)
        .join(' ');
      console.log(
        `  ◐ ${name.slice(0, 60)} — Unbekannt (top-tagged-scores: ${scoreSummary || 'none'})`,
      );
      return null;
    }
    // Person: bevorzugt aus Triage, fallback A (häufigster Fall im Lane-2-Slice)
    let person: 'A' | 'B' = 'A';
    if (t.person === 'A' || t.person === 'B') person = t.person;
    else if (household.personA?.idnr && rawText.includes(household.personA.idnr)) person = 'A';
    else if (household.personB?.idnr && rawText.includes(household.personB.idnr)) person = 'B';

    // Bevorzugt: mapBelegFromTagged (direkt auf TaggedPage[] mit BBoxen)
    // wenn der orchestrator semantische Tags geliefert hat. Fallback:
    // rawText → mapBeleg (für orchestrator-Konfigurationen ohne embed-client).
    const taggedYield = resp.tagged_pages.reduce(
      (s, p) => s + p.records.reduce((rs, r) => rs + (r.candidates.length > 0 ? 1 : 0), 0),
      0,
    );
    const result = taggedYield > 0
      ? mapBelegFromTagged(resp.tagged_pages, belegTyp, person)
      : mapBeleg({ belegTyp, person, rawText, source: { pdfPath: t.pdfPath } });
    const path = taggedYield > 0 ? 'tagged' : 'rawText';
    console.log(
      `  ✓ ${name.slice(0, 60).padEnd(60)} → ${belegTyp}/${person}  ` +
      `pages=${resp.consensus_pages.length} records=${resp.consensus_pages.reduce((s, p) => s + p.records.length, 0)} ` +
      `tagged-candidates=${taggedYield} path=${path} felder=${result.felder.length}`,
    );
    return result;
  } catch (e) {
    console.log(`  ✗ ${name.slice(0, 60)} — Lane 2 fehlgeschlagen: ${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log('═'.repeat(82));
  console.log('  render-hildburg-auto  —  Triage → mapBeleg → preValidate → E10-XML');
  console.log('═'.repeat(82));
  console.log(`  Belege-Dir: ${BELEGE_DIR}`);
  console.log('');

  // 1. Triage über das gesamte Verzeichnis
  if (!existsSync(BELEGE_DIR)) {
    console.error(`Belege-Verzeichnis nicht gefunden: ${BELEGE_DIR}`);
    process.exit(1);
  }
  const triaged = triageDirectory(BELEGE_DIR, { household: HOUSEHOLD });
  triaged.sort((a, b) => a.pdfPath.localeCompare(b.pdfPath));

  console.log('Triage-Ergebnis:');
  console.log('─'.repeat(82));
  for (const t of triaged) {
    const name = t.pdfPath.split('/').pop()!;
    const flag =
      t.renderMode === 'text-extract' && t.belegTyp !== 'Unbekannt'
        ? '✓'
        : t.renderMode === 'ocr-required'
          ? '◐'
          : '✗';
    console.log(
      `  ${flag} ${t.belegTyp.padEnd(24)} ` +
      `[${t.person}] ${t.renderMode.padEnd(14)} ${name.slice(0, 60)}`,
    );
    for (const w of t.warnings) console.log(`      ⚠ ${w}`);
  }
  console.log('');
  const okBelege = triaged.filter(
    (t) => t.renderMode === 'text-extract' && t.belegTyp !== 'Unbekannt',
  );
  const skipped = triaged.length - okBelege.length;
  console.log(`  ${okBelege.length} klassifiziert  •  ${skipped} skipped (OCR/Unbekannt)`);
  console.log('');

  // 2a. mapBeleg über die LANE 1 (text-extract) Belege
  const results: MappingResult[] = [];
  for (const t of okBelege) {
    if (!t.rawText) continue;
    if (t.person === 'unknown') continue;
    const input: BelegInput = {
      belegTyp: t.belegTyp,
      person: t.person,
      rawText: t.rawText,
      source: { pdfPath: t.pdfPath },
    };
    results.push(mapBeleg(input));
  }
  console.log(`  Lane 1 mapBeleg: ${results.length} Belege → ${results.reduce((s, r) => s + r.felder.length, 0)} Felder`);

  // 2b. LANE 2 — OCR-required Belege via tornado-orchestrator
  const ocrCandidates = triaged.filter((t) => t.renderMode === 'ocr-required');
  if (ocrCandidates.length > 0) {
    console.log('');
    console.log('─'.repeat(82));
    console.log(`  Lane 2 — ${ocrCandidates.length} OCR-required Belege`);
    console.log('─'.repeat(82));
    const orchUp = await pingOrchestrator();
    if (!orchUp) {
      console.log('  tornado-orchestrator unreachable (TORNADO_ORCHESTRATOR_URL) — skip Lane 2.');
    } else {
      console.log(`  Orchestrator-Health OK (${process.env.TORNADO_ORCHESTRATOR_URL ?? 'h200v:7180'})`);
      // Parallelize Lane-2-OCR-Calls. Concurrency 4: alle 8 Hildburg-OCR-PDFs
      // werden in 2 Batches abgearbeitet. Spart ~6s vs sequenziell.
      const LANE2_CONCURRENCY = Number(process.env.LANE2_CONCURRENCY ?? '4');
      const lane2Started = Date.now();
      const lane2Results: Array<MappingResult | null> = [];
      for (let i = 0; i < ocrCandidates.length; i += LANE2_CONCURRENCY) {
        const batch = ocrCandidates.slice(i, i + LANE2_CONCURRENCY);
        const batchResults = await Promise.all(batch.map((t) => lane2OneBeleg(t, HOUSEHOLD)));
        lane2Results.push(...batchResults);
      }
      for (const r of lane2Results) if (r) results.push(r);
      const lane2Ms = Date.now() - lane2Started;
      console.log(`  Lane 2 mapBeleg total: ${results.length} (Lane 1 + Lane 2) Belege  (${lane2Ms}ms, concurrency=${LANE2_CONCURRENCY})`);
    }
  }

  // 3. Aggregat
  const merged = aggregate(results);
  console.log(`  Aggregat: ${merged.length} konsolidierte Felder`);
  if (merged.length === 0) {
    console.error('  Keine Felder — Abbruch.');
    process.exit(1);
  }

  // 4. Pre-Validation
  const url = process.env.ELSTER_CATALOG_PG_URL ?? DEFAULT_PG_URL;
  const pool = new Pool({ connectionString: url, max: 4 });
  let xml: string;
  try {
    const report = await preValidate(merged, { vz: 2024, pool });
    console.log('');
    console.log('─'.repeat(82));
    console.log('  Pre-Validation');
    console.log('─'.repeat(82));
    console.log(
      `  Issues: ${report.issues.length} (${report.errorCount} errors, ${report.warningCount} warnings)`,
    );
    console.log(`  Lane-1-ready: ${report.ready ? '✓ ja' : '✗ nein'}`);
    if (report.issues.length > 0) {
      for (const i of report.issues) {
        const flag = i.severity === 'error' ? '✗' : '⚠';
        console.log(`    ${flag} [${i.anlage}] ${i.eCode}  ${i.detail}`);
      }
    }

    // 5. XML generieren
    const out = await buildE10XML(merged, { vz: 2024, pool });
    xml = out.xml;
    console.log('');
    console.log(`  XML: ${xml.length} bytes  •  ${out.emittedECodes.length} E-Codes`);
    if (out.warnings.length > 0) {
      console.log(`  ⚠ ${out.warnings.length} Generator-Warnungen:`);
      for (const w of out.warnings) console.log(`    • ${w.eCode}: ${w.reason}`);
    }
  } finally {
    await pool.end();
  }

  writeFileSync(OUT_PATH, xml, 'utf8');
  console.log(`  geschrieben: ${OUT_PATH}`);

  // 6. xmllint
  console.log('');
  console.log('─'.repeat(82));
  console.log('  xmllint --schema E10-2024.xsd');
  console.log('─'.repeat(82));
  if (!existsSync(XSD_PATH)) {
    console.warn(`  ⚠ XSD nicht gefunden — Schema-Check übersprungen.`);
    process.exit(0);
  }
  // Detect xmllint; falls nicht installiert, einmaliger alpine-Container.
  let xmllintCmd: string;
  try {
    execSync('which xmllint', { stdio: 'pipe' });
    xmllintCmd = `xmllint --schema ${JSON.stringify(XSD_PATH)} ${JSON.stringify(OUT_PATH)} --noout`;
  } catch {
    console.log('  (xmllint nicht installiert — verwende docker alpine-libxml2-Container)');
    const xsdDir = XSD_PATH.replace(/\/[^/]+$/, '');
    const outDir = OUT_PATH.replace(/\/[^/]+$/, '');
    const mountSrc = outDir; // einfach: alle paths im OUT_PATH-Dir
    if (!XSD_PATH.startsWith(mountSrc) && !XSD_PATH.startsWith(xsdDir)) {
      console.warn('  ⚠ XSD- und Output-Dir disjoint — Docker-Mount nicht trivial. Skip.');
      process.exit(0);
    }
    // Workaround: mount $HOME, so beide paths sichtbar
    const home = process.env.HOME ?? '/home';
    xmllintCmd = `docker run --rm -v ${home}:${home} alpine:latest sh -c 'apk add --quiet --no-cache libxml2-utils && xmllint --schema ${XSD_PATH} ${OUT_PATH} --noout'`;
  }
  try {
    const out = execSync(`${xmllintCmd} 2>&1`, { encoding: 'utf8' });
    console.log(`  ${out.trim() || OUT_PATH + ' validates'}`);
    console.log('');
    console.log('═'.repeat(82));
    console.log('  ✓ XML schema-valid gegen E10-2024.xsd');
    console.log('═'.repeat(82));
    process.exit(0);
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    console.log(e.stdout?.toString() ?? '');
    console.log(e.stderr?.toString() ?? '');
    console.log('');
    console.log('═'.repeat(82));
    console.log('  ✗ Schema-Validierung fehlgeschlagen');
    console.log('═'.repeat(82));
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(3);
});
