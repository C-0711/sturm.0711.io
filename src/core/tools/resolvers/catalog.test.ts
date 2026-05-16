/**
 * catalog Resolver — verifies atoms/container/nested loading aus tmp-Dir.
 *
 * Run: tsx src/core/tools/resolvers/catalog.test.ts
 */

import { writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { resolveCatalog, probeCatalogHealth } from './catalog.ts';
import type { CatalogToolRef } from '../types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

(async () => {
  console.log('\n=== resolveCatalog loads atoms + container + nested/*.json ===');
  const tmp = await mkdtemp(join(tmpdir(), 'sturm-cat-test-'));
  try {
    const atomsPath = join(tmp, 'atoms.json');
    const containerPath = join(tmp, 'container.json');
    const nestedDir = join(tmp, 'nested');
    await mkdir(nestedDir);

    await writeFile(atomsPath, JSON.stringify([{ eCode: 'E0200204', label: 'Bruttoarbeitslohn' }]));
    await writeFile(containerPath, JSON.stringify({ id: 'test:container', version: 'v1' }));
    await writeFile(join(nestedDir, 'lohnsteuer.json'), JSON.stringify({ type: 'lohn' }));
    await writeFile(join(nestedDir, 'spenden.json'), JSON.stringify({ type: 'spende' }));
    // Not a .json — must be ignored
    await writeFile(join(nestedDir, 'README.txt'), 'ignore me');

    // Catalog resolver resolves paths relative to process.cwd. Convert.
    const ref: CatalogToolRef = {
      name: 'test-cat', kind: 'catalog', required: false,
      config: {
        containerId: 'test:c1',
        files: {
          atoms: relative(process.cwd(), atomsPath),
          container: relative(process.cwd(), containerPath),
          nested: relative(process.cwd(), nestedDir),
        },
      },
    };

    const h = await resolveCatalog(ref);
    assert('handle kind = catalog', h.kind === 'catalog');
    assert('handle name', h.name === 'test-cat');
    assert('meta.containerId', h.meta.containerId === 'test:c1');

    const atoms = h.get<Array<{ eCode: string }>>('atoms');
    assert('atoms loaded', Array.isArray(atoms) && atoms[0].eCode === 'E0200204');

    const container = h.get<{ id: string }>('container');
    assert('container loaded', container.id === 'test:container');

    const nested = h.get<Record<string, { type: string }>>('nested');
    assert('nested has 2 entries', Object.keys(nested).length === 2);
    assert('nested keys are basenames', nested.lohnsteuer.type === 'lohn' && nested.spenden.type === 'spende');
    assert('nested ignores .txt', !('README' in nested));

    console.log('\n=== health() on loaded catalog → alive ===');
    const hh = await h.health();
    assert('health.alive = true', hh.alive === true);
    assert('health.configured = true', hh.configured === true);

    console.log('\n=== get(missing key) throws ===');
    const ref2: CatalogToolRef = {
      name: 'test-cat-min', kind: 'catalog', required: false,
      config: { containerId: 'x', files: { nested: relative(process.cwd(), nestedDir) } },
    };
    const h2 = await resolveCatalog(ref2);
    let threw = false;
    try { h2.get('atoms'); } catch { threw = true; }
    assert('get("atoms") throws when not declared', threw);
    threw = false;
    try { h2.get('container'); } catch { threw = true; }
    assert('get("container") throws when not declared', threw);

    console.log('\n=== probeCatalogHealth (no files) → !alive ===');
    const noFilesRef: CatalogToolRef = {
      name: 'no-files', kind: 'catalog', required: false,
      config: { containerId: 'x', files: {} },
    };
    const hh3 = await probeCatalogHealth(noFilesRef);
    assert('no-files !alive', hh3.alive === false);
    assert('no-files !configured', hh3.configured === false);

    console.log('\n=== probeCatalogHealth (bad path) → !alive ===');
    const badRef: CatalogToolRef = {
      name: 'bad', kind: 'catalog', required: false,
      config: { containerId: 'x', files: { atoms: 'does/not/exist.json' } },
    };
    const hh4 = await probeCatalogHealth(badRef);
    assert('bad path !alive', hh4.alive === false);
    assert('bad path has lastError', !!hh4.lastError);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
