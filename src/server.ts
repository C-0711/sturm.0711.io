import { createMandantenBescheidRouter } from "./server/m-bescheid.ts";
import express, { type Request } from 'express';
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
import type { McpHandle, LlmHandle } from './core/tools/handles.ts';
import { createOrchestratorRouter } from './server/orchestrator.ts';
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
import { createCtxBenchRouter } from './lib/ctx-bench-server.ts';
import { createIntegrationsRouter } from './server/integrations.ts';
import { createTokensRouter, createSessionRedeemRouter, sessionCookieMiddleware } from './server/sessions.ts';
import { createMandantenAuthRouter } from './server/m-auth.ts';
import { createMandantenCasesRouter, createOwnershipGuard } from './server/m-cases.ts';
import { createCaseStreamRouter } from './server/case-stream.ts';
import { createClassifyRouter } from './server/classify-route.ts';
import { createWorkflowsUserRouter, loadAndRegisterUserWorkflows } from './server/workflows-user.ts';
import {
  createApplicationsRouter,
  loadInstanceFile,
  saveInstanceFile,
} from './server/applications.ts';
import { registerOnboardingEndpoint } from './server/onboarding-handler.ts';
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
  recordFastPathAnalysis,
  writeManifest,
} from './server/inbox.ts';
import {
  applyOverrides,
  deleteStageOverride,
  readOverrides,
  writeStageOverride,
} from './core/config-overrides.ts';
import { startUploadSweep } from './server/upload-sweep.ts';
import { analyzeFastPdfUpload, materializeFastCaseFacts, runFastAudit } from './server/fast-path.ts';
import { cold_preprocess_stub_freistehend, einsekunde_pipeline, einsekunde_pipeline_freistehend } from './server/einsekunde.ts';
import { getEmbedCacheStats, clearEmbedCache } from './lib/gemma-embed.ts';
import { getLane1CacheStats, clearLane1Cache } from './server/einsekunde.ts';
import { registerVorjahresUploadEndpoint } from './server/vorjahres-upload-handler.ts';
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
// Mandanten-Useraccounts (Mandanten-Workspace, /m/*-Surface). Liegt unter
// runs/ damit es per Default gitignored ist — User-JSONs enthalten
// Passwort-Hashes.
const USERS_DIR = path.join(RUNS_DIR, '_users');
const CANONICALS_DIR = path.join(__dirname, 'canonicals-seed');
const PIPELINES_DIR = path.join(__dirname, 'pipelines-seed');
const UI_DIR = path.join(__dirname, 'ui');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
fs.mkdirSync(USER_WORKFLOWS_DIR, { recursive: true });
fs.mkdirSync(APPLICATIONS_DIR, { recursive: true });
fs.mkdirSync(USERS_DIR, { recursive: true });

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

