#!/usr/bin/env tsx
/**
 * Re-quantize the ELSTER Gemma-TurboQuant cascade DIRECTLY from the existing
 * `embeddings.gemma4.fp32.bin` — no re-embedding.
 *
 * Why this exists:
 *   The container at v5.8 had a known inconsistency between fp32.bin and the
 *   TQ-Tiers. The fp32 was RESTORED from a backup, but the TQ-Tiers were
 *   re-quantized from a DIFFERENT in-memory embedding run (different prompt,
 *   different text inputs, or just a different Ollama session). Result:
 *   QuantumCascade.topK(stored_vec) does NOT return idx with cos=1.0 — the
 *   TQ-Tiers index a different space than fp32.bin.
 *
 *   This script fixes that by re-quantizing FROM the current fp32.bin
 *   (the ground truth, sealed catalog vectors) using the same deterministic
 *   TurboQuant pipeline (Lloyd-Max + QJL with seed=42).
 *
 * Pipeline:
 *   1. Read fp32.bin → vectors[] (2287 × 768, L2-normalized).
 *   2. For each tier d ∈ {128, 256, 512, 768}: MRL-truncate, re-L2-normalize,
 *      TurboQuant-encode (same b-values + seed=42 as the original container).
 *   3. Write new `.tq.bin` files (overwriting the broken ones).
 *   4. Update `embeddings.gemma4.cascade.json` with new sha256s
 *      (atoms.json + fp32.bin unchanged).
 *   5. Update `container.gemma4.json` artifacts block + description.
 *   6. Self-test: load cascade, query with stored atom #500's vector →
 *      must return idx=500 in top-1 with score≈1.0.
 *
 * Usage:
 *   npx tsx scripts/requantize-from-fp32.ts
 *
 * No GPU, no network. Deterministic. Runs in <5s.
 */

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TurboQuantizer } from '../src/lib/qjl/index.ts';
import { l2normalize, mrlTruncate } from '../src/lib/gemma-embed.ts';
import { QuantumCascade, type CascadeManifest } from '../src/lib/quantum-index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DATA = join(REPO_ROOT, 'src/verticals/elster-v3/data');

const SEED = 42;
const NATIVE_D = 768;

const TIERS = [
  { d: 128, b: 2, keepTopK: 500, file: 'embeddings.gemma4.tq-d128-b2.bin' },
  { d: 256, b: 3, keepTopK: 200, file: 'embeddings.gemma4.tq-d256-b3.bin' },
  { d: 512, b: 3, keepTopK: 100, file: 'embeddings.gemma4.tq-d512-b3.bin' },
  { d: 768, b: 3, keepTopK: 50,  file: 'embeddings.gemma4.tq-d768-b3.bin' },
];

function packIndicesBigEndian(indices: Uint8Array, b: number): Uint8Array {
  const totalBits = indices.length * b;
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  let bitPos = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] & ((1 << b) - 1);
    for (let bi = b - 1; bi >= 0; bi--) {
      const bit = (v >> bi) & 1;
      const bytePos = bitPos >> 3;
      const bitInByte = 7 - (bitPos & 7);
      out[bytePos] |= bit << bitInByte;
      bitPos++;
    }
  }
  return out;
}

interface TierBlob {
  buffer: Buffer;
  sha256: string;
  recordBytes: number;
  compressionRatio: number;
  zeroCount: number;
}

function encodeTier(vectors: Float32Array[], d: number, b: number, seed: number): TierBlob {
  const turbo = new TurboQuantizer(d, b, seed);
  const POLAR_BYTES = (d * b) / 8;
  const QJL_BYTES = d / 8;
  const REC = POLAR_BYTES + QJL_BYTES + 8;

  const SEED_TAG = `tq-seed-${seed}-d${d}-b${b}`;
  const seedSha = createHash('sha256').update(SEED_TAG, 'utf-8').digest();

  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x5451454d, 0);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(d, 6);
  header.writeUInt8(b, 8);
  header.writeUInt32LE(vectors.length, 9);
  header.writeUInt32LE(seed, 13);
  seedSha.subarray(0, 15).copy(header, 17);

  const body = Buffer.alloc(vectors.length * REC);
  let off = 0;
  let zeroCount = 0;
  for (let i = 0; i < vectors.length; i++) {
    const x = vectors[i];
    if (x.length !== d) {
      throw new Error(`encodeTier(d=${d}): vector ${i} has length ${x.length}`);
    }
    let norm2 = 0;
    for (let j = 0; j < d; j++) norm2 += x[j] * x[j];
    if (norm2 === 0) {
      off += REC;
      zeroCount++;
      continue;
    }
    const enc = turbo.encode(x);
    const packed = packIndicesBigEndian(enc.polar.quantizedBits, b);
    body.set(packed, off); off += POLAR_BYTES;
    body.set(enc.qjlSigns, off); off += QJL_BYTES;
    body.writeFloatLE(enc.polar.norm, off); off += 4;
    body.writeFloatLE(enc.residualNorm, off); off += 4;
  }
  const buf = Buffer.concat([header, body]);
  return {
    buffer: buf,
    sha256: createHash('sha256').update(buf).digest('hex'),
    recordBytes: REC,
    compressionRatio: (d * 4) / REC,
    zeroCount,
  };
}

