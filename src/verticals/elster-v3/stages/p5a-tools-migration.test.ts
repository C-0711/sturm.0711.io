/**
 * P5a Tool-Binding migration tests.
 *
 * Verifies the four elster-v3 LLM stages prefer the Anwendung-bound
 * `extraction-llm` / `disambig-llm` role (via `ctx.tools.getByRole(...)`)
 * over the legacy direct `chatJson()` / raw-fetch path when a real
 * ToolContainer is wired.
 *
 * Run: tsx src/verticals/elster-v3/stages/p5a-tools-migration.test.ts
 */
import { phase3LlmFillStage } from './phase3-llm-fill.ts';
import { phase4EntityDisambigStage } from './phase4-entity-disambig.ts';
import { phase3EnsembleMergeStage } from './phase3-ensemble-merge.ts';
import { llmDisambigStage } from './llm-disambig.ts';

import type { Phase1AnlageResult } from './phase1-regex.ts';
import type { Phase3LlmFillOutput } from './phase3-llm-fill.ts';
import type { LlmDisambigInput } from './llm-disambig.ts';

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

interface ChatCall {
  prompt: string | ChatMessage[];
  opts: LlmChatOptions | undefined;
}

interface StubResult {
  handle: LlmHandle;
  calls: ChatCall[];
}

function stubLlm(role: string, responses: unknown[]): StubResult {
  const calls: ChatCall[] = [];
  let i = 0;
  const handle: LlmHandle = {
    name: 'gemma4-mm',
    kind: 'llm',
    meta: { provider: 'vllm', model: 'gemma4-mm' },
    async chatJson<T>(prompt: string | ChatMessage[], opts?: LlmChatOptions): Promise<T> {
      calls.push({ prompt, opts });
      const r = responses[i] ?? responses[responses.length - 1] ?? {};
      i++;
      return r as T;
    },
    async health(): Promise<ToolHealth> {
      return { name: 'gemma4-mm', kind: 'llm', configured: true, alive: true };
    },
  };
  // role parameter exists for documentation/symmetry with getByRole(role).
  void role;
  return { handle, calls };
}