// Orchestrator: Gemma-4 Steuerassistent fuer steuerfall-est. Wird hier
// post-boot konfiguriert, weil wir die vLLM-URL aus dem LlmHandle.meta
// nehmen (kein direkter env-read).
function resolveOrchestratorVllm(): { baseUrl: string; model: string } | null {
  const container = getToolContainer('steuerfall-est');
  if (!container) return null;
  try {
    const llm = container.getByRole<LlmHandle>('extraction-llm');
    const baseUrl = llm.meta.baseUrl ?? 'http://localhost:11435';
    return { baseUrl, model: llm.meta.model };
  } catch {
    return null;
  }
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

/** Pick the extraction workflow ID for a case upload. Priority:
 *   1. URL query `?workflow=elster-v6-vision` (per-request override, useful
 *      for one-off tests via UI toggle)
 *   2. inst.extractionWorkflow (per-case override, PATCH-set, persisted)
 *   3. app_.workflows.extraction (Anwendung default; env-overridable via
 *      STURM_EXTRACTION_WORKFLOW)
 * Returns undefined if none configured.
 */
function pickExtractionWorkflow(
  req: import('express').Request,
  inst: { extractionWorkflow?: string } | null,
  app_: { workflows: { extraction?: string } },
): string | undefined {
  const fromQuery = typeof req.query?.workflow === 'string' ? req.query.workflow.trim() : '';
  if (fromQuery && /^[A-Za-z0-9._-]+$/.test(fromQuery)) return fromQuery;
  const fromInst = inst?.extractionWorkflow;
  if (typeof fromInst === 'string' && fromInst.length > 0) return fromInst;
  return app_.workflows.extraction;
}

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

// TIER A.1: cache observability endpoints
app.get('/api/quantum/cache-stats', (_req, res) => {
  res.json({
    embed_cache: getEmbedCacheStats(),
    lane1_cache: getLane1CacheStats(),
  });
});
app.post('/api/quantum/cache-clear', (_req, res) => {
  clearEmbedCache();
  clearLane1Cache();
  res.json({ ok: true, cleared: ['embed', 'lane1'] });
});

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

// Ownership-Guard für Mandanten-Cookies. Greift NUR wenn sturm-session-Cookie
// gesetzt UND der Fall einen ownerUserId hat. Bearer-Aufrufe (Admin) und
// Legacy-Cases ohne Owner werden durchgelassen. Muss VOR den
// Instance-Handlern montiert sein. Siehe docs/MANDANTEN_WORKSPACE.md.
app.use(
  '/api/applications/:appId/instances/:caseId',
  createOwnershipGuard({
    applicationsDir: APPLICATIONS_DIR,
    workspacesDir: WORKSPACES_DIR,
    usersDir: USERS_DIR,
  }),
);

// Instances: GET (list), GET (one), POST (create) — file-backed JSON registry.
app.use('/api/applications', express.json(), createApplicationsRouter({ dir: APPLICATIONS_DIR }));

// Onboarding-Wizard (5-Fragen) — alternative zum Vorjahres-Upload für Neukunden.
// Schreibt einen `CaseContext` mit source='onboarding' in die Instance.
registerOnboardingEndpoint(app, { applicationsDir: APPLICATIONS_DIR });

// ── Orchestrator: Gemma-4 Steuerassistent ──────────────────────────────
// SSE-Stream-Surface unter /api/orchestrator + Vanilla-Chat-UI unter
// /orchestrator. Wird nur registriert, wenn der ToolContainer fuer
// steuerfall-est einen erreichbaren Extraction-LLM (vLLM/Gemma) bietet.
{
  const vllm = resolveOrchestratorVllm();
  if (vllm) {
    app.use('/api/orchestrator', express.json(), createOrchestratorRouter({
      appId: 'steuerfall-est',
      vllmUrl: vllm.baseUrl,
      modelName: vllm.model,
      applicationsDir: APPLICATIONS_DIR,
      runsDir: RUNS_DIR,
      rootCwd: ROOT,
    }));
    console.log(`  Orchestrator:   /api/orchestrator → ${vllm.baseUrl} (${vllm.model})`);
  } else {
    console.log('  Orchestrator:   nicht aktiviert (kein extraction-llm fuer steuerfall-est)');
  }
}

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
    // Persist the workflow that processed this upload so a later
    // /master?refresh=1 (without ?workflow=) aggregates from the SAME
    // workflow's run dir. Without this, refresh falls back to the app
    // default and finds 0 runs for cases that used a per-request override.
    if (extractionId && inst.extractionWorkflow !== extractionId) {
      inst.extractionWorkflow = extractionId;
    }
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

// ── POST /api/applications/:appId/instances/:caseId/upload-fast ────────
// Fast-Ingest ohne OCR/Workflow: Datei nur in inbox persistieren, nativen
// PDF-Textlayer extrahieren und als Fast-Path-Artefakt ablegen. Dieser
// Endpoint ist absichtlich strikt: kein OCR-Fallback, keine LLM-Extraktion.
app.post(
  '/api/applications/:appId/instances/:caseId/upload-fast',
  upload.single('file'),
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) { res.status(404).json({ error: `application not found: ${appId}` }); return; }
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) { res.status(404).json({ error: `case not found: ${caseId}` }); return; }
    if (!req.file) { res.status(400).json({ error: 'file fehlt (multipart field "file")' }); return; }
    if (!/pdf/i.test(req.file.mimetype || req.file.originalname)) {
      res.status(415).json({ error: 'upload-fast unterstützt aktuell nur PDF-Dateien' });
      return;
    }

    const syntheticRunId = `fast-${Date.now().toString(36)}`;
    const doc = await persistUploadToInbox(ROOT, inst, {
      tempPath: req.file.path,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    }, syntheticRunId, { replaceRunIdOnDuplicate: false });

    inst.documents = inst.documents ?? [];
    if (!inst.documents.some((d) => d.sha256 === doc.sha256)) inst.documents.push(doc);
    if (inst.status === 'archiviert') inst.status = 'in_bearbeitung';
    await saveInstanceFile(APPLICATIONS_DIR, inst);

    try {
      const fastPath = await analyzeFastPdfUpload(ROOT, inst, doc);
      await recordFastPathAnalysis(ROOT, inst, doc.runId, {
        kind: fastPath.kind,
        hasTextLayer: fastPath.hasTextLayer,
        chars: fastPath.chars,
        pageCount: fastPath.pageCount,
        analyzedAt: fastPath.analyzedAt,
        ms: fastPath.ms,
        docTypeHints: fastPath.facts.docTypeHints,
        yearHints: fastPath.facts.yearHints,
        preview: fastPath.facts.preview,
        structuredFacts: fastPath.facts.structuredFacts,
        artifactDir: fastPath.artifactDir,
        analysisPath: fastPath.analysisPath,
        textPath: fastPath.textPath,
        factsPath: fastPath.facts.factsPath,
      });
      const refreshedManifest = await readManifest(ROOT, inst);
      const persistedDoc = refreshedManifest.documents.find((d) => d.sha256 === doc.sha256) ?? doc;
      const caseFacts = await materializeFastCaseFacts(ROOT, inst);
      res.json({
        ok: true,
        mode: 'upload-fast',
        appId,
        caseId,
        document: persistedDoc,
        fastPath,
        caseFacts,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        mode: 'upload-fast',
        appId,
        caseId,
        document: doc,
        error: (err as Error).message,
      });
    }
  },
);

// ── POST /api/applications/:appId/instances/:caseId/upload-1sek ────────
// EIN-SEKUNDEN-STEUERPIPELINE: Upload → Textlayer → Einbettung → eCode-Treffer
// → kanonische Felder → Lane-1 BMF-Calculator → ESt-Ergebnis, alles in EINEM
// Request. Ziel-Latenz < 1 Sekunde end-to-end. Liefert Timings pro Stufe
// und Vorschau der extrahierten Kennzahlen mit Treffer-Punktzahlen.
//
// Strikt PDF-only, kein OCR-Fallback. Wenn der Textlayer leer ist (gescanntes
// PDF ohne Text), schlägt die Pipeline mit fehler='keine Kennzahlen ...' fehl
// statt OCR zu starten — letzteres würde das 1-Sekunden-Budget sprengen.
app.post(
  '/api/applications/:appId/instances/:caseId/upload-1sek',
  upload.single('file'),
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) { res.status(404).json({ error: `application not found: ${appId}` }); return; }
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) { res.status(404).json({ error: `case not found: ${caseId}` }); return; }
    if (!req.file) { res.status(400).json({ error: 'datei fehlt (multipart field "file")' }); return; }
    if (!/(pdf|jpe?g|png|webp|gif)/i.test(req.file.mimetype || req.file.originalname)) {
      res.status(415).json({ error: 'upload-1sek unterstützt PDF/JPG/PNG/WEBP/GIF' });
      return;
    }

    const syntheticRunId = `einsek-${Date.now().toString(36)}`;
    const doc = await persistUploadToInbox(ROOT, inst, {
      tempPath: req.file.path,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    }, syntheticRunId, { replaceRunIdOnDuplicate: false });

    inst.documents = inst.documents ?? [];
    if (!inst.documents.some((d) => d.sha256 === doc.sha256)) inst.documents.push(doc);
    if (inst.status === 'archiviert') inst.status = 'in_bearbeitung';
    await saveInstanceFile(APPLICATIONS_DIR, inst);

    try {
      const ergebnis = await einsekunde_pipeline(ROOT, inst, doc);
      res.json(ergebnis);
    } catch (err) {
      res.status(500).json({
        ok: false,
        kind: 'einsekunde-v1',
        appId,
        caseId,
        document: doc,
        fehler: (err as Error).message,
      });
    }
  },
);

