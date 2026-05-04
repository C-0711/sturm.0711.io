/**
 * Codec: MistralOcrConfig ⇄ wire request, wire response → ParsedOcrResponse.
 *
 * Boundary responsibilities:
 *   - Coerce backwards-compat config (schema/schemaName) into the new shape.
 *   - Build a wire request with all known fields (including beta).
 *   - Parse JSON-stringified annotations once at the boundary.
 *   - Run a minimal schema check + substring-based hallucination flag.
 *
 * NON-goals: full JSON Schema validation (would require ajv); deep type coercion.
 */

import type {
  AnnotationFormat,
  DocumentChunk,
  HallucinationFlag,
  JsonSchema,
  MistralOcrConfig,
  MistralOcrPage,
  MistralOcrRequest,
  MistralOcrResponse,
  ParsedOcrResponse,
  ValidationIssue,
} from './types.ts';

// ---------------- Config normalization --------------------------------------

/** Coerce backwards-compat fields (schema/schemaName) into documentAnnotation. */
export function normalizeConfig(cfg: MistralOcrConfig | undefined): MistralOcrConfig {
  const c: MistralOcrConfig = { ...(cfg ?? {}) };
  if (c.schema && !c.documentAnnotation) {
    c.documentAnnotation = { schema: c.schema, name: c.schemaName };
  }
  delete c.schema;
  delete c.schemaName;
  return c;
}

// ---------------- Request builder -------------------------------------------

export function wrapJsonSchema(name: string, schema: JsonSchema): AnnotationFormat {
  return { type: 'json_schema', json_schema: { name, schema, strict: true } };
}

export interface RequestBuildContext {
  runId?: string;
  stageId?: string;
}

export function configToApiRequest(
  cfg: MistralOcrConfig,
  document: DocumentChunk,
  ctx: RequestBuildContext = {},
): MistralOcrRequest {
  const c = normalizeConfig(cfg);
  const req: MistralOcrRequest = {
    model: c.model ?? 'mistral-ocr-latest',
    document,
  };
  if (c.pages && c.pages.length > 0) req.pages = c.pages;
  if (c.extractHeader !== undefined) req.extract_header = c.extractHeader;
  if (c.extractFooter !== undefined) req.extract_footer = c.extractFooter;
  if (c.tableFormat) req.table_format = c.tableFormat;
  if (c.includeImageBase64 !== undefined) req.include_image_base64 = c.includeImageBase64;
  if (c.imageLimit !== undefined) req.image_limit = c.imageLimit;
  if (c.imageMinSize !== undefined) req.image_min_size = c.imageMinSize;

  if (c.documentAnnotation) {
    req.document_annotation_format = wrapJsonSchema(
      c.documentAnnotation.name ?? 'document_annotation',
      c.documentAnnotation.schema,
    );
    if (c.documentAnnotation.prompt) req.document_annotation_prompt = c.documentAnnotation.prompt;
  }
  // Note: there is no `image_annotation_format` in the OpenAPI spec — production
  // returns 422 extra_forbidden. `bbox_annotation_format` covers both bounding
  // boxes and extracted images per the spec.
  if (c.bboxAnnotation) {
    req.bbox_annotation_format = wrapJsonSchema(
      c.bboxAnnotation.name ?? 'bbox_annotation',
      c.bboxAnnotation.schema,
    );
  }
  if (c.confidenceScoresGranularity && c.confidenceScoresGranularity !== 'none') {
    req.confidence_scores_granularity = c.confidenceScoresGranularity;
  }
  const id = c.requestId ?? (ctx.runId && ctx.stageId ? `${ctx.runId}:${ctx.stageId}` : undefined);
  if (id) req.id = id;
  return req;
}

// ---------------- Response parsing ------------------------------------------

/** Parse a JSON-stringified annotation; tolerate Mistral's occasional double-encoding. */
export function safeParseAnnotation(raw: string | null | undefined): unknown | null {
  if (raw == null || raw === '') return null;
  let cur: unknown = raw;
  for (let i = 0; i < 3 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur as string);
    } catch {
      // Not JSON — return whatever we have (string).
      return cur;
    }
  }
  return cur;
}

