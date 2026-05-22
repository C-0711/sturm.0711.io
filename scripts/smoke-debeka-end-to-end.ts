/**
 * End-to-End Smoke: Mistral-OCR-Markdown → Polar-Coding → Tier-1-Value-Extract.
 *
 * Beide Debeka-Belege (Layout A = XSD-Datensatz, Layout B = Brief-PDF) muessen
 * mit derselben Pipeline laufen — ohne Layout-Detektor. Empirisch wird gezeigt:
 *
 *   (a) bei welchen eCodes Tier-1 cent-genau ist (= deterministisch lieferbar),
 *   (b) wo Tier-1 falsche/fehlende Werte liefert (= Tier-3-Kandidaten).
 *
 * Ground Truth (aus den Belegen selbst nachgewiesen):
 *   • Private KV — Basisabsicherung (Beitrag mit Zuschuss):   1.781,98 €
 *   • Private PV — Pflichtversicherung (mit Zuschuss):           772,68 €
 *   • Private KV — Gesamtbeitrag (inkl. Wahlleistungen):      2.238,60 €
 *   • Private PV — Gesamtbeitrag (inkl. freiwillige):            772,68 €
 *   • Differenz Wahlleistungen KV:                              456,62 €
 *
 * Erwartete eCodes (aus Anlage-Vorsorge-Spec):
 *   • E2003104 — private KV Basisabsicherung (ohne Wahlleistungen)
 *   • E2003202 — Pflege-Pflichtversicherung
 *   • E2004003 — private KV Basisabsicherung abzgl. steuerfreier Zuschuesse
 *   • E2004103 — Pflege-Pflichtversicherung abzgl. steuerfreier Zuschuesse
 *   • E2004303 — private KV-/PV-Beitraege über die Basisabsicherung hinausgehend
 */

import * as fs from 'node:fs';
import { polarSchemaSynthStage } from '../src/verticals/elster-v3/stages/polar-schema-synth.ts';
import { tier1ValueExtractStage } from '../src/verticals/elster-v3/stages/tier1-value-extract.ts';

const META_DIR = '/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta';
const LAYOUT_A = `${META_DIR}/f2a377dd-36e1-43ef-b16a-6cb115845f38.json`; // XSD-Datensatz
const LAYOUT_B = `${META_DIR}/5304e988-ac73-4e04-bb04-95af71bd6e49.json`; // Brief-PDF

interface ExpectedValue {
  ecode: string;
  expected: number;
  bedeutung: string;
}

// ELSTER-Format: GeldBetragOhneCent, also Integer-Euro nach Rundung.
// Rule: Ausgaben (Versicherungsbeitraege) → Math.floor.
//   1.781,98 → 1781
//     772,68 →  772
//   2.238,60 → 2238
//     456,62 →  456
const GROUND_TRUTH: ExpectedValue[] = [
  { ecode: 'E2003104', expected: 1781, bedeutung: 'Private KV Basisabsicherung' },
  { ecode: 'E2003202', expected:  772, bedeutung: 'Pflege-Pflichtversicherung' },
  { ecode: 'E2004003', expected: 1781, bedeutung: 'Private KV Basis abzgl. Zuschuesse' },
  { ecode: 'E2004103', expected:  772, bedeutung: 'PV Pflicht abzgl. Zuschuesse' },
  { ecode: 'E2004303', expected:  456, bedeutung: 'Private KV/PV ueber Basis (Wahlleistungen)' },
];

function makeCtx(): any {
  return {
    runId: 'smoke',
    workflowId: 'smoke',
    stageId: 'smoke',
    config: {},
    logger: console,
    artifacts: {},
    emit: (name: string, payload: unknown) => {
      const summary = JSON.stringify(payload).slice(0, 140);
      if (process.env.VERBOSE) console.log('[emit]', name, summary);
    },
    signal: new AbortController().signal,
    results: {},
  };
}

