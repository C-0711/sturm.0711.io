/**
 * Confidence-shape probe: calls Mistral OCR with confidence_scores_granularity:
 * "word" against a small PDF and dumps the raw page-level extras to stdout
 * + docs/mistral-confidence-shape.json.
 *
 * Decides whether we have word-level positions to overlay on the PDF iframe.
 *
 * Run: tsx e2e-confidence.ts <path/to/pdf>
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  callMistralOcrWithFallback,
  configToApiRequest,
  fileToDataUriChunk,
} from './src/lib/mistral-ocr/index.ts';

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) { console.error('usage: tsx e2e-confidence.ts <pdf-or-image>'); process.exit(2); }
  if (!process.env.MISTRAL_API_KEY) { console.error('MISTRAL_API_KEY missing'); process.exit(2); }
  const filename = path.basename(inputPath);
  const document = await fileToDataUriChunk(inputPath, filename);
  const apiReq = configToApiRequest(
    { confidenceScoresGranularity: 'word' },
    document,
    { runId: 'probe', stageId: 'confidence' },
  );
  console.log('[probe] sending', filename, 'with confidence_scores_granularity=word');
  const t0 = Date.now();
  const { response, degradation } = await callMistralOcrWithFallback(apiReq);
  console.log('[probe] response in', Date.now() - t0, 'ms; degradation:', degradation ?? 'none');

  const sample = {
    model: response.model,
    pageCount: response.pages.length,
    pages: response.pages.map((p, i) => {
      const out: Record<string, unknown> = { index: p.index };
      const known = new Set([
        'index', 'markdown', 'dimensions', 'header', 'footer', 'hyperlinks', 'images', 'tables',
      ]);
      for (const [k, v] of Object.entries(p as unknown as Record<string, unknown>)) {
        if (!known.has(k)) out[k] = v;
      }
      // For tables, capture word_confidence_scores too.
      if (p.tables?.length) out.tableConfidenceSamples = p.tables.map((t) => ({ id: t.id, word_confidence_scores: (t as unknown as { word_confidence_scores?: unknown }).word_confidence_scores ?? null }));
      console.log(`[probe] page ${i} extra keys:`, Object.keys(out).filter((k) => k !== 'index'));
      return out;
    }),
    rawFirstPage: response.pages[0] ?? null,
  };

  await fs.mkdir('docs', { recursive: true });
  const outPath = 'docs/mistral-confidence-shape.json';
  await fs.writeFile(outPath, JSON.stringify(sample, null, 2));
  console.log('[probe] wrote', outPath);
}

main().catch((e) => { console.error('[probe] failed:', e); process.exit(1); });
