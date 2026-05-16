/**
 * Fixture test for pentacam-kc-score.
 *
 * Runs the workflow's pure stages (extract → classify) against three
 * synthetic Pentacam-OCR transcripts covering: normal, suspicious, and
 * abnormal cases. Asserts:
 *   - completeness  ≥ 0.8 on each fixture
 *   - riskClass     matches expectation
 *   - score10       monotonic w.r.t. badD across the three cases
 *
 * No network, no API keys, no real Mistral call — pure stage logic.
 * Run via:    npx tsx src/workflows/pentacam-kc/pentacam-kc.test.ts
 * Or in CI:   add to the `test` script in package.json.
 */

import assert from 'node:assert/strict';
import { pentacamExtractStage } from './stages/extract.ts';
import { pentacamClassifyStage } from './stages/classify.ts';
import type { StageContext } from '../../core/types.ts';
import { NullToolContainer } from '../../core/tools/null-container.ts';

// ─── Minimal context double — covers what extract+classify use ────────────
const noopArtifacts = {
  async write() {},
  async writeBuffer() {},
  async read() { return null as any; },
  async readBuffer() { return Buffer.alloc(0); },
  async exists() { return false; },
  absolutePath(p: string) { return `/tmp/${p}`; },
};
const noopLogger = {
  debug(..._a: unknown[]) {},
  info(..._a: unknown[]) {},
  warn(..._a: unknown[]) {},
  error(..._a: unknown[]) {},
};
function makeCtx<T>(stageId: string): StageContext<T> {
  return {
    runId: 'test-run',
    workflowId: 'pentacam-kc-score',
    stageId,
    config: undefined as T,
    logger: noopLogger,
    artifacts: noopArtifacts,
    emit() {},
    signal: new AbortController().signal,
    results: {},
    tools: new NullToolContainer(),
  };
}

// ─── Fixtures — three Pentacam reports in compact OCR form ────────────────
// Field labels and decimal-comma formatting deliberately mirror what we
// observe in real Pentacam Interpretation-Guide PDFs.

const FIXTURE_NORMAL = `
  Pentacam HR — Patient: PAT-12345  Datum: 14/03/2026  OD
  K1: 43,2 dpt   K2: 44,1 dpt
  Pachymetrie Apex 540 µm   dünnste Stelle 532 µm
  Anteriore Elevation +4 µm
  Posteriore Elevation +8 µm
  BAD-D 0,84
  Df 0,12   Db 0,31   Dp 0,55   Dt 0,21   Da 0,18
`;

const FIXTURE_SUSPICIOUS = `
  Pentacam HR — Patient: PAT-67890  Datum: 14/03/2026  OS
  K1: 45,8 dpt   K2: 47,2 dpt
  Pachymetrie Apex 498 µm   dünnste Stelle 488 µm
  Anteriore Elevation +14 µm
  Posteriore Elevation +21 µm
  BAD-D 1,92
  Df 1,12   Db 1,58   Dp 1,84   Dt 1,41   Da 1,03
`;

const FIXTURE_ABNORMAL = `
  Pentacam HR — Patient: PAT-44444  Datum: 14/03/2026  OD
  K1: 49,3 dpt   K2: 52,7 dpt
  Pachymetrie Apex 472 µm   dünnste Stelle 451 µm
  Anteriore Elevation +28 µm
  Posteriore Elevation +37 µm
  BAD-D 3,42
  Df 2,84   Db 3,12   Dp 2,71   Dt 3,55   Da 2,18
`;

// ─── Helpers ──────────────────────────────────────────────────────────────
async function runCase(text: string) {
  const extracted = await pentacamExtractStage.run({ text }, makeCtx('extract'));
  const classified = await pentacamClassifyStage.run({ extracted }, makeCtx('classify'));
  return { extracted, classified };
}

// ─── Assertions ───────────────────────────────────────────────────────────
async function main() {
  console.log('[pentacam-kc.test] running 3 fixtures …');

  const normal = await runCase(FIXTURE_NORMAL);
  assert.equal(normal.extracted.side, 'OD', 'normal: side');
  assert.equal(normal.extracted.patientId, 'PAT-12345', 'normal: patient');
  assert.ok(normal.extracted.completeness >= 0.8, `normal: completeness ${normal.extracted.completeness}`);
  assert.equal(normal.classified.riskClass, 'green', `normal: risk = ${normal.classified.riskClass}`);

  const suspicious = await runCase(FIXTURE_SUSPICIOUS);
  assert.equal(suspicious.extracted.side, 'OS', 'susp: side');
  assert.ok(suspicious.extracted.completeness >= 0.8, `susp: completeness`);
  assert.equal(suspicious.classified.riskClass, 'yellow', `susp: risk = ${suspicious.classified.riskClass}`);

  const abnormal = await runCase(FIXTURE_ABNORMAL);
  assert.equal(abnormal.extracted.side, 'OD', 'abn: side');
  assert.ok(abnormal.extracted.completeness >= 0.8, `abn: completeness`);
  assert.equal(abnormal.classified.riskClass, 'red', `abn: risk = ${abnormal.classified.riskClass}`);

  // Monotonicity: score should rise with risk class.
  assert.ok(
    normal.classified.score10 < suspicious.classified.score10 &&
      suspicious.classified.score10 < abnormal.classified.score10,
    `monotonicity: normal=${normal.classified.score10} susp=${suspicious.classified.score10} abn=${abnormal.classified.score10}`,
  );

  // Disclaimer present + non-empty in every output.
  for (const r of [normal, suspicious, abnormal]) {
    assert.ok(r.classified.disclaimer.length > 50, 'disclaimer present');
  }

  console.log(`[pentacam-kc.test] ALL CHECKS PASSED`);
  console.log(`  normal:     KC ${normal.classified.score10}/10  ${normal.classified.bandLabel}`);
  console.log(`  suspicious: KC ${suspicious.classified.score10}/10  ${suspicious.classified.bandLabel}`);
  console.log(`  abnormal:   KC ${abnormal.classified.score10}/10  ${abnormal.classified.bandLabel}`);
}

main().catch((err) => {
  console.error('[pentacam-kc.test] FAIL', err);
  process.exit(1);
});
