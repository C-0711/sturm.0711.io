/**
 * Standalone classification preview — no workspace, no persistence.
 *
 * POST /api/classify  (multipart "file") → SSE
 *   event: classify_started  data: { filename, size, fileId }
 *   event: classify_done     data: { label, confidence, summary, kpis, value_count, ms, tokens }
 *   event: done              data: { fileId }
 *   event: error             data: { message }
 *
 * Used by the studio playground to show the user a one-shot summary of what
 * the document is, immediately on file drop, before any schema work.
 *
 * Uploads to Mistral Files API once and surfaces the file_id in the SSE so a
 * follow-up call (schema-generate, OCR Run) can reuse it without re-encoding.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import * as fs from 'node:fs/promises';
import { getFileSignedUrl, uploadFile } from '../lib/mistral-ocr/index.ts';
import { classifyDocument } from '../lib/classify.ts';

const MAX_BYTES = 25 * 1024 * 1024;

export function createClassifyRouter(uploadsDir: string): Router {
  const router = Router();
  const upload = multer({ dest: uploadsDir, limits: { fileSize: MAX_BYTES } });

  const acceptUpload: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next();
      const m = err as { code?: string; message?: string };
      if (m.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: 'file_too_large',
          message: `Datei zu groß. Max ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
          maxBytes: MAX_BYTES,
        });
        return;
      }
      res.status(400).json({ error: 'upload_failed', message: m.message ?? String(err) });
    });
  };

  router.post('/', acceptUpload, async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'file fehlt (multipart field "file")' });
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
    // Node emits IncomingMessage 'close' once the request has been completed,
    // even if the SSE response is still streaming. Abort only when the client
    // closes the response before we finished writing it.
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    try {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) throw new Error('MISTRAL_API_KEY not set on server');

      const { file_id } = await uploadFile(req.file.path, req.file.originalname, { apiKey, signal: ac.signal });
      const { url: signedUrl } = await getFileSignedUrl(file_id, { apiKey, signal: ac.signal });

      send('classify_started', {
        filename: req.file.originalname,
        size: req.file.size,
        fileId: file_id,
      });

      const result = await classifyDocument({
        documentUrl: signedUrl,
        apiKey,
        signal: ac.signal,
        mime: req.file.mimetype,
        filename: req.file.originalname,
      });

      send('classify_done', {
        label: result.label,
        confidence: result.confidence,
        summary: result.summary,
        kpis: result.kpis,
        valueCount: result.valueCount,
        ms: result.ms,
        tokens: result.mistralUsage.total_tokens,
        fileId: file_id,
      });
      send('done', { fileId: file_id });
      res.end();
    } catch (e) {
      const err = e as Error & { name?: string };
      if (err?.name === 'AbortError') {
        send('error', { message: 'aborted by client' });
      } else {
        send('error', { message: err.message ?? String(err) });
      }
      res.end();
    } finally {
      // Local tmp upload only — we never persisted this anywhere else.
      if (req.file) await fs.unlink(req.file.path).catch(() => {});
    }
  });

  return router;
}
