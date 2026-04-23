import express from 'express';
import multer from 'multer';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { registerAllStages } from './stages/index.ts';
import { registerAllWorkflows } from './workflows/index.ts';
import { listWorkflows, getWorkflow } from './core/registry.ts';
import { runWorkflow } from './core/runner.ts';
import { formatSseEvent } from './core/events.ts';
import type { WorkflowDef } from './core/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const RUNS_DIR = path.join(ROOT, 'runs');
const UI_DIR = path.join(__dirname, 'ui');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });

// Bootstrap-Registries
registerAllStages();
registerAllWorkflows();

const app = express();
app.use(express.json({ limit: '2mb' }));

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

// ============ Workflow-Metadaten ============

function summarizeWorkflow(def: WorkflowDef) {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    input: def.input,
    stages: Object.entries(def.stages).map(([id, s]) => ({
      id, uses: s.uses, name: s.name ?? id, description: s.description ?? null,
    })),
    edges: def.edges,
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

// ============ Upload ============

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file fehlt (multipart/form-data, field "file")' });
  res.json({
    storedFilename: req.file.filename,
    originalFilename: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype,
  });
});

// ============ Run (SSE) ============

app.post('/api/workflows/:id/run', upload.single('file'), async (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) { res.status(404).json({ error: `workflow not found: ${req.params.id}` }); return; }

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

  // SSE-Header
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const run = runWorkflow(def, { runsDir: RUNS_DIR, input });

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

app.get('/api/runs/:workflowId/:runId', async (req, res) => {
  const metaPath = path.join(RUNS_DIR, req.params.workflowId, req.params.runId, '_result.json');
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'run not found or still running' });
  }
});

// ============ Static UI ============

app.use('/design-system', express.static(path.join(UI_DIR, 'design-system')));
app.get('/', (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
app.get('/pipeline.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'pipeline.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
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
  console.log(`  Workflows: ${listWorkflows().map(w => w.id).join(', ') || '(keine)'}`);
});