// ── POST /api/applications/:appId/instances/:caseId/audit-now ───────────
// Heißpfad: nutzt nur vorhandene Cache-/Meta-Artefakte und ruft danach
// Lane-1. Default ist fail-on-fresh: liegen frische inbox-PDFs ohne Vorarbeit
// vor, wird bewusst NICHT stillschweigend OCR ausgelöst.
app.post(
  '/api/applications/:appId/instances/:caseId/audit-now',
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) { res.status(404).json({ error: `application not found: ${appId}` }); return; }
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) { res.status(404).json({ error: `case not found: ${caseId}` }); return; }

    try {
      const audit = await runFastAudit(ROOT, inst);
      res.json(audit);
    } catch (err) {
      const message = (err as Error).message || 'fast audit failed';
      const isFastBlocker = /blocked:|fresh PDFs|--fail-on-fresh|FATAL:/i.test(message);
      res.status(isFastBlocker ? 409 : 500).json({
        ok: false,
        mode: 'audit-now',
        appId,
        caseId,
        error: message,
      });
    }
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
    // Per-case workflow override (set via PATCH /api/m/cases/:caseId or
    // upload-time query ?workflow=…). Falls back to the application's
    // default extraction workflow.
    const extractionId = pickExtractionWorkflow(req, inst, app_);
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
      caseContext: inst.context ?? undefined,
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
    // Persist Workflow-Wahl für spätere master-Refresh (sonst fällt der
    // pickExtractionWorkflow ohne Query auf den App-Default zurück und
    // findet keine Runs im richtigen workflow-Verzeichnis).
    if (extractionId && inst.extractionWorkflow !== extractionId) {
      inst.extractionWorkflow = extractionId;
    }
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
        const indikationOut = (result.stages?.indikation?.output as {
          anlagen?: string[]; belegtyp?: string | null;
          wichtige_werte?: Array<{ label: string; value: string }>; ms?: number;
        } | undefined);
        const layer = bmf?.canonical_layer ?? merge?.canonical_layer ?? null;
        await recordDocumentRunCompletion(ROOT, inst, run.runId, {
          anlagen: klass?.erkannte_anlagen,
          fieldsExtracted: layer ? Object.keys(layer).length : 0,
          trustBreakdown: computeTrustBreakdown(layer),
          indikation: indikationOut ? {
            anlagen: indikationOut.anlagen ?? [],
            belegtyp: indikationOut.belegtyp ?? null,
            wichtige_werte: indikationOut.wichtige_werte ?? [],
            ms: indikationOut.ms ?? 0,
            at: new Date().toISOString(),
          } : undefined,
        });
        // P2: refresh the case-level master.json (single source of truth
        // consumed by abrechnung.html, source-viewer, ELSTER export, etc.).
        try {
          const fresh = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
          if (fresh && extractionId) {
            const { writeCaseMaster } = await import('./server/case-master.ts');
            await writeCaseMaster(fresh, {
              runsDir: RUNS_DIR,
              extractionWorkflowId: extractionId,
              workspaceBase: ROOT,
            });
          }
        } catch (e) {
          console.error('[upload] master.json refresh failed:', (e as Error).message);
        }
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
    const extractionId = pickExtractionWorkflow(req, inst, app_);
    if (!extractionId) { res.status(409).json({ error: `application ${appId} has no extraction workflow configured` }); return; }
    const baseDef = getWorkflow(extractionId);
    if (!baseDef) { res.status(409).json({ error: `extraction workflow not registered: ${extractionId}` }); return; }
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) { res.status(400).json({ error: 'mindestens eine Datei erforderlich (multipart field "files")' }); return; }
    // Default 16, Cap 32 — H200v hat 248GB GPU, Gemma-4 31B braucht ~60GB,
    // vLLM continuous-batching nimmt locker 16-32 parallele Requests.
    // Override per ?concurrency=N.
    const concurrency = Math.max(1, Math.min(32, Number(req.query.concurrency) || 16));

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
      caseContext: inst.context ?? undefined,
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
          // P2: refresh master.json after each doc completes (case state
          // accretes incrementally, UI sees fresh data immediately).
          try {
            const fresh = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
            if (fresh && extractionId) {
              const { writeCaseMaster } = await import('./server/case-master.ts');
              await writeCaseMaster(fresh, {
                runsDir: RUNS_DIR,
                extractionWorkflowId: extractionId,
                workspaceBase: ROOT,
              });
            }
          } catch (e) {
            console.error('[bulk] master.json refresh failed:', (e as Error).message);
          }
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

    // ── Round-1 Indikation: ALLE Dokumente parallel + ungethrottelt ──────
    // Vor dem (gethrottelten) Workflow-Pool feuern wir Mistral Small Vision
    // für jedes Dokument SOFORT — die Indikation soll für alle Dokumente
    // innerhalb von ~3s sichtbar sein, unabhängig davon wann die jeweilige
    // Heavy-Pipeline dran ist (Gemma-OCR cappt bei concurrency=4).
    void (async () => {
      const { runBelegIndikation } = await import('./stages/beleg-indikation.ts');
      const { recordEagerIndikation } = await import('./server/inbox.ts');
      await Promise.all(files.map(async (file, idx) => {
        if (aborted) return;
        try {
          const result = await runBelegIndikation(
            { filePath: file.path, filename: file.originalname },
            { dpi: 150, maxTokens: 800, timeoutMs: 30_000 },
          );
          if (aborted) return;
          res.write(formatSseEvent({
            name: 'beleg_indikation',
            runId: '',
            workflowId: def.id,
            at: new Date().toISOString(),
            payload: { docIdx: idx, filename: file.originalname, ...result },
          }));
          // Persist into manifest so UI sees indikation.belegtyp after reload
          // (docKategorie() falls back to belegtyp wenn vorhanden).
          await recordEagerIndikation(ROOT, inst, file.originalname, {
            ...result, at: new Date().toISOString(),
          });
        } catch (err) {
          console.warn('[bulk] eager indikation failed for', file.originalname, ':', (err as Error).message);
        }
      }));
    })();

    // Concurrency-limited Pool für die schwere Pipeline (OCR + Extraction).
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
      // Persist actually-used workflow so /aggregate + /master ohne ?workflow
      // den richtigen runs/<workflowId>/ Pfad scannen.
      if (extractionId && freshInst.extractionWorkflow !== extractionId) {
        freshInst.extractionWorkflow = extractionId;
      }
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

