/**
 * POST /api/applications/:appId/instances/:caseId/vorjahres-upload
 *
 * Mandanten-Onboarding via Vorjahres-Erklärung:
 *   1) Multipart-Upload eines PDF/Bild der kompletten Vorjahres-Einkommen-
 *      steuererklärung (z.B. ESt 2023).
 *   2) Triggert den Workflow `vorjahres-kontext-extract` (gemma-vision-ocr →
 *      elster-v3/vorjahres-kontext-extract).
 *   3) SSE-Streaming der Workflow-Events (gleiche Shape wie /upload-bulk).
 *   4) Persistiert Output: `<workspace>/vorjahres_kontext.json` + setzt
 *      `inst.context = CaseContext` im Instance-Manifest.
 *
 * Returns: SSE-Stream mit doc_start / stage_* / doc_done. Letztes Event ist
 * `vorjahres_kontext_persisted` mit `{ ok, context, ms }`.
 *
 * Verkabelt in src/server.ts via registerVorjahresUploadEndpoint(app, ctx).
 */
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runWorkflow } from '../core/runner.ts';
import { formatSseEvent } from '../core/events.ts';
import { getApplication, getWorkflow } from '../core/registry.ts';
import { applyOverrides, readOverrides } from '../core/config-overrides.ts';
import {
  loadInstanceFile,
  saveInstanceFile,
  type CaseContext,
  type ApplicationInstance,
} from './applications.ts';

const VORJAHRES_WORKFLOW_ID = 'vorjahres-kontext-extract';

export interface VorjahresUploadHandlerOptions {
  /** Repository root (für config-overrides + workspace paths). */
  rootDir: string;
  /** Runs-Verzeichnis. */
  runsDir: string;
  /** Multer upload-Verzeichnis. */
  uploadsDir: string;
  /** Verzeichnis der Application-Instances. */
  applicationsDir: string;
  /** Optional: Bearer-Token-Guard (z.B. requireBearerToken). */
  requireBearerToken?: (req: Request, res: Response, next: () => void) => void;
}

function absWorkspace(rootCwd: string, inst: { workspacePath: string }): string {
  return path.isAbsolute(inst.workspacePath)
    ? inst.workspacePath
    : path.join(rootCwd, inst.workspacePath);
}

async function persistVorjahresKontextArtifact(
  rootCwd: string,
  inst: ApplicationInstance,
  context: CaseContext,
  nested: Record<string, unknown>,
  runId: string,
  filename: string,
): Promise<string> {
  const wsAbs = absWorkspace(rootCwd, inst);
  await fs.mkdir(wsAbs, { recursive: true });
  const out = path.join(wsAbs, 'vorjahres_kontext.json');
  await fs.writeFile(
    out,
    JSON.stringify({
      filename,
      runId,
      generatedAt: new Date().toISOString(),
      context,
      nested,
    }, null, 2),
    'utf-8',
  );
  return out;
}

