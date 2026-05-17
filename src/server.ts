import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { registerAllStages } from './stages/index.ts';
import { registerAllWorkflows } from './workflows/index.ts';
import { registerAllApplications } from './applications/index.ts';
import { listWorkflows, getWorkflow, listStages, getStage, listApplications, getApplication } from './core/registry.ts';
import { ToolContainer, getToolContainer } from './core/tools/tool-container.ts';
import type { McpHandle } from './core/tools/handles.ts';
import { runWorkflow } from './core/runner.ts';
import { formatSseEvent } from './core/events.ts';
import type { WorkflowDef } from './core/types.ts';
import { createOcrPreviewRouter } from './server/ocr-preview.ts';
import { createSchemaGenerateRouter } from './server/schema-generate.ts';
import { createWorkspacesRouter, createPipelinesRouter } from './server/workspaces.ts';
import { createJobsRouter } from './server/jobs.ts';
import { JobRunner } from './lib/job-runner.ts';
import { registerJobHandlers } from './server/job-handlers.ts';
import { resolveMasterKey } from './lib/master-signer.ts';
import { createCtxRouter } from './lib/ctx-server.ts';
import { createIntegrationsRouter } from './server/integrations.ts';
import { createTokensRouter, createSessionRedeemRouter, sessionCookieMiddleware } from './server/sessions.ts';
import { createClassifyRouter } from './server/classify-route.ts';
import { createWorkflowsUserRouter, loadAndRegisterUserWorkflows } from './server/workflows-user.ts';
import {
  createApplicationsRouter,
  loadInstanceFile,
  saveInstanceFile,
} from './server/applications.ts';
// Stubs für noch nicht implementierte workspace→gitchain-Funktionen.
// Werden in der Seal-Handler-Pipeline aufgerufen aber sind in der aktuellen
// Codebase nicht fertig — return noop. Volle Impl folgt mit Lane-5-Anbindung.
const syncWorkspaceContainer = async (_containerId: string, _workspacePath: string): Promise<void> => {
  /* TODO: implement workspace→container sync */
};
const promoteWorkspaceToTaxCase = async (..._args: unknown[]): Promise<null> => null;
import { computeWorkflowStats } from './server/workflow-stats.ts';
import {
  persistUploadToInbox,
  recordDocumentRunCompletion,
  computeTrustBreakdown,
  readManifest,
  writeManifest,
} from './server/inbox.ts';
import {
  applyOverrides,
  deleteStageOverride,
  readOverrides,
  writeStageOverride,
} from './core/config-overrides.ts';
import { startUploadSweep } from './server/upload-sweep.ts';
import { requireBearerToken, warnIfDisabled } from './server/auth.ts';
import {
  getSchemaIndex,
  getSchemaVersion,
  listSchemas,
  putSchema,
  SchemaRepoError,
} from './core/schema-repo.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const RUNS_DIR = path.join(ROOT, 'runs');
const WORKSPACES_DIR = path.join(ROOT, 'workspaces');
const USER_WORKFLOWS_DIR = path.join(ROOT, 'workflows-user');
const APPLICATIONS_DIR = path.join(ROOT, 'applications-data');
const CANONICALS_DIR = path.join(__dirname, 'canonicals-seed');
const PIPELINES_DIR = path.join(__dirname, 'pipelines-seed');
const UI_DIR = path.join(__dirname, 'ui');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
fs.mkdirSync(USER_WORKFLOWS_DIR, { recursive: true });
fs.mkdirSync(APPLICATIONS_DIR, { recursive: true });

// Bootstrap-Registries
registerAllStages();
registerAllWorkflows();
// Anwendungen *nach* Workflows registrieren, damit Workflow-Refs validierbar sind.
registerAllApplications();
// Tool-Container pro Anwendung initialisieren. STURM_TOOLS_BOOT=skip
// überspringt die Probe — nützlich in Dev-Umgebungen ohne vLLM/gitchain.
if (process.env.STURM_TOOLS_BOOT === 'skip') {
  console.log('[tools] boot SKIPPED via STURM_TOOLS_BOOT=skip');
} else {
  const tools = await ToolContainer.bootAll();
  console.log(`  Tool-Container: ${tools.size} Anwendung(en) initialisiert`);
}
// Snapshot built-in IDs BEFORE user-workflows get registered. The workflows-user
// router uses this to decide what's a "true" built-in vs what's user-owned.
const builtInWorkflowIds = new Set(listWorkflows().map((w) => w.id));
// User-defined workflows from disk — load AFTER built-ins so id collisions are detected.
loadAndRegisterUserWorkflows(USER_WORKFLOWS_DIR).then((r) => {
  if (r.loaded > 0) console.log(`[workflows-user] loaded ${r.loaded} workflow(s) from disk`);
  for (const err of r.errors) console.warn(`[workflows-user] ${err}`);
}).catch((e) => console.warn(`[workflows-user] boot load failed: ${(e as Error).message}`));

const app = express();

// Security headers — CSP allows React + Babel-standalone from unpkg, plus inline
// scripts (text/babel transform) and inline styles already in the studio markup.
// Frame ancestors none + HSTS via helmet defaults.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      // Tesseract.js needs script + worker + WASM from unpkg/jsdelivr CDN
      'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
      'worker-src': ["'self'", 'blob:', 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
      // Tesseract fetches traineddata + wasm via XHR/fetch
      'connect-src': ["'self'", 'https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://tessdata.projectnaptha.com'],
      'frame-src': ["'self'", 'blob:'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  frameguard: { action: 'deny' },
}));

app.use(express.json({ limit: '2mb' }));

// Auth: opt-in. No-op when STURM_BEARER_TOKEN is unset.
warnIfDisabled();

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

const ocrPreviewLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const rl = (req as unknown as { rateLimit?: { resetTime?: Date } }).rateLimit;
    const retryAfterSec = rl?.resetTime
      ? Math.ceil((rl.resetTime.getTime() - Date.now()) / 1000)
      : 600;
    res.status(429).json({ error: 'rate_limited', retryAfter: Math.max(1, retryAfterSec) });
  },
});

// Schema-Generator: jeder Request macht 3-5 Chat-Calls → 10 req / 10 min / IP
// (≤50 chat calls per IP per 10 min). Eigene Surface, daher separater Limiter.
const schemaGenerateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const rl = (req as unknown as { rateLimit?: { resetTime?: Date } }).rateLimit;
    const retryAfterSec = rl?.resetTime
      ? Math.ceil((rl.resetTime.getTime() - Date.now()) / 1000)
      : 600;
    res.status(429).json({ error: 'rate_limited', retryAfter: Math.max(1, retryAfterSec) });
  },
});

// ============ Workflow-Metadaten ============

function summarizeWorkflow(def: WorkflowDef) {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    input: def.input,
    // Enrich each workflow stage with the underlying stage definition's
    // description + hints (inputPorts, outputPorts, configExample). The UI
    // uses this for the Inspector's "Transformation"-section and to label
    // node-tiles meaningfully. Falls back gracefully if a uses-id is not
    // registered (e.g. compose-only fanout branches).
    stages: Object.entries(def.stages).map(([id, s]) => {
      const stageDef = getStage(s.uses);
      return {
        id,
        uses: s.uses,
        name: s.name ?? stageDef?.name ?? id,
        description: s.description ?? stageDef?.description ?? null,
        hints: stageDef?.hints ?? null,
        // Workflow-stage wiring — needed by the Inspector to render the
        // "Eingaben"-table (input slot → resolved value preview). Without
        // these the inspector falsely claims "no inputs declared".
        inputs: s.inputs ?? {},
        config: s.config ?? {},
      };
    }),
    edges: def.edges,
    containers: def.containers ?? [],
  };
}

app.get('/api/workflows', (_req, res) => {
  res.json(listWorkflows().map(summarizeWorkflow));
});

app.get('/api/workflows/:id', (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) return res.status(404).json({ error: `workflow not found: ${req.params.id}` });
  res.json(summarizeWorkflow(def));
});

