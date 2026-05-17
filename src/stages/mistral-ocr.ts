import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { defineStage } from '../core/stage.ts';
import {
  callMistralOcrWithFallback,
  configToApiRequest,
  getFileSignedUrl,
  mimeFromFilename,
  parseApiResponse,
  uploadFile,
  type DocumentChunk,
  type JsonSchema,
  type MistralOcrConfig as FullConfig,
  type ParsedOcrResponse,
} from '../lib/mistral-ocr/index.ts';
import {
  readOcrCache,
  sha256OfFile,
  writeOcrCache,
} from '../lib/ocr-cache.ts';

export interface MistralOcrInput {
  /** Absoluter Dateipfad. */
  filePath: string;
  /** Ursprünglicher Dateiname — bestimmt MIME über Extension. */
  filename: string;
  /** Optionales dynamisches Schema-Override. Überschreibt config.documentAnnotation.schema. */
  schema?: JsonSchema;
  /** Optionaler Schema-Name-Override. */
  schemaName?: string;
  /** Optional: bereits hochgeladene Mistral file_id (wiederverwenden, kein erneuter Upload). */
  fileId?: string;
}

/** Stage-Config = volle MistralOcrConfig. Backwards-compat schema/schemaName/model bleiben unterstützt. */
export type MistralOcrConfig = FullConfig;

/**
 * Output bleibt rückwärtskompatibel zur vorherigen Stage:
 *   { model, pages[{index,markdown,chars}], text, chars, annotation, ms }
 * Zusätzlich liefert das volle ParsedOcrResponse unter `parsed`.
 */
export interface MistralOcrOutput {
  model: string;
  pages: Array<{ index: number; markdown: string; chars: number }>;
  text: string;
  chars: number;
  annotation: unknown | null;
  ms: number;
  parsed: ParsedOcrResponse;
}

