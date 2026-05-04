/**
 * STURM Schema Generator — Mistral Document AI Playground mirror.
 *
 * Mirrors what the public Mistral playground actually does for "Generate schema":
 *   1. Upload PDF via Files API (purpose=ocr).
 *   2. Get a presigned download URL.
 *   3. ONE chat-completions call (model=mistral-small-latest) with a
 *      `document_url` content part + a strict `response_format: json_schema`
 *      that constrains output to { name, schema }. The chat backend OCRs the
 *      doc internally; the *invoked* model is mistral-small-latest, NOT
 *      mistral-ocr-latest.
 *   4. JSON.parse(message.content) → emit single SSE winner.
 *
 * No 3-candidate orchestration, no scoring, no snake_case rewriting.
 * The playground's verbatim 5-rule prompt is reused so output style matches.
 *
 * `validateSoundness` and `scoreCandidate` are kept as pure utilities for
 * downstream QA / badging — not used to gate the response anymore.
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import multer from 'multer';
import * as fs from 'node:fs/promises';
import { getFileSignedUrl, MistralOcrError, uploadFile } from '../lib/mistral-ocr/api.ts';
import type { JsonSchema } from '../lib/mistral-ocr/types.ts';

// ---------------- Playground prompt + meta-schema (verbatim) ----------------

export const PLAYGROUND_PROMPT =
  'Analyze the uploaded document and generate a JSON schema that strictly represents its structure and content.\n' +
  'Rules:\n' +
  '1. Return ONLY the JSON schema in valid JSON format. No additional text, metadata, or comments.\n' +
  '2. Model headings as keys, lists as arrays, and nested sections as objects.\n' +
  '3. Use "string" for text, "array" for lists, and "object" for nested content.\n' +
  '4. Mark required fields based on the document\'s structure.\n' +
  '5. Do not include placeholders, examples, or fields like "$schema" or "title" inside the schema.';

export const PLAYGROUND_META_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name', 'schema'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    schema: { type: 'object' },
  },
};

// ---------------- Soundness validator + scorer (kept as utilities) ----------

export interface SoundnessIssue {
  path: string;
  rule: 'A' | 'B' | 'C' | 'D';
  message: string;
}

const SNAKE = /^[a-z][a-z0-9_]*$/;

/**
 * Walk a JsonSchema and report rule violations.
 *  A — every object should set additionalProperties:false
 *  B — every declared property should appear in required[]
 *  C — keys are snake_case ASCII (warn-only — playground emits PascalCase German)
 *  D — array nodes need items; items must not be the run-2 bug
 */
export function validateSoundness(s: JsonSchema | undefined, path = '$'): SoundnessIssue[] {
  const issues: SoundnessIssue[] = [];
  if (!s || typeof s !== 'object') return issues;

  if (s.type === 'object') {
    if (s.additionalProperties !== false) {
      issues.push({ path, rule: 'A', message: 'additionalProperties must be false on object nodes' });
    }
    const props = s.properties ?? {};
    const required = new Set(s.required ?? []);
    for (const [k, child] of Object.entries(props)) {
      if (!SNAKE.test(k)) {
        issues.push({ path: `${path}.${k}`, rule: 'C', message: `key "${k}" is not snake_case ASCII` });
      }
      if (!required.has(k)) {
        issues.push({ path: `${path}.${k}`, rule: 'B', message: `property "${k}" is not listed in required[]` });
      }
      issues.push(...validateSoundness(child, `${path}.${k}`));
    }
  } else if (s.type === 'array') {
    if (!s.items) {
      issues.push({ path, rule: 'D', message: 'array node must declare items' });
    } else {
      const items = s.items;
      if (items && items.type === 'string' && items.properties && Object.keys(items.properties).length > 0) {
        issues.push({
          path: `${path}.items`,
          rule: 'D',
          message: 'items has both type:"string" and properties (run-2 bug pattern)',
        });
      }
      issues.push(...validateSoundness(items, `${path}.items`));
    }
  }
  return issues;
}

export interface CandidateMetrics {
  score: number;
  props: number;
  depth: number;
  formats: number;
  enums: number;
}

export function scoreCandidate(schema: JsonSchema | undefined, issues: SoundnessIssue[]): CandidateMetrics {
  let props = 0;
  let depth = 0;
  let formats = 0;
  let enums = 0;

  function walk(s: JsonSchema | undefined, d: number): void {
    if (!s || typeof s !== 'object') return;
    if (d > depth) depth = d;
    if (s.format) formats++;
    if (s.enum) enums++;
    if (s.type === 'object' && s.properties) {
      for (const [, child] of Object.entries(s.properties)) {
        props++;
        walk(child, d + 1);
      }
    }
    if (s.type === 'array' && s.items) {
      walk(s.items, d + 1);
    }
  }
  walk(schema, 0);

  let score = props * 1 + formats * 2 + enums * 1.5 - issues.length * 10;
  if (depth > 5) score -= (depth - 5) * 5;
  if (props > 200) score *= 0.5;

  return { score, props, depth, formats, enums };
}

