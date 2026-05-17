import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { defineStage } from '../core/stage.ts';

export interface LightonOcrInput {
  filePath: string;
  filename: string;
}

export interface LightonOcrConfig {
  /** vLLM base URL (OpenAI-compatible). Default env LIGHTON_OCR_URL or http://localhost:11437. */
  baseUrl?: string;
  /** Served-model-name on the vLLM instance. Default 'lighton-ocr'. */
  model?: string;
  /** max_tokens per page. Default 4096. */
  maxTokens?: number;
  /** Render PDF pages to PNG first (requires `pdftoppm`). Default true. */
  rasterize?: boolean;
  /** Resolution for rasterization (dpi). Default 200. */
  dpi?: number;
}

export interface LightonOcrOutput {
  model: string;
  pages: Array<{ index: number; markdown: string; chars: number }>;
  text: string;
  chars: number;
  ms: number;
}

const DEFAULT_PROMPT =
  'Lies dieses Dokument vollständig und gib den Inhalt als Markdown wieder. ' +
  'Erhalte Tabellenstrukturen, Listen, Überschriften. ' +
  'Keine Erklärungen, keine Vorbemerkungen.';

async function pageBlobsFromPdf(filePath: string, dpi: number, signal: AbortSignal): Promise<Buffer[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const execFileP = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'sturm-lighton-'));
  try {
    await execFileP('pdftoppm', ['-r', String(dpi), '-png', filePath, join(dir, 'page')], { signal });
    const entries = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    const buffers: Buffer[] = [];
    for (const e of entries) buffers.push(await readFile(join(dir, e)));
    return buffers;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ocrOnePage(
  imageBytes: Buffer,
  cfg: Required<Pick<LightonOcrConfig, 'baseUrl' | 'model' | 'maxTokens'>>,
  signal: AbortSignal,
): Promise<string> {
  const b64 = imageBytes.toString('base64');
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: DEFAULT_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
  };
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`lighton-ocr ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * lighton-ocr — calls a vLLM OpenAI-compatible endpoint that serves the
 * LightOn OCR model (e.g. `lightonai/LightOnOCR-1B`).
 *
 * PDFs are rasterized to PNG via `pdftoppm` and each page is sent in a
 * separate request. Output mirrors the mistral-ocr stage shape so any
 * downstream classifier/extractor that reads `output.pages[].markdown` or
 * `output.text` works unchanged.
 */
export const lightonOcrStage = defineStage<LightonOcrInput, LightonOcrOutput, LightonOcrConfig>({
  id: 'lighton-ocr',
  name: 'LightOn OCR (vLLM)',
  description:
    'OCR via LightOn OCR served by vLLM. Rasterizes PDFs to PNG, then calls ' +
    'the OpenAI-compatible /v1/chat/completions endpoint per page. Output is ' +
    'shape-compatible with mistral-ocr.',
  hints: {
    inputs: 'filePath, filename',
    outputs: 'model, text, pages[], chars, ms',
    configExample: '{"baseUrl": "http://localhost:11437", "model": "lighton-ocr", "maxTokens": 4096, "dpi": 200}',
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
    if (!input?.filePath) throw new Error('lighton-ocr: filePath fehlt');
    const t0 = Date.now();
    const cfg = {
      baseUrl: ctx.config?.baseUrl ?? process.env['LIGHTON_OCR_URL'] ?? 'http://localhost:11437', // lint-no-env: allow — pre-P10 standalone OCR stage, not yet wired to a tool roster
      model:   ctx.config?.model   ?? 'lighton-ocr',
      maxTokens: ctx.config?.maxTokens ?? 4096,
      rasterize: ctx.config?.rasterize !== false,
      dpi: ctx.config?.dpi ?? 200,
    };

    const ext = extname(input.filename).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);

    let pageImages: Buffer[];
    if (isImage) {
      pageImages = [await readFile(input.filePath)];
    } else if (cfg.rasterize) {
      pageImages = await pageBlobsFromPdf(input.filePath, cfg.dpi, ctx.signal);
    } else {
      throw new Error('lighton-ocr: rasterize=false ist nur fuer Bilder gueltig');
    }
    ctx.emit('lighton_started', { pages: pageImages.length, model: cfg.model });

    const pageOutputs: Array<{ index: number; markdown: string; chars: number }> = [];
    // Sequential per page to avoid hammering a single-replica vLLM. If you
    // serve LightOn with N replicas, bump this to Promise.all.
    for (let i = 0; i < pageImages.length; i++) {
      const md = await ocrOnePage(pageImages[i], cfg, ctx.signal);
      pageOutputs.push({ index: i, markdown: md, chars: md.length });
      ctx.emit('lighton_page', { index: i, chars: md.length });
    }

    const text = pageOutputs.map((p) => p.markdown).join('\n\n');
    const ms = Date.now() - t0;
    ctx.emit('lighton_done', { pages: pageOutputs.length, chars: text.length, ms });
    return { model: cfg.model, pages: pageOutputs, text, chars: text.length, ms };
  },
});
