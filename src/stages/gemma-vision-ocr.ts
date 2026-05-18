/**
 * gemma-vision-ocr — Drop-in OCR via vLLM Gemma-4 multimodal.
 *
 * Replaces mistral-ocr in workflows where Gemma-4 should own the OCR pass
 * end-to-end (no Mistral OCR fallback — strict per user directive).
 *
 * Output shape is shape-compatible with mistral-ocr / mistral-small-ocr:
 *   { model, pages[{index,markdown,chars}], text, chars, ms }
 *
 * Per-page sequential vLLM calls. For PDFs: `pdftoppm` via pdf-render lib
 * (sha256-keyed cache). For images: passed as-is.
 *
 * Prompt asks for verbatim Markdown — preserves headings, lists, tables,
 * line breaks where structurally meaningful. JSON-schema-constrained so the
 * existing vllm-vision helper can be reused; the schema is a single
 * `{ markdown: string }` envelope.
 */
import { extname } from 'node:path';
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineStage } from '../core/stage.ts';
import { renderPdfToPng } from '../lib/pdf-render.ts';
import { callVllmVision, VllmVisionError } from '../lib/vllm-vision.ts';

export interface GemmaVisionOcrInput {
  filePath: string;
  filename: string;
}

export interface GemmaVisionOcrConfig {
  /** vLLM base URL. Default: env VLLM_URL or 'http://localhost:11435'. */
  vllmUrl?: string;
  /** Served vLLM model name. Default 'gemma4-mm'. */
  model?: string;
  /** PDF render DPI. Default 200 (matches v6 spike). */
  dpi?: number;
  /** max_tokens per page. Default 4096. */
  maxTokens?: number;
  /** Per-page timeout. Default 120s. */
  timeoutMs?: number;
  /** Hard cap on rendered pages (safety). Default 32. */
  maxPages?: number;
}

export interface GemmaVisionOcrOutput {
  model: string;
  pages: Array<{ index: number; markdown: string; chars: number }>;
  text: string;
  chars: number;
  ms: number;
}

const PROMPT =
  'Transkribiere den vollständigen Inhalt dieser Dokumentseite als GitHub-' +
  'flavored Markdown. Erhalte Überschriften (#), Listen (- bzw. 1.), Tabellen ' +
  '(| … | … |) und sinnvolle Zeilenumbrüche. Gib alle sichtbaren Werte wörtlich ' +
  'wieder — Namen, Beträge, Daten, IDs, Steuernummern, eTINs. KEINE ' +
  'Erklärungen, KEINE Vorbemerkungen.';

const SCHEMA = {
  name: 'gemma_vision_ocr_page',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['markdown'],
    properties: {
      markdown: { type: 'string' },
    },
  },
} as const;

async function pagePathsForInput(
  filePath: string,
  filename: string,
  dpi: number,
  maxPages: number,
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const ext = extname(filename).toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
  if (isImage) {
    // PNG/JPG go straight in. No cleanup needed (caller-owned file).
    return { paths: [filePath], cleanup: async () => {} };
  }
  if (ext !== '.pdf') {
    throw new Error(`gemma-vision-ocr: unsupported extension ${ext}`);
  }
  const rendered = await renderPdfToPng(filePath, { dpi, maxPages });
  return { paths: rendered.pngPaths, cleanup: async () => {} };
}

export const gemmaVisionOcrStage = defineStage<
  GemmaVisionOcrInput,
  GemmaVisionOcrOutput,
  GemmaVisionOcrConfig
>({
  id: 'gemma-vision-ocr',
  name: 'Gemma-4 Vision OCR',
  description:
    'OCR via vLLM gemma4-mm multimodal. Rendert PDF-Seiten mit pdftoppm und ' +
    'extrahiert Markdown pro Seite. Drop-in für mistral-ocr (gleicher Output-' +
    'shape). Strict — kein Fallback.',
  hints: {
    inputs: 'filePath, filename',
    outputs: 'model, pages[{index,markdown,chars}], text, chars, ms',
    configExample:
      '{"vllmUrl": "http://localhost:11435", "model": "gemma4-mm", "dpi": 200, "maxTokens": 4096}',
    inputPorts: [
      { name: 'filePath', type: 'file-path' },
      { name: 'filename', type: 'string' },
    ],
    outputPorts: [
      { name: 'text', type: 'text' },
      { name: 'pages', type: 'pages' },
    ],
  },

  async run(input, ctx) {
    if (!input?.filePath) throw new Error('gemma-vision-ocr: filePath fehlt');
    if (!input?.filename) throw new Error('gemma-vision-ocr: filename fehlt');

    const t0 = Date.now();
    const vllmUrl =
      ctx.config?.vllmUrl ?? process.env['VLLM_URL'] ?? 'http://localhost:11435';
    const model = ctx.config?.model ?? 'gemma4-mm';
    const dpi = ctx.config?.dpi ?? 200;
    const maxTokens = ctx.config?.maxTokens ?? 4096;
    const timeoutMs = ctx.config?.timeoutMs ?? 120_000;
    const maxPages = ctx.config?.maxPages ?? 32;

    const { paths, cleanup } = await pagePathsForInput(
      input.filePath,
      input.filename,
      dpi,
      maxPages,
    );

    try {
      ctx.emit('gemma_vision_ocr_started', {
        pages: paths.length,
        model,
        dpi,
      });

      const pageOutputs: Array<{ index: number; markdown: string; chars: number }> = [];
      for (let i = 0; i < paths.length; i++) {
        const { parsed } = await callVllmVision<{ markdown: string }>({
          vllmUrl,
          model,
          imagePaths: [paths[i]],
          textInstructions: PROMPT,
          jsonSchema: SCHEMA,
          maxTokens,
          temperature: 0,
          timeoutMs,
          signal: ctx.signal,
        });
        const md = parsed?.markdown ?? '';
        pageOutputs.push({ index: i, markdown: md, chars: md.length });
        // Stück für Stück: 200-char Preview pro Seite, damit das UI live
        // sieht was bisher extrahiert wurde (statt "Wird verarbeitet…").
        const preview = md.replace(/\s+/g, ' ').slice(0, 200);
        ctx.emit('gemma_vision_ocr_page', {
          index: i,
          totalPages: paths.length,
          chars: md.length,
          preview,
        });
      }

      const text = pageOutputs.map((p) => p.markdown).join('\n\n');
      const ms = Date.now() - t0;
      ctx.emit('gemma_vision_ocr_done', { pages: pageOutputs.length, chars: text.length, ms });
      return {
        model,
        pages: pageOutputs,
        text,
        chars: text.length,
        ms,
      };
    } finally {
      await cleanup();
    }
  },
});
