import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineStage } from '../core/stage.ts';

const execFileP = promisify(execFile);

export interface PdfTextLayerInput {
  filePath: string;
  filename: string;
}

export interface PdfTextLayerConfig {
  /** Override binary path; default discovered via PATH. */
  pdftotextBin?: string;
  /** Preserve layout (passes -layout). Default true. */
  layout?: boolean;
  /** Skip files with fewer than this many characters per page on average. */
  minCharsPerPageHeuristic?: number;
}

export interface PdfTextLayerOutput {
  /** Combined page text (form-feed separated by pdftotext). */
  text: string;
  /** One entry per page, in order. */
  pages: Array<{ index: number; markdown: string; chars: number }>;
  chars: number;
  ms: number;
  /** True when the PDF clearly has an embedded text layer of usable density. */
  hasTextLayer: boolean;
}

/**
 * pdf-text-layer — extracts an embedded text layer from a PDF via `pdftotext`.
 *
 * Use case: ELSTER/WISO-printed PDFs almost always carry a clean text layer.
 * This stage is ~10 ms per page and produces no LLM cost. Returns
 * `hasTextLayer: false` when the file looks scanned (very few chars / page),
 * so a downstream router can fall back to a real OCR engine.
 */
export const pdfTextLayerStage = defineStage<PdfTextLayerInput, PdfTextLayerOutput, PdfTextLayerConfig>({
  id: 'extract/pdf-text-layer',
  name: 'PDF Text-Layer (pdftotext)',
  description:
    'Extracts the embedded text layer from a PDF using `pdftotext`. ~10 ms per ' +
    'page, no LLM cost. Reports hasTextLayer=false when the document looks ' +
    'scanned, so a router can fall back to OCR.',
  hints: {
    inputs: 'filePath (string, absolute), filename (string)',
    outputs: 'text, pages[{index,markdown,chars}], chars, ms, hasTextLayer',
    configExample: '{"layout": true, "minCharsPerPageHeuristic": 50}',
    inputPorts: [
      { name: 'filePath', type: 'file-path' },
      { name: 'filename', type: 'string' },
    ],
    outputPorts: [
      { name: 'text', type: 'text' },
      { name: 'pages', type: 'pages' },
      { name: 'hasTextLayer', type: 'boolean' },
    ],
  },

  async run(input, ctx) {
    if (!input?.filePath) throw new Error('pdf-text-layer: filePath fehlt');
    const t0 = Date.now();
    const bin = ctx.config?.pdftotextBin ?? 'pdftotext';
    const layout = ctx.config?.layout !== false;
    const minPerPage = ctx.config?.minCharsPerPageHeuristic ?? 50;

    const args: string[] = [];
    if (layout) args.push('-layout');
    args.push('-q'); // quiet
    args.push(input.filePath);
    args.push('-'); // stdout

    let stdout = '';
    try {
      const r = await execFileP(bin, args, { maxBuffer: 64 * 1024 * 1024, signal: ctx.signal });
      stdout = r.stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // ENOENT → binary missing. Don't crash the whole compare/fanout — return empty.
      if (/ENOENT|not found|command not found/i.test(msg)) {
        ctx.logger.warn(`pdf-text-layer: pdftotext not installed (${msg.split('\n')[0]}) — returning empty`);
        return { text: '', pages: [], chars: 0, ms: Date.now() - t0, hasTextLayer: false };
      }
      throw new Error(`pdf-text-layer: ${msg}`);
    }

    // pdftotext separates pages by form-feed (\f).
    const rawPages = stdout.split('\f');
    // Trailing empty page from final \f is normal — strip.
    while (rawPages.length && rawPages[rawPages.length - 1].trim() === '') rawPages.pop();
    const pages = rawPages.map((markdown, index) => ({
      index,
      markdown: markdown.trim(),
      chars: markdown.trim().length,
    }));
    const chars = pages.reduce((s, p) => s + p.chars, 0);
    const avgPerPage = pages.length ? chars / pages.length : 0;
    const hasTextLayer = pages.length > 0 && avgPerPage >= minPerPage;
    const ms = Date.now() - t0;
    ctx.emit('text_layer_done', { pages: pages.length, chars, hasTextLayer, ms });
    return { text: pages.map((p) => p.markdown).join('\n\n'), pages, chars, ms, hasTextLayer };
  },
});