// ── POST /api/applications/:appId/instances/:caseId/vorjahres-upload ───
// Mandanten-Onboarding via Vorjahres-Erklärung — triggert den Workflow
// `vorjahres-kontext-extract` und persistiert den CaseContext am Case.
registerVorjahresUploadEndpoint(app, {
  rootDir: ROOT,
  runsDir: RUNS_DIR,
  uploadsDir: UPLOADS_DIR,
  applicationsDir: APPLICATIONS_DIR,
  requireBearerToken,
});

// ── DELETE /api/applications/:appId/instances/:caseId/documents/:runId ─
// Löscht einen Beleg aus dem Fall: Manifest-Eintrag, Inbox-Datei,
// Run-Artefakte. Master.json wird neu geschrieben. 200 wenn erfolgreich,
// 404 wenn runId unbekannt. Idempotent: bereits gelöschte Dateien sind ok.
app.delete(
  '/api/applications/:appId/instances/:caseId/documents/:runId',
  async (req, res) => {
    const { appId, caseId, runId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });

    const { readManifest, writeManifest, inboxDirFor } = await import('./server/inbox.ts');
    const manifest = await readManifest(ROOT, inst);
    const docIdx = manifest.documents.findIndex((d) => d.runId === runId);
    if (docIdx < 0) return res.status(404).json({ error: 'document not found', runId });

    const doc = manifest.documents[docIdx];
    const inboxAbs = path.join(inboxDirFor(ROOT, inst), path.basename(doc.inboxPath));

    // 1. Inbox-Datei entfernen (best-effort)
    try { await fs.promises.unlink(inboxAbs); } catch { /* schon weg */ }

    // 2. Run-Artefakte entfernen (best-effort über alle bekannten Workflow-Verzeichnisse)
    const extractionId = app_.workflows.extraction;
    if (extractionId) {
      const runDir = path.join(RUNS_DIR, extractionId, runId);
      try { await fs.promises.rm(runDir, { recursive: true, force: true }); } catch { /* nix */ }
    }

    // 3. Manifest-Eintrag entfernen
    manifest.documents.splice(docIdx, 1);
    await writeManifest(ROOT, inst, manifest);

    // 4. runs[] in der Instance auch bereinigen
    inst.runs = inst.runs.filter((r) => r !== runId);
    inst.documents = manifest.documents;
    await saveInstanceFile(APPLICATIONS_DIR, inst);

    // 5. master.json neu schreiben damit die Abrechnung den gelöschten Beleg vergisst
    if (extractionId) {
      try {
        const { writeCaseMaster } = await import('./server/case-master.ts');
        await writeCaseMaster(inst, {
          runsDir: RUNS_DIR,
          extractionWorkflowId: extractionId,
          workspaceBase: ROOT,
        });
      } catch (e) {
        console.error('[delete-doc] master.json refresh failed:', (e as Error).message);
      }
    }

    res.json({ ok: true, runId, filename: doc.filename, remaining: manifest.documents.length });
  },
);

