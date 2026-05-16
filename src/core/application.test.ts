/**
 * Tests für `desugarLegacyTools` und `resolveTools`: stellt sicher, dass eine
 * Anwendung, die nur das legacy `mcps` + `rag`-Sugar deklariert hat, denselben
 * `ToolRef[]`-Output produziert wie ein expliziter P1-Roster für den
 * überlappenden Anteil. `def.tools` (wenn gesetzt) muss `resolveTools`
 * gewinnen lassen.
 *
 * Run: tsx src/core/application.test.ts
 */

import {
  defineApplication,
  desugarLegacyTools,
  resolveTools,
} from './application.ts';
import type { ToolRef } from './tools/types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}
function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? undefined : { actual, expected });
}

// ── Minimal legacy-shape ApplicationDef ────────────────────────────────

const legacyDef = defineApplication({
  id: 'legacy-test',
  name: 'Legacy-Test-Anwendung',
  description: 'Nutzt nur das alte mcps + rag-Sugar.',
  category: 'other',
  mandantRequired: false,
  workflows: { extraction: 'noop' },
  mcps: {
    'bmf-lane1': {
      envVar: 'BMF_MCP_URL',
      url: 'http://localhost:12010/mcp',
      tools: ['berechne_vollstaendige_steuer_v2'],
    },
    'bmf-lane5': {
      envVar: 'ELSTER_MCP_URL',
      tools: ['elster_einreichen'],
    },
  },
  rag: {
    containerId: '0711:elster:bmf:jahresdok-2024:v1',
    indexPath: 'src/verticals/elster-v3/data/embeddings.gemma4.tq-d128.bin',
    strategy: 'turboquant-cascade',
  },
});

const expectedDesugared: ToolRef[] = [
  {
    name: 'bmf-lane1',
    kind: 'mcp',
    required: false,
    config: {
      envUrl: 'BMF_MCP_URL',
      defaultUrl: 'http://localhost:12010/mcp',
      tools: ['berechne_vollstaendige_steuer_v2'],
    },
    roles: ['bmf-lane1'],
  },
  {
    name: 'bmf-lane5',
    kind: 'mcp',
    required: false,
    config: {
      envUrl: 'ELSTER_MCP_URL',
      defaultUrl: undefined,
      tools: ['elster_einreichen'],
    },
    roles: ['bmf-lane5'],
  },
  {
    name: 'rag',
    kind: 'rag-index',
    required: true,
    alwaysOn: true,
    config: {
      containerId: '0711:elster:bmf:jahresdok-2024:v1',
      manifest: 'src/verticals/elster-v3/data/embeddings.gemma4.tq-d128.bin',
      strategy: 'turboquant-cascade',
      tiers: ['d128', 'd256', 'd768', 'fp32'],
      topK: { d128: 512, d256: 128, d768: 32, fp32: 8 },
    },
  },
];

console.log('\n=== desugarLegacyTools snapshot ===');
const desugared = desugarLegacyTools(legacyDef);
eq('desugared roster matches snapshot', desugared, expectedDesugared);

console.log('\n=== resolveTools falls back to desugar when tools[] missing ===');
const resolvedLegacy = resolveTools(legacyDef);
eq('resolveTools without tools[] equals desugar', resolvedLegacy, expectedDesugared);

console.log('\n=== resolveTools prefers explicit def.tools when present ===');
const explicit: ToolRef[] = [
  {
    name: 'only-tool',
    kind: 'kv',
    required: false,
    config: { backend: 'redis', envUrl: 'REDIS_URL' },
  },
];
const withTools = defineApplication({
  ...legacyDef,
  id: 'legacy-test-explicit',
  tools: explicit,
});
const resolvedExplicit = resolveTools(withTools);
eq('resolveTools returns explicit tools[]', resolvedExplicit, explicit);
assert('resolveTools does not concatenate with legacy', resolvedExplicit.length === 1);

console.log('\n=== desugar is pure (no mutation of input) ===');
const before = JSON.stringify(legacyDef);
desugarLegacyTools(legacyDef);
resolveTools(legacyDef);
const after = JSON.stringify(legacyDef);
eq('legacyDef unchanged after desugar+resolve', after, before);

console.log('\n=== Empty input → empty roster ===');
const empty = defineApplication({
  id: 'empty', name: 'Empty', description: 'no mcps no rag',
  category: 'other', mandantRequired: false,
  workflows: { extraction: 'noop' },
});
eq('desugar(empty) → []', desugarLegacyTools(empty), []);
eq('resolveTools(empty) → []', resolveTools(empty), []);

console.log(`\nResult: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
