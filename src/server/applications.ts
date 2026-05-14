/**
 * Application-Instances REST-Layer.
 *
 * Persistenz: JSON-Dateien unter `applications/<appId>/<caseId>.json`. Bewusst
 * kein Postgres/Redis — kompatibel zu CLAUDE.md MVP-Regel ("JSON-Persistenz im
 * MVP"). Wenn später Postgres-Tax-Case-Container live geschaltet werden, kann
 * derselbe Contract gegen die gitchain-Registry backen.
 *
 * Phase 4a: CRUD (create, list, get).
 * Phase 4b: trigger-Endpoints (upload/seal/export) — werden später ergänzt.
 */
import { Router } from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listApplications, getApplication } from '../core/registry.ts';

export interface ApplicationInstance {
  caseId: string;
  appId: string;
  displayName: string;
  mandantId: string;
  veranlagungsjahr?: number;
  status: 'in_bearbeitung' | 'review' | 'versiegelt' | 'eingereicht';
  createdAt: string;
  updatedAt: string;
  /** Run-IDs des extraction-Workflows, jüngste zuletzt. */
  runs: string[];
  /** Pfad zum Workspace-Verzeichnis (uploads, artifacts). Relativ zum Server-Cwd. */
  workspacePath: string;
  sealedAt?: string;
  sealCommitSha?: string;
  exportedAt?: string;
  einreichungsId?: string;
}

export interface CreateInstanceBody {
  mandant_id: string;
  displayName: string;
  veranlagungsjahr?: number;
}

/** ISO-konformer kebab-case-Slug — eindeutige caseId-Komponente. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function makeCaseId(displayName: string, veranlagungsjahr?: number): string {
  const slug = slugify(displayName) || 'fall';
  // Veranlagungsjahr nur anhängen, wenn nicht schon im Slug enthalten — vermeidet
  // doppelte Jahres-Suffixe ("mustermann-2024-2024-…").
  const jahr = veranlagungsjahr ? String(veranlagungsjahr) : '';
  const slugHasJahr = jahr && slug.includes(jahr);
  const t = Date.now().toString(36);
  return slugHasJahr ? `${slug}-${t}` : `${slug}${jahr ? `-${jahr}` : ''}-${t}`;
}

export interface ApplicationsRouterOptions {
  /** Root-Verzeichnis für persistente Instanzen (z.B. <cwd>/applications-data). */
  dir: string;
}

/** Pfad zur Instanz-Datei für (appId, caseId). */
export function instanceFilePath(rootDir: string, appId: string, caseId: string): string {
  return path.join(rootDir, appId, `${caseId}.json`);
}

/** Liest eine Instanz oder null bei nicht-existent. */
export async function loadInstanceFile(
  rootDir: string,
  appId: string,
  caseId: string,
): Promise<ApplicationInstance | null> {
  try {
    const raw = await fs.readFile(instanceFilePath(rootDir, appId, caseId), 'utf-8');
    return JSON.parse(raw) as ApplicationInstance;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Schreibt eine Instanz (legt das Verzeichnis bei Bedarf an). */
export async function saveInstanceFile(
  rootDir: string,
  inst: ApplicationInstance,
): Promise<void> {
  const dir = path.join(rootDir, inst.appId);
  await fs.mkdir(dir, { recursive: true });
  inst.updatedAt = new Date().toISOString();
  await fs.writeFile(
    instanceFilePath(rootDir, inst.appId, inst.caseId),
    JSON.stringify(inst, null, 2),
    'utf-8',
  );
}

export function createApplicationsRouter(opts: ApplicationsRouterOptions): Router {
  const router = Router();
  const ROOT = opts.dir;

  async function instancesDir(appId: string): Promise<string> {
    const p = path.join(ROOT, appId);
    await fs.mkdir(p, { recursive: true });
    return p;
  }

  async function loadInstance(appId: string, caseId: string): Promise<ApplicationInstance | null> {
    return loadInstanceFile(ROOT, appId, caseId);
  }

  async function saveInstance(inst: ApplicationInstance): Promise<void> {
    return saveInstanceFile(ROOT, inst);
  }

  // ── GET /api/applications/:appId/instances ─────────────────────────────
  router.get('/:appId/instances', async (req, res) => {
    const appId = req.params.appId;
    if (!getApplication(appId)) {
      return res.status(404).json({ error: `application not found: ${appId}` });
    }
    const dir = await instancesDir(appId);
    let files: string[];
    try { files = await fs.readdir(dir); } catch { files = []; }
    const items: ApplicationInstance[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        items.push(JSON.parse(raw) as ApplicationInstance);
      } catch {
        // skip corrupted file; reported elsewhere
      }
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(items);
  });

  // ── GET /api/applications/:appId/instances/:caseId ─────────────────────
  router.get('/:appId/instances/:caseId', async (req, res) => {
    const { appId, caseId } = req.params;
    if (!getApplication(appId)) {
      return res.status(404).json({ error: `application not found: ${appId}` });
    }
    const inst = await loadInstance(appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    res.json(inst);
  });

  // ── POST /api/applications/:appId/instances ────────────────────────────
  router.post('/:appId/instances', async (req, res) => {
    const appId = req.params.appId;
    const app = getApplication(appId);
    if (!app) return res.status(404).json({ error: `application not found: ${appId}` });

    const body = (req.body ?? {}) as CreateInstanceBody;
    if (app.mandantRequired && (!body.mandant_id || typeof body.mandant_id !== 'string')) {
      return res.status(400).json({ error: 'mandant_id (string) required' });
    }
    if (!body.displayName || typeof body.displayName !== 'string') {
      return res.status(400).json({ error: 'displayName (string) required' });
    }

    const caseId = makeCaseId(body.displayName, body.veranlagungsjahr);
    const now = new Date().toISOString();
    const workspacePath = path.join('applications', appId, caseId);
    const inst: ApplicationInstance = {
      caseId,
      appId,
      displayName: body.displayName,
      mandantId: body.mandant_id ?? '',
      veranlagungsjahr: body.veranlagungsjahr,
      status: 'in_bearbeitung',
      createdAt: now,
      updatedAt: now,
      runs: [],
      workspacePath,
    };
    // Workspace-Verzeichnis bereits anlegen, damit Upload-Trigger später nichts
    // mehr zu prüfen hat.
    await fs.mkdir(path.join(process.cwd(), workspacePath, 'inbox'), { recursive: true });
    await fs.mkdir(path.join(process.cwd(), workspacePath, 'runs'), { recursive: true });
    await saveInstance(inst);
    res.status(201).json(inst);
  });

  return router;
}

/** Listet alle registrierten Anwendungen (verwendet vom landing UI). */
export function listAllApplicationsForApi() {
  return listApplications();
}
