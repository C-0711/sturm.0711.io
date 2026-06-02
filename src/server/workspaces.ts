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
import { ocrDocumentFromFile } from '../lib/ocr.ts';
import { extractElsterValues } from '../lib/elster-extract.ts';
import {
  loadPipelines,
  getBinding,
  setBinding,
  deleteBinding,
  resolvePipeline,
  classifyLabelToCanonical,
  type PipelineBinding,
} from '../lib/pipeline-loader.ts';
import type { JobRunner } from '../lib/job-runner.ts';
import type { JobKind, JobInputs } from '../lib/job-types.ts';
import { lazyMigrateWorkspace, computeWorkspaceVerlaufHash, ensureDocHistoryHashed } from '../lib/verlauf-hasher.ts';
import { signMaster, verifyMaster, resolveMasterKey } from '../lib/master-signer.ts';
import { getSnapshot, setSnapshot, getLatestHash, readLog } from '../lib/snapshot-store.ts';
import {
  emitWebhookEvent,
  addSubscriber,
  listSubscribers,
  deleteSubscriber,
  readEventLog,
  readDeliveries,
} from '../lib/webhooks.ts';

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
  /** Persisted PRE-OCR (mistral-ocr-latest) result, used by Pass 2 (extract)
   *  and visual-audit. Set after the OCR step succeeds. */
  ocr?: {
    markdown: string;
    pages: Array<{ index: number; chars: number }>;
    charCount: number;
    ms: number;
    pagesProcessed: number;
  };
  classification?: {
    label: string;
    confidence: number;
    summary?: string;
    kpis?: Array<{
      key: string;
      value: string;
      from?: 'mistral' | 'claude-haiku-merge' | 'manual' | 'structural-rescue';
      /** Phase H: pointer auf die Quelle im OCR-Text. null = uncitable (potential hallucination). */
      citation?: {
        page?: number;
        charOffset: number;
        length: number;
        evidence: string;
        confidence: 'verbatim' | 'normalized' | 'partial';
        matchedText: string;
      } | null;
    }>;
    /** Per-key conflicts that need human resolution — set when Mistral and
     *  Claude disagreed on the same field. Cleared once user picks a winner. */
    conflicts?: Array<{ key: string; mistralValue: string; claudeValue: string; claudeKey: string }>;
    valueCount?: number;
    mistralUsage?: { total_tokens?: number };
    ms?: number;
    classifiedAt: string;
    /** Phase B: resolved triple from pipeline.classifications[] at upload-time.
     *  Persisted so a later pipeline-version migration does not silently rename
     *  folders. UI uses displayName for chips, filesystem uses folderSlug. */
    templateId?: string;
    folderSlug?: string;
    displayName?: string;
    /** Full raw chat-completion request + response from the upload-time
     *  Mistral Small call. Kept verbatim so the user can audit what the model
     *  actually saw and produced. */
    raw?: {
      request: { model: string; promptText: string; documentUrl?: string; markdownLen?: number };
      response: unknown;
    };
    /** Pass 1 — empfohlene ELSTER-Anlagen für dieses Dokument. Pass 2
     *  (elster-extract) lädt für genau diese Anlagen den Feldkatalog. */
    recommendedAnlagen?: string[];
  };
  /** Pass 2 — strukturierte ELSTER-Werte mit eCode pro Anlage. Wird gesetzt
   *  wenn classification.recommendedAnlagen non-empty war. */
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
    kind: 'consistency' | 'semantic' | 'visual' | 'vision' | 'structural';
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
  /** Independent second-opinion extractions, keyed by model. Stored verbatim;
   *  no comparison logic — the user inspects them side-by-side and judges. */
  crossModel?: {
    claudeHaiku?: {
      ranAt: string;
      model: string;
      label: string;
      confidence: number;
      summary: string;
      kpis: Array<{ key: string; value: string }>;
      valueCount: number;
      ms: number;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
  };
  approvedAt?: string;
  /** Phase H+: client-side OCR-Bboxes pro Page (Tesseract.js).
   *  Persistiert nach erstem Run für instant-load beim 2. Aufruf. */
  bboxes?: {
    generatedAt: string;
    engine: 'tesseract.js' | 'mistral-ocr' | 'manual';
    /** Gemessene Render-Dimensions (für Pixel-Mapping). */
    pageDimensions?: Array<{ page: number; width: number; height: number }>;
    /** Pro Page eine Liste von Word-Bboxes in Pixeln. */
    pages: Array<{
      page: number;
      words: Array<{ text: string; x: number; y: number; w: number; h: number; confidence?: number }>;
    }>;
  };
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

/** Standalone catalog router for pipeline definitions, mounted at /api/pipelines.
 *  Pipelines are not workspace-scoped — they're shared definitions. */
export function createPipelinesRouter(pipelinesDir: string): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    try {
      const pipelines = await loadPipelines(pipelinesDir);
      res.json(pipelines.map((p) => ({
        id: p.id,
        version: p.version,
        displayName: p.displayName,
        description: p.description,
        nodeCount: p.nodes.length,
        classificationCount: p.classifications?.length ?? 0,
      })));
    } catch (e) {
      res.status(500).json({ error: 'pipelines_failed', message: (e as Error).message });
    }
  });
  router.get('/:id/:version', async (req, res) => {
    try {
      const id = safeSeg(req.params.id);
      const version = safeSeg(req.params.version);
      const pipelines = await loadPipelines(pipelinesDir);
      const found = pipelines.find((p) => p.id === id && p.version === version);
      if (!found) { res.status(404).json({ error: 'pipeline_not_found', id, version }); return; }
      res.json(found);
    } catch (e) {
      res.status(500).json({ error: 'pipeline_failed', message: (e as Error).message });
    }
  });
  return router;
}

