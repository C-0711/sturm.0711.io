/**
 * End-to-End Smoke: OCR → Mistral-Structure (HTML) → Polar-Coder → Tier-1.
 *
 * Beide Debeka-Layouts (A=XSD-Datensatz, B=Brief-PDF). Ground-Truth-Diff
 * gegen Cent-Werte (gerundet auf Integer-Euro nach BMF-Spec).
 */

import * as fs from 'node:fs';
import { mistralStructureStage } from '../src/verticals/elster-v3/stages/mistral-structure.ts';
import { polarSchemaSynthStage } from '../src/verticals/elster-v3/stages/polar-schema-synth.ts';
import { tier1ValueExtractStage } from '../src/verticals/elster-v3/stages/tier1-value-extract.ts';

const META_DIR = '/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta';
const LAYOUT_A = `${META_DIR}/f2a377dd-36e1-43ef-b16a-6cb115845f38.json`;
const LAYOUT_B = `${META_DIR}/5304e988-ac73-4e04-bb04-95af71bd6e49.json`;

const GROUND_TRUTH = [
  { ecode: 'E2003104', expected: 1781, bedeutung: 'Private KV Basisabsicherung' },
  { ecode: 'E2003202', expected:  772, bedeutung: 'Pflege-Pflichtversicherung' },
  { ecode: 'E2004003', expected: 1781, bedeutung: 'Private KV Basis abzgl. Zuschuesse' },
  { ecode: 'E2004103', expected:  772, bedeutung: 'PV Pflicht abzgl. Zuschuesse' },
  { ecode: 'E2004303', expected:  456, bedeutung: 'Private KV/PV ueber Basis (Wahlleistungen)' },
];

function ctxNew(): any {
  return {
    runId: 'smoke',
    workflowId: 'smoke',
    stageId: 'smoke',
    config: {},
    logger: console,
    artifacts: {},
    emit: (n: string, p: unknown) => {
      if (process.env.VERBOSE) console.log('[emit]', n, JSON.stringify(p).slice(0, 160));
    },
    signal: new AbortController().signal,
    results: {},
  };
}

async function runOne(metaPath: string, layoutName: string) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const ocrText = meta.ocr.markdown;
  const docClass = meta.classification.label;

  console.log('═'.repeat(82));
  console.log(`Layout: ${layoutName}`);
  console.log(`Beleg:  ${meta.originalFilename}`);
  console.log(`OCR:    ${ocrText.length} chars, ${meta.ocr.pages.length} pages`);
  console.log('═'.repeat(82));

  const t0 = Date.now();

  // 1. Mistral Small Structure → HTML
  const structureCtx = ctxNew();
  const structured = await mistralStructureStage.run({ ocrText }, structureCtx);
  const tStructure = Date.now() - t0;

  // 2. Polar-Coder auf das HTML
  const polarCtx = ctxNew();
  const tP0 = Date.now();
  const polar = await polarSchemaSynthStage.run(
    {
      ocrText: structured.html, // HTML-Input!
      ocrPages: meta.ocr.pages,
      docClass,
      classifierAnlagen: [],
      minScore: 0.0,
      topKPerSection: 8,
      maxEcodes: 100,
      minSectionLength: 20, // niedrig, weil HTML-Sections kompakter sind
    } as any,
    polarCtx,
  );
  const tPolar = Date.now() - tP0;

  // 3. Tier-1 Value-Extract
  const tier1Ctx = ctxNew();
  const tT0 = Date.now();
  const tier1 = await tier1ValueExtractStage.run(
    { polarCoding: polar, confidenceThreshold: 0.4 },
    tier1Ctx,
  );
  const tTier1 = Date.now() - tT0;

  const totalMs = Date.now() - t0;

  console.log(`\nPipeline-Zeiten:`);
  console.log(`  Mistral-Structure: ${tStructure} ms (${structured.stats.sectionCount} sections, ${structured.stats.fieldCount} fields, ${structured.stats.totalTokens} tokens)`);
  console.log(`  Polar-Coder:       ${tPolar} ms (${polar.sections.length} sections, ${Object.keys(polar.ecode_descriptions).length} eCodes)`);
  console.log(`  Tier-1 Extract:    ${tTier1} ms (${tier1.stats.extracted} extrahiert, ${tier1.stats.missing} missing, ${tier1.stats.lowConfidence} lowConf)`);
  console.log(`  TOTAL:             ${totalMs} ms`);

  console.log(`\n--- Ground-Truth-Diff ---`);
  console.log(`eCode      Bedeutung                                Expected  Got       Status`);
  console.log('─'.repeat(90));

  let pass = 0, fail = 0, miss = 0;
  for (const gt of GROUND_TRUTH) {
    const got = tier1.values[gt.ecode];
    let status: string;
    if (got === undefined) {
      const inLow = tier1.lowConfidence.find((x) => x.ecode === gt.ecode);
      const inMiss = tier1.missing.find((x) => x.ecode === gt.ecode);
      if (inLow) status = `MISSING (lowConf score=${inLow.score.toFixed(3)})`;
      else if (inMiss) status = `MISSING (${inMiss.reason})`;
      else status = 'MISSING (not in trace)';
      miss++;
    } else if (typeof got === 'number' && got === gt.expected) {
      status = '✓ MATCH';
      pass++;
    } else {
      status = `✗ WRONG (got ${got})`;
      fail++;
    }
    console.log(
      `${gt.ecode}  ${gt.bedeutung.padEnd(40).slice(0, 40)} ${String(gt.expected).padEnd(9)} ${String(got ?? '—').padEnd(9)} ${status}`,
    );
  }

  console.log(`\n--- Extrahierte Werte (top-12 nach Score) ---`);
  const valEntries = Object.entries(tier1.values)
    .map(([ec, v]) => ({ ec, v, prov: tier1.provenance[ec] }))
    .sort((a, b) => (b.prov?.score ?? 0) - (a.prov?.score ?? 0))
    .slice(0, 12);
  for (const { ec, v, prov } of valEntries) {
    const desc = polar.ecode_descriptions[ec];
    console.log(`  ${ec}  ${String(v).padStart(8)}  score=${prov.score.toFixed(3)}  ${(desc?.value ?? '?').slice(0, 60)}`);
  }

  return { pass, fail, miss, total: GROUND_TRUTH.length, totalMs };
}

async function main() {
  console.log('\n████  E2E-SMOKE — OCR → Mistral-Structure (HTML) → Polar → Tier-1  ████\n');
  const resultA = await runOne(LAYOUT_A, 'A — ELSTER XSD-Datensatz');
  const resultB = await runOne(LAYOUT_B, 'B — Brief-PDF mit Spalten-Matrix');

  console.log('\n' + '═'.repeat(82));
  console.log('SUMMARY');
  console.log('═'.repeat(82));
  console.log(`Layout A:  ${resultA.pass}/${resultA.total} match, ${resultA.fail} wrong, ${resultA.miss} missing  (${resultA.totalMs} ms)`);
  console.log(`Layout B:  ${resultB.pass}/${resultB.total} match, ${resultB.fail} wrong, ${resultB.miss} missing  (${resultB.totalMs} ms)`);
  const totalPass = resultA.pass + resultB.pass;
  const totalExpected = resultA.total + resultB.total;
  console.log(`\nAggregat:  ${totalPass}/${totalExpected} = ${((totalPass / totalExpected) * 100).toFixed(0)}% cent-genau`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
