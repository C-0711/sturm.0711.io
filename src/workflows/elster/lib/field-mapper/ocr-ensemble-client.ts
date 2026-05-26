/**
 * ocr-ensemble-client — HTTP-Client für tornado-orchestrator's
 *   POST /api/v1/ocr-ensemble
 *
 * Schickt PDF-Bytes an die Rust-Pipeline auf H200V, bekommt OCR-Records
 * (mit BBoxen) und Semantic-Overlay-Tags (Top-K Catalog-E-Code-Kandidaten
 * pro Label-Record) zurück. Sturm dreht die Phasen 3+4 weiter:
 * field-mapper extrahiert deterministisch, normalisiert, validiert via
 * Catalog, und baut das E10-XML.
 *
 * Anti-Goals:
 *   • Kein Retry/Backoff hier (Caller-Verantwortung).
 *   • Kein Streaming — die Response ist auf ~MBs limitiert.
 *
 * Endpoint-Default-URL ist die in der Runtime-Architektur dokumentierte
 * (h200v:7180). Override per Env-Var TORNADO_ORCHESTRATOR_URL möglich.
 */
import { readFileSync } from 'node:fs';

const DEFAULT_URL =
  process.env.TORNADO_ORCHESTRATOR_URL ?? 'http://h200v:7180';

/**
 * Wire-Format des Rust-BBox-Structs: 4-element array `[x0, y0, x1, y1]`
 * (per `#[serde(into = "[f32; 4]")]` in crates/triton-client/src/records.rs).
 */
export type BBoxWire = [number, number, number, number];

/** Komfortablere Objekt-Form für JavaScript-Verbraucher. */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function bboxFromWire(wire: BBoxWire | null): BBox | null {
  if (!wire) return null;
  const [x0, y0, x1, y1] = wire;
  return { x0, y0, x1, y1 };
}

export interface ConsensusRecord {
  text: string;
  /** Wire-Format aus Rust: array `[x0,y0,x1,y1]` oder null. */
  bbox: BBoxWire | null;
  /** 0..1 — Engine-aggregated confidence. */
  confidence_min: number | null;
  /** Engine-Namen die zu diesem Record beigetragen haben. */
  voters: string[];
}

export interface ConsensusPage {
  page_index: number;
  records: ConsensusRecord[];
}

export interface TaggedRecord {
  record: ConsensusRecord;
  /** Top-K (e_code, score) Paare aus dem PolarQuant-Lookup. */
  candidates: Array<[string, number]>;
}

export interface TaggedPage {
  page_index: number;
  records: TaggedRecord[];
}

export interface OcrEnsembleResponse {
  document_sha256_hex: string;
  consensus_pages: ConsensusPage[];
  /** Empty wenn EmbeddingGemma nicht verfügbar war oder kein PolarQuant-Index geladen. */
  tagged_pages: TaggedPage[];
}

export interface OcrEnsembleOptions {
  /** Override des Orchestrator-Endpoints. Default: env var oder h200v:7180. */
  baseUrl?: string;
  /** Timeout in ms. Default: 120s (große PDFs brauchen Zeit). */
  timeoutMs?: number;
}

export class OcrEnsembleError extends Error {
  constructor(public status: number, public bodyExcerpt: string) {
    super(`ocr-ensemble HTTP ${status}: ${bodyExcerpt.slice(0, 200)}`);
    this.name = 'OcrEnsembleError';
  }
}

/**
 * Sendet die PDF-Bytes an /api/v1/ocr-ensemble und parst die JSON-Antwort.
 *
 * @param pdf — PDF-Bytes als Buffer oder Uint8Array.
 */
export async function callOcrEnsemble(
  pdf: Buffer | Uint8Array,
  opts: OcrEnsembleOptions = {},
): Promise<OcrEnsembleResponse> {
  const url = (opts.baseUrl ?? DEFAULT_URL).replace(/\/$/, '') + '/api/v1/ocr-ensemble';
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdf,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new OcrEnsembleError(resp.status, text);
    }
    return JSON.parse(text) as OcrEnsembleResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: PDF von Pfad laden + an Orchestrator schicken. */
export async function ocrEnsembleFromPath(
  pdfPath: string,
  opts: OcrEnsembleOptions = {},
): Promise<OcrEnsembleResponse> {
  const buf = readFileSync(pdfPath);
  return callOcrEnsemble(buf, opts);
}

/** Health-Check gegen den Orchestrator. */
export async function pingOrchestrator(baseUrl?: string): Promise<boolean> {
  const url = (baseUrl ?? DEFAULT_URL).replace(/\/$/, '') + '/api/v1/health';
  try {
    const resp = await fetch(url);
    return resp.ok;
  } catch {
    return false;
  }
}
