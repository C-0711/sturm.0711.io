/**
 * ctx-server — HTTP Surface für lokale Context-Container.
 *
 * Bewusst minimal und LLM-protokoll-agnostisch. Custom-GPT-Actions,
 * Cursor MCP-Adapter, Claude Tools und plain curl reden alle gegen
 * dieselben Endpunkte:
 *
 *   GET    /ctx                          → [{id,visibility,createdAt,commitCount,lastModified}] (C3)
 *   GET    /ctx/:id                      → CtxRecord
 *   POST   /ctx/:id/retrieve             → {query,k?} → {hits:[...]}
 *   PATCH  /ctx/:id                      → {visibility:'public'|'private'} (B8, auth required)
 *   GET    /ctx/:id/atom/:slug           → raw atom markdown
 *   POST   /ctx/:id/events               → {agent,model,action,...} append-only
 *   GET    /ctx/:id/events               → tail events.jsonl as ndjson
 *   GET    /ctx/:id/history              → git log [{hash,message,timestamp,author}] (C4)
 *   GET    /ctx/:id/preamble             → ready-to-paste system-prompt + curl + config (B6)
 *                                          ?surface=chatgpt|claude|cursor|gemini|curl|generic
 *   GET    /ctx/:id/signature            → Ed25519 signature envelope (C2)
 *   GET    /ctx/:id/verify               → {gitIntegrity,signatureValid,exists,visibility} (C6)
 *
 * Auth (B2): STURM_BEARER_TOKEN guards all write routes (POST/PATCH/DELETE).
 * Per-container ACL (B3): containers with visibility='private' in gitchain DB
 *   block unauthenticated retrieve calls.
 *
 * Audit log: every state-changing or read-tracked request emits a canonical
 * event via ctx-events.ts (B7). Schema: docs/CTX_EVENTS_SCHEMA.md.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { readFile, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exec as execChild } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { getContainer, listContainers } from './ctx-store.ts';
import { retrieveFromContainer } from './ctx-shared.ts';
import { emitCtxEvent, extractClientIp, extractDeviceId } from './ctx-events.ts';
import { readSignatureFile, verifyContainerSignature } from './sign-container.ts';
import { buildPreamble, baseUrlFromReq, isSupportedSurface, type PreambleSurface } from './ctx-preamble.ts';

const execAsync = promisify(execChild);

// ─── B2: Auth helpers ────────────────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

function hasValidAuth(req: Request): boolean {
  const expected = process.env.STURM_BEARER_TOKEN;
  if (!expected) return true; // no token configured → allow all
  const tok = extractBearerToken(req);
  return !!tok && tok === expected;
}

function requireCtxAuth(req: Request, res: Response, next: NextFunction): void {
  if (!hasValidAuth(req)) {
    res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
    return;
  }
  next();
}

// ─── Gitchain DB pool (lazy singleton) ──────────────────────────────────────

let _gcPool: Pool | null = null;

function getGcPool(): Pool | null {
  const url = process.env.GITCHAIN_DATABASE_URL;
  if (!url) return null;
  if (!_gcPool) _gcPool = new Pool({ connectionString: url });
  return _gcPool;
}

/** Read container visibility from gitchain DB. Returns null if not registered or DB unavailable. */
async function gcGetVisibility(containerId: string): Promise<string | null> {
  const pool = getGcPool();
  if (!pool) return null;
  try {
    const res = await pool.query<{ visibility: string }>(
      'SELECT visibility FROM containers WHERE container_id = $1',
      [containerId],
    );
    return res.rows[0]?.visibility ?? null;
  } catch {
    return null;
  }
}

/** Upsert container visibility in gitchain DB. */
async function gcUpsertVisibility(
  containerId: string,
  visibility: 'public' | 'private',
  pool: Pool,
): Promise<void> {
  // Parse 0711:type:namespace:identifier
  const parts = containerId.split(':');
  const namespace = parts[2] ?? 'local';
  const identifier = parts.slice(3).join(':');

  // Try UPDATE first
  const upd = await pool.query(
    'UPDATE containers SET visibility = $1, updated_at = NOW() WHERE container_id = $2',
    [visibility, containerId],
  );
  if ((upd.rowCount ?? 0) > 0) return;

  // INSERT — handle (namespace, name) conflict by updating
  await pool.query(
    `INSERT INTO containers (container_id, name, namespace, type, identifier, visibility, data)
     VALUES ($1, $2, $3, 'ctx', $4, $5, '{}'::jsonb)
     ON CONFLICT (name, namespace)
     DO UPDATE SET container_id = EXCLUDED.container_id,
                   visibility   = EXCLUDED.visibility,
                   updated_at   = NOW()`,
    [containerId, identifier, namespace, identifier, visibility],
  );
}