async function main(): Promise<void> {
  console.error('=== Re-Quantize ELSTER Quantum Container from fp32.bin ===');
  console.error(`  data dir:  ${DATA}`);
  console.error(`  seed:      ${SEED}`);
  console.error(`  tiers:     ${TIERS.map((t) => `d=${t.d}/b=${t.b}`).join(', ')}`);

  // 1. Read fp32.bin and reconstruct vectors[].
  const fp32Buf = await readFile(join(DATA, 'embeddings.gemma4.fp32.bin'));
  if (fp32Buf.byteLength % (NATIVE_D * 4) !== 0) {
    throw new Error(`fp32.bin size ${fp32Buf.byteLength} not multiple of ${NATIVE_D}*4`);
  }
  const nAtoms = fp32Buf.byteLength / (NATIVE_D * 4);
  console.error(`  fp32.bin:  ${fp32Buf.byteLength} B = ${nAtoms} × ${NATIVE_D} × 4`);

  const vectors: Float32Array[] = new Array(nAtoms);
  for (let i = 0; i < nAtoms; i++) {
    const off = i * NATIVE_D * 4;
    const v = new Float32Array(NATIVE_D);
    for (let j = 0; j < NATIVE_D; j++) {
      v[j] = fp32Buf.readFloatLE(off + j * 4);
    }
    vectors[i] = v;
  }
  const fp32Sha = createHash('sha256').update(fp32Buf).digest('hex');
  console.error(`  fp32 sha:  ${fp32Sha.slice(0, 24)}…`);

  // Sanity: ||v|| should be ~1.0 (L2-normalized by EmbeddingGemma).
  const sampleIdx = [0, 100, 500, 1000, 2000, nAtoms - 1];
  for (const i of sampleIdx) {
    let n2 = 0;
    for (let j = 0; j < NATIVE_D; j++) n2 += vectors[i][j] * vectors[i][j];
    if (Math.abs(Math.sqrt(n2) - 1.0) > 1e-3) {
      throw new Error(`fp32 vector ${i} not L2-normalized: ||v||=${Math.sqrt(n2)}`);
    }
  }
  console.error(`  ✓ all sampled vectors L2-normalized`);

  // 2. Backup old TQ-Tiers (suffix .pre-requantize-{timestamp}).
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  console.error(`\n[backup] Sichere alte TQ-Tiers vor Ueberschreiben:`);
  for (const t of TIERS) {
    const src = join(DATA, t.file);
    const bak = join(DATA, `${t.file}.pre-requantize-${ts}`);
    try {
      await copyFile(src, bak);
      console.error(`  ${t.file} → ${t.file}.pre-requantize-${ts}`);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      console.error(`  ${t.file} not present, skipping backup`);
    }
  }

  // 3. Re-encode each tier.
  console.error(`\n[re-encode] TQ-Tiers from fp32.bin (MRL-truncate + Lloyd-Max + QJL):`);
  const tierBlobs: Array<TierBlob & { spec: typeof TIERS[number] }> = [];
  for (const t of TIERS) {
    const t0 = Date.now();
    const vecs =
      t.d === NATIVE_D
        ? vectors
        : vectors.map((v) => {
            const truncated = mrlTruncate(v, t.d);
            return l2normalize(new Float32Array(truncated));
          });
    const blob = encodeTier(vecs, t.d, t.b, SEED);
    await writeFile(join(DATA, t.file), blob.buffer);
    const ms = Date.now() - t0;
    console.error(
      `  ${t.file.padEnd(40)} d=${t.d} b=${t.b} → ${blob.buffer.byteLength} B (${blob.recordBytes} B/vec, ${blob.compressionRatio.toFixed(2)}×)  ${ms}ms  sha=${blob.sha256.slice(0, 16)}…`,
    );
    tierBlobs.push({ ...blob, spec: t });
  }

  // 4. Update cascade.json (atoms + fp32 unchanged).
  const cascadePath = join(DATA, 'embeddings.gemma4.cascade.json');
  const existingCascade = JSON.parse(await readFile(cascadePath, 'utf-8'));
  const updatedCascade: CascadeManifest & Record<string, unknown> = {
    ...existingCascade,
    nativeDim: NATIVE_D,
    seed: SEED,
    tiers: tierBlobs.map((t) => ({
      file: t.spec.file,
      d: t.spec.d,
      b: t.spec.b,
      n: nAtoms,
      keepTopK: t.spec.keepTopK,
      bytesPerVector: t.recordBytes,
      compressionRatio: t.compressionRatio,
      sha256: t.sha256,
    })),
    exact: {
      file: 'embeddings.gemma4.fp32.bin',
      d: NATIVE_D,
      n: nAtoms,
      bytesPerVector: NATIVE_D * 4,
      sha256: fp32Sha,
    },
    requantized_at: new Date().toISOString(),
    requantize_source: 'embeddings.gemma4.fp32.bin (sealed, unchanged)',
  };
  await writeFile(cascadePath, JSON.stringify(updatedCascade, null, 2) + '\n');
  console.error(`\n[cascade.json] updated with new TQ-Tier sha256s`);

  // 5. Update container.gemma4.json artifacts block + description.
  const containerPath = join(DATA, 'container.gemma4.json');
  const existingContainer = JSON.parse(await readFile(containerPath, 'utf-8'));
  const newArtifacts = { ...(existingContainer.artifacts ?? {}) };
  for (const t of tierBlobs) {
    newArtifacts[t.spec.file] = { sha256: t.sha256, bytes: t.buffer.byteLength };
  }
  const updatedContainer = {
    ...existingContainer,
    version: 'v5.9',
    updated_at: new Date().toISOString(),
    description:
      `${nAtoms} eCodes embedded via EmbeddingGemma-300m (native d=${NATIVE_D}, multilingual). ` +
      `MRL × TurboQuant cascade: ${tierBlobs.map((t) => `d=${t.spec.d}/b=${t.spec.b}@${t.recordBytes}B`).join(' → ')} → fp32 (${NATIVE_D}×4=${NATIVE_D * 4}B). ` +
      `v5.9 (${new Date().toISOString().slice(0, 10)}): TQ-Tiers re-quantized DETERMINISTICALLY from sealed fp32.bin (seed=${SEED}). ` +
      `Behebt v5.8-Inkonsistenz wo TQ-Tiers aus anderem Embedding-Run als fp32.bin stammten.`,
    artifacts: newArtifacts,
  };
  await writeFile(containerPath, JSON.stringify(updatedContainer, null, 2) + '\n');
  console.error(`[container.gemma4.json] bumped v5.8 → v5.9`);

  // 6. Self-test: load cascade, query with stored atom #500.
  console.error(`\n[self-test] Cascade.topK(stored_vec[500], 5):`);
  const cascade = await QuantumCascade.loadFromManifest(DATA, updatedCascade as CascadeManifest, 5);
  const atomsRaw = JSON.parse(await readFile(join(DATA, 'atoms.json'), 'utf-8'));

  for (const targetIdx of [0, 500, 1000, 2000]) {
    const q = new Float32Array(vectors[targetIdx]);
    const top = cascade.topK(q, 5);
    const selfRank = top.findIndex((h) => h.idx === targetIdx);
    const top1 = top[0];
    const status = selfRank === 0 ? 'PASS' : selfRank > 0 ? `RANK ${selfRank + 1}` : 'NOT IN TOP 5';
    console.error(
      `  atom #${String(targetIdx).padStart(4)} (${atomsRaw[targetIdx]?.field_name ?? '?'}): top-1 idx=${top1?.idx} score=${top1?.score.toFixed(4)} | self-rank=${status}`,
    );
  }

  console.error(`\n✓ Re-quantize complete.`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
