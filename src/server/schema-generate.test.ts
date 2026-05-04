/**
 * Contract tests for src/server/schema-generate.ts (deterministic pieces only).
 *
 * Run: tsx src/server/schema-generate.test.ts (no network)
 */

import {
  validateSoundness,
  scoreCandidate,
  PLAYGROUND_PROMPT,
  PLAYGROUND_META_SCHEMA,
  callPlaygroundChatForSchema,
  type SoundnessIssue,
} from './schema-generate.ts';
import type { JsonSchema } from '../lib/mistral-ocr/types.ts';
import * as http from 'node:http';

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

console.log('\n=== Playground meta-schema sanity ===');
assert('PLAYGROUND_META_SCHEMA top-level required name+schema',
  Array.isArray(PLAYGROUND_META_SCHEMA.required)
    && PLAYGROUND_META_SCHEMA.required.includes('name')
    && PLAYGROUND_META_SCHEMA.required.includes('schema'));
assert('PLAYGROUND_META_SCHEMA additionalProperties:false',
  PLAYGROUND_META_SCHEMA.additionalProperties === false);
assert('PLAYGROUND_PROMPT contains the 5 numbered rules',
  /\n1\. /.test(PLAYGROUND_PROMPT) && /\n5\. /.test(PLAYGROUND_PROMPT));
assert('PLAYGROUND_PROMPT does NOT enforce snake_case (mirrors playground)',
  !/snake_case/i.test(PLAYGROUND_PROMPT));

console.log('\n=== Soundness validator: clean schema ===');
const clean: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'amount'],
  properties: {
    name: { type: 'string', description: 'name' },
    amount: { type: 'number', description: 'EUR amount' },
  },
};
eq('clean → 0 issues', validateSoundness(clean).length, 0);

console.log('\n=== Soundness validator: rule A — missing additionalProperties ===');
const noAP: JsonSchema = { type: 'object', required: ['x'], properties: { x: { type: 'string' } } };
const aIssues = validateSoundness(noAP);
assert('rule A flagged on root', aIssues.some(i => i.rule === 'A' && i.path === '$'));

console.log('\n=== Soundness validator: rule B — property not in required ===');
const missingReq: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['a'],
  properties: { a: { type: 'string' }, b: { type: 'string' } },
};
const bIssues = validateSoundness(missingReq);
assert('rule B flagged for "b"',
  bIssues.some((i: SoundnessIssue) => i.rule === 'B' && i.path === '$.b'));

console.log('\n=== Soundness validator: rule C — non-snake_case key (warn-only) ===');
const badKey: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['Foo'],
  properties: { Foo: { type: 'string' } },
};
const cIssues = validateSoundness(badKey);
assert('rule C flagged for "Foo"', cIssues.some(i => i.rule === 'C'));

console.log('\n=== Soundness validator: rule D — array missing items ===');
const noItems: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['xs'],
  properties: { xs: { type: 'array' } },
};
const dIssues = validateSoundness(noItems);
assert('rule D flagged for missing items', dIssues.some(i => i.rule === 'D'));

console.log('\n=== Soundness validator: rule D — run-2 bug pattern ===');
const run2Bug: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['xs'],
  properties: {
    xs: {
      type: 'array',
      items: { type: 'string', properties: { foo: { type: 'string' } } } as JsonSchema,
    },
  },
};
const dBugIssues = validateSoundness(run2Bug);
assert('rule D flagged the run-2 hybrid items bug',
  dBugIssues.some(i => i.rule === 'D' && i.path.includes('items')));

console.log('\n=== Soundness validator: nested object inherits all rules ===');
const nested: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['child'],
  properties: {
    child: {
      type: 'object',
      required: [],
      properties: { Bad: { type: 'string' } },
    },
  },
};
const nIssues = validateSoundness(nested);
assert('nested rule A on $.child', nIssues.some(i => i.rule === 'A' && i.path === '$.child'));
assert('nested rule B on $.child.Bad', nIssues.some(i => i.rule === 'B' && i.path === '$.child.Bad'));
assert('nested rule C on $.child.Bad', nIssues.some(i => i.rule === 'C' && i.path === '$.child.Bad'));

