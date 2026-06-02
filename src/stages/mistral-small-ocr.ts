/**
 * mistral-small-ocr — OCR via Mistral's multimodal `mistral-small-latest`
 * über die Standard Chat-Completions API. Zwei Modi je nach Config:
 *
 *   mode='md'     → Volltext-Markdown-Extraktion (Drop-in für lighton-ocr/
 *                   mistral-ocr; deckt Headings, Listen, Body-Text ab).
 *   mode='table'  → Tabellen-Fokus: extrahiert tabellarische Strukturen als
 *                   GitHub-flavored Markdown-Tabellen (mit | und ---). Body-
 *                   Text wird kürzer gehalten, weil das Layout-Skelett der
 *                   Tabelle der primäre Output ist.
 *
 * Beide Modi liefern dieselbe Output-Shape wie mistral-ocr und lighton-ocr
 * (`pages[{index,markdown,chars}]`), damit `compare/ocr-consensus-merge`
 * sie als zwei unterscheidbare Branches im Fan-out vergleichen kann.
 *
 * Authentifizierung: `MISTRAL_API_KEY` env. PDFs werden via `pdftoppm` zu
 * 200dpi-PNGs gerastert und pro Seite an `https://api.mistral.ai/v1/chat/
 * completions` mit `image_url`-Content-Type gesendet.
 *
 * Performance: ~2-4s pro Seite, sequenziell um Rate-Limits zu respektieren.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { defineStage } from '../core/stage.ts';
import { recordTrace } from '../lib/trace.ts';

export type MistralSmallOcrMode = 'md' | 'table';

export interface MistralSmallOcrInput {
  filePath: string;
  filename: string;
}

export interface MistralSmallOcrConfig {
  /** API-Endpoint. Default 'https://api.mistral.ai'. */
  baseUrl?: string;
  /** Mistral-Modell. Default 'mistral-small-latest' (multimodal). */
  model?: string;
  /** Modus: 'md' (Volltext-Markdown) oder 'table' (Tabellen-Fokus). Default 'md'. */
  mode?: MistralSmallOcrMode;
  /** max_tokens pro Seite. Default 4096. */
  maxTokens?: number;
  /** PDF-Render-DPI. Default 200. */
  dpi?: number;
  /** Custom Prompt der den Default überschreibt. */
  promptOverride?: string;
  /** API-Key. Default aus env MISTRAL_API_KEY. */
  apiKey?: string;
}

export interface MistralSmallOcrOutput {
  model: string;
  mode: MistralSmallOcrMode;
  pages: Array<{ index: number; markdown: string; chars: number }>;
  text: string;
  chars: number;
  ms: number;
}

// ─── Prompts ──────────────────────────────────────────────────────────────

const PROMPT_MD =
  'Lies dieses Dokument vollständig und gib den Inhalt als GitHub-Markdown wieder. ' +
  'Erhalte Tabellenstrukturen (als | … | … |), Listen (- bzw. 1.), Überschriften (#). ' +
  'Erhalte Whitespace und Zeilenumbrüche wo sie für die Struktur wichtig sind. ' +
  'KEINE Erklärungen, KEINE Vorbemerkungen — nur der reine Markdown-Inhalt.';

const PROMPT_TABLE =
  'Extrahiere ALLE tabellarischen Strukturen aus dieser Seite als GitHub-flavored ' +
  'Markdown-Tabellen mit | und einer Trennzeile aus ---. Wenn das Dokument ' +
  'ein Formular ist (Label/Wert-Paare in zwei Spalten), gib es als 2-spaltige Tabelle ' +
  'aus. Zellen müssen exakt das enthalten was im Dokument steht (Whitespace + Werte). ' +
  'Nicht-tabellarischer Body-Text (Fließtext, Anrede, Disclaimer) wird ausgelassen. ' +
  'KEINE Erklärungen, KEINE Vorbemerkungen — nur die Tabellen.';

function buildPrompt(mode: MistralSmallOcrMode, override?: string): string {
  if (override) return override;
  return mode === 'table' ? PROMPT_TABLE : PROMPT_MD;
}

// ─── PDF → PNG Rasterizer (reuse pattern from lighton-ocr) ────────────────

async function pageBlobsFromPdf(filePath: string, dpi: number, signal: AbortSignal): Promise<Buffer[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const execFileP = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'sturm-mistral-small-ocr-'));
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

// ─── Mistral Chat-Completions Call (single page) ──────────────────────────

interface OcrCfgResolved {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  mode: MistralSmallOcrMode;
  prompt: string;
}

