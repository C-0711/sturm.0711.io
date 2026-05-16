/**
 * Fixture test for myopia-progression.
 *
 * Three Myopia-Master OCR fixtures: stable, slow progression, fast
 * progression in a young patient (with high-myopia escalation).
 */

import assert from 'node:assert/strict';
import { myopiaExtractStage } from './stages/extract.ts';
import { myopiaClassifyStage } from './stages/classify.ts';
import type { StageContext } from '../../core/types.ts';
import { NullToolContainer } from '../../core/tools/null-container.ts';

const noopArtifacts = {
  async write() {}, async writeBuffer() {},
  async read() { return null as any; }, async readBuffer() { return Buffer.alloc(0); },
  async exists() { return false; },
  absolutePath(p: string) { return `/tmp/${p}`; },
};
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
function makeCtx<T>(stageId: string): StageContext<T> {
  return {
    runId: 'test', workflowId: 'myopia-progression', stageId,
    config: undefined as T, logger: noopLogger, artifacts: noopArtifacts,
    emit() {}, signal: new AbortController().signal, results: {},
    tools: new NullToolContainer(),
  };
}

// 18-year-old, stable: AL 24.10 → 24.12 over 180 days = ~0.04 mm/y
const STABLE = `
  Myopia Master — Patient: PAT-AA1111  Datum: 14/03/2026  OD
  Alter: 18 Jahre
  AL aktuell 24,12 mm
  AL vorherig 24,10 mm
  Δt 180 Tage
  SE -2,25 D
  Km 43,1 D
`;

// 13-year-old, slow: AL 23.80 → 23.95 over 180 days = ~0.30 mm/y → red (≥ 0.20)
// Note: this fixture is intentionally fast to assert the red classification.
const SLOW_BUT_FAST = `
  Myopia Master — Patient: PAT-BB2222  Datum: 14/03/2026  OS
  Alter: 13 Jahre
  AL aktuell 23,95 mm
  AL vorherig 23,80 mm
  Δt 180 Tage
  SE -3,50 D
  Km 43,8 D
`;

// 8-year-old, fast progression + 0.15 mm/6mo escalates red, AL 26.4 high-myopia tag
const FAST_YOUNG = `
  Myopia Master — Patient: PAT-CC3333  Datum: 14/03/2026  OD
  Alter: 8 Jahre
  AL aktuell 26,40 mm
  AL vorherig 26,20 mm
  Δt 180 Tage
  SE -6,75 D
  Km 44,2 D
`;

async function runCase(text: string) {
  const extracted = await myopiaExtractStage.run({ text }, makeCtx('extract'));
  const classified = await myopiaClassifyStage.run({ extracted }, makeCtx('classify'));
  return { extracted, classified };
}

async function main() {
  console.log('[myopia-progression.test] running 3 fixtures …');

  const stable = await runCase(STABLE);
  assert.equal(stable.extracted.side, 'OD');
  assert.equal(stable.extracted.patientId, 'PAT-AA1111');
  assert.ok(stable.extracted.completeness >= 0.8, `stable: completeness ${stable.extracted.completeness}`);
  assert.equal(stable.classified.riskClass, 'green', `stable: risk = ${stable.classified.riskClass}`);

  const fast = await runCase(SLOW_BUT_FAST);
  assert.equal(fast.extracted.side, 'OS');
  assert.equal(fast.classified.riskClass, 'red', `fast: risk = ${fast.classified.riskClass}`);

  const young = await runCase(FAST_YOUNG);
  assert.equal(young.classified.riskClass, 'red');
  assert.ok(young.classified.tags.includes('high-myopia'), 'high-myopia tag');
  assert.ok(young.classified.tags.includes('high-degree-myopia'), 'high-degree-myopia tag');

  for (const r of [stable, fast, young]) {
    assert.ok(r.classified.disclaimer.length > 50, 'disclaimer present');
    assert.ok(r.classified.deltaAlPerYear !== null, 'Δ-AL computed');
  }

  // score10 strictly higher for fast/young than for stable.
  assert.ok(fast.classified.score10 > stable.classified.score10);
  assert.ok(young.classified.score10 >= fast.classified.score10);

  console.log('[myopia-progression.test] ALL CHECKS PASSED');
  console.log(`  stable: prog ${stable.classified.score10}/10  Δ=${stable.classified.deltaAlPerYear?.toFixed(2)} mm/y`);
  console.log(`  fast:   prog ${fast.classified.score10}/10  Δ=${fast.classified.deltaAlPerYear?.toFixed(2)} mm/y`);
  console.log(`  young:  prog ${young.classified.score10}/10  Δ=${young.classified.deltaAlPerYear?.toFixed(2)} mm/y  tags=${young.classified.tags.join(',')}`);
}

main().catch((err) => { console.error('[myopia-progression.test] FAIL', err); process.exit(1); });
