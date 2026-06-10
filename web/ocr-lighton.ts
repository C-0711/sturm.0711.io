/**
 * web/ocr-lighton — OCR EINES Belegs über LightOnOCR (vLLM, :11437) statt
 * PaddleOCR. Rastert PDF-Seiten zu PNG (`pdftoppm`) und liest jede Seite über
 * den OpenAI-kompatiblen /v1/chat/completions-Vision-Endpoint als Markdown.
 *
 * Gedacht für gescannte Belege (kein Text-Layer) im Hintergrund-Pfad — die
 * deterministische Lane-1 (pdftotext) bleibt für digitale PDFs primär.
 *
 * Endpoint via Env LIGHTON_OCR_URL (Default http://127.0.0.1:11437),
 * Modell via LIGHTON_OCR_MODEL (Default 'lighton-ocr'). Kein Modellname im UI.
 */
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const execFileP = promisify(execFile);
const LIGHTON_URL = process.env.LIGHTON_OCR_URL ?? 'http://127.0.0.1:11437';
const MODEL = process.env.LIGHTON_OCR_MODEL ?? 'lighton-ocr';
const PROMPT =
  'Lies dieses Dokument vollständig und gib den Inhalt als Markdown wieder. ' +
  'Erhalte Tabellenstrukturen, Listen, Überschriften. Keine Erklärungen, keine Vorbemerkungen.';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

async function pagesToPng(filePath: string, dpi: number, signal: AbortSignal): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'sturm-lighton-'));
  try {
    await execFileP('pdftoppm', ['-r', String(dpi), '-png', filePath, join(dir, 'page')], { signal });
    const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    const out: Buffer[] = [];
    for (const f of files) out.push(await readFile(join(dir, f)));
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ocrPage(png: Buffer, maxTokens: number, signal: AbortSignal): Promise<string> {
  const b64 = png.toString('base64');
  const res = await fetch(`${LIGHTON_URL.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`lighton-ocr ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content ?? '';
}

/** OCR eines Belegs (PDF oder Bild) → zusammengefügter Markdown-Text aller Seiten.
 *  Seiten sequenziell (Single-Replica-vLLM nicht überfahren). Wirft bei Hard-Fehler. */
export async function ocrLighton(
  filePath: string,
  opts: { dpi?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs ?? 180_000);
  try {
    const ext = extname(filePath).toLowerCase();
    const pages = IMAGE_EXT.has(ext)
      ? [await readFile(filePath)]
      : await pagesToPng(filePath, opts.dpi ?? 200, ctrl.signal);
    // Seiten parallel — vLLM batcht auf der GPU (gemessen ×3,3 vs sequenziell).
    const md = await Promise.all(pages.map((p) => ocrPage(p, opts.maxTokens ?? 4096, ctrl.signal)));
    return md.join('\n\n');
  } finally {
    clearTimeout(timer);
  }
}