function mockContainer(handle: LlmHandle | null): ToolContainerView {
  return {
    get: <T>(_name: string): T => {
      if (!handle) throw new Error('no tool');
      return handle as unknown as T;
    },
    getByRole: <T>(_role: string): T => {
      if (!handle) throw new Error('no tool bound to role');
      return handle as unknown as T;
    },
    getAllByRole: <T>(_role: string): T[] => (handle ? [handle as unknown as T] : []),
    has: (name: string): boolean => handle !== null && name === 'gemma4-mm',
    // healthAll exists on the real container; ToolContainerView only requires
    // the four members above, so we don't add it.
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

// ─── Test 1: phase3-llm-fill (extraction-llm) ─────────────────────────────

async function testPhase3LlmFill(): Promise<void> {
  console.log('phase3-llm-fill — extraction-llm role lookup:');
  const { handle, calls } = stubLlm('extraction-llm', [{ E0200201: '1234,56' }]);
  const tools = mockContainer(handle);

  const phase1: Record<string, Phase1AnlageResult> = {
    N: {
      anlage: 'N',
      regex_hits: {},
      missing_ecodes: ['E0200201'],
      fieldCount: 1,
      hitCount: 0,
      durationMs: 0,
    },
  };
  const felder = {
    N: {
      anlage: 'N',
      felder: [
        {
          eCode: 'E0200201',
          drucktext: 'Bruttoarbeitslohn',
          bezeichnung: 'Bruttoarbeitslohn',
          datentyp: 'currency' as const,
          formatRegex: '\\d+',
          pflicht: true,
          vordruckzeile: '3',
          einkunftsart: 'ArbL',
        },
      ],
    },
  };

  // stream:false so we hit the chatJson path (not vllmStreamExtract).
  const ctx = memCtx<Record<string, unknown>>(
    { provider: 'vllm', model: 'gemma4-mm', stream: false, maxTokens: 200 },
    tools,
  );
  const out = await phase3LlmFillStage.run(
    { text: 'Bruttoarbeitslohn 1.234,56', phase1_per_anlage: phase1, felder_per_anlage: felder },
    ctx as never,
  );
  assert('stub.chatJson was called', calls.length === 1, { calls: calls.length });
  assert('schema passed through to handle', !!calls[0]?.opts?.schema);
  assert('signal passed through', calls[0]?.opts?.signal instanceof AbortSignal);
  assert('output has per_anlage.N', out.per_anlage.N !== undefined);
  assert(
    'extracted hit was recorded (E0200201)',
    out.per_anlage.N?.llm_hits?.E0200201?.value === '1234,56',
    out.per_anlage.N?.llm_hits,
  );
}

// ─── Test 2: phase4-entity-disambig (disambig-llm) ────────────────────────

async function testPhase4EntityDisambig(): Promise<void> {
  console.log('phase4-entity-disambig — disambig-llm role lookup:');
  const { handle, calls } = stubLlm('disambig-llm', [
    { value: 4242, source_idx: 0, confidence: 0.95, reasoning: 'top kandidat passt semantisch' },
  ]);
  const tools = mockContainer(handle);

  const phase1: Record<string, Phase1AnlageResult> = {
    N: {
      anlage: 'N',
      regex_hits: {},
      missing_ecodes: ['E0200999'],
      fieldCount: 1,
      hitCount: 0,
      durationMs: 0,
    },
  };
  const phase3 = {
    N: {
      anlage: 'N',
      llm_hits: {},
      still_missing: ['E0200999'],
      prefilled_count: 0,
      missing_at_start: 1,
      durationMs: 0,
    },
  };
  const felder = {
    N: {
      anlage: 'N',
      felder: [
        {
          eCode: 'E0200999',
          drucktext: 'Werbungskosten Reisekosten',
          bezeichnung: 'Werbungskosten Reisekosten',
          datentyp: 'currency' as const,
          formatRegex: '\\d+',
          pflicht: true,
          vordruckzeile: '46',
          einkunftsart: 'ArbL',
        },
      ],
    },
  };

  const ctx = memCtx<Record<string, unknown>>(
    { provider: 'vllm', model: 'gemma4-mm', confidenceThreshold: 0.5 },
    tools,
  );
  const out = await phase4EntityDisambigStage.run(
    {
      text: 'Werbungskosten Reisekosten 4242 EUR\nIrrelevante Zeile\nWeitere Daten',
      phase1_per_anlage: phase1,
      phase3_per_anlage: phase3,
      felder_per_anlage: felder,
    },
    ctx as never,
  );
  assert('stub.chatJson was called at least once', calls.length >= 1, { calls: calls.length });
  assert('schema was passed', !!calls[0]?.opts?.schema);
  assert(
    'disambig hit landed in output',
    out.per_anlage.N?.llm_hits?.E0200999?.value === '4242',
    out.per_anlage.N?.llm_hits,
  );
}

// ─── Test 3: phase3-ensemble-merge (no LLM, smoke test under mock) ────────

async function testPhase3EnsembleMerge(): Promise<void> {
  console.log('phase3-ensemble-merge — runs unchanged under mock container:');
  // ensemble-merge has no LLM calls (it merges upstream branches), but it
  // still receives a ToolContainerView via StageContext. Smoke-test that
  // attaching a real-mock container does not break the stage.
  const { handle, calls } = stubLlm('extraction-llm', []);
  const tools = mockContainer(handle);
  const branchOutput: Phase3LlmFillOutput = {
    per_anlage: {
      N: {
        anlage: 'N',
        llm_hits: {
          E0200201: {
            eCode: 'E0200201',
            value: '1000',
            origin: 'LLM_FSM',
            kontextPath: null,
            anlage: 'N',
            drucktext: 'Brutto',
            vordruckzeile: '3',
            datentyp: 'currency',
          },
        },
        still_missing: [],
        prefilled_count: 0,
        missing_at_start: 1,
        durationMs: 0,
      },
    },
    totalFilled: 1,
    ms: 0,
  };
  const ctx = memCtx({}, tools);
  const out = await phase3EnsembleMergeStage.run(
    { vllm: branchOutput, mistral_small: branchOutput },
    ctx as never,
  );
  assert('ensemble-merge ran cleanly', out.per_anlage.N !== undefined);
  assert('ensemble-merge picked the consensus hit', out.totalFilled === 1, out.totalFilled);
  assert('ensemble-merge did NOT call the LLM stub (no LLM calls in this stage)', calls.length === 0);
}

// ─── Test 4: llm-disambig (disambig-llm) ──────────────────────────────────

async function testLlmDisambig(): Promise<void> {
  console.log('llm-disambig — disambig-llm role lookup:');
  const { handle, calls } = stubLlm('disambig-llm', [
    { picked_ecode: 'E0200201', confidence: 0.88, reasoning: 'Bruttoarbeitslohn passt' },
  ]);
  const tools = mockContainer(handle);

  const input: LlmDisambigInput = {
    belege: [
      {
        index: 0,
        doc_class: 'lohnsteuerbescheinigung',
        title: 'Lohnsteuerbescheinigung 2024',
        rawText: 'Bruttoarbeitslohn 12345,67',
        text_sha256: 'sha-placeholder',
        chunks: [
          {
            lineIndex: 0,
            label: 'Bruttoarbeitslohn',
            value: '12345,67',
            rawLine: 'Bruttoarbeitslohn 12345,67',
            zeile: '3',
            candidates: [
              {
                rank: 1,
                ecode: 'E0200201',
                score: 0.45, // between disambigLo (0.30) and acceptCosine (0.65)
                drucktext: 'Bruttoarbeitslohn',
                anlage: 'N',
                datentyp: 'currency',
                pflicht: true,
                vordruckzeile: '3',
                formatRegex: '\\d+',
                format_valid: true,
                normalized_value: '1234567',
              },
              {
                rank: 2,
                ecode: 'E0200299',
                score: 0.40,
                drucktext: 'Versorgungsbezüge',
                anlage: 'N',
                datentyp: 'currency',
                pflicht: false,
                vordruckzeile: '8',
                formatRegex: '\\d+',
                format_valid: true,
                normalized_value: '1234567',
              },
            ],
          },
        ],
      },
    ],
    dokumenttyp_id: 'lohnsteuerbescheinigung',
  };

  const ctx = memCtx<Record<string, unknown>>({ maxConcurrency: 1 }, tools);
  const out = await llmDisambigStage.run(input as never, ctx as never);
  assert('stub.chatJson was called', calls.length === 1, { calls: calls.length });
  assert('schema passed through', !!calls[0]?.opts?.schema);
  assert(
    'accepted contained the LLM-picked field',
    out.accepted.some((a) => a.ecode === 'E0200201' && a.method === 'llm-disambig'),
    out.accepted,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await testPhase3LlmFill();
  } catch (e) {
    fail++;
    console.log('  ✗ phase3-llm-fill threw:', (e as Error).message);
  }
  try {
    await testPhase4EntityDisambig();
  } catch (e) {
    fail++;
    console.log('  ✗ phase4-entity-disambig threw:', (e as Error).message);
  }
  try {
    await testPhase3EnsembleMerge();
  } catch (e) {
    fail++;
    console.log('  ✗ phase3-ensemble-merge threw:', (e as Error).message);
  }
  try {
    await testLlmDisambig();
  } catch (e) {
    fail++;
    console.log('  ✗ llm-disambig threw:', (e as Error).message);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
