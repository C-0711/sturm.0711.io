/**
 * Mistral OCR HTTP wrapper.
 *
 * Direct fetch — no SDK. Honors AbortSignal.
 * Files API integration is stubbed (uploadFile) so the studio can call it for
 * large docs without re-uploading on every variant; not yet wired into the
 * stage's main path.
 */

import * as fs from 'node:fs/promises';
import type { DocumentChunk, MistralOcrRequest, MistralOcrResponse } from './types.ts';

const OCR_URL = 'https://api.mistral.ai/v1/ocr';
const FILES_URL = 'https://api.mistral.ai/v1/files';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function mimeFromFilename(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return MIME[name.slice(i).toLowerCase()] ?? 'application/octet-stream';
}

export async function fileToDataUriChunk(filePath: string, filename: string): Promise<DocumentChunk> {
  const mime = mimeFromFilename(filename);
  const buf = await fs.readFile(filePath);
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  return mime.startsWith('image/')
    ? { type: 'image_url', image_url: dataUri }
    : { type: 'document_url', document_url: dataUri, document_name: filename };
}

export interface CallOptions {
  apiKey?: string;
  signal?: AbortSignal;
  /** Override base URL for testing. */
  baseUrl?: string;
}

/**
 * Latest API call result. `degradation` is set when the request was retried
 * with one or more fields stripped (e.g. an undocumented param the API tightened
 * validation on). Callers can surface this to users.
 */
export interface CallResult {
  response: MistralOcrResponse;
  degradation?: { reason: string; strippedFields: string[] };
}

export async function callMistralOcr(
  req: MistralOcrRequest,
  opts: CallOptions = {},
): Promise<MistralOcrResponse> {
  const { response } = await callMistralOcrWithFallback(req, opts);
  return response;
}

/**
 * Same as callMistralOcr, but returns degradation metadata when the call had to
 * retry without an undocumented field. Specifically: if a 422 mentions
 * `confidence_scores_granularity` (the one undocumented param this codec emits),
 * we strip it and retry once. Real 4xx/5xx errors propagate normally.
 */
export async function callMistralOcrWithFallback(
  req: MistralOcrRequest,
  opts: CallOptions = {},
): Promise<CallResult> {
  const apiKey = opts.apiKey ?? process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');
  const finalUrl = opts.baseUrl
    ? opts.baseUrl.replace(/\/$/, '') + '/v1/ocr'
    : OCR_URL;

  const send = async (body: MistralOcrRequest) => fetch(finalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  let resp = await send(req);
  let raw = await resp.text();

  // Fallback: 422 extra_forbidden on confidence_scores_granularity → strip & retry.
  if (resp.status === 422 && req.confidence_scores_granularity && /confidence_scores_granularity/.test(raw)) {
    const { confidence_scores_granularity: _drop, ...stripped } = req;
    void _drop;
    const retry = await send(stripped as MistralOcrRequest);
    const retryRaw = await retry.text();
    if (retry.ok) {
      try {
        return {
          response: JSON.parse(retryRaw) as MistralOcrResponse,
          degradation: {
            reason: 'API rejected confidence_scores_granularity (422); retried without it',
            strippedFields: ['confidence_scores_granularity'],
          },
        };
      } catch {
        throw new MistralOcrError('Mistral OCR returned invalid JSON after fallback retry', retry.status, retryRaw.slice(0, 400));
      }
    }
    // Retry also failed — surface the retry error
    throw new MistralOcrError(`Mistral OCR HTTP ${retry.status} after fallback`, retry.status, retryRaw.slice(0, 800));
  }

  if (!resp.ok) {
    throw new MistralOcrError(`Mistral OCR HTTP ${resp.status}`, resp.status, raw.slice(0, 800));
  }
  try {
    return { response: JSON.parse(raw) as MistralOcrResponse };
  } catch {
    throw new MistralOcrError('Mistral OCR returned invalid JSON', resp.status, raw.slice(0, 400));
  }
}

export class MistralOcrError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(`${message}: ${body}`);
    this.name = 'MistralOcrError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Upload to Mistral's Files API. Returns the file_id usable in
 * { type: 'file', file_id: ... } document chunks.
 *
 * Stub for now — used by studio batch endpoint when implemented.
 */
export async function uploadFile(
  filePath: string,
  filename: string,
  opts: CallOptions = {},
): Promise<{ file_id: string }> {
  const apiKey = opts.apiKey ?? process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append('purpose', 'ocr');
  form.append('file', new Blob([new Uint8Array(buf)], { type: mimeFromFilename(filename) }), filename);
  const resp = await fetch(FILES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: opts.signal,
  });
  const raw = await resp.text();
  if (!resp.ok) throw new MistralOcrError(`Files upload HTTP ${resp.status}`, resp.status, raw.slice(0, 400));
  const j = JSON.parse(raw) as { id: string };
  return { file_id: j.id };
}

/**
 * Resolve a presigned download URL for a previously uploaded file.
 * Mirrors the playground's `GET /api-ui/jobs/files/<id>/url` call;
 * the public equivalent is `GET /v1/files/{id}/url?expiry=<hours>`.
 */
export async function getFileSignedUrl(
  fileId: string,
  opts: CallOptions & { expiryHours?: number } = {},
): Promise<{ url: string }> {
  const apiKey = opts.apiKey ?? process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');
  const expiry = opts.expiryHours ?? 1;
  const url = `${FILES_URL}/${encodeURIComponent(fileId)}/url?expiry=${expiry}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: opts.signal,
  });
  const raw = await resp.text();
  if (!resp.ok) throw new MistralOcrError(`Files signed-url HTTP ${resp.status}`, resp.status, raw.slice(0, 400));
  const j = JSON.parse(raw) as { url: string };
  if (!j.url) throw new MistralOcrError('Files signed-url response missing url', resp.status, raw.slice(0, 400));
  return { url: j.url };
}
