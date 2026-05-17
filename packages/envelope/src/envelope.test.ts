/**
 * @0711/envelope test suite.
 *
 * Covers — in order of platform importance:
 *   1. v2 envelope: roundtrip, tamper, project-scoping, key rotation
 *   2. v1 master: byte-compat with pre-extraction sturm signatures
 *   3. fingerprint: replay-determinism, signature roundtrip
 *   4. canonical-JSON: key-order independence
 *   5. resolveSharedKey: env → file → autogen precedence
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  signEnvelope,
  signEnvelopeEd25519,
  verifyEnvelope,
  verifyEnvelopeAny,
  staticKeyResolver,
  mapKeyResolver,
  signMaster,
  verifyMaster,
  computeFingerprint,
  signFingerprint,
  verifyFingerprint,
  generateEd25519KeyPair,
  resolveSharedKey,
  canonicalJson,
} from './index.ts';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log(`  ✓ ${name}`);
      pass++;
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      console.log(`  ✗ ${name}\n    ${msg}`);
      fail++;
    });
}

async function main() {
  console.log('\n=== v2 envelope: roundtrip + tamper + project-scoping ===');

  await check('signEnvelope + verifyEnvelope: valid roundtrip', async () => {
    const env = signEnvelope(
      { project: 'sturm', payload: { run_id: 'abc', score: 0.93 } },
      KEY_A,
      'sturm-master-v1',
    );
    const result = await verifyEnvelope(env, staticKeyResolver('sturm-master-v1', KEY_A));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  await check('verifyEnvelope: payload tamper → invalid', async () => {
    const env = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_A, 'sturm-master-v1');
    const tampered = { ...env, payload: { x: 2 } };
    const result = await verifyEnvelope(tampered, staticKeyResolver('sturm-master-v1', KEY_A));
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('signature mismatch'));
  });

  await check('verifyEnvelope: project tamper → invalid (cross-project replay blocked)', async () => {
    const env = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_A, 'sturm-master-v1');
    const replayed = { ...env, project: 'eyeai' };
    const result = await verifyEnvelope(replayed, staticKeyResolver('sturm-master-v1', KEY_A));
    assert.equal(result.valid, false);
  });

  await check('verifyEnvelope: signedAt tamper → invalid', async () => {
    const env = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_A, 'sturm-master-v1');
    assert.ok(env.signature);
    const tampered = { ...env, signature: { ...env.signature!, signedAt: '1970-01-01T00:00:00.000Z' } };
    const result = await verifyEnvelope(tampered, staticKeyResolver('sturm-master-v1', KEY_A));
    assert.equal(result.valid, false);
  });

  await check('verifyEnvelope: unknown keyId → invalid', async () => {
    const env = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_A, 'sturm-master-v1');
    const result = await verifyEnvelope(env, staticKeyResolver('sturm-master-v2', KEY_A));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('unknown keyId')));
  });

  await check('verifyEnvelope: wrong key for valid keyId → invalid', async () => {
    const env = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_A, 'sturm-master-v1');
    const result = await verifyEnvelope(env, staticKeyResolver('sturm-master-v1', KEY_B));
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('signature mismatch'));
  });

  await check('mapKeyResolver: rotation — old keyId still verifies', async () => {
    const v1 = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_A, 'sturm-master-v1');
    const v2 = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_B, 'sturm-master-v2');
    const resolver = mapKeyResolver({ 'sturm-master-v1': KEY_A, 'sturm-master-v2': KEY_B });
    assert.equal((await verifyEnvelope(v1, resolver)).valid, true);
    assert.equal((await verifyEnvelope(v2, resolver)).valid, true);
  });

  await check('signEnvelope: same payload + different project → different signature', async () => {
    const a = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_A, 'shared-v1', { signedAt: '2026-01-01T00:00:00.000Z' });
    const b = signEnvelope({ project: 'eyeai', payload: { x: 1 } }, KEY_A, 'shared-v1', { signedAt: '2026-01-01T00:00:00.000Z' });
    assert.ok(a.signature && b.signature);
    assert.notEqual(a.signature!.value, b.signature!.value);
  });

  await check('signEnvelope: rejects short key', () => {
    assert.throws(() => signEnvelope({ project: 'x', payload: {} }, 'short', 'k1'), /≥32 chars/);
  });

  await check('signEnvelope: rejects empty project', () => {
    assert.throws(() => signEnvelope({ project: '', payload: {} }, KEY_A, 'k1'), /project must be a non-empty/);
  });

  console.log('\n=== Ed25519 envelope: roundtrip + tamper + alg dispatch ===');

  const kp = generateEd25519KeyPair();
  const kpOther = generateEd25519KeyPair();

  await check('signEnvelopeEd25519 + verifyEnvelopeAny: valid roundtrip', async () => {
    const env = signEnvelopeEd25519(
      { project: 'eyeai', payload: { scan_uid: 'xyz', k1: 43.2 } },
      kp.privatePem,
      'eyeai-device-pentacam-A0042',
    );
    const result = await verifyEnvelopeAny(env, {
      ed25519: (id) => (id === 'eyeai-device-pentacam-A0042' ? kp.publicPem : undefined),
    });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  await check('Ed25519: payload tamper → invalid', async () => {
    const env = signEnvelopeEd25519({ project: 'eyeai', payload: { k1: 43.2 } }, kp.privatePem, 'k1');
    const tampered = { ...env, payload: { k1: 44.0 } };
    const result = await verifyEnvelopeAny(tampered, { ed25519: () => kp.publicPem });
    assert.equal(result.valid, false);
  });

  await check('Ed25519: project tamper → invalid (cross-project replay blocked)', async () => {
    const env = signEnvelopeEd25519({ project: 'eyeai', payload: { x: 1 } }, kp.privatePem, 'k1');
    const replayed = { ...env, project: 'sturm' };
    const result = await verifyEnvelopeAny(replayed, { ed25519: () => kp.publicPem });
    assert.equal(result.valid, false);
  });

  await check('Ed25519: wrong public key → invalid', async () => {
    const env = signEnvelopeEd25519({ project: 'eyeai', payload: { x: 1 } }, kp.privatePem, 'k1');
    const result = await verifyEnvelopeAny(env, { ed25519: () => kpOther.publicPem });
    assert.equal(result.valid, false);
  });

  await check('verifyEnvelopeAny: HMAC signature dispatches to hmac resolver', async () => {
    const env = signEnvelope({ project: 'sturm', payload: { x: 1 } }, KEY_A, 'sturm-master-v1');
    const result = await verifyEnvelopeAny(env, {
      hmac: staticKeyResolver('sturm-master-v1', KEY_A),
      ed25519: () => kp.publicPem,  // present but unused
    });
    assert.equal(result.valid, true);
  });

  await check('verifyEnvelopeAny: missing resolver for sig alg → invalid (fail-closed)', async () => {
    const env = signEnvelopeEd25519({ project: 'eyeai', payload: { x: 1 } }, kp.privatePem, 'k1');
    const result = await verifyEnvelopeAny(env, { hmac: staticKeyResolver('k1', KEY_A) });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('no ed25519 resolver')));
  });

  console.log('\n=== v1 master: wire-compat with pre-extraction sturm ===');

  await check('signMaster + verifyMaster: roundtrip', () => {
    const master: Record<string, unknown> = { id: 'workspace-abc', files: ['a.pdf', 'b.pdf'], score: 0.91 };
    const sig = signMaster(master, KEY_A);
    const signed = { ...master, signature: sig };
    const result = verifyMaster(signed, KEY_A);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  await check('signMaster: byte-stable — same input + key → same signature', () => {
    const master: Record<string, unknown> = { id: 'x', n: 42 };
    const s1 = signMaster(master, KEY_A);
    const s2 = signMaster(master, KEY_A);
    assert.equal(s1.value, s2.value);
    assert.equal(s1.keyId, 'sturm-master-v1');
  });

  await check('signMaster: known-good signature (canary against accidental changes)', () => {
    // If this fails, someone changed the canonical-JSON or HMAC behavior.
    // Existing master.json files in production will no longer verify.
    const master = { id: 'canary', n: 1 };
    const sig = signMaster(master, KEY_A, 'sturm-master-v1');
    // Computed from canonicalJson({id:"canary",n:1,signature:null}) HMAC'd with 64×"a".
    assert.equal(sig.value, 't8qCgpW+fl6QxXhJLlO1SnU0nBlxGpM7US4TuoudC+s=');
  });

  await check('verifyMaster: tamper → invalid', () => {
    const master: Record<string, unknown> = { id: 'x', n: 1 };
    const sig = signMaster(master, KEY_A);
    const tampered = { ...master, n: 2, signature: sig };
    assert.equal(verifyMaster(tampered, KEY_A).valid, false);
  });

  console.log('\n=== fingerprints: replay-determinism + signature ===');

  const components = {
    container: {
      id: 'elster-v3',
      catalog_version: '2026-05',
      merkle_root: '0xabc123',
      container_sha256: '0xdef456',
    },
    embedder: {
      family: 'embedding-gemma',
      dim: 768,
      seed: 42,
      artifact_sha256s: { cascade: '0xaaa', exact: '0xbbb' },
    },
    input: { pdf_sha256: '0x111', filename: 'fall.pdf' },
    stage_versions: { 'mistral-ocr': '1.2.3', 'finalize': '0.4.1' },
  };

  await check('computeFingerprint: deterministic across runs (timestamp stripped)', () => {
    const a = computeFingerprint(components);
    const b = computeFingerprint(components);
    assert.equal(a.digest, b.digest);
  });

  await check('computeFingerprint: differs when components differ', () => {
    const a = computeFingerprint(components);
    const b = computeFingerprint({ ...components, container: { ...components.container, merkle_root: '0xchanged' } });
    assert.notEqual(a.digest, b.digest);
  });

  await check('signFingerprint + verifyFingerprint: roundtrip', () => {
    const fp = computeFingerprint(components);
    const signed = signFingerprint(fp, KEY_A);
    const result = verifyFingerprint(signed, KEY_A);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  await check('verifyFingerprint: components tamper detected via digest mismatch', () => {
    const fp = computeFingerprint(components);
    const signed = signFingerprint(fp, KEY_A);
    const tampered = { ...signed, components: { ...signed.components, container: { ...signed.components.container, merkle_root: '0xevil' } } };
    const result = verifyFingerprint(tampered, KEY_A);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('digest mismatch')));
  });

  console.log('\n=== canonical-JSON: key-order independence ===');

  await check('canonicalJson: same logical object → same bytes', () => {
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  await check('canonicalJson: nested + arrays', () => {
    const out = canonicalJson({ z: [3, { y: 2, x: 1 }], a: null });
    assert.equal(out, '{"a":null,"z":[3,{"x":1,"y":2}]}');
  });

  console.log('\n=== resolveSharedKey: env → file → autogen precedence ===');

  const tmpDir = mkdtempSync(join(tmpdir(), 'envelope-test-'));
  try {
    await check('resolveSharedKey: env wins when ≥32 chars', async () => {
      process.env.TEST_KEY_A = 'x'.repeat(40);
      const k = await resolveSharedKey({ envVar: 'TEST_KEY_A', keyFile: '.k.json', rootDir: tmpDir });
      assert.equal(k, 'x'.repeat(40));
      delete process.env.TEST_KEY_A;
    });

    await check('resolveSharedKey: file used when env empty', async () => {
      writeFileSync(join(tmpDir, '.k2.json'), JSON.stringify({ key: 'y'.repeat(64), generatedAt: '2026-01-01' }));
      const k = await resolveSharedKey({ envVar: 'TEST_KEY_MISSING', keyFile: '.k2.json', rootDir: tmpDir });
      assert.equal(k, 'y'.repeat(64));
    });

    await check('resolveSharedKey: autogen when both missing, persists to file', async () => {
      const k = await resolveSharedKey({ envVar: 'TEST_KEY_MISSING', keyFile: '.k3.json', rootDir: tmpDir });
      assert.equal(k.length, 64);  // 32 bytes hex
      const persisted = JSON.parse(readFileSync(join(tmpDir, '.k3.json'), 'utf8')) as { key: string };
      assert.equal(persisted.key, k);
    });

    await check('resolveSharedKey: throws when generate=false and nothing found', async () => {
      await assert.rejects(
        async () =>
          resolveSharedKey({
            envVar: 'TEST_KEY_MISSING',
            keyFile: '.k4.json',
            rootDir: tmpDir,
            generate: false,
          }),
        /no key in env/,
      );
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