async function ocrOnePage(imageBytes: Buffer, cfg: OcrCfgResolved, signal: AbortSignal): Promise<string> {
  const b64 = imageBytes.toString('base64');
  const t0 = Date.now();
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: cfg.prompt },
          { type: 'image_url', image_url: `data:image/png;base64,${b64}` },
        ],
      },
    ],
  };
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mistral-small-ocr ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  recordTrace({
    kind: 'ocr', provider: 'mistral', model: cfg.model,
    url: `${cfg.baseUrl}/v1/chat/completions`,
    request: { prompt: cfg.prompt, image: 'inline-base64' },
    response: content, ms: Date.now() - t0, ok: true,
  });
  return content;
}

// ─── Stage ────────────────────────────────────────────────────────────────

export const mistralSmallOcrStage = defineStage<
  MistralSmallOcrInput,
  MistralSmallOcrOutput,
  MistralSmallOcrConfig
>({
  id: 'mistral-small-ocr',
  name: 'Mistral-Small OCR (Markdown / Table mode)',
  description:
    'OCR via `mistral-small-latest` multimodal über die Mistral Chat-API. ' +
    'Modus="md": Volltext-Markdown-Extraktion (Drop-in für lighton-ocr). ' +
    'Modus="table": Tabellen-Fokus, ideal als zweite Engine im Fan-out für ' +
    'tabellarisch geprägte Belege (VAST-Lohnsteuer, Mitteilungen). Beide Modi ' +
    'liefern shape-kompatibles Output für compare/ocr-consensus-merge.',
  hints: {
    inputs: 'filePath, filename',
    outputs: 'model, mode, pages[{index,markdown,chars}], text, chars, ms',
    configExample:
      '{"mode": "md", "model": "mistral-small-latest", "maxTokens": 4096, "dpi": 200}',
    inputPorts: [
      { name: 'filePath', type: 'file-path' },
      { name: 'filename', type: 'string' },
    ],
    outputPorts: [
      { name: 'text', type: 'text' },
      { name: 'pages', type: 'pages' },
      { name: 'mode', type: 'string', description: 'md|table' },
    ],
  },

  async run(input, ctx) {
    if (!input?.filePath) throw new Error('mistral-small-ocr: filePath fehlt');
    const t0 = Date.now();
    const mode: MistralSmallOcrMode = ctx.config?.mode ?? 'md';
    const apiKey = ctx.config?.apiKey ?? process.env['MISTRAL_API_KEY']; // lint-no-env: allow — Mistral API key, pre-P10 OCR stage not yet wired to a tool roster
    if (!apiKey) {
      throw new Error('mistral-small-ocr: MISTRAL_API_KEY env nicht gesetzt');
    }
    const cfg: OcrCfgResolved = {
      baseUrl: ctx.config?.baseUrl ?? 'https://api.mistral.ai',
      model: ctx.config?.model ?? 'mistral-small-latest',
      apiKey,
      maxTokens: ctx.config?.maxTokens ?? 4096,
      mode,
      prompt: buildPrompt(mode, ctx.config?.promptOverride),
    };

    const ext = extname(input.filename).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);

    let pageImages: Buffer[];
    if (isImage) {
      pageImages = [await readFile(input.filePath)];
    } else {
      pageImages = await pageBlobsFromPdf(input.filePath, ctx.config?.dpi ?? 200, ctx.signal);
    }
    ctx.emit('mistral_small_ocr_started', {
      pages: pageImages.length,
      mode: cfg.mode,
      model: cfg.model,
    });

    const pageOutputs: Array<{ index: number; markdown: string; chars: number }> = [];
    // Sequenziell um API-Rate-Limits nicht zu treffen. Bei mehreren Belegen
    // parallel-Hop wäre ein Workflow-Level concurrency-control.
    for (let i = 0; i < pageImages.length; i++) {
      const md = await ocrOnePage(pageImages[i], cfg, ctx.signal);
      pageOutputs.push({ index: i, markdown: md, chars: md.length });
      ctx.emit('mistral_small_ocr_page', { index: i, mode: cfg.mode, chars: md.length });
    }

    const text = pageOutputs.map((p) => p.markdown).join('\n\n');
    const ms = Date.now() - t0;
    ctx.emit('mistral_small_ocr_done', {
      pages: pageOutputs.length,
      mode: cfg.mode,
      chars: text.length,
      ms,
    });
    return {
      model: cfg.model,
      mode: cfg.mode,
      pages: pageOutputs,
      text,
      chars: text.length,
      ms,
    };
  },
});
