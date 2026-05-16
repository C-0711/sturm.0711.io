/**
 * rag-index Resolver — verifiziert Index-Sharing (per containerId+manifest)
 * + Manifest-Probe für health().
 *
 * Run: tsx src/core/tools/resolvers/rag-index.test.ts
 */

import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRagIndex, probeRagHealth, _resetRagRegistry, _ragRegistrySize } from './rag-index.ts';
import type { RagIndexToolRef } from '../types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

const REAL_MANIFEST = 'src/verticals/elster-v3/data/embeddings.gemma4.cascade.json';

(async () => {
  console.log('\n=== resolveRagIndex returns RagIndexHandle (no eager load) ===');
  _resetRagRegistry();
  const ref: RagIndexToolRef = {
    name: 'test-rag', kind: 'rag-index', required: false, alwaysOn: false,
    config: {
      containerId: 'test:c1', manifest: REAL_MANIFEST,
      strategy: 'turboquant-cascade',
      tiers: ['d128'], topK: { d128: 8 },
    },
  };
  const h = await resolveRagIndex(ref);
  assert('handle has kind=rag-index', h.kind === 'rag-index');
  assert('meta.containerId set', h.meta.containerId === 'test:c1');
  assert('registry empty without alwaysOn', _ragRegistrySize() === 0);

  console.log('\n=== alwaysOn=true triggers eager shared load ===');
  _resetRagRegistry();
  const refEager: RagIndexToolRef = { ...ref, alwaysOn: true };
  await resolveRagIndex(refEager);
  assert('registry has 1 entry after eager resolve', _ragRegistrySize() === 1);

  // Second resolve same key MUST reuse the same promise → registry stays at 1
  await resolveRagIndex(refEager);
  assert('registry still 1 after duplicate resolve (sharing)', _ragRegistrySize() === 1);

  // Different containerId/manifest combo → 2 entries
  const refOther: RagIndexToolRef = {
    ...refEager,
    config: { ...refEager.config, containerId: 'test:c2' },
  };
  await resolveRagIndex(refOther);
  assert('registry has 2 entries for different key', _ragRegistrySize() === 2);

  console.log('\n=== probeRagHealth: bad manifest path → !alive ===');
  const badRef: RagIndexToolRef = {
    ...ref,
    config: { ...ref.config, manifest: 'does/not/exist/manifest.json' },
  };
  const hh = await probeRagHealth(badRef);
  assert('bad manifest → !alive', hh.alive === false);
  assert('bad manifest → !configured', hh.configured === false);
  assert('bad manifest has lastError', !!hh.lastError);

  console.log('\n=== probeRagHealth: real manifest → alive ===');
  const hh2 = await probeRagHealth(ref);
  assert('real manifest → alive', hh2.alive === true);
  assert('real manifest → configured', hh2.configured === true);

  console.log('\n=== probeRagHealth: empty-tiers manifest → !alive ===');
  const tmp = await mkdtemp(join(tmpdir(), 'sturm-rag-test-'));
  try {
    const emptyPath = join(tmp, 'empty.json');
    await writeFile(emptyPath, JSON.stringify({ containerId: 'x', nativeDim: 768, tiers: [] }));
    const emptyRef: RagIndexToolRef = { ...ref, config: { ...ref.config, manifest: emptyPath } };
    const hh3 = await probeRagHealth(emptyRef);
    assert('empty-tiers manifest → !alive', hh3.alive === false);
    assert('empty-tiers manifest lastError', !!hh3.lastError);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  _resetRagRegistry();
  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
