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
import { createIntegrationsRouter } from './server/integrations.ts';
import { createTokensRouter, createSessionRedeemRouter, sessionCookieMiddleware } from './server/sessions.ts';
import { createClassifyRouter } from './server/classify-route.ts';
import { createWorkflowsUserRouter, loadAndRegisterUserWorkflows } from './server/workflows-user.ts';
import { createApplicationsRouter } from './server/applications.ts';
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
app.get('/', (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
app.get('/pipeline.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'pipeline.html')));
app.get('/designer.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'designer.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
app.get('/studio-ocr.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'studio-ocr.html')));
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