export const mistralOcrStage = defineStage<MistralOcrInput, MistralOcrOutput, MistralOcrConfig>({
  id: 'mistral-ocr',
  name: 'Mistral OCR',
  description: 'OCR via Mistral mit voller API-Konfiguration (Header, Footer, Annotationen, Image-Filter, Confidence)',
  hints: {
    inputs: 'filePath, filename · optional: schema, schemaName, fileId',
    outputs: 'text, pages[{index,markdown,chars}], chars, annotation, ms, parsed',
    configExample: '{"model": "mistral-ocr-latest"}',
    inputPorts: [
      { name: 'filePath', type: 'file-path', description: 'Absolute filesystem path' },
      { name: 'filename', type: 'string', description: 'Original filename' },
    ],
    outputPorts: [
      { name: 'text', type: 'text', description: 'Concatenated markdown of all pages' },
      { name: 'pages', type: 'pages', description: 'Array of {index, markdown, chars}' },
      { name: 'annotation', type: 'json', description: 'Optional structured annotation' },
    ],
  },

  async run(input, ctx) {
    if (!input?.filePath) throw new Error('mistral-ocr: filePath fehlt');
    if (!input?.filename) throw new Error('mistral-ocr: filename fehlt');

    // Input-Schema-Override gewinnt vor config (Legacy-Verhalten).
    const cfg: MistralOcrConfig = { ...(ctx.config ?? {}) };
    // Quality-pipeline default: turn on line-level confidence so downstream
    // ocr-consensus-merge can pick the most-confident variant per aligned
    // cluster. Costs nothing extra on the wire. Caller can disable via
    // config.confidenceScoresGranularity = 'none'.
    if (cfg.confidenceScoresGranularity === undefined) {
      // 'page' is the finest granularity exposed by Mistral's typed config
      // ('word' is for token-level; we need a per-page float that ocr-consensus-merge
      // can use to weight clusters from this branch).
      cfg.confidenceScoresGranularity = 'page';
    }
    if (input.schema) {
      cfg.documentAnnotation = {
        schema: input.schema,
        name: input.schemaName ?? cfg.documentAnnotation?.name,
        prompt: cfg.documentAnnotation?.prompt,
      };
    }

    // ── OCR result cache (sha256 + model) ─────────────────────────────────
    // Mistral OCR costs 4–5 s + API call per page. If the same PDF is uploaded
    // twice (frequent during testing + inbox re-runs), we re-OCR from scratch.
    // The cache lives OUTSIDE per-run artifacts (shared across runs); we still
    // return the same output shape, and the per-run `ocr/output.json` is
    // written by the runner regardless so audit trails stay intact.
    //
    // Cache key = sha256(file) + model. A schema/annotation override is NOT
    // part of the key because document-annotation does not influence OCR text
    // extraction itself; skipping the cache there would defeat the purpose.
    // If a future feature makes annotation part of the OCR output a caller
    // depends on, revisit the key.
    const effectiveModel = cfg.model ?? 'mistral-ocr-latest';
    const sha256 = await sha256OfFile(input.filePath);
    // artifacts.absolutePath('') → <rootDir>/<workflowId>/<runId>;
    // two `..` segments resolve to the runs root.
    const runsRoot = path.resolve(ctx.artifacts.absolutePath(''), '..', '..');

    const hit = await readOcrCache<MistralOcrOutput>(runsRoot, sha256);
    if (hit && hit.model === effectiveModel) {
      ctx.emit('ocr_cache_hit', { sha256, cachedAt: hit.cachedAt, model: hit.model });
      ctx.logger.info(`OCR cache hit: ${sha256.slice(0, 12)} (cached ${hit.cachedAt})`);
      return hit.output;
    }
    ctx.emit('ocr_cache_miss', { sha256 });

    // Upload via Files API (or reuse a pre-uploaded fileId), then resolve a
    // presigned URL. Mirrors the playground's Run-call shape and avoids
    // base64-encoding the bytes on every iteration.
    const fileId = input.fileId
      ?? (await uploadFile(input.filePath, input.filename, { signal: ctx.signal })).file_id;
    const { url: signedUrl } = await getFileSignedUrl(fileId, { signal: ctx.signal });
    const isImage = mimeFromFilename(input.filename).startsWith('image/');
    const document: DocumentChunk = isImage
      ? { type: 'image_url', image_url: signedUrl }
      : { type: 'document_url', document_url: signedUrl, document_name: input.filename };
    ctx.logger.debug(`OCR Eingabe: ${input.filename} (file_id=${fileId})`);

    const req = configToApiRequest(cfg, document, { runId: ctx.runId, stageId: ctx.stageId });
    const t0 = Date.now();
    ctx.emit("ocr_started", { filename: input.filename, fileId });
    const { response, degradation } = await callMistralOcrWithFallback(req, { signal: ctx.signal });
    const parsed = parseApiResponse(response, cfg, t0, degradation);

    if (degradation) ctx.emit('ocr_degraded', degradation);
    ctx.emit('ocr_done', { pages: parsed.pages.length, chars: parsed.chars, ms: parsed.ms });
    if (parsed.validation.documentAnnotation.length > 0) {
      ctx.emit('ocr_validation', {
        issues: parsed.validation.documentAnnotation.length,
        sample: parsed.validation.documentAnnotation.slice(0, 5),
      });
    }
    if (parsed.hallucinations.length > 0) {
      ctx.emit('ocr_hallucinations', {
        count: parsed.hallucinations.length,
        sample: parsed.hallucinations.slice(0, 5),
      });
    }

    const output: MistralOcrOutput = {
      model: parsed.model,
      pages: parsed.pages.map((p) => ({ index: p.index, markdown: p.markdown, chars: p.chars })),
      text: parsed.text,
      chars: parsed.chars,
      annotation: parsed.documentAnnotation,
      ms: parsed.ms,
      parsed,
    };

    // Best-effort cache write — never fail the stage if the disk is full or
    // the runs dir is read-only.
    try {
      const stat = await fs.stat(input.filePath);
      await writeOcrCache<MistralOcrOutput>(runsRoot, sha256, {
        sha256,
        filename: input.filename,
        size: stat.size,
        mime: mimeFromFilename(input.filename),
        model: effectiveModel,
        output,
        cachedAt: new Date().toISOString(),
      });
    } catch (e) {
      ctx.logger.warn(`OCR cache write failed (non-fatal): ${(e as Error).message}`);
    }

    return output;
  },
});