// Aggregat über die letzten N Runs: avg-ms pro Workflow + pro Stage, plus
// avg-Output-Size pro Stage (heuristisch). Zeigt dem User auf einen Blick wo
// im Funnel Felder/Daten verloren gehen.
app.get('/api/workflows/:id/stats', async (req, res) => {
  const wf = safeSeg(req.params.id);
  if (!wf) { res.status(400).json({ error: 'invalid workflow id' }); return; }
  const maxRunsRaw = Number(req.query.maxRuns);
  const maxRuns = Number.isFinite(maxRunsRaw) && maxRunsRaw > 0 ? Math.min(200, maxRunsRaw) : 50;
  try {
    const stats = await computeWorkflowStats(RUNS_DIR, wf, { maxRuns });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============ Applications (Anwendungen) ============
// Orchestrierung über Workflows: persistente Fall-State, RAG, MCP-Komposition,
// Lifecycle. Instance-Management folgt in einer späteren Phase.

app.get('/api/applications', (_req, res) => {
  res.json(listApplications());
});

app.get('/api/applications/:id', (req, res) => {
  const def = getApplication(req.params.id);
  if (!def) return res.status(404).json({ error: `application not found: ${req.params.id}` });
  res.json(def);
});

// Instances: GET (list), GET (one), POST (create) — file-backed JSON registry.
app.use('/api/applications', express.json(), createApplicationsRouter({ dir: APPLICATIONS_DIR }));

// ── GET /api/applications/:appId/instances/:caseId/result ──────────────
// Liefert das Aggregat des letzten extraction-Runs eines Falls:
//   • canonical_layer (aus phase7Validator → phase6BmfRechner → phase5Merge,
//     in dieser Priorität)
//   • eric_xml (aus phase6 oder phase5)
//   • Stats (Anzahl Felder, Origin-Verteilung)
//
// Bewusst ohne requireBearerToken — die Application-Oberfläche ist die
// öffentliche Front, alle gefährlichen Aktionen (run, seal, export) haben
// ihre eigenen Guards/Lifecycle-Checks. Lesen eines bereits gelaufenen
// Falls braucht keinen Token.
app.get(
  '/api/applications/:appId/instances/:caseId/result',
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    if (inst.runs.length === 0) {
      return res.json({ runId: null, canonical_layer: null, eric_xml: null, source: null });
    }
    const extractionId = app_.workflows.extraction;
    if (!extractionId) return res.status(409).json({ error: 'no-extraction-workflow' });
    const lastRunId = inst.runs[inst.runs.length - 1];
    const runDir = path.join(RUNS_DIR, extractionId, lastRunId);

    async function readJson(rel: string): Promise<unknown | null> {
      try { return JSON.parse(await fs.promises.readFile(path.join(runDir, rel), 'utf-8')); }
      catch { return null; }
    }

    const validatorOut = (await readJson('phase7Validator/output.json')) as {
      canonicalLayer?: { codes?: Record<string, unknown>; validator?: unknown };
    } | null;
    const bmfOut = (await readJson('phase6BmfRechner/output.json')) as {
      canonical_layer?: Record<string, unknown>;
      canonicalLayer?: { codes?: Record<string, unknown> };
      eric_xml?: string;
      xml_payload?: string;
    } | null;
    const mergeOut = (await readJson('phase5Merge/output.json')) as {
      canonical_layer?: Record<string, unknown>;
      eric_xml?: string;
    } | null;

    // Priorität: das *reiche* canonical_layer (mit origin/drucktext/anlage/
    // evidence_line) zuerst — phase6 und phase5 halten das im snake_case-
    // canonical_layer-Feld. phase7Validator und der camelCase-canonicalLayer.codes
    // sind ein flacher eCode → string Map (nur Wert) und nur als Fallback gut.
    let layer: Record<string, unknown> | null = null;
    let source: string | null = null;
    if (bmfOut?.canonical_layer && Object.keys(bmfOut.canonical_layer).length > 0) {
      layer = bmfOut.canonical_layer;
      source = 'phase6BmfRechner';
    } else if (mergeOut?.canonical_layer && Object.keys(mergeOut.canonical_layer).length > 0) {
      layer = mergeOut.canonical_layer;
      source = 'phase5Merge';
    } else if (validatorOut?.canonicalLayer?.codes) {
      // Last-Resort: flat codes-map ohne Metadaten.
      layer = validatorOut.canonicalLayer.codes;
      source = 'phase7Validator-flat';
    }

    const eric_xml = bmfOut?.xml_payload ?? bmfOut?.eric_xml ?? mergeOut?.eric_xml ?? null;

    // Origin-Verteilung als Statistik (REGEX_100% / REGEX_3F / LLM_FSM /
    // BMF_RECHNER / ENSEMBLE_*).
    const stats: { totalFields: number; byOrigin: Record<string, number> } = { totalFields: 0, byOrigin: {} };
    if (layer) {
      for (const v of Object.values(layer)) {
        stats.totalFields++;
        const o = (v as { origin?: string })?.origin ?? 'unknown';
        stats.byOrigin[o] = (stats.byOrigin[o] ?? 0) + 1;
      }
    }
    res.json({ runId: lastRunId, canonical_layer: layer, eric_xml, source, stats });
  },
);

// ── GET /api/applications/:appId/instances/:caseId/recompute-quality ───
// Backfill für ältere Manifests: läuft pro Dokument im Manifest, liest
// das canonical_layer des zugehörigen runId aus dem extraction-Workflow
// und schreibt die Trust-Verteilung (high/medium/suspicious/low) zurück
// ins Manifest. Re-Runt KEINEN Workflow — nur lesen + Manifest-Update.
// Idempotent: mehrfaches Aufrufen erzeugt dieselben Counts.
app.get(
  '/api/applications/:appId/instances/:caseId/recompute-quality',
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    const extractionId = app_.workflows.extraction;
    if (!extractionId) return res.status(409).json({ error: 'no-extraction-workflow' });

    const manifest = await readManifest(ROOT, inst);
    let updated = 0;
    let missing = 0;
    for (const doc of manifest.documents) {
      if (!doc.runId) { missing++; continue; }
      const runDir = path.join(RUNS_DIR, extractionId, doc.runId);
      // Bevorzugt phase6BmfRechner/canonical_layer.json (rich), fallback
      // auf phase5Merge/canonical_layer.json. Manche Runs schreiben das
      // canonical_layer auch als Top-Level-Artefakt (canonical_layer.json
      // im Run-Root) — den nutzen wir als drittes Fallback.
      const candidates = [
        path.join(runDir, 'phase6BmfRechner', 'canonical_layer.json'),
        path.join(runDir, 'phase5Merge', 'canonical_layer.json'),
        path.join(runDir, 'canonical_layer.json'),
      ];
      let layer: Record<string, unknown> | null = null;
      let fieldsExtracted: number | undefined;
      for (const f of candidates) {
        try {
          const raw = await fs.promises.readFile(f, 'utf-8');
          const parsed = JSON.parse(raw) as unknown;
          // Wenn die Datei selbst die Karte ist (eCode → Feld), nimm sie
          // direkt — sonst greife auf `.canonical_layer` zu.
          const obj = (parsed && typeof parsed === 'object')
            ? (parsed as Record<string, unknown>)
            : null;
          if (obj && 'canonical_layer' in obj && obj.canonical_layer && typeof obj.canonical_layer === 'object') {
            layer = obj.canonical_layer as Record<string, unknown>;
          } else if (obj) {
            layer = obj;
          }
          if (layer && Object.keys(layer).length > 0) break;
          layer = null;
        } catch { /* try next */ }
      }
      if (!layer) { missing++; continue; }
      fieldsExtracted = Object.keys(layer).length;
      doc.trustBreakdown = computeTrustBreakdown(layer);
      if (typeof doc.fieldsExtracted !== 'number') doc.fieldsExtracted = fieldsExtracted;
      updated++;
    }
    await writeManifest(ROOT, inst, manifest);
    // Instanz-Datei spiegelt Manifest — Documents im Instance-JSON
    // ebenfalls aktualisieren, damit der nächste GET die Counts sieht.
    inst.documents = manifest.documents;
    await saveInstanceFile(APPLICATIONS_DIR, inst);
    res.json({
      caseId,
      appId,
      workflowId: extractionId,
      documentsTotal: manifest.documents.length,
      documentsUpdated: updated,
      documentsMissingArtifact: missing,
      instance: inst,
    });
  },
);

// ── POST /api/applications/:appId/instances/:caseId/upload ─────────────
// Multipart file upload triggert den extraction-Workflow der Anwendung
// (z.B. elster-v5_2-rag). SSE-Stream wie /api/workflows/:id/run. Run-ID
// wird nach Erfolg in instance.runs angehängt.
app.post(
  '/api/applications/:appId/instances/:caseId/upload',
  upload.single('file'),
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) { res.status(404).json({ error: `application not found: ${appId}` }); return; }
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) { res.status(404).json({ error: `case not found: ${caseId}` }); return; }
    const extractionId = app_.workflows.extraction;
    if (!extractionId) { res.status(409).json({ error: `application ${appId} has no extraction workflow configured` }); return; }
    const baseDef = getWorkflow(extractionId);
    if (!baseDef) { res.status(409).json({ error: `extraction workflow not registered: ${extractionId}` }); return; }
    if (!req.file) { res.status(400).json({ error: 'file fehlt (multipart field "file")' }); return; }

    const def = applyOverrides(baseDef, await readOverrides(ROOT, baseDef.id));
    const input: Record<string, unknown> = {
      filePath: req.file.path,
      filename: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
      mandant_id: inst.mandantId,
      case_id: inst.caseId,
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const run = runWorkflow(def, { runsDir: RUNS_DIR, input, appId });
    void persistInputForRun(def.id, run.runId, req.file.path, req.file.originalname, req.file.size, req.file.mimetype);

    // Datei in den Workspace-Inbox kopieren + Manifest fortschreiben.
    const doc = await persistUploadToInbox(ROOT, inst, {
      tempPath: req.file.path,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    }, run.runId);

    // Run-ID sofort am Instance-Datensatz festhalten — auch wenn der Client
    // SSE abbricht, läuft der Workflow zu Ende.
    inst.runs.push(run.runId);
    inst.documents = inst.documents ?? [];
    inst.documents.push(doc);
    inst.status = 'in_bearbeitung';
    await saveInstanceFile(APPLICATIONS_DIR, inst);

    const unsub = run.bus.subscribe((env) => res.write(formatSseEvent(env)));
    res.write(formatSseEvent({
      name: 'run_meta',
      runId: run.runId,
      workflowId: def.id,
      at: new Date().toISOString(),
      payload: { stages: Object.keys(def.stages), appId, caseId },
    }));
    req.on('close', () => unsub());
    try {
      const result = await run.result;
      if (result.state === 'ok') {
        // Per-Doc Anlagen + Felder-Anzahl aus den Stage-Outputs nachtragen
        const klass = (result.stages?.klassifizierung?.output as { erkannte_anlagen?: string[] } | undefined);
        const bmf = (result.stages?.phase6BmfRechner?.output as { canonical_layer?: Record<string, unknown> } | undefined);
        const merge = (result.stages?.phase5Merge?.output as { canonical_layer?: Record<string, unknown> } | undefined);
        const layer = bmf?.canonical_layer ?? merge?.canonical_layer ?? null;
        await recordDocumentRunCompletion(ROOT, inst, run.runId, {
          anlagen: klass?.erkannte_anlagen,
          fieldsExtracted: layer ? Object.keys(layer).length : 0,
          trustBreakdown: computeTrustBreakdown(layer),
        });
      }
    } catch { /* errors emitted as events */ }
    finally { unsub(); res.end(); }
  },
);

