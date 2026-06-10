/**
 * Tests für finalize-extraction Multi-Source-eCode-Akzeptanz (v5_4).
 *
 * Validates the four supported routing paths:
 *   1. Klassisch:        input.accepted (von llm-disambig)
 *   2. v5_4 Pfad A:      input.ecodes_lstb (Lohnsteuerbescheid-Mapper, flach)
 *   3. v5_4 Pfad B:      input.ecodes_ese (ESE-Mapper, flach)
 *   4. v5_4 alle-skipped: alle Quellen undefined → canonical_layer.codes={}
 *
 * Pattern: vanilla `assert` + exit-code, kein Test-Framework.
 * Run: npx tsx src/verticals/elster-v3/stages/finalize-extraction-multisource.test.ts
 */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeExtractionStage } from './finalize-extraction.ts';
import type { AcceptedField } from './llm-disambig.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '../data');

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      fail++;
      failures.push(`${name}: ${(e as Error).message}`);
      console.log(`  ✗ ${name}: ${(e as Error).message}`);
    });
}

interface FakeCtxOpts {
  onEmit?: (name: string, payload?: unknown) => void;
}

function makeFakeCtx(opts: FakeCtxOpts = {}) {
  const artifacts = {
    write: async () => '',
    read: async () => null,
    exists: async () => false,
    absolutePath: (p: string) => p,
  };
  return {
    runId: 'test',
    workflowId: 'test',
    stageId: 'test',
    config: { dataDir: DATA_DIR },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    artifacts,
    emit: (name: string, payload?: unknown) => {
      opts.onEmit?.(name, payload);
    },
    signal: new AbortController().signal,
    results: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function main() {
  console.log('\nfinalize-extraction · Multi-Source-eCode-Akzeptanz');

  // ── Case 1: nur `accepted` (klassischer Pfad) ─────────────────────────
  await check('Case 1: classical accepted → codes populated from accepted', async () => {
    const accepted: AcceptedField[] = [
      {
        ecode: 'E0101201',
        drucktext: 'Bruttoarbeitslohn',
        anlage: 'N',
        vordruckzeile: '6',
        datentyp: 'currency',
        pflicht: true,
        rawValue: '69.291,80',
        normalizedValue: '6929180',
        method: 'cascade-direct',
        cosine: 0.92,
        confidence: 0.95,
        source: { belegIdx: 0, chunkIdx: 0, lineIndex: 5, label: 'Bruttoarbeitslohn' },
      },
    ];
    const out = await finalizeExtractionStage.run(
      { accepted, rejected: [] },
      makeFakeCtx(),
    );
    assert.equal(out.canonical_layer.codes['E0101201'], '6929180');
    assert.equal(out.stats.accepted, 1);
    assert.equal(out.stats.cascadeDirect, 1);
    assert.equal(out.canonical_layer.provenance.length, 1);
    assert.equal(out.canonical_layer.provenance[0]!.sourceLabel, 'Bruttoarbeitslohn');
  });

  // ── Case 2: nur `ecodes_lstb` → Direct-Mapper-Conversion ──────────────
  await check('Case 2: ecodes_lstb only → canonical_layer.codes from LStB mapper', async () => {
    const out = await finalizeExtractionStage.run(
      {
        ecodes_lstb: {
          E0101201: '6929180',
          E0102101: '124350',
        },
      },
      makeFakeCtx(),
    );
    assert.equal(out.canonical_layer.codes['E0101201'], '6929180');
    assert.equal(out.canonical_layer.codes['E0102101'], '124350');
    assert.equal(out.stats.accepted, 2);
    assert.equal(out.canonical_layer.provenance.length, 2);
    assert.equal(
      out.canonical_layer.provenance[0]!.sourceLabel,
      'lohnsteuerbescheid-mapper',
    );
    assert.equal(out.canonical_layer.provenance[0]!.confidence, 1.0);
    assert.equal(out.canonical_layer.provenance[0]!.cosine, 1.0);
    assert.equal(out.canonical_layer.provenance[0]!.method, 'cascade-direct');
  });

  // ── Case 3: nur `ecodes_ese` → Direct-Mapper-Conversion ───────────────
  await check('Case 3: ecodes_ese only → canonical_layer.codes from ESE mapper', async () => {
    const out = await finalizeExtractionStage.run(
      {
        ecodes_ese: {
          E0700101: 'Mustermann',
          E0102101: 50000,
        },
      },
      makeFakeCtx(),
    );
    assert.equal(out.canonical_layer.codes['E0700101'], 'Mustermann');
    assert.equal(out.canonical_layer.codes['E0102101'], '50000');
    assert.equal(out.stats.accepted, 2);
    assert.equal(
      out.canonical_layer.provenance[0]!.sourceLabel,
      'einkommensteuererklaerung-mapper',
    );
    assert.equal(out.canonical_layer.provenance[0]!.confidence, 1.0);
  });

  // ── Case 4: alle Quellen undefined → no-op ─────────────────────────────
  await check('Case 4: all sources undefined → canonical_layer.codes is empty', async () => {
    const out = await finalizeExtractionStage.run({}, makeFakeCtx());
    assert.deepEqual(out.canonical_layer.codes, {});
    assert.deepEqual(out.canonical_layer.nested, {});
    assert.equal(out.canonical_layer.provenance.length, 0);
    assert.equal(out.stats.accepted, 0);
    assert.equal(out.stats.rejected, 0);
    // Fingerprint must still be produced (canonical, replay-bar even im Leerlauf)
    assert.ok(typeof out.extraction_fingerprint.digest === 'string');
    assert.ok(out.extraction_fingerprint.digest.length > 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
