/**
 * phase3-llm-fill — anlagen-level parallelism tests.
 *
 * Verifies the worker pool that processes anlagen in parallel. Each LLM
 * stub call sleeps `DELAY_MS`; with N anlagen and concurrency C we expect
 * wallclock ≈ ceil(N/C) * DELAY_MS.
 *
 * Run: tsx src/verticals/elster-v3/stages/phase3-llm-fill.test.ts
 */
import { phase3LlmFillStage } from './phase3-llm-fill.ts';

import type { Phase1AnlageResult } from './phase1-regex.ts';
import type {
  ArtifactStore,
  StageContext,
  StageLogger,
  StageResult,
  StageId,
} from '../../../core/types.ts';
import type { LlmHandle, ChatMessage, LlmChatOptions } from '../../../core/tools/handles.ts';
import type { ToolContainerView, ToolHealth } from '../../../core/tools/types.ts';

// ─── Test harness ─────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
function assert(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

const DELAY_MS = 200;

interface ChatCall {
  prompt: string | ChatMessage[];
  opts: LlmChatOptions | undefined;
  startedAt: number;
}

interface StubResult {
  handle: LlmHandle;
  calls: ChatCall[];
  inFlightPeak: number;
}

/** Delaying LLM stub: each chatJson resolves after DELAY_MS with the
 *  anlage's expected payload (read from the schema's first eCode). Tracks
 *  peak in-flight to verify true parallelism, not just wallclock. */
function delayingLlmStub(): StubResult {
  const calls: ChatCall[] = [];
  let inFlight = 0;
  let peak = 0;
  const handle: LlmHandle = {
    name: 'gemma4-mm',
    kind: 'llm',
    meta: { provider: 'vllm', model: 'gemma4-mm' },
    async chatJson<T>(prompt: string | ChatMessage[], opts?: LlmChatOptions): Promise<T> {
      calls.push({ prompt, opts, startedAt: Date.now() });
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((r) => setTimeout(r, DELAY_MS));
      inFlight--;
      // Build a response that fills every eCode in the schema with "OK".
      const schema = opts?.schema?.schema as
        | { properties?: Record<string, unknown> }
        | undefined;
      const out: Record<string, string> = {};
      for (const k of Object.keys(schema?.properties ?? {})) out[k] = 'OK';
      return out as unknown as T;
    },
    async health(): Promise<ToolHealth> {
      return { name: 'gemma4-mm', kind: 'llm', configured: true, alive: true };
    },
  };
  return {
    handle,
    calls,
    // wrap inFlightPeak as getter via Object.defineProperty would be nicer;
    // here we expose a live ref via the object — tests read it after run.
    get inFlightPeak(): number { return peak; },
  } as unknown as StubResult;
}

function mockContainer(handle: LlmHandle): ToolContainerView {
  return {
    get: <T>(_name: string): T => handle as unknown as T,
    getByRole: <T>(_role: string): T => handle as unknown as T,
    getAllByRole: <T>(_role: string): T[] => [handle as unknown as T],
    has: (name: string): boolean => name === 'gemma4-mm',
  };
}

function memCtx<TC>(config: TC, tools: ToolContainerView): StageContext<TC> {
  const writes: Record<string, unknown> = {};
  const store: ArtifactStore = {
    write: async (p, d) => { writes[p] = d; },
    writeBuffer: async (p, b) => { writes[p] = b; },
    read: async (p) => writes[p] as never,
    readBuffer: async (p) => writes[p] as Buffer,
    exists: async (p) => p in writes,
    absolutePath: (p) => p,
  };
  const logger: StageLogger = { debug() {}, info() {}, warn() {}, error() {} };
  return {
    runId: 'test-run',
    workflowId: 'test-workflow',
    stageId: 'test-stage',
    config,
    logger,
    artifacts: store,
    emit: () => {},
    signal: new AbortController().signal,
    results: {} as Readonly<Record<StageId, StageResult>>,
    tools,
  };
}

/** Build a 7-anlagen test input: each anlage has exactly 1 missing eCode
 *  so each anlage triggers exactly 1 LLM call. */
function buildSevenAnlagenInput(): {
  text: string;
  phase1_per_anlage: Record<string, Phase1AnlageResult>;
  felder_per_anlage: Record<string, {
    anlage: string;
    felder: Array<{
      eCode: string;
      drucktext: string;
      bezeichnung: string;
      datentyp: 'currency' | 'string' | 'date';
      formatRegex: string;
      pflicht: boolean;
      vordruckzeile: string;
      einkunftsart: string;
    }>;
  }>;
} {
  const anlagen = ['N', 'KAP', 'V', 'S', 'G', 'R', 'SO'];
  const phase1: Record<string, Phase1AnlageResult> = {};
  const felder: Record<string, ReturnType<typeof buildSevenAnlagenInput>['felder_per_anlage'][string]> = {};
  for (const [i, a] of anlagen.entries()) {
    const eCode = `E020${(100 + i).toString().padStart(4, '0')}`;
    phase1[a] = {
      anlage: a,
      regex_hits: {},
      missing_ecodes: [eCode],
      fieldCount: 1,
      hitCount: 0,
      durationMs: 0,
    };
    felder[a] = {
      anlage: a,
      felder: [
        {
          eCode,
          drucktext: `Testfeld ${a}`,
          bezeichnung: `Testfeld ${a}`,
          datentyp: 'currency',
          formatRegex: '\\d+',
          pflicht: true,
          vordruckzeile: '1',
          einkunftsart: 'ArbL',
        },
      ],
    };
  }
  return {
    text: 'irrelevant OCR text for parallelism timing test',
    phase1_per_anlage: phase1,
    felder_per_anlage: felder,
  };
}

// ─── Test 1: sequential (anlageConcurrency: 1) ────────────────────────────

async function testSequential(): Promise<void> {
  console.log('phase3-llm-fill — anlageConcurrency: 1 (sequential):');
  const stub = delayingLlmStub();
  const tools = mockContainer(stub.handle);
  const input = buildSevenAnlagenInput();
  const ctx = memCtx<Record<string, unknown>>(
    { provider: 'vllm', model: 'gemma4-mm', stream: false, maxTokens: 200, anlageConcurrency: 1 },
    tools,
  );

  const t0 = Date.now();
  const out = await phase3LlmFillStage.run(input, ctx as never);
  const elapsed = Date.now() - t0;

  assert(
    `wallclock ≥ ${7 * DELAY_MS}ms (sequential), got ${elapsed}ms`,
    elapsed >= 7 * DELAY_MS - 50, // small slack
    { elapsed },
  );
  assert('all 7 anlagen got LLM calls', stub.calls.length === 7, { calls: stub.calls.length });
  assert(
    'peak in-flight = 1 (no parallelism)',
    stub.inFlightPeak === 1,
    { peak: stub.inFlightPeak },
  );
  assert(
    'all 7 anlagen produced output',
    Object.keys(out.per_anlage).length === 7,
    { keys: Object.keys(out.per_anlage) },
  );
  assert('totalFilled = 7', out.totalFilled === 7, { totalFilled: out.totalFilled });
}

// ─── Test 2: parallel (anlageConcurrency: 7) ──────────────────────────────

async function testParallel(): Promise<void> {
  console.log('phase3-llm-fill — anlageConcurrency: 7 (full parallel):');
  const stub = delayingLlmStub();
  const tools = mockContainer(stub.handle);
  const input = buildSevenAnlagenInput();
  const ctx = memCtx<Record<string, unknown>>(
    { provider: 'vllm', model: 'gemma4-mm', stream: false, maxTokens: 200, anlageConcurrency: 7 },
    tools,
  );

  const t0 = Date.now();
  const out = await phase3LlmFillStage.run(input, ctx as never);
  const elapsed = Date.now() - t0;

  assert(
    `wallclock ≤ ${DELAY_MS * 2 + 100}ms (parallel), got ${elapsed}ms`,
    elapsed <= DELAY_MS * 2 + 100,
    { elapsed },
  );
  assert('all 7 anlagen got LLM calls', stub.calls.length === 7, { calls: stub.calls.length });
  assert(
    'peak in-flight = 7 (full parallelism)',
    stub.inFlightPeak === 7,
    { peak: stub.inFlightPeak },
  );
  assert(
    'all 7 anlagen produced output',
    Object.keys(out.per_anlage).length === 7,
    { keys: Object.keys(out.per_anlage) },
  );
  assert('totalFilled = 7', out.totalFilled === 7, { totalFilled: out.totalFilled });
}

// ─── Test 3: legacy `concurrency` field still honored ─────────────────────

async function testLegacyConcurrencyAlias(): Promise<void> {
  console.log('phase3-llm-fill — legacy `concurrency` field still works:');
  const stub = delayingLlmStub();
  const tools = mockContainer(stub.handle);
  const input = buildSevenAnlagenInput();
  // Use the legacy `concurrency` field without `anlageConcurrency` — should
  // be honored as the worker-pool size for backward compatibility.
  const ctx = memCtx<Record<string, unknown>>(
    { provider: 'vllm', model: 'gemma4-mm', stream: false, maxTokens: 200, concurrency: 7 },
    tools,
  );

  const out = await phase3LlmFillStage.run(input, ctx as never);

  assert(
    'peak in-flight = 7 (legacy concurrency honored)',
    stub.inFlightPeak === 7,
    { peak: stub.inFlightPeak },
  );
  assert('totalFilled = 7', out.totalFilled === 7, { totalFilled: out.totalFilled });
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await testSequential();
  } catch (e) {
    fail++;
    console.log('  ✗ sequential threw:', (e as Error).message);
  }
  try {
    await testParallel();
  } catch (e) {
    fail++;
    console.log('  ✗ parallel threw:', (e as Error).message);
  }
  try {
    await testLegacyConcurrencyAlias();
  } catch (e) {
    fail++;
    console.log('  ✗ legacy alias threw:', (e as Error).message);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
