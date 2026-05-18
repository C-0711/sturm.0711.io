/**
 * Mandanten-Cases-Router. Mounted unter `/api/m`.
 *
 * Liefert/erzeugt steuerfall-est-Instances, gefiltert auf
 * `ownerUserId === session.userId`.
 *
 * Endpoints (siehe docs/MANDANTEN_WORKSPACE.md):
 *   GET    /cases               — Liste der eigenen Fälle
 *   POST   /cases               — Neuen Fall anlegen
 *   DELETE /cases/:caseId       — Eigenen Fall löschen
 *
 * Wir delegieren die eigentliche Instance-Anlage NICHT an einen
 * HTTP-Self-Call, sondern an die geteilten Helper aus
 * `src/server/applications.ts` — das hält den Code zustandslos und vermeidet
 * eine Loopback-Authentifizierung.
 */

import { Router, type Request } from 'express';
import express from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  loadInstanceFile,
  saveInstanceFile,
  instanceFilePath,
  type ApplicationInstance,
} from './applications.ts';
import { getApplication } from '../core/registry.ts';
import { requireMandantenSession } from './m-auth.ts';
import { getUserById } from '../lib/m-users.ts';

const APP_ID = 'steuerfall-est';

export interface MandantenCasesRouterOptions {
  usersDir: string;
  workspacesDir: string;
  /** Server-Konstante `APPLICATIONS_DIR` (= `<repo>/applications-data`). */
  applicationsDir: string;
  /** Server-Konstante `RUNS_DIR`. Für lastRunAt-Heuristik. */
  runsDir: string;
}

interface ApplicationInstanceWithOwner extends ApplicationInstance {
  ownerUserId?: string;
}

interface MandantenRequestFields {
  mandantenUserId?: string;
  mandantenWorkspaceId?: string;
  mandantenEmail?: string;
}

