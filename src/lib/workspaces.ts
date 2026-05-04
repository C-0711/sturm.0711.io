/**
 * STURM workspace API — Phase 1 (filesystem-only persistence).
 *
 * Scope:
 *   - Create workspaces (lightweight, no GitChain container yet).
 *   - Upload files into <workspace>/inbox/.
 *   - List + fetch document metadata + binary.
 *
 * Out of scope here (later phases):
 *   - Auto-classify on upload (Phase 2)
 *   - Canonical templates + extraction (Phase 3-4)
 *   - Approve + master.json (Phase 5)
 *   - Promotion to GitChain `project` container via `0711` CLI (Phase 6)
 *
 * Filesystem layout:
 *   workspaces/
 *     index.json                    # [{id, name, createdAt}]
 *     <id>/
 *       inbox/<uuid>.<ext>          # incoming, unrouted
 *       <classification>/<uuid>.<ext>  # auto-routed in Phase 2
 *       meta/<uuid>.json            # per-document sidecar (grows over time)
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  callMistralOcrWithFallback,
  configToApiRequest,
  getFileSignedUrl,
  mimeFromFilename,
  parseApiResponse,
  uploadFile,
  type DocumentChunk,
  type MistralOcrConfig,
  type JsonSchema,
} from '../lib/mistral-ocr/index.ts';
import { classifyDocument, type ClassificationResult } from '../lib/classify.ts';
import { extractElsterValues } from '../lib/elster-extract.ts';

const MAX_BYTES = 25 * 1024 * 1024;

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface DocumentMeta {
  uuid: string;
  originalFilename: string;
  mime: string;
  size: number;
  ingestedAt: string;
  /** Path relative to the workspace root, e.g. `inbox/<uuid>.pdf` or `elster/<uuid>.pdf`. */
  currentPath: string;
  /** Mistral Files API id, set after classify; reusable for OCR Run. */
  fileId?: string;
  classification?: {
    label: string;
    confidence: number;
    summary?: string;
    kpis?: Array<{ key: string; value: string }>;
    /** Pass 1 — recommended ELSTER-Anlagen für dieses Dokument. Pass 2
     *  (elster_extract) lädt für genau diese Anlagen den Feldkatalog. */
    recommendedAnlagen?: string[];
    valueCount?: number;
    mistralUsage?: { total_tokens?: number };
    ms?: number;
    classifiedAt: string;
    /** Full raw chat-completion request + response from the upload-time
     *  Mistral Small call. Kept verbatim so the user can audit what the model
     *  actually saw and produced. */
    raw?: {
      request: { model: string; promptText: string; documentUrl: string };
      response: unknown;
    };
  };
  /** Pass 2 — strukturierte ELSTER-Werte mit eCode pro Anlage.
   *  Wird nur gesetzt wenn classification.recommendedAnlagen non-empty war. */
  elsterExtract?: {
    extractedAt: string;
    vz: number;
    anlagen: string[];
    values: Array<{
      elster_code: string;
      value: string;
      anlage: string;
      drucktext?: string;
      vordruckzeile?: string;
    }>;
    perAnlage: Array<{
      anlage: string;
      fieldsInSchema: number;
      valuesReturned: number;
      ms: number;
      tokens?: number;
      error?: string;
    }>;
    totalMs: number;
  };
  template?: {
    source: 'canonical' | 'manual';
    id?: string;
    name?: string;
    schema?: Record<string, unknown>;
    annotationPrompt?: string;
  };
  extraction?: {
    ranAt: string;
    annotation: unknown | null;
    /** Concatenated `pages[].markdown` from the Mistral OCR run. Persisted so the
     *  Werte-Fluss diagnostic can compute "untapped tokens in document". */
    markdown?: string;
    /** Per-page markdown — kept separately from `markdown` so the visual
     *  audit can locate each value to a specific page. */
    pagesMarkdown?: string[];
    pages: number;
    chars: number;
    ms: number;
    model?: string;
    validationIssueCount?: number;
    hallucinationCount?: number;
    usage?: { pagesProcessed: number; docSizeBytes: number | null };
    degradation?: { reason: string; strippedFields: string[] } | null;
  };
  audit?: {
    ranAt: string;
    kind: 'consistency' | 'semantic' | 'visual';
    ms: number;
    totals: { ok: number; warn: number; error: number; total: number };
    findings: Array<{
      source: string;
      kind: string;
      field: string;
      value: string;
      status: string;
      severity: string;
      message: string;
      evidence?: string;
    }>;
  };
  approvedAt?: string;
  /** Audit trail — one entry per significant change. Maps 1:1 to GitChain
   *  commit messages once the per-doc container is wired in. */
  history?: Array<{
    at: string;
    kind: 'ingest' | 'classify' | 'route' | 'template' | 'extract' | 'approve' | 'patch' | 'cleanup' | 'tag';
    source: 'workspace-upload' | 'playground' | 'document-detail' | 'api';
    summary: string;
    /** Structured diff of what changed in this entry — populated for entries
     *  written after this feature lands; older entries have no `change`. */
    change?: HistoryChange;
    /** Marked true by a cleanup op (squash/supersede). Render dimmed; never silently dropped. */
    superseded?: boolean;
  }>;
}

export interface HistoryChange {
  /** Top-level keys added to meta (e.g. ['classification', 'fileId']). */
  added?: string[];
  /** Top-level keys removed (cleared) from meta. */
  removed?: string[];
  /** Field-level modifications. `before`/`after` are stringified summaries, NOT raw values. */
  modified?: Array<{ path: string; before: string | number | null; after: string | number | null }>;
  /** classification-specific: list of new KPI keys. */
  kpisAdded?: string[];
  /** template-specific. */
  schemaSize?: number;
  /** extraction-specific. */
  leavesPopulated?: number;
  flags?: { validation: number; hallucination: number };
  /** cleanup/tag-specific. */
  squashedCount?: number;
  tag?: string;
  targetVersion?: number;
}

// ---------- version + sha derivation (computed, never persisted) ----------

function deriveVersionAndSha(meta: DocumentMeta): { version: number; sha: string } {
  const version = (meta.history ?? []).length;
  // Hash everything except the history array so reordering/squashing history
  // doesn't change the content fingerprint of the doc state itself.
  const { history: _h, ...rest } = meta;
  void _h;
  const sha = createHash('sha256')
    .update(JSON.stringify(rest, Object.keys(rest).sort()))
    .digest('hex')
    .slice(0, 12);
  return { version, sha };
}

function metaWithDerived(meta: DocumentMeta): DocumentMeta & { version: number; sha: string } {
  return { ...meta, ...deriveVersionAndSha(meta) };
}

// ---------- diff computation ----------

function diffApprovedAt(before: DocumentMeta, after: DocumentMeta): HistoryChange | null {
  const b = before.approvedAt ?? null;
  const a = after.approvedAt ?? null;
  if (b === a) return null;
  return { modified: [{ path: 'approvedAt', before: b, after: a }] };
}

function diffClassification(before: DocumentMeta, after: DocumentMeta): HistoryChange | null {
  const b = before.classification;
  const a = after.classification;
  if (!b && a) {
    return {
      added: ['classification'],
      kpisAdded: (a.kpis ?? []).map((k) => k.key),
      modified: [{ path: 'classification.label', before: null, after: a.label }],
    };
  }
  if (b && a && b.label !== a.label) {
    return { modified: [{ path: 'classification.label', before: b.label, after: a.label }] };
  }
  if (b && !a) return { removed: ['classification'] };
  return null;
}

