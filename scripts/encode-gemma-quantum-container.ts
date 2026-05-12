#!/usr/bin/env tsx
/**
 * Encode the ELSTER catalog as a **Gemma-4 quantum-optimized** container
 * with a Matryoshka×TurboQuant retrieval cascade.
 *
 * Pipeline:
 *   1. Read src/verticals/elster-v3/data/atoms.json (2287 atoms).
 *   2. Embed each atom's text via EmbeddingGemma-300m (Ollama :11434, model
 *      'embeddinggemma', native dim 768, multilingual incl. German) using
 *      the **document task prompt** (`title: none | text: …`). Vectors are
 *      L2-normalized by the model.
 *   3. For each cascade tier (256d, 768d by default): MRL-truncate the
 *      fp32 vector, re-L2-normalize, then TurboQuant-encode.
 *   4. Write per-tier `.tq.bin` files, a cascade manifest, raw fp32 (for
 *      exact rerank), and the container manifest.
 *   5. Self-benchmark: pick a known atom as a held-out query, measure
 *      recall@10 of the cascade vs fp32 truth (sanity check that the
 *      compression preserves ranking quality).
 *
 * Container id: 0711:elster:gemma4-tq:embeddings:v1
 *
 * Usage:
 *   EMBED_CPU=1 OLLAMA_URL=http://localhost:11434 \
 *     tsx scripts/encode-gemma-quantum-container.ts
 *
 * One-time host setup: `ssh h200v 'ollama pull embeddinggemma'`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TurboQuantizer } from '../src/lib/qjl/index.ts';
import {
  embedDocuments,
  embedQueries,
  mrlTruncate,
  GEMMA_EMBED_DEFAULTS,
} from '../src/lib/gemma-embed.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DATA = join(REPO_ROOT, 'src/verticals/elster-v3/data');

const SEED = 42;
const CONTAINER_ID = '0711:elster:gemma4-tq:embeddings:v1';
const BATCH_SIZE = Number(process.env.GEMMA_EMBED_BATCH ?? 32);

/** Cascade tiers, ordered coarse → fine. `keepTopK` is how many candidates
 *  survive past this tier into the next. Final tier's keepTopK is overridden
 *  by the caller's finalK at retrieval time. */