// ── POST /api/applications/:appId/instances/:caseId/upload-bulk ────────
// Multi-File-Upload: N Dateien hochladen, pro Datei einen extraction-Run
// starten (Concurrency-Limit), multiplexed SSE-Events mit doc-Index-Prefix.
app.post(
  '/api/applications/:appId/instances/:caseId/upload-bulk',
  upload.array('files', 20),
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) { res.status(404).json({ error: `application not found: ${appId}` }); return; }
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) { res.status(404).json({ error: `case not found: ${caseId}` }); return; }
    const extractionId = app_.workflows.extraction;
    if (!extractionId) { res.status(409).json({ error: `application ${appId} has no extraction workflow configured` }); return; }
    const baseDef = getWorkflow(extractionId);
    if (!baseDef) { res.status(409).json({ error: `extraction workflow not registered: ${extractionId}` }); return; }
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) { res.status(400).json({ error: 'mindestens eine Datei erforderlich (multipart field "files")' }); return; }
    const concurrency = Math.max(1, Math.min(5, Number(req.query.concurrency) || 4));

    const def = applyOverrides(baseDef, await readOverrides(ROOT, baseDef.id));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let aborted = false;
    req.on('close', () => { aborted = true; });

    res.write(formatSseEvent({
      name: 'bulk_start',
      runId: '',
      workflowId: def.id,
      at: new Date().toISOString(),
      payload: { fileCount: files.length, concurrency, filenames: files.map(f => f.originalname) },
    }));

    // Persist current instance state increments — load fresh inside the
    // worker, append, save (lock-free since we serialize through one process).
    const runIds: string[] = [];
    const docsAdded: unknown[] = [];

    const processOne = async (file: Express.Multer.File, idx: number) => {
      const input: Record<string, unknown> = {
        filePath: file.path,
        filename: file.originalname,
        size: file.size,
        mime: file.mimetype,
        mandant_id: inst.mandantId,
        case_id: inst.caseId,
      };
      const run = runWorkflow(def, { runsDir: RUNS_DIR, input, appId });
      void persistInputForRun(def.id, run.runId, file.path, file.originalname, file.size, file.mimetype);
      runIds.push(run.runId);

      const doc = await persistUploadToInbox(ROOT, inst, {
        tempPath: file.path,
        originalname: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
      }, run.runId);
      docsAdded.push(doc);

      res.write(formatSseEvent({
        name: 'doc_start',
        runId: run.runId,
        workflowId: def.id,
        at: new Date().toISOString(),
        payload: { docIdx: idx, filename: file.originalname, runId: run.runId, totalStages: Object.keys(def.stages).length },
      }));

      // Stage-Events mit doc:idx:-Prefix re-emitten — die UI demultiplexed
      // per payload.docIdx.
      const unsub = run.bus.subscribe((env) => {
        if (aborted) return;
        const wrapped = {
          ...env,
          name: env.name,
          payload: { ...((env.payload as Record<string, unknown>) ?? {}), docIdx: idx, runId: run.runId },
        };
        res.write(formatSseEvent(wrapped));
      });

      try {
        const result = await run.result;
        if (result.state === 'ok') {
          const klass = (result.stages?.klassifizierung?.output as { erkannte_anlagen?: string[] } | undefined);
          const bmf = (result.stages?.phase6BmfRechner?.output as { canonical_layer?: Record<string, unknown> } | undefined);
          const merge = (result.stages?.phase5Merge?.output as { canonical_layer?: Record<string, unknown> } | undefined);
          const layer = bmf?.canonical_layer ?? merge?.canonical_layer ?? null;
          await recordDocumentRunCompletion(ROOT, inst, run.runId, {
            anlagen: klass?.erkannte_anlagen,
            fieldsExtracted: layer ? Object.keys(layer).length : 0,
            trustBreakdown: computeTrustBreakdown(layer),
          });
          res.write(formatSseEvent({
            name: 'doc_done',
            runId: run.runId,
            workflowId: def.id,
            at: new Date().toISOString(),
            payload: { docIdx: idx, runId: run.runId, state: 'ok', fields: layer ? Object.keys(layer).length : 0, anlagen: klass?.erkannte_anlagen ?? [] },
          }));
        } else {
          res.write(formatSseEvent({
            name: 'doc_done',
            runId: run.runId,
            workflowId: def.id,
            at: new Date().toISOString(),
            payload: { docIdx: idx, runId: run.runId, state: result.state },
          }));
        }
      } catch (err) {
        res.write(formatSseEvent({
          name: 'doc_error',
          runId: run.runId,
          workflowId: def.id,
          at: new Date().toISOString(),
          payload: { docIdx: idx, runId: run.runId, error: (err as Error).message },
        }));
      } finally {
        unsub();
      }
    };

    // Concurrency-limited Pool
    let nextIdx = 0;
    async function worker() {
      while (!aborted) {
        const my = nextIdx++;
        if (my >= files.length) return;
        await processOne(files[my], my);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));

    // Instance final speichern — runs[] aggregiert, documents[] aus dem
    // Manifest (das die Dedup-Wahrheit ist).
    const freshInst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (freshInst) {
      freshInst.runs = [...freshInst.runs, ...runIds];
      // Documents aus dem (gerade frisch geschriebenen) Manifest spiegeln,
      // damit identische Dateien nicht doppelt in instance.documents stehen.
      const { readManifest } = await import('./server/inbox.ts');
      const manifest = await readManifest(ROOT, freshInst);
      freshInst.documents = manifest.documents;
      freshInst.status = 'in_bearbeitung';
      await saveInstanceFile(APPLICATIONS_DIR, freshInst);
    }

    res.write(formatSseEvent({
      name: 'bulk_done',
      runId: '',
      workflowId: def.id,
      at: new Date().toISOString(),
      payload: { runIds, fileCount: files.length },
    }));
    res.end();
  },
);