function diffTemplate(before: DocumentMeta, after: DocumentMeta): HistoryChange | null {
  const b = before.template;
  const a = after.template;
  if (!b && a) {
    return {
      added: ['template'],
      schemaSize: countLeaves(a.schema),
      modified: [{ path: 'template.id', before: null, after: a.id ?? a.name ?? a.source }],
    };
  }
  if (b && a && (b.id ?? b.name) !== (a.id ?? a.name)) {
    return {
      schemaSize: countLeaves(a.schema),
      modified: [{ path: 'template.id', before: b.id ?? b.name ?? null, after: a.id ?? a.name ?? null }],
    };
  }
  return null;
}

function diffExtraction(before: DocumentMeta, after: DocumentMeta): HistoryChange | null {
  const b = before.extraction;
  const a = after.extraction;
  if (!a) return b ? { removed: ['extraction'] } : null;
  if (!b || b.ranAt !== a.ranAt) {
    return {
      added: b ? undefined : ['extraction'],
      leavesPopulated: countAnnotationLeaves(a.annotation),
      flags: {
        validation: a.validationIssueCount ?? 0,
        hallucination: a.hallucinationCount ?? 0,
      },
    };
  }
  return null;
}

function countAnnotationLeaves(node: unknown): number {
  if (node == null) return 0;
  if (typeof node !== 'object') return 1;
  if (Array.isArray(node)) return node.reduce<number>((n, c) => n + countAnnotationLeaves(c), 0);
  return Object.values(node as Record<string, unknown>).reduce<number>((n, c) => n + countAnnotationLeaves(c), 0);
}

/** Same as countAnnotationLeaves but only counts truthy non-empty leaves (filled). */
function countAnnotationLeavesShallow(node: unknown): number {
  if (node == null) return 0;
  if (typeof node === 'string') return node.trim().length > 0 ? 1 : 0;
  if (typeof node === 'number' || typeof node === 'boolean') return 1;
  if (Array.isArray(node)) return node.reduce<number>((n, c) => n + countAnnotationLeavesShallow(c), 0);
  if (typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).reduce<number>((n, c) => n + countAnnotationLeavesShallow(c), 0);
  }
  return 0;
}

/**
 * Count value-shaped tokens in OCR markdown that are NOT present in the
 * structured annotation. Pure structural detection — no domain semantics.
 *
 * Detects: dates (DE/ISO), EUR amounts, IBANs, percentages, integer IDs of
 * 5+ digits, multi-word currency lines. Strips the ones already in annotation
 * after light normalization (date format, EUR format, whitespace).
 */
function countUntappedTokens(markdown: string, annotation: unknown): number {
  if (!markdown) return 0;
  const tokens = extractValueTokens(markdown);
  const annotationValues = collectAnnotationValues(annotation).map(normalizeForCompare);
  const annotSet = new Set(annotationValues);
  let untapped = 0;
  const seen = new Set<string>();
  for (const t of tokens) {
    const norm = normalizeForCompare(t);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!annotSet.has(norm)) untapped++;
  }
  return untapped;
}

const TOKEN_PATTERNS = [
  /\b\d{2}\.\d{2}\.(19|20)\d{2}\b/g,                // date DE
  /\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g, // date ISO
  /\b[\d.]+,\d{2}\s*(€|EUR)\b/g,                    // EUR amount
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,             // IBAN
  /\bDE\d{9}\b/g,                                    // USt-IdNr
  /\b\d{11}\b/g,                                     // Steuer-ID
  /\b\d{5,10}\b/g,                                   // generic numeric ID
  /\b\d+([.,]\d+)?\s*%\b/g,                          // percent
];

function extractValueTokens(text: string): string[] {
  const out: string[] = [];
  for (const re of TOKEN_PATTERNS) {
    const matches = text.match(re);
    if (matches) out.push(...matches);
  }
  return out;
}

function collectAnnotationValues(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') { if (node.trim()) out.push(node); return out; }
  if (typeof node === 'number' || typeof node === 'boolean') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const v of node) collectAnnotationValues(v, out); return out; }
  if (typeof node === 'object') { for (const v of Object.values(node as Record<string, unknown>)) collectAnnotationValues(v, out); }
  return out;
}

function normalizeForCompare(v: string): string {
  let s = String(v).trim().toLowerCase();
  // Date DE → ISO
  const de = s.match(/^(\d{2})\.(\d{2})\.((19|20)\d{2})$/);
  if (de) return `${de[3]}-${de[2]}-${de[1]}`;
  // EUR: strip €/EUR/spaces, normalize 1.234,56 → 1234.56
  if (/(€|eur)/.test(s) || /^[\d.]+,\d{2}$/.test(s)) {
    s = s.replace(/€|eur/g, '').replace(/\s/g, '');
    if (/^-?[\d.]+,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  }
  // Strip non-essential whitespace
  return s.replace(/\s+/g, '');
}

function buildChange(before: DocumentMeta, after: DocumentMeta, changedKeys: string[]): HistoryChange {
  // Per-field diffs. We merge them so history.change is one object regardless of how many fields changed.
  const merged: HistoryChange = {};
  const merge = (c: HistoryChange | null) => {
    if (!c) return;
    if (c.added) merged.added = [...(merged.added ?? []), ...c.added];
    if (c.removed) merged.removed = [...(merged.removed ?? []), ...c.removed];
    if (c.modified) merged.modified = [...(merged.modified ?? []), ...c.modified];
    if (c.kpisAdded) merged.kpisAdded = c.kpisAdded;
    if (c.schemaSize !== undefined) merged.schemaSize = c.schemaSize;
    if (c.leavesPopulated !== undefined) merged.leavesPopulated = c.leavesPopulated;
    if (c.flags) merged.flags = c.flags;
  };
  if (changedKeys.includes('classification')) merge(diffClassification(before, after));
  if (changedKeys.includes('template')) merge(diffTemplate(before, after));
  if (changedKeys.includes('extraction')) merge(diffExtraction(before, after));
  if (changedKeys.includes('approvedAt')) merge(diffApprovedAt(before, after));
  // fileId / currentPath: simple before/after if changed
  for (const k of ['fileId', 'currentPath'] as const) {
    if (changedKeys.includes(k) && (before as unknown as Record<string, unknown>)[k] !== (after as unknown as Record<string, unknown>)[k]) {
      merge({
        modified: [{
          path: k,
          before: (before as unknown as Record<string, unknown>)[k] as string ?? null,
          after: (after as unknown as Record<string, unknown>)[k] as string ?? null,
        }],
      });
    }
  }
  return merged;
}

/**
 * Count "leaf" fields in a schema-shaped tree. Tolerates two shapes:
 *
 *   1. Proper JSON Schema: `{ type: 'object', properties: { foo: { type: 'string' } } }`
 *   2. Playground informal: `{ Foo: { string: true } }` or `{ Foo: { Bar: { string: true } } }`
 *      (the mistral-small playground emits this — leaves are `{string|number|boolean: true}`,
 *      branches are bare named objects with no `type` key.)
 *
 * Strategy:
 *   - If proper-schema markers are present, use them.
 *   - Else treat the node as a name-keyed branch and recurse into each value.
 *   - A node with no children but an informal-leaf marker counts as 1.
 */
function countLeaves(node: unknown): number {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
  const n = node as Record<string, unknown> & {
    type?: unknown; properties?: Record<string, unknown>; items?: unknown;
  };

  // Shape 1 — proper JSON Schema
  if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
    let count = 0;
    for (const child of Object.values(n.properties)) {
      count += countLeaves(child) || 1;
    }
    return count;
  }
  if (n.type === 'array' && n.items) return countLeaves(n.items) || 1;
  if (n.type === 'string' || n.type === 'number' || n.type === 'integer' || n.type === 'boolean') return 1;

  // Shape 2 — informal playground leaf marker `{string|number|boolean|integer: true}` (no nested children)
  const informalLeafMarkers = ['string', 'number', 'integer', 'boolean'];
  const keys = Object.keys(n);
  const allLeafMarkers = keys.length > 0 && keys.every((k) => informalLeafMarkers.includes(k) && n[k] === true);
  if (allLeafMarkers) return 1;

  // Otherwise treat as a name-keyed branch — recurse into each child value.
  let count = 0;
  for (const child of Object.values(n)) {
    if (child && typeof child === 'object') count += countLeaves(child);
  }
  return count;
}