// ── POST /api/applications/:appId/instances/:caseId/documents/:runId/retry
// Startet einen NEUEN Extraction-Run auf die schon vorhandene Inbox-Datei.
// Antwortet als SSE (gleiches Schema wie /upload-bulk: doc_start, stage_*, doc_done).
// Im Manifest wird der runId-Eintrag auf den neuen Run umgehängt; alte
// Run-Artefakte werden vorher gelöscht.
app.post(
  '/api/applications/:appId/instances/:caseId/documents/:runId/retry',
  async (req, res) => {
    const { appId, caseId, runId: oldRunId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    const extractionId = app_.workflows.extraction;
    if (!extractionId) return res.status(409).json({ error: 'no-extraction-workflow' });
    const baseDef = getWorkflow(extractionId);
    if (!baseDef) return res.status(409).json({ error: `extraction workflow not registered: ${extractionId}` });

    const { readManifest, writeManifest, inboxDirFor } = await import('./server/inbox.ts');
    const manifest = await readManifest(ROOT, inst);
    const doc = manifest.documents.find((d) => d.runId === oldRunId);
    if (!doc) return res.status(404).json({ error: 'document not found', runId: oldRunId });

    const inboxAbs = path.join(inboxDirFor(ROOT, inst), path.basename(doc.inboxPath));
    try { await fs.promises.access(inboxAbs); } catch {
      return res.status(410).json({ error: 'inbox file gone', inboxPath: doc.inboxPath });
    }

    // SSE-Stream starten
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let aborted = false;
    req.on('close', () => { aborted = true; });

    const def = applyOverrides(baseDef, await readOverrides(ROOT, baseDef.id));

    const input: Record<string, unknown> = {
      filePath: inboxAbs,
      filename: doc.filename,
      size: doc.size,
      mime: doc.mimeType,
      mandant_id: inst.mandantId,
      case_id: inst.caseId,
      caseContext: inst.context ?? undefined,
    };
    const run = runWorkflow(def, { runsDir: RUNS_DIR, input, appId });
    void persistInputForRun(def.id, run.runId, inboxAbs, doc.filename, doc.size, doc.mimeType);

    // Alte Run-Artefakte entsorgen (best-effort)
    try {
      await fs.promises.rm(path.join(RUNS_DIR, def.id, oldRunId), { recursive: true, force: true });
    } catch { /* egal */ }

    // Doc-Eintrag im Manifest auf neuen Run umhängen + alte runId aus instance.runs entfernen
    doc.runId = run.runId;
    delete doc.fieldsExtracted;
    delete doc.anlagen;
    delete doc.trustBreakdown;
    await writeManifest(ROOT, inst, manifest);
    inst.runs = inst.runs.filter((r) => r !== oldRunId);
    inst.runs.push(run.runId);
    await saveInstanceFile(APPLICATIONS_DIR, inst);

    res.write(formatSseEvent({
      name: 'doc_start',
      runId: run.runId,
      workflowId: def.id,
      at: new Date().toISOString(),
      payload: { runId: run.runId, oldRunId, filename: doc.filename, totalStages: Object.keys(def.stages).length },
    }));

    const unsub = run.bus.subscribe((env) => {
      if (aborted) return;
      const wrapped = { ...env, payload: { ...((env.payload as Record<string, unknown>) ?? {}), runId: run.runId } };
      res.write(formatSseEvent(wrapped));
    });

    try {
      const result = await run.result;
      if (result.state === 'ok') {
        const klass = (result.stages?.klassifizierung?.output as { erkannte_anlagen?: string[] } | undefined);
        const bmf = (result.stages?.phase6BmfRechner?.output as { canonical_layer?: Record<string, unknown> } | undefined);
        const merge = (result.stages?.phase5Merge?.output as { canonical_layer?: Record<string, unknown> } | undefined);
        const indikationOut = (result.stages?.indikation?.output as {
          anlagen?: string[]; belegtyp?: string | null;
          wichtige_werte?: Array<{ label: string; value: string }>; ms?: number;
        } | undefined);
        const layer = bmf?.canonical_layer ?? merge?.canonical_layer ?? null;
        await recordDocumentRunCompletion(ROOT, inst, run.runId, {
          anlagen: klass?.erkannte_anlagen,
          fieldsExtracted: layer ? Object.keys(layer).length : 0,
          trustBreakdown: computeTrustBreakdown(layer),
          indikation: indikationOut ? {
            anlagen: indikationOut.anlagen ?? [],
            belegtyp: indikationOut.belegtyp ?? null,
            wichtige_werte: indikationOut.wichtige_werte ?? [],
            ms: indikationOut.ms ?? 0,
            at: new Date().toISOString(),
          } : undefined,
        });
        // master.json refresh
        try {
          const fresh = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
          if (fresh) {
            const { writeCaseMaster } = await import('./server/case-master.ts');
            await writeCaseMaster(fresh, { runsDir: RUNS_DIR, extractionWorkflowId: extractionId, workspaceBase: ROOT });
          }
        } catch (e) { console.error('[retry] master refresh failed:', (e as Error).message); }
        res.write(formatSseEvent({
          name: 'doc_done', runId: run.runId, workflowId: def.id, at: new Date().toISOString(),
          payload: { runId: run.runId, state: 'ok', fields: layer ? Object.keys(layer).length : 0, anlagen: klass?.erkannte_anlagen ?? [] },
        }));
      } else {
        res.write(formatSseEvent({
          name: 'doc_done', runId: run.runId, workflowId: def.id, at: new Date().toISOString(),
          payload: { runId: run.runId, state: result.state },
        }));
      }
    } catch (err) {
      res.write(formatSseEvent({
        name: 'doc_error', runId: run.runId, workflowId: def.id, at: new Date().toISOString(),
        payload: { runId: run.runId, error: (err as Error).message },
      }));
    } finally {
      unsub();
      res.end();
    }
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

// ── GET /api/_deploycheck ── sanity ping for deploy verification ───────
app.get('/api/_deploycheck', (_req, res) => {
  res.json({ deployedAt: '__V5_DEPLOY_CHECK__', ts: new Date().toISOString() });
});

// ── GET /api/source-bbox/:sha256/:page ─────────────────────────────────
// Returns word-level bounding boxes (in %) for a given snippet on a PDF
// page. Used by m-case.html viewer to highlight the source on the rendered
// PNG via absolute-positioned overlay divs.
//
// Query: ?q=<snippet> (URL-encoded text fragment). Server uses pdftotext
// -bbox-layout (Poppler) to get word positions, fuzzy-matches the snippet
// against the word sequence, returns matching word boxes as % of page-dim.
app.get(
  '/api/source-bbox/:sha256/:page',
  async (req, res) => {
    const sha = String(req.params.sha256 ?? '');
    const page = parseInt(req.params.page ?? '0', 10);
    const snippet = String(req.query.q ?? '').trim();
    if (!/^[0-9a-f]{64}$/i.test(sha)) return res.status(400).json({ error: 'invalid sha256' });
    if (!Number.isFinite(page) || page < 1 || page > 100) return res.status(400).json({ error: 'invalid page' });
    if (!snippet) return res.json({ matches: [] });
    // PDF path: uploads sind multer-random, sha256 ist im Case-Manifest →
    // Walk applications-data manifests, find doc mit matching sha256.
    let pdfPath: string | null = null;
    try {
      const appDir = path.join(APPLICATIONS_DIR, 'steuerfall-est');
      const files = await fs.promises.readdir(appDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.promises.readFile(path.join(appDir, f), 'utf8');
          const inst = JSON.parse(raw) as { workspacePath?: string; documents?: Array<{ sha256?: string; inboxPath?: string }> };
          const doc = (inst.documents ?? []).find((d) => d.sha256 === sha);
          if (doc && inst.workspacePath && doc.inboxPath) {
            const cand = path.join(ROOT, inst.workspacePath, doc.inboxPath);
            try {
              await fs.promises.stat(cand);
              pdfPath = cand;
              break;
            } catch { /* try next */ }
          }
        } catch { /* skip corrupt */ }
      }
    } catch { /* dir missing */ }
    if (!pdfPath) return res.status(404).json({ error: 'pdf not found for sha' });
    // Tesseract Fallback nutzt das gecachte PNG (gleicher render-cache wie /source-page)
    const pngPath = path.join(RUNS_DIR, '_pdf_render', sha, `page-${page}.png`);
    try {
      const { findSnippetBboxes } = await import('./server/pdf-bbox.ts');
      const matches = await findSnippetBboxes(pdfPath, page, snippet, pngPath);
      res.json({ matches });
    } catch (err) {
      res.status(500).json({ error: 'bbox-extract failed', message: (err as Error).message });
    }
  },
);

// ── GET /api/source-page/:sha256/:page ─────────────────────────────────
// Streams a cached PDF-render PNG by content hash (P6 source viewer).
// Path constrained: sha256 must be hex, page must be 1-based ≤ 50.
// No directory traversal possible. Token-frei (UI is open).
app.get(
  '/api/source-page/:sha256/:page',
  async (req, res) => {
    const sha = String(req.params.sha256 ?? '');
    const page = parseInt(req.params.page ?? '0', 10);
    if (!/^[0-9a-f]{64}$/i.test(sha)) {
      return res.status(400).json({ error: 'invalid sha256' });
    }
    if (!Number.isFinite(page) || page < 1 || page > 50) {
      return res.status(400).json({ error: 'invalid page (1-50)' });
    }
    const pngPath = path.join(RUNS_DIR, '_pdf_render', sha, `page-${page}.png`);
    try {
      const stat = await fs.promises.stat(pngPath);
      if (!stat.isFile()) return res.status(404).json({ error: 'not found' });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
      res.setHeader('Content-Length', String(stat.size));
      fs.createReadStream(pngPath).pipe(res);
    } catch {
      res.status(404).json({ error: 'not cached — run pdf-render first' });
    }
  },
);

// ── GET /api/applications/:appId/instances/:caseId/master ─────────────
// Persisted case-level state (P2). Returns the latest master.json from
// disk; query ?refresh=1 forces a fresh compute + rewrite. UI consumers
// (abrechnung.html, source-viewer, landing page) should prefer this over
// /aggregate because it's read-from-disk and contains the full citation
// chain ({page, snippet} per source).
app.get(
  '/api/applications/:appId/instances/:caseId/master',
  async (req, res) => {
    const { appId, caseId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    // Respect per-case extractionWorkflow override (set via PATCH /api/m/cases/:id).
    // Picker: query > inst.extractionWorkflow > app default.
    const extractionId = pickExtractionWorkflow(req, inst, app_);
    if (!extractionId) return res.status(409).json({ error: 'no-extraction-workflow' });

    const { readCaseMaster, writeCaseMaster } = await import('./server/case-master.ts');
    const refresh = req.query.refresh === '1';
    if (!refresh) {
      const existing = await readCaseMaster(inst, ROOT);
      if (existing) return res.json(existing);
    }
    try {
      const { master } = await writeCaseMaster(inst, {
        runsDir: RUNS_DIR,
        extractionWorkflowId: extractionId,
        workspaceBase: ROOT,
      });
      res.json(master);
    } catch (e) {
      const err = e as Error & { cause?: unknown };
      console.error('[master] write failed:', err.message, 'cause:', err.cause);
      res.status(500).json({
        error: 'master-write-failed',
        message: err.message,
        cause: err.cause instanceof Error ? err.cause.message : (err.cause ?? null),
      });
    }
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
    // Respect per-case extractionWorkflow override (set via PATCH /api/m/cases/:id).
    // Picker: query > inst.extractionWorkflow > app default.
    const extractionId = pickExtractionWorkflow(req, inst, app_);
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
        (agg as { bmf?: unknown }).bmf = {
          erfolg: false,
          reason: 'mcp-error',
          message: (e as Error).message,
          xMarker: 'CATCH_V4',
        };
      }
    }

    // route-end marker to verify which handler version is running
    (agg as { _routeVersion?: string })._routeVersion = 'server.ts:aggregate:CATCH_V4';
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

// ── GET /api/applications/:appId/instances/:caseId/runs/:runId/progress ──
// Liefert die Liste der bisher fertigen Stages eines laufenden (oder fertigen)
// Runs. Quelle ist die Verzeichnisstruktur unter runs/<workflowId>/<runId>/:
// pro fertiger Stage existiert ein Unterordner mit output.json. Wir müssen
// den workflowId nicht kennen — wir scannen runs/ nach dem (eindeutigen)
// runId. Endpunkt ist token-frei, gleicher Scope wie /runs/:runId/summary.
app.get(
  '/api/applications/:appId/instances/:caseId/runs/:runId/progress',
  async (req, res) => {
    const { appId, caseId, runId } = req.params;
    const app_ = getApplication(appId);
    if (!app_) return res.status(404).json({ error: `application not found: ${appId}` });
    const inst = await loadInstanceFile(APPLICATIONS_DIR, appId, caseId);
    if (!inst) return res.status(404).json({ error: `case not found: ${caseId}` });
    if (!inst.runs.includes(runId)) {
      return res.status(404).json({ error: 'run not in case' });
    }
    // Bevorzugte Auflösung: extraction-Workflow der App. Wenn der run-Ordner
    // dort nicht existiert (z.B. weil ein anderer Workflow den Run erzeugt
    // hat), fallen wir auf einen Scan aller Workflows zurück.
    const primary = app_.workflows.extraction;
    const candidates: string[] = [];
    if (primary) candidates.push(primary);
    try {
      const wfDirs = await fs.promises.readdir(RUNS_DIR, { withFileTypes: true });
      for (const d of wfDirs) {
        if (d.isDirectory() && !candidates.includes(d.name)) candidates.push(d.name);
      }
    } catch { /* RUNS_DIR fehlt — ignorieren */ }

    for (const wfId of candidates) {
      const runDir = path.join(RUNS_DIR, wfId, runId);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(runDir, { withFileTypes: true });
      } catch { continue; }
      const completedStages = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
        .map((e) => e.name);
      const hasResult = entries.some((e) => e.isFile() && e.name === '_result.json');
      return res.json({
        runId,
        workflowId: wfId,
        completedStages,
        finished: hasResult,
      });
    }
    return res.status(404).json({ error: 'run not found' });
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


// ── POST /api/upload-cold-preprocess  (fall- und mandanten-frei) ──────────
// Erkennt früh, ob ein Beleg den Hot-Path direkt bedienen kann oder erst
// durch den kalten Vorverarbeitungspfad (z.B. OCR bei scan-only PDFs) muss.
// Schreibt ein kleines Job-Artefakt unter /tmp/sturm-cold-preprocess/<job>.json.
app.post(
  '/api/upload-cold-preprocess',
  requireBearerToken,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'datei fehlt (multipart field "file")' });
      return;
    }
    if (!/(pdf|jpe?g|png|webp|gif)/i.test(req.file.mimetype || req.file.originalname)) {
      res.status(415).json({ error: 'upload-cold-preprocess unterstuetzt PDF/JPG/PNG/WEBP/GIF' });
      return;
    }
    const jahr_raw = (req.body?.steuerjahr ?? req.query?.steuerjahr) as string | undefined;
    const steuerjahr = jahr_raw ? Number(jahr_raw) : undefined;
    try {
      const ergebnis = await cold_preprocess_stub_freistehend(
        req.file.path,
        req.file.originalname,
        Number.isFinite(steuerjahr as number) ? (steuerjahr as number) : undefined,
      );
      res.json(ergebnis);
    } catch (err) {
      res.status(500).json({
        ok: false,
        kind: 'cold-preprocess-v1',
        dateiname: req.file?.originalname,
        fehler: (err as Error).message,
      });
    }
  },
);

