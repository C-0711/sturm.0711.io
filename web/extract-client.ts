/**
 * web/extract-client — HTTP-Client für den ECHTEN deterministischen Extraktor
 * des Rust-Orchestrators:
 *
 *   POST http://127.0.0.1:7180/api/v1/extract   (Content-Type: application/pdf)
 *
 * PDF-Bytes rein → strukturierte Felder raus (Phase 0→3). Pro Beleg liefert die
 * Antwort {document_sha256, extracted[], fields[], lane_two_pending[]} mit
 * value_window_px je Feld. KEIN Mock; bei Fehler wird geworfen.
 *
 * Bild-Belege (JPG/PNG/TIFF…) sind keine PDFs → der pdfium-Rasterizer des
 * Orchestrators wirft FormatError. Wie in web/server.ts (imageToPdf) wickeln
 * wir sie zuerst in ein einseitiges PDF (Pillow, 200 dpi).
 *
 * Endpoint via Env TORNADO_ORCHESTRATOR_URL überschreibbar
 * (Default http://127.0.0.1:7180).
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_URL = 'http://127.0.0.1:7180';
const baseUrl = () => (process.env.TORNADO_ORCHESTRATOR_URL ?? DEFAULT_URL).replace(/\/$/, '');

// Bild→PDF (identisch zu web/server.ts): Bilder vor dem /extract-POST rastern.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp', '.bmp', '.gif']);
const PY = process.env.PDL3_PY ?? `${process.env.HOME}/.venvs/pdl3/bin/python`;
function imageToPdf(img: string): string {
  const pdf = img.replace(/\.[^.]+$/, '') + '.asimg.pdf';
  execFileSync(PY, ['-c',
    "from PIL import Image;import sys;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2],'PDF',resolution=200.0)",
    img, pdf], { stdio: 'pipe' });
  return pdf;
}

// ── Wire-Form der /extract-Antwort (Teilmenge, die der Harmonizer nutzt) ──
/** Pixel-Box im Anker-Format {x,y,w,h} (Rust value_window_px / anchor_bbox_px). */
export interface BoxPx { x: number; y: number; w: number; h: number; }
/** Aufgelöstes Feld aus extracted[] (lane 'fast' | 'gemma' | …). */
export interface ExtractedField {
  belegfeld_id: string;
  e_code: string;
  page: number;
  value_raw: string | null;
  value_parsed: string | number | null;
  lane: string;
  anchor_bbox_px: BoxPx | null;
  value_window_px: BoxPx | null;
}
/** Voll-Template aus fields[] (meist value_raw=null) inkl. voters/confidence. */
export interface WindowedField {
  belegfeld_id: string;
  e_code: string;
  page: number;
  value_raw: string | null;
  voters: string[];
  confidence_min: number | null;
  anchor_bbox_px: BoxPx | null;
  value_window_px: BoxPx | null;
}
/** Roher OCR-Record einer Seite: [x0,y0,x1,y1] + voters — Geometrie-Ground-Truth. */
export interface PageRecord {
  text: string;
  bbox: [number, number, number, number];
  voters: string[];
  confidence_min: number | null;
}
/** Ungelöstes Feld inkl. der VOLLEN rohen OCR-Seite (page_records) für Rolle/Anker. */
export interface LaneTwoPending {
  belegfeld_id: string;
  e_code: string;
  page: number;
  anchor_bbox_px: BoxPx | null;
  value_window_px: BoxPx | null;
  records_in_window: PageRecord[];
  page_records: PageRecord[];
  reason: { kind: string };
}
export interface ExtractOutput {
  document_sha256: string;
  pages: number;
  extracted_count: number;
  fields_windowed: number;
  lane_two_pending_count: number;
  total_records?: number;
  extracted: ExtractedField[];
  fields: WindowedField[];
  fields_failed?: unknown[];
  lane_two_pending: LaneTwoPending[];
}

export class ExtractError extends Error {
  constructor(public status: number, bodyExcerpt: string) {
    super(`extract HTTP ${status}: ${bodyExcerpt.slice(0, 200)}`);
    this.name = 'ExtractError';
  }
}

/**
 * Schickt EINEN Beleg an /api/v1/extract und parst die JSON-Antwort.
 * Bilder werden vorher zu PDF gewandelt. Wirft bei jedem Fehler.
 *
 * @param pdfPath  Pfad zum Beleg (PDF oder Bild).
 * @param opts     baseUrl/timeoutMs-Override.
 */
export async function extractBeleg(
  pdfPath: string,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<ExtractOutput> {
  const src = IMAGE_EXT.has(extname(pdfPath).toLowerCase()) ? imageToPdf(pdfPath) : pdfPath;
  const bytes = readFileSync(src);
  const url = (opts.baseUrl ?? baseUrl()).replace(/\/$/, '') + '/api/v1/extract';
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: bytes,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new ExtractError(resp.status, text);
    return JSON.parse(text) as ExtractOutput;
  } finally {
    clearTimeout(timer);
  }
}
