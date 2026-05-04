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

  async run(input, ctx) {
    if (!input?.filePath) throw new Error('mistral-ocr: filePath fehlt');
    if (!input?.filename) throw new Error('mistral-ocr: filename fehlt');

    // Input-Schema-Override gewinnt vor config (Legacy-Verhalten).
    const cfg: MistralOcrConfig = { ...(ctx.config ?? {}) };
    if (input.schema) {
      cfg.documentAnnotation = {
        schema: input.schema,
        name: input.schemaName ?? cfg.documentAnnotation?.name,
        prompt: cfg.documentAnnotation?.prompt,
      };
    }

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
    const { response, degradation } = await callMistralOcrWithFallback(req, { signal: ctx.signal });
    const parsed = parseApiResponse(response, cfg, t0, degradation);

    if (degradation) ctx.emit('ocr_degraded', degradation);
    ctx.emit('ocr_pages', { count: parsed.pages.length, chars: parsed.chars });
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

    return {
      model: parsed.model,
      pages: parsed.pages.map((p) => ({ index: p.index, markdown: p.markdown, chars: p.chars })),
      text: parsed.text,
      chars: parsed.chars,
      annotation: parsed.documentAnnotation,
      ms: parsed.ms,
      parsed,
    };
  },
});