console.log('\n=== Scorer: counts props/formats/enums ===');
const rich: JsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['iban', 'date', 'kind', 'items'],
  properties: {
    iban: { type: 'string', format: 'iban', description: 'iban' },
    date: { type: 'string', format: 'date', description: 'date' },
    kind: { type: 'string', enum: ['a', 'b'], description: 'kind' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['amount'],
        properties: { amount: { type: 'number', description: 'EUR' } },
      },
    },
  },
};
const richIssues = validateSoundness(rich);
const richMetrics = scoreCandidate(rich, richIssues);
eq('issues=0 on rich', richIssues.length, 0);
eq('props counted (top 4 + nested 1 = 5)', richMetrics.props, 5);
eq('formats counted (iban + date)', richMetrics.formats, 2);
eq('enums counted (kind)', richMetrics.enums, 1);
eq('score = 5 + 4 + 1.5', richMetrics.score, 10.5);

console.log('\n=== Scorer: penalties ===');
function makeDeep(d: number): JsonSchema {
  if (d === 0) return { type: 'string', description: 'x' };
  return {
    type: 'object', additionalProperties: false, required: ['x'],
    properties: { x: makeDeep(d - 1) },
  };
}
const deep = makeDeep(7);
const dMetrics = scoreCandidate(deep, []);
assert('depth>5 penalty applied', dMetrics.score < dMetrics.props);
assert('depth recorded ≥ 7', dMetrics.depth >= 7);

console.log('\n=== Scorer: issues weighted -10 each ===');
const issues: SoundnessIssue[] = [
  { path: '$', rule: 'A', message: 'a' },
  { path: '$.x', rule: 'B', message: 'b' },
];
const m2 = scoreCandidate(clean, issues);
const m1 = scoreCandidate(clean, []);
eq('score drops by 20 for 2 issues', m1.score - m2.score, 20);

console.log('\n=== Playground chat call: shape contract ===');
// Mock the chat endpoint and verify we send the exact playground request.
function startMockServer(handler: (body: unknown, req: http.IncomingMessage) => unknown): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { /* */ }
        const out = handler(body, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let captured: any = null;
const mock = await startMockServer((body) => {
  captured = body;
  return {
    choices: [{ message: { content: JSON.stringify({ name: 'Hauptvordruck_ESt_1_A', schema: rich }) } }],
    usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
  };
});

const result = await callPlaygroundChatForSchema({
  documentUrl: 'https://example.com/blob.pdf?sas=token',
  apiKey: 'test-key',
  baseUrl: mock.url,
});

eq('model is mistral-small-latest', captured?.model, 'mistral-small-latest');
assert('messages[0] has document_url part',
  Array.isArray(captured?.messages?.[0]?.content)
    && captured.messages[0].content.some((p: any) => p.type === 'document_url' && p.document_url === 'https://example.com/blob.pdf?sas=token'));
assert('messages[0] has text part with playground prompt',
  captured?.messages?.[0]?.content?.some?.((p: any) => p.type === 'text' && p.text === PLAYGROUND_PROMPT));
eq('response_format json_schema name is document_schema_response',
  captured?.response_format?.json_schema?.name, 'document_schema_response');
eq('response_format meta-schema is the playground meta-schema',
  captured?.response_format?.json_schema?.schema, PLAYGROUND_META_SCHEMA);
assert('NO temperature/random_seed/system role (playground sends none)',
  captured?.temperature === undefined
    && captured?.random_seed === undefined
    && !captured?.messages?.some?.((m: any) => m.role === 'system'));
eq('parsed.name returned', result.parsed.name, 'Hauptvordruck_ESt_1_A');
eq('parsed.schema returned', result.parsed.schema, rich);
eq('usage passed through', result.usage.total_tokens, 100);
await mock.close();

console.log('\n=== Playground chat call: rejects empty content ===');
const mockEmpty = await startMockServer(() => ({
  choices: [{ message: { content: '' } }],
  usage: {},
}));
let threwEmpty = false;
try {
  await callPlaygroundChatForSchema({
    documentUrl: 'https://x/y.pdf',
    apiKey: 'k',
    baseUrl: mockEmpty.url,
  });
} catch (e) {
  threwEmpty = true;
  assert('empty content error mentions empty', /empty assistant content/.test((e as Error).message));
}
assert('throws on empty content', threwEmpty);
await mockEmpty.close();

console.log('\n=== Playground chat call: rejects malformed content ===');
const mockBad = await startMockServer(() => ({
  choices: [{ message: { content: 'not json {' } }],
  usage: {},
}));
let threwBad = false;
try {
  await callPlaygroundChatForSchema({
    documentUrl: 'https://x/y.pdf',
    apiKey: 'k',
    baseUrl: mockBad.url,
  });
} catch (e) {
  threwBad = true;
  assert('malformed content error mentions not JSON', /not JSON/.test((e as Error).message));
}
assert('throws on malformed content', threwBad);
await mockBad.close();

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
