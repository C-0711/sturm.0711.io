// case-stream.ts — SSE-Endpoint: GET /api/m/cases/:id/stream
//
// Mounts: app.use('/api/m', createCaseStreamRouter());
//
// Client connects mit EventSource. Liefert:
//   1. Initial replay aller buffered Events (für späte Subscriber)
//   2. Live-Stream aller neuen Events
//   3. Heartbeat alle 25s (gegen Cloudflare-Idle-Timeout)

import { Router, type Request, type Response } from 'express';
import { caseEvents, type CaseEvent } from './case-events.ts';
import { startCaseWatcher } from './case-watcher.ts';
import { narratorTick } from './case-narrator.ts';

function writeSseFrame(res: Response, event: CaseEvent): void {
  // SSE-Format: "event: <kind>\ndata: <json>\n\n"
  res.write(`event: ${event.kind}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createCaseStreamRouter(): Router {
  const router = Router();

  router.get('/cases/:caseId/stream', (req: Request, res: Response) => {
    const caseId = String(req.params.caseId || '').trim();
    if (!caseId) {
      res.status(400).json({ error: 'caseId fehlt' });
      return;
    }

    // SSE-Header
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx-buffering
    });
    res.flushHeaders();

    // Watcher starten (no-op wenn schon läuft)
    startCaseWatcher(caseId);

    // Initial-Replay + Greet
    writeSseFrame(res, {
      kind: 'heartbeat',
      ts: new Date().toISOString(),
      message: 'stream connected',
      data: { case_id: caseId },
    });
    for (const ev of caseEvents.replay(caseId)) {
      writeSseFrame(res, ev);
    }

    // Live-Subscribe
    const unsub = caseEvents.subscribe(caseId, (ev) => {
      writeSseFrame(res, ev);
    });

    // Heartbeat alle 25s
    const hb = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clearInterval(hb);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  });

  // Stats-Endpoint zum Debuggen
  router.get('/cases/_stream/stats', (_req, res) => {
    res.json({
      stats: caseEvents.stats(),
      ts: new Date().toISOString(),
    });
  });

  // Test-Endpoint zum Manuell-Event-Emit (für Debug/Demo)
  router.post('/cases/:caseId/_stream/emit', (req: Request, res: Response) => {
    const caseId = String(req.params.caseId);
    const ev = req.body || {};
    if (!ev.kind) {
      res.status(400).json({ error: 'kind fehlt' });
      return;
    }
    caseEvents.emit(caseId, ev);
    // Narrator nach kurzem Delay triggern (sammelt evtl. weitere Events)
    setTimeout(() => {
      void narratorTick(caseId).catch(e => {
        caseEvents.emit(caseId, { kind: 'narrator.error', message: String(e?.message ?? e) });
      });
    }, 800);
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  return router;
}
