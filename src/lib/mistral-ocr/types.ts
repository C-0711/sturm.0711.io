/**
 * Mistral OCR — typed surface for STURM.
 *
 * Mirrors POST /v1/ocr request/response. Some fields are beta or undocumented
 * (bbox_annotation_format, confidence_scores_granularity); they are typed but
 * commented as such so consumers know the risk.
 */

// ---------------- JSON Schema (subset Mistral accepts under strict:true) -----

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
  // STURM extensions — Mistral ignores unknown keys; our verifier may use them.
  'x-sturm-evidence-required'?: boolean;
  'x-sturm-anchor'?: { page: number; bbox: [number, number, number, number] };
  [key: string]: unknown;
}

// ---------------- Document chunk variants -----------------------------------
//
// `document_name` is part of DocumentURLChunk per the OpenAPI spec (verified
// against /v1/openapi.yaml on 2026-04-25); used for telemetry/filename echo.

export type DocumentChunk =
  | { type: 'document_url'; document_url: string; document_name?: string }
  | { type: 'image_url'; image_url: string }
  | { type: 'file'; file_id: string };

// ---------------- Annotation format wrapper ---------------------------------

export interface AnnotationFormat {
  type: 'json_schema';
  json_schema: { name: string; schema: JsonSchema; strict: true };
}

// ---------------- Config (STURM-side) ---------------------------------------

export interface MistralOcrConfig {
  model?: 'mistral-ocr-latest' | 'mistral-ocr-2505' | string;

  /** 0-indexed integer list. Use pageRangeStringToArray() to convert from "1-4,8". */
  pages?: number[];

  extractHeader?: boolean;
  extractFooter?: boolean;
  /** Mistral API value. UI may layer an additional "render inline" presentation toggle. */
  tableFormat?: 'markdown' | 'html';

  includeImageBase64?: boolean;
  imageLimit?: number | null;
  imageMinSize?: number | null;

  documentAnnotation?: { schema: JsonSchema; prompt?: string; name?: string };
  /**
   * Per OpenAPI spec, `bbox_annotation_format` covers BOTH bounding boxes AND
   * extracted images — there is no separate `image_annotation_format` (verified
   * 2026-04-25; production rejects it as `extra_forbidden`/422).
   */
  bboxAnnotation?: { schema: JsonSchema; name?: string };

  /**
   * Undocumented in OpenAPI spec but accepted by production as of 2026-04-25.
   * Returns word- or page-level confidence scores. Codec emits as-is; the API
   * wrapper has a 422 fallback that strips it and retries if Mistral ever
   * tightens validation.
   */
  confidenceScoresGranularity?: 'word' | 'page' | 'none';

  /** Caller-supplied tracking id. Auto-filled to runId:stageId by the stage runner. */
  requestId?: string;

  // ---- Backwards-compatible aliases for the previous stage config shape ----
  /** @deprecated use documentAnnotation.schema */
  schema?: JsonSchema;
  /** @deprecated use documentAnnotation.name */
  schemaName?: string;
}

// ---------------- Wire request/response -------------------------------------

export interface MistralOcrRequest {
  model: string;
  document: DocumentChunk;
  pages?: number[];
  extract_header?: boolean;
  extract_footer?: boolean;
  table_format?: 'markdown' | 'html';
  include_image_base64?: boolean;
  image_limit?: number | null;
  image_min_size?: number | null;
  document_annotation_format?: AnnotationFormat | null;
  document_annotation_prompt?: string | null;
  bbox_annotation_format?: AnnotationFormat | null;
  /** Undocumented; api.callMistralOcr strips & retries on 422 if rejected. */
  confidence_scores_granularity?: 'word' | 'page' | 'none';
  id?: string;
}

export interface MistralOcrPage {
  index: number;
  markdown: string;
  dimensions: { dpi: number; height: number; width: number } | null;
  header: string | null;
  footer: string | null;
  hyperlinks: string[];
  images: Array<{
    id: string;
    top_left_x: number;
    top_left_y: number;
    bottom_right_x: number;
    bottom_right_y: number;
    image_base64: string | null;
    image_annotation: string | null;
  }>;
  tables: Array<{ id: string; content: string; format: 'markdown' | 'html'; word_confidence_scores?: unknown | null }>;
  /**
   * Page-level word confidence detail. Populated when
   * confidence_scores_granularity is "word"; null otherwise. Shape per live
   * probe (2026-04-25): `{ word_confidence_scores: [...], average_page_confidence_score, minimum_page_confidence_score }`.
   * Captured opaquely — schema is undocumented and may change.
   */
  confidence_scores?: unknown | null;
  /** @deprecated kept for backwards compat; use confidence_scores. */
  confidence?: unknown;
}

export interface MistralOcrResponse {
  model: string;
  document_annotation: string | null;
  pages: MistralOcrPage[];
  usage_info: { pages_processed: number; doc_size_bytes: number | null };
}

// ---------------- Parsed/normalized output (what the stage emits) -----------

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface HallucinationFlag {
  path: string;
  value: string;
}

export interface ParsedOcrResponse {
  model: string;
  ms: number;
  text: string;
  chars: number;
  pages: Array<MistralOcrPage & { chars: number }>;
  documentAnnotation: unknown | null;
  imageAnnotations: Array<{ pageIndex: number; imageId: string; annotation: unknown }>;
  validation: { documentAnnotation: ValidationIssue[] };
  hallucinations: HallucinationFlag[];
  usage: { pagesProcessed: number; docSizeBytes: number | null };
  /**
   * Set when the call was retried with one or more undocumented fields stripped.
   * Surfaced in the studio so users see "preview ran but with confidence off".
   */
  degradation?: { reason: string; strippedFields: string[] } | null;
  /** Original wire response, kept for the studio's Raw tab. */
  raw: MistralOcrResponse;
}
