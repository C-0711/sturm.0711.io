import * as fs from 'node:fs';
import * as path from 'node:path';

type CanonicalLike = {
  value?: unknown;
  normalized?: string | null;
  normalizedNumber?: number;
  origin?: string;
  datentyp?: string;
  evidence_line?: string;
  page?: number;
  trust?: 'high' | 'medium' | 'low' | 'suspicious';
  trust_reasons?: string[];
  anlage?: string;
  drucktext?: string;
};

type RunInputLike = Record<string, unknown> | null | undefined;

type ExportSummary = {
  extractedDocuments: number;
  extractedFacts: number;
  normalizedProducts: number;
  normalizedDocuments: number;
  normalizedFeatures: number;
  normalizedValues: number;
  entityLinks: number;
  documentLinks: number;
  sourceRefs: number;
  resolvedValues: number;
  conflicts: number;
  decisions: number;
  targetRoot: string;
};

type ExportContext = {
  workflowId: string;
  runId: string;
  sourceFile: string;
  primaryDocumentId: string;
  rootEntityId: string;
  rootEntityDisplayName: string;
};

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function createContext(workflowId: string, runId: string, sourceFile: string): ExportContext {
  return {
    workflowId,
    runId,
    sourceFile,
    primaryDocumentId: `doc_${slug(workflowId)}_${slug(runId)}_primary`,
    rootEntityId: `entity_${slug(workflowId)}_${slug(runId)}_root`,
    rootEntityDisplayName: `${sourceFile} · root`,
  };
}

function entityIdForAnlage(ctx: ExportContext, anlage?: string | null): string {
  if (!anlage) return ctx.rootEntityId;
  return `entity_${slug(ctx.workflowId)}_${slug(ctx.runId)}_anlage_${slug(anlage)}`;
}

function valueIdForEntityFeature(entityId: string, featureCode: string): string {
  return `value_${slug(entityId)}_${slug(featureCode)}`;
}

function mapDatatype(input?: string): 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'range' | 'json' {
  const dt = String(input || '').toLowerCase();
  if (dt === 'currency' || dt === 'amount' || dt === 'integer' || dt === 'percent' || dt === 'number') return 'number';
  if (dt === 'boolean' || dt === 'bool') return 'boolean';
  if (dt === 'date' || dt === 'datum') return 'date';
  if (dt === 'enum') return 'enum';
  if (dt === 'range') return 'range';
  if (dt === 'json' || dt === 'object') return 'json';
  return 'string';
}

function mapJsDatatype(value: unknown): 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'range' | 'json' {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (Array.isArray(value)) return 'json';
  if (value && typeof value === 'object') return 'json';
  return 'string';
}

function mapResolutionStrategy(origin?: string): 'source_priority' | 'confidence' | 'manual' {
  switch (origin) {
    case 'REGEX_100%':
    case 'REGEX_3F':
    case 'BMF_RECHNER':
      return 'source_priority';
    case 'LLM_FSM':
      return 'confidence';
    default:
      return 'manual';
  }
}

function trustToConfidence(trust?: CanonicalLike['trust']): number | null {
  switch (trust) {
    case 'high': return 0.98;
    case 'medium': return 0.8;
    case 'low': return 0.55;
    case 'suspicious': return 0.25;
    default: return null;
  }
}

function hitConfidence(origin?: string): number | null {
  switch (origin) {
    case 'REGEX_100%': return 0.99;
    case 'REGEX_3F': return 0.9;
    case 'LLM_FSM': return 0.65;
    default: return null;
  }
}

