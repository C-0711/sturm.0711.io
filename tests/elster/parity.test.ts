/**
 * Phase F.2 / Task 6 — bundle/single-doc parity matrix.
 *
 * Pinned regression tests for the original Q.rtf bug ("elster-v3-multi
 * stops at Layer A"). Pure: no LLM, no IO, synthetic BelegErgebnis fixtures.
 *
 * Run: tsx tests/elster/parity.test.ts
 */

import {
  layer4AggregateStage,
  type Layer4AggregateInput,
} from '../../src/workflows/steuerbelege/stages/layer4-aggregate.ts';
import type { BelegErgebnis } from '../../src/workflows/steuerbelege/stages/belege-multi.ts';
import {
  verifyProvenance,
  type BundleAggregateInput,
  type BundleAggregateOutput,
  type ContainerProof,
  type ECode,
} from '../../packages/gitchain-types/src/index.ts';

// ─── tiny test harness (matches existing repo style) ──────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log(`    detail:`, detail);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected), {
    actual,
    expected,
  });
}

// ─── fixtures ─────────────────────────────────────────────────────────────

function mockCtx() {
  return {
    runId: 'test-run',
    workflowId: 'belege-bundle-v1',
    stageId: 'steuerbelege/layer4-aggregate',
    config: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    artifacts: {
      write: async () => {},
      writeBuffer: async () => {},
      read: async () => null as never,
      readBuffer: async () => Buffer.from(''),
      exists: async () => false,
      absolutePath: () => '',
    },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

function makeBeleg(
  index: number,
  typ_id: string,
  values: Record<string, Record<string, string | null>>,
  opts: { skipped?: boolean; reason?: string } = {},
): BelegErgebnis {
  return {
    index,
    header: `Test Beleg ${index}`,
    seiten: [index],
    klassifikation: {
      typ_id,
      label: typ_id,
      anlagen: Object.keys(values),
      ecodeHintsProAnlage: {},
      konfidenz: 1,
      used_llm: false,
    } as never,
    extraktion: {
      values,
      perAnlage: [],
      filled: 0,
      fieldCount: 0,
      skipped: opts.skipped ?? false,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ms: 1,
    },
  };
}

async function runAggregator(
  belege: BelegErgebnis[],
  containerOverride: Partial<ContainerProof> = {},
): Promise<BundleAggregateOutput> {
  const input: Layer4AggregateInput = {
    belege,
    runId: 'test-run',
    container: containerOverride,
  };
  return layer4AggregateStage.run(input, mockCtx() as never);
}

function buildVerifyInput(
  belege: BelegErgebnis[],
  output: BundleAggregateOutput,
): BundleAggregateInput {
  // Reconstruct the SubDocLayered[] the aggregator built internally — this
  // mirrors what a real workflow would persist as input metadata.
  return {
    subDocs: belege.map((b) => {
      const subDocId = `subdoc_${String(b.index).padStart(2, '0')}`;
      const docClass = b.klassifikation.typ_id ?? 'unknown';
      return {
        subDocId,
        title: b.header,
        headerKind: b.klassifikation.label ?? docClass,
        pages: b.seiten,
        classifierHint: b.klassifikation.typ_id ?? null,
        layer1: {
          subDocId,
          docClass,
          schemaName: `belege/${docClass}`,
          schemaId: `belege/${docClass}`,
          nested: b.extraktion.values ?? {},
          llmMs: 0,
          ms: b.extraktion.ms,
          ...(b.extraktion.skipped
            ? { error: b.extraktion.reason ?? 'skipped' }
            : {}),
        },
      };
    }),
    container: output.container,
    runId: 'test-run',
  };
}

// ─── tests ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\nPhase F.2 / Task 6 — parity matrix\n');

  // 1) Empty bundle → empty output, no errors
  console.log('1) empty bundle');
  {
    const out = await runAggregator([]);
    assertEqual('  totalSubDocs is 0', out.summary.totalSubDocs, 0);
    assertEqual('  aggregated[] is empty', out.aggregated.length, 0);
    assertEqual('  conflicts[] is empty', out.conflicts.length, 0);
    assertEqual('  skipped[] is empty', out.skipped.length, 0);
    assertEqual('  codes is empty', Object.keys(out.codes).length, 0);
  }

  // 2) Single-beleg N=1 bundle parity
  console.log('\n2) N=1 bundle — sum strategy');
  {
    const beleg = makeBeleg(1, 'kapitalertraege', {
      KAP: { E1900701: '500,00', E1900702: '100,00' },
    });
    const out = await runAggregator([beleg]);
    assertEqual('  uniqueCodes is 2', out.summary.uniqueCodes, 2);
    assertEqual('  E1900701 strategy is sum', out.aggregated[0]?.strategy, 'sum');
    assertEqual('  E1900701 numericTotal is 500', out.aggregated[0]?.numericTotal, 500);
    assertEqual('  codes E1900701 is 500', out.codes['E1900701' as ECode], 500);
    assertEqual('  contributions length is 1', out.aggregated[0]?.contributions.length, 1);
    assertEqual('  no conflicts', out.conflicts.length, 0);
    assertEqual('  no skipped', out.skipped.length, 0);
  }

  // 3) Two belege, non-overlapping codes — union semantics
  console.log('\n3) [D1, D2] non-overlapping codes');
  {
    const d1 = makeBeleg(1, 'kapitalertraege', { KAP: { E1900701: '500' } });
    const d2 = makeBeleg(2, 'donations', { SA: { E0108405: '120' } });
    const out = await runAggregator([d1, d2]);
    assertEqual('  uniqueCodes is 2', out.summary.uniqueCodes, 2);
    assertEqual(
      '  E0108405 (sum) is 120',
      out.codes['E0108405' as ECode],
      120,
    );
    assertEqual(
      '  E1900701 (sum) is 500',
      out.codes['E1900701' as ECode],
      500,
    );
  }

  // 4) Two belege, both produce E0108405 (sum strategy) — sums + 2 contributions
  console.log('\n4) [D1, D2] both produce E0108405 (sum)');
  {
    const d1 = makeBeleg(1, 'donations', { SA: { E0108405: '50' } });
    const d2 = makeBeleg(2, 'donations', { SA: { E0108405: '70,50' } });
    const out = await runAggregator([d1, d2]);
    const e0108405 = out.aggregated.find((a) => a.code === ('E0108405' as ECode));
    assert('  E0108405 present', !!e0108405);
    assertEqual('  E0108405 strategy is sum', e0108405?.strategy, 'sum');
    assertEqual('  E0108405 numericTotal is 120.5', e0108405?.numericTotal, 120.5);
    assertEqual(
      '  E0108405 contributions length is 2',
      e0108405?.contributions.length,
      2,
    );
    assertEqual(
      '  contribution 1 from subdoc_01',
      e0108405?.contributions[0]?.subDocId,
      'subdoc_01',
    );
    assertEqual(
      '  contribution 2 from subdoc_02',
      e0108405?.contributions[1]?.subDocId,
      'subdoc_02',
    );
  }

  // 5) Two belege conflict on E0200201 (first strategy)
  console.log('\n5) [D1, D2] conflict on E0200201 (first strategy)');
  {
    const d1 = makeBeleg(1, 'lohn', { N: { E0200201: 'Acme GmbH' } });
    const d2 = makeBeleg(2, 'lohn', { N: { E0200201: 'Beta GmbH' } });
    const out = await runAggregator([d1, d2]);
    const e0200201 = out.aggregated.find((a) => a.code === ('E0200201' as ECode));
    assert('  E0200201 present', !!e0200201);
    assertEqual('  E0200201 strategy is first', e0200201?.strategy, 'first');
    assertEqual(
      '  E0200201 value is Acme (first by sub-doc order)',
      e0200201?.value,
      'Acme GmbH',
    );
    assertEqual(
      '  E0200201 contributions length is 2 (both kept)',
      e0200201?.contributions.length,
      2,
    );
    assertEqual(
      '  conflicts[] surfaces the disagreement',
      out.conflicts.length,
      1,
    );
    assertEqual(
      '  conflict.code is E0200201',
      out.conflicts[0]?.code,
      'E0200201' as ECode,
    );
    assertEqual(
      '  conflict.resolution is kept (first wins)',
      out.conflicts[0]?.resolution.kind,
      'kept',
    );
  }

  // 6) Provenance round-trip: feed Y_bundle to verifyProvenance — must pass
  console.log('\n6) verifyProvenance round-trip');
  {
    const d1 = makeBeleg(1, 'donations', { SA: { E0108405: '50' } });
    const d2 = makeBeleg(2, 'donations', { SA: { E0108405: '70,50' } });
    const out = await runAggregator([d1, d2]);
    const result = verifyProvenance(out, buildVerifyInput([d1, d2], out));
    assert('  verifyProvenance ok', result.ok);
    if (!result.ok) {
      console.log('    issues:', result.issues);
    }
    assertEqual(
      '  no error-severity issues',
      result.issues.filter((i) => i.severity === 'error').length,
      0,
    );
  }

  // 7) Skipped belege — no code contributions but still in skipped[]
  console.log('\n7) skipped belege carry typed reason');
  {
    const d1 = makeBeleg(1, 'donations', { SA: { E0108405: '50' } });
    const d2 = makeBeleg(2, 'unknown', {}, { skipped: true, reason: 'no class' });
    const out = await runAggregator([d1, d2]);
    assertEqual('  skipped length is 1', out.skipped.length, 1);
    assertEqual('  skipped subDocId is subdoc_02', out.skipped[0]?.subDocId, 'subdoc_02');
    assertEqual(
      '  skipped reason is l1-error',
      out.skipped[0]?.reason,
      'l1-error',
    );
  }

  // 8) DEFAULT_STRATEGY missing-code default to replace-on-conflict
  console.log('\n8) unknown code defaults to replace-on-conflict');
  {
    const d1 = makeBeleg(1, 'mystery', { X: { E9999999: 'a' } });
    const d2 = makeBeleg(2, 'mystery', { X: { E9999999: 'b' } });
    const out = await runAggregator([d1, d2]);
    const ag = out.aggregated.find((a) => a.code === ('E9999999' as ECode));
    assert('  E9999999 present', !!ag);
    assertEqual(
      '  E9999999 strategy is replace-on-conflict',
      ag?.strategy,
      'replace-on-conflict',
    );
    assertEqual('  E9999999 value is "b" (last wins)', ag?.value, 'b');
    assertEqual(
      '  conflicts[] populated',
      out.conflicts.filter((c) => c.code === ('E9999999' as ECode)).length,
      1,
    );
  }

  // 9) Non-eCode field names are ignored (e.g., "_meta" or "name")
  console.log('\n9) non-eCode fields are ignored');
  {
    const d1 = makeBeleg(1, 'donations', {
      SA: { E0108405: '50', empfaenger: 'Caritas', _meta: 'ignored' as never },
    });
    const out = await runAggregator([d1]);
    assertEqual(
      '  uniqueCodes is 1 (only E0108405)',
      out.summary.uniqueCodes,
      1,
    );
  }

  // 10) German number parsing edge cases
  console.log('\n10) German number parsing');
  {
    const d1 = makeBeleg(1, 'kap', { KAP: { E1900701: '1.234,56' } });
    const d2 = makeBeleg(2, 'kap', { KAP: { E1900701: '1.234.567,89' } });
    const out = await runAggregator([d1, d2]);
    const ag = out.aggregated.find((a) => a.code === ('E1900701' as ECode));
    assertEqual(
      '  sum of 1234.56 + 1234567.89 = 1235802.45',
      ag?.numericTotal,
      1235802.45,
    );
  }

  // ─── summary ─────────────────────────────────────────────────────────────
  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('fatal:', err);
  process.exit(1);
});