// ── POST /api/applications/:appId/instances/:caseId/seal ───────────────
// Triggert den steuerfall-seal Workflow. Liest die Instance + den letzten
// extraction-Run, baut den master-Snapshot und reicht ihn als Input rein.
// SSE-Stream identisch zum upload-Endpoint.
app.post(
  '/api/applications/:appId/instances/:caseId/seal',
  express.json(),
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    const sealWorkflowId = app_.workflows.seal;
    if (!sealWorkflowId || !getWorkflow(sealWorkflowId)) {
      return res.status(501).json({
        error: 'seal-workflow-not-registered',
        message: `Workflow "${sealWorkflowId ?? '<unset>'}" nicht registriert.`,
      });
    }
    if (inst.runs.length === 0) {
      return res.status(409).json({ error: 'no-extraction-runs', message: 'Vor dem Versiegeln muss mindestens ein Dokument extrahiert worden sein.' });
    }
    const extractionId = app_.workflows.extraction;
    if (!extractionId) return res.status(409).json({ error: 'no-extraction-workflow' });

    // Aus dem letzten Run: rich canonical_layer (mit origin/anlage/drucktext)
    // bevorzugt aus phase6BmfRechner.canonical_layer, dann phase5Merge.
    // Der flache phase7Validator.canonicalLayer.codes-Map ist nur Fallback.
    const lastRunId = inst.runs[inst.runs.length - 1];
    const runDir = path.join(RUNS_DIR, extractionId, lastRunId);
    async function readJson(rel: string): Promise<unknown | null> {
      try { return JSON.parse(await fs.promises.readFile(path.join(runDir, rel), 'utf-8')); }
      catch { return null; }
    }
    const validatorOut = (await readJson('phase7Validator/output.json')) as { canonicalLayer?: { codes?: Record<string, unknown> } } | null;
    const mergeOut = (await readJson('phase5Merge/output.json')) as { canonical_layer?: Record<string, { value?: string; normalized?: string | null; anlage?: string }>; eric_xml?: string } | null;
    const bmfOut = (await readJson('phase6BmfRechner/output.json')) as { canonical_layer?: Record<string, { value?: string; normalized?: string | null; anlage?: string }>; eric_xml?: string; xml_payload?: string } | null;
    const klassOut = (await readJson('klassifizierung/output.json')) as { erkannte_anlagen?: string[] } | null;

    const canonical_layer =
      (bmfOut?.canonical_layer && Object.keys(bmfOut.canonical_layer).length > 0) ? bmfOut.canonical_layer :
      (mergeOut?.canonical_layer && Object.keys(mergeOut.canonical_layer).length > 0) ? mergeOut.canonical_layer :
      validatorOut?.canonicalLayer?.codes ?? null;
    const eric_xml = bmfOut?.xml_payload ?? bmfOut?.eric_xml ?? mergeOut?.eric_xml ?? '';

    if (!canonical_layer || typeof canonical_layer !== 'object') {
      return res.status(409).json({
        error: 'extraction-incomplete',
        message: `Run ${lastRunId} hat keinen canonical_layer geliefert.`,
      });
    }

    // ── Pre-Seal-Validierung (I1.1): alle pflicht=true Atome der erkannten
    // Anlagen müssen im canonical_layer einen nicht-leeren Wert haben. Wenn
    // der Katalog für eine Anlage keine pflicht-Atome führt (z.B. Anlage N
    // — siehe Mängel D1) ist der Check für diese Anlage ein No-op und der
    // Seal läuft. Computed-Felder (ESt1A E0107xxx von BMF) sind ohnehin
    // nicht pflicht und werden ignoriert.
    const anlagen = Array.isArray(klassOut?.erkannte_anlagen) ? klassOut!.erkannte_anlagen : [];
    const layerCovered = new Set<string>();
    for (const [code, cv] of Object.entries(canonical_layer)) {
      const v = (cv as { value?: string; normalized?: string | null })?.value ?? null;
      const n = (cv as { value?: string; normalized?: string | null })?.normalized ?? null;
      if ((typeof v === 'string' && v.trim().length > 0) || (typeof n === 'string' && n.trim().length > 0)) {
        layerCovered.add(code);
      }
    }
    const missing: Array<{ eCode: string; anlage: string; drucktext: string; vordruckzeile: string }> = [];
    try {
      const { felderFuerAnlage } = await import('./lib/elster-catalog.ts');
      for (const anlage of anlagen) {
        const liste = await felderFuerAnlage(anlage as never);
        for (const feld of liste.felder) {
          if (!feld.pflicht) continue;
          if (!layerCovered.has(feld.eCode)) {
            missing.push({
              eCode: feld.eCode,
              anlage,
              drucktext: feld.drucktext,
              vordruckzeile: feld.vordruckzeile,
            });
          }
        }
      }
    } catch (e) {
      console.warn('[seal] pre-validation catalog lookup failed:', (e as Error).message);
      // Im Fehlerfall lassen wir die Validierung großzügig durchgehen, damit
      // ein Katalog-Bug nicht versiegeln blockiert.
    }
    if (missing.length > 0) {
      return res.status(409).json({
        error: 'missing-pflicht-fields',
        message: `Versiegelung blockiert: ${missing.length} Pflicht-Feld${missing.length === 1 ? '' : 'er'} ohne Wert.`,
        missing,
        anlagen,
      });
    }

    const def = getWorkflow(sealWorkflowId)!;
    const input = {
      appId, caseId,
      mandantId: inst.mandantId,
      displayName: inst.displayName,
      veranlagungsjahr: inst.veranlagungsjahr ?? null,
      runId: lastRunId,
      workspacePath: inst.workspacePath,
      canonical_layer,
      eric_xml,
      validator_result: validatorOut ?? null,
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const run = runWorkflow(def, { runsDir: RUNS_DIR, input, appId });
    const unsub = run.bus.subscribe((env) => res.write(formatSseEvent(env)));
    res.write(formatSseEvent({
      name: 'run_meta',
      runId: run.runId,
      workflowId: def.id,
      at: new Date().toISOString(),
      payload: { stages: Object.keys(def.stages), appId, caseId },
    }));

    req.on('close', () => unsub());
    try {
      const result = await run.result;
      // Wenn alle Stages OK: Instance auf 'versiegelt' setzen + Commit-Sha persistieren.
      if (result.state === 'ok') {
        const anchorOut = result.stages?.anchor?.output as { anchor?: { commit_hash?: string } } | undefined;
        inst.status = 'versiegelt';
        inst.sealedAt = new Date().toISOString();
        inst.sealCommitSha = anchorOut?.anchor?.commit_hash;

        if (inst.containerId) {
          try {
            await syncWorkspaceContainer(inst.containerId, inst.workspacePath);
          } catch (err) {
            console.warn('[seal] failed to sync workspace container:', (err as Error).message);
          }
          try {
            const promoted = await promoteWorkspaceToTaxCase(
              inst.containerId,
              inst.caseId,
              inst.mandantId,
              inst.veranlagungsjahr ?? new Date().getFullYear(),
              inst.displayName,
              app_.id,
            );
            if (promoted) {
              inst.taxCaseContainerId = promoted.tax_case_id;
              inst.taxCaseCommitSha = promoted.commit_sha;
            }
          } catch (err) {
            console.warn('[seal] failed to promote workspace to tax_case:', (err as Error).message);
          }
        }

        await saveInstanceFile(APPLICATIONS_DIR, inst);
      }
    } catch { /* errors emitted as events */ }
    finally { unsub(); res.end(); }
  },
);

