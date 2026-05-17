/**
 * Run: npx tsx src/lib/vllm-vision.test.ts
 *
 * Tests for the vLLM multi-image + JSON-schema wrapper. Uses an injected
 * fetchImpl mock + a 1×1 PNG fixture written to /tmp so we exercise the
 * base64 path without any network.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { callVllmVision, VllmVisionError } from './vllm-vision.ts';

const PNG_1X1_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c63f8cfc0000000020001e2266c540000000049454e44ae426082';
const PNG_1X1 = Buffer.from(PNG_1X1_HEX, 'hex');

let fixtureDir: string | null = null;
const fixturePaths: string[] = [];

async function ensureFixtures(count: number): Promise<string[]> {
  if (!fixtureDir) {
    fixtureDir = await mkdtemp(path.join(tmpdir(), 'vllm-vision-test-'));
  }
  while (fixturePaths.length < count) {
    const p = path.join(fixtureDir, `img-${fixturePaths.length}.png`);
    await writeFile(p, PNG_1X1);
    fixturePaths.push(p);
  }
  return fixturePaths.slice(0, count);
}

const baseSchema = {
  name: 'test_schema',
  schema: { type: 'object', properties: { foo: { type: 'string' } } },
  strict: true,
};

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 1234, completion_tokens: 56 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('happy path: returns parsed JSON + telemetry', async () => {
  const [p] = await ensureFixtures(1);
  const expected = { foo: 'bar', baz: null };

  let captured: { url: string; body: unknown } | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')),
    };
    return okResponse(JSON.stringify(expected));
  };

  const result = await callVllmVision({
    vllmUrl: 'http://example.test:11435',
    model: 'gemma4-mm',
    imagePaths: [p!],
    textInstructions: 'extract foo',
    jsonSchema: baseSchema,
    fetchImpl,
  });

  assert.deepEqual(result.parsed, expected);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.promptTokens, 1234);
  assert.equal(result.completionTokens, 56);
  assert.ok(result.wallclockMs >= 0);
  assert.ok(captured, 'fetch was called');
  const c = captured as { url: string; body: Record<string, unknown> };
  assert.equal(c.url, 'http://example.test:11435/v1/chat/completions');
  assert.equal((c.body as { model: string }).model, 'gemma4-mm');
  assert.equal((c.body as { stream: boolean }).stream, false);
  const rf = (c.body as { response_format: { type: string; json_schema: unknown } }).response_format;
  assert.equal(rf.type, 'json_schema');
  assert.deepEqual(rf.json_schema, baseSchema);
});

test('0 images → throws VllmVisionError stage:request', async () => {
  await assert.rejects(
    () =>
      callVllmVision({
        vllmUrl: 'http://x',
        model: 'gemma4-mm',
        imagePaths: [],
        textInstructions: 't',
        jsonSchema: baseSchema,
        fetchImpl: async () => okResponse('{}'),
      }),
    (e: unknown) => e instanceof VllmVisionError && e.stage === 'request',
  );
});

test('5 images → throws (Gemma-4 limit)', async () => {
  const paths = await ensureFixtures(5);
  await assert.rejects(
    () =>
      callVllmVision({
        vllmUrl: 'http://x',
        model: 'gemma4-mm',
        imagePaths: paths,
        textInstructions: 't',
        jsonSchema: baseSchema,
        fetchImpl: async () => okResponse('{}'),
      }),
    (e: unknown) =>
      e instanceof VllmVisionError &&
      e.stage === 'request' &&
      /limit/i.test(e.message),
  );
});

test('HTTP 400 → throws stage:http with status + body', async () => {
  const [p] = await ensureFixtures(1);
  const fetchImpl: typeof fetch = async () =>
    new Response('bad schema', { status: 400 });

  await assert.rejects(
    () =>
      callVllmVision({
        vllmUrl: 'http://x',
        model: 'gemma4-mm',
        imagePaths: [p!],
        textInstructions: 't',
        jsonSchema: baseSchema,
        fetchImpl,
      }),
    (e: unknown) =>
      e instanceof VllmVisionError &&
      e.stage === 'http' &&
      e.httpStatus === 400 &&
      e.body === 'bad schema',
  );
});

test('non-JSON content → throws stage:parse with raw content in body', async () => {
  const [p] = await ensureFixtures(1);
  const fetchImpl: typeof fetch = async () => okResponse('not-json-at-all{');

  await assert.rejects(
    () =>
      callVllmVision({
        vllmUrl: 'http://x',
        model: 'gemma4-mm',
        imagePaths: [p!],
        textInstructions: 't',
        jsonSchema: baseSchema,
        fetchImpl,
      }),
    (e: unknown) =>
      e instanceof VllmVisionError &&
      e.stage === 'parse' &&
      e.body === 'not-json-at-all{',
  );
});

test('timeout: fetch hangs, throws stage:timeout', async () => {
  const [p] = await ensureFixtures(1);
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal as AbortSignal | undefined;
      if (sig) {
        sig.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      }
    });

  await assert.rejects(
    () =>
      callVllmVision({
        vllmUrl: 'http://x',
        model: 'gemma4-mm',
        imagePaths: [p!],
        textInstructions: 't',
        jsonSchema: baseSchema,
        timeoutMs: 100,
        fetchImpl,
      }),
    (e: unknown) => e instanceof VllmVisionError && e.stage === 'timeout',
  );
});

test('caller abort mid-flight → throws stage:aborted', async () => {
  const [p] = await ensureFixtures(1);
  const ac = new AbortController();
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal as AbortSignal | undefined;
      if (sig) {
        sig.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      }
    });

  setTimeout(() => ac.abort(), 20);
  await assert.rejects(
    () =>
      callVllmVision({
        vllmUrl: 'http://x',
        model: 'gemma4-mm',
        imagePaths: [p!],
        textInstructions: 't',
        jsonSchema: baseSchema,
        timeoutMs: 5000,
        signal: ac.signal,
        fetchImpl,
      }),
    (e: unknown) => e instanceof VllmVisionError && e.stage === 'aborted',
  );
});

test('image base64 produces data:image/png;base64,... prefix', async () => {
  const [p] = await ensureFixtures(1);
  let capturedBody: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body ?? '{}'));
    return okResponse('{}');
  };

  await callVllmVision({
    vllmUrl: 'http://x',
    model: 'gemma4-mm',
    imagePaths: [p!],
    textInstructions: 'hello',
    jsonSchema: baseSchema,
    fetchImpl,
  });

  assert.ok(capturedBody, 'fetch captured');
  const messages = (capturedBody as { messages: Array<{ content: unknown[] }> }).messages;
  const content = messages[0]!.content;
  // First entries are image_url; last is text
  const imgPart = content[0] as { type: string; image_url: { url: string } };
  assert.equal(imgPart.type, 'image_url');
  assert.ok(
    imgPart.image_url.url.startsWith('data:image/png;base64,'),
    `expected data URL prefix, got: ${imgPart.image_url.url.slice(0, 40)}`,
  );
  const expectedB64 = PNG_1X1.toString('base64');
  assert.ok(
    imgPart.image_url.url.endsWith(expectedB64),
    'data URL must end with the PNG base64',
  );
  const textPart = content[content.length - 1] as { type: string; text: string };
  assert.equal(textPart.type, 'text');
  assert.equal(textPart.text, 'hello');
});