const SAFE_SEG = /^[a-zA-Z0-9._-]+$/;
function safeSeg(s: string): string {
  if (!SAFE_SEG.test(s)) throw new Error(`unsafe path segment: ${s}`);
  return s;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'workspace';
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(i).toLowerCase() : '';
}

export interface CanonicalRecord {
  id: string;
  name: string;
  description?: string;
  classificationHints?: string[];
  annotationPrompt?: string;
  schema: Record<string, unknown>;
}

async function loadCanonicals(canonicalsDir: string): Promise<CanonicalRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(canonicalsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: CanonicalRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(canonicalsDir, name), 'utf8');
      const j = JSON.parse(raw) as CanonicalRecord;
      if (j && typeof j.id === 'string' && j.schema) out.push(j);
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function createWorkspacesRouter(workspacesDir: string, canonicalsDir: string): Router {
  const router = Router();
  // Per-request upload dir lives inside the target workspace; multer is set
  // to the system tmp + we move the file into place after we know which
  // workspace + uuid. This keeps multer dumb and avoids dynamic-dest hacks.
  const upload = multer({ dest: path.join(workspacesDir, '.tmp'), limits: { fileSize: MAX_BYTES } });

  const acceptUpload: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next();
      const m = err as { code?: string; message?: string };
      if (m.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: 'file_too_large',
          message: `Datei zu groß. Max ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
          maxBytes: MAX_BYTES,
        });
        return;
      }
      res.status(400).json({ error: 'upload_failed', message: m.message ?? String(err) });
    });
  };

  // -------------------- workspace registry I/O --------------------

  const indexPath = path.join(workspacesDir, 'index.json');

  async function readIndex(): Promise<WorkspaceRecord[]> {
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const j = JSON.parse(raw);
      return Array.isArray(j) ? (j as WorkspaceRecord[]) : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async function writeIndex(records: WorkspaceRecord[]): Promise<void> {
    await fs.mkdir(workspacesDir, { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(records, null, 2));
  }

  async function generateWorkspaceId(name: string, existing: WorkspaceRecord[]): Promise<string> {
    const base = slugify(name);
    if (!existing.some((r) => r.id === base)) return base;
    // Collision — append short suffix from randomUUID.
    for (let i = 0; i < 5; i++) {
      const candidate = `${base}-${randomUUID().slice(0, 6)}`;
      if (!existing.some((r) => r.id === candidate)) return candidate;
    }
    throw new Error('could not generate unique workspace id');
  }

  // -------------------- meta I/O --------------------

  function workspaceRoot(wsId: string): string {
    return path.join(workspacesDir, safeSeg(wsId));
  }

  function metaPath(wsId: string, uuid: string): string {
    return path.join(workspaceRoot(wsId), 'meta', `${safeSeg(uuid)}.json`);
  }

  async function listMetas(wsId: string): Promise<DocumentMeta[]> {
    const dir = path.join(workspaceRoot(wsId), 'meta');
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: DocumentMeta[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8');
        out.push(JSON.parse(raw) as DocumentMeta);
      } catch {
        /* skip malformed */
      }
    }
    return out.sort((a, b) => (a.ingestedAt < b.ingestedAt ? 1 : -1));
  }

  // -------------------- routes --------------------

  router.get('/', async (_req, res) => {
    try {
      const records = await readIndex();
      const enriched = await Promise.all(
        records.map(async (r) => ({
          ...r,
          docCount: (await listMetas(r.id)).length,
        })),
      );
      res.json(enriched);
    } catch (e) {
      res.status(500).json({ error: 'list_failed', message: (e as Error).message });
    }
  });

  router.post('/', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name fehlt' });
      return;
    }
    try {
      const records = await readIndex();
      const id = await generateWorkspaceId(name, records);
      const record: WorkspaceRecord = { id, name, createdAt: new Date().toISOString() };
      await fs.mkdir(path.join(workspaceRoot(id), 'inbox'), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot(id), 'meta'), { recursive: true });
      await writeIndex([...records, record]);
      res.status(201).json(record);
    } catch (e) {
      res.status(500).json({ error: 'create_failed', message: (e as Error).message });
    }
  });

  router.get('/:ws', async (req, res) => {
    try {
      const records = await readIndex();
      const ws = records.find((r) => r.id === req.params.ws);
      if (!ws) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      const docs = await listMetas(ws.id);
      const byClassification: Record<string, number> = { inbox: 0 };
      for (const d of docs) {
        const k = d.classification?.label ?? 'inbox';
        byClassification[k] = (byClassification[k] ?? 0) + 1;
      }
      res.json({ ...ws, docCount: docs.length, byClassification });
    } catch (e) {
      res.status(500).json({ error: 'read_failed', message: (e as Error).message });
    }
  });

  router.post('/:ws/upload', acceptUpload, async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'file fehlt (multipart field "file")' });
      return;
    }
    let wsId: string;
    try {
      wsId = safeSeg(req.params.ws);
    } catch {
      await fs.unlink(req.file.path).catch(() => {});
      res.status(400).json({ error: 'invalid_workspace_id' });
      return;
    }

    const records = await readIndex();
    if (!records.some((r) => r.id === wsId)) {
      await fs.unlink(req.file.path).catch(() => {});
      res.status(404).json({ error: 'workspace_not_found' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    const uuid = randomUUID();
    const ext = extOf(req.file.originalname);
    const inboxRel = path.posix.join('inbox', `${uuid}${ext}`);
    const inboxAbs = path.join(workspaceRoot(wsId), 'inbox', `${uuid}${ext}`);

    let meta: DocumentMeta = {
      uuid,
      originalFilename: req.file.originalname,
      mime: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      ingestedAt: new Date().toISOString(),
      currentPath: inboxRel,
    };

    try {
      // Step 1: ingest — move into inbox/, write sidecar.
      await fs.mkdir(path.dirname(inboxAbs), { recursive: true });
      await fs.rename(req.file.path, inboxAbs);
      await fs.mkdir(path.join(workspaceRoot(wsId), 'meta'), { recursive: true });
      await fs.writeFile(metaPath(wsId, uuid), JSON.stringify(meta, null, 2));
      send('ingested', { uuid, currentPath: inboxRel, originalFilename: meta.originalFilename, size: meta.size });

      // Step 2: classify (only if API key is configured — otherwise stop after ingest).
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) {
        send('classify_skipped', { reason: 'MISTRAL_API_KEY not set' });
        send('done', { uuid, meta });
        res.end();
        return;
      }

      send('classify_started', { uuid });
      const { file_id } = await uploadFile(inboxAbs, meta.originalFilename, { apiKey, signal: ac.signal });
      const { url: signedUrl } = await getFileSignedUrl(file_id, { apiKey, signal: ac.signal });
      const classification: ClassificationResult = await classifyDocument({
        documentUrl: signedUrl,
        apiKey,
        signal: ac.signal,
        mime: meta.mime,
        filename: meta.originalFilename,
      });

      meta = {
        ...meta,
        fileId: file_id,
        classification: {
          label: classification.label,
          confidence: classification.confidence,
          summary: classification.summary,
          kpis: classification.kpis,
          recommendedAnlagen: classification.recommendedAnlagen,
          valueCount: classification.valueCount,
          mistralUsage: { total_tokens: classification.mistralUsage.total_tokens },
          ms: classification.ms,
          classifiedAt: new Date().toISOString(),
          raw: classification.raw,
        },
      };
      await fs.writeFile(metaPath(wsId, uuid), JSON.stringify(meta, null, 2));
      send('classify_done', {
        uuid,
        label: classification.label,
        confidence: classification.confidence,
        summary: classification.summary,
        kpis: classification.kpis,
        recommendedAnlagen: classification.recommendedAnlagen,
        valueCount: classification.valueCount,
        ms: classification.ms,
        tokens: classification.mistralUsage.total_tokens,
      });

      // ─── Step 2.5: Pass 2 — strukturierte ELSTER-Extraktion ─────────────
      // Läuft genau dann wenn Pass 1 mindestens eine Anlage empfohlen hat.
      // Lädt pro Anlage den ELSTER-Feldkatalog und ruft Mistral mit
      // dynamischem JSON-Schema auf — pro Anlage eine eigene Mistral-Anfrage,
      // alle parallel. Werte werden mit elster_code annotiert ans
      // Sidecar geschrieben und an den SSE-Client gestreamt.
      if (classification.recommendedAnlagen.length > 0) {
        send('elster_extract_started', {
          uuid,
          anlagen: classification.recommendedAnlagen,
        });
        try {
          const vz = (() => {
            const m = String(classification.summary ?? '').match(/\b(20\d{2})\b/);
            return m ? Number(m[1]) : new Date().getFullYear() - 1;
          })();
          const extract = await extractElsterValues({
            vz,
            anlagen: classification.recommendedAnlagen,
            documentUrl: signedUrl,
            apiKey,
            signal: ac.signal,
            onAnlageDone: (info) => {
              send('elster_extract_anlage_done', { uuid, ...info });
            },
          });
          meta = {
            ...meta,
            elsterExtract: {
              extractedAt: new Date().toISOString(),
              vz: extract.vz,
              anlagen: classification.recommendedAnlagen,
              values: extract.values,
              perAnlage: extract.perAnlage,
              totalMs: extract.totalMs,
            },
          };
          await fs.writeFile(metaPath(wsId, uuid), JSON.stringify(meta, null, 2));
          send('elster_extract_done', {
            uuid,
            valueCount: extract.values.length,
            anlagenCount: extract.perAnlage.length,
            totalMs: extract.totalMs,
            values: extract.values,
            perAnlage: extract.perAnlage,
          });
        } catch (e) {
          const err = e as Error;
          send('elster_extract_error', { uuid, message: err.message ?? String(err) });
          // Soft-Fail: Pass 2 darf den Upload nicht blockieren — ohne
          // strukturierte ELSTER-Werte fällt der Konsument auf die KPIs
          // aus Pass 1 zurück.
        }
      }

      // Step 3: route — move file from inbox/ to <label>/.
      const label = classification.label;
      const targetRel = path.posix.join(label, `${uuid}${ext}`);
      const targetAbs = path.join(workspaceRoot(wsId), label, `${uuid}${ext}`);
      // Defensive: ensure label resolves inside workspace root.
      if (!path.resolve(targetAbs).startsWith(path.resolve(workspaceRoot(wsId)) + path.sep)) {
        throw new Error(`route: classification label "${label}" escapes workspace`);
      }
      await fs.mkdir(path.dirname(targetAbs), { recursive: true });
      await fs.rename(inboxAbs, targetAbs);
      meta = { ...meta, currentPath: targetRel };
      await fs.writeFile(metaPath(wsId, uuid), JSON.stringify(meta, null, 2));
      send('routed', { uuid, from: inboxRel, to: targetRel, classification: label });

      send('done', { uuid, meta });
      res.end();
    } catch (e) {
      const err = e as Error & { name?: string };
      // Best-effort: leave the file wherever it currently is, so the user can
      // re-classify later. The sidecar already reflects the latest known state.
      if (err?.name === 'AbortError') {
        send('error', { uuid, message: 'aborted by client' });
      } else {
        send('error', { uuid, message: err.message ?? String(err) });
      }
      // Cleanup the multer tmp upload only if rename never happened.
      if (req.file && req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      res.end();
    }
  });

  router.get('/:ws/documents', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      const all = await listMetas(wsId);
      const filter = req.query?.classification;
      const filtered = typeof filter === 'string' && filter
        ? all.filter((d) => (d.classification?.label ?? 'inbox') === filter)
        : all;
      res.json(filtered);
    } catch (e) {
      res.status(500).json({ error: 'list_failed', message: (e as Error).message });
    }
  });

  router.get('/:ws/documents/:uuid', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const uuid = safeSeg(req.params.uuid);
      const raw = await fs.readFile(metaPath(wsId, uuid), 'utf8');
      const meta = JSON.parse(raw) as DocumentMeta;
      res.type('application/json').json(metaWithDerived(meta));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'document_not_found' });
        return;
      }
      res.status(500).json({ error: 'read_failed', message: (e as Error).message });
    }
  });

  router.post('/:ws/documents/:uuid/extract', async (req: Request, res: Response) => {
    let wsId: string, uuid: string;
    try {
      wsId = safeSeg(req.params.ws);
      uuid = safeSeg(req.params.uuid);
    } catch {
      res.status(400).json({ error: 'invalid_path' });
      return;
    }
    const records = await readIndex();
    if (!records.some((r) => r.id === wsId)) {
      res.status(404).json({ error: 'workspace_not_found' });
      return;
    }
    const mp = metaPath(wsId, uuid);
    let meta: DocumentMeta;
    try {
      meta = JSON.parse(await fs.readFile(mp, 'utf8')) as DocumentMeta;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'document_not_found' });
        return;
      }
      throw e;
    }
    const template = meta.template;
    if (!template?.schema) {
      res.status(400).json({ error: 'no_template', message: 'Vorlage fehlt — bitte zuerst ein Template wählen.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) throw new Error('MISTRAL_API_KEY not set on server');

      // Resolve fileId — upload now if missing (e.g. doc ingested before Phase 2).
      let fileId = meta.fileId;
      if (!fileId) {
        const fileAbs = path.join(workspaceRoot(wsId), meta.currentPath);
        const { file_id } = await uploadFile(fileAbs, meta.originalFilename, { apiKey, signal: ac.signal });
        fileId = file_id;
        meta = { ...meta, fileId };
        await fs.writeFile(mp, JSON.stringify(meta, null, 2));
      }

      const { url: signedUrl } = await getFileSignedUrl(fileId, { apiKey, signal: ac.signal });
      const isImage = mimeFromFilename(meta.originalFilename).startsWith('image/');
      const document: DocumentChunk = isImage
        ? { type: 'image_url', image_url: signedUrl }
        : { type: 'document_url', document_url: signedUrl, document_name: meta.originalFilename };

      const cfg: MistralOcrConfig = {
        model: 'mistral-ocr-latest',
        documentAnnotation: {
          schema: template.schema as JsonSchema,
          name: template.name ?? 'extraction',
          prompt: template.annotationPrompt,
        },
      };

      send('extract_started', {
        uuid,
        model: cfg.model,
        templateId: template.id ?? null,
        templateName: template.name ?? null,
      });

      const apiReq = configToApiRequest(cfg, document, { runId: 'workspace', stageId: uuid });
      const t0 = Date.now();
      const { response, degradation } = await callMistralOcrWithFallback(apiReq, { apiKey, signal: ac.signal });
      const parsed = parseApiResponse(response, cfg, t0, degradation);

      const extraction: NonNullable<DocumentMeta['extraction']> = {
        ranAt: new Date().toISOString(),
        annotation: parsed.documentAnnotation,
        markdown: parsed.text,
        pagesMarkdown: parsed.pages.map((p) => p.markdown ?? ''),
        pages: parsed.pages.length,
        chars: parsed.chars,
        ms: parsed.ms,
        model: parsed.model,
        validationIssueCount: parsed.validation.documentAnnotation.length,
        hallucinationCount: parsed.hallucinations.length,
        usage: parsed.usage,
        degradation: parsed.degradation ?? null,
      };
      meta = { ...meta, extraction };
      await fs.writeFile(mp, JSON.stringify(meta, null, 2));

      send('extract_done', {
        uuid,
        annotation: parsed.documentAnnotation,
        pages: parsed.pages.length,
        chars: parsed.chars,
        ms: parsed.ms,
        model: parsed.model,
        validationIssueCount: parsed.validation.documentAnnotation.length,
        hallucinationCount: parsed.hallucinations.length,
        validationSample: parsed.validation.documentAnnotation.slice(0, 5),
        hallucinationSample: parsed.hallucinations.slice(0, 5),
        usage: parsed.usage,
        degradation: parsed.degradation ?? null,
      });
      send('done', { uuid, meta });
      res.end();
    } catch (e) {
      const err = e as Error & { name?: string; status?: number; body?: string };
      if (err?.name === 'AbortError') {
        send('error', { uuid, message: 'aborted by client' });
      } else {
        send('error', { uuid, message: err.message ?? String(err), status: err.status, body: err.body });
      }
      res.end();
    }
  });

  // ========================================================================
  // Pipeline view — derives 6-node status per doc + workspace-level aggregates.
  // Pure projection over meta sidecars; no model calls, no mutation.
  // ========================================================================

  router.get('/:ws/pipeline', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      const ws = records.find((r) => r.id === wsId);
      if (!ws) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      const all = await listMetas(wsId);

      type CellState = 'ok' | 'partial' | 'fail' | 'pending';
      type DocStatus = {
        ingest: { state: CellState; sizeBytes?: number; mime?: string; ingestedAt?: string };
        classify: { state: CellState; label?: string; confidence?: number; kpiCount?: number; tokens?: number; ms?: number; classifiedAt?: string };
        route: { state: CellState; folder?: string };
        template: { state: CellState; source?: string; name?: string; id?: string; schemaSize?: number };
        extract: {
          state: CellState;
          filledCount?: number;
          schemaTotal?: number;
          coveragePct?: number;
          leakage?: number;
          hallucinations?: number;
          model?: string;
          pages?: number;
          ms?: number;
          costEur?: number;
        };
        approve: { state: CellState; at?: string };
      };

      const docStatuses = all.map((d) => {
        const status: DocStatus = {
          ingest: { state: 'ok', sizeBytes: d.size, mime: d.mime, ingestedAt: d.ingestedAt },
          classify: d.classification
            ? {
                state: 'ok',
                label: d.classification.label,
                confidence: d.classification.confidence,
                kpiCount: d.classification.kpis?.length ?? 0,
                tokens: d.classification.mistralUsage?.total_tokens,
                ms: d.classification.ms,
                classifiedAt: d.classification.classifiedAt,
              }
            : { state: 'pending' },
          route: d.classification && d.currentPath && !d.currentPath.startsWith('inbox/')
            ? { state: 'ok', folder: d.currentPath.split('/')[0] }
            : { state: 'pending' },
          template: d.template
            ? {
                state: d.template.source === 'canonical' ? 'ok' : 'partial',
                source: d.template.source,
                name: d.template.name,
                id: d.template.id,
                schemaSize: d.template.schema ? countLeaves(d.template.schema) : undefined,
              }
            : { state: 'pending' },
          extract: { state: 'pending' },
          approve: d.approvedAt ? { state: 'ok', at: d.approvedAt } : { state: 'pending' },
        };

        if (d.extraction && d.template?.schema) {
          const schemaTotal = countLeaves(d.template.schema);
          const filledCount = d.extraction.annotation ? countAnnotationLeavesShallow(d.extraction.annotation) : 0;
          const coveragePct = schemaTotal > 0 ? Math.round((filledCount / schemaTotal) * 100) : 0;
          const leakage = d.extraction.markdown
            ? countUntappedTokens(d.extraction.markdown, d.extraction.annotation)
            : null;
          const hallucinations = d.extraction.hallucinationCount ?? 0;
          const state: CellState =
            coveragePct >= 80 && hallucinations === 0 ? 'ok'
              : coveragePct >= 50 ? 'partial'
              : 'fail';
          const pages = d.extraction.pages ?? 0;
          const classifyTokens = d.classification?.mistralUsage?.total_tokens ?? 0;
          // Per-doc cost estimate (rough): classify-tokens × €0.20/M + extract-pages × €0.001
          const costEur = (classifyTokens / 1_000_000) * 0.20 + pages * 0.001;
          status.extract = {
            state,
            filledCount,
            schemaTotal,
            coveragePct,
            leakage: leakage ?? undefined,
            hallucinations,
            model: d.extraction.model,
            pages,
            ms: d.extraction.ms,
            costEur,
          };
        }

        return {
          uuid: d.uuid,
          filename: d.originalFilename,
          mime: d.mime,
          size: d.size,
          ingestedAt: d.ingestedAt,
          status,
        };
      });

      // Aggregate per node.
      const nodeAgg = (selector: (s: DocStatus) => CellState) => {
        let passed = 0, partial = 0, total = docStatuses.length;
        for (const d of docStatuses) {
          const s = selector(d.status);
          if (s === 'ok') passed++;
          else if (s === 'partial') partial++;
        }
        return { passed, partial, total };
      };

      // ---------- Per-node detailed aggregates ----------

      // Ingest: total bytes + mime breakdown
      const totalBytes = all.reduce((a, d) => a + (d.size ?? 0), 0);
      const mimeBreakdown: Record<string, number> = {};
      for (const d of all) {
        const m = (d.mime ?? 'unknown').split('/')[1] ?? d.mime ?? 'unknown';
        mimeBreakdown[m] = (mimeBreakdown[m] ?? 0) + 1;
      }
      const earliestIngest = all.length > 0
        ? all.reduce((min, d) => (!min || d.ingestedAt < min ? d.ingestedAt : min), all[0].ingestedAt)
        : null;
      const latestIngest = all.length > 0
        ? all.reduce((max, d) => (!max || d.ingestedAt > max ? d.ingestedAt : max), all[0].ingestedAt)
        : null;

      // Classify: confidence + KPI total + token total + latency total
      const classifyConfs = docStatuses
        .map((d) => d.status.classify.confidence)
        .filter((c): c is number => typeof c === 'number');
      const avgClassifyConf = classifyConfs.length > 0
        ? classifyConfs.reduce((a, b) => a + b, 0) / classifyConfs.length
        : null;
      const totalKpis = all.reduce((a, d) => a + (d.classification?.kpis?.length ?? 0), 0);
      const totalClassifyTokens = all.reduce((a, d) => a + (d.classification?.mistralUsage?.total_tokens ?? 0), 0);
      const totalClassifyMs = all.reduce((a, d) => a + (d.classification?.ms ?? 0), 0);
      const distinctLabels = [...new Set(
        all.map((d) => d.classification?.label).filter((l): l is string => !!l),
      )];

      // Route: per-folder breakdown
      const folderBreakdown: Record<string, number> = {};
      for (const d of all) {
        const folder = (d.currentPath ?? 'inbox/').split('/')[0] || 'inbox';
        folderBreakdown[folder] = (folderBreakdown[folder] ?? 0) + 1;
      }

      // Template: source breakdown + canonical usage
      const templateBreakdown = { canonical: 0, playground: 0, manual: 0, none: 0 };
      const canonicalUsage: Record<string, number> = {};
      for (const d of docStatuses) {
        const t = d.status.template;
        if (t.state === 'pending') templateBreakdown.none++;
        else if (t.source === 'canonical') {
          templateBreakdown.canonical++;
          if (t.id) canonicalUsage[t.id] = (canonicalUsage[t.id] ?? 0) + 1;
        }
        else if (t.source === 'playground') templateBreakdown.playground++;
        else templateBreakdown.manual++;
      }

      // Extract: coverage + leakage + tokens + pages + ms + cost
      const extractStats = docStatuses
        .map((d) => d.status.extract)
        .filter((e) => e.state !== 'pending');
      const avgCoverage = extractStats.length > 0
        ? Math.round(extractStats.reduce((a, e) => a + (e.coveragePct ?? 0), 0) / extractStats.length)
        : null;
      const leakageVals = extractStats
        .map((e) => e.leakage)
        .filter((l): l is number => typeof l === 'number');
      const avgLeakage = leakageVals.length > 0
        ? Math.round(leakageVals.reduce((a, b) => a + b, 0) / leakageVals.length)
        : null;
      const totalFilledFields = all.reduce((a, d) => {
        if (!d.extraction?.annotation) return a;
        return a + countAnnotationLeavesShallow(d.extraction.annotation);
      }, 0);
      const totalSchemaFields = all.reduce((a, d) =>
        a + (d.template?.schema && d.extraction ? countLeaves(d.template.schema) : 0), 0);
      const totalUntapped = all.reduce((a, d) =>
        a + (d.extraction?.markdown ? countUntappedTokens(d.extraction.markdown, d.extraction.annotation) : 0), 0);
      const totalExtractPages = all.reduce((a, d) => a + (d.extraction?.pages ?? 0), 0);
      const totalExtractMs = all.reduce((a, d) => a + (d.extraction?.ms ?? 0), 0);
      const totalHallucinations = all.reduce((a, d) => a + (d.extraction?.hallucinationCount ?? 0), 0);

      // Cost estimate (rough; mistral-small ~€0.20/M tok, mistral-ocr ~€0.001/page)
      const totalCostEur =
        (totalClassifyTokens / 1_000_000) * 0.20 +
        totalExtractPages * 0.001;

      // Approve: latest approval + count of approved templates used
      const approvedDocs = all.filter((d) => d.approvedAt);
      const latestApproval = approvedDocs.length > 0
        ? approvedDocs.reduce((max, d) => (!max || (d.approvedAt ?? '') > max ? d.approvedAt ?? '' : max), '')
        : null;
      const approvedTemplates = [...new Set(approvedDocs.map((d) => d.template?.id ?? d.template?.name).filter((x): x is string => !!x))];

      const nodes = [
        {
          id: 'ingest',   name: 'Ingest',   ...nodeAgg((s) => s.ingest.state),
          quality: { kind: 'ingest', totalBytes, mimes: mimeBreakdown, earliestAt: earliestIngest, latestAt: latestIngest },
        },
        {
          id: 'classify', name: 'Classify', ...nodeAgg((s) => s.classify.state),
          quality: {
            kind: 'classify',
            avgConfidence: avgClassifyConf,
            totalKpis,
            totalTokens: totalClassifyTokens,
            totalMs: totalClassifyMs,
            distinctLabels,
          },
        },
        {
          id: 'route',    name: 'Route',    ...nodeAgg((s) => s.route.state),
          quality: { kind: 'route', folders: folderBreakdown },
        },
        {
          id: 'template', name: 'Template', ...nodeAgg((s) => s.template.state),
          quality: { kind: 'template', ...templateBreakdown, canonicalUsage },
        },
        {
          id: 'extract',  name: 'Extract',  ...nodeAgg((s) => s.extract.state),
          quality: {
            kind: 'extract',
            avgCoverage,
            avgLeakage,
            totalFilledFields,
            totalSchemaFields,
            totalUntapped,
            totalPages: totalExtractPages,
            totalMs: totalExtractMs,
            totalHallucinations,
          },
        },
        {
          id: 'approve',  name: 'Approve',  ...nodeAgg((s) => s.approve.state),
          quality: { kind: 'approve', latestAt: latestApproval, distinctTemplates: approvedTemplates },
        },
      ];

      // Workspace-level summary (cost rolls up here too)
      const summary = {
        totalBytes,
        totalKpis,
        totalClassifyTokens,
        totalExtractPages,
        totalCostEur,
      };

      res.json({
        workspace: { id: ws.id, name: ws.name },
        generatedAt: new Date().toISOString(),
        totalDocs: docStatuses.length,
        summary,
        nodes,
        docs: docStatuses,
      });
    } catch (e) {
      res.status(500).json({ error: 'pipeline_failed', message: (e as Error).message });
    }
  });

  router.get('/:ws/master.json', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      const ws = records.find((r) => r.id === wsId);
      if (!ws) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      const all = await listMetas(wsId);
      const approved = all.filter((d) => d.approvedAt);
      // Summary rollups (P1 minimal — richer aggregator deferred to P2).
      const byClassification: Record<string, number> = {};
      for (const d of approved) {
        const k = d.classification?.label ?? 'unklassifiziert';
        byClassification[k] = (byClassification[k] ?? 0) + 1;
      }
      const out = {
        workspace: { id: ws.id, name: ws.name, createdAt: ws.createdAt },
        generatedAt: new Date().toISOString(),
        approvedCount: approved.length,
        totalCount: all.length,
        documents: approved.map((d) => {
          const { version, sha } = deriveVersionAndSha(d);
          return {
            uuid: d.uuid,
            version,
            sha,
            originalFilename: d.originalFilename,
            mime: d.mime,
            size: d.size,
            ingestedAt: d.ingestedAt,
            currentPath: d.currentPath,
            fileId: d.fileId,
            classification: d.classification,
            template: d.template ? {
              source: d.template.source,
              id: d.template.id,
              name: d.template.name,
            } : undefined,
            extraction: d.extraction,
            approvedAt: d.approvedAt,
            history: d.history,
          };
        }),
        summary: { byClassification },
      };
      // Allow inline view + download with a sensible default filename.
      if (req.query?.download) {
        res.setHeader('Content-Disposition', `attachment; filename="${ws.id}-master.json"`);
      }
      res.type('application/json').send(JSON.stringify(out, null, 2));
    } catch (e) {
      res.status(500).json({ error: 'master_json_failed', message: (e as Error).message });
    }
  });

  router.post('/:ws/documents/:uuid/audit', async (req: Request, res: Response) => {
    let wsId: string, uuid: string;
    try { wsId = safeSeg(req.params.ws); uuid = safeSeg(req.params.uuid); }
    catch { res.status(400).json({ error: 'invalid_path' }); return; }
    const records = await readIndex();
    if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
    const mp = metaPath(wsId, uuid);
    let meta: DocumentMeta;
    try { meta = JSON.parse(await fs.readFile(mp, 'utf8')) as DocumentMeta; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { res.status(404).json({ error: 'document_not_found' }); return; }
      throw e;
    }
    const kind = (req.body?.kind ?? 'consistency') as 'consistency' | 'semantic' | 'visual';
    if (!['consistency', 'semantic', 'visual'].includes(kind)) {
      res.status(400).json({ error: 'invalid_kind', message: 'kind must be consistency|semantic|visual' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      const apiKey = process.env.MISTRAL_API_KEY;
      const needsKey = kind === 'semantic' || kind === 'visual';
      if (needsKey && !apiKey) throw new Error('MISTRAL_API_KEY not set on server');

      send('audit_started', { uuid, kind });

      // Visual audit IS the vision pass: if no per-page OCR text exists yet,
      // run mistral-ocr-latest on the file (no schema, just text) and persist
      // the result. The audit then compares values against what the eye sees,
      // independent of any prior Extract.
      if (kind === 'visual' && !(meta.extraction?.pagesMarkdown && meta.extraction.pagesMarkdown.length > 0)) {
        send('visual_ocr_started', { uuid, model: 'mistral-ocr-latest' });
        let fileId = meta.fileId;
        if (!fileId) {
          const fileAbs = path.join(workspaceRoot(wsId), meta.currentPath);
          const { file_id } = await uploadFile(fileAbs, meta.originalFilename, { apiKey: apiKey!, signal: ac.signal });
          fileId = file_id;
          meta = { ...meta, fileId };
          await fs.writeFile(mp, JSON.stringify(meta, null, 2));
        }
        const { url: signedUrl } = await getFileSignedUrl(fileId, { apiKey: apiKey!, signal: ac.signal });
        const isImage = mimeFromFilename(meta.originalFilename).startsWith('image/');
        const document: DocumentChunk = isImage
          ? { type: 'image_url', image_url: signedUrl }
          : { type: 'document_url', document_url: signedUrl, document_name: meta.originalFilename };
        const cfg: MistralOcrConfig = { model: 'mistral-ocr-latest' };
        const apiReq = configToApiRequest(cfg, document, { runId: 'workspace-audit', stageId: uuid });
        const t0 = Date.now();
        const { response, degradation } = await callMistralOcrWithFallback(apiReq, { apiKey: apiKey!, signal: ac.signal });
        const parsed = parseApiResponse(response, cfg, t0, degradation);
        const prev = meta.extraction;
        meta = {
          ...meta,
          extraction: {
            ranAt: prev?.ranAt ?? new Date().toISOString(),
            annotation: prev?.annotation,
            markdown: parsed.text,
            pagesMarkdown: parsed.pages.map((p) => p.markdown ?? ''),
            pages: parsed.pages.length,
            chars: parsed.chars,
            ms: parsed.ms,
            model: parsed.model,
            validationIssueCount: prev?.validationIssueCount ?? 0,
            hallucinationCount: prev?.hallucinationCount ?? 0,
            usage: parsed.usage,
            degradation: parsed.degradation ?? null,
          },
        };
        await fs.writeFile(mp, JSON.stringify(meta, null, 2));
        send('visual_ocr_done', { uuid, pages: parsed.pages.length, chars: parsed.chars, ms: parsed.ms });
      }

      const { runAudit } = await import('../lib/audit.ts');
      const report = await runAudit(meta, { apiKey: apiKey ?? '', kind, signal: ac.signal });

      // Persist on meta + history.
      meta = {
        ...meta,
        audit: {
          ranAt: report.ranAt,
          kind,
          ms: report.ms,
          totals: report.totals,
          findings: report.findings as NonNullable<DocumentMeta['audit']>['findings'],
        },
        history: [
          ...(meta.history ?? []),
          {
            at: report.ranAt,
            kind: 'patch',
            source: 'document-detail',
            summary: `audit (${kind}): ${report.totals.ok} ok · ${report.totals.warn} warn · ${report.totals.error} error`,
          },
        ],
      };
      await fs.writeFile(mp, JSON.stringify(meta, null, 2));

      send('audit_done', { uuid, report });
      send('done', { uuid });
      res.end();
    } catch (e) {
      const err = e as Error & { name?: string };
      if (err?.name === 'AbortError') send('error', { uuid, message: 'aborted by client' });
      else send('error', { uuid, message: err.message ?? String(err) });
      res.end();
    }
  });

  router.get('/:ws/canonicals', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      const canonicals = await loadCanonicals(canonicalsDir);
      // Lightweight list: omit full schema by default (schema is large; fetched per-id below).
      const slim = canonicals.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        classificationHints: c.classificationHints ?? [],
        propCount: countLeaves(c.schema),
      }));
      res.json(slim);
    } catch (e) {
      res.status(500).json({ error: 'list_failed', message: (e as Error).message });
    }
  });

  router.get('/:ws/canonicals/:id(*)', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      const id = req.params.id;
      const canonicals = await loadCanonicals(canonicalsDir);
      const found = canonicals.find((c) => c.id === id);
      if (!found) {
        res.status(404).json({ error: 'canonical_not_found' });
        return;
      }
      res.json(found);
    } catch (e) {
      res.status(500).json({ error: 'read_failed', message: (e as Error).message });
    }
  });

  router.patch('/:ws/documents/:uuid', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const uuid = safeSeg(req.params.uuid);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      const mp = metaPath(wsId, uuid);
      let meta: DocumentMeta;
      try {
        meta = JSON.parse(await fs.readFile(mp, 'utf8')) as DocumentMeta;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: 'document_not_found' });
          return;
        }
        throw e;
      }

      const body = (req.body ?? {}) as Partial<DocumentMeta> & {
        source?: string;
        summary?: string;
        historyOp?: 'supersede' | 'squash' | 'tag';
        target?: number;
        range?: [number, number];
        name?: string;
      };
      const source = (body.source ?? 'api') as 'workspace-upload' | 'playground' | 'document-detail' | 'api';

      // ---------- historyOp branch: cleanup ops never mutate meta data fields ----------
      if (body.historyOp) {
        const hist = meta.history ?? [];
        if (body.historyOp === 'supersede') {
          const t = body.target;
          if (typeof t !== 'number' || t < 0 || t >= hist.length) {
            res.status(400).json({ error: 'invalid_target', message: `target must be a valid history index 0..${hist.length - 1}` });
            return;
          }
          hist[t] = { ...hist[t], superseded: true };
          meta.history = [
            ...hist,
            {
              at: new Date().toISOString(),
              kind: 'cleanup',
              source,
              summary: `superseded entry @ index ${t} (${hist[t].kind})`,
            },
          ];
        } else if (body.historyOp === 'squash') {
          const r = body.range;
          if (!Array.isArray(r) || r.length !== 2 || r[0] < 0 || r[1] >= hist.length || r[0] > r[1]) {
            res.status(400).json({ error: 'invalid_range', message: `range must be [start,end] within 0..${hist.length - 1}` });
            return;
          }
          const kindsInRange: string[] = [];
          for (let i = r[0]; i <= r[1]; i++) {
            kindsInRange.push(hist[i].kind);
            hist[i] = { ...hist[i], superseded: true };
          }
          meta.history = [
            ...hist,
            {
              at: new Date().toISOString(),
              kind: 'cleanup',
              source,
              summary: `squashed ${r[1] - r[0] + 1} entries: ${[...new Set(kindsInRange)].join(', ')}`,
              change: { squashedCount: r[1] - r[0] + 1 },
            },
          ];
        } else if (body.historyOp === 'tag') {
          const tagName = (body.name ?? '').trim();
          if (!tagName) {
            res.status(400).json({ error: 'tag_name_required' });
            return;
          }
          meta.history = [
            ...(meta.history ?? []),
            {
              at: new Date().toISOString(),
              kind: 'tag',
              source,
              summary: tagName,
              change: { tag: tagName, targetVersion: body.target ?? hist.length },
            },
          ];
        }
        await fs.writeFile(mp, JSON.stringify(meta, null, 2));
        res.json(metaWithDerived(meta));
        return;
      }

      // ---------- regular meta-patch branch ----------
      // Snapshot for diff computation (deep clone via JSON round-trip — safe for our small meta shape).
      const before = JSON.parse(JSON.stringify(meta)) as DocumentMeta;

      // Allow-list the patchable fields. uuid/originalFilename/ingestedAt are immutable.
      const allowed: Array<keyof DocumentMeta> = [
        'classification', 'template', 'extraction', 'approvedAt', 'fileId', 'currentPath',
      ];
      const changed: string[] = [];
      const metaWritable = meta as unknown as Record<string, unknown>;
      for (const k of allowed) {
        if (body[k] !== undefined) {
          metaWritable[k] = body[k] as unknown;
          changed.push(k);
        }
      }

      if (changed.length === 0) {
        res.status(400).json({ error: 'nothing_to_patch', message: 'PATCH body must include at least one of: ' + allowed.join(', ') });
        return;
      }

      // Build a short summary if the caller didn't supply one.
      let summary = body.summary;
      if (!summary) {
        const parts: string[] = [];
        if (changed.includes('classification') && meta.classification) {
          parts.push(`classification=${meta.classification.label}`);
        }
        if (changed.includes('template') && meta.template) {
          parts.push(`template=${meta.template.name ?? meta.template.id ?? meta.template.source}`);
        }
        if (changed.includes('extraction') && meta.extraction) {
          parts.push(`extract=${meta.extraction.pages}p/${meta.extraction.chars}c`);
        }
        if (changed.includes('approvedAt')) parts.push('approved');
        summary = parts.length > 0 ? parts.join(' · ') : `patched ${changed.join(',')}`;
      }

      // Determine the most representative kind for this patch (first matching key).
      const kindMap: Record<string, NonNullable<DocumentMeta['history']>[number]['kind']> = {
        classification: 'classify',
        template: 'template',
        extraction: 'extract',
        approvedAt: 'approve',
      };
      const kind = (Object.keys(kindMap).find((k) => changed.includes(k)) as keyof typeof kindMap | undefined)
        ? kindMap[Object.keys(kindMap).find((k) => changed.includes(k)) as string]
        : 'patch';

      const change = buildChange(before, meta, changed);

      meta.history = [
        ...(meta.history ?? []),
        { at: new Date().toISOString(), kind, source, summary, change },
      ];

      await fs.writeFile(mp, JSON.stringify(meta, null, 2));
      res.json(metaWithDerived(meta));
    } catch (e) {
      res.status(500).json({ error: 'patch_failed', message: (e as Error).message });
    }
  });

  router.post('/:ws/documents/:uuid/template', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const uuid = safeSeg(req.params.uuid);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      const mp = metaPath(wsId, uuid);
      let meta: DocumentMeta;
      try {
        meta = JSON.parse(await fs.readFile(mp, 'utf8')) as DocumentMeta;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: 'document_not_found' });
          return;
        }
        throw e;
      }

      const body = (req.body ?? {}) as {
        canonicalId?: string;
        schema?: Record<string, unknown>;
        name?: string;
        annotationPrompt?: string;
      };

      let template: NonNullable<DocumentMeta['template']> & {
        schema?: Record<string, unknown>;
        annotationPrompt?: string;
      };

      if (body.canonicalId) {
        const canonicals = await loadCanonicals(canonicalsDir);
        const c = canonicals.find((x) => x.id === body.canonicalId);
        if (!c) {
          res.status(400).json({ error: 'canonical_not_found' });
          return;
        }
        template = {
          source: 'canonical',
          id: c.id,
          name: c.name,
          schema: c.schema,
          annotationPrompt: c.annotationPrompt,
        };
      } else if (body.schema && typeof body.schema === 'object') {
        template = {
          source: 'manual',
          name: body.name ?? 'manual',
          schema: body.schema,
          annotationPrompt: body.annotationPrompt,
        };
      } else {
        res.status(400).json({ error: 'provide canonicalId or {schema, name}' });
        return;
      }

      meta = { ...meta, template };
      await fs.writeFile(mp, JSON.stringify(meta, null, 2));
      res.json(meta);
    } catch (e) {
      res.status(500).json({ error: 'template_failed', message: (e as Error).message });
    }
  });

  router.get('/:ws/documents/:uuid/file', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const uuid = safeSeg(req.params.uuid);
      const raw = await fs.readFile(metaPath(wsId, uuid), 'utf8');
      const meta = JSON.parse(raw) as DocumentMeta;
      const abs = path.join(workspaceRoot(wsId), meta.currentPath);
      // Defensive: ensure resolved path stays inside the workspace root.
      const wsRoot = workspaceRoot(wsId);
      if (!path.resolve(abs).startsWith(path.resolve(wsRoot) + path.sep)) {
        res.status(400).json({ error: 'path_escape' });
        return;
      }
      res.type(meta.mime || 'application/octet-stream').sendFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'document_not_found' });
        return;
      }
      res.status(500).json({ error: 'read_failed', message: (e as Error).message });
    }
  });

  return router;
}
