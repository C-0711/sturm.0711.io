/**
 * User-defined workflows — persistence + REST.
 *
 * Workflows are stored as `workflows-user/<id>.json` (gitignored). On boot,
 * `loadAndRegisterUserWorkflows()` reads them all and calls `registerWorkflow`.
 * The designer UI POSTs full WorkflowDef payloads here.
 *
 * Difference vs. config-overrides: config-overrides patches an existing built-
 * in workflow's stage configs. User-workflows are *new* workflows authored
 * from scratch via the designer.
 */
import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getStage, getWorkflow, registerWorkflow } from '../core/registry.ts';
import type { WorkflowDef } from '../core/types.ts';

const ID_RX = /^[a-z][a-z0-9_-]{0,63}$/;

export interface UserWorkflowFile {
  workflow: WorkflowDef;
  /** Optional ReactFlow node positions, keyed by stageId. */
  layout?: Record<string, { x: number; y: number }>;
  updatedAt: string;
}

function safeId(id: string): boolean {
  return ID_RX.test(id);
}

function validateWorkflow(def: unknown): { ok: true; def: WorkflowDef } | { ok: false; error: string } {
  if (!def || typeof def !== 'object') return { ok: false, error: 'workflow must be an object' };
  const d = def as Partial<WorkflowDef>;
  if (typeof d.id !== 'string' || !safeId(d.id)) return { ok: false, error: 'workflow.id must be snake_case (^[a-z][a-z0-9_-]{0,63}$)' };
  if (typeof d.name !== 'string' || !d.name) return { ok: false, error: 'workflow.name required' };
  if (!d.input || typeof d.input !== 'object') return { ok: false, error: 'workflow.input required' };
  if (!d.stages || typeof d.stages !== 'object') return { ok: false, error: 'workflow.stages required' };
  const stageIds = Object.keys(d.stages);
  if (stageIds.length === 0) return { ok: false, error: 'workflow.stages must have at least one entry' };
  for (const [sid, s] of Object.entries(d.stages)) {
    if (!s || typeof s !== 'object') return { ok: false, error: `stage "${sid}" must be an object` };
    if (typeof (s as { uses?: unknown }).uses !== 'string') return { ok: false, error: `stage "${sid}".uses required` };
    const uses = (s as { uses: string }).uses;
    if (!getStage(uses)) return { ok: false, error: `stage "${sid}".uses="${uses}" is not a registered stage` };
  }
  const edges = d.edges ?? [];
  if (!Array.isArray(edges)) return { ok: false, error: 'workflow.edges must be array' };
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || typeof e[1] !== 'string') {
      return { ok: false, error: 'workflow.edges entries must be [string, string]' };
    }
    if (!stageIds.includes(e[0])) return { ok: false, error: `edge from unknown stage "${e[0]}"` };
    if (!stageIds.includes(e[1])) return { ok: false, error: `edge to unknown stage "${e[1]}"` };
  }
  return { ok: true, def: d as WorkflowDef };
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((f) => f.endsWith('.json'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

async function readFile(dir: string, id: string): Promise<UserWorkflowFile | null> {
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8');
    return JSON.parse(raw) as UserWorkflowFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeFile(dir: string, id: string, payload: UserWorkflowFile): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify(payload, null, 2));
}

async function deleteFile(dir: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(join(dir, `${id}.json`));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Read every workflows-user/*.json and register each. Called once at server
 * boot, AFTER registerAllStages() so `uses` references resolve.
 */
export async function loadAndRegisterUserWorkflows(dir: string): Promise<{ loaded: number; errors: string[] }> {
  const errors: string[] = [];
  const files = await listFiles(dir);
  let loaded = 0;
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    if (!safeId(id)) {
      errors.push(`${f}: filename id "${id}" not snake_case — skipped`);
      continue;
    }
    try {
      const payload = await readFile(dir, id);
      if (!payload || !payload.workflow) {
        errors.push(`${f}: missing payload.workflow — skipped`);
        continue;
      }
      const v = validateWorkflow(payload.workflow);
      if (!v.ok) {
        errors.push(`${f}: ${v.error} — skipped`);
        continue;
      }
      if (getWorkflow(v.def.id)) {
        errors.push(`${f}: workflow id "${v.def.id}" collides with a registered workflow — skipped`);
        continue;
      }
      registerWorkflow(v.def);
      loaded += 1;
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { loaded, errors };
}

export interface WorkflowsUserRouterOpts {
  dir: string;
  /**
   * Snapshot of workflow IDs that were registered BEFORE user-workflows were
   * loaded — i.e. the built-ins. POST refuses to overwrite these regardless of
   * what's currently in the in-memory registry. Without this, a user-added
   * workflow whose disk-file got deleted out-of-band would be mistaken for a
   * built-in on the next save attempt.
   */
  builtInIds: ReadonlySet<string>;
}

export function createWorkflowsUserRouter(opts: WorkflowsUserRouterOpts): Router {
  const r = Router();
  const dir = opts.dir;
  const builtInIds = opts.builtInIds;

  // LIST — returns lightweight metadata
  r.get('/', async (_req: Request, res: Response) => {
    try {
      const files = await listFiles(dir);
      const out: Array<{ id: string; name: string; description: string; updatedAt: string }> = [];
      for (const f of files) {
        const id = f.replace(/\.json$/, '');
        const p = await readFile(dir, id);
        if (!p) continue;
        out.push({
          id: p.workflow?.id ?? id,
          name: p.workflow?.name ?? id,
          description: p.workflow?.description ?? '',
          updatedAt: p.updatedAt ?? '',
        });
      }
      out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // GET — full payload (workflow + layout + updatedAt)
  r.get('/:id', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!safeId(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const p = await readFile(dir, id);
      if (!p) { res.status(404).json({ error: 'not found' }); return; }
      res.json(p);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // SAVE — upsert. Body: { workflow: WorkflowDef, layout?: {...} }
  r.post('/:id', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!safeId(id)) { res.status(400).json({ error: 'invalid id (snake_case required)' }); return; }
    const body = req.body ?? {};
    if (!body.workflow) { res.status(400).json({ error: 'body.workflow required' }); return; }
    if (body.workflow.id !== id) {
      res.status(400).json({ error: `body.workflow.id ("${body.workflow.id}") must match URL id ("${id}")` });
      return;
    }
    // Refuse to overwrite a built-in workflow. Source-of-truth is the boot-time
    // snapshot — NOT the live registry, which may contain user-added workflows
    // whose disk file got removed externally.
    if (builtInIds.has(id)) {
      res.status(409).json({ error: `workflow id "${id}" collides with a built-in workflow` });
      return;
    }
    const v = validateWorkflow(body.workflow);
    if (!v.ok) { res.status(400).json({ error: v.error }); return; }
    // Optional layout
    let layout: Record<string, { x: number; y: number }> | undefined;
    if (body.layout && typeof body.layout === 'object') {
      layout = {};
      for (const [k, val] of Object.entries(body.layout as Record<string, unknown>)) {
        if (val && typeof val === 'object' && 'x' in val && 'y' in val) {
          const x = (val as { x: unknown }).x;
          const y = (val as { y: unknown }).y;
          if (typeof x === 'number' && typeof y === 'number') {
            layout[k] = { x, y };
          }
        }
      }
    }
    const payload: UserWorkflowFile = {
      workflow: v.def,
      layout,
      updatedAt: new Date().toISOString(),
    };
    try {
      const wasRegistered = !!getWorkflow(id);
      await writeFile(dir, id, payload);
      // Hot-register: if not yet in the live registry, register; if already
      // there (e.g. user-overwriting their own workflow this session), leave
      // it — registry has no replace API, so changes apply next server boot.
      let hotRegistered = false;
      if (!wasRegistered) {
        try { registerWorkflow(v.def); hotRegistered = true; }
        catch (e) {
          console.warn(`[workflows-user] register skipped: ${(e as Error).message}`);
        }
      }
      res.status(201).json({ ok: true, id, updatedAt: payload.updatedAt, hotRegistered });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // DELETE — removes the file. Note: in-memory registration is NOT removed (no
  // unregister API) — workflow keeps running this session but vanishes on next boot.
  r.delete('/:id', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!safeId(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const ok = await deleteFile(dir, id);
      if (!ok) { res.status(404).json({ error: 'not found' }); return; }
      res.json({ ok: true, id, note: 'removed from disk; takes effect on next server boot' });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return r;
}
