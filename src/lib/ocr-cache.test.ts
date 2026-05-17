/**
 * Run: node --test --import tsx src/lib/ocr-cache.test.ts
 *
 * Covers the sha256-keyed OCR cache used by the mistral-ocr stage to skip
 * re-OCR of identical PDFs (frequent during testing + inbox re-runs).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  readOcrCache,
  writeOcrCache,
  sha256OfFile,
  type OcrCacheEntry,
} from './ocr-cache.ts';

async function makeTmpRunsDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ocr-cache-test-'));
}

interface FakeOcrOutput {
  model: string;
  text: string;
  pages: Array<{ index: number; markdown: string; chars: number }>;
}

function fakeEntry(sha: string, model = 'mistral-ocr-latest'): OcrCacheEntry<FakeOcrOutput> {
  return {
    sha256: sha,
    filename: 'rechnung.pdf',
    size: 12345,
    mime: 'application/pdf',
    model,
    output: {
      model,
      text: 'Rechnung Nr. 4711\nBetrag: 100,00 EUR',
      pages: [{ index: 0, markdown: 'Rechnung Nr. 4711\nBetrag: 100,00 EUR', chars: 36 }],
    },
    cachedAt: '2026-05-16T12:00:00.000Z',
  };
}

test('writeOcrCache + readOcrCache round-trip preserves all fields', async () => {
  const runsDir = await makeTmpRunsDir();
  const sha = 'a'.repeat(64);
  const entry = fakeEntry(sha);

  await writeOcrCache(runsDir, sha, entry);
  const got = await readOcrCache<FakeOcrOutput>(runsDir, sha);

  assert.ok(got, 'expected cache hit');
  assert.deepEqual(got, entry);
  assert.equal(got!.output.text, entry.output.text);
  assert.equal(got!.output.pages.length, 1);

  await fs.rm(runsDir, { recursive: true, force: true });
});

test('readOcrCache returns null for unknown sha (no throw)', async () => {
  const runsDir = await makeTmpRunsDir();
  const got = await readOcrCache(runsDir, 'b'.repeat(64));
  assert.equal(got, null);
  await fs.rm(runsDir, { recursive: true, force: true });
});

test('different sha256 → different file (cache isolation)', async () => {
  const runsDir = await makeTmpRunsDir();
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);

  await writeOcrCache(runsDir, shaA, fakeEntry(shaA));
  await writeOcrCache(runsDir, shaB, { ...fakeEntry(shaB), filename: 'andere.pdf' });

  const gotA = await readOcrCache<FakeOcrOutput>(runsDir, shaA);
  const gotB = await readOcrCache<FakeOcrOutput>(runsDir, shaB);

  assert.ok(gotA && gotB);
  assert.equal(gotA!.filename, 'rechnung.pdf');
  assert.equal(gotB!.filename, 'andere.pdf');
  assert.notEqual(gotA!.sha256, gotB!.sha256);

  // Sanity-check the on-disk layout: two distinct files under _ocr-cache/.
  const files = await fs.readdir(path.join(runsDir, '_ocr-cache'));
  assert.equal(files.length, 2);
  assert.ok(files.includes(`${shaA}.json`));
  assert.ok(files.includes(`${shaB}.json`));

  await fs.rm(runsDir, { recursive: true, force: true });
});

test('sha256OfFile is deterministic and matches a known fixture', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-sha-test-'));
  const f = path.join(tmp, 'foo.bin');
  await fs.writeFile(f, 'hello world');

  // sha256('hello world') is well-known:
  const expected = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
  const got1 = await sha256OfFile(f);
  const got2 = await sha256OfFile(f);
  assert.equal(got1, expected);
  assert.equal(got2, expected);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('writeOcrCache creates parent directory if missing', async () => {
  const runsDir = await makeTmpRunsDir();
  // Nuke the runs dir to a fresh empty one, no _ocr-cache subdir.
  await fs.rm(runsDir, { recursive: true, force: true });
  await fs.mkdir(runsDir, { recursive: true });

  const sha = 'c'.repeat(64);
  await writeOcrCache(runsDir, sha, fakeEntry(sha));

  const got = await readOcrCache<FakeOcrOutput>(runsDir, sha);
  assert.ok(got, 'expected cache hit after auto-mkdir');

  await fs.rm(runsDir, { recursive: true, force: true });
});
