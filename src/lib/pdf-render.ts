/**
 * PDF → PNG renderer with sha256-keyed cache.
 *
 * Foundation for the v6 vision workflow: gemma4-mm needs PDF pages as PNG.
 * The 30-min spike confirmed `pdftoppm -r 200 -png` produces ~700 KB pages
 * the model reads with 93% accuracy. This wrapper caches by content hash so
 * repeated v6 runs on the same PDF render at most once.
 *
 * Layout:
 *   <cacheRoot>/<sha256>/page-1.png
 *   <cacheRoot>/<sha256>/page-2.png
 *   <cacheRoot>/<sha256>/_done.json   { pageCount, dpi }
 *
 * The cache key includes `dpi` via _done.json: a request at a different dpi
 * re-renders into the same directory (pdftoppm overwrites by name).
 *
 * Requires `pdftoppm` (poppler-utils) on PATH. Dockerfile installs it.
 */

import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface RenderOptions {
  /** Resolution in dpi. Default 200 — matches v6 vision spike (93% accuracy). */
  dpi?: number;
  /** Safety cap on page count. Default 32. */
  maxPages?: number;
  /** Cache root. Default: <cwd>/runs/_pdf_render/. */
  cacheRoot?: string;
  /** Override pdftoppm binary path. Default: 'pdftoppm' (PATH lookup). */
  pdftoppmBin?: string;
  /** Per-render timeout. Default 60s (large multi-page PDFs). */
  timeoutMs?: number;
}

export interface RenderResult {
  /** Absolute paths to rendered pages, ordered page 1..N. */
  pngPaths: string[];
  /** sha256 hex of the input PDF — also the cache directory name. */
  sha256: string;
  /** True if cached (no rendering happened this call). */
  cached: boolean;
  /** Wallclock of the render itself (0 on cache hit). */
  renderMs: number;
}

interface DoneManifest {
  pageCount: number;
  dpi: number;
}

const DEFAULT_DPI = 200;
const DEFAULT_MAX_PAGES = 32;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BIN = 'pdftoppm';

/** Stream sha256 of the file (does not load full file into memory). */
export async function sha256OfPdf(pdfPath: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(pdfPath);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return h.digest('hex');
}

/**
 * Render every page of `pdfPath` to PNG at `dpi` resolution.
 *
 * Returns absolute paths to the rendered files in numeric page order.
 * Caches under <cacheRoot>/<sha256>/page-N.png so the same PDF (by content
 * hash + same dpi) renders at most once per cache lifetime.
 *
 * Throws ENOENT if pdftoppm is missing, or wraps pdftoppm stderr on failure.
 */
export async function renderPdfToPng(
  pdfPath: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin = opts.pdftoppmBin ?? DEFAULT_BIN;
  // lint-no-env: allow — cache root default, callers can override
  const cacheRoot = opts.cacheRoot ?? path.join(process.cwd(), 'runs', '_pdf_render');

  // 1. Hash the input. Surfaces ENOENT on bad path before we touch pdftoppm.
  const sha256 = await sha256OfPdf(pdfPath);

  // 2. Check cache.
  const cacheDir = path.join(cacheRoot, sha256);
  const donePath = path.join(cacheDir, '_done.json');
  const cached = await readDone(donePath);
  if (cached && cached.dpi === dpi) {
    const pngPaths = pagePaths(cacheDir, cached.pageCount);
    // Verify all pages exist on disk; if a file was deleted out from under
    // us, fall through to re-render rather than handing back broken paths.
    const allExist = await allFilesExist(pngPaths);
    if (allExist) {
      return { pngPaths, sha256, cached: true, renderMs: 0 };
    }
  }

  // 3. Render. pdftoppm writes <cacheDir>/page-1.png, page-2.png, …
  await fs.mkdir(cacheDir, { recursive: true });
  const outPrefix = path.join(cacheDir, 'page');
  const t0 = Date.now();
  await runPdftoppm(bin, dpi, pdfPath, outPrefix, timeoutMs);
  const renderMs = Date.now() - t0;

  // 4. Discover what got rendered.
  const pageCount = await countPages(cacheDir);
  if (pageCount === 0) {
    throw new Error(
      `pdftoppm produced no output for ${pdfPath} (cache dir: ${cacheDir})`,
    );
  }
  if (pageCount > maxPages) {
    // Clean up — don't keep a partial result that exceeds the cap.
    await fs.rm(cacheDir, { recursive: true, force: true });
    throw new Error(`PDF has ${pageCount} pages, exceeds maxPages cap (${maxPages})`);
  }

  // 5. Write manifest and return.
  const manifest: DoneManifest = { pageCount, dpi };
  await fs.writeFile(donePath, JSON.stringify(manifest, null, 2), 'utf-8');
  const pngPaths = pagePaths(cacheDir, pageCount);

  return { pngPaths, sha256, cached: false, renderMs };
}

// ── internals ──────────────────────────────────────────────────────────────

async function readDone(donePath: string): Promise<DoneManifest | null> {
  try {
    const raw = await fs.readFile(donePath, 'utf-8');
    const m = JSON.parse(raw) as DoneManifest;
    if (typeof m.pageCount === 'number' && typeof m.dpi === 'number') return m;
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function pagePaths(cacheDir: string, pageCount: number): string[] {
  // pdftoppm pads page numbers to match the digit count of the total page
  // count when needed, but for our default (≤32 pages) it just uses bare
  // integers. We scan the directory rather than guessing the format.
  const out: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    out.push(path.join(cacheDir, `page-${i}.png`));
  }
  return out;
}

async function allFilesExist(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      if (!st.isFile() || st.size === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function countPages(cacheDir: string): Promise<number> {
  const entries = await fs.readdir(cacheDir);
  let max = 0;
  for (const name of entries) {
    const m = /^page-(\d+)\.png$/.exec(name);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

function runPdftoppm(
  bin: string,
  dpi: number,
  pdfPath: string,
  outPrefix: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-r', String(dpi), '-png', pdfPath, outPrefix];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let stdout = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT when bin is missing — preserve the original code for callers.
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        reject(Object.assign(
          new Error(`pdftoppm binary not found on PATH (tried: ${bin}). Install poppler-utils.`),
          { code: 'ENOENT' },
        ));
        return;
      }
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(
          `pdftoppm timed out after ${timeoutMs}ms (pdf=${pdfPath}). stderr: ${stderr.trim() || '(none)'}`,
        ));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const sig = signal ? ` signal=${signal}` : '';
      reject(new Error(
        `pdftoppm failed (exit=${code}${sig}) for ${pdfPath}. stderr: ${stderr.trim() || '(none)'}${stdout ? ` stdout: ${stdout.trim()}` : ''}`,
      ));
    });
  });
}
