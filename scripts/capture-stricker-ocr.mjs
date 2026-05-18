#!/usr/bin/env node
/**
 * capture-stricker-ocr.mjs — one-shot: render Stricker PDF to PNG, OCR
 * via Mistral Small chat-vision, save the result as a test fixture.
 *
 * Why this exists: the v6 phase3-vision-fill page-Zeile filter needs
 * real OCR text with Zeile markers preserved. We capture Mistral Small's
 * output once on h200v, commit as fixture, tests run hermetically.
 *
 * Usage (on h200v inside the sturm container):
 *   docker exec sturm npx tsx scripts/capture-stricker-ocr.mjs \
 *     /home/christoph.bertsch/dev-cb-ctax/test-data/stricker/stricker_est_2023.pdf \
 *     /app/tests/fixtures/stricker-ocr-mistral-small.json
 *
 * The host path doesn't matter; the script reads whatever PDF you point
 * it at and writes the JSON wherever you say.
 */
import { renderPdfToPng } from '../src/lib/pdf-render.ts';
import { ocrViaMistralSmall } from '../src/lib/ocr-mistral-small.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const [, , inPdf, outJson] = process.argv;
if (!inPdf || !outJson) {
  console.error('Usage: capture-stricker-ocr.mjs <input.pdf> <output.json>');
  process.exit(2);
}

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) {
  console.error('MISTRAL_API_KEY env required');
  process.exit(2);
}

console.log(`[1/3] Rendering ${path.basename(inPdf)} to PNGs @ 200dpi…`);
const t0 = Date.now();
const render = await renderPdfToPng(inPdf, { dpi: 200 });
console.log(`     → ${render.pngPaths.length} pages, sha256=${render.sha256.slice(0, 12)}, cached=${render.cached}, ${Date.now() - t0}ms`);

console.log(`[2/3] OCR via Mistral Small (mistral-small-latest)…`);
const t1 = Date.now();
const ocr = await ocrViaMistralSmall({
  pngPaths: render.pngPaths,
  apiKey,
  // Conservative — Mistral Small can be slow on dense pages.
  timeoutMs: 120_000,
});
console.log(`     → ${ocr.pages.length} pages, ${ocr.charCount} chars, ${ocr.ms}ms`);

console.log(`[3/3] Writing fixture to ${outJson}…`);
const dir = path.dirname(outJson);
await fs.mkdir(dir, { recursive: true });
const fixture = {
  generatedAt: new Date().toISOString(),
  sourcePdf: path.basename(inPdf),
  sha256: render.sha256,
  renderDpi: 200,
  ocrModel: 'mistral-small-latest',
  ocrMs: ocr.ms,
  ocrCharCount: ocr.charCount,
  pages: ocr.pages,
  markdown: ocr.markdown,
};
await fs.writeFile(outJson, JSON.stringify(fixture, null, 2));
console.log(`     ✓ ${outJson} (${(await fs.stat(outJson)).size} bytes)`);

// Per-page preview: first 200 chars + Zeile-count
console.log('\nPer-page summary:');
for (const p of ocr.pages) {
  const zMatches = [...p.markdown.matchAll(/(?:^|\n|\|)\s*(\d{1,3})\s+[A-ZÄÖÜa-zäöü]/g)];
  const zeilen = new Set(zMatches.map((m) => m[1]));
  console.log(`  page ${p.index + 1}: ${p.markdown.length} chars, ${zeilen.size} unique Zeile-anchors`);
  console.log(`    preview: ${p.markdown.slice(0, 160).replace(/\n/g, ' ⏎ ')}`);
}
