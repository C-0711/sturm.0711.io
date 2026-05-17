import { readFile } from 'node:fs/promises';
import { defineStage } from '../core/stage.ts';

export interface PaddleOcrVlInput {
  filePath: string;
  filename: string;
}

export interface PaddleOcrVlConfig {
  /** Base URL of the paddleocr-vl HTTP server. Default env PADDLEOCR_URL or http://localhost:11438. */
  baseUrl?: string;
  /** Endpoint path (default '/predict'). Set to '/ocr' or similar depending on server flavor. */
  endpointPath?: string;
  /** Output format: 'markdown' | 'json'. Default 'markdown'. */
  format?: 'markdown' | 'json';
}

export interface PaddleOcrVlOutput {
  model: string;
  pages: Array<{ index: number; markdown: string; chars: number }>;
  text: string;
  chars: number;
  ms: number;
  /** Raw response from the server for debugging — keep minimal. */
  raw?: unknown;
}

/**
 * paddleocr-vl — thin HTTP client for a self-hosted PaddleOCR-VL endpoint.
 *
 * The exact API surface depends on how PaddleOCR-VL is served (PaddleX,
 * PP-StructureV3, custom FastAPI wrapper). This stage POSTs the raw file
 * bytes as multipart/form-data with field `file` and expects either a
 * markdown string under `markdown` or an array of pages under `pages[]`.
 * Override `endpointPath` for non-default deployments.
 */
export const paddleOcrVlStage = defineStage<PaddleOcrVlInput, PaddleOcrVlOutput, PaddleOcrVlConfig>({
  id: 'paddleocr-vl',
  name: 'PaddleOCR-VL (HTTP)',
  description:
    'OCR via a self-hosted PaddleOCR-VL endpoint. Posts file bytes as ' +
    'multipart/form-data; accepts {markdown} or {pages[]} responses. ' +
    'Shape-compatible with mistral-ocr output.',
  hints: {
    inputs: 'filePath, filename',
    outputs: 'model, text, pages[], chars, ms',
    configExample: '{"baseUrl": "http://localhost:11438", "endpointPath": "/predict", "format": "markdown"}',
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
    if (!input?.filePath) throw new Error('paddleocr-vl: filePath fehlt');
    const t0 = Date.now();
    const baseUrl = ctx.config?.baseUrl ?? process.env['PADDLEOCR_URL'] ?? 'http://localhost:11438'; // lint-no-env: allow — pre-P10 OCR stage, not yet wired to a tool roster
    const endpointPath = ctx.config?.endpointPath ?? '/predict';
    const format = ctx.config?.format ?? 'markdown';

    const bytes = await readFile(input.filePath);
    // Use undici's native FormData (Node 18+).
    const fd = new FormData();
    const blob = new Blob([bytes]);
    fd.append('file', blob, input.filename);
    fd.append('format', format);
    ctx.emit('paddleocr_started', { bytes: bytes.length });

    const res = await fetch(`${baseUrl}${endpointPath}`, {
      method: 'POST',
      signal: ctx.signal,
      body: fd,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`paddleocr-vl ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as Record<string, unknown>;

    let pages: Array<{ index: number; markdown: string; chars: number }> = [];
    if (Array.isArray((data as { pages?: unknown }).pages)) {
      const raw = (data as { pages: Array<{ markdown?: string; text?: string }> }).pages;
      pages = raw.map((p, i) => {
        const md = p.markdown ?? p.text ?? '';
        return { index: i, markdown: md, chars: md.length };
      });
    } else if (typeof (data as { markdown?: unknown }).markdown === 'string') {
      const md = (data as { markdown: string }).markdown;
      pages = [{ index: 0, markdown: md, chars: md.length }];
    } else if (typeof (data as { text?: unknown }).text === 'string') {
      const md = (data as { text: string }).text;
      pages = [{ index: 0, markdown: md, chars: md.length }];
    } else {
      // Best-effort: stringify whole response so downstream KPI still sees something.
      const md = JSON.stringify(data);
      pages = [{ index: 0, markdown: md, chars: md.length }];
    }

    const text = pages.map((p) => p.markdown).join('\n\n');
    const ms = Date.now() - t0;
    ctx.emit('paddleocr_done', { pages: pages.length, chars: text.length, ms });
    return { model: 'paddleocr-vl', pages, text, chars: text.length, ms };
  },
});
