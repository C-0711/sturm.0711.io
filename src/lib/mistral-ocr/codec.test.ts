/**
 * Contract test for the mistral-ocr codec.
 *
 * Asserts the EXACT wire shape sent to api.mistral.ai/v1/ocr for several
 * realistic config inputs. Pins the contract so future drift between the
 * playground's stale code-export and the real API is caught immediately.
 *
 * Run: tsx src/lib/mistral-ocr/codec.test.ts (no network).
 */

import {
  configToApiRequest,
  pageRangeStringToArray,
  arrayToPageRangeString,
  parseApiResponse,
  normalizeConfig,
  type DocumentChunk,
  type MistralOcrConfig,
  type MistralOcrResponse,
} from './index.ts';

let pass = 0, fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}
function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? undefined : { actual, expected });
}

console.log('\n=== Page range parser (1-indexed UI ⇄ 0-indexed wire) ===');
eq('"1-4,8" → [0,1,2,3,7]', pageRangeStringToArray('1-4,8'), [0, 1, 2, 3, 7]);
eq('"3" → [2]', pageRangeStringToArray('3'), [2]);
eq('empty → []', pageRangeStringToArray(''), []);
eq('"2,2,3" dedup → [1,2]', pageRangeStringToArray('2,2,3'), [1, 2]);
eq('round-trip [0,1,2,3,7] → "1-4,8"', arrayToPageRangeString([0, 1, 2, 3, 7]), '1-4,8');
try { pageRangeStringToArray('0'); assert('reject 0 (1-indexed)', false); }
catch { assert('reject 0 (1-indexed)', true); }
try { pageRangeStringToArray('5-2'); assert('reject inverted range', false); }
catch { assert('reject inverted range', true); }

console.log('\n=== Backwards-compat config normalization ===');
const legacy = normalizeConfig({ schema: { type: 'object' }, schemaName: 'foo' });
assert('legacy schema → documentAnnotation.schema',
  legacy.documentAnnotation?.schema?.type === 'object');
assert('legacy schemaName → documentAnnotation.name',
  legacy.documentAnnotation?.name === 'foo');
assert('top-level schema field deleted',
  !('schema' in legacy));

console.log('\n=== Wire request: minimal config ===');
const doc: DocumentChunk = { type: 'document_url', document_url: 'data:application/pdf;base64,xx' };
const minReq = configToApiRequest({}, doc, { runId: 'r1', stageId: 's1' });
eq('default model', minReq.model, 'mistral-ocr-latest');
eq('document chunk passes through', minReq.document, doc);
eq('id = runId:stageId', minReq.id, 'r1:s1');
assert('no pages emitted when unset', minReq.pages === undefined);
assert('no annotation format when no schema', minReq.document_annotation_format === undefined);
assert('no extract_header when unset', minReq.extract_header === undefined);

console.log('\n=== Wire request: full config (the contract) ===');
const fullCfg: MistralOcrConfig = {
  model: 'mistral-ocr-latest',
  pages: [0, 2, 7],
  extractHeader: true,
  extractFooter: false,
  tableFormat: 'markdown',
  includeImageBase64: true,
  imageLimit: 5,
  imageMinSize: 80,
  documentAnnotation: {
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    prompt: 'Beträge in EUR.',
    name: 'extraction',
  },
  // imageAnnotation is intentionally NOT a typed field (Mistral 422s on the wire);
  // this loose-typed extension is here to confirm the codec drops it.
  ...({ imageAnnotation: { schema: { type: 'object' } } } as Record<string, unknown>),
  bboxAnnotation: { schema: { type: 'object' } },
  confidenceScoresGranularity: 'word',
};
const fullReq = configToApiRequest(fullCfg, doc, { runId: 'r2', stageId: 'ocr' });

// Snake_case wire keys — playground export shows extract_tables but the
// published spec uses table_format. We must NOT emit extract_tables.
assert('emits table_format (not extract_tables)',
  'table_format' in fullReq && !('extract_tables' in (fullReq as any)));
eq('table_format value', fullReq.table_format, 'markdown');
eq('extract_header passes through', fullReq.extract_header, true);
eq('extract_footer passes through', fullReq.extract_footer, false);
eq('include_image_base64', fullReq.include_image_base64, true);
eq('image_limit', fullReq.image_limit, 5);
eq('image_min_size', fullReq.image_min_size, 80);
eq('pages stays 0-indexed array', fullReq.pages, [0, 2, 7]);
eq('confidence_scores_granularity', fullReq.confidence_scores_granularity, 'word');