// ---------------- Single playground-mirror chat call ------------------------

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

export interface MistralUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface MistralChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: MistralUsage;
}

export interface PlaygroundCallResult {
  parsed: { name: string; schema: JsonSchema };
  usage: MistralUsage;
  raw: MistralChatResponse;
}

/**
 * Single chat call mirroring the playground's "Generate schema" request:
 * mistral-small-latest, document_url content part, json_schema response_format
 * constraining output to {name, schema}.
 */
export async function callPlaygroundChatForSchema(opts: {
  documentUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  baseUrl?: string;
}): Promise<PlaygroundCallResult> {
  const body = {
    model: 'mistral-small-latest',
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PLAYGROUND_PROMPT },
          { type: 'document_url', document_url: opts.documentUrl },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'document_schema_response',
        schema: PLAYGROUND_META_SCHEMA,
        strict: true,
      },
    },
  };

  const url = opts.baseUrl ?? CHAT_URL;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`mistral ${resp.status}: ${text.slice(0, 500)}`);

  let json: MistralChatResponse;
  try {
    json = JSON.parse(text) as MistralChatResponse;
  } catch {
    throw new Error(`mistral ${resp.status}: non-JSON response: ${text.slice(0, 500)}`);
  }
  const content = json.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error(`mistral ${resp.status}: empty assistant content`);
  }
  let parsed: { name: string; schema: JsonSchema };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`mistral ${resp.status}: assistant content is not JSON: ${content.slice(0, 300)}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string' || !parsed.schema) {
    throw new Error(`mistral ${resp.status}: assistant content missing name/schema`);
  }
  return { parsed, usage: json.usage ?? {}, raw: json };
}

// ---------------- Express SSE wrapper --------------------------------------

const HTTPS_RE = /^https:\/\//i;

export function createSchemaGenerateRouter(uploadsDir: string): Router {
  const router = Router();
  // The Files-API → signed-URL flow doesn't put bytes through the chat
  // request body, so we can match the OCR limit (25 MB) instead of the
  // older 8 MB chat-context cap.
  const MAX_BYTES = 25 * 1024 * 1024;
  const upload = multer({ dest: uploadsDir, limits: { fileSize: MAX_BYTES } });

  // Wrap multer so payload-too-large becomes a clean JSON 413, not HTML 500.
  const acceptUpload: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (err) => {
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

  router.post('/generate', acceptUpload, async (req: Request, res: Response) => {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'MISTRAL_API_KEY not set on server' });
      if (req.file) await cleanup(req.file.path);
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

    const t0 = Date.now();
    let resolvedUrl: string | null = null;
    let fileId: string | null = null;
    let inputDescription = '';

    try {
      // Phase 1: upload + signed URL  (mirrors playground's 4-step dance,
      // collapsed to two public-API calls). For pre-uploaded URLs we skip both.
      if (req.file) {
        inputDescription = `${req.file.originalname} (${req.file.size} bytes)`;
        const { file_id } = await uploadFile(req.file.path, req.file.originalname, { signal: ac.signal });
        fileId = file_id;
        const { url } = await getFileSignedUrl(file_id, { signal: ac.signal });
        resolvedUrl = url;
      } else if (typeof req.body?.documentUrl === 'string') {
        const u = req.body.documentUrl.trim();
        if (!HTTPS_RE.test(u)) {
          res.status(400).json({ error: 'documentUrl must start with https://' });
          return;
        }
        resolvedUrl = u;
        inputDescription = u;
      } else {
        res.status(400).json({ error: 'provide multipart "file" or JSON body { documentUrl }' });
        return;
      }

      send('schema_start', { input: inputDescription, fileId });

      if (!resolvedUrl) {
        // Defensive narrowing — every branch above sets it or returns.
        throw new Error('documentUrl resolution failed');
      }

      // Phase 2: one chat call.
      const result = await callPlaygroundChatForSchema({
        documentUrl: resolvedUrl,
        apiKey,
        signal: ac.signal,
      });

      send('winner', {
        name: result.parsed.name,
        schema: result.parsed.schema,
        total_ms: Date.now() - t0,
        total_tokens: result.usage,
        file_id: fileId,
      });
      send('done', {});
    } catch (e) {
      const err = e as Error & { name?: string; status?: number; body?: string };
      if (e instanceof MistralOcrError) {
        send('error', { message: err.message, status: err.status, body: err.body });
      } else if (err?.name === 'AbortError') {
        send('error', { message: 'aborted by client' });
      } else {
        send('error', { message: err.message ?? String(err) });
      }
    } finally {
      if (req.file) await cleanup(req.file.path);
      res.end();
    }
  });

  return router;
}

async function cleanup(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}