function getSourceFile(runInput: RunInputLike, workflowId: string, runId: string): string {
  const filePath = typeof runInput?.filePath === 'string' ? runInput.filePath : null;
  const filename = typeof runInput?.filename === 'string' ? runInput.filename : null;
  if (filename) return filename;
  if (filePath) return path.basename(filePath);
  return `${workflowId}/${runId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function primitiveOrNull(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function flattenNestedValues(value: unknown, prefix: string[] = []): Array<{ featureCode: string; value: unknown; valueText: string | null; datatype: ReturnType<typeof mapJsDatatype> }> {
  if (value == null) return [];
  if (Array.isArray(value)) {
    if (prefix.length === 0) return [];
    return [{ featureCode: prefix.join('.'), value, valueText: JSON.stringify(value), datatype: 'json' }];
  }
  if (typeof value === 'object') {
    const out: Array<{ featureCode: string; value: unknown; valueText: string | null; datatype: ReturnType<typeof mapJsDatatype> }> = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(...flattenNestedValues(child, [...prefix, key]));
    }
    return out;
  }
  if (prefix.length === 0) return [];
  return [{
    featureCode: prefix.join('.'),
    value,
    valueText: typeof value === 'string' ? value : String(value),
    datatype: mapJsDatatype(value),
  }];
}

async function appendValidatedRecords(targetFile: string, records: Array<Record<string, unknown>>, keyField: string): Promise<number> {
  if (records.length === 0) return 0;
  // @ts-expect-error external schema helper repo ships no .d.ts
  const mod = await import('../../../../gitchain-schema-v2/lib/index.mjs');
  let existing: Array<Record<string, unknown>> = [];
  if (fs.existsSync(targetFile)) existing = mod.loadRecords(targetFile);
  const merged = new Map<string, Record<string, unknown>>();
  for (const record of existing) {
    const key = String(record[keyField] ?? '');
    if (key) merged.set(key, record);
  }
  for (const record of records) {
    const key = String(record[keyField] ?? '');
    if (key) merged.set(key, record);
  }
  mod.writeValidatedFileByPath(targetFile, Array.from(merged.values()));
  return records.length;
}

function entityRecord(ctx: ExportContext, entityId: string, displayName: string, derivedFrom: string[]): Record<string, unknown> {
  return {
    product_id: entityId,
    article_number: entityId,
    display_name: displayName,
    brand: 'STURM',
    family: ctx.workflowId,
    language: 'de',
    derived_from: derivedFrom,
  };
}

function buildCanonicalExports(params: {
  ctx: ExportContext;
  stageId: string;
  canonicalLayer: Record<string, CanonicalLike>;
}) {
  const normalizedProducts = [] as Array<Record<string, unknown>>;
  const normalizedFeatures = [] as Array<Record<string, unknown>>;
  const normalizedValues = [] as Array<Record<string, unknown>>;
  const resolvedValues = [] as Array<Record<string, unknown>>;
  const sourceRefs = [] as Array<Record<string, unknown>>;
  const decisions = [] as Array<Record<string, unknown>>;

  for (const [featureCode, cv] of Object.entries(params.canonicalLayer || {})) {
    const anlage = typeof cv.anlage === 'string' && cv.anlage ? cv.anlage : null;
    const entityId = entityIdForAnlage(params.ctx, anlage);
    const displayName = anlage ? `${params.ctx.sourceFile} · Anlage ${anlage}` : params.ctx.rootEntityDisplayName;
    const candidateValueId = valueIdForEntityFeature(entityId, featureCode);
    const sourceRefId = `ref_${slug(entityId)}_${slug(featureCode)}`;
    const chosenValue = cv.normalizedNumber ?? cv.normalized ?? cv.value ?? null;
    const datatype = mapDatatype(cv.datentyp);
    const strategy = mapResolutionStrategy(cv.origin);
    const trace = [
      `sturm_stage:${params.stageId}`,
      `origin:${cv.origin ?? 'unknown'}`,
      `entity:${entityId}`,
      `datatype:${datatype}`,
      ...(Array.isArray(cv.trust_reasons) ? cv.trust_reasons.map((r) => `trust:${r}`) : []),
    ];

    normalizedProducts.push(entityRecord(params.ctx, entityId, displayName, [`${params.stageId}:${featureCode}`]));
    normalizedFeatures.push({
      feature_code: featureCode,
      label: cv.drucktext ?? featureCode,
      datatype,
      unit: null,
      etim_code: null,
      description: anlage ? `ELSTER Anlage ${anlage}` : 'STURM canonical layer',
    });
    normalizedValues.push({
      value_id: candidateValueId,
      entity_id: entityId,
      feature_code: featureCode,
      value: primitiveOrNull(chosenValue),
      value_text: typeof cv.value === 'string' ? cv.value : (typeof chosenValue === 'string' ? chosenValue : null),
      unit: null,
      datatype,
      language: 'de',
      normalizer: params.stageId,
      derived_from: [`${params.stageId}:${featureCode}`],
    });

    const sourceRefIds: string[] = [];
    if (typeof cv.page === 'number' || cv.evidence_line) {
      sourceRefIds.push(sourceRefId);
      sourceRefs.push({
        ref_id: sourceRefId,
        value_id: candidateValueId,
        document_id: params.ctx.primaryDocumentId,
        source_type: cv.evidence_line ? 'ocr_span' : 'pdf_page',
        location: {
          file: params.ctx.sourceFile,
          row: null,
          column: null,
          sheet: null,
          xpath: null,
          page: typeof cv.page === 'number' ? cv.page : null,
          bbox: null,
          quote: cv.evidence_line ?? null,
        },
        confidence: trustToConfidence(cv.trust),
      });
    }

    resolvedValues.push({
      resolved_id: `resolved_${slug(entityId)}_${slug(featureCode)}`,
      entity_id: entityId,
      feature_code: featureCode,
      chosen_value: chosenValue,
      unit: null,
      datatype,
      candidate_value_ids: [candidateValueId],
      resolution_strategy: strategy,
      decision_trace: trace.length ? trace : ['sturm_export'],
      ...(sourceRefIds.length ? { source_refs: sourceRefIds } : {}),
    });

    decisions.push({
      decision_id: `decision_${slug(entityId)}_${slug(featureCode)}`,
      entity_id: entityId,
      feature_code: featureCode,
      action: 'choose',
      chosen_value_id: candidateValueId,
      inputs: [candidateValueId],
      decision_trace: trace.length ? trace : ['sturm_export'],
      actor: 'sturm',
      decided_at: new Date().toISOString(),
      notes: `Exported from STURM canonical_layer stage ${params.stageId}`,
    });
  }

  return { normalizedProducts, normalizedFeatures, normalizedValues, resolvedValues, sourceRefs, decisions };
}

function buildPhaseHitExports(params: {
  ctx: ExportContext;
  stageId: string;
  output: Record<string, unknown>;
}) {
  const normalizedProducts = [] as Array<Record<string, unknown>>;
  const extractedFacts = [] as Array<Record<string, unknown>>;
  const normalizedFeatures = [] as Array<Record<string, unknown>>;
  const normalizedValues = [] as Array<Record<string, unknown>>;
  const perAnlage = asRecord(params.output.per_anlage);
  if (!perAnlage) return { normalizedProducts, extractedFacts, normalizedFeatures, normalizedValues };

  for (const [anlage, anlageValue] of Object.entries(perAnlage)) {
    const anlageRec = asRecord(anlageValue);
    if (!anlageRec) continue;
    const entityId = entityIdForAnlage(params.ctx, anlage);
    normalizedProducts.push(entityRecord(params.ctx, entityId, `${params.ctx.sourceFile} · Anlage ${anlage}`, [`${params.stageId}:${anlage}`]));

    for (const hitMapKey of ['regex_hits', 'llm_hits']) {
      const hitMap = asRecord(anlageRec[hitMapKey]);
      if (!hitMap) continue;
      for (const [featureCode, hitValue] of Object.entries(hitMap)) {
        const hit = asRecord(hitValue);
        if (!hit) continue;
        const origin = typeof hit.origin === 'string' ? hit.origin : params.stageId;
        const datentyp = mapDatatype(typeof hit.datentyp === 'string' ? hit.datentyp : undefined);
        const factId = `fact_${slug(entityId)}_${slug(featureCode)}`;
        extractedFacts.push({
          fact_id: factId,
          batch_id: params.ctx.runId,
          source_system: 'sturm',
          source_file: params.ctx.sourceFile,
          source_row: null,
          source_page: typeof hit.page === 'number' ? hit.page : null,
          source_bbox: null,
          subject_raw: entityId,
          predicate_raw: featureCode,
          value_raw: primitiveOrNull(hit.value ?? hit.normalized ?? null),
          unit_raw: null,
          language: 'de',
          extractor: origin,
          confidence: hitConfidence(origin),
          extracted_at: new Date().toISOString(),
        });
        normalizedFeatures.push({
          feature_code: featureCode,
          label: typeof hit.drucktext === 'string' && hit.drucktext ? hit.drucktext : featureCode,
          datatype: datentyp,
          unit: null,
          etim_code: null,
          description: `ELSTER Anlage ${anlage}`,
        });
        normalizedValues.push({
          value_id: valueIdForEntityFeature(entityId, featureCode),
          entity_id: entityId,
          feature_code: featureCode,
          value: primitiveOrNull(hit.normalized ?? hit.value ?? null),
          value_text: typeof hit.value === 'string' ? hit.value : null,
          unit: null,
          datatype: datentyp,
          language: 'de',
          normalizer: origin,
          derived_from: [factId],
        });
      }
    }
  }

  return { normalizedProducts, extractedFacts, normalizedFeatures, normalizedValues };
}

function buildNestedExports(params: {
  ctx: ExportContext;
  stageId: string;
  output: Record<string, unknown>;
}) {
  const normalizedProducts = [] as Array<Record<string, unknown>>;
  const normalizedValues = [] as Array<Record<string, unknown>>;
  const normalizedFeatures = [] as Array<Record<string, unknown>>;
  const nested = params.output.nested;
  if (nested === undefined) return { normalizedProducts, normalizedValues, normalizedFeatures };

  const leaves = flattenNestedValues(nested);
  normalizedProducts.push(entityRecord(params.ctx, params.ctx.rootEntityId, params.ctx.rootEntityDisplayName, [`${params.stageId}:nested`]));
  for (const leaf of leaves) {
    normalizedFeatures.push({
      feature_code: leaf.featureCode,
      label: leaf.featureCode.split('.').slice(-1)[0] || leaf.featureCode,
      datatype: leaf.datatype,
      unit: null,
      etim_code: null,
      description: `STURM nested extraction from ${params.stageId}`,
    });
    normalizedValues.push({
      value_id: valueIdForEntityFeature(params.ctx.rootEntityId, leaf.featureCode),
      entity_id: params.ctx.rootEntityId,
      feature_code: leaf.featureCode,
      value: primitiveOrNull(leaf.value),
      value_text: leaf.valueText,
      unit: null,
      datatype: leaf.datatype,
      language: 'de',
      normalizer: params.stageId,
      derived_from: [`${params.stageId}:${leaf.featureCode}`],
    });
  }

  return { normalizedProducts, normalizedValues, normalizedFeatures };
}

function buildDocumentExports(params: {
  ctx: ExportContext;
  stageId: string;
  output: Record<string, unknown>;
}) {
  const extractedDocuments = [] as Array<Record<string, unknown>>;
  const normalizedDocuments = [] as Array<Record<string, unknown>>;

  const pages = Array.isArray(params.output.pages) ? params.output.pages : null;
  if (pages) {
    const documentType = typeof params.output.primary_form === 'string' && params.output.primary_form
      ? params.output.primary_form
      : Array.isArray(params.output.erkannte_anlagen) && typeof params.output.erkannte_anlagen[0] === 'string'
        ? String(params.output.erkannte_anlagen[0])
        : 'ocr_document';
    extractedDocuments.push({
      document_id: params.ctx.primaryDocumentId,
      batch_id: params.ctx.runId,
      source_system: 'sturm',
      source_file: params.ctx.sourceFile,
      document_type: documentType,
      title_raw: params.ctx.sourceFile,
      language: 'de',
      page_count: pages.length,
      sha256: null,
      derived_from: [`${params.stageId}:pages`],
    });
    normalizedDocuments.push({
      document_id: params.ctx.primaryDocumentId,
      document_type: documentType,
      canonical_title: params.ctx.sourceFile,
      language: 'de',
      source_system: 'sturm',
      page_count: pages.length,
      derived_from: [params.ctx.primaryDocumentId],
    });
  }

  const subDocs = Array.isArray(params.output.subDocs) ? params.output.subDocs : null;
  if (subDocs) {
    for (const subDocValue of subDocs) {
      const subDoc = asRecord(subDocValue);
      if (!subDoc) continue;
      const subId = typeof subDoc.id === 'string' ? subDoc.id : `subdoc_${extractedDocuments.length}`;
      const title = typeof subDoc.title === 'string' && subDoc.title ? subDoc.title : subId;
      const documentType = typeof subDoc.classifierHint === 'string' && subDoc.classifierHint
        ? subDoc.classifierHint
        : (typeof subDoc.headerKind === 'string' && subDoc.headerKind ? subDoc.headerKind : 'sub_document');
      const pageCount = Array.isArray(subDoc.pages) ? subDoc.pages.length : null;
      const documentId = `doc_${slug(params.ctx.workflowId)}_${slug(params.ctx.runId)}_${slug(subId)}`;
      extractedDocuments.push({
        document_id: documentId,
        batch_id: params.ctx.runId,
        source_system: 'sturm',
        source_file: params.ctx.sourceFile,
        document_type: documentType,
        title_raw: title,
        language: 'de',
        page_count: pageCount,
        sha256: null,
        derived_from: [`${params.stageId}:${subId}`],
      });
      normalizedDocuments.push({
        document_id: documentId,
        document_type: documentType,
        canonical_title: title,
        language: 'de',
        source_system: 'sturm',
        page_count: pageCount,
        derived_from: [documentId],
      });
    }
  }

  return { extractedDocuments, normalizedDocuments };
}

function buildLinkExports(params: {
  ctx: ExportContext;
  normalizedProducts: Array<Record<string, unknown>>;
  stageId: string;
}) {
  const entityLinks = [] as Array<Record<string, unknown>>;
  const documentLinks = [] as Array<Record<string, unknown>>;
  const entityIds = new Set(
    params.normalizedProducts
      .map((r) => typeof r.product_id === 'string' ? r.product_id : null)
      .filter((v): v is string => Boolean(v))
  );

  if (entityIds.has(params.ctx.rootEntityId)) {
    documentLinks.push({
      link_id: `doclink_${slug(params.ctx.primaryDocumentId)}_${slug(params.ctx.rootEntityId)}`,
      document_id: params.ctx.primaryDocumentId,
      entity_id: params.ctx.rootEntityId,
      relationship: 'describes',
      confidence: 0.9,
      reason: `STURM ${params.stageId} produced root-level extracted values for this document`,
      page_span: null,
      derived_from: [`${params.stageId}:root`],
    });
  }

  for (const entityId of entityIds) {
    if (entityId === params.ctx.rootEntityId) continue;
    entityLinks.push({
      link_id: `entitylink_${slug(entityId)}_${slug(params.ctx.rootEntityId)}`,
      left_id: entityId,
      right_id: params.ctx.rootEntityId,
      link_type: 'belongs_to_family',
      confidence: 1,
      reason: 'ELSTER Anlage entity belongs to the same STURM run root entity',
      derived_from: [`${params.stageId}:anlage_partition`],
    });
    documentLinks.push({
      link_id: `doclink_${slug(params.ctx.primaryDocumentId)}_${slug(entityId)}`,
      document_id: params.ctx.primaryDocumentId,
      entity_id: entityId,
      relationship: 'evidences',
      confidence: 0.95,
      reason: `STURM ${params.stageId} extracted Anlage-scoped values evidenced by this document`,
      page_span: null,
      derived_from: [`${params.stageId}:anlage_values`],
    });
  }

  return { entityLinks, documentLinks };
}

function sameCandidateValue(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)
    && JSON.stringify(a.value_text ?? null) === JSON.stringify(b.value_text ?? null);
}

async function loadRecordsIfExists(targetFile: string): Promise<Array<Record<string, unknown>>> {
  if (!fs.existsSync(targetFile)) return [];
  // @ts-expect-error external schema helper repo ships no .d.ts
  const mod = await import('../../../../gitchain-schema-v2/lib/index.mjs');
  return mod.loadRecords(targetFile);
}

function buildConflictRecords(params: {
  existingNormalizedValues: Array<Record<string, unknown>>;
  incomingNormalizedValues: Array<Record<string, unknown>>;
  resolvedValues: Array<Record<string, unknown>>;
}) {
  const conflicts = [] as Array<Record<string, unknown>>;
  const existingByValueId = new Map<string, Record<string, unknown>>();
  for (const record of params.existingNormalizedValues) {
    const key = typeof record.value_id === 'string' ? record.value_id : null;
    if (key) existingByValueId.set(key, record);
  }
  const resolvedByEntityFeature = new Map<string, Record<string, unknown>>();
  for (const record of params.resolvedValues) {
    const entityId = typeof record.entity_id === 'string' ? record.entity_id : null;
    const featureCode = typeof record.feature_code === 'string' ? record.feature_code : null;
    if (entityId && featureCode) resolvedByEntityFeature.set(`${entityId}::${featureCode}`, record);
  }

  for (const incoming of params.incomingNormalizedValues) {
    const valueId = typeof incoming.value_id === 'string' ? incoming.value_id : null;
    const entityId = typeof incoming.entity_id === 'string' ? incoming.entity_id : null;
    const featureCode = typeof incoming.feature_code === 'string' ? incoming.feature_code : null;
    if (!valueId || !entityId || !featureCode) continue;
    const existing = existingByValueId.get(valueId);
    if (!existing) continue;
    if (sameCandidateValue(existing, incoming)) continue;

    const resolved = resolvedByEntityFeature.get(`${entityId}::${featureCode}`);
    const existingTag = typeof existing.normalizer === 'string' && existing.normalizer ? existing.normalizer : 'existing';
    const incomingTag = typeof incoming.normalizer === 'string' && incoming.normalizer ? incoming.normalizer : 'incoming';
    conflicts.push({
      conflict_id: `conflict_${slug(entityId)}_${slug(featureCode)}`,
      entity_id: entityId,
      feature_code: featureCode,
      candidates: [
        {
          value_id: `${valueId}__${slug(existingTag)}`,
          value: existing.value ?? existing.value_text ?? null,
          unit: typeof existing.unit === 'string' ? existing.unit : null,
          source_refs: [],
        },
        {
          value_id: `${valueId}__${slug(incomingTag)}`,
          value: incoming.value ?? incoming.value_text ?? null,
          unit: typeof incoming.unit === 'string' ? incoming.unit : null,
          source_refs: [],
        },
      ],
      status: resolved ? 'resolved' : 'open',
    });
  }

  return conflicts;
}

export async function exportStageOutputAsRawFirst(params: {
  runRoot: string;
  workflowId: string;
  runId: string;
  stageId: string;
  output: unknown;
  runInput?: RunInputLike;
}): Promise<ExportSummary | null> {
  const out = asRecord(params.output);
  if (!out) return null;

  const targetRoot = path.join(params.runRoot, '_gitchain_v2');
  const sourceFile = getSourceFile(params.runInput, params.workflowId, params.runId);
  const ctx = createContext(params.workflowId, params.runId, sourceFile);

  const documents = buildDocumentExports({ ctx, stageId: params.stageId, output: out });
  const hits = buildPhaseHitExports({ ctx, stageId: params.stageId, output: out });
  const nested = buildNestedExports({ ctx, stageId: params.stageId, output: out });
  const canonical = out.canonical_layer && typeof out.canonical_layer === 'object'
    ? buildCanonicalExports({ ctx, stageId: params.stageId, canonicalLayer: out.canonical_layer as Record<string, CanonicalLike> })
    : { normalizedProducts: [], normalizedFeatures: [], normalizedValues: [], resolvedValues: [], sourceRefs: [], decisions: [] };

  const allNormalizedProducts = [...hits.normalizedProducts, ...nested.normalizedProducts, ...canonical.normalizedProducts];
  const links = buildLinkExports({
    ctx,
    normalizedProducts: allNormalizedProducts,
    stageId: params.stageId,
  });

  const normalizedValuesPath = path.join(targetRoot, '02_normalized', 'values.jsonl');
  const existingNormalizedValues = await loadRecordsIfExists(normalizedValuesPath);
  const incomingNormalizedValues = [...hits.normalizedValues, ...nested.normalizedValues, ...canonical.normalizedValues];
  const conflictRecords = buildConflictRecords({
    existingNormalizedValues,
    incomingNormalizedValues,
    resolvedValues: canonical.resolvedValues,
  });

  const extractedDocuments = await appendValidatedRecords(path.join(targetRoot, '01_extracted', 'documents.jsonl'), documents.extractedDocuments, 'document_id');
  const extractedFacts = await appendValidatedRecords(path.join(targetRoot, '01_extracted', 'facts.jsonl'), hits.extractedFacts, 'fact_id');
  const normalizedProducts = await appendValidatedRecords(path.join(targetRoot, '02_normalized', 'products.jsonl'), allNormalizedProducts, 'product_id');
  const normalizedDocuments = await appendValidatedRecords(path.join(targetRoot, '02_normalized', 'documents.jsonl'), documents.normalizedDocuments, 'document_id');
  const normalizedFeatures = await appendValidatedRecords(path.join(targetRoot, '02_normalized', 'features.jsonl'), [...hits.normalizedFeatures, ...nested.normalizedFeatures, ...canonical.normalizedFeatures], 'feature_code');
  const normalizedValues = await appendValidatedRecords(normalizedValuesPath, incomingNormalizedValues, 'value_id');
  const entityLinks = await appendValidatedRecords(path.join(targetRoot, '03_linked', 'entity_links.jsonl'), links.entityLinks, 'link_id');
  const documentLinks = await appendValidatedRecords(path.join(targetRoot, '03_linked', 'document_links.jsonl'), links.documentLinks, 'link_id');
  const sourceRefs = await appendValidatedRecords(path.join(targetRoot, '03_linked', 'source_refs.jsonl'), canonical.sourceRefs, 'ref_id');
  const resolvedValues = await appendValidatedRecords(path.join(targetRoot, '04_resolved', 'resolved_values.jsonl'), canonical.resolvedValues, 'resolved_id');
  const conflicts = await appendValidatedRecords(path.join(targetRoot, '04_resolved', 'conflicts.jsonl'), conflictRecords, 'conflict_id');
  const decisions = await appendValidatedRecords(path.join(targetRoot, '04_resolved', 'decisions.jsonl'), canonical.decisions, 'decision_id');

  if ([extractedDocuments, extractedFacts, normalizedProducts, normalizedDocuments, normalizedFeatures, normalizedValues, entityLinks, documentLinks, sourceRefs, resolvedValues, conflicts, decisions].every((count) => count === 0)) {
    return null;
  }

  return {
    extractedDocuments,
    extractedFacts,
    normalizedProducts,
    normalizedDocuments,
    normalizedFeatures,
    normalizedValues,
    entityLinks,
    documentLinks,
    sourceRefs,
    resolvedValues,
    conflicts,
    decisions,
    targetRoot,
  };
}