/** Liest alle steuerfall-est-Instances und filtert auf ownerUserId. */
async function listOwnedInstances(
  applicationsDir: string,
  userId: string,
): Promise<ApplicationInstanceWithOwner[]> {
  const dir = path.join(applicationsDir, APP_ID);
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  const out: ApplicationInstanceWithOwner[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      const inst = JSON.parse(raw) as ApplicationInstanceWithOwner;
      if (inst.ownerUserId === userId) out.push(inst);
    } catch { /* skip corrupted */ }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/**
 * Heuristik für `lastRunAt`: jüngste mtime aller Stage-output.json im letzten
 * Run-Verzeichnis. Wenn nichts ermittelbar → null.
 */
async function readLastRunAt(
  runsDir: string,
  inst: ApplicationInstance,
): Promise<string | null> {
  if (inst.runs.length === 0) return null;
  const extractionId = getApplication(inst.appId)?.workflows.extraction;
  if (!extractionId) return null;
  const lastRunId = inst.runs[inst.runs.length - 1];
  const runDir = path.join(runsDir, extractionId, lastRunId);
  try {
    const st = await fs.stat(runDir);
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Liest `phase6BmfRechner/output.json` und extrahiert die zwei UI-relevanten
 * Größen `zvE` und `erstattung`. Bei Nachzahlung wird `erstattung` negativ
 * gespiegelt (UI rendert das einheitlich). Liefert null wenn kein BMF-Output.
 */
async function readAbrechnungSummary(
  runsDir: string,
  inst: ApplicationInstance,
): Promise<{ zvE: number; erstattung: number } | null> {
  if (inst.runs.length === 0) return null;
  const extractionId = getApplication(inst.appId)?.workflows.extraction;
  if (!extractionId) return null;
  const lastRunId = inst.runs[inst.runs.length - 1];
  const p = path.join(runsDir, extractionId, lastRunId, 'phase6BmfRechner', 'output.json');
  try {
    const raw = await fs.readFile(p, 'utf8');
    const bmf = JSON.parse(raw) as {
      zu_versteuerndes_einkommen?: number;
      erstattung?: number;
      nachzahlung?: number;
    };
    const zvE = typeof bmf.zu_versteuerndes_einkommen === 'number' ? bmf.zu_versteuerndes_einkommen : null;
    const erstattung = typeof bmf.erstattung === 'number'
      ? bmf.erstattung
      : (typeof bmf.nachzahlung === 'number' ? -bmf.nachzahlung : null);
    if (zvE == null || erstattung == null) return null;
    return { zvE, erstattung };
  } catch {
    return null;
  }
}

/** kebab-case-Slug (gespiegelt aus applications.ts — Duplikation bewusst, um
 *  die App-Logik nicht zu importieren-für-Slug-Generierung). */
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
  const jahr = veranlagungsjahr ? String(veranlagungsjahr) : '';
  const slugHasJahr = jahr && slug.includes(jahr);
  const t = Date.now().toString(36);
  return slugHasJahr ? `${slug}-${t}` : `${slug}${jahr ? `-${jahr}` : ''}-${t}`;
}

export function createMandantenCasesRouter(opts: MandantenCasesRouterOptions): Router {
  const router = Router();
  router.use(express.json({ limit: '64kb' }));
  router.use(requireMandantenSession({ workspacesDir: opts.workspacesDir, usersDir: opts.usersDir }));

  // ── GET /cases ────────────────────────────────────────────────────────
  router.get('/cases', async (req, res) => {
    try {
      const userId = (req as Request & MandantenRequestFields).mandantenUserId!;
      const instances = await listOwnedInstances(opts.applicationsDir, userId);
      const emailCache = new Map<string, string | null>();
      async function ownerEmail(uid?: string): Promise<string | null> {
        if (!uid) return null;
        if (emailCache.has(uid)) return emailCache.get(uid)!;
        try {
          const u = await getUserById(opts.usersDir, uid);
          emailCache.set(uid, u?.email ?? null);
          return u?.email ?? null;
        } catch {
          emailCache.set(uid, null);
          return null;
        }
      }
      const cases = await Promise.all(instances.map(async (inst) => ({
        caseId: inst.caseId,
        displayName: inst.displayName,
        veranlagungsjahr: inst.veranlagungsjahr ?? null,
        createdAt: inst.createdAt,
        documentCount: inst.documents?.length ?? 0,
        lastRunAt: await readLastRunAt(opts.runsDir, inst),
        abrechnungSummary: await readAbrechnungSummary(opts.runsDir, inst),
        extractionWorkflow: (inst as { extractionWorkflow?: string }).extractionWorkflow ?? null,
        ownerEmail: await ownerEmail(inst.ownerUserId),
      })));
      res.json({ cases });
    } catch (e) {
      res.status(500).json({ error: 'cases_list_failed', message: (e as Error).message });
    }
  });

  // ── POST /cases ───────────────────────────────────────────────────────
  router.post('/cases', async (req, res) => {
    try {
      const userId = (req as Request & MandantenRequestFields).mandantenUserId!;
      const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
      const veranlagungsjahr = typeof req.body?.veranlagungsjahr === 'number'
        ? req.body.veranlagungsjahr
        : undefined;
      if (!displayName) {
        return res.status(400).json({ error: 'invalid_request', message: 'displayName erforderlich' });
      }
      if (!getApplication(APP_ID)) {
        return res.status(500).json({ error: 'app_not_registered', message: APP_ID });
      }

      const caseId = makeCaseId(displayName, veranlagungsjahr);
      const now = new Date().toISOString();
      const workspacePath = path.join('applications', APP_ID, caseId);
      const inst: ApplicationInstanceWithOwner = {
        caseId,
        appId: APP_ID,
        displayName,
        mandantId: userId, // Mandanten-IDs decken sich mit User-IDs.
        ownerUserId: userId,
        veranlagungsjahr,
        status: 'in_bearbeitung',
        createdAt: now,
        updatedAt: now,
        runs: [],
        workspacePath,
      };
      // Inbox + runs anlegen (spiegelt applications.ts POST-Handler).
      await fs.mkdir(path.join(process.cwd(), workspacePath, 'inbox'), { recursive: true });
      await fs.mkdir(path.join(process.cwd(), workspacePath, 'runs'), { recursive: true });
      await saveInstanceFile(opts.applicationsDir, inst);

      res.status(201).json({
        caseId,
        displayName,
        veranlagungsjahr: veranlagungsjahr ?? null,
      });
    } catch (e) {
      res.status(500).json({ error: 'case_create_failed', message: (e as Error).message });
    }
  });

  // ── PATCH /cases/:caseId ──────────────────────────────────────────────
  // Updates mutable per-case settings. Currently only `extractionWorkflow`
  // (the workflow used for NEW uploads — existing runs are unchanged).
  //
  // Body: { "extractionWorkflow": "elster-v6-vision" | "elster-v5_2-rag" | null }
  // null/empty → clears override → falls back to app default.
  // Allowed IDs are validated against the registry.
  router.patch('/cases/:caseId', async (req, res) => {
    try {
      const userId = (req as Request & MandantenRequestFields).mandantenUserId!;
      const { caseId } = req.params;
      const inst = (await loadInstanceFile(opts.applicationsDir, APP_ID, caseId)) as
        (ApplicationInstanceWithOwner & { extractionWorkflow?: string }) | null;
      if (!inst) return res.status(404).json({ error: 'case_not_found' });
      if (inst.ownerUserId !== userId) return res.status(404).json({ error: 'case_not_found' });

      const body = req.body as { extractionWorkflow?: string | null } | undefined;
      if (body && 'extractionWorkflow' in body) {
        const wf = body.extractionWorkflow;
        if (wf == null || wf === '') {
          delete (inst as { extractionWorkflow?: string }).extractionWorkflow;
        } else if (typeof wf !== 'string' || !/^[A-Za-z0-9._-]+$/.test(wf)) {
          return res.status(400).json({ error: 'invalid_workflow_id' });
        } else {
          const { getWorkflow } = await import('../core/registry.ts');
          if (!getWorkflow(wf)) {
            return res.status(400).json({ error: 'workflow_not_registered', wf });
          }
          (inst as { extractionWorkflow?: string }).extractionWorkflow = wf;
        }
        inst.updatedAt = new Date().toISOString();
        await saveInstanceFile(opts.applicationsDir, inst);
      }
      res.json({
        caseId: inst.caseId,
        extractionWorkflow: (inst as { extractionWorkflow?: string }).extractionWorkflow ?? null,
      });
    } catch (e) {
      res.status(500).json({ error: 'case_patch_failed', message: (e as Error).message });
    }
  });

  // ── DELETE /cases/:caseId ─────────────────────────────────────────────
  router.delete('/cases/:caseId', async (req, res) => {
    try {
      const userId = (req as Request & MandantenRequestFields).mandantenUserId!;
      const { caseId } = req.params;
      const inst = (await loadInstanceFile(opts.applicationsDir, APP_ID, caseId)) as
        ApplicationInstanceWithOwner | null;
      if (!inst) return res.status(404).json({ error: 'case_not_found' });
      if (inst.ownerUserId !== userId) {
        // Generisches 404 — kein Hinweis, dass der Fall existiert.
        return res.status(404).json({ error: 'case_not_found' });
      }

      // Instance-JSON + Workspace-Dir löschen.
      try { await fs.rm(instanceFilePath(opts.applicationsDir, APP_ID, caseId), { force: true }); }
      catch { /* tolerant */ }
      const wsAbs = path.isAbsolute(inst.workspacePath)
        ? inst.workspacePath
        : path.join(process.cwd(), inst.workspacePath);
      try { await fs.rm(wsAbs, { recursive: true, force: true }); }
      catch { /* tolerant */ }

      // Zugehörige Runs aus dem extraction-Workflow-Bereich löschen.
      const extractionId = getApplication(APP_ID)?.workflows.extraction;
      if (extractionId) {
        for (const runId of inst.runs) {
          if (!/^[A-Za-z0-9._-]+$/.test(runId)) continue;
          const runDir = path.join(opts.runsDir, extractionId, runId);
          try { await fs.rm(runDir, { recursive: true, force: true }); }
          catch { /* tolerant */ }
        }
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'case_delete_failed', message: (e as Error).message });
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────────────────────
// Ownership-Guard für bestehende `/api/applications/steuerfall-est/instances/:caseId`
// Routen. WENN Aufruf via Session-Cookie (Mandant) UND der Fall einen
// ownerUserId hat, der NICHT zur Session passt → 403.
//
// Bearer-Token-Aufrufe (Admin) und ownerless-Cases (Legacy, vor Mandanten-
// Surface angelegt) umgehen den Check.
// ─────────────────────────────────────────────────────────────────────────

export interface OwnershipGuardOptions {
  applicationsDir: string;
  workspacesDir: string;
  usersDir: string;
}

export function createOwnershipGuard(opts: OwnershipGuardOptions) {
  // Cookie-Name als Konstante — muss zu sessionCookieMiddleware passen.
  const COOKIE_NAME = 'sturm-session';

  function readCookie(req: Request, name: string): string | null {
    const raw = req.header('cookie');
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
  }

  return async (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
    // Nur für steuerfall-est-Instances guarden.
    const appId = req.params.appId;
    const caseId = req.params.caseId;
    if (appId !== APP_ID || !caseId) return next();

    // Bearer = Admin → durchlassen.
    const hasBearer = (req.headers['authorization'] ?? '').toString().toLowerCase().startsWith('bearer ');
    if (hasBearer) return next();

    // Kein Session-Cookie → durchlassen (öffentlicher Read auf /result und
    // /aggregate ist bewusst gewollt; harte Endpoints wie /upload-bulk und
    // /seal haben eigenen requireBearerToken-Guard). Wir lesen das Cookie
    // direkt — der Guard läuft potenziell VOR der globalen
    // sessionCookieMiddleware, je nach Mount-Reihenfolge.
    const sid = readCookie(req, COOKIE_NAME);
    if (!sid) return next();

    // Session validieren.
    const { getSession } = await import('../lib/sessions.ts');
    const session = await getSession(opts.workspacesDir, sid);
    if (!session) return next();

    // Mandanten-Session → ownerUserId-Check pflicht.
    const inst = (await loadInstanceFile(opts.applicationsDir, appId, caseId)) as
      ApplicationInstanceWithOwner | null;
    if (!inst) return next(); // 404 macht der eigentliche Handler.
    if (!inst.ownerUserId) return next(); // Legacy-Fall ohne Owner → durchlassen.

    const { readUserIdFromSession } = await import('./m-auth.ts');
    const userId = await readUserIdFromSession(opts.workspacesDir, session);
    if (userId && inst.ownerUserId === userId) return next();

    return res.status(403).json({ error: 'forbidden', message: 'Kein Zugriff auf diesen Fall.' });
  };
}