async function runOneBeleg(metaPath: string, layoutName: string) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const ocrText = meta.ocr.markdown;
  const docClass = meta.classification.label;

  console.log('═'.repeat(80));
  console.log(`Layout: ${layoutName}`);
  console.log(`Beleg:  ${meta.originalFilename}`);
  console.log(`Class:  ${docClass}`);
  console.log(`OCR:    ${ocrText.length} chars, ${meta.ocr.pages.length} pages`);
  console.log('═'.repeat(80));

  const ctx = makeCtx();
  const t0 = Date.now();

  // 1. Polar-ELSTER-Coding (alle 59 Kandidaten + Pflicht-Atome)
  const polar = await polarSchemaSynthStage.run(
    {
      ocrText,
      ocrPages: meta.ocr.pages,
      docClass,
      classifierAnlagen: [],
      minScore: 0.0,
      topKPerSection: 8,
      maxEcodes: 100,
      minSectionLength: 50,
    } as any,
    ctx,
  );

  // 2. Tier-1 Value-Extract
  const tier1 = await tier1ValueExtractStage.run(
    {
      polarCoding: polar,
      confidenceThreshold: 0.4,
    },
    ctx,
  );

  const elapsed = Date.now() - t0;

  console.log(`\nWall-Clock total:    ${elapsed} ms`);
  console.log(`Polar-Coding:        ${polar.quantum_container_query.retrieval_ms} ms (${polar.sections.length} sections, ${Object.keys(polar.ecode_descriptions).length} eCodes)`);
  console.log(`Tier-1 extract:      ${tier1.stats.wallClockMs} ms`);
  console.log(`Extracted values:    ${tier1.stats.extracted}`);
  console.log(`Missing (no EUR):    ${tier1.stats.missing}`);
  console.log(`Low confidence:      ${tier1.stats.lowConfidence}`);

  console.log('\n--- Ground-Truth-Diff ---');
  console.log(`eCode      Bedeutung                                   Expected      Got           Status`);
  console.log('─'.repeat(95));

  let pass = 0;
  let fail = 0;
  let miss = 0;
  for (const gt of GROUND_TRUTH) {
    const got = tier1.values[gt.ecode];
    let status: string;
    if (got === undefined) {
      const inLow = tier1.lowConfidence.find((x) => x.ecode === gt.ecode);
      const inMiss = tier1.missing.find((x) => x.ecode === gt.ecode);
      if (inLow) status = `MISSING (lowConf score=${inLow.score.toFixed(3)})`;
      else if (inMiss) status = `MISSING (${inMiss.reason})`;
      else status = 'MISSING (not even in trace)';
      miss++;
    } else if (typeof got === 'number' && got === gt.expected) {
      status = '✓ MATCH';
      pass++;
    } else {
      status = `✗ WRONG (got ${got})`;
      fail++;
    }
    console.log(
      `${gt.ecode}  ${gt.bedeutung.padEnd(42).slice(0, 42)}  ${String(gt.expected).padEnd(12)}  ${String(got ?? '—').padEnd(12)}  ${status}`,
    );
  }

  console.log('\n--- Was wurde extrahiert (mit Provenance) ---');
  const valEntries = Object.entries(tier1.values).sort(([, a], [, b]) => b - a);
  for (const [ec, v] of valEntries.slice(0, 12)) {
    const prov = tier1.provenance[ec];
    const desc = polar.ecode_descriptions[ec];
    console.log(
      `  ${ec}  ${v.toFixed(2).padStart(10)} €  score=${prov.score.toFixed(3)}  raw="${prov.raw_match}"  ← ${(desc?.value ?? '?').slice(0, 50)}`,
    );
  }

  return { pass, fail, miss, total: GROUND_TRUTH.length, elapsed, polar, tier1 };
}

async function main() {
  console.log('\n████  SMOKE: Polar → Tier-1, Debeka A vs B, ohne Layout-Detektor  ████\n');

  const resultA = await runOneBeleg(LAYOUT_A, 'A — ELSTER XSD-Datensatz (4 Beitragsdaten-Bloecke)');
  const resultB = await runOneBeleg(LAYOUT_B, 'B — Brief-PDF (Spalten-Matrix mit Zeilen-Hints)');

  console.log('\n' + '═'.repeat(80));
  console.log('TOTAL SUMMARY');
  console.log('═'.repeat(80));
  console.log(`Layout A:  ${resultA.pass}/${resultA.total} match, ${resultA.fail} wrong, ${resultA.miss} missing  (${resultA.elapsed} ms)`);
  console.log(`Layout B:  ${resultB.pass}/${resultB.total} match, ${resultB.fail} wrong, ${resultB.miss} missing  (${resultB.elapsed} ms)`);

  const totalPass = resultA.pass + resultB.pass;
  const totalExpected = resultA.total + resultB.total;
  console.log(`\nAggregat:  ${totalPass}/${totalExpected} = ${((totalPass / totalExpected) * 100).toFixed(0)}% cent-genau`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