export function parseApiResponse(
  resp: MistralOcrResponse,
  cfg: MistralOcrConfig,
  startedAt: number,
  degradation?: { reason: string; strippedFields: string[] } | null,
): ParsedOcrResponse {
  const c = normalizeConfig(cfg);
  const ms = Date.now() - startedAt;

  const pages = (resp.pages ?? []).map((p, i): MistralOcrPage & { chars: number } => ({
    index: p.index ?? i,
    markdown: p.markdown ?? '',
    dimensions: p.dimensions ?? null,
    header: p.header ?? null,
    footer: p.footer ?? null,
    hyperlinks: Array.isArray(p.hyperlinks) ? p.hyperlinks : [],
    images: Array.isArray(p.images) ? p.images : [],
    tables: Array.isArray(p.tables) ? p.tables : [],
    confidence_scores: (p as { confidence_scores?: unknown }).confidence_scores ?? null,
    confidence: p.confidence,
    chars: (p.markdown ?? '').length,
  }));

  const text = pages.map((p) => p.markdown).join('\n\n');

  const documentAnnotation = safeParseAnnotation(resp.document_annotation);

  const imageAnnotations: ParsedOcrResponse['imageAnnotations'] = [];
  for (const p of pages) {
    for (const img of p.images) {
      if (img.image_annotation) {
        imageAnnotations.push({
          pageIndex: p.index,
          imageId: img.id,
          annotation: safeParseAnnotation(img.image_annotation),
        });
      }
    }
  }

  const validation = {
    documentAnnotation: c.documentAnnotation
      ? validateAgainstSchema(documentAnnotation, c.documentAnnotation.schema, '$')
      : [],
  };

  const hallucinations = c.documentAnnotation
    ? findHallucinations(documentAnnotation, text)
    : [];

  return {
    model: resp.model ?? c.model ?? 'mistral-ocr-latest',
    ms,
    text,
    chars: text.length,
    pages,
    documentAnnotation,
    imageAnnotations,
    validation,
    hallucinations,
    usage: {
      pagesProcessed: resp.usage_info?.pages_processed ?? pages.length,
      docSizeBytes: resp.usage_info?.doc_size_bytes ?? null,
    },
    degradation: degradation ?? null,
    raw: resp,
  };
}

// ---------------- Minimal schema validation ---------------------------------

/**
 * Check structural conformance to a JSON Schema subset:
 *  - type
 *  - required (keys present)
 *  - enum membership
 *  - basic numeric/string bounds
 *  - nested properties + items
 *
 * Does NOT cover: oneOf, anyOf, $ref, format. Mistral's strict:true already
 * narrows the surface, so this catches the common drift.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value === null || value === undefined) {
    if (schema.type && schema.type !== 'null') {
      issues.push({ path, message: `expected ${schema.type}, got ${value === null ? 'null' : 'undefined'}` });
    }
    return issues;
  }
  if (schema.type) {
    const actual = jsType(value);
    if (!typeMatches(schema.type, actual)) {
      issues.push({ path, message: `expected ${schema.type}, got ${actual}` });
      return issues;
    }
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    issues.push({ path, message: `value not in enum (${schema.enum.length} options)` });
  }
  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `length ${value.length} < minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `length ${value.length} > maxLength ${schema.maxLength}` });
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          issues.push({ path, message: `does not match pattern ${schema.pattern}` });
        }
      } catch { /* invalid regex in schema — ignore */ }
    }
  }
  if ((schema.type === 'number' || schema.type === 'integer') && typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `${value} < minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `${value} > maximum ${schema.maximum}` });
    }
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) issues.push({ path: `${path}.${req}`, message: `required key missing` });
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) issues.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `length ${value.length} < minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `length ${value.length} > maxItems ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((item, i) => {
        issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${i}]`));
      });
    }
  }
  return issues;
}

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(schemaType: string, actual: string): boolean {
  if (schemaType === actual) return true;
  if (schemaType === 'number' && actual === 'integer') return true;
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

// ---------------- Hallucination flagging ------------------------------------

/**
 * Walk all leaf string values in `value`. For each, check whether the string
 * appears (case-insensitive, whitespace-collapsed) anywhere in `ocrText`.
 * Strings under 3 chars and pure numeric/symbol strings are skipped to reduce
 * false positives. Numbers are coerced to strings and checked the same way.
 */
export function findHallucinations(value: unknown, ocrText: string): HallucinationFlag[] {
  const flags: HallucinationFlag[] = [];
  const haystack = normalizeForSearch(ocrText);
  walk(value, '$');
  return flags;

  function walk(v: unknown, path: string) {
    if (v == null) return;
    if (typeof v === 'string') {
      const norm = normalizeForSearch(v);
      if (norm.length < 3) return;
      if (!haystack.includes(norm)) flags.push({ path, value: v });
      return;
    }
    if (typeof v === 'number') {
      const s = String(v);
      if (s.length < 2) return;
      if (!haystack.includes(s)) flags.push({ path, value: s });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof v === 'object') {
      for (const [k, sub] of Object.entries(v as Record<string, unknown>)) walk(sub, `${path}.${k}`);
    }
  }
}

function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