// ── GET /api/applications/:appId/instances/:caseId/aggregate ──────────
// Case-Level-Layer-Aggregation über alle hochgeladenen Belege des Falls.
// Liefert merged_layer, conflicts, pflicht-coverage, missing-list +
// optional BMF-Berechnung über den merged Layer.
// Token-frei (analog zu /result).
app.get(
  '/api/applications/:appId/instances/:caseId/aggregate',
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    const extractionId = app_.workflows.extraction;
    if (!extractionId) return res.status(409).json({ error: 'no-extraction-workflow' });

    const { aggregateCase } = await import('./server/aggregation.ts');
    const { documentTypeHintsMap } = await import('./server/document-type-hints.ts');

    const agg = await aggregateCase(inst, {
      runsDir: RUNS_DIR,
      extractionWorkflowId: extractionId,
    });

    // Doc-Type-Hints für die missing-Liste nachreichen
    for (const m of agg.pflicht_missing) {
      const sugg = documentTypeHintsMap([m.eCode])[m.eCode] ?? [];
      m.suggestedDocs = sugg;
    }

    // BMF-Re-Compute über den merged Layer — wenn BMF-MCP erreichbar und
    // mindestens 1 currency-Wert vorhanden ist.
    const wantBmf = req.query.bmf !== '0';
    if (wantBmf && Object.keys(agg.merged_layer).length > 0) {
      try {
        const { BmfMcpClient, canonicalLayerToElsterFelder } = await import('./lib/bmf-mcp-client.ts');
        // canonical_layer → BMF-elster-felder Map (currency-Werte als "x,xx")
        const felder = canonicalLayerToElsterFelder(
          Object.fromEntries(Object.entries(agg.merged_layer).map(([k, v]) => [k, {
            value: v.value,
            normalized: v.normalized,
            datentyp: (v.datentyp as 'string' | 'date' | 'currency') ?? 'string',
            trust: (v as { trust?: 'high' | 'medium' | 'low' | 'suspicious' }).trust,
          }])),
        );
        const client = new BmfMcpClient({ timeoutMs: 15_000 });
        const bmfResult = await client.berechneVollstaendigeSteuerV2({
          erklaerungsjahr: inst.veranlagungsjahr ?? 2024,
          elster_felder: felder,
        });
        (agg as { bmf?: unknown }).bmf = bmfResult;
      } catch (e) {
        (agg as { bmf?: unknown }).bmf = { erfolg: false, reason: 'mcp-error', message: (e as Error).message };
      }
    }

    res.json(agg);
  },
);

// ── GET /api/applications/:appId/mcps/health ───────────────────────────
// Health-Check für alle in der Application-Definition gelisteten MCPs.
// Pro MCP: { name, url, configured, alive, latencyMs, error }.
// Wird im /steuerfall.html Header für Health-Dots gepingt. Token-frei,
// weil nur Health-Probe (kein Tool-Call).
app.get('/api/applications/:appId/mcps/health', async (req, res) => {
  // Deprecated — bevorzuge /api/applications/:appId/tools/health (P2). Wir
  // setzen den Header proaktiv, damit Clients bei nächster Gelegenheit migrieren.
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', `</api/applications/${req.params.appId}/tools/health>; rel="successor-version"`);
  const { appId } = req.params;
  const app_ = getApplication(appId);
  if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
  const mcps = app_.mcps ?? {};
  const checks = await Promise.all(Object.entries(mcps).map(async ([name, ref]) => {
    const url = process.env[ref.envVar] ?? ref.url ?? null;
    const configured = typeof url === 'string' && url.length > 0;
    if (!configured) {
      return { name, configured: false, alive: false, url: null, latencyMs: null, error: 'not-configured', tools: ref.tools };
    }
    const t0 = Date.now();
    try {
      // Probe via JSON-RPC tools/list — Standard-MCP-Endpoint. 3s Hard-Timeout.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), 3000);
      const r = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      clearTimeout(timer);
      const alive = r.ok;
      return {
        name, configured: true, alive,
        url, latencyMs: Date.now() - t0,
        error: alive ? null : `HTTP ${r.status}`,
        tools: ref.tools,
      };
    } catch (e) {
      return {
        name, configured: true, alive: false,
        url, latencyMs: Date.now() - t0,
        error: (e as Error).message,
        tools: ref.tools,
      };
    }
  }));
  res.json({ mcps: checks });
});

// ── GET /api/applications/:appId/tools/health ───────────────────────────
// P2-Nachfolger der `/mcps/health`-Route: liefert pro registriertem Tool
// (LLM/Embedder/RAG/MCP/Gitchain/Catalog/KV) den aktuellen `ToolHealth`.
// Verwendet den per Application gebooteten `ToolContainer`. Antwortet 503,
// wenn der Container nicht hochgefahren wurde (z.B. STURM_TOOLS_BOOT=skip).
app.get('/api/applications/:appId/tools/health', async (req, res) => {
  const { appId } = req.params;
  const app_ = getApplication(appId);
  if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
  const container = getToolContainer(appId);
  if (!container) {
    return res.status(503).json({
      error: 'tool-container not booted',
      hint: 'STURM_TOOLS_BOOT=skip is set or server is still initializing',
      appId,
    });
  }
  const tools = await container.healthAll();
  res.json({ appId, tools });
});

