/**
 * Tests for the seal/* stage family.
 *   • collect-snapshot — shape + determinism
 *   • compute-merkle   — leaf+root reproducibility
 *   • sign-master      — HMAC roundtrip via master-signer
 *   • commit-and-anchor — file writes + anchor record
 *
 * Run: tsx src/stages/seal/seal.test.ts
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectSnapshotStage } from './collect-snapshot.ts';
import { computeMerkleStage } from './compute-merkle.ts';
import { signMasterStage } from './sign-master.ts';
import { commitAndAnchorStage } from './commit-and-anchor.ts';
import { verifyMaster } from '../../lib/master-signer.ts';
import type { StageContext, ArtifactStore, StageLogger, StageResult, StageId } from '../../core/types.ts';

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

function memArtifacts(): { store: ArtifactStore; writes: Record<string, unknown> } {
  const writes: Record<string, unknown> = {};
  const store: ArtifactStore = {
    write: async (p, data) => { writes[p] = data; },
    writeBuffer: async (p, b) => { writes[p] = b; },
    read: async <T>(p: string) => writes[p] as T,
    readBuffer: async (p) => writes[p] as Buffer,
    exists: async (p) => p in writes,
    absolutePath: (p) => p,
  };
  return { store, writes };
}

function silentLogger(): StageLogger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeCtx<TConfig>(config: TConfig, stageId = 'test'): { ctx: StageContext<TConfig>; writes: Record<string, unknown>; events: Array<{ name: string; payload: unknown }> } {
  const { store, writes } = memArtifacts();
  const events: Array<{ name: string; payload: unknown }> = [];
  const ctx: StageContext<TConfig> = {
    runId: 'r0',
    workflowId: 'wf-test',
    stageId,
    config,
    logger: silentLogger(),
    artifacts: store,
    emit: (name, payload) => { events.push({ name, payload }); },
    signal: new AbortController().signal,
    results: {} as Readonly<Record<StageId, StageResult>>,
  };
  return { ctx, writes, events };
}

async function main() {
  console.log('\n=== collect-snapshot: builds master.json with required fields ===');
  {
    const { ctx, writes } = makeCtx({});
    const input = {
      appId: 'steuerfall-est',
      caseId: 'test-case',
      mandantId: 'mand-1',
      displayName: 'Test 2024',
      veranlagungsjahr: 2024,
      runId: 'r0',
      canonical_layer: {
        E0200201: { value: '69.291,80', normalized: '6929180', origin: 'REGEX_3F', anlage: 'N' },
        E0107101: { value: '50000', normalized: '5000000', origin: 'BMF_RECHNER', anlage: 'ESt1A' },
      },
      eric_xml: '<Erklaerung/>',
    };
    const out = await collectSnapshotStage.run(input, ctx);
    eq('schemaVersion', out.master.schemaVersion, 1);
    eq('appId', out.master.appId, 'steuerfall-est');
    eq('caseId', out.master.caseId, 'test-case');
    eq('mandantId', out.master.mandantId, 'mand-1');
    eq('veranlagungsjahr', out.master.veranlagungsjahr, 2024);
    eq('basedOnRunId', out.master.basedOnRunId, 'r0');
    eq('eCodes stat', out.stats.eCodes, 2);
    assert('master.snapshot.json artifact written', 'master.snapshot.json' in writes);
    assert('generatedAt looks like ISO date', /^\d{4}-\d{2}-\d{2}T/.test(out.master.generatedAt));
  }

  console.log('\n=== collect-snapshot: throws on missing canonical_layer ===');
  {
    const { ctx } = makeCtx({});
    let threw = false;
    try {
      // @ts-expect-error intentional bad input
      await collectSnapshotStage.run({ appId: 'x', caseId: 'y', runId: 'r' }, ctx);
    } catch (e) {
      threw = true;
      assert('error mentions canonical_layer', String((e as Error).message).includes('canonical_layer'));
    }
    assert('throws on missing layer', threw);
  }

  console.log('\n=== compute-merkle: reproducible across runs ===');
  {
    const master = {
      schemaVersion: 1, appId: 'a', caseId: 'c', mandantId: '', displayName: '', veranlagungsjahr: null,
      basedOnRunId: 'r', generatedAt: '2026-01-01T00:00:00Z',
      canonical_layer: {
        E0200201: { value: '1' },
        E0200202: { value: '2' },
        E0200203: { value: '3' },
      },
      eric_xml: '', validator_result: null,
    };
    const { ctx } = makeCtx({});
    const a = await computeMerkleStage.run({ master: master as never }, ctx);
    const { ctx: ctx2 } = makeCtx({});
    const b = await computeMerkleStage.run({ master: master as never }, ctx2);
    eq('same root across runs', a.master.merkle.root, b.master.merkle.root);
    eq('leafCount', a.master.merkle.leafCount, 3);
    eq('sortedECodes', a.master.merkle.sortedECodes, ['E0200201', 'E0200202', 'E0200203']);
    assert('root is 64-char hex', /^[0-9a-f]{64}$/.test(a.master.merkle.root));
  }

  console.log('\n=== compute-merkle: changes when a value changes ===');
  {
    const baseMaster = {
      schemaVersion: 1, appId: 'a', caseId: 'c', mandantId: '', displayName: '', veranlagungsjahr: null,
      basedOnRunId: 'r', generatedAt: '2026-01-01T00:00:00Z',
      canonical_layer: { E0200201: { value: '1' } },
      eric_xml: '', validator_result: null,
    };
    const variantMaster = { ...baseMaster, canonical_layer: { E0200201: { value: '2' } } };
    const { ctx: c1 } = makeCtx({});
    const { ctx: c2 } = makeCtx({});
    const r1 = await computeMerkleStage.run({ master: baseMaster as never }, c1);
    const r2 = await computeMerkleStage.run({ master: variantMaster as never }, c2);
    assert('different roots when values differ', r1.master.merkle.root !== r2.master.merkle.root);
  }

  console.log('\n=== sign-master: HMAC roundtrip via verifyMaster ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-seal-test-'));
    try {
      // Pre-seed a key so the test doesn't rely on rotation.
      const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      await fs.writeFile(path.join(tmp, '.master-key.json'), JSON.stringify({ key, generatedAt: 't' }), { mode: 0o600 });
      const masterIn = {
        schemaVersion: 1, appId: 'a', caseId: 'c', mandantId: '', displayName: '', veranlagungsjahr: null,
        basedOnRunId: 'r', generatedAt: '2026-01-01T00:00:00Z',
        canonical_layer: { E0200201: { value: '1' } },
        eric_xml: '', validator_result: null,
      };
      const { ctx, writes } = makeCtx({ rootDir: tmp });
      const out = await signMasterStage.run({ master: masterIn }, ctx);
      eq('signature.alg', out.signature.alg, 'HMAC-SHA256');
      assert('signature.value non-empty', out.signature.value.length > 0);
      eq('keyId default', out.signature.keyId, 'sturm-master-v1');
      assert('signed master has signature field', !!(out.master as { signature?: unknown }).signature);
      assert('artifact master.signed.json written', 'master.signed.json' in writes);
      const verify = verifyMaster(out.master, key);
      assert('verifyMaster returns valid=true', verify.valid, verify);
      // Tamper detection
      const tampered = { ...(out.master as object), canonical_layer: { E0200201: { value: 'X' } } };
      const v2 = verifyMaster(tampered as Record<string, unknown>, key);
      assert('verifyMaster returns valid=false on tamper', v2.valid === false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  console.log('\n=== commit-and-anchor: writes master + anchor record to workspace ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-anchor-test-'));
    try {
      const master = {
        appId: 'a', caseId: 'c',
        merkle: { root: 'a'.repeat(64) },
        signature: { alg: 'HMAC-SHA256', value: 'dGVzdA==', keyId: 'sturm-master-v1' },
        canonical_layer: { E0200201: { value: '1' } },
      };
      const wsRel = 'ws-relative-path';
      const { ctx } = makeCtx({ tag: 'seal-v1', network: 'base-mainnet', rootDir: tmp });
      const out = await commitAndAnchorStage.run({ master: master as never, workspacePath: wsRel }, ctx);
      const wsAbs = path.join(tmp, wsRel);
      const masterStat = await fs.stat(path.join(wsAbs, 'seal', 'master.json'));
      assert('master.json file exists', masterStat.isFile());
      const anchorsList = await fs.readdir(path.join(wsAbs, 'anchors'));
      eq('one anchor record written', anchorsList.length, 1);
      eq('anchor commit_hash equals merkle root', out.anchor.commit_hash, 'a'.repeat(64));
      eq('anchor tag', out.anchor.tag, 'seal-v1');
      eq('anchor network', out.anchor.network, 'base-mainnet');
      eq('anchor tx_hash null (v1 stub)', out.anchor.tx_hash, null);
      eq('anchor block_number null (v1 stub)', out.anchor.block_number, null);
      eq('container_id format', out.anchor.container_id, '0711:tax_case:ctax:c');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log('Failures:', failures);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
