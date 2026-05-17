/**
 * Run: node --test --import tsx src/lib/pdf-render.test.ts
 *
 * Covers the PDF→PNG renderer used by the v6 vision workflow.
 * Skips pdftoppm-dependent cases when SKIP_PDFTOPPM_TESTS=1.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { renderPdfToPng, sha256OfPdf } from './pdf-render.ts';

const FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'tests',
  'fixtures',
  'stricker',
  'stricker_vast.pdf',
);

const SKIP_PDFTOPPM = process.env.SKIP_PDFTOPPM_TESTS === '1';

async function makeTmpCache(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pdf-render-test-'));
}

test('sha256OfPdf returns 64-char hex and is deterministic', async () => {
  const a = await sha256OfPdf(FIXTURE);
  const b = await sha256OfPdf(FIXTURE);
  assert.equal(a.length, 64, `got ${a.length}-char hash: ${a}`);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b, 'sha256 not deterministic across two reads');
});

test('sha256OfPdf throws ENOENT on bad path', async () => {
  await assert.rejects(
    sha256OfPdf('/nonexistent/path/does/not/exist.pdf'),
    (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
  );
});

test('renderPdfToPng renders at least one non-empty PNG', { skip: SKIP_PDFTOPPM ? 'SKIP_PDFTOPPM_TESTS=1' : false }, async () => {
  const cacheRoot = await makeTmpCache();
  try {
    const r = await renderPdfToPng(FIXTURE, { cacheRoot });
    assert.ok(r.pngPaths.length >= 1, 'expected at least 1 page');
    assert.equal(r.cached, false, 'first call should not be cached');
    assert.ok(r.renderMs > 0, 'renderMs should be > 0 on first call');
    assert.match(r.sha256, /^[0-9a-f]{64}$/);

    for (const p of r.pngPaths) {
      const st = await fs.stat(p);
      assert.ok(st.isFile(), `${p} is not a file`);
      assert.ok(st.size > 0, `${p} is empty`);
      // PNG magic: 89 50 4E 47 0D 0A 1A 0A
      const fd = await fs.open(p, 'r');
      const buf = Buffer.alloc(8);
      await fd.read(buf, 0, 8, 0);
      await fd.close();
      assert.deepEqual(
        Array.from(buf),
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        `${p} is not a valid PNG`,
      );
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test('renderPdfToPng second call is cache hit (cached:true, renderMs:0)', { skip: SKIP_PDFTOPPM ? 'SKIP_PDFTOPPM_TESTS=1' : false }, async () => {
  const cacheRoot = await makeTmpCache();
  try {
    const first = await renderPdfToPng(FIXTURE, { cacheRoot });
    const second = await renderPdfToPng(FIXTURE, { cacheRoot });

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.renderMs, 0);
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.pngPaths, second.pngPaths);
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test('renderPdfToPng with different dpi busts the cache', { skip: SKIP_PDFTOPPM ? 'SKIP_PDFTOPPM_TESTS=1' : false }, async () => {
  const cacheRoot = await makeTmpCache();
  try {
    const r200 = await renderPdfToPng(FIXTURE, { cacheRoot, dpi: 200 });
    assert.equal(r200.cached, false);

    // Same dpi → cache hit.
    const r200b = await renderPdfToPng(FIXTURE, { cacheRoot, dpi: 200 });
    assert.equal(r200b.cached, true);

    // Different dpi → re-render (cache:false again, renderMs > 0).
    const r100 = await renderPdfToPng(FIXTURE, { cacheRoot, dpi: 100 });
    assert.equal(r100.cached, false, 'dpi change should bust cache');
    assert.ok(r100.renderMs > 0);
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test('renderPdfToPng with maxPages:0 throws', { skip: SKIP_PDFTOPPM ? 'SKIP_PDFTOPPM_TESTS=1' : false }, async () => {
  const cacheRoot = await makeTmpCache();
  try {
    await assert.rejects(
      renderPdfToPng(FIXTURE, { cacheRoot, maxPages: 0 }),
      /exceeds maxPages cap/,
    );
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test('renderPdfToPng throws ENOENT on bad pdf path', async () => {
  const cacheRoot = await makeTmpCache();
  try {
    await assert.rejects(
      renderPdfToPng('/nonexistent/foo.pdf', { cacheRoot }),
      (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
    );
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});
