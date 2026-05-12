/**
 * Run: `node --test --import tsx src/lib/quantum-index.test.ts`
 *
 * End-to-end tests for the quantum-retrieval primitive. We build a small
 * synthetic catalog, encode it via TurboQuant at multiple MRL dims, and
 * verify:
 *   1. wire-format round-trip — encoder → QuantumIndex.fromBuffer recovers
 *      identical TurboEncoded records
 *   2. scoreAll matches TurboQuantizer.estimateInnerProduct row-by-row
 *   3. topK returns indices in descending-score order
 *   4. on a clustered dataset the top-1 hit recovers the cluster center
 *   5. cascade.topK returns the same top-1 as fp32 truth on the same query
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

import { TurboQuantizer } from './qjl/index.ts';
import {
  QuantumIndex,
  ExactFp32Index,
  QuantumCascade,
} from './quantum-index.ts';
import { l2normalize, mrlTruncate } from './gemma-embed.ts';

// ─────────────────────────────────────────────────────────────────────────
// Test fixture: clustered unit-norm vectors.
// 6 clusters × 8 vectors = 48 atoms in d=128. Within a cluster vectors are
// near-neighbors; across clusters they are roughly orthogonal. This mimics
// the structure of EmbeddingGemma's output on a semantically-clustered
// corpus.
// ─────────────────────────────────────────────────────────────────────────

const SEED = 42;
const D = 128;
const B = 3;
const CLUSTERS = 6;
const PER_CLUSTER = 8;
const N = CLUSTERS * PER_CLUSTER;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b1) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

function makeClusteredCorpus(): { vecs: Float32Array[]; clusterOf: number[] } {
  const r = rng(SEED);
  const centers: Float32Array[] = [];
  for (let c = 0; c < CLUSTERS; c++) {
    const v = new Float32Array(D);
    for (let i = 0; i < D; i++) v[i] = r() - 0.5;
    centers.push(l2normalize(v));
  }
  const vecs: Float32Array[] = [];
  const clusterOf: number[] = [];
  for (let c = 0; c < CLUSTERS; c++) {
    for (let k = 0; k < PER_CLUSTER; k++) {
      // center + small jitter
      const v = new Float32Array(D);
      for (let i = 0; i < D; i++) v[i] = centers[c][i] + 0.05 * (r() - 0.5);
      vecs.push(l2normalize(v));
      clusterOf.push(c);
    }
  }
  return { vecs, clusterOf };
}

// ─────────────────────────────────────────────────────────────────────────
// Encoder — mirrors scripts/encode-gemma-quantum-container.ts but local.
// ─────────────────────────────────────────────────────────────────────────

function packIndicesBigEndian(indices: Uint8Array, b: number): Uint8Array {
  const totalBits = indices.length * b;
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  let bitPos = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] & ((1 << b) - 1);
    for (let bi = b - 1; bi >= 0; bi--) {
      const bit = (v >> bi) & 1;
      out[bitPos >> 3] |= bit << (7 - (bitPos & 7));
      bitPos++;
    }
  }
  return out;
}

function buildTqBuffer(vecs: Float32Array[], d: number, b: number, seed: number): Buffer {
  const turbo = new TurboQuantizer(d, b, seed);
  const polarBytes = (d * b) / 8;
  const qjlBytes = d / 8;
  const recBytes = polarBytes + qjlBytes + 8;
  const tag = `tq-seed-${seed}-d${d}-b${b}`;
  const sha = createHash('sha256').update(tag, 'utf-8').digest();

  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x5451454d, 0);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(d, 6);
  header.writeUInt8(b, 8);
  header.writeUInt32LE(vecs.length, 9);
  header.writeUInt32LE(seed, 13);
  sha.subarray(0, 15).copy(header, 17);

  const body = Buffer.alloc(vecs.length * recBytes);
  let off = 0;
  for (let i = 0; i < vecs.length; i++) {
    const enc = turbo.encode(vecs[i]);
    body.set(packIndicesBigEndian(enc.polar.quantizedBits, b), off); off += polarBytes;
    body.set(enc.qjlSigns, off); off += qjlBytes;
    body.writeFloatLE(enc.polar.norm, off); off += 4;
    body.writeFloatLE(enc.residualNorm, off); off += 4;
  }
  return Buffer.concat([header, body]);
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

test('QuantumIndex.fromBuffer round-trips records (scoreAll matches estimate)', () => {
  const { vecs } = makeClusteredCorpus();
  const buf = buildTqBuffer(vecs, D, B, SEED);
  const idx = QuantumIndex.fromBuffer(buf);

  assert.equal(idx.header.d, D);
  assert.equal(idx.header.b, B);
  assert.equal(idx.header.n, N);
  assert.equal(idx.header.seed, SEED);

  // Pick an arbitrary query and verify scoreAll[i] equals the standalone
  // turbo.estimateInnerProduct(q, encoded_i) for every i.
  const q = vecs[0]; // self-query — easy to reason about
  const scores = idx.scoreAll(q);

  // Independent reference TurboQuantizer with the same seed produces
  // bit-identical state; encode each vec and estimate via the same path.
  const ref = new TurboQuantizer(D, B, SEED);
  for (let i = 0; i < N; i++) {
    const ref_i = ref.encode(vecs[i]);
    const estRef = ref.estimateInnerProduct(q, ref_i);
    assert.ok(
      Math.abs(scores[i] - estRef) < 1e-3,
      `scoreAll[${i}]=${scores[i]} ≠ ref estimate ${estRef}`,
    );
  }
});

test('QuantumIndex.topK returns descending scores and finite scores only', () => {
  const { vecs } = makeClusteredCorpus();
  const idx = QuantumIndex.fromBuffer(buildTqBuffer(vecs, D, B, SEED));
  const top = idx.topK(vecs[5], 10);

  assert.equal(top.length, 10);
  for (let i = 1; i < top.length; i++) {
    assert.ok(top[i - 1].score >= top[i].score, `not sorted at i=${i}`);
  }
  for (const s of top) assert.ok(Number.isFinite(s.score));
});

test('topK self-query recovers cluster-mates in top-K', () => {
  // Query vector belongs to cluster 2. The cluster has 8 members; we ask
  // for top-12. At least 6 of the cluster's 8 should appear (TurboQuant
  // has variance — perfect recovery isn't guaranteed, but most should hit).
  const { vecs, clusterOf } = makeClusteredCorpus();
  const idx = QuantumIndex.fromBuffer(buildTqBuffer(vecs, D, B, SEED));

  const queryIdx = 16; // cluster 2, member 0
  const cluster = clusterOf[queryIdx];
  const top = idx.topK(vecs[queryIdx], 12);

  const fromCluster = top.filter((s) => clusterOf[s.idx] === cluster).length;
  assert.ok(
    fromCluster >= 6,
    `cluster-recovery too low: ${fromCluster}/8 cluster-mates in top-12`,
  );
  // Top-1 must be the query itself (perfect self-match dominates noise).
  assert.equal(top[0].idx, queryIdx, 'top-1 should be the query itself');
});

test('QuantumCascade.topK matches fp32 top-1 on clustered corpus', async () => {
  const { vecs } = makeClusteredCorpus();

  // Tier A: d=64, b=2 coarse pre-filter
  const D_COARSE = 64;
  const B_COARSE = 2;
  const vecsCoarse = vecs.map((v) => mrlTruncate(new Float32Array(v), D_COARSE));
  const idxCoarse = QuantumIndex.fromBuffer(
    buildTqBuffer(vecsCoarse, D_COARSE, B_COARSE, SEED),
  );

  // Tier B: d=128, b=3 fine
  const idxFine = QuantumIndex.fromBuffer(buildTqBuffer(vecs, D, B, SEED));

  // Exact fp32 rerank
  const flat = new Float32Array(N * D);
  for (let i = 0; i < N; i++) flat.set(vecs[i], i * D);
  const exact = new ExactFp32Index(D, flat, N);

  const cascade = new QuantumCascade(
    [
      { index: idxCoarse, keepTopK: 20 },
      { index: idxFine, keepTopK: 5 },
    ],
    { index: exact, keepTopK: 3 },
    D,
  );

  // Query: half-way between cluster 1 member 0 and cluster 1 member 1.
  const q = new Float32Array(D);
  for (let i = 0; i < D; i++) q[i] = 0.5 * (vecs[8][i] + vecs[9][i]);
  l2normalize(q);

  // fp32 truth
  const truth: Array<{ idx: number; score: number }> = vecs.map((v, i) => {
    let s = 0;
    for (let j = 0; j < D; j++) s += v[j] * q[j];
    return { idx: i, score: s };
  });
  truth.sort((a, b) => b.score - a.score);

  const cascadeTop = cascade.topK(q, 3);
  assert.equal(cascadeTop.length, 3);

  // Top-1 must match truth. Top-3 should overlap ≥ 2 with truth top-3.
  assert.equal(
    cascadeTop[0].idx,
    truth[0].idx,
    `cascade top-1 (${cascadeTop[0].idx}) ≠ fp32 truth (${truth[0].idx})`,
  );
  const truthTop3 = new Set(truth.slice(0, 3).map((r) => r.idx));
  const overlap = cascadeTop.filter((s) => truthTop3.has(s.idx)).length;
  assert.ok(overlap >= 2, `cascade top-3 overlap with truth top-3 only ${overlap}/3`);
});

test('QuantumIndex rejects tampered headers', () => {
  const { vecs } = makeClusteredCorpus();
  const buf = buildTqBuffer(vecs, D, B, SEED);
  // Flip one byte in the seed-sha field.
  const tampered = Buffer.from(buf);
  tampered[20] ^= 0xff;
  assert.throws(() => QuantumIndex.fromBuffer(tampered), /seed_sha256 mismatch/);
});
