/**
 * ctx-server — HTTP Surface für lokale Context-Container.
 *
 * Bewusst minimal und LLM-protokoll-agnostisch. Custom-GPT-Actions,
 * Cursor MCP-Adapter, Claude Tools und plain curl reden alle gegen
 * dieselben Endpunkte:
 *
 *   GET    /ctx                          → [{id,name,atomCount,status}]
 *   GET    /ctx/:id                      → CtxRecord
 *   POST   /ctx/:id/retrieve             → {query,k?} → {hits:[...]}
 *   GET    /ctx/:id/atom/:slug           → raw atom markdown
 *   POST   /ctx/:id/events               → {agent,model,action,...} append-only
 *   GET    /ctx/:id/events               → tail events.jsonl as ndjson
 *   GET    /ctx/:id/preamble             → ready-to-paste system-prompt + curl + config (B6)
 *                                          ?surface=chatgpt|claude|cursor|gemini|curl|generic
 *
 * Audit log: every state-changing or read-tracked request emits a canonical
 * event via ctx-events.ts (B7). Schema: docs/CTX_EVENTS_SCHEMA.md.
 *
 * Auth: server-level Bearer middleware happens upstream in src/server.ts.
 * Per-container ACL is Phase B3 (Pope).
 */
import { Router, type Request, type Response } from 'express';
import { readFile, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getContainer, listContainers } from './ctx-store.ts';
import { retrieveFromContainer } from './ctx-shared.ts';
import { emitCtxEvent, extractClientIp, extractDeviceId } from './ctx-events.ts';
import { readSignatureFile } from './sign-container.ts';
import { buildPreamble, baseUrlFromReq, isSupportedSurface, type PreambleSurface } from './ctx-preamble.ts';

export function createCtxRouter(opts: { ollamaUrl?: string; embedCpu?: boolean } = {}): Router {
  const router = Router();
  router.use((_req, _res, next) => {
    _res.setHeader('Access-Control-Allow-Origin', '*');
    _res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    _res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-device-id');
    next();
  });
  router.options('*', (_req, res) => res.status(204).end());

  router.get('/', async (_req, res) => {
    const all = await listContainers();
    res.json(all.map((r) => ({
      id: r.id,
      shortId: r.shortId,
      name: r.name,
      atomCount: r.atomCount,
      status: r.status,
      builtAt: r.builtAt,
    })));
  });

  router.get('/:id', async (req, res) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });
    return res.json(rec);
  });

  router.post('/:id/retrieve', async (req: Request, res: Response) => {
    const start = Date.now();
    const deviceId = extractDeviceId(req as any);
    const ip = extractClientIp(req as any);

    const rec = await getContainer(req.params.id);
    if (!rec) {
      await emitCtxEvent({
        outDir: '/tmp', // no container outDir available; log to /tmp/orphan-events
        containerId: req.params.id,
        event: 'retrieved_404',
        deviceId,
        ip,
        latencyMs: Date.now() - start,
      });
      return res.status(404).json({ error: 'not_found', id: req.params.id });
    }
    if (rec.status !== 'indexed') return res.status(409).json({ error: 'not_indexed', id: req.params.id });

    const body = (req.body ?? {}) as { query?: string; k?: number };
    const query = String(body.query ?? '').trim();
    if (!query) return res.status(400).json({ error: 'query_required' });
    const k = Math.max(1, Math.min(50, Number(body.k ?? 8)));

    try {
      const hits = await retrieveFromContainer(rec.outDir, query, k, opts);
      const latencyMs = Date.now() - start;
      await emitCtxEvent({
        outDir: rec.outDir,
        containerId: rec.id,
        event: hits.length > 0 ? 'retrieved' : 'retrieved_empty',
        deviceId,
        ip,
        query,
        hitCount: hits.length,
        k,
        latencyMs,
      });
      return res.json({ containerId: rec.id, query, k, hits });
    } catch (e) {
      return res.status(500).json({ error: 'retrieve_failed', message: (e as Error).message });
    }
  });

  router.get('/:id/atom/:slug', async (req, res) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });
    try {
      const body = await readFile(join(rec.outDir, 'atoms', 'code', `${req.params.slug}.md`), 'utf8');
      await emitCtxEvent({
        outDir: rec.outDir,
        containerId: rec.id,
        event: 'atom_fetched',
        deviceId: extractDeviceId(req as any),
        ip: extractClientIp(req as any),
        details: { slug: req.params.slug },
      });
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(body);
    } catch {
      return res.status(404).json({ error: 'atom_not_found' });
    }
  });

  // ─── B6: preamble endpoint ──────────────────────────────────────────────
  router.get('/:id/preamble', async (req, res) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });

    const surfaceParam = String(req.query.surface ?? 'generic');
    const surface: PreambleSurface = isSupportedSurface(surfaceParam) ? surfaceParam : 'generic';
    const baseUrl = baseUrlFromReq(req as any);
    const preamble = buildPreamble({ rec, baseUrl, surface });

    await emitCtxEvent({
      outDir: rec.outDir,
      containerId: rec.id,
      event: 'preamble_fetched',
      deviceId: extractDeviceId(req as any),
      ip: extractClientIp(req as any),
      details: { surface },
    });

    return res.json(preamble);
  });

  // ─── C2: signature endpoint ────────────────────────────────────────────
  router.get('/:id/signature', async (req, res) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const sig = await readSignatureFile(rec.outDir);
    if (!sig) {
      return res.status(404).json({
        error: 'signature_not_found',
        id: req.params.id,
        hint: 'container was published before C2 — rebuild to materialise signature.json',
      });
    }
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(sig);
  });

  router.post('/:id/events', async (req, res) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const eventPath = join(rec.outDir, 'events.jsonl');
    const payload = req.body ?? {};
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...payload,
    }) + '\n';
    await appendFile(eventPath, line);
    // Also record the meta-event that an external agent appended something.
    await emitCtxEvent({
      outDir: rec.outDir,
      containerId: rec.id,
      event: 'events_appended',
      deviceId: extractDeviceId(req as any),
      ip: extractClientIp(req as any),
      details: { external_event: typeof payload.event === 'string' ? payload.event : 'unknown' },
    });
    return res.status(201).json({ ok: true });
  });

  router.get('/:id/events', async (req, res) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const eventPath = join(rec.outDir, 'events.jsonl');
    try {
      await stat(eventPath);
      const body = await readFile(eventPath, 'utf8');
      res.setHeader('Content-Type', 'application/x-ndjson');
      return res.send(body);
    } catch {
      return res.json([]);
    }
  });

  return router;
}
