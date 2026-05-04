/**
 * OCR Studio: preview endpoint.
 *
 * POST /api/ocr/preview  (multipart: file + JSON-encoded config)
 *   → SSE stream:
 *       event: ocr_start    data: { config }
 *       event: ocr_done     data: ParsedOcrResponse
 *       event: ocr_error    data: { message, status?, body? }
 *
 * Single-runtime principle: this is a thin wrapper around the same codec
 * the production stage uses. No persistence — preview is ephemeral.
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import * as fs from 'node:fs/promises';
import {
  callMistralOcrWithFallback,
  configToApiRequest,
  fileToDataUriChunk,
  MistralOcrError,
  parseApiResponse,
  type MistralOcrConfig,
} from '../lib/mistral-ocr/index.ts';

export function createOcrPreviewRouter(uploadsDir: string): Router {
  const router = Router();
  const upload = multer({ dest: uploadsDir, limits: { fileSize: 25 * 1024 * 1024 } });

  router.post('/preview', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'file fehlt (multipart field "file")' });
      return;
    }

    let config: MistralOcrConfig = {};
    if (typeof req.body?.config === 'string') {
      try {
        config = JSON.parse(req.body.config);
      } catch (e) {
        res.status(400).json({ error: `config ist kein JSON: ${(e as Error).message}` });
        cleanup(req.file.path);
        return;
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    send('ocr_start', { config, filename: req.file.originalname, size: req.file.size });

    try {
      const document = await fileToDataUriChunk(req.file.path, req.file.originalname);
      const apiReq = configToApiRequest(config, document, { runId: 'studio', stageId: 'preview' });
      const t0 = Date.now();
      const { response, degradation } = await callMistralOcrWithFallback(apiReq, { signal: ac.signal });
      const parsed = parseApiResponse(response, config, t0, degradation);
      if (degradation) send('ocr_degraded', degradation);
      send('ocr_done', parsed);
    } catch (e) {
      if (e instanceof MistralOcrError) {
        send('ocr_error', { message: e.message, status: e.status, body: e.body });
      } else if ((e as { name?: string })?.name === 'AbortError') {
        send('ocr_error', { message: 'aborted by client' });
      } else {
        send('ocr_error', { message: (e as Error).message ?? String(e) });
      }
    } finally {
      cleanup(req.file.path);
      res.end();
    }
  });

  router.post('/preview/batch', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'file fehlt (multipart field "file")' });
      return;
    }
    let variants: Array<{ id: string; config: MistralOcrConfig }>;
    try {
      const raw = typeof req.body?.variants === 'string' ? JSON.parse(req.body.variants) : req.body?.variants;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('variants must be a non-empty array');
      if (raw.length > 5) throw new Error('max 5 variants per batch');
      variants = raw.map((v: { id?: unknown; config?: unknown }, i: number) => {
        if (!v || typeof v.id !== 'string') throw new Error(`variants[${i}].id must be a string`);
        if (typeof v.config !== 'object' || v.config === null) throw new Error(`variants[${i}].config must be an object`);
        return { id: v.id, config: v.config as MistralOcrConfig };
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      cleanup(req.file.path);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    const t0 = Date.now();
    send('batch_start', { variants: variants.map((v) => ({ id: v.id })), filename: req.file.originalname, size: req.file.size });

    try {
      const document = await fileToDataUriChunk(req.file.path, req.file.originalname);
      await Promise.allSettled(
        variants.map(async (v) => {
          try {
            const apiReq = configToApiRequest(v.config, document, { runId: 'studio', stageId: `batch:${v.id}` });
            const start = Date.now();
            const { response, degradation } = await callMistralOcrWithFallback(apiReq, { signal: ac.signal });
            const parsed = parseApiResponse(response, v.config, start, degradation);
            send('variant_done', { variantId: v.id, parsed });
          } catch (e) {
            if (e instanceof MistralOcrError) {
              send('variant_error', { variantId: v.id, message: e.message, status: e.status, body: e.body });
            } else if ((e as { name?: string })?.name === 'AbortError') {
              send('variant_error', { variantId: v.id, message: 'aborted by client' });
            } else {
              send('variant_error', { variantId: v.id, message: (e as Error).message ?? String(e) });
            }
          }
        }),
      );
      send('batch_done', { totalMs: Date.now() - t0 });
    } finally {
      cleanup(req.file.path);
      res.end();
    }
  });

  return router;
}

async function cleanup(p: string) {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}
