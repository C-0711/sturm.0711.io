/**
 * Voting-Logik-Tests für phase3-ensemble-merge.
 * Run: tsx src/verticals/elster-v3/stages/phase3-ensemble-merge.test.ts
 */
import { phase3EnsembleMergeStage } from './phase3-ensemble-merge.ts';
import type { Phase3LlmFillOutput, Phase3LlmHit } from './phase3-llm-fill.ts';
import type { ArtifactStore, StageContext, StageLogger, StageResult, StageId } from '../../../core/types.ts';
import { NullToolContainer } from '../../../core/tools/null-container.ts';

let pass = 0, fail = 0;
function assert(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}
function eq<T>(name: string, actual: T, expected: T) {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function memCtx<TC>(config: TC): StageContext<TC> {
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
    runId: 'r', workflowId: 'w', stageId: 's',
    config, logger, artifacts: store,
    emit: () => {}, signal: new AbortController().signal,
    results: {} as Readonly<Record<StageId, StageResult>>,
    tools: new NullToolContainer(),
  };
}

function hit(eCode: string, value: string, anlage = 'N'): Phase3LlmHit {
  return { eCode, value, origin: 'LLM_FSM', kontextPath: null, anlage, drucktext: '', vordruckzeile: '', datentyp: 'currency' };
}

function branch(anlage: string, hits: Phase3LlmHit[], missing: string[] = []): Phase3LlmFillOutput {
  const llm_hits: Record<string, Phase3LlmHit> = {};
  for (const h of hits) llm_hits[h.eCode] = h;
  return {
    per_anlage: {
      [anlage]: {
        anlage,
        llm_hits,
        still_missing: missing,
        prefilled_count: 0,
        missing_at_start: hits.length + missing.length,
        durationMs: 10,
      },
    },
    totalFilled: hits.length,
    ms: 10,
  };
}

async function main() {
  console.log('\n=== 3/4 agree → ENSEMBLE_OK ===');
  {
    const a = branch('N', [hit('E0200201', '100,00'), hit('E0200301', '50,00')]);
    const b = branch('N', [hit('E0200201', '100,00'), hit('E0200301', '50,00')]);
    const c = branch('N', [hit('E0200201', '100,00'), hit('E0200301', '999,00')]);
    const d = branch('N', [hit('E0200201', '999,99')]);
    const ctx = memCtx({ minAgreement: 3 });
    const out = await phase3EnsembleMergeStage.run(
      { vllm: a, mistral_small: b, mistral_large: c, claude_haiku: d } as never,
      ctx,
    );
    eq('E0200201 winning value', out.per_anlage.N.llm_hits.E0200201?.value, '100,00');
    eq('E0200301 winning value', out.per_anlage.N.llm_hits.E0200301?.value, '50,00');
    assert('audit has 2 entries', out._ensemble_audit.length === 2);
    // E0200201: 3 of 4 → OK. E0200301: only 3 branches voted (d had no hit
    // for it), 2 say '50,00' und 1 sagt '999,00'. 2:1 ist kein TIE
    // (TIE = exact split), sondern DISAGREE bei minAgreement=3.
    const consensusSet = new Set(out._ensemble_audit.map(e => e.consensus));
    assert('OK + DISAGREE in audit',
      consensusSet.has('ENSEMBLE_OK') && consensusSet.has('ENSEMBLE_DISAGREE'));
  }

  console.log('\n=== 2/2 split → ENSEMBLE_TIE ===');
  {
    const a = branch('N', [hit('E0200201', 'A')]);
    const b = branch('N', [hit('E0200201', 'A')]);
    const c = branch('N', [hit('E0200201', 'B')]);
    const d = branch('N', [hit('E0200201', 'B')]);
    const ctx = memCtx({ minAgreement: 3 });
    const out = await phase3EnsembleMergeStage.run(
      { vllm: a, mistral_small: b, mistral_large: c, claude_haiku: d } as never,
      ctx,
    );
    eq('tie consensus', out._ensemble_audit[0].consensus, 'ENSEMBLE_TIE');
    eq('tie agreement', out._ensemble_audit[0].agreement, 2);
  }

  console.log('\n=== alle uneinig → ENSEMBLE_DISAGREE ===');
  {
    const a = branch('N', [hit('E0200201', 'A')]);
    const b = branch('N', [hit('E0200201', 'B')]);
    const c = branch('N', [hit('E0200201', 'C')]);
    const d = branch('N', [hit('E0200201', 'D')]);
    const ctx = memCtx({ minAgreement: 3 });
    const out = await phase3EnsembleMergeStage.run(
      { vllm: a, mistral_small: b, mistral_large: c, claude_haiku: d } as never,
      ctx,
    );
    eq('disagree consensus', out._ensemble_audit[0].consensus, 'ENSEMBLE_DISAGREE');
  }

  console.log('\n=== Branch fehlt → wird übersprungen ===');
  {
    const a = branch('N', [hit('E0200201', 'X')]);
    const c = branch('N', [hit('E0200201', 'X')]);
    const ctx = memCtx({ minAgreement: 2 });
    const out = await phase3EnsembleMergeStage.run(
      { vllm: a, mistral_large: c } as never,
      ctx,
    );
    eq('only 2 branches counted', out._ensemble_stats.branches.length, 2);
    eq('ok with minAgreement=2', out._ensemble_audit[0].consensus, 'ENSEMBLE_OK');
  }

  console.log('\n=== Normalize: whitespace ignored ===');
  {
    const a = branch('N', [hit('E0200201', '100,00')]);
    const b = branch('N', [hit('E0200201', '  100,00  ')]);
    const c = branch('N', [hit('E0200201', '100,00')]);
    const d = branch('N', [hit('E0200201', 'X')]);
    const ctx = memCtx({ minAgreement: 3 });
    const out = await phase3EnsembleMergeStage.run(
      { vllm: a, mistral_small: b, mistral_large: c, claude_haiku: d } as never,
      ctx,
    );
    eq('whitespace-normalized agreement counts as match', out._ensemble_audit[0].agreement, 3);
    eq('whitespace-normalized → OK', out._ensemble_audit[0].consensus, 'ENSEMBLE_OK');
  }

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
