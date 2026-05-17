/**
 * Tests fuer den Orchestrator-Chat-Loop.
 *
 * Stubbt vLLM mit einem fake-fetch, der zwei Responses liefert:
 *   1) Tool-Call (auswertung)
 *   2) Stop mit Text
 *
 * Asserted: SSE-Events in der korrekten Reihenfolge + Handler-Argumente.
 *
 * Run: tsx src/server/orchestrator.test.ts
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runChatLoop, type ChatMessage } from './orchestrator.ts';
import { defineApplication } from '../core/application.ts';
import { registerApplication } from '../core/registry.ts';
import { saveInstanceFile } from './applications.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

// ─────────────────────────────────────────────────────────────────────────
// SSE-Sink-Stub
// ─────────────────────────────────────────────────────────────────────────

interface CapturedEvent { name: string; payload: unknown }

function makeCapturingSink() {
  const events: CapturedEvent[] = [];
  let closed = false;
  return {
    sink: {
      event(name: string, payload: unknown) { events.push({ name, payload }); },
      end() { closed = true; },
      get closed() { return closed; },
    },
    events,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// vLLM-Fetch-Stub
// ─────────────────────────────────────────────────────────────────────────

/** Liefert eine fetch-Implementierung, die deterministisch eine vordefinierte
 *  SSE-Response-Sequenz zurueckgibt — eine pro Call. */