export function createWorkspacesRouter(workspacesDir: string, canonicalsDir: string, pipelinesDir: string, jobRunner?: JobRunner, masterKeyResolver?: () => Promise<string>): Router {
  const router = Router();
  // Lazy-cached HMAC key (resolved once on first master.json request).
  let cachedMasterKey: string | null = null;
  const getMasterKey = async (): Promise<string> => {
    if (cachedMasterKey) return cachedMasterKey;
    cachedMasterKey = masterKeyResolver ? await masterKeyResolver() : await resolveMasterKey(path.dirname(workspacesDir));
    return cachedMasterKey;
  };
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
    // Optional: deterministischer Slug fuer idempotente Calls aus externen
    // Systemen (cb-chat Auto-Anlage). Wenn der Slug schon existiert, geben
    // wir 200 + bestehenden Datensatz mit reused:true zurueck statt einen
    // neuen mit -<hash>-Suffix anzulegen. Wenn nicht angegeben, faellt
    // das Verhalten auf den klassischen Auto-Slugify-Pfad zurueck.
    const slugRaw = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
    try {
      const records = await readIndex();
      let id: string;
      if (slugRaw) {
        const desired = slugify(slugRaw);
        if (!desired) { res.status(400).json({ error: 'slug ungueltig' }); return; }
        const existing = records.find((r) => r.id === desired);
        if (existing) {
          res.status(200).json({ ...existing, reused: true });
          return;
        }
        id = desired;
      } else {
        id = await generateWorkspaceId(name, records);
      }
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
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

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

      // Step 2a: PRE-OCR via /v1/ocr (mistral-ocr-latest) — pure markdown.
      // Spart Files-API-Upload + Signed-URL und beschleunigt anschliessende
      // Mistral-Small-Calls drastisch (kein interner OCR pro Anlage mehr).
      send('ocr_started', { uuid });
      const ocrResult = await ocrDocumentFromFile({
        filePath: inboxAbs,
        apiKey,
        signal: ac.signal,
        tableFormat: 'markdown',
      });
      send('ocr_done', {
        uuid,
        pages: ocrResult.pages.length,
        chars: ocrResult.charCount,
        ms: ocrResult.ms,
      });

      // Step 2b: Klassifikation gegen das OCR-Markdown — mistral-small-latest
      // ohne document_url, daher kein interner OCR-Pass mehr.
      send('classify_started', { uuid });
      const classification: ClassificationResult = await classifyDocument({
        markdown: ocrResult.markdown,
        apiKey,
        signal: ac.signal,
      });
      // Legacy-Variablen damit nachfolgender Code (file_id, signedUrl) weiter
      // kompiliert. Beide werden jetzt nicht mehr verwendet — Pass-2 nutzt
      // markdown statt signedUrl.
      const file_id = '';
      const signedUrl = '';

      // Resolve the workspace's pipeline binding to the controlled-vocabulary
      // {templateId, folderSlug, displayName} triple. If the bound pipeline
      // declares a classification matching the raw mistral label, we route to
      // its folderSlug and persist the triple. Otherwise (no binding, or no
      // matching classification) we fall back to the legacy raw-label routing.
      const pipelines = await loadPipelines(pipelinesDir);
      const binding = await getBinding(workspacesDir, wsId);
      const pipeline = resolvePipeline(pipelines, binding);
      const matchedClassif = classifyLabelToCanonical(pipeline, classification.label);

      meta = {
        ...meta,
        fileId: file_id,
        ocr: {
          markdown: ocrResult.markdown,
          pages: ocrResult.pages.map((p) => ({ index: p.index, chars: p.markdown.length })),
          charCount: ocrResult.charCount,
          ms: ocrResult.ms,
          pagesProcessed: ocrResult.pagesProcessed,
        },
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
          // Phase B: persist the resolved triple at upload-time so a later
          // pipeline-version migration does not silently rename folders.
          templateId: matchedClassif?.templateId,
          folderSlug: matchedClassif?.folderSlug,
          displayName: matchedClassif?.displayName,
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
        ocr_ms: ocrResult.ms,
        ocr_chars: ocrResult.charCount,
        tokens: classification.mistralUsage.total_tokens,
        templateId: matchedClassif?.templateId,
        folderSlug: matchedClassif?.folderSlug,
        displayName: matchedClassif?.displayName,
      });

      // ─── Step 2.5: Pass 2 — strukturierte ELSTER-Extraktion ─────────────
      // Läuft genau dann wenn Pass 1 mindestens eine ELSTER-Anlage empfohlen
      // hat. Lädt pro Anlage den ELSTER-Feldkatalog (workflows/elster/data/<vz>/
      // felder/<anlage>.json) und ruft Mistral pro Anlage parallel mit
      // dynamischem JSON-Schema auf. Werte werden mit elster_code annotiert
      // ans Sidecar geschrieben und an den SSE-Client gestreamt.
      // Phase A (cb-ctax): Pass 2 ist standardmäßig DEAKTIVIERT. STURM
      // läuft nur Pass 1 (Mistral-Small classify + KPI-Extraktion).
      // Aktivierung: STURM_PASS_2_ENABLED=1 (Phase B).
      const pass2Enabled = process.env.STURM_PASS_2_ENABLED === '1';
      if (pass2Enabled && classification.recommendedAnlagen.length > 0) {
        send('elster_extract_started', {
          uuid,
          anlagen: classification.recommendedAnlagen,
        });
        try {
          // Steuerjahr: aus Summary (z.B. "Lohnsteuerbescheinigung 2024") oder
          // Vorjahr als Default. Pass 2 muss VZ kennen, um den richtigen
          // Feldkatalog (data/<vz>/felder/) zu laden.
          const vz = (() => {
            const m = String(classification.summary ?? '').match(/\b(20\d{2})\b/);
            return m ? Number(m[1]) : new Date().getFullYear() - 1;
          })();
          const extract = await extractElsterValues({
            vz,
            anlagen: classification.recommendedAnlagen,
            markdown: ocrResult.markdown,
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
      // Webhook: document.classified
      void emitWebhookEvent(workspacesDir, wsId, {
        type: 'document.classified',
        pipeline: { id: pipeline.id, version: pipeline.version },
        data: {
          docUuid: uuid,
          filename: meta.originalFilename,
          label: classification.label,
          confidence: classification.confidence,
          kpiCount: classification.kpis.length,
          templateId: matchedClassif?.templateId,
          folderSlug: matchedClassif?.folderSlug,
          displayName: matchedClassif?.displayName,
        },
      });

      // Step 3: route — move file from inbox/ to <folderSlug>/ (Pipeline)
      // or <label>/ (Fallback wenn keine Pipeline-Klassifikation matched).
      const routeFolder = matchedClassif?.folderSlug ?? classification.label;
      const targetRel = path.posix.join(routeFolder, `${uuid}${ext}`);
      const targetAbs = path.join(workspaceRoot(wsId), routeFolder, `${uuid}${ext}`);
      // Defensive: ensure label/slug resolves inside workspace root.
      if (!path.resolve(targetAbs).startsWith(path.resolve(workspaceRoot(wsId)) + path.sep)) {
        throw new Error(`route: classification "${routeFolder}" escapes workspace`);
      }
      await fs.mkdir(path.dirname(targetAbs), { recursive: true });
      await fs.rename(inboxAbs, targetAbs);
      meta = { ...meta, currentPath: targetRel };
      await fs.writeFile(metaPath(wsId, uuid), JSON.stringify(meta, null, 2));
      send('routed', {
        uuid,
        from: inboxRel,
        to: targetRel,
        classification: classification.label,
        folderSlug: matchedClassif?.folderSlug,
        displayName: matchedClassif?.displayName,
      });

      // Phase H: automatisch Citations-Job nachschießen (asynchron, blockt upload nicht).
      // Findet alle KPI-Werte im OCR-Text und persistiert {page, charOffset, evidence,
      // confidence} pro KPI. Lazy-OCR im Job wenn nötig.
      if (jobRunner) {
        void jobRunner.enqueue({
          workspaceId: wsId,
          kind: 'citations',
          inputs: { docUuids: [uuid] },
          pipelineRef: `${pipeline.id}@${pipeline.version}`,
          createdBy: 'auto-after-classify',
        });
      }

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

  // Re-run classification on an existing document — useful after the prompt
  // changes (e.g. removed KPI cap). Replaces meta.classification in place.
  router.post('/:ws/documents/:uuid/reclassify', async (req: Request, res: Response) => {
    let wsId: string, uuid: string;
    try { wsId = safeSeg(req.params.ws); uuid = safeSeg(req.params.uuid); }
    catch { res.status(400).json({ error: 'invalid_path' }); return; }
    const mp = metaPath(wsId, uuid);
    let meta: DocumentMeta;
    try { meta = JSON.parse(await fs.readFile(mp, 'utf8')) as DocumentMeta; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { res.status(404).json({ error: 'document_not_found' }); return; }
      throw e;
    }
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) { res.status(500).json({ error: 'no_api_key' }); return; }
    try {
      let fileId = meta.fileId;
      if (!fileId) {
        const fileAbs = path.join(workspaceRoot(wsId), meta.currentPath);
        const { file_id } = await uploadFile(fileAbs, meta.originalFilename, { apiKey });
        fileId = file_id;
      }
      const { url: signedUrl } = await getFileSignedUrl(fileId, { apiKey });
      const cls = await classifyDocument({ documentUrl: signedUrl, apiKey });
      // Phase B: resolve controlled-vocabulary triple via the workspace's
      // pipeline binding. Used here for backfill on existing docs.
      const pipelines2 = await loadPipelines(pipelinesDir);
      const binding2 = await getBinding(workspacesDir, wsId);
      const pipeline2 = resolvePipeline(pipelines2, binding2);
      const matched2 = classifyLabelToCanonical(pipeline2, cls.label);
      meta = {
        ...meta,
        fileId,
        classification: {
          label: cls.label, confidence: cls.confidence, summary: cls.summary,
          kpis: cls.kpis, valueCount: cls.valueCount, ms: cls.ms, classifiedAt: new Date().toISOString(),
          mistralUsage: cls.mistralUsage, raw: cls.raw,
          templateId: matched2?.templateId,
          folderSlug: matched2?.folderSlug,
          displayName: matched2?.displayName,
        },
        history: [...(meta.history ?? []), {
          at: new Date().toISOString(), kind: 'patch', source: 'document-detail',
          summary: `re-classify: ${cls.kpis.length} KPIs (vs vorher), label=${cls.label} conf=${cls.confidence}${matched2 ? ` → ${matched2.displayName}` : ''}`,
        }],
      };
      await fs.writeFile(mp, JSON.stringify(meta, null, 2));
      res.json({
        kpis: cls.kpis.length,
        valueCount: cls.valueCount,
        label: cls.label,
        confidence: cls.confidence,
        templateId: matched2?.templateId,
        folderSlug: matched2?.folderSlug,
        displayName: matched2?.displayName,
      });
    } catch (e) {
      res.status(500).json({ error: 'reclassify_failed', message: (e as Error).message });
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
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

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
      // Webhook: document.extracted
      void emitWebhookEvent(workspacesDir, wsId, {
        type: 'document.extracted',
        data: {
          docUuid: uuid,
          filename: meta.originalFilename,
          templateId: meta.template?.id,
          pages: parsed.pages.length,
          chars: parsed.chars,
          validationIssueCount: parsed.validation.documentAnnotation.length,
          hallucinationCount: parsed.hallucinations.length,
        },
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
        classify: { state: CellState; label?: string; displayName?: string; confidence?: number; kpiCount?: number; tokens?: number; ms?: number; classifiedAt?: string };
        route: { state: CellState; folder?: string; displayName?: string };
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
                displayName: d.classification.displayName,
                confidence: d.classification.confidence,
                kpiCount: d.classification.kpis?.length ?? 0,
                tokens: d.classification.mistralUsage?.total_tokens,
                ms: d.classification.ms,
                classifiedAt: d.classification.classifiedAt,
              }
            : { state: 'pending' },
          route: d.classification && d.currentPath && !d.currentPath.startsWith('inbox/')
            ? { state: 'ok', folder: d.currentPath.split('/')[0], displayName: d.classification.displayName }
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

      // ---------- Pipeline-Definition + Binding (deklarativ) ----------
      // The pipeline structure is no longer hardcoded — it comes from
      // pipelines-seed/<id>@<version>.json via the workspace's binding.json
      // (or default@v0 fallback). Quality aggregators dispatch by `kind`.
      const pipelines = await loadPipelines(pipelinesDir);
      const binding = await getBinding(workspacesDir, wsId);
      const pipeline = resolvePipeline(pipelines, binding);

      // Per-kind quality blocks (referentially pure — order-independent).
      const qualityByKind: Record<string, () => Record<string, unknown>> = {
        ingest: () => ({ kind: 'ingest', totalBytes, mimes: mimeBreakdown, earliestAt: earliestIngest, latestAt: latestIngest }),
        classify: () => ({
          kind: 'classify',
          avgConfidence: avgClassifyConf,
          totalKpis,
          totalTokens: totalClassifyTokens,
          totalMs: totalClassifyMs,
          distinctLabels,
        }),
        route: () => ({ kind: 'route', folders: folderBreakdown }),
        template: () => ({ kind: 'template', ...templateBreakdown, canonicalUsage }),
        extract: () => ({
          kind: 'extract',
          avgCoverage,
          avgLeakage,
          totalFilledFields,
          totalSchemaFields,
          totalUntapped,
          totalPages: totalExtractPages,
          totalMs: totalExtractMs,
          totalHallucinations,
        }),
        approve: () => ({ kind: 'approve', latestAt: latestApproval, distinctTemplates: approvedTemplates }),
      };
      const stateSelector: Record<string, (s: DocStatus) => CellState> = {
        ingest: (s) => s.ingest.state,
        classify: (s) => s.classify.state,
        route: (s) => s.route.state,
        template: (s) => s.template.state,
        extract: (s) => s.extract.state,
        approve: (s) => s.approve.state,
      };

      const nodes = pipeline.nodes.map((n) => {
        const sel = stateSelector[n.kind];
        const qual = qualityByKind[n.kind];
        const agg = sel ? nodeAgg(sel) : { passed: 0, partial: 0, total: docStatuses.length };
        return {
          id: n.id,
          name: n.displayName, // legacy alias for older clients still reading `name`
          displayName: n.displayName,
          kind: n.kind,
          model: n.model,
          optional: n.optional ?? false,
          ...agg,
          quality: qual ? qual() : { kind: n.kind },
        };
      });

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
        pipeline: {
          id: pipeline.id,
          version: pipeline.version,
          displayName: pipeline.displayName,
          bound: !!binding,
        },
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

  // ---------- Workspace ↔ Pipeline binding (sidecar at workspaces/<id>/binding.json) ----------
  // Note: Pipeline catalog routes live in createPipelinesRouter() (mounted at /api/pipelines)
  // — they're not workspace-scoped, so they don't belong in this router.
  router.get('/:ws/binding', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const binding = await getBinding(workspacesDir, wsId);
      if (!binding) { res.status(204).end(); return; }
      res.json(binding);
    } catch (e) {
      res.status(500).json({ error: 'binding_read_failed', message: (e as Error).message });
    }
  });

  router.post('/:ws/binding', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const pipelineId = typeof req.body?.pipelineId === 'string' ? req.body.pipelineId.trim() : '';
      const version = typeof req.body?.version === 'string' ? req.body.version.trim() : '';
      if (!pipelineId || !version) { res.status(400).json({ error: 'missing_fields', message: 'pipelineId und version erforderlich' }); return; }
      const pipelines = await loadPipelines(pipelinesDir);
      const exists = pipelines.some((p) => p.id === pipelineId && p.version === version);
      if (!exists) {
        res.status(400).json({
          error: 'pipeline_not_found',
          message: `Pipeline ${pipelineId}@${version} ist nicht im pipelines-seed/ vorhanden.`,
          available: pipelines.map((p) => `${p.id}@${p.version}`),
        });
        return;
      }
      const binding: PipelineBinding = {
        pipelineId,
        version,
        boundAt: new Date().toISOString(),
        boundBy: typeof req.body?.boundBy === 'string' ? req.body.boundBy : 'manual',
        overrides: typeof req.body?.overrides === 'object' && req.body.overrides ? req.body.overrides : {},
      };
      await setBinding(workspacesDir, wsId, binding);
      res.json(binding);
    } catch (e) {
      res.status(500).json({ error: 'binding_write_failed', message: (e as Error).message });
    }
  });

  router.delete('/:ws/binding', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const removed = await deleteBinding(workspacesDir, wsId);
      res.json({ removed });
    } catch (e) {
      res.status(500).json({ error: 'binding_delete_failed', message: (e as Error).message });
    }
  });

  // ---------- Phase H+: client-side bboxes (Tesseract.js) persistieren ----------
  router.post('/:ws/documents/:uuid/bboxes', async (req: Request, res: Response) => {
    let wsId: string, uuid: string;
    try { wsId = safeSeg(req.params.ws); uuid = safeSeg(req.params.uuid); }
    catch { res.status(400).json({ error: 'invalid_path' }); return; }
    const mp = metaPath(wsId, uuid);
    let meta: DocumentMeta;
    try { meta = JSON.parse(await fs.readFile(mp, 'utf8')) as DocumentMeta; }
    catch { res.status(404).json({ error: 'document_not_found' }); return; }
    const body = req.body as { engine?: string; pages?: Array<{ page: number; words: Array<{ text: string; x: number; y: number; w: number; h: number; confidence?: number }> }>; pageDimensions?: Array<{ page: number; width: number; height: number }> };
    if (!Array.isArray(body?.pages)) { res.status(400).json({ error: 'missing_pages' }); return; }
    meta = {
      ...meta,
      bboxes: {
        generatedAt: new Date().toISOString(),
        engine: (body.engine as 'tesseract.js' | 'mistral-ocr' | 'manual') ?? 'tesseract.js',
        pageDimensions: body.pageDimensions,
        pages: body.pages,
      },
    } as DocumentMeta;
    await fs.writeFile(mp, JSON.stringify(meta, null, 2));
    res.json({ ok: true, pageCount: body.pages.length, wordCount: body.pages.reduce((a, p) => a + p.words.length, 0) });
  });

  router.get('/:ws/documents/:uuid/bboxes', async (req: Request, res: Response) => {
    let wsId: string, uuid: string;
    try { wsId = safeSeg(req.params.ws); uuid = safeSeg(req.params.uuid); }
    catch { res.status(400).json({ error: 'invalid_path' }); return; }
    const mp = metaPath(wsId, uuid);
    let meta: DocumentMeta;
    try { meta = JSON.parse(await fs.readFile(mp, 'utf8')) as DocumentMeta; }
    catch { res.status(404).json({ error: 'document_not_found' }); return; }
    if (!meta.bboxes) { res.status(204).end(); return; }
    res.json(meta.bboxes);
  });

  // ---------- Workspace-scoped Jobs (Phase C) ----------
  router.post('/:ws/jobs', async (req, res) => {
    if (!jobRunner) { res.status(503).json({ error: 'jobs_disabled' }); return; }
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const kind = req.body?.kind as JobKind | undefined;
      const inputs = (req.body?.inputs ?? {}) as JobInputs;
      if (!kind || !['reclassify', 'extract', 'audit', 'batch', 'citations'].includes(kind)) {
        res.status(400).json({ error: 'invalid_kind', message: 'kind must be one of: reclassify, extract, audit, batch, citations' });
        return;
      }
      const pipelines = await loadPipelines(pipelinesDir);
      const binding = await getBinding(workspacesDir, wsId);
      const pipeline = resolvePipeline(pipelines, binding);
      const { job, deduplicated } = await jobRunner.enqueue({
        workspaceId: wsId,
        kind,
        inputs,
        pipelineRef: `${pipeline.id}@${pipeline.version}`,
        createdBy: typeof req.body?.createdBy === 'string' ? req.body.createdBy : 'user',
        idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
      });
      res.status(deduplicated ? 200 : 201).json({ ...job, deduplicated });
    } catch (e) {
      res.status(500).json({ error: 'job_create_failed', message: (e as Error).message });
    }
  });

  router.get('/:ws/jobs', async (req, res) => {
    if (!jobRunner) { res.status(503).json({ error: 'jobs_disabled' }); return; }
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const status = req.query?.status as NonNullable<Parameters<JobRunner['list']>[1]>['status'] | undefined;
      const kind = req.query?.kind as NonNullable<Parameters<JobRunner['list']>[1]>['kind'] | undefined;
      const limit = req.query?.limit ? parseInt(String(req.query.limit), 10) : 50;
      const jobs = await jobRunner.list(wsId, { status, kind, limit });
      res.json(jobs);
    } catch (e) {
      res.status(500).json({ error: 'jobs_list_failed', message: (e as Error).message });
    }
  });

  // Phase G: master.json is a content-addressed signed snapshot.
  // - Reads the cached snapshot if verlaufHash unchanged (no re-build)
  // - Builds + signs + persists when verlaufHash changes
  // - ETag-based If-None-Match → 304 for unchanged snapshots
  router.get('/:ws/master.json', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      const ws = records.find((r) => r.id === wsId);
      if (!ws) {
        res.status(404).json({ error: 'workspace_not_found' });
        return;
      }
      // Lazy-migration: ensure all docs' history chains are hashed before
      // computing the workspace verlaufHash. Idempotent.
      const verlaufHash = await lazyMigrateWorkspace(workspacesDir, wsId, metaPath);
      const cachedHash = await getLatestHash(workspacesDir, wsId);

      // ETag handling
      const etag = `"${verlaufHash}"`;
      if (req.headers['if-none-match'] === etag) {
        res.status(304).setHeader('ETag', etag).end();
        return;
      }

      // Try cached snapshot first
      let snapshot: unknown | null = null;
      if (cachedHash === verlaufHash) {
        snapshot = await getSnapshot(workspacesDir, wsId, verlaufHash);
      }
      if (!snapshot) {
        // Rebuild + sign + persist
        const all = await listMetas(wsId);
        const approved = all.filter((d) => d.approvedAt);
        const byClassification: Record<string, number> = {};
        for (const d of approved) {
          const k = d.classification?.label ?? 'unklassifiziert';
          byClassification[k] = (byClassification[k] ?? 0) + 1;
        }
        // Resolve pipeline (for traceability in the snapshot)
        const pipelines = await loadPipelines(pipelinesDir);
        const binding = await getBinding(workspacesDir, wsId);
        const pipeline = resolvePipeline(pipelines, binding);

        const unsigned: Record<string, unknown> = {
          '@context': 'https://0711.io/schemas/master/v1',
          version: 1,
          workspace: { id: ws.id, name: ws.name, createdAt: ws.createdAt },
          pipeline: { id: pipeline.id, version: pipeline.version },
          verlaufHash,
          generatedAt: new Date().toISOString(),
          approvedCount: approved.length,
          totalCount: all.length,
          documents: approved.map((d) => {
            const { version, sha } = deriveVersionAndSha(d);
            return {
              uuid: d.uuid, version, sha,
              originalFilename: d.originalFilename, mime: d.mime, size: d.size,
              ingestedAt: d.ingestedAt, currentPath: d.currentPath, fileId: d.fileId,
              classification: d.classification,
              template: d.template ? { source: d.template.source, id: d.template.id, name: d.template.name } : undefined,
              extraction: d.extraction,
              approvedAt: d.approvedAt,
              history: d.history,
            };
          }),
          summary: { byClassification },
          signature: null,
        };
        const key = await getMasterKey();
        unsigned.signature = signMaster(unsigned, key);
        await setSnapshot(workspacesDir, wsId, verlaufHash, unsigned, { approvedCount: approved.length, totalCount: all.length });
        snapshot = unsigned;
        // Webhook: master.updated (only when a NEW snapshot was persisted, not on cache hits)
        void emitWebhookEvent(workspacesDir, wsId, {
          type: 'master.updated',
          pipeline: { id: pipeline.id, version: pipeline.version },
          outputHash: verlaufHash,
          data: {
            verlaufHash,
            approvedCount: approved.length,
            totalCount: all.length,
            signature: (unsigned.signature as { value?: string } | undefined)?.value,
          },
        });
      }

      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      if (req.query?.download) {
        res.setHeader('Content-Disposition', `attachment; filename="${ws.id}-master.json"`);
      }
      res.type('application/json').send(JSON.stringify(snapshot, null, 2));
      return;
    } catch (e) {
      res.status(500).json({ error: 'master_json_failed', message: (e as Error).message });
    }
  });

  // Workspace consolidation: ALL data from ALL classified documents in ONE
  // structured JSON. Default includes any doc with at least classification —
  // approval workflow is downstream and not a precondition for the JSON view.
  // Use ?approved=1 to filter to approved-only, or ?include=all for everything.
  router.get('/:ws/case.json', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      const ws = records.find((r) => r.id === wsId);
      if (!ws) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const all = await listMetas(wsId);
      const filterMode = req.query?.approved ? 'approved'
        : req.query?.include === 'all' ? 'all'
        : 'classified'; // default
      const filtered = all.filter((d) => {
        if (filterMode === 'approved') return !!d.approvedAt;
        if (filterMode === 'all') return true;
        return (d.classification?.kpis?.length ?? 0) > 0; // 'classified'
      });
      // Phase G: case.json is a derived view of master — declare provenance
      // via derivedFrom + ETag combining workspace verlaufHash, pipeline ref,
      // and filter mode (anything that would change the body).
      const verlaufHash = await lazyMigrateWorkspace(workspacesDir, wsId, metaPath);
      const pipelines = await loadPipelines(pipelinesDir);
      const binding = await getBinding(workspacesDir, wsId);
      const pipeline = resolvePipeline(pipelines, binding);
      const etag = `"${verlaufHash}:${pipeline.id}@${pipeline.version}:${filterMode}"`;
      if (req.headers['if-none-match'] === etag) {
        res.status(304).setHeader('ETag', etag).end();
        return;
      }
      const { buildCase } = await import('../lib/case-builder.ts');
      const consolidated = buildCase(filtered);
      const out = {
        '@context': 'https://0711.io/schemas/case/v1',
        version: 1,
        workspace: { id: ws.id, name: ws.name, createdAt: ws.createdAt },
        derivedFrom: {
          master: verlaufHash,
          pipeline: `${pipeline.id}@${pipeline.version}`,
        },
        filterMode,
        ...consolidated,
        totalCount: all.length,
      };
      res.setHeader('ETag', etag);
      res.setHeader('X-Derived-From', `master:${verlaufHash}`);
      res.setHeader('Cache-Control', 'public, max-age=300');
      if (req.query?.download) {
        res.setHeader('Content-Disposition', `attachment; filename="${ws.id}-case.json"`);
      }
      res.type('application/json').send(JSON.stringify(out, null, 2));
    } catch (e) {
      res.status(500).json({ error: 'case_json_failed', message: (e as Error).message });
    }
  });

  // ---------- Phase D: webhooks (subscribers + event log + deliveries) ----------
  router.get('/:ws/webhooks', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const subs = await listSubscribers(workspacesDir, wsId);
      // Don't leak secrets in list responses — show preview only.
      res.json(subs.map((s) => ({ ...s, secret: s.secret.slice(0, 8) + '…' })));
    } catch (e) {
      res.status(500).json({ error: 'webhooks_list_failed', message: (e as Error).message });
    }
  });

  router.post('/:ws/webhooks', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      const events = Array.isArray(req.body?.events) ? req.body.events : undefined;
      const secret = typeof req.body?.secret === 'string' ? req.body.secret : undefined;
      const label = typeof req.body?.label === 'string' ? req.body.label : undefined;
      if (!url) { res.status(400).json({ error: 'missing_url' }); return; }
      const sub = await addSubscriber(workspacesDir, wsId, { url, events, secret, label });
      // Return the secret ONCE — caller must persist it.
      res.status(201).json(sub);
    } catch (e) {
      res.status(400).json({ error: 'webhook_create_failed', message: (e as Error).message });
    }
  });

  router.delete('/:ws/webhooks/:subscriberId', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const subId = req.params.subscriberId;
      const removed = await deleteSubscriber(workspacesDir, wsId, subId);
      if (!removed) { res.status(404).json({ error: 'subscriber_not_found' }); return; }
      res.json({ removed: true });
    } catch (e) {
      res.status(500).json({ error: 'webhook_delete_failed', message: (e as Error).message });
    }
  });

  router.get('/:ws/webhooks/:subscriberId/deliveries', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const subId = req.params.subscriberId;
      const limit = req.query?.limit ? parseInt(String(req.query.limit), 10) : 100;
      const all = await readDeliveries(workspacesDir, wsId, subId);
      res.json(all.slice(-limit).reverse());
    } catch (e) {
      res.status(500).json({ error: 'deliveries_failed', message: (e as Error).message });
    }
  });

  /** Replay endpoint: get events from a sequence cursor. */
  router.get('/:ws/events', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const fromSeq = req.query?.fromSeq ? parseInt(String(req.query.fromSeq), 10) : 0;
      const events = await readEventLog(workspacesDir, wsId, fromSeq);
      const limit = req.query?.limit ? parseInt(String(req.query.limit), 10) : 100;
      res.json({ wsId, fromSeq, count: events.length, events: events.slice(0, limit) });
    } catch (e) {
      res.status(500).json({ error: 'events_failed', message: (e as Error).message });
    }
  });

  // ---------- Phase G: master snapshot history + verify ----------
  /** Get a historical master snapshot by its verlaufHash. */
  router.get('/:ws/master/:hash.json', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const hash = req.params.hash;
      const snap = await getSnapshot(workspacesDir, wsId, hash);
      if (!snap) { res.status(404).json({ error: 'snapshot_not_found', hash }); return; }
      res.setHeader('ETag', `"sha256:${hash}"`);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.type('application/json').send(JSON.stringify(snap, null, 2));
    } catch (e) {
      res.status(500).json({ error: 'snapshot_read_failed', message: (e as Error).message });
    }
  });

  /** Genealogy: chronological list of all master snapshots for a workspace. */
  router.get('/:ws/master/log', async (req, res) => {
    try {
      const wsId = safeSeg(req.params.ws);
      const records = await readIndex();
      if (!records.some((r) => r.id === wsId)) { res.status(404).json({ error: 'workspace_not_found' }); return; }
      const log = await readLog(workspacesDir, wsId);
      res.json({ wsId, count: log.length, snapshots: log });
    } catch (e) {
      res.status(500).json({ error: 'log_read_failed', message: (e as Error).message });
    }
  });

  /** Verify a master.json HMAC signature without exposing the secret. */
  router.post('/:ws/master/verify', async (req, res) => {
    try {
      const master = req.body as Record<string, unknown> | undefined;
      if (!master || typeof master !== 'object') { res.status(400).json({ error: 'missing_body' }); return; }
      const key = await getMasterKey();
      const result = verifyMaster(master, key);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'verify_failed', message: (e as Error).message });
    }
  });

  // Human-in-the-loop merge decisions. Accepts a batch of actions on the
  // KPI list (keep/replace/add/remove). Each action is recorded in history
  // with `from` provenance. No model calls — pure mutation.
  router.post('/:ws/documents/:uuid/merge', async (req: Request, res: Response) => {
    let wsId: string, uuid: string;
    try { wsId = safeSeg(req.params.ws); uuid = safeSeg(req.params.uuid); }
    catch { res.status(400).json({ error: 'invalid_path' }); return; }
    const mp = metaPath(wsId, uuid);
    let meta: DocumentMeta;
    try { meta = JSON.parse(await fs.readFile(mp, 'utf8')) as DocumentMeta; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { res.status(404).json({ error: 'document_not_found' }); return; }
      throw e;
    }
    const actions = (req.body?.actions ?? []) as Array<
      | { type: 'add'; key: string; value: string; from?: 'claude-haiku-merge' | 'manual' | 'structural-rescue' }
      | { type: 'remove'; key: string }
      | { type: 'replace'; key: string; newValue: string; from?: 'claude-haiku-merge' | 'manual' }
      | { type: 'rename'; key: string; newKey: string }
    >;
    if (!Array.isArray(actions) || actions.length === 0) {
      res.status(400).json({ error: 'no_actions' });
      return;
    }
    if (!meta.classification) meta.classification = { label: 'unknown', confidence: 0, classifiedAt: new Date().toISOString() } as NonNullable<DocumentMeta['classification']>;
    const kpis = [...(meta.classification.kpis ?? [])].map((k) => ({ ...k, from: k.from ?? 'mistral' as const }));
    const summary: string[] = [];
    for (const a of actions) {
      if (a.type === 'add') {
        // De-dupe: skip if exact (key+value) already present
        if (!kpis.some((k) => k.key === a.key && k.value === a.value)) {
          kpis.push({ key: a.key, value: a.value, from: a.from ?? 'manual' });
          summary.push(`+${a.key}=${a.value}`);
        }
      } else if (a.type === 'remove') {
        const before = kpis.length;
        const idx = kpis.findIndex((k) => k.key === a.key);
        if (idx >= 0) { kpis.splice(idx, 1); summary.push(`-${a.key}`); }
        if (kpis.length === before) summary.push(`(remove no-op: ${a.key})`);
      } else if (a.type === 'replace') {
        const idx = kpis.findIndex((k) => k.key === a.key);
        if (idx >= 0) {
          const old = kpis[idx].value;
          kpis[idx] = { ...kpis[idx], value: a.newValue, from: a.from ?? 'manual' };
          summary.push(`~${a.key}: ${old} → ${a.newValue}`);
        }
      } else if (a.type === 'rename') {
        const idx = kpis.findIndex((k) => k.key === a.key);
        if (idx >= 0) { kpis[idx] = { ...kpis[idx], key: a.newKey }; summary.push(`rename: ${a.key} → ${a.newKey}`); }
      }
    }
    meta = {
      ...meta,
      classification: { ...meta.classification, kpis },
      history: [...(meta.history ?? []), {
        at: new Date().toISOString(), kind: 'patch', source: 'document-detail',
        summary: `human-merge: ${summary.length} action${summary.length === 1 ? '' : 'en'} · ${summary.slice(0, 6).join(', ')}${summary.length > 6 ? '…' : ''}`,
      }],
    };
    await fs.writeFile(mp, JSON.stringify(meta, null, 2));
    res.json({ kpis: kpis.length, applied: actions.length });
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
    const kind = (req.body?.kind ?? 'consistency') as 'consistency' | 'semantic' | 'visual' | 'vision' | 'cross-model' | 'structural';
    if (!['consistency', 'semantic', 'visual', 'vision', 'cross-model', 'structural'].includes(kind)) {
      res.status(400).json({ error: 'invalid_kind', message: 'kind must be consistency|semantic|visual|vision|cross-model|structural' });
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
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    try {
      const apiKey = process.env.MISTRAL_API_KEY;
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const needsMistral = kind === 'semantic' || kind === 'visual' || kind === 'vision';
      if (needsMistral && !apiKey) throw new Error('MISTRAL_API_KEY not set on server');
      if (kind === 'cross-model' && !anthropicKey) throw new Error('ANTHROPIC_API_KEY not set on server');

      send('audit_started', { uuid, kind });

      // Cross-model: a STANDALONE second-opinion classification by Claude
      // Haiku 4.5. No diff logic — we persist the full Haiku result so the
      // user can see what the other model independently extracted, side by
      // side with Mistral's. Comparison is a follow-up surface, not this run.
      if (kind === 'cross-model') {
        const fileAbs = path.join(workspaceRoot(wsId), meta.currentPath);
        const buf = await fs.readFile(fileAbs);
        const mediaType = mimeFromFilename(meta.originalFilename);
        send('cross_model_started', { uuid, model: 'claude-haiku-4-5-20251001', bytes: buf.length });
        const { classifyDocumentClaude } = await import('../lib/classify-claude.ts');
        const claude = await classifyDocumentClaude({
          fileBase64: buf.toString('base64'),
          mediaType,
          apiKey: anthropicKey!,
          signal: ac.signal,
        });
        const ranAt = new Date().toISOString();
        meta = {
          ...meta,
          crossModel: {
            ...(meta.crossModel ?? {}),
            claudeHaiku: {
              ranAt,
              model: 'claude-haiku-4-5-20251001',
              label: claude.label,
              confidence: claude.confidence,
              summary: claude.summary,
              kpis: claude.kpis,
              valueCount: claude.valueCount,
              ms: claude.ms,
              usage: {
                input_tokens: claude.mistralUsage.prompt_tokens,
                output_tokens: claude.mistralUsage.completion_tokens,
                total_tokens: claude.mistralUsage.total_tokens,
              },
            },
          },
          history: [...(meta.history ?? []), {
            at: ranAt, kind: 'patch', source: 'document-detail',
            summary: `cross-check (claude-haiku-4-5): ${claude.kpis.length} KPIs, label=${claude.label}, conf=${claude.confidence}`,
          }],
        };
        await fs.writeFile(mp, JSON.stringify(meta, null, 2));
        send('cross_model_done', { uuid, result: meta.crossModel!.claudeHaiku });
        send('done', { uuid });
        res.end();
        return;
      }

      // Resolve a document chunk for kinds that need to send the file to the
      // model (vision pass). Also used by the OCR pre-step for visual/semantic.
      let auditDocument: DocumentChunk | undefined;
      if (kind === 'vision') {
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
        auditDocument = isImage
          ? { type: 'image_url', image_url: signedUrl }
          : { type: 'document_url', document_url: signedUrl, document_name: meta.originalFilename };
        send('vision_audit_started', { uuid, model: 'mistral-ocr-latest' });
      }

      // Visual + semantic both need OCR text. If none exists yet, run
      // mistral-ocr-latest on the file (no schema) and persist the result so
      // the audit has something to compare against — independent of any prior
      // Extract.
      const haveMd = (meta.extraction?.markdown?.length ?? 0) > 0;
      const havePages = (meta.extraction?.pagesMarkdown?.length ?? 0) > 0;
      const needsOcr = (kind === 'visual' && !havePages) || (kind === 'semantic' && !haveMd);
      if (needsOcr) {
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
      const report = await runAudit(meta, { apiKey: apiKey ?? '', kind, signal: ac.signal, document: auditDocument });

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
      // Webhook: document.audited
      void emitWebhookEvent(workspacesDir, wsId, {
        type: 'document.audited',
        data: {
          docUuid: uuid,
          auditKind: kind,
          totals: report.totals,
          ms: report.ms,
        },
      });
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
      // Webhook: document.approved (or generic patch event)
      if (changed.includes('approvedAt')) {
        void emitWebhookEvent(workspacesDir, wsId, {
          type: 'document.approved',
          data: {
            docUuid: meta.uuid,
            filename: meta.originalFilename,
            approvedAt: meta.approvedAt,
            templateId: meta.template?.id,
          },
        });
      }
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