// ── GET /api/applications/:appId/instances/:caseId/runs/:runId/summary ──
// Liefert eine kompakte Zusammenfassung eines Runs, ohne dass der Client
// einen Bearer-Token braucht. Liest `_result.json` + `_meta.json` aus dem
// runs/<workflowId>/<runId>/-Ordner und korreliert mit der Instance, damit
// nur Runs ausgeliefert werden, die wirklich zum Fall gehören.
app.get(
  '/api/applications/:appId/instances/:caseId/runs/:runId/summary',
  async (req, res) => {
    const { appId, caseId, runId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    if (!inst.runs.includes(runId)) {
      return res.status(404).json({ error: 'run not in case', caseRuns: inst.runs.length });
    }
    const extractionId = app_.workflows.extraction;
    if (!extractionId) return res.status(409).json({ error: 'no-extraction-workflow' });
    const runDir = path.join(RUNS_DIR, extractionId, runId);
    async function readJson(rel: string): Promise<unknown | null> {
      try { return JSON.parse(await fs.promises.readFile(path.join(runDir, rel), 'utf-8')); }
      catch { return null; }
    }
    const meta = (await readJson('_meta.json')) as { runId?: string; workflowId?: string; startedAt?: string } | null;
    const result = (await readJson('_result.json')) as {
      state?: 'ok' | 'error' | 'partial';
      ms?: number;
      stages?: Record<string, { state: string; ms?: number; error?: { message?: string } }>;
    } | null;
    const mergeOut = (await readJson('phase5Merge/output.json')) as { canonical_layer?: Record<string, unknown> } | null;
    const bmfOut = (await readJson('phase6BmfRechner/output.json')) as { canonical_layer?: Record<string, unknown> } | null;
    const layer = bmfOut?.canonical_layer ?? mergeOut?.canonical_layer ?? null;
    const fields = layer ? Object.keys(layer).length : 0;

    const stages = result?.stages
      ? Object.entries(result.stages).map(([id, s]) => ({
          id,
          state: s.state,
          ms: s.ms ?? null,
          error: s.error?.message ?? null,
        }))
      : [];
    res.json({
      runId,
      workflowId: meta?.workflowId ?? extractionId,
      startedAt: meta?.startedAt ?? null,
      state: result?.state ?? null,
      totalMs: result?.ms ?? null,
      stages,
      fields,
    });
  },
);

// ── GET /api/applications/:appId/instances/:caseId/download/:artifact ──
// Liefert die versiegelten Artefakte des Falls zum Download. Wir erlauben
// genau zwei: master.json (signierter Snapshot, master.signed-Variante aus
// dem seal-Run) und eric_xml (ERiC-konformes XML-Payload).
//
// Token-frei: die Application-Oberfläche scoped alles auf den Fall-Workspace.
app.get(
  '/api/applications/:appId/instances/:caseId/download/:artifact',
  async (req, res) => {
    const { appId, caseId, artifact } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    if (inst.status !== 'versiegelt' && inst.status !== 'eingereicht') {
      return res.status(409).json({ error: 'not-sealed', message: 'Download erst nach Versiegelung verfügbar.' });
    }
    const wsAbs = path.isAbsolute(inst.workspacePath)
      ? inst.workspacePath
      : path.join(ROOT, inst.workspacePath);
    const masterPath = path.join(wsAbs, 'seal', 'master.json');
    if (artifact === 'master.json') {
      try {
        const raw = await fs.promises.readFile(masterPath, 'utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${caseId}-master.json"`);
        res.type('application/json').send(raw);
      } catch {
        res.status(404).json({ error: 'master-not-found' });
      }
      return;
    }
    if (artifact === 'eric.xml') {
      try {
        const raw = await fs.promises.readFile(masterPath, 'utf-8');
        const master = JSON.parse(raw) as { eric_xml?: string };
        const xml = master.eric_xml ?? '';
        if (!xml) return res.status(404).json({ error: 'eric-xml-empty' });
        res.setHeader('Content-Disposition', `attachment; filename="${caseId}-eric.xml"`);
        res.type('application/xml').send(xml);
      } catch {
        res.status(404).json({ error: 'master-not-found' });
      }
      return;
    }
    return res.status(400).json({
      error: 'unknown-artifact',
      message: `unbekanntes Artefakt: ${artifact}`,
      supported: ['master.json', 'eric.xml'],
    });
  },
);

// ── POST /api/applications/:appId/instances/:caseId/export ─────────────
// Liest das versiegelte master.json aus dem Fall-Workspace, ruft den
// Lane-5 ELSTER-MCP-Client. Wenn ELSTER_MCP_URL unset ist, antwortet der
// Client deterministisch mit `mcp-unavailable` — keine Fehlerseite, weil
// das genau der erwartete v1-Zustand ist.
app.post(
  '/api/applications/:appId/instances/:caseId/export',
  express.json(),
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    if (inst.status !== 'versiegelt' && inst.status !== 'eingereicht') {
      return res.status(409).json({
        error: 'must-seal-first',
        message: 'Export ist erst nach erfolgreicher Versiegelung möglich.',
        status: inst.status,
      });
    }
    // master.json aus dem Workspace lesen — gibt uns eric_xml + merkle.root.
    let master: { eric_xml?: string; merkle?: { root?: string } } | null = null;
    try {
      const masterPath = path.join(
        process.cwd(),
        inst.workspacePath,
        'seal',
        'master.json',
      );
      master = JSON.parse(await fs.promises.readFile(masterPath, 'utf-8'));
    } catch {
      return res.status(409).json({
        error: 'sealed-master-missing',
        message: 'Versiegeltes master.json nicht gefunden. Versiegelung wiederholen.',
      });
    }
    const ericXml = master?.eric_xml ?? '';
    const merkleRoot = master?.merkle?.root;
    const fall_metadata = {
      appId, caseId,
      mandantId: inst.mandantId,
      veranlagungsjahr: inst.veranlagungsjahr ?? null,
      merkle_root: merkleRoot,
    };
    // EXPORT contract (2026-05-17):
    // The deployed Lane-5 MCP (ctaxv1-lane5-elster) does NOT have an
    // `elster_einreichen` tool — it only has `erstelle_elster_xml` which
    // GENERATES the XML. But the XML is already produced upstream by
    // phase6BmfRechner and lives in master.json (eric_xml field). Real
    // ELSTER-Schnittstelle submission requires production credentials
    // + the ERiC client library and is OUT OF SCOPE for sturm.
    //
    // So: /export now materializes the existing eric_xml as a downloadable
    // file in the case workspace + marks the case `eingereicht` (semantic:
    // "ready for ELSTER submission"). The actual submission is a manual
    // upload step performed by the steuerberater. If a real submission
    // MCP is added later, this handler can call it via ctx.tools.
    if (!ericXml) {
      return res.status(409).json({
        erfolg: false,
        reason: 'no-eric-xml',
        message: 'Versiegeltes master.json enthält keinen eric_xml. Phase 6 (BMF) prüfen.',
      });
    }
    // Write the XML to the case workspace + content-addressed by merkle root.
    const ericXmlAbsPath = path.join(
      ROOT,
      inst.workspacePath,
      `eric_${merkleRoot ? merkleRoot.slice(0, 12) : 'unsealed'}.xml`,
    );
    try {
      await fs.promises.writeFile(ericXmlAbsPath, ericXml, 'utf-8');
    } catch (err) {
      return res.status(500).json({
        erfolg: false,
        reason: 'write-failed',
        message: `Konnte ERiC-XML nicht schreiben: ${(err as Error).message}`,
      });
    }
    inst.status = 'eingereicht';
    inst.exportedAt = new Date().toISOString();
    inst.einreichungsId = `local-${merkleRoot?.slice(0, 12) ?? Date.now().toString(36)}`;
    await saveInstanceFile(APPLICATIONS_DIR, inst);

    return res.status(200).json({
      erfolg: true,
      einreichungs_id: inst.einreichungsId,
      eric_xml_path: path.relative(ROOT, ericXmlAbsPath),
      eric_xml_size: ericXml.length,
      eric_xml_sha_prefix: merkleRoot?.slice(0, 12) ?? null,
      mode: 'local-export',
      hinweis: 'ERiC-XML auf Festplatte abgelegt. Tatsächliche ELSTER-Übermittlung erfolgt ' +
               'außerhalb von sturm (ERiC-Client + Schnittstellen-Credentials).',
      download: `/api/applications/${appId}/instances/${caseId}/download/eric.xml`,
    });
  },
);

// ============ Stage catalog (workflow designer metadata) ============

function categorizeStage(id: string): string {
  if (id.startsWith('compare/')) return 'control-flow';
  // Quality-Trias: critic + cross-validator + schema-guard + span-linker — defensibility nodes.
  // Sort BEFORE the generic eval/ + extract/ buckets so they land in the dedicated category.
  if (id === 'eval/critic-llm') return 'quality';
  if (id === 'extract/span-linker' || id === 'extract/cross-validator' || id === 'extract/schema-guarded-llm') return 'quality';
  if (id.startsWith('quality/')) return 'quality';
  if (id.startsWith('eval/')) return 'evaluation';
  if (id.startsWith('extract/')) return 'extract';
  if (id === 'paddleocr-vl' || id.endsWith('-ocr')) return 'ocr';
  if (id.startsWith('elster-v3/')) return 'elster-v3';
  if (id.startsWith('elster/')) return 'elster';
  if (id.startsWith('steuerbelege/')) return 'steuerbelege';
  if (id.startsWith('pentacam')) return 'pentacam';
  if (id.startsWith('myopia')) return 'myopia';
  if (id === 'text-stats') return 'analysis';
  return 'general';
}

app.get('/api/stages/catalog', (_req, res) => {
  res.json(listStages().map((s) => ({
    id: s.id,
    name: s.name ?? s.id,
    description: s.description ?? null,
    category: categorizeStage(s.id),
    hints: s.hints ?? null,
  })));
});

// Container catalog — deduplicated union of all `containers[]` declared across
// registered workflows. Powers the designer's container palette so users can
// pin a "data center" (e.g. ELSTER eCode catalog) to their workflow.
app.get('/api/containers', (_req, res) => {
  const seen = new Map<string, unknown>();
  for (const wf of listWorkflows()) {
    for (const c of (wf.containers ?? [])) {
      if (!seen.has(c.id)) {
        // Strip workflow-specific readBy[] — the catalog represents the container
        // shape, not how a particular workflow consumes it.
        const { readBy: _readBy, ...rest } = c;
        seen.set(c.id, rest);
      }
    }
  }
  res.json(Array.from(seen.values()));
});

// ============ Upload ============

app.post('/api/upload', requireBearerToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file fehlt (multipart/form-data, field "file")' });
  res.json({
    storedFilename: req.file.filename,
    originalFilename: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype,
  });
});

// ============ OCR Studio ============

app.use('/api/ocr', requireBearerToken, ocrPreviewLimiter, createOcrPreviewRouter(UPLOADS_DIR));

// ============ Schema Generator (LLM-driven; separate surface from /api/ocr) ============

app.use(
  '/api/schema',
  requireBearerToken,
  schemaGenerateLimiter,
  createSchemaGenerateRouter(UPLOADS_DIR),
);

// ============ Workspaces (Phase 1: filesystem-only, no GitChain yet) ============

// ============ Jobs (Phase C: persistent long-running operations) ============
const jobRunner = new JobRunner(WORKSPACES_DIR);
const PORT_FOR_LOOPBACK = process.env.PORT ?? '7800';
registerJobHandlers(jobRunner, {
  selfBaseUrl: `http://localhost:${PORT_FOR_LOOPBACK}`,
  selfAuthToken: process.env.STURM_BEARER_TOKEN ?? '',
  workspacesDir: WORKSPACES_DIR,
});
// Boot-time recovery: mark in-flight as failed, re-enqueue queued.
void jobRunner.recover();