// Annotation envelopes: type=json_schema, name, schema, strict:true
const da = fullReq.document_annotation_format!;
eq('document_annotation_format.type', da.type, 'json_schema');
eq('document_annotation_format.json_schema.name', da.json_schema.name, 'extraction');
eq('document_annotation_format.json_schema.strict', da.json_schema.strict, true);
assert('document_annotation_format.json_schema.schema present',
  da.json_schema.schema?.type === 'object');
eq('document_annotation_prompt as separate top-level field',
  fullReq.document_annotation_prompt, 'Beträge in EUR.');

// Per live API testing: `image_annotation_format` returns 422 extra_forbidden.
// The codec correctly drops the imageAnnotation config; `bbox_annotation_format`
// covers both bounding boxes and per-image extraction per the spec.
assert('image_annotation_format intentionally NOT emitted (422 extra_forbidden)',
  (fullReq as unknown as Record<string, unknown>).image_annotation_format === undefined);

const ba = fullReq.bbox_annotation_format!;
assert('bbox_annotation_format wrapped', ba?.type === 'json_schema');
eq('bbox_annotation default name', ba.json_schema.name, 'bbox_annotation');

console.log('\n=== Wire request: confidence=none → field omitted ===');
const noConf = configToApiRequest({ confidenceScoresGranularity: 'none' }, doc);
assert('confidence none → field omitted',
  noConf.confidence_scores_granularity === undefined);

console.log('\n=== Response parsing: documentAnnotation JSON-decoded once ===');
const fakeResp: MistralOcrResponse = {
  model: 'mistral-ocr-latest',
  document_annotation: JSON.stringify({ name: 'Christoph', amount: 42 }),
  pages: [{
    index: 0, markdown: 'Hallo Christoph. Betrag: 42 EUR.',
    dimensions: { dpi: 200, height: 1000, width: 800 },
    header: null, footer: null, hyperlinks: [], images: [], tables: [],
  }],
  usage_info: { pages_processed: 1, doc_size_bytes: 1024 },
};
const parsed = parseApiResponse(fakeResp, fullCfg, Date.now() - 100);
assert('documentAnnotation is parsed object (not string)',
  typeof parsed.documentAnnotation === 'object'
  && (parsed.documentAnnotation as any)?.name === 'Christoph');
eq('pages[].chars derived from markdown', parsed.pages[0].chars,
  'Hallo Christoph. Betrag: 42 EUR.'.length);
eq('text concatenates pages', parsed.text, 'Hallo Christoph. Betrag: 42 EUR.');
eq('usage.pagesProcessed', parsed.usage.pagesProcessed, 1);
eq('usage.docSizeBytes', parsed.usage.docSizeBytes, 1024);

console.log('\n=== Response parsing: doubly-encoded annotation tolerated ===');
const dblResp: MistralOcrResponse = {
  ...fakeResp,
  document_annotation: JSON.stringify(JSON.stringify({ name: 'Foo' })),
};
const dbl = parseApiResponse(dblResp, fullCfg, Date.now());
assert('double-encoded JSON parsed through',
  (dbl.documentAnnotation as any)?.name === 'Foo');

console.log('\n=== Hallucination flag: extracted value not in OCR text ===');
const hallResp: MistralOcrResponse = {
  ...fakeResp,
  document_annotation: JSON.stringify({ name: 'NotInDoc', amount: 42 }),
  pages: [{ ...fakeResp.pages[0], markdown: 'Hallo Christoph.' }],
};
const halls = parseApiResponse(hallResp, fullCfg, Date.now()).hallucinations;
assert('flags "NotInDoc" as hallucination',
  halls.some(h => h.value === 'NotInDoc'));
assert('does NOT flag "Christoph" (substring of OCR text)',
  !halls.some(h => h.value === 'Christoph'));

console.log('\n=== Validation: required field missing ===');
const valResp: MistralOcrResponse = {
  ...fakeResp,
  document_annotation: JSON.stringify({ amount: 42 }), // missing required `name`
};
const val = parseApiResponse(valResp, fullCfg, Date.now()).validation.documentAnnotation;
assert('required key missing flagged',
  val.some(i => i.path === '$.name' && /required/.test(i.message)));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
