// ocr.ts — Pre-OCR via Mistral /v1/ocr (mistral-ocr-latest)
// ═══════════════════════════════════════════════════════════════════════════
// Architektur-Trennung:
//   Vorher: classify + KPI-Extraktion + interner OCR in EINEM
//           chat/completions-Call (8-15s wallclock, 4-5k tokens out).
//   Jetzt:  /v1/ocr → Markdown (1.5-2s) → wiederverwenden für
//           classifyMarkdown() und extractElsterValuesFromMarkdown().
//
// /v1/ocr akzeptiert PDF base64 inline (data:application/pdf;base64,…).
// table_format='markdown' erzwingt strukturierte Tabellen.
// include_image_base64=false spart Bandbreite (wir brauchen die Bilder
// nicht — nur den Text).
// ═══════════════════════════════════════════════════════════════════════════

import { promises as fs } from 'node:fs';

const OCR_URL = 'https://api.mistral.ai/v1/ocr';
const MODEL = 'mistral-ocr-latest';

export interface OcrPage {
  index: number;
  markdown: string;
}

export interface OcrResult {
  pages: OcrPage[];
  /** Alle Seiten konkateniert mit \n\n als Separator. */
  markdown: string;
  charCount: number;
  ms: number;
  pagesProcessed: number;
}

/**
 * Sendet eine PDF an Mistral /v1/ocr und liefert das strukturierte Markdown.
 *
 * Inline-base64 statt Files-API-Upload + Signed-URL — spart 1 RTT
 * (ca. 800-1200ms in der Praxis). Mistral akzeptiert
 * data:application/pdf;base64,<...> direkt im document_url-Feld.
 */
export async function ocrDocumentFromFile(opts: {
  filePath: string;
  apiKey: string;
  signal?: AbortSignal;
  tableFormat?: 'markdown' | 'html';
  /** Optional: subset of pages, e.g. "1-3,5". Default: alle. */
  pages?: string;
}): Promise<OcrResult> {
  const t0 = Date.now();
  const buf = await fs.readFile(opts.filePath);
  const b64 = buf.toString('base64');

  const body: Record<string, unknown> = {
    document: {
      type: 'document_url',
      document_url: 'data:application/pdf;base64,' + b64,
    },
    model: MODEL,
    include_image_base64: false,
    table_format: opts.tableFormat ?? 'markdown',
  };
  if (opts.pages) body.pages = opts.pages;

  const resp = await fetch(OCR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`mistral ocr ${resp.status}: ${text.slice(0, 500)}`);
  }
  let json: any;
  try { json = JSON.parse(text); }
  catch { throw new Error(`mistral ocr ${resp.status}: non-JSON response: ${text.slice(0, 300)}`); }

  const pagesRaw: Array<any> = Array.isArray(json.pages) ? json.pages : [];
  // Inline-expand: Mistral /v1/ocr rendert Tabellen als externe Markdown-
  // Referenzen `[tbl-N.md](tbl-N.md)` und legt den eigentlichen Tabellen-
  // Inhalt in pages[i].tables[].content. Wir ersetzen die Platzhalter durch
  // den echten Tabellen-Markdown — sonst fehlen alle Werte aus tabellarischen
  // Belegen (VAST, Lohnsteuerbescheinigung, Steuerbescheid).
  const pages: OcrPage[] = pagesRaw.map((p, i) => {
    let md = typeof p?.markdown === 'string' ? p.markdown : '';
    const tables: Array<{ id?: string; content?: string }> = Array.isArray(p?.tables) ? p.tables : [];
    for (const t of tables) {
      if (!t?.id || !t?.content) continue;
      // Beide Varianten: [id](id) und [id.md](id.md). Mistral schreibt aktuell
      // den Plain-id als Linktext + Linkziel. Sicher: replace exact \`[id](id)\`.
      const placeholder = '[' + t.id + '](' + t.id + ')';
      if (md.includes(placeholder)) {
        md = md.split(placeholder).join('\n\n' + t.content + '\n\n');
      }
    }
    return {
      index: typeof p?.index === 'number' ? p.index : i,
      markdown: md,
    };
  });
  const markdown = pages.map((p) => p.markdown).join('\n\n');

  return {
    pages,
    markdown,
    charCount: markdown.length,
    ms: Date.now() - t0,
    pagesProcessed:
      json.usage_info?.pages_processed ??
      json.usage?.pages_processed ??
      pages.length,
  };
}
