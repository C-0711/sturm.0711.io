/**
 * ocr-mistral-small — OCR via Mistral Small chat-vision instead of /v1/ocr.
 *
 * Why a second OCR path: Mistral's dedicated `/v1/ocr` endpoint
 * (mistral-ocr-latest) is purpose-built for OCR but lacks the precise
 * line-number anchoring we need for the v6 per-anlage page-Zeile filter
 * (it sometimes collapses or reformats Zeile numbers).
 *
 * Mistral Small (`mistral-small-latest`) is multimodal: chat-completions
 * accepts image_url messages and returns markdown text. With an explicit
 * "preserve line numbers" instruction it produces output where every
 * Zeile-N row leader survives intact — which is what the spike used and
 * what phase3-vision-fill's page-Zeile filter needs to anchor field asks.
 *
 * Output contract matches `lib/ocr.OcrResult` so downstream stages
 * (klassifizierung, phase1-regex, phase3-vision-fill) are unchanged.
 */
import { promises as fs } from 'node:fs';
import type { OcrResult, OcrPage } from './ocr.ts';

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODEL = 'mistral-small-latest';

export interface MistralSmallOcrOptions {
  /** Rendered PDF pages as PNG paths (use lib/pdf-render). */
  pngPaths: string[];
  apiKey: string;
  /** Override model. Default 'mistral-small-latest'. */
  model?: string;
  /** Per-call timeout. Default 60_000ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Conservative per-call image cap. Mistral Small supports more than 4,
 *  but smaller batches give cleaner per-page output. ELSTER forms rarely
 *  exceed 8 pages, so 4 = at most 2 calls per typical Stricker/Hildburg
 *  document. */
const MAX_IMAGES_PER_CALL = 4;

/** Transcription prompt — the load-bearing instruction. Tells the model
 *  to preserve Zeile numbers verbatim so the page-Zeile filter downstream
 *  can match `vordruckzeile: "5"` against `^5 Bruttoarbeitslohn` in the
 *  transcribed text. */
const TRANSCRIBE_PROMPT = [
  'Transkribiere die gezeigte(n) Seite(n) einer deutschen ELSTER-Steuererklaerung',
  'als Markdown — wortgenau, ohne Zusammenfassung, ohne Ergaenzungen.',
  '',
  'Regeln:',
  '- ZEILEN-NUMMERN am Zeilen-/Spaltenanfang BLEIBEN ERHALTEN (z.B. "5 Bruttoarbeitslohn 63.559,90").',
  '- Tabellen als Markdown-Pipe-Tabellen.',
  '- Eurobetraege im Original-Format ("63.559,90"), keine Umformatierung.',
  '- Mehrere Seiten: trenne mit einer Zeile "Seite N von M" wie auf dem Beleg.',
  '- Keine Erklaerungen, keine Vorworte, keine ```markdown``` Codefence — nur den reinen Text.',
].join('\n');

interface ChatMessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

/** OCR a PDF (rendered to PNGs) via Mistral Small chat-vision.
 *
 *  Returns the `OcrResult` shape so downstream stages don't need changes.
 *  Pages are split by `Seite N von M` markers in the model's output (which
 *  the prompt asks it to preserve); if no markers are emitted, the entire
 *  output goes into page 0.
 */
export async function ocrViaMistralSmall(
  opts: MistralSmallOcrOptions,
): Promise<OcrResult> {
  const t0 = Date.now();
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (!opts.pngPaths || opts.pngPaths.length === 0) {
    throw new Error('ocrViaMistralSmall: pngPaths must contain at least 1 image');
  }
  if (!opts.apiKey) {
    throw new Error('ocrViaMistralSmall: apiKey is required');
  }

  // Batch into MAX_IMAGES_PER_CALL groups, transcribe each batch.
  const allMarkdownChunks: string[] = [];
  for (let i = 0; i < opts.pngPaths.length; i += MAX_IMAGES_PER_CALL) {
    const batch = opts.pngPaths.slice(i, i + MAX_IMAGES_PER_CALL);
    const chunk = await transcribeOneBatch({
      pngPaths: batch,
      apiKey: opts.apiKey,
      model,
      timeoutMs,
      signal: opts.signal,
      pageOffset: i + 1, // 1-based page numbering for the prompt's "Seite N"
      totalPages: opts.pngPaths.length,
    });
    allMarkdownChunks.push(chunk);
  }

  const joined = allMarkdownChunks.join('\n\n');
  const pages = splitByPageMarkers(joined, opts.pngPaths.length);
  const markdown = pages.map((p) => p.markdown).join('\n\n');

  return {
    pages,
    markdown,
    charCount: markdown.length,
    ms: Date.now() - t0,
    pagesProcessed: pages.length,
  };
}

async function transcribeOneBatch(args: {
  pngPaths: string[];
  apiKey: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  pageOffset: number;
  totalPages: number;
}): Promise<string> {
  // Build multipart user message: prompt text + each image as data URI.
  const content: ChatMessageContent[] = [
    {
      type: 'text',
      text:
        `${TRANSCRIBE_PROMPT}\n\nGezeigt: Seite ${args.pageOffset}` +
        (args.pngPaths.length > 1
          ? `–${args.pageOffset + args.pngPaths.length - 1}`
          : '') +
        ` von ${args.totalPages}.`,
    },
  ];
  for (const p of args.pngPaths) {
    const buf = await fs.readFile(p);
    const b64 = buf.toString('base64');
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64}` },
    });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`mistral-small-ocr timeout after ${args.timeoutMs}ms`)), args.timeoutMs);
  const onParentAbort = (): void => ac.abort(args.signal?.reason);
  args.signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const resp = await fetch(CHAT_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({
        model: args.model,
        temperature: 0,
        max_tokens: 8000,
        messages: [{ role: 'user', content }],
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `mistral-small-ocr ${resp.status}: ${text.slice(0, 400)}`,
      );
    }
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = json?.choices?.[0]?.message?.content ?? '';
    return typeof out === 'string' ? out : '';
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onParentAbort);
  }
}

/** Split the model's joined output into pages by `Seite N von M` markers,
 *  grouping by the page NUMBER (Mistral Small emits the header twice on
 *  some pages — once at the page break, once at the start of content).
 *  Sections without a header are appended to the previous detected page.
 *
 *  Returns exactly `expectedPages` entries: missing pages become empty
 *  strings, excess pages (rare) collapse into the last page.
 */
function splitByPageMarkers(text: string, expectedPages: number): OcrPage[] {
  if (typeof text !== 'string' || text.length === 0) {
    return Array.from({ length: expectedPages }, (_, i) => ({ index: i, markdown: '' }));
  }
  const headerRx = /Seite (\d+) von \d+/;
  const parts = text.split(/(?=Seite \d+ von \d+)/);

  // Bucket each part by the page number from its header. Parts without
  // a header get appended to whichever bucket was last seen (or page 0).
  const byPage = new Map<number, string[]>();
  let lastPage = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const m = trimmed.match(headerRx);
    const pageNum = m ? parseInt(m[1], 10) - 1 : lastPage; // 1-based → 0-based
    if (!byPage.has(pageNum)) byPage.set(pageNum, []);
    byPage.get(pageNum)!.push(trimmed);
    lastPage = pageNum;
  }

  const pages: OcrPage[] = [];
  const totalSlots = Math.max(expectedPages, ...Array.from(byPage.keys()).map((k) => k + 1));
  for (let i = 0; i < totalSlots; i++) {
    const chunks = byPage.get(i) ?? [];
    pages.push({ index: i, markdown: chunks.join('\n\n') });
  }
  // Trim trailing extras into the last expected page if model over-emitted.
  if (pages.length > expectedPages) {
    const tail = pages.slice(expectedPages).map((p) => p.markdown).join('\n\n');
    pages.length = expectedPages;
    pages[expectedPages - 1] = {
      index: expectedPages - 1,
      markdown: pages[expectedPages - 1].markdown + (tail ? '\n\n' + tail : ''),
    };
  }
  return pages;
}