function makeFakeFetch(responseChunks: string[][]): typeof fetch {
  let callIdx = 0;
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    const chunks = responseChunks[callIdx++];
    if (!chunks) throw new Error(`fake-fetch: out of responses at call ${callIdx}`);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

/** Helfer: baut einen vLLM-konformen SSE-Chunk fuer ein einzelnes Delta. */
function deltaChunk(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

async function setupTempCase(): Promise<{ appId: string; caseId: string; appDir: string; runsDir: string; rootCwd: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-test-'));
  const appId = 'test-orchestrator-app';
  const caseId = 'fall-mustermann-test';
  const appDir = path.join(tmp, 'applications-data');
  const runsDir = path.join(tmp, 'runs');
  // Register a dummy application so getApplication() works.
  try {
    registerApplication(defineApplication({
      id: appId,
      name: 'Test Orchestrator App',
      description: 'Test',
      category: 'other',
      mandantRequired: false,
      containers: [],
      workflows: { extraction: 'dummy-extraction' },
      tools: [],
    }));
  } catch {
    // Bereits registriert (anderer Lauf).
  }
  await fs.mkdir(path.join(appDir, appId), { recursive: true });
  const workspacePath = path.join('workspaces', appId, caseId);
  await fs.mkdir(path.join(tmp, workspacePath, 'inbox'), { recursive: true });
  // Manifest mit einem dummy doc.
  await fs.writeFile(
    path.join(tmp, workspacePath, 'inbox', '_manifest.json'),
    JSON.stringify({
      version: 1, caseId, appId,
      documents: [{
        runId: 'run-1',
        filename: 'beleg.pdf',
        inboxPath: 'inbox/beleg.pdf',
        sha256: 'a'.repeat(64),
        size: 1234,
        uploadedAt: new Date().toISOString(),
        anlagen: ['N'],
        fieldsExtracted: 5,
        trustBreakdown: { high: 3, medium: 2, suspicious: 0, low: 0 },
        mimeType: 'application/pdf',
      }],
      updatedAt: new Date().toISOString(),
    }, null, 2),
  );
  await saveInstanceFile(appDir, {
    caseId, appId,
    displayName: 'Test Mustermann',
    mandantId: 'M-001',
    veranlagungsjahr: 2024,
    status: 'in_bearbeitung',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runs: ['run-1'],
    workspacePath,
  });
  // Fake BMF-Auswertung im Run-Ordner.
  const runDir = path.join(runsDir, 'dummy-extraction', 'run-1');
  await fs.mkdir(path.join(runDir, 'phase6BmfRechner'), { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'phase6BmfRechner', 'output.json'),
    JSON.stringify({
      zu_versteuerndes_einkommen: 45000,
      tarifliche_est: 8500,
      festzusetzende_steuer: 8967,
      soli: 0,
      erstattung: 617.42,
      eingabewerte: { foo: 'bar' },
      canonical_layer: {
        '0102301': { value: '45000', normalized: '45000', trust: 'high', anlage: 'N', origin: 'LLM_FSM' },
      },
    }),
  );
  return { appId, caseId, appDir, runsDir, rootCwd: tmp };
}

async function testToolCallLoop() {
  console.log('\n[orchestrator] OpenAI tool-use loop');
  const { appId, caseId, appDir, runsDir, rootCwd } = await setupTempCase();

  // 1. Antwort: tool_calls (auswertung). 2. Antwort: stop mit Text.
  const fakeFetch = makeFakeFetch([
    [
      deltaChunk({
        choices: [{ delta: { tool_calls: [{
          index: 0, id: 'call_abc',
          type: 'function',
          function: { name: 'auswertung', arguments: '{"caseId":"' + caseId + '"}' },
        }] } }],
      }),
      deltaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ],
    [
      deltaChunk({ choices: [{ delta: { content: 'Erstattung: 617,42 EUR.' } }] }),
      deltaChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ],
  ]);

  const { sink, events } = makeCapturingSink();
  const messages: ChatMessage[] = [
    { role: 'user', content: `Was ist die Erstattung im Fall ${caseId}?` },
  ];
  await runChatLoop(
    {
      appId,
      vllmUrl: 'http://fake',
      modelName: 'gemma4-mm',
      applicationsDir: appDir,
      runsDir,
      fetchImpl: fakeFetch,
      rootCwd,
    },
    messages,
    caseId,
    sink,
  );

  const names = events.map((e) => e.name);
  assert('saw tool_call event', names.includes('tool_call'));
  assert('saw tool_result event', names.includes('tool_result'));
  assert('saw token event for text reply', names.includes('token'));
  assert('saw done event', names.includes('done'));

  const tc = events.find((e) => e.name === 'tool_call');
  assert('tool_call has name=auswertung', (tc?.payload as { name?: string })?.name === 'auswertung',
         tc);
  assert('tool_call args contain caseId', (tc?.payload as { args?: { caseId?: string } })?.args?.caseId === caseId);

  const tr = events.find((e) => e.name === 'tool_result');
  const result = (tr?.payload as { result?: { erstattung_eur?: number } })?.result;
  assert('tool_result.erstattung_eur === 617.42', result?.erstattung_eur === 617.42, result);

  const done = events.find((e) => e.name === 'done');
  assert('done.finishReason === stop', (done?.payload as { finishReason?: string })?.finishReason === 'stop');

  // Ordering: tool_call must come before its tool_result, and both before done.
  const tcIdx = names.indexOf('tool_call');
  const trIdx = names.indexOf('tool_result');
  const doneIdx = names.indexOf('done');
  assert('order tool_call < tool_result < done', tcIdx < trIdx && trIdx < doneIdx, { tcIdx, trIdx, doneIdx });
}

async function testNoToolJustStop() {
  console.log('\n[orchestrator] no-tool plain stop reply');
  const { appId, appDir, runsDir, rootCwd } = await setupTempCase();
  const fakeFetch = makeFakeFetch([
    [
      deltaChunk({ choices: [{ delta: { content: 'Hallo!' } }] }),
      deltaChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ],
  ]);
  const { sink, events } = makeCapturingSink();
  await runChatLoop(
    {
      appId, vllmUrl: 'http://fake', modelName: 'gemma4-mm',
      applicationsDir: appDir, runsDir, fetchImpl: fakeFetch, rootCwd,
    },
    [{ role: 'user', content: 'Hi' }],
    undefined,
    sink,
  );
  assert('no tool_call', !events.find((e) => e.name === 'tool_call'));
  assert('saw token "Hallo!"', events.some((e) => e.name === 'token' && (e.payload as { delta?: string }).delta === 'Hallo!'));
  assert('saw done', events.some((e) => e.name === 'done'));
}

async function main() {
  await testToolCallLoop();
  await testNoToolJustStop();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