// ---------- Phase E: session cookie middleware (must run BEFORE protected routes) ----------
const sessionsOpts = { workspacesDir: WORKSPACES_DIR, cookieName: 'sturm-session', secureCookie: true };
app.use(sessionCookieMiddleware(sessionsOpts));

// Session redeem is PUBLIC (no Bearer) — sessionId in body is the auth.
app.use('/api/sessions', createSessionRedeemRouter(sessionsOpts));

app.use('/api/jobs', requireBearerToken, createJobsRouter(jobRunner));
app.use('/api/pipelines', requireBearerToken, createPipelinesRouter(PIPELINES_DIR));
const masterKeyResolver = () => resolveMasterKey(ROOT);
// Token-management requires admin Bearer (mounted FIRST under /api/workspaces).
app.use('/api/workspaces', requireBearerToken, createTokensRouter(sessionsOpts));
app.use('/api/workspaces', requireBearerToken, createWorkspacesRouter(WORKSPACES_DIR, CANONICALS_DIR, PIPELINES_DIR, jobRunner, masterKeyResolver));
app.use('/api/integrations', requireBearerToken, createIntegrationsRouter({
  workspacesDir: WORKSPACES_DIR, pipelinesDir: PIPELINES_DIR, jobRunner,
}));

// ============ Standalone classify (used by /studio-ocr.html on file drop) ============

app.use('/api/classify', requireBearerToken, schemaGenerateLimiter, createClassifyRouter(UPLOADS_DIR));

// ============ ctx — drop-in context container HTTP surface ============
// Cross-LLM retrieval endpoint. Mounted WITHOUT requireBearerToken: matches
// the CLAUDE.md "Playground-Level, kein Auth" posture for sturm itself.
// Behind an internet-facing reverse-proxy, gate this.
app.use('/ctx', express.json({ limit: '5mb' }), createCtxRouter({
  ollamaUrl: process.env.OLLAMA_URL,
  embedCpu: process.env.EMBED_CPU === '1',
}));

// ============ User-defined workflows (designer-authored, persistent) ============
// Mounted WITHOUT requireBearerToken intentionally — designer is local-dev tool.
// If you expose this to the internet, gate it.
app.use('/api/workflows-user', createWorkflowsUserRouter({ dir: USER_WORKFLOWS_DIR, builtInIds: builtInWorkflowIds }));

// ============ Studio templates (P2.6) ============