app.get('/api/cold-preprocess/:jobId', requireBearerToken, async (req, res) => {
  const jobId = String(req.params.jobId || '');
  if (!/^[a-z0-9_\-]+$/i.test(jobId)) {
    res.status(400).json({ error: 'ungueltige jobId' });
    return;
  }
  const artefakt = path.join('/tmp/sturm-cold-preprocess', `${jobId}.json`);
  try {
    const raw = await fs.promises.readFile(artefakt, 'utf-8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'job-not-found', jobId });
  }
});

// ── POST /api/upload-1sek  (fall- und mandanten-frei) ──────────────────
// Nimmt ein PDF entgegen und fuehrt die EIN-SEKUNDEN-STEUERPIPELINE durch:
//   Textlayer -> Kennzahlen -> Einbettung -> eCode-Treffer -> kanonisch
//   -> Lane-1 BMF-Calculator -> ESt-Ergebnis
// Persistiert NICHTS. Optionales Query- oder Form-Feld `steuerjahr`.
// Strikt PDF-only, kein OCR-Fallback (sprengt das 1-Sekunden-Budget).
app.post(
  '/api/upload-1sek',
  requireBearerToken,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'datei fehlt (multipart field "file")' });
      return;
    }
    if (!/(pdf|jpe?g|png|webp|gif)/i.test(req.file.mimetype || req.file.originalname)) {
      res.status(415).json({ error: 'upload-1sek unterstuetzt PDF/JPG/PNG/WEBP/GIF' });
      return;
    }

    const jahr_raw = (req.body?.steuerjahr ?? req.query?.steuerjahr) as string | undefined;
    const steuerjahr = jahr_raw ? Number(jahr_raw) : undefined;

    try {
      const ergebnis = await einsekunde_pipeline_freistehend(
        req.file.path,
        req.file.originalname,
        Number.isFinite(steuerjahr as number) ? (steuerjahr as number) : undefined,
      );
      res.json(ergebnis);
    } catch (err) {
      res.status(500).json({
        ok: false,
        kind: 'einsekunde-freistehend-v1',
        dateiname: req.file?.originalname,
        fehler: (err as Error).message,
      });
    }
  },
);