export function registerVorjahresUploadEndpoint(
  app: Express,
  opts: VorjahresUploadHandlerOptions,
): void {
  const upload = multer({
    dest: opts.uploadsDir,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB — Vorjahres-PDFs sind oft >25 MB
  });

  const middlewares: Array<(req: Request, res: Response, next: () => void) => void> = [];
  if (opts.requireBearerToken) middlewares.push(opts.requireBearerToken);
  middlewares.push(upload.single('file') as unknown as (req: Request, res: Response, next: () => void) => void);

  app.post(
    '/api/applications/:appId/instances/:caseId/vorjahres-upload',
    ...middlewares,
    async (req: Request, res: Response) => {
      const { appId, caseId } = req.params;

      const app_ = getApplication(appId);
      if (!app_) {
        res.status(404).json({ error: `application not found: ${appId}` });
        return;
      }
      const inst = await loadInstanceFile(opts.applicationsDir, appId, caseId);
      if (!inst) {
        res.status(404).json({ error: `case not found: ${caseId}` });
        return;
      }

      const baseDef = getWorkflow(VORJAHRES_WORKFLOW_ID);
      if (!baseDef) {
        res.status(409).json({ error: `vorjahres workflow not registered: ${VORJAHRES_WORKFLOW_ID}` });
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ error: 'file fehlt (multipart field "file")' });
        return;
      }

      // Optional ?vorjahr=2023 — sonst leiten wir das aus hauptvordruck.steuerjahr ab.
      const vorjahrParam = Number((req.query as Record<string, string>).vorjahr);
      const vorjahr = Number.isFinite(vorjahrParam) && vorjahrParam > 1900
        ? vorjahrParam
        : (inst.veranlagungsjahr ? inst.veranlagungsjahr - 1 : undefined);

      const def = applyOverrides(baseDef, await readOverrides(opts.rootDir, baseDef.id));
      const input: Record<string, unknown> = {
        filePath: file.path,
        filename: file.originalname,
        size: file.size,
        mime: file.mimetype,
        mandant_id: inst.mandantId,
        case_id: inst.caseId,
        vorjahr,
      };

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const tStart = Date.now();
      const run = runWorkflow(def, { runsDir: opts.runsDir, input, appId });

      // Run-ID + start-Event direkt an Client.
      res.write(formatSseEvent({
        name: 'run_meta',
        runId: run.runId,
        workflowId: def.id,
        at: new Date().toISOString(),
        payload: {
          stages: Object.keys(def.stages),
          appId,
          caseId,
          purpose: 'vorjahres-kontext',
          vorjahr,
        },
      }));
      res.write(formatSseEvent({
        name: 'doc_start',
        runId: run.runId,
        workflowId: def.id,
        at: new Date().toISOString(),
        payload: { docIdx: 0, filename: file.originalname, runId: run.runId },
      }));

      // Run-ID am Manifest festhalten (vor Workflow-Ende, falls Client trennt).
      inst.runs.push(run.runId);
      await saveInstanceFile(opts.applicationsDir, inst);

      const unsub = run.bus.subscribe((env) => res.write(formatSseEvent(env)));
      let aborted = false;
      req.on('close', () => { aborted = true; unsub(); });

      try {
        const result = await run.result;
        if (aborted) { res.end(); return; }

        if (result.state === 'ok') {
          const stageOut = result.stages?.vorjahresKontext?.output as {
            context: CaseContext;
            nested: Record<string, unknown>;
            ms: number;
          } | undefined;

          if (stageOut?.context) {
            // Persistiere als Workspace-Artefakt UND am Case-Manifest.
            const artifactPath = await persistVorjahresKontextArtifact(
              opts.rootDir, inst, stageOut.context, stageOut.nested,
              run.runId, file.originalname,
            );
            const freshInst = await loadInstanceFile(opts.applicationsDir, appId, caseId);
            if (freshInst) {
              freshInst.context = {
                ...stageOut.context,
                vorjahresKontextPfad: path.relative(opts.rootDir, artifactPath),
              };
              await saveInstanceFile(opts.applicationsDir, freshInst);
            }

            res.write(formatSseEvent({
              name: 'vorjahres_kontext_persisted',
              runId: run.runId,
              workflowId: def.id,
              at: new Date().toISOString(),
              payload: {
                ok: true,
                context: stageOut.context,
                artifactPath: path.relative(opts.rootDir, artifactPath),
                ms: Date.now() - tStart,
              },
            }));
          } else {
            res.write(formatSseEvent({
              name: 'vorjahres_kontext_persisted',
              runId: run.runId,
              workflowId: def.id,
              at: new Date().toISOString(),
              payload: { ok: false, error: 'stage output missing context', ms: Date.now() - tStart },
            }));
          }
        } else {
          res.write(formatSseEvent({
            name: 'vorjahres_kontext_persisted',
            runId: run.runId,
            workflowId: def.id,
            at: new Date().toISOString(),
            payload: { ok: false, error: `workflow state=${result.state}`, ms: Date.now() - tStart },
          }));
        }
      } catch (err) {
        res.write(formatSseEvent({
          name: 'vorjahres_kontext_persisted',
          runId: run.runId,
          workflowId: def.id,
          at: new Date().toISOString(),
          payload: { ok: false, error: (err as Error).message, ms: Date.now() - tStart },
        }));
      } finally {
        unsub();
        res.end();
      }
    },
  );
}