app.get('/api/studio/templates', requireBearerToken, async (_req, res) => {
  try {
    const raw = await fs.promises.readFile(path.join(UI_DIR, 'studio-templates.json'), 'utf8');
    res.type('application/json').send(raw);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ============ Schema repo (P2.5) ============

const SCHEMAS_DIR = path.join(ROOT);
fs.mkdirSync(path.join(ROOT, 'schemas'), { recursive: true });

app.get('/api/schemas', requireBearerToken, async (_req, res) => {
  try {
    res.json(await listSchemas(SCHEMAS_DIR));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/schemas/:id(*)', requireBearerToken, async (req, res, next) => {
  const id = req.params.id;
  // Match `:id/:version` form (last segment matches ^v\d+$).
  const lastSlash = id.lastIndexOf('/');
  const tail = lastSlash >= 0 ? id.slice(lastSlash + 1) : '';
  const isVersion = /^v\d+$/.test(tail);
  try {
    if (isVersion) {
      const realId = id.slice(0, lastSlash);
      const rec = await getSchemaVersion(SCHEMAS_DIR, realId, tail);
      res.json(rec);
    } else {
      const idx = await getSchemaIndex(SCHEMAS_DIR, id);
      res.json({ id, current: idx.current, versions: idx.versions, hashes: idx.hashes, name: idx.name, defaultPrompt: idx.defaultPrompt });
    }
  } catch (e) {
    if (e instanceof SchemaRepoError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'invalid_id' ? 400 : 500;
      return res.status(status).json({ error: e.code, message: e.message });
    }
    next(e);
  }
});

app.post('/api/schemas/:id(*)', requireBearerToken, async (req, res) => {
  const id = req.params.id;
  const body = req.body ?? {};
  if (typeof body !== 'object' || body.schema === undefined) {
    return res.status(400).json({ error: 'body must be { schema, name?, defaultPrompt? }' });
  }
  try {
    const result = await putSchema(SCHEMAS_DIR, id, {
      schema: body.schema,
      name: typeof body.name === 'string' ? body.name : undefined,
      defaultPrompt: typeof body.defaultPrompt === 'string' ? body.defaultPrompt : undefined,
    });
    res.status(201).json(result);
  } catch (e) {
    if (e instanceof SchemaRepoError) {
      const status = e.code === 'invalid_id' ? 400 : 500;
      return res.status(status).json({ error: e.code, message: e.message });
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

// Versions are immutable; deletion is intentionally not supported until we
// have run reference tracking (see findings).
app.delete('/api/schemas/:id(*)', requireBearerToken, (_req, res) => {
  res.status(405).json({ error: 'method_not_allowed', message: 'schema versions are immutable; delete is not supported (no run reference tracking yet)' });
});

// ============ Run (SSE) ============

app.post('/api/workflows/:id/run', requireBearerToken, upload.single('file'), async (req, res) => {
  const baseDef = getWorkflow(req.params.id);
  if (!baseDef) { res.status(404).json({ error: `workflow not found: ${req.params.id}` }); return; }
  // Merge any persisted overrides onto the canonical workflow.
  const def = applyOverrides(baseDef, await readOverrides(ROOT, baseDef.id));

  // Input je nach input.type aus FormData oder Body bauen
  let input: Record<string, unknown> = {};
  if (def.input.type === 'file') {
    if (!req.file) { res.status(400).json({ error: 'file fehlt (multipart field "file")' }); return; }
    input = {
      filePath: req.file.path,
      filename: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
    };
  } else {
    input = req.body?.input ?? {};
  }

  // ─── Wave 25 v2: Hint-Parameter (cb-ctax → STURM elster-v1) ──────────────
  // anlagen_hint=ESt1A,N,KAP,VOR,SA  → Pass 3 nur ueber diese Anlagen-Schemas
  // skip_classification=true         → Pass 2 wird uebersprungen, erkannte_-
  //                                    anlagen direkt aus anlagen_hint
  // profil_hint=ARBEITNEHMER         → optionaler Kontext fuer LLM-Prompts
  // Ziel: Pass 3 laeuft nicht ueber alle 35 Anlagen sondern nur ueber das
  // tatsaechlich passende Set → 3-5x schneller bei einer Lohnsteuerbescheini-
  // gung. Hints sind optional und aenderen das Verhalten von elster-v1
  // ausschliesslich abwaerts-kompatibel (defaults bleiben).
  const anlagenHintRaw = (req.query?.anlagen_hint as string | undefined) || '';
  if (anlagenHintRaw) {
    input.anlagen_hint = anlagenHintRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (req.query?.skip_classification === 'true' || req.query?.skip_classification === '1') {
    input.skip_classification = true;
  }
  if (req.query?.profil_hint) {
    input.profil_hint = String(req.query.profil_hint);
  }

  // SSE-Header
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const run = runWorkflow(def, { runsDir: RUNS_DIR, input });

  // Persist input next to the run so the OCR Studio can deep-link back to it.
  // Fire-and-forget; runs proceed regardless.
  if (def.input.type === 'file' && req.file) {
    void persistInputForRun(def.id, run.runId, req.file.path, req.file.originalname, req.file.size, req.file.mimetype);
  }

  const unsub = run.bus.subscribe((env) => {
    res.write(formatSseEvent(env));
  });

  // Initial run-Info raus, falls Subscriber bereits run_start verpasst hat
  res.write(formatSseEvent({
    name: 'run_meta',
    runId: run.runId,
    workflowId: def.id,
    at: new Date().toISOString(),
    payload: { stages: Object.keys(def.stages) },
  }));

  req.on('close', () => {
    unsub();
    // Run läuft im Hintergrund weiter; Artefakte landen auf disk
  });

  try {
    await run.result;
  } catch (e) {
    // Fehler werden bereits als run_error/stage_error emittiert
  } finally {
    unsub();
    res.end();
  }
});

// ============ Runs ============

// List previous runs of a workflow (for Diff-vs-previous + replay-dropdown).
// Sorted by mtime desc, capped at 20. Each entry pulls state + score from _result.json.
app.get('/api/workflows/:id/runs', requireBearerToken, async (req, res) => {
  const wf = safeSeg(req.params.id);
  if (!wf) { res.status(400).json({ error: 'invalid workflow id' }); return; }
  const dir = path.join(RUNS_DIR, wf);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    res.json([]); return;
  }
  type Row = { runId: string; state: string | null; ms: number | null; kpiScore: number | null; finishedAt: string | null; mtime: number };
  const rows: Row[] = [];
  for (const name of entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    const runDir = path.join(dir, name);
    const resultPath = path.join(runDir, '_result.json');
    let st;
    try { st = await fs.promises.stat(runDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let state: string | null = null;
    let ms: number | null = null;
    let kpiScore: number | null = null;
    let finishedAt: string | null = null;
    try {
      const raw = await fs.promises.readFile(resultPath, 'utf8');
      const j = JSON.parse(raw) as Record<string, unknown>;
      state = typeof j.state === 'string' ? j.state : null;
      ms = typeof j.ms === 'number' ? j.ms : null;
      finishedAt = typeof j.finishedAt === 'string' ? j.finishedAt : null;
      const stages = j.stages as Record<string, { output?: Record<string, unknown> }> | undefined;
      const kpiOut = stages?.kpi?.output;
      if (kpiOut && typeof kpiOut.score === 'number') kpiScore = kpiOut.score;
    } catch {
      // still-running or missing _result.json — keep state=null, useful to show "running"
    }
    rows.push({ runId: name, state, ms, kpiScore, finishedAt, mtime: st.mtimeMs });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  res.json(rows.slice(0, 20).map(({ mtime: _m, ...r }) => r));
});

app.get('/api/runs/:workflowId/:runId', requireBearerToken, async (req, res) => {
  const metaPath = path.join(RUNS_DIR, req.params.workflowId, req.params.runId, '_result.json');
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'run not found or still running' });
  }
});

// Studio deep-link support: input metadata + the file itself.
app.get('/api/runs/:workflowId/:runId/_input.json', requireBearerToken, async (req, res) => {
  const p = path.join(RUNS_DIR, safeSeg(req.params.workflowId), safeSeg(req.params.runId), '_input.json');
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'no input persisted for this run' });
  }
});

app.get('/api/runs/:workflowId/:runId/_input/:filename', requireBearerToken, async (req, res) => {
  const filename = safeSeg(req.params.filename);
  if (!filename) { res.status(400).json({ error: 'invalid filename' }); return; }
  const p = path.join(RUNS_DIR, safeSeg(req.params.workflowId), safeSeg(req.params.runId), '_input', filename);
  res.sendFile(p, (err) => { if (err) res.status(404).end(); });
});

// Workflow stage config — used by the Studio to prefill from a stage.
// Returns the effective config (source + override merged), plus split shapes
// so the UI can show "you have an override" badges and revert intelligently.
app.get('/api/workflows/:id/stages/:stageId/config', requireBearerToken, async (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) { res.status(404).json({ error: `workflow not found: ${req.params.id}` }); return; }
  const stage = def.stages[req.params.stageId];
  if (!stage) { res.status(404).json({ error: `stage not found: ${req.params.stageId}` }); return; }
  const overrides = await readOverrides(ROOT, def.id);
  const override = overrides?.stages[req.params.stageId] ?? null;
  const sourceConfig = (stage.config ?? {}) as Record<string, unknown>;
  const effectiveConfig = override ? { ...sourceConfig, ...override } : sourceConfig;
  res.json({
    workflowId: def.id,
    stageId: req.params.stageId,
    uses: stage.uses,
    name: stage.name ?? req.params.stageId,
    description: stage.description ?? null,
    config: effectiveConfig,
    source: sourceConfig,
    override,
    hasOverride: override != null,
  });
});

// Studio: write a stage override. Body = full effective config.
app.post('/api/workflows/:id/stages/:stageId/config', requireBearerToken, async (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) { res.status(404).json({ error: `workflow not found: ${req.params.id}` }); return; }
  const stage = def.stages[req.params.stageId];
  if (!stage) { res.status(404).json({ error: `stage not found: ${req.params.stageId}` }); return; }
  const incoming = req.body?.config;
  if (!incoming || typeof incoming !== 'object') {
    res.status(400).json({ error: 'body must be { config: {...} }' });
    return;
  }
  try {
    const updated = await writeStageOverride(ROOT, def.id, req.params.stageId, incoming as Record<string, unknown>);
    res.json({ ok: true, workflowId: def.id, stageId: req.params.stageId, override: updated.stages[req.params.stageId] });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Studio: revert override → workflow source wins again.
app.delete('/api/workflows/:id/stages/:stageId/config', requireBearerToken, async (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) { res.status(404).json({ error: `workflow not found: ${req.params.id}` }); return; }
  try {
    await deleteStageOverride(ROOT, def.id, req.params.stageId);
    res.json({ ok: true, workflowId: def.id, stageId: req.params.stageId });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Studio: persisted output of a stage from a previous run, for diffing.
app.get('/api/runs/:workflowId/:runId/stages/:stageId/output', requireBearerToken, async (req, res) => {
  const wf = safeSeg(req.params.workflowId);
  const run = safeSeg(req.params.runId);
  const stage = safeSeg(req.params.stageId);
  if (!wf || !run || !stage) { res.status(400).json({ error: 'invalid path segment' }); return; }
  const p = path.join(RUNS_DIR, wf, run, stage, 'output.json');
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'stage output not found' });
  }
});

async function persistInputForRun(
  workflowId: string,
  runId: string,
  uploadedPath: string,
  originalFilename: string,
  size: number,
  mime: string,
) {
  try {
    const safeName = sanitizeFilename(originalFilename);
    const dir = path.join(RUNS_DIR, workflowId, runId, '_input');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.copyFile(uploadedPath, path.join(dir, safeName));
    await fs.promises.writeFile(
      path.join(RUNS_DIR, workflowId, runId, '_input.json'),
      JSON.stringify({ filename: safeName, originalFilename, size, mime, persistedAt: new Date().toISOString() }, null, 2),
    );
  } catch (e) {
    console.warn(`[server] persistInputForRun failed for ${workflowId}/${runId}:`, (e as Error).message);
  }
}

function sanitizeFilename(name: string): string {
  // Keep extension; replace anything not safe with _.
  const base = name.replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.length > 0 ? base : 'input.bin';
}

function safeSeg(seg: string): string {
  return /^[A-Za-z0-9._-]+$/.test(seg) ? seg : '';
}

// ============ Static UI ============

app.use('/design-system', express.static(path.join(UI_DIR, 'design-system')));
// Silenced favicon — kein favicon-File im Repo, deshalb 204 statt 404-Spam in
// jeder UI-Console.
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.get('/', (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
app.get('/pipeline.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'pipeline.html')));
app.get('/designer.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'designer.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
app.get('/anwendungen.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'anwendungen.html')));
app.get('/steuerfall.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'steuerfall.html')));
app.get('/abrechnung.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'abrechnung.html')));
app.get('/ctx-demo.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'ctx-demo.html')));
app.get('/studio-ocr.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'studio-ocr.html')));
app.get('/fleet', (_req, res) => res.sendFile(path.join(UI_DIR, '0711-fleet.html')));
app.get('/api/fleet/data', (_req, res) => res.sendFile(path.join(UI_DIR, '0711-fleet.data.json')));
app.use(express.static(UI_DIR));

// Docs: /docs/WORKFLOW_TEMPLATE.md direkt ausliefern (plain text)
app.get('/docs/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return res.status(400).end();
  const p = path.join(ROOT, 'docs', file);
  res.sendFile(p, (err) => { if (err) res.status(404).end(); });
});

// ============ Start ============

const port = Number(process.env.PORT ?? 7800);
app.listen(port, () => {
  console.log(`STURM · http://localhost:${port}`);
  console.log(`  Workflows:    ${listWorkflows().map(w => w.id).join(', ') || '(keine)'}`);
  console.log(`  Anwendungen:  ${listApplications().map(a => a.id).join(', ') || '(keine)'}`);
  console.log(`  Studio:       http://localhost:${port}/studio-ocr.html`);
});

// Janitor — runs in-process, sweeps uploads/ + run _input/ folders.
startUploadSweep({
  uploadsDir: UPLOADS_DIR,
  runsDir: RUNS_DIR,
  inputRetentionDays: Number(process.env.STURM_INPUT_RETENTION_DAYS ?? 7),
});
