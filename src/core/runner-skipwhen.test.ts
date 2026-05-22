/**
 * Tests für `StageDef.skipWhen` — conditional stage-skipping.
 *
 * Covers:
 *   1. evaluateCondition pure-Funktion: ==, !=, &&, ||, truthy, literals
 *   2. Runner: skipWhen=true → state='skipped', stage_skipped emit, output=undefined
 *   3. Downstream: ${skipped.x} resolved zu undefined ohne Crash
 *   4. Mehrere parallele Stages in einer Layer mit unterschiedlichen skipWhen-Ergebnissen
 *
 * Run: tsx src/core/runner-skipwhen.test.ts
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { defineStage } from './stage.ts';
import { defineWorkflow } from './workflow.ts';
import { registerStage } from './registry.ts';
import { runWorkflow, evaluateCondition } from './runner.ts';
import type { StageContext } from './types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

// ── 1. evaluateCondition unit-tests ─────────────────────────────────
console.log('\n1. evaluateCondition()');
{
  const out = { klass: { doc_type: 'vast_bundle', steuerjahr: 2024 } };
  assert('== literal match', evaluateCondition('${klass.doc_type} == "vast_bundle"', out, {}) === true);
  assert('== literal no-match', evaluateCondition('${klass.doc_type} == "einzelbeleg"', out, {}) === false);
  assert('!= literal match (negated)', evaluateCondition('${klass.doc_type} != "vast_bundle"', out, {}) === false);
  assert('!= literal no-match (negated)', evaluateCondition('${klass.doc_type} != "einzelbeleg"', out, {}) === true);
  assert('truthy check on existing path', evaluateCondition('${klass.steuerjahr}', out, {}) === true);
  assert('truthy check on missing path', evaluateCondition('${klass.missing}', out, {}) === false);
  assert('&& both true', evaluateCondition('${klass.doc_type} == "vast_bundle" && ${klass.steuerjahr} == 2024', out, {}) === true);
  assert('&& one false', evaluateCondition('${klass.doc_type} == "vast_bundle" && ${klass.steuerjahr} == 2023', out, {}) === false);
  assert('|| one true', evaluateCondition('${klass.doc_type} == "einzelbeleg" || ${klass.steuerjahr} == 2024', out, {}) === true);
  assert('|| both false', evaluateCondition('${klass.doc_type} == "einzelbeleg" || ${klass.steuerjahr} == 2099', out, {}) === false);
  assert('empty string → false', evaluateCondition('', out, {}) === false);
}

// ── 2-4. Runner integration tests ───────────────────────────────────
console.log('\n2-4. Runner integration');
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skipwhen-test-'));

  // Define three test stages
  registerStage(defineStage<{ docType: string }, { docType: string; steuerjahr: number }, Record<string, unknown>>({
    id: 'test/classifier', name: 'test classifier',
    async run(input) {
      return { docType: input.docType, steuerjahr: 2024 };
    },
  }));
  registerStage(defineStage<{ payload: string }, { processed: string }, Record<string, unknown>>({
    id: 'test/vast-mapper', name: 'test vast mapper',
    async run(input) {
      return { processed: `VAST(${input.payload})` };
    },
  }));
  registerStage(defineStage<{ payload: string }, { processed: string }, Record<string, unknown>>({
    id: 'test/ese-mapper', name: 'test ese mapper',
    async run(input) {
      return { processed: `ESE(${input.payload})` };
    },
  }));
  registerStage(defineStage<
    { vastOut?: unknown; eseOut?: unknown },
    { merged: unknown },
    Record<string, unknown>
  >({
    id: 'test/finalize', name: 'test finalize',
    async run(input) {
      return { merged: input.vastOut ?? input.eseOut ?? null };
    },
  }));

  const wf = defineWorkflow({
    id: 'test/v5_4-conditional',
    name: 'Test conditional routing',
    description: '',
    input: { type: 'json' },
    stages: {
      classifier: { uses: 'test/classifier', inputs: { docType: '${input.docType}' } },
      vastMapper: {
        uses: 'test/vast-mapper',
        inputs: { payload: '${input.payload}' },
        skipWhen: '${classifier.docType} != "vast_bundle"',
      },
      eseMapper: {
        uses: 'test/ese-mapper',
        inputs: { payload: '${input.payload}' },
        skipWhen: '${classifier.docType} != "ese"',
      },
      finalize: {
        uses: 'test/finalize',
        inputs: { vastOut: '${vastMapper.processed}', eseOut: '${eseMapper.processed}' },
      },
    },
    edges: [
      ['classifier', 'vastMapper'],
      ['classifier', 'eseMapper'],
      ['vastMapper', 'finalize'],
      ['eseMapper', 'finalize'],
    ],
  });

  // ── Case A: docType=vast_bundle → vastMapper läuft, eseMapper skipped ─
  const skipEvents_a: Array<{ stageId?: string; payload: unknown }> = [];
  const run_a = runWorkflow(wf, {
    runsDir: tmp,
    input: { docType: 'vast_bundle', payload: 'hello' },
    onEvent: (name, payload, stageId) => {
      if (name === 'stage_skipped') skipEvents_a.push({ stageId, payload });
    },
  });
  const r_a = await run_a.result;
  assert('Case A: overall state ok', r_a.state === 'ok', r_a);
  assert('Case A: classifier ran', r_a.stages.classifier?.state === 'ok');
  assert('Case A: vastMapper ran', r_a.stages.vastMapper?.state === 'ok');
  assert('Case A: eseMapper SKIPPED', r_a.stages.eseMapper?.state === 'skipped');
  assert('Case A: stage_skipped event for eseMapper', skipEvents_a.some((e) => e.stageId === 'eseMapper'));
  assert(
    'Case A: finalize merged = VAST(hello)',
    (r_a.stages.finalize?.output as { merged: string } | undefined)?.merged === 'VAST(hello)',
    r_a.stages.finalize?.output,
  );

  // ── Case B: docType=ese → eseMapper läuft, vastMapper skipped ──────
  const skipEvents_b: Array<{ stageId?: string }> = [];
  const run_b = runWorkflow(wf, {
    runsDir: tmp,
    input: { docType: 'ese', payload: 'world' },
    onEvent: (name, _payload, stageId) => {
      if (name === 'stage_skipped') skipEvents_b.push({ stageId });
    },
  });
  const r_b = await run_b.result;
  assert('Case B: vastMapper SKIPPED', r_b.stages.vastMapper?.state === 'skipped');
  assert('Case B: eseMapper ran', r_b.stages.eseMapper?.state === 'ok');
  assert(
    'Case B: finalize merged = ESE(world)',
    (r_b.stages.finalize?.output as { merged: string } | undefined)?.merged === 'ESE(world)',
  );

  // ── Case C: docType=einzelbeleg → BOTH skipped, finalize gets nulls ─
  const run_c = runWorkflow(wf, {
    runsDir: tmp,
    input: { docType: 'einzelbeleg', payload: 'orphan' },
  });
  const r_c = await run_c.result;
  assert('Case C: vastMapper SKIPPED', r_c.stages.vastMapper?.state === 'skipped');
  assert('Case C: eseMapper SKIPPED', r_c.stages.eseMapper?.state === 'skipped');
  assert('Case C: finalize ran trotzdem', r_c.stages.finalize?.state === 'ok');
  assert(
    'Case C: finalize merged = null (no upstream output)',
    (r_c.stages.finalize?.output as { merged: unknown } | undefined)?.merged === null,
    r_c.stages.finalize?.output,
  );

  await fs.rm(tmp, { recursive: true, force: true });
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length > 0) {
    console.log('Failures:'); for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}).catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