// ── Mega-Case Profil (case-frei) ───────────────────────────────────
// Konzept: Basis-Beleg (Lohnsteuerbescheinigung / ESt-Bescheid / Rente)
// erstellt ein Profil mit ID. Folge-Belege patchen das Profil und zeigen
// die ESt-Differenz. TTL 1h, in-memory.

import {
  megacase_profil_erstellen,
  megacase_beleg_hinzufuegen,
  megacase_profil_holen,
  megacase_profil_loeschen,
  megacase_alle_profile,
} from './server/einsekunde.ts';

// POST /api/megacase/start  - Basis-Beleg → erstellt Profil
app.post(
  '/api/megacase/start',
  requireBearerToken,
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) { res.status(400).json({ ok: false, error: 'datei fehlt' }); return; }
      const steuerjahr = Number(req.query.steuerjahr ?? req.body?.steuerjahr ?? new Date().getFullYear() - 1);
      const ergebnis = await megacase_profil_erstellen(req.file.path, req.file.originalname, steuerjahr);
      if (!ergebnis.ok) { res.status(422).json(ergebnis); return; }
      res.json(ergebnis);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// POST /api/megacase/:profil_id/add  - Folge-Beleg → patches Profil + Diff
app.post(
  '/api/megacase/:profil_id/add',
  requireBearerToken,
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) { res.status(400).json({ ok: false, error: 'datei fehlt' }); return; }
      const ergebnis = await megacase_beleg_hinzufuegen(req.params.profil_id, req.file.path, req.file.originalname);
      if (!ergebnis.ok) { res.status(404).json(ergebnis); return; }
      res.json(ergebnis);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// GET /api/megacase/:profil_id  - aktuelles Profil + alle Belege
