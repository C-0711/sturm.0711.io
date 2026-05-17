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
 *
 * Kein Auth, kein Rate-Limit — lokales Dev-Tool. Vor Exponieren ins
 * Internet einen Reverse-Proxy + Auth davor stellen.
 */
import { Router, type Request, type Response } from 'express';
import { readFile, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getContainer, listContainers } from './ctx-store.ts';
import { retrieveFromContainer } from './ctx-shared.ts';

export function createCtxRouter(opts: { ollamaUrl?: string; embedCpu?: boolean } = {}): Router {
  const router = Router();
  router.use((_req, _res, next) => {
    _res.setHeader('Access-Control-Allow-Origin', '*');
    _res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    _res.setHeader('Access-Control-Allow-Headers', 'content-type');
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
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });
    if (rec.status !== 'indexed') return res.status(409).json({ error: 'not_indexed', id: req.params.id });

    const body = (req.body ?? {}) as { query?: string; k?: number };
    const query = String(body.query ?? '').trim();
    if (!query) return res.status(400).json({ error: 'query_required' });
    const k = Math.max(1, Math.min(50, Number(body.k ?? 8)));

    try {
      const hits = await retrieveFromContainer(rec.outDir, query, k, opts);
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
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(body);
    } catch {
      return res.status(404).json({ error: 'atom_not_found' });
    }
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