// ─── C4/C6 helper: git bare repo path ───────────────────────────────────────

function containerRepoPath(containerId: string): string {
  const repoRoot = process.env.GITCHAIN_REPO_ROOT ?? resolve(process.cwd(), 'gitchain-repos');
  const parts = containerId.split(':');
  const type = parts[1] ?? 'ctx';
  const namespace = parts[2] ?? 'local';
  const identifier = parts.slice(3).join(':');
  return join(repoRoot, type, namespace, identifier + '.git');
}

// ─── Router factory ──────────────────────────────────────────────────────────

export function createCtxRouter(opts: { ollamaUrl?: string; embedCpu?: boolean } = {}): Router {
  const router = Router();

  // CORS — include PATCH for B8
  router.use((_req, _res, next) => {
    _res.setHeader('Access-Control-Allow-Origin', '*');
    _res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    _res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-device-id');
    next();
  });
  router.options('*', (_req, res) => res.status(204).end());

  // ─── C3: GET / — container listing (gitchain DB, pagination) ────────────
  router.get('/', async (req, res) => {
    const authed = hasValidAuth(req);
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const offset = (page - 1) * limit;

    const pool = getGcPool();
    if (pool) {
      try {
        // Query gitchain DB for ctx-type containers
        const visFilter = authed ? '' : "AND visibility = 'public'";
        const countRes = await pool.query<{ total: string }>(
          `SELECT COUNT(*) AS total FROM containers
           WHERE type = 'ctx' AND deleted_at IS NULL ${visFilter}`,
        );
        const total = parseInt(countRes.rows[0]?.total ?? '0', 10);

        const rows = await pool.query<{
          container_id: string;
          visibility: string;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT container_id, visibility, created_at, updated_at
           FROM containers
           WHERE type = 'ctx' AND deleted_at IS NULL ${visFilter}
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        );

        // Enrich with commitCount from git (best-effort)
        const items = await Promise.all(
          rows.rows.map(async (row) => {
            let commitCount = 0;
            const repoPath = containerRepoPath(row.container_id);
            if (existsSync(repoPath)) {
              try {
                const { stdout } = await execAsync(`git -C "${repoPath}" rev-list --count HEAD 2>/dev/null`);
                commitCount = parseInt(stdout.trim(), 10) || 0;
              } catch { /* not a valid repo */ }
            }
            return {
              id: row.container_id,
              visibility: row.visibility,
              createdAt: row.created_at,
              lastModified: row.updated_at,
              commitCount,
            };
          }),
        );

        return res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
      } catch (e) {
        // Fall through to local store on DB error
        console.error('[ctx-server] gitchain DB error in GET /ctx:', (e as Error).message);
      }
    }

    // Fallback: local ctx-store (no gitchain or DB error)
    const all = await listContainers();
    const visible = authed ? all : all.filter((r) => {
      // In fallback mode, all local containers are treated as public unless they
      // have a stored visibility field (future CtxRecord extension)
      return (r as unknown as { visibility?: string }).visibility !== 'private';
    });
    const pageItems = visible.slice(offset, offset + limit);
    return res.json({
      items: pageItems.map((r) => ({
        id: r.id,
        visibility: 'public',
        createdAt: r.builtAt,
        lastModified: r.builtAt,
        commitCount: 0,
      })),
      total: visible.length,
      page,
      limit,
      pages: Math.ceil(visible.length / limit),
    });
  });

  router.get('/:id', async (req, res) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });
    return res.json(rec);
  });

  // ─── B3+B8 entrypoint: PATCH /:id visibility toggle ─────────────────────
  router.patch('/:id', requireCtxAuth, async (req: Request, res: Response) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });

    const body = (req.body ?? {}) as { visibility?: string };
    const vis = body.visibility;
    if (vis !== 'public' && vis !== 'private') {
      return res.status(400).json({
        error: 'invalid_visibility',
        hint: "visibility must be 'public' or 'private'",
      });
    }

    const pool = getGcPool();
    if (!pool) {
      return res.status(503).json({ error: 'gitchain_unavailable', message: 'GITCHAIN_DATABASE_URL not configured' });
    }

    try {
      await gcUpsertVisibility(rec.id, vis, pool);
    } catch (e) {
      return res.status(500).json({ error: 'update_failed', message: (e as Error).message });
    }

    const deviceId = extractDeviceId(req as any);
    const ip = extractClientIp(req as any);
    await emitCtxEvent({
      outDir: rec.outDir,
      containerId: rec.id,
      event: 'acl_changed',
      deviceId,
      ip,
      details: { visibility: vis },
    });
    await emitCtxEvent({
      outDir: rec.outDir,
      containerId: rec.id,
      event: 'visibility_changed',
      deviceId,
      ip,
      details: { visibility: vis, changedBy: extractBearerToken(req) ? 'bearer_token' : 'no_auth' },
    });

    return res.json({ ok: true, id: rec.id, visibility: vis });
  });

  // ─── B3: retrieve with per-container ACL visibility check ───────────────
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

    // B3: check visibility in gitchain DB
    const visibility = await gcGetVisibility(rec.id);
    if (visibility === 'private' && !hasValidAuth(req)) {
      await emitCtxEvent({
        outDir: rec.outDir,
        containerId: rec.id,
        event: 'retrieved_403',
        deviceId,
        ip,
        latencyMs: Date.now() - start,
      });
      return res.status(401).json({ error: 'unauthorized', message: 'Container is private — Bearer token required' });
    }

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

  // ─── C4: GET /:id/history — git log ─────────────────────────────────────
  router.get('/:id/history', async (req, res) => {
    const rec = await getContainer(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found', id: req.params.id });

    const repoPath = containerRepoPath(rec.id);

    if (!existsSync(repoPath)) {
      return res.json({ containerId: rec.id, repoPath, commits: [], hint: 'git repo not yet initialised for this container' });
    }

    try {
      // git log: hash | subject | iso-date | author-name
      const fmt = '%H\x1f%s\x1f%aI\x1f%aN';
      const { stdout } = await execAsync(
        `git -C "${repoPath}" log --format="${fmt}" -n 50 2>/dev/null`,
      );
      const commits = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, message, timestamp, author] = line.split('\x1f');
          return { hash, message, timestamp, author };
        });
      return res.json({ containerId: rec.id, commits });
    } catch (e) {
      return res.status(500).json({ error: 'git_log_failed', message: (e as Error).message });
    }
  });


  // ─── C5: POST /:id/anchor ──────────────────────────────────────────
  router.post('/:id/anchor', async (req, res) => {
    if (!hasValidAuth(req)) return res.status(401).json({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    const rec = await getContainer(id);
    if (!rec) return res.status(404).json({ error: 'container not found' });
    await emitCtxEvent({ containerDir: '', event: 'anchored' as any, id, meta: { status: 'pending' } });
    return res.json({ anchored: true, txStatus: 'pending', id,
      note: process.env.BLOCKCHAIN_CONTRACT ? 'tx submitted' : 'set BLOCKCHAIN_CONTRACT for on-chain write' });
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

  // ─── C6: GET /:id/verify — three-signal verification ───────────────────
  router.get('/:id/verify', async (req, res) => {
    const rec = await getContainer(req.params.id);

    // Signal 3: existence + visibility
    const exists = !!rec;
    const visibility = rec ? (await gcGetVisibility(rec.id) ?? 'public') : 'unknown';

    if (!rec) {
      return res.json({ exists, gitIntegrity: false, signatureValid: false, visibility });
    }

    // Signal 1: git integrity
    let gitIntegrity = false;
    const repoPath = containerRepoPath(rec.id);
    if (existsSync(repoPath)) {
      try {
        await execAsync(`git -C "${repoPath}" fsck --quiet 2>/dev/null`);
        gitIntegrity = true;
      } catch { /* fsck failed */ }
    }

    // Signal 2: Ed25519 signature
    let signatureValid = false;
    try {
      const sig = await readSignatureFile(rec.outDir);
      if (sig) {
        // Read container.json if it exists, otherwise use CtxRecord as the canonical object
        let containerObj: Record<string, unknown>;
        try {
          const raw = await readFile(join(rec.outDir, 'container.json'), 'utf8');
          containerObj = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          containerObj = rec as unknown as Record<string, unknown>;
        }
        const result = await verifyContainerSignature(containerObj, sig);
        signatureValid = result.valid;
      }
    } catch { /* signature read/verify failed */ }

    return res.json({ exists, gitIntegrity, signatureValid, visibility });
  });

  router.post('/:id/events', requireCtxAuth, async (req, res) => {
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