app.get('/api/megacase/:profil_id', requireBearerToken, (req, res) => {
  const profil = megacase_profil_holen(req.params.profil_id);
  if (!profil) { res.status(404).json({ ok: false, error: 'Profil nicht gefunden' }); return; }
  res.json({ ok: true, profil });
});

// DELETE /api/megacase/:profil_id
app.delete('/api/megacase/:profil_id', requireBearerToken, (req, res) => {
  const geloescht = megacase_profil_loeschen(req.params.profil_id);
  res.json({ ok: geloescht });
});

// GET /api/megacase  - alle aktiven Profile
app.get('/api/megacase', requireBearerToken, (req, res) => {
  res.json({ ok: true, profile: megacase_alle_profile() });
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

// ── Mandanten-Surface (/api/m/*) ──────────────────────────────────────
// Auth + Cases für die /m/* HTML-Surface. Nutzt dieselbe Session-Mechanik
// (sturm-session-Cookie) wie das Embed-Flow, aber mit User+Workspace-Stub.
// Siehe docs/MANDANTEN_WORKSPACE.md.
app.use('/api/m', createMandantenAuthRouter({
  usersDir: USERS_DIR,
  workspacesDir: WORKSPACES_DIR,
  cookieName: sessionsOpts.cookieName,
  secureCookie: sessionsOpts.secureCookie,
}));
app.use("/api/m", createMandantenBescheidRouter({
  usersDir: USERS_DIR,
  workspacesDir: WORKSPACES_DIR,
  profilesDir: "/app/profiles",
  runsDir: RUNS_DIR,
  uploadsDir: UPLOADS_DIR,
  appsRoot: ROOT,
  applicationsDir: APPLICATIONS_DIR,
}));

app.use('/api/m', createMandantenCasesRouter({
  usersDir: USERS_DIR,
  workspacesDir: WORKSPACES_DIR,
  applicationsDir: APPLICATIONS_DIR,
  runsDir: RUNS_DIR,
}));

// Live-Stream + Haiku-Narrator: /api/m/cases/:id/stream (SSE)
app.use('/api/m', createCaseStreamRouter());

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

// ============ ctx — drop-in context container surface ============
// Mounted WITHOUT requireBearerToken to match CLAUDE.md playground posture.
app.use('/ctx', express.json({ limit: '5mb' }), createCtxRouter({
  ollamaUrl: process.env.OLLAMA_URL,
  embedCpu: process.env.EMBED_CPU === '1',
}));
// Cross-LLM token-savings benchmark — SSE-streaming backend for ctx-demo.html.
app.use('/api/ctx-bench', express.json({ limit: '1mb' }), createCtxBenchRouter({
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

// ── Mandanten-Surface (/m/*) ──────────────────────────────────────────
// HTML-Routen für die Mandanten-Surface. Auth-Logik (Session-Cookie) wird
// in den jeweiligen API-Endpoints geprüft, die /m-*.html-Files selbst sind
// statisch und führen den eigenen Auth-Probe-Call (/api/m/me) durch.
// Siehe docs/MANDANTEN_WORKSPACE.md.
app.get('/m/login', (_req, res) => res.sendFile(path.join(UI_DIR, 'm-login.html')));
app.get('/m/dashboard', (_req, res) => res.sendFile(path.join(UI_DIR, 'm-dashboard.html')));
app.get('/m/case/:caseId', (_req, res) => res.sendFile(path.join(UI_DIR, 'm-case.html')));
app.get('/m/bescheid', (_req, res) => res.sendFile(path.join(UI_DIR, 'm-bescheid.html')));
app.get('/onboarding-wizard.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'onboarding-wizard.html')));

// ── Dev-Surface (Sturm-internal) ──────────────────────────────────────
// Diese Seiten sind Dev-Tools und sollten in Produktion hinter Bearer
// liegen. `requireBearerToken` ist no-op solange STURM_BEARER_TOKEN unset.
app.get('/pipeline.html', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, 'pipeline.html')));
app.get('/designer.html', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, 'designer.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
app.get('/anwendungen.html', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, 'anwendungen.html')));
app.get('/steuerfall.html', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, 'steuerfall.html')));
app.get('/orchestrator', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, 'orchestrator.html')));
app.get('/orchestrator.html', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, 'orchestrator.html')));
app.get('/abrechnung.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'abrechnung.html')));
app.get('/ctx-demo.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'ctx-demo.html')));
app.get('/studio-ocr.html', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, 'studio-ocr.html')));
app.get('/workspaces.html', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, 'workspaces.html')));
app.get('/fleet', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, '0711-fleet.html')));
app.get('/api/fleet/data', requireBearerToken, (_req, res) => res.sendFile(path.join(UI_DIR, '0711-fleet.data.json')));

// Block dev HTML files via the static catch-all when a session cookie is
// present (Mandanten-Modus). Bearer-Aufrufe und sessionlose Public-Calls
// (ctx-demo.html, abrechnung.html, m-*.html) gehen durch.
const DEV_ONLY_HTML = new Set([
  'anwendungen.html', 'pipeline.html', 'designer.html', 'studio-ocr.html',
  'workspaces.html', 'steuerfall.html', 'orchestrator.html', '0711-fleet.html',
  'document.html',
]);
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const file = req.path.replace(/^\//, '');
  if (!DEV_ONLY_HTML.has(file)) return next();
  const hasBearer = (req.headers['authorization'] ?? '').toString().toLowerCase().startsWith('bearer ');
  if (hasBearer) return next();
  const session = (req as Request & { sturmSession?: unknown }).sturmSession;
  if (session) {
    // Mandant — explizit blockieren
    return res.status(403).type('text/html').send(
      '<!doctype html><html><body style="font-family:system-ui;max-width:480px;margin:80px auto;padding:0 20px">'
      + '<h1 style="font-size:20px">403 — kein Zugriff</h1>'
      + '<p>Diese Seite ist nicht für Mandanten zugänglich.</p>'
      + '<p><a href="/m/dashboard">Zurück zum Dashboard</a></p>'
      + '</body></html>',
    );
  }
  return next();
});

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
