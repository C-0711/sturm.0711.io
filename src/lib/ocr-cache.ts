/**
 * OCR result cache, keyed by sha256 of the input file.
 *
 * Storage: <runsDir>/_ocr-cache/<sha256>.json
 *
 * The cache is ADDITIVE — we never mutate the runner's per-run artifact
 * store. A cache hit returns the previous OCR output verbatim; the run's
 * `runs/<runId>/ocr/output.json` still gets written normally so per-run
 * audit trails stay intact.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const CACHE_DIRNAME = '_ocr-cache';

export async function sha256OfFile(filePath: string): Promise<string> {
  const h = createHash('sha256');
  // For >25 MB PDFs we could stream, but readFile is simpler and the
  // file is already on local disk; OS page cache makes this cheap.
  const data = await fs.readFile(filePath);
  h.update(data);
  return h.digest('hex');
}

export interface OcrCacheEntry<T = unknown> {
  sha256: string;
  filename: string;
  size: number;
  mime: string;
  model: string;          // e.g. 'mistral-ocr-latest'
  output: T;              // the full MistralOcrOutput minus internals
  cachedAt: string;       // ISO timestamp
}

export async function readOcrCache<T = unknown>(
  runsDir: string,
  sha256: string,
): Promise<OcrCacheEntry<T> | null> {
  const p = path.join(runsDir, CACHE_DIRNAME, `${sha256}.json`);
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw) as OcrCacheEntry<T>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeOcrCache<T = unknown>(
  runsDir: string,
  sha256: string,
  entry: OcrCacheEntry<T>,
): Promise<void> {
  const dir = path.join(runsDir, CACHE_DIRNAME);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sha256}.json`),
    JSON.stringify(entry, null, 2),
    'utf-8',
  );
}