const TIERS: Array<{ d: number; b: number; keepTopK: number; file: string }> = [
  { d: 256, b: 3, keepTopK: 200, file: 'embeddings.gemma4.tq-d256-b3.bin' },
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

function atomText(a: any): string {
  // The embeddable string. EmbeddingGemma's document prefix wraps this:
  //   `title: none | text: <atomText>`.
  // We pack the user-visible bezeichnung + drucktext (form label) which
  // gives the model both the canonical identifier and the field's printed
  // name — important for German tax forms where Drucktext is what users
  // and OCR actually see.
  const dt = a.metadata?.drucktext;
  const base = a.value ?? a.citation_excerpt ?? a.field_name;
  return dt && dt !== base ? `${base} — ${dt}` : base;
}

function atomTitle(a: any): string | undefined {
  // The form/Anlage name acts as a useful title for retrieval. E.g.
  // "ESt1A - Felder" anchors the embedding in the specific tax form.
  return a.citation_section ?? a.metadata?.anlage;
}

// ─────────────────────────────────────────────────────────────────────────
// TurboQuant encoding helper
// ─────────────────────────────────────────────────────────────────────────

interface TierBlob {
  buffer: Buffer;
  sha256: string;
  recordBytes: number;
  compressionRatio: number;
  zeroCount: number;
}

function encodeTier(
  vectors: Float32Array[],
  d: number,
  b: number,
  seed: number,
): TierBlob {
  const turbo = new TurboQuantizer(d, b, seed);
  const POLAR_BYTES = (d * b) / 8;
  const QJL_BYTES = d / 8;
  const REC = POLAR_BYTES + QJL_BYTES + 8;

  const SEED_TAG = `tq-seed-${seed}-d${d}-b${b}`;
  const seedSha = createHash('sha256').update(SEED_TAG, 'utf-8').digest();

  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x5451454d, 0);   // "TQEM"
  header.writeUInt16LE(1, 4);             // version
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

// ─────────────────────────────────────────────────────────────────────────
// Self-benchmark — sanity that the cascade preserves ranking
// ─────────────────────────────────────────────────────────────────────────

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

interface QueryBenchResult {
  query: string;
  /** Truth score of the K-th best fp32 result. TQ top-K is "perfect" if all K
   *  results have fp32 score ≥ this threshold. */
  tieThreshold: number;
  /** Fraction of TQ top-K whose fp32 truth score ≥ tieThreshold. Strict. */
  tieRecallAt10_tq768: number;
  tieRecallAt10_tq256: number;
  tieRecallAt10_cascade: number;
  /** Fraction of TQ top-10 that are in fp32 top-30. Forgiving — credits the
   *  cascade for finding any close neighbor even when fp32 ties are dense. */
  broadRecall_tq768: number;
  broadRecall_tq256: number;
  broadRecall_cascade: number;
  /** Mean absolute estimation error vs fp32 truth across the corpus. */
  meanAbsErr_tq768: number;
  meanAbsErr_tq256: number;
  /** A reading of the truth top-3 for human eyeballing. */
  truthTop3: Array<{ atom_id: string; score: number; drucktext?: string }>;
}

interface BenchResult {
  queries: QueryBenchResult[];
  summary: {
    avgTieRecall_tq768: number;
    avgTieRecall_tq256: number;
    avgTieRecall_cascade: number;
    avgBroadRecall_tq768: number;
    avgBroadRecall_tq256: number;
    avgBroadRecall_cascade: number;
    avgMeanAbsErr_tq768: number;
    avgMeanAbsErr_tq256: number;
  };
}

/**
 * The naive set-overlap recall metric breaks on the ELSTER catalog because
 * the catalog has many bit-identical embeddings (e.g. 12+ different "Betrag"
 * eCodes across Anlagen, all embedding to the exact same 768-d vector because
 * the text "Betrag — Betrag" is identical). The right metric is tie-aware:
 * count how many of the K retrieved hits achieve truth-score ≥ truth's K-th
 * best score. With ties this can exceed naïve recall and correctly credits
 * the cascade for finding equivalent atoms.
 *
 * We also report mean absolute estimation error on the inner product, which
 * is the unbiased TurboQuant Thm-2 quantity we actually care about.
 */
async function runBenchmark(
  atoms: any[],
  fp32: Float32Array[],
  D: number,
): Promise<BenchResult> {
  const { QuantumIndex } = await import('../src/lib/quantum-index.ts');
  const tq768 = encodeTier(fp32, 768, 3, SEED);
  const idx768 = QuantumIndex.fromBuffer(tq768.buffer);
  const fp32_256: Float32Array[] = fp32.map((v) => mrlTruncate(new Float32Array(v), 256));
  const tq256 = encodeTier(fp32_256, 256, 3, SEED);
  const idx256 = QuantumIndex.fromBuffer(tq256.buffer);

  // A small mixed query battery — covers tie-heavy ("Betrag"), specific
  // ("Identifikationsnummer"), German RAG-style ("Anschrift des Spenders"),
  // and English ("donor address" — multilingual sanity).
  const probeTexts = [
    'Betrag',
    'Identifikationsnummer',
    'Anschrift des Spenders',
    'Bruttoarbeitslohn',
    'donor address',
  ];

  const queryVecs = await embedQueries(probeTexts);
  const results: QueryBenchResult[] = [];

  for (let qi = 0; qi < probeTexts.length; qi++) {
    const qFp32 = queryVecs[qi];
    if (qFp32.length !== D) throw new Error(`bench: query dim ${qFp32.length} ≠ ${D}`);
    const q256v = mrlTruncate(new Float32Array(qFp32), 256);

    // Truth: fp32 inner-product over the full catalog.
    const truthAll: Array<{ idx: number; score: number }> = fp32.map((v, i) => ({
      idx: i,
      score: dot(v, qFp32),
    }));
    truthAll.sort((a, b) => b.score - a.score);
    const tieThreshold = truthAll[9].score;

    const top10_tq768 = idx768.topK(qFp32, 10);
    const top10_tq256 = idx256.topK(q256v, 10);
    const survivors200 = idx256.topK(q256v, 200).map((s) => s.idx);
    const top10_cascade = idx768.rerank(qFp32, survivors200, 10);

    const truthScoreOf = new Map(truthAll.map((r) => [r.idx, r.score]));
    const tieRecall = (hits: { idx: number }[]): number => {
      let hit = 0;
      for (const h of hits) {
        const ts = truthScoreOf.get(h.idx)!;
        if (ts >= tieThreshold - 1e-6) hit++;
      }
      return hit / hits.length;
    };
    const truthTop30 = new Set(truthAll.slice(0, 30).map((r) => r.idx));
    const broadRecall = (hits: { idx: number }[]): number => {
      let hit = 0;
      for (const h of hits) if (truthTop30.has(h.idx)) hit++;
      return hit / hits.length;
    };

    // Mean absolute estimation error over the corpus.
    const tqAll768 = idx768.scoreAll(qFp32);
    const tqAll256 = idx256.scoreAll(q256v);
    let sumErr768 = 0;
    let sumErr256 = 0;
    for (let i = 0; i < fp32.length; i++) {
      const truthScore = truthAll.find((r) => r.idx === i)!.score;
      sumErr768 += Math.abs(tqAll768[i] - truthScore);
      // tq-256 estimates inner product in the truncated space; compare to
      // truth-256 (truncate+renorm fp32) for fairness.
      const v256 = fp32_256[i];
      let truthScore256 = 0;
      for (let j = 0; j < 256; j++) truthScore256 += v256[j] * q256v[j];
      sumErr256 += Math.abs(tqAll256[i] - truthScore256);
    }
    const meanAbsErr_tq768 = sumErr768 / fp32.length;
    const meanAbsErr_tq256 = sumErr256 / fp32.length;

    results.push({
      query: probeTexts[qi],
      tieThreshold,
      tieRecallAt10_tq768: tieRecall(top10_tq768),
      tieRecallAt10_tq256: tieRecall(top10_tq256),
      tieRecallAt10_cascade: tieRecall(top10_cascade),
      broadRecall_tq768: broadRecall(top10_tq768),
      broadRecall_tq256: broadRecall(top10_tq256),
      broadRecall_cascade: broadRecall(top10_cascade),
      meanAbsErr_tq768,
      meanAbsErr_tq256,
      truthTop3: truthAll.slice(0, 3).map((r) => ({
        atom_id: atoms[r.idx].atom_id,
        score: r.score,
        drucktext: atoms[r.idx].metadata?.drucktext,
      })),
    });
  }

  const avg = (sel: (r: QueryBenchResult) => number): number =>
    results.reduce((s, r) => s + sel(r), 0) / results.length;

  return {
    queries: results,
    summary: {
      avgTieRecall_tq768: avg((r) => r.tieRecallAt10_tq768),
      avgTieRecall_tq256: avg((r) => r.tieRecallAt10_tq256),
      avgTieRecall_cascade: avg((r) => r.tieRecallAt10_cascade),
      avgBroadRecall_tq768: avg((r) => r.broadRecall_tq768),
      avgBroadRecall_tq256: avg((r) => r.broadRecall_tq256),
      avgBroadRecall_cascade: avg((r) => r.broadRecall_cascade),
      avgMeanAbsErr_tq768: avg((r) => r.meanAbsErr_tq768),
      avgMeanAbsErr_tq256: avg((r) => r.meanAbsErr_tq256),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error(`=== Encoding Gemma-quantum cascade container ===`);
  console.error(`  container_id: ${CONTAINER_ID}`);
  console.error(`  embedder:     ${GEMMA_EMBED_DEFAULTS.model} @ ${GEMMA_EMBED_DEFAULTS.url}`);
  console.error(`  cpu mode:     ${process.env.EMBED_CPU === '1' ? 'YES (vLLM saturates GPUs)' : 'no'}`);

  const atoms: any[] = JSON.parse(await readFile(join(DATA, 'atoms.json'), 'utf-8'));
  console.error(`  atoms:        ${atoms.length}`);

  // ── 1. Embed (document side, with title prefix) ─────────────────────
  console.error(`\n[1/4] Embedding atoms with task prompt 'title: <anlage> | text: <bezeichnung — drucktext>' …`);
  const texts = atoms.map(atomText);
  const titles = atoms.map(atomTitle);

  const t0 = Date.now();
  const [probe] = await embedDocuments([texts[0]], [titles[0]]);
  const D = probe.length;
  console.error(`  native dim:   ${D}`);

  const vectors: Float32Array[] = new Array(atoms.length);
  vectors[0] = probe;
  for (let i = 1; i < atoms.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const tslice = titles.slice(i, i + BATCH_SIZE);
    const batch = await embedDocuments(slice, tslice);
    for (let k = 0; k < batch.length; k++) vectors[i + k] = batch[k];
    if ((i / BATCH_SIZE) % 10 === 0) {
      console.error(`  embedded ${Math.min(i + BATCH_SIZE, atoms.length)}/${atoms.length}`);
    }
  }
  const tEmb = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`  done in ${tEmb}s`);

  // ── 2. Write raw fp32 (exact rerank tier) ───────────────────────────
  console.error(`\n[2/4] Writing fp32 exact-rerank tier …`);
  const fp32Buf = Buffer.alloc(atoms.length * D * 4);
  for (let i = 0; i < atoms.length; i++) {
    const v = vectors[i];
    for (let j = 0; j < D; j++) fp32Buf.writeFloatLE(v[j], (i * D + j) * 4);
  }
  await writeFile(join(DATA, 'embeddings.gemma4.fp32.bin'), fp32Buf);
  const fp32Sha = createHash('sha256').update(fp32Buf).digest('hex');
  console.error(`  embeddings.gemma4.fp32.bin (${fp32Buf.byteLength} B, sha ${fp32Sha.slice(0, 12)}…)`);

  // ── 3. Encode each MRL tier ─────────────────────────────────────────
  console.error(`\n[3/4] Encoding cascade tiers …`);
  const tierBlobs: Array<TierBlob & { spec: typeof TIERS[number] }> = [];
  for (const t of TIERS) {
    const vecs =
      t.d === D
        ? vectors
        : vectors.map((v) => mrlTruncate(new Float32Array(v), t.d));
    const blob = encodeTier(vecs, t.d, t.b, SEED);
    await writeFile(join(DATA, t.file), blob.buffer);
    console.error(
      `  ${t.file.padEnd(40)} d=${t.d} b=${t.b} → ${blob.buffer.byteLength} B (${blob.recordBytes} B/vec, ${blob.compressionRatio.toFixed(2)}×) ${blob.zeroCount > 0 ? `[${blob.zeroCount} zero-vectors]` : ''}`,
    );
    tierBlobs.push({ ...blob, spec: t });
  }

  const projSeed = Buffer.alloc(4);
  projSeed.writeUInt32LE(SEED, 0);
  await writeFile(join(DATA, 'embeddings.gemma4.projection_seed.bin'), projSeed);

  // Legacy fixed-name copy (kept for back-compat with the first container build).
  await writeFile(join(DATA, 'embeddings.gemma4.tq.bin'), tierBlobs[tierBlobs.length - 1].buffer);

  // ── 3b. Cascade manifest + meta + container.gemma4.json ─────────────
  const cascadeManifest = {
    containerId: CONTAINER_ID,
    nativeDim: D,
    embedder: {
      provider: 'ollama',
      model: process.env.EMBED_MODEL ?? GEMMA_EMBED_DEFAULTS.model,
      base_url: process.env.OLLAMA_URL ?? GEMMA_EMBED_DEFAULTS.url,
      family: 'google/embeddinggemma-300m',
      matryoshka: [768, 512, 256, 128],
      document_prompt: 'title: {title|none} | text: {content}',
      query_prompt: 'task: search result | query: {content}',
    },
    seed: SEED,
    tiers: tierBlobs.map((t) => ({
      file: t.spec.file,
      d: t.spec.d,
      b: t.spec.b,
      n: atoms.length,
      keepTopK: t.spec.keepTopK,
      bytesPerVector: t.recordBytes,
      compressionRatio: t.compressionRatio,
      sha256: t.sha256,
    })),
    exact: {
      file: 'embeddings.gemma4.fp32.bin',
      d: D,
      n: atoms.length,
      bytesPerVector: D * 4,
      sha256: fp32Sha,
    },
    quantizer: {
      kind: 'TurboQuant',
      reference: 'arxiv:2504.19874',
      stage_1: 'PolarQuant (Haar rotation + Lloyd-Max @ N(0,1/d))',
      stage_2: 'QJL (sign(S·r) random Gaussian projection)',
      seed_tag_format: 'tq-seed-{seed}-d{d}-b{b}',
    },
  };
  await writeFile(
    join(DATA, 'embeddings.gemma4.cascade.json'),
    JSON.stringify(cascadeManifest, null, 2) + '\n',
  );

  await writeFile(
    join(DATA, 'embeddings.gemma4.meta.json'),
    JSON.stringify(
      {
        container_id: CONTAINER_ID,
        dim: D,
        count: atoms.length,
        seed: SEED,
        embedder: cascadeManifest.embedder,
        atoms: atoms.map((a) => ({ atom_id: a.atom_id, field_name: a.field_name })),
        cascade_manifest: 'embeddings.gemma4.cascade.json',
      },
      null,
      2,
    ) + '\n',
  );

  const containerManifest = {
    id: CONTAINER_ID,
    schema_version: 5,
    version: 'v5.2',
    type: 'embedding-index',
    namespace: 'elster',
    identifier: 'gemma4-tq:embeddings',
    display_name: 'ELSTER eCode Embeddings — EmbeddingGemma + TurboQuant cascade',
    description: `${atoms.length} eCodes embedded via EmbeddingGemma-300m (native ${D}-d, multilingual incl. German). MRL×TurboQuant cascade: ${tierBlobs.map((t) => `d=${t.spec.d}/b=${t.spec.b}@${t.recordBytes}B`).join(' → ')} → fp32 (${D}×4=${D * 4}B).`,
    created_at: new Date().toISOString(),
    catalog_id_ref: '0711:elster:bmf:jahresdok-2024:v1',
    embedder: cascadeManifest.embedder,
    quantizer: cascadeManifest.quantizer,
    artifacts: Object.fromEntries([
      ...tierBlobs.map((t) => [
        t.spec.file,
        { sha256: t.sha256, bytes: t.buffer.byteLength },
      ]),
      ['embeddings.gemma4.fp32.bin', { sha256: fp32Sha, bytes: fp32Buf.byteLength }],
      [
        'embeddings.gemma4.projection_seed.bin',
        {
          sha256: createHash('sha256').update(projSeed).digest('hex'),
          bytes: 4,
        },
      ],
      [
        'embeddings.gemma4.cascade.json',
        {
          sha256: createHash('sha256')
            .update(JSON.stringify(cascadeManifest))
            .digest('hex'),
          bytes: -1,
        },
      ],
    ]),
    signature: null,
    anchor_block_number: null,
    anchor_tx_hash: null,
    anchor_chain: null,
    issuer_fingerprint: null,
  };
  await writeFile(
    join(DATA, 'container.gemma4.json'),
    JSON.stringify(containerManifest, null, 2) + '\n',
  );

  // ── 4. Self-benchmark ───────────────────────────────────────────────
  console.error(`\n[4/4] Self-benchmark: tie-aware recall@10 + mean abs error …`);
  const bench = await runBenchmark(atoms, vectors, D);
  await writeFile(
    join(DATA, 'embeddings.gemma4.bench.json'),
    JSON.stringify(bench, null, 2) + '\n',
  );
  for (const r of bench.queries) {
    console.error(`  "${r.query}"   (truth top-3:`);
    for (const t of r.truthTop3) {
      console.error(`     ${t.atom_id} dt="${t.drucktext ?? '(none)'}" score=${t.score.toFixed(4)})`);
    }
    console.error(`     tie-recall@10  (strict) — tq256:${(r.tieRecallAt10_tq256 * 100).toFixed(0)}%  tq768:${(r.tieRecallAt10_tq768 * 100).toFixed(0)}%  cascade:${(r.tieRecallAt10_cascade * 100).toFixed(0)}%`);
    console.error(`     broad-recall@10 (TQ⊆fp32 top-30) — tq256:${(r.broadRecall_tq256 * 100).toFixed(0)}%  tq768:${(r.broadRecall_tq768 * 100).toFixed(0)}%  cascade:${(r.broadRecall_cascade * 100).toFixed(0)}%`);
    console.error(`     mean abs err   — tq256:${r.meanAbsErr_tq256.toFixed(4)}  tq768:${r.meanAbsErr_tq768.toFixed(4)}`);
  }
  console.error(`  ─────────────────────`);
  console.error(`  Avg tie-recall@10 (strict):   tq256:${(bench.summary.avgTieRecall_tq256 * 100).toFixed(1)}%   tq768:${(bench.summary.avgTieRecall_tq768 * 100).toFixed(1)}%   cascade:${(bench.summary.avgTieRecall_cascade * 100).toFixed(1)}%`);
  console.error(`  Avg broad-recall@10:         tq256:${(bench.summary.avgBroadRecall_tq256 * 100).toFixed(1)}%   tq768:${(bench.summary.avgBroadRecall_tq768 * 100).toFixed(1)}%   cascade:${(bench.summary.avgBroadRecall_cascade * 100).toFixed(1)}%`);
  console.error(`  Avg mean abs err on ⟨q,x⟩:   tq256:${bench.summary.avgMeanAbsErr_tq256.toFixed(4)}      tq768:${bench.summary.avgMeanAbsErr_tq768.toFixed(4)}`);

  console.error(`\n=== Done ===`);
  console.error(`  manifest: embeddings.gemma4.cascade.json`);
  console.error(`  retrieval primitive: src/lib/quantum-index.ts (QuantumCascade.loadFromManifest)`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
