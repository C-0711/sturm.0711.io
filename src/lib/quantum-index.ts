/**
 * Quantum-retrieval index — reader and scanner for TurboQuant-encoded
 * `.tq.bin` files produced by `scripts/encode-gemma-quantum-container.ts`.
 *
 * Wire-format (mirrors promote-worker stage 5 / CONTAINER-SPEC §7):
 *
 *   header (32 bytes):
 *     magic        u32 LE = 0x5451454D ("TQEM")
 *     version      u16 LE = 1
 *     d            u16 LE
 *     b            u8
 *     n            u32 LE
 *     seed         u32 LE
 *     seed_sha256  [15] = first 15 bytes of sha256(`tq-seed-${seed}-d${d}-b${b}`)
 *     pad          [1]  = 0
 *   per-vector record (n × (d*b/8 + d/8 + 8)):
 *     polar        d*b/8 bytes (Lloyd-Max indices, MSB-first bit-packed)
 *     qjl          d/8   bytes (sign(S·r) packed, MSB-first)
 *     x_norm       f32   LE (||x||; for EmbeddingGemma always ~1.0)
 *     r_norm       f32   LE (||r||)
 *
 * On load() we materialize a `TurboQuantizer` for the (d, b, seed) triple
 * and decode all records into in-memory `TurboEncoded` objects. Each record
 * is decoded once (eager x̂ via PolarQuant) so per-query scoring is just
 * O(n·d) over already-allocated buffers.
 *
 * # Innovation: Matryoshka × TurboQuant cascade
 *
 * EmbeddingGemma is MRL — same model, four output dims (768/512/256/128)
 * each producing a usable embedding space. TurboQuant compresses at any
 * dim independently. Composed, you get a cascade:
 *
 *   Tier 0  d=128, b=2  →  40 B/vec   ( 76× vs fp32×768)   coarse pre-filter
 *   Tier 1  d=256, b=3  → 136 B/vec   (22.6× vs fp32×768)  mid rerank
 *   Tier 2  d=768, b=3  → 392 B/vec   ( 7.8× vs fp32×768)  fine rerank
 *   Tier 3  fp32×768    → 3072 B/vec  ( 1.0×)              exact rerank
 *
 * Retrieval cost stays O(n) only on Tier 0; deeper tiers see only the
 * surviving candidates (e.g. top-200 → top-50 → top-10). At n=2287 the
 * cascade is overkill, but at n=100K+ (the full 0711 catalog) it's the
 * difference between sub-ms and seconds.
 *
 * The cascade also gives you a free **quality/latency knob**: drop the
 * exact rerank for cheap-but-noisy retrieval; keep it for high-stakes
 * citation flows like Layer 2 entity resolution.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  TurboQuantizer,
  type TurboEncoded,
  type PolarEncoded,
} from './qjl/index.ts';

const TQEM_MAGIC = 0x5451454d; // "TQEM" little-endian
const HEADER_BYTES = 32;

export interface QuantumIndexHeader {
  version: number;
  d: number;
  b: number;
  n: number;
  seed: number;
  seedSha15: Buffer;
}

export interface QuantumScore {
  /** Index into the index's atom array (0..n-1). */
  idx: number;
  /** Unbiased TurboQuant Thm-2 estimate of ⟨q, x⟩ (= cosine when ||x|| = ||q|| = 1). */
  score: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Tight bit-unpacker — inverse of packIndicesBigEndian in the encoder.
// ─────────────────────────────────────────────────────────────────────────

function unpackIndicesBigEndian(
  packed: Uint8Array,
  d: number,
  b: number,
): Uint8Array {
  const out = new Uint8Array(d);
  let bitPos = 0;
  for (let i = 0; i < d; i++) {
    let v = 0;
    for (let bi = b - 1; bi >= 0; bi--) {
      const bytePos = bitPos >> 3;
      const bitInByte = 7 - (bitPos & 7);
      const bit = (packed[bytePos] >>> bitInByte) & 1;
      v |= bit << bi;
      bitPos++;
    }
    out[i] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Min-heap for streaming top-k. Order: smallest score at root.
// ─────────────────────────────────────────────────────────────────────────

class MinHeap {
  private a: QuantumScore[] = [];
  constructor(public readonly capacity: number) {}
  size(): number { return this.a.length; }
  peek(): QuantumScore | undefined { return this.a[0]; }
  pushIfBetter(item: QuantumScore): void {
    if (this.a.length < this.capacity) {
      this.a.push(item);
      this.bubbleUp(this.a.length - 1);
    } else if (this.a[0].score < item.score) {
      this.a[0] = item;
      this.bubbleDown(0);
    }
  }
  /** Returns items sorted descending by score. */
  drainSorted(): QuantumScore[] {
    return [...this.a].sort((p, q) => q.score - p.score);
  }
  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].score <= this.a[i].score) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  private bubbleDown(i: number): void {
    const n = this.a.length;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.a[l].score < this.a[m].score) m = l;
      if (r < n && this.a[r].score < this.a[m].score) m = r;
      if (m === i) break;
      [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
      i = m;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// QuantumIndex
// ─────────────────────────────────────────────────────────────────────────

export class QuantumIndex {
  readonly header: QuantumIndexHeader;
  readonly turbo: TurboQuantizer;
  /** Decoded records, one per vector. PolarEncoded objects are eager so
   *  estimateFromSq doesn't pay decode cost per query. */
  private readonly records: TurboEncoded[];

  private constructor(
    header: QuantumIndexHeader,
    turbo: TurboQuantizer,
    records: TurboEncoded[],
  ) {
    this.header = header;
    this.turbo = turbo;
    this.records = records;
  }

  static async load(path: string): Promise<QuantumIndex> {
    const buf = await readFile(path);
    return QuantumIndex.fromBuffer(buf);
  }

  static fromBuffer(buf: Buffer): QuantumIndex {
    if (buf.length < HEADER_BYTES) {
      throw new Error(`QuantumIndex: file too short (${buf.length} bytes)`);
    }
    const magic = buf.readUInt32LE(0);
    if (magic !== TQEM_MAGIC) {
      throw new Error(
        `QuantumIndex: bad magic 0x${magic.toString(16)} (expected 0x${TQEM_MAGIC.toString(16)})`,
      );
    }
    const version = buf.readUInt16LE(4);
    if (version !== 1) throw new Error(`QuantumIndex: unsupported version ${version}`);
    const d = buf.readUInt16LE(6);
    const b = buf.readUInt8(8);
    const n = buf.readUInt32LE(9);
    const seed = buf.readUInt32LE(13);
    const seedSha15 = Buffer.from(buf.subarray(17, 32));
    // Verify seed-sha15 matches the canonical tag — cheap tamper check.
    const expectedTag = `tq-seed-${seed}-d${d}-b${b}`;
    const expectedSha = createHash('sha256').update(expectedTag, 'utf-8').digest();
    if (!seedSha15.equals(expectedSha.subarray(0, 15))) {
      throw new Error(
        `QuantumIndex: seed_sha256 mismatch — file claims seed=${seed} d=${d} b=${b} but hash diverges`,
      );
    }

    const polarBytes = (d * b) / 8;
    const qjlBytes = d / 8;
    if (!Number.isInteger(polarBytes) || !Number.isInteger(qjlBytes)) {
      throw new Error(`QuantumIndex: d=${d} b=${b} not byte-aligned`);
    }
    const recBytes = polarBytes + qjlBytes + 8;
    const expectedBody = n * recBytes;
    if (buf.length !== HEADER_BYTES + expectedBody) {
      throw new Error(
        `QuantumIndex: file size mismatch — have ${buf.length}, expected ${HEADER_BYTES + expectedBody} for n=${n} d=${d} b=${b}`,
      );
    }

    const turbo = new TurboQuantizer(d, b, seed);

    // Decode all records.
    const records: TurboEncoded[] = new Array(n);
    let off = HEADER_BYTES;
    for (let i = 0; i < n; i++) {
      const polarPacked = buf.subarray(off, off + polarBytes);
      off += polarBytes;
      const qjlSigns = new Uint8Array(buf.subarray(off, off + qjlBytes));
      off += qjlBytes;
      const xNorm = buf.readFloatLE(off); off += 4;
      const rNorm = buf.readFloatLE(off); off += 4;

      const quantizedBits =
        xNorm === 0 ? new Uint8Array(d) : unpackIndicesBigEndian(polarPacked, d, b);
      const polar: PolarEncoded = { quantizedBits, norm: xNorm, residualNorm: rNorm, b, d };
      records[i] = { polar, qjlSigns, residualNorm: rNorm };
    }

    return new QuantumIndex(
      { version, d, b, n, seed, seedSha15 },
      turbo,
      records,
    );
  }

  get d(): number { return this.header.d; }
  get b(): number { return this.header.b; }
  get n(): number { return this.header.n; }

  /**
   * Score every record against the query. Returns a Float32Array of length n
   * with the unbiased Thm-2 inner-product estimate. Query length must equal d.
   */
  scoreAll(query: Float32Array): Float32Array {
    if (query.length !== this.d) {
      throw new Error(`scoreAll: query dim ${query.length} ≠ index d=${this.d}`);
    }
    // S·q computed once and reused for all records.
    const Sq = this.turbo.qjl.projectFloat(query);
    const out = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      out[i] = this.turbo.estimateFromSq(query, Sq, this.records[i]);
    }
    return out;
  }

  /**
   * Heap-based top-k retrieval. Returns indices+scores sorted by descending
   * score. O(n · log k) heap ops; the dominant cost is the per-record dot
   * product inside estimateFromSq (≈ d float-muls + d Hamming bits).
   */
  topK(query: Float32Array, k: number): QuantumScore[] {
    if (k <= 0) return [];
    if (query.length !== this.d) {
      throw new Error(`topK: query dim ${query.length} ≠ index d=${this.d}`);
    }
    const Sq = this.turbo.qjl.projectFloat(query);
    const heap = new MinHeap(Math.min(k, this.n));
    for (let i = 0; i < this.n; i++) {
      const score = this.turbo.estimateFromSq(query, Sq, this.records[i]);
      heap.pushIfBetter({ idx: i, score });
    }
    return heap.drainSorted();
  }

  /**
   * Restricted top-k over a candidate set — used by the cascade for rerank
   * passes where a coarser tier already narrowed the field.
   */
  rerank(query: Float32Array, candidates: number[], k: number): QuantumScore[] {
    if (k <= 0) return [];
    if (query.length !== this.d) {
      throw new Error(`rerank: query dim ${query.length} ≠ index d=${this.d}`);
    }
    const Sq = this.turbo.qjl.projectFloat(query);
    const heap = new MinHeap(Math.min(k, candidates.length));
    for (const idx of candidates) {
      const score = this.turbo.estimateFromSq(query, Sq, this.records[idx]);
      heap.pushIfBetter({ idx, score });
    }
    return heap.drainSorted();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Exact (fp32) rerank — optional final stage
// ─────────────────────────────────────────────────────────────────────────

export class ExactFp32Index {
  constructor(
    public readonly d: number,
    /** Raw vectors, row-major, length n × d. Float32. */
    private readonly data: Float32Array,
    public readonly n: number,
  ) {
    if (data.length !== n * d) {
      throw new Error(`ExactFp32Index: data ${data.length} ≠ n*d = ${n * d}`);
    }
  }

  static async load(path: string, d: number): Promise<ExactFp32Index> {
    const buf = await readFile(path);
    if (buf.byteLength % 4 !== 0 || buf.byteLength % (d * 4) !== 0) {
      throw new Error(
        `ExactFp32Index: ${path} byteLength ${buf.byteLength} not multiple of d*4 = ${d * 4}`,
      );
    }
    const n = buf.byteLength / (d * 4);
    // Buffer → Float32Array, zero-copy when alignment matches; safe-copy otherwise.
    const aligned = buf.byteOffset % 4 === 0
      ? new Float32Array(buf.buffer, buf.byteOffset, n * d)
      : new Float32Array(new Uint8Array(buf).buffer);
    // Detach from underlying Node Buffer to avoid lifetime surprises.
    return new ExactFp32Index(d, new Float32Array(aligned), n);
  }

  rerank(query: Float32Array, candidates: number[], k: number): QuantumScore[] {
    if (query.length !== this.d) {
      throw new Error(`ExactFp32Index.rerank: q dim ${query.length} ≠ d=${this.d}`);
    }
    if (k <= 0) return [];
    const heap = new MinHeap(Math.min(k, candidates.length));
    for (const idx of candidates) {
      const off = idx * this.d;
      let acc = 0;
      for (let j = 0; j < this.d; j++) acc += this.data[off + j] * query[j];
      heap.pushIfBetter({ idx, score: acc });
    }
    return heap.drainSorted();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Cascade
// ─────────────────────────────────────────────────────────────────────────

export interface CascadeTierSpec {
  /** Loaded quantum index for this tier. */
  index: QuantumIndex;
  /** Candidates to survive past this tier. Last tier sets the final K. */
  keepTopK: number;
}

export interface CascadeManifest {
  containerId: string;
  nativeDim: number;
  tiers: Array<{
    file: string;
    d: number;
    b: number;
    n: number;
    keepTopK: number;
    bytesPerVector: number;
  }>;
  exact?: {
    file: string;
    d: number;
    n: number;
  };
}

/**
 * Multi-tier cascade. Embed the query once at native dim, then for each tier
 * MRL-truncate to that tier's d, re-L2-normalize, and rerank the prior tier's
 * survivors. Optional fp32 final pass for exact scores on the final top-K.
 */
export class QuantumCascade {
  constructor(
    public readonly tiers: CascadeTierSpec[],
    public readonly exact?: { index: ExactFp32Index; keepTopK: number },
    public readonly nativeDim: number = tiers[tiers.length - 1]?.index.d ?? 0,
  ) {
    if (tiers.length === 0) throw new Error('QuantumCascade: at least one tier required');
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].index.d < tiers[i - 1].index.d) {
        throw new Error(
          `QuantumCascade: tiers must be ordered coarse→fine (tier ${i} d=${tiers[i].index.d} < tier ${i - 1} d=${tiers[i - 1].index.d})`,
        );
      }
    }
  }

  /**
   * Build cascade from a manifest JSON. Paths are resolved relative to `dir`.
   */
  static async loadFromManifest(
    dir: string,
    manifest: CascadeManifest,
    finalK: number,
  ): Promise<QuantumCascade> {
    const tiers: CascadeTierSpec[] = [];
    for (const t of manifest.tiers) {
      tiers.push({ index: await QuantumIndex.load(join(dir, t.file)), keepTopK: t.keepTopK });
    }
    let exact: { index: ExactFp32Index; keepTopK: number } | undefined;
    if (manifest.exact) {
      exact = {
        index: await ExactFp32Index.load(join(dir, manifest.exact.file), manifest.exact.d),
        keepTopK: finalK,
      };
    }
    // Tighten the last quantum tier's keepTopK to finalK if no exact rerank.
    if (!exact) tiers[tiers.length - 1].keepTopK = finalK;
    return new QuantumCascade(tiers, exact, manifest.nativeDim);
  }

  /**
   * Run the cascade. `queryNative` must be at the native dim (the largest
   * tier's d, or the fp32 d) and L2-normalized. The cascade MRL-truncates
   * and re-normalizes per tier internally.
   */
  topK(queryNative: Float32Array, finalK: number): QuantumScore[] {
    if (queryNative.length !== this.nativeDim) {
      throw new Error(
        `QuantumCascade.topK: query dim ${queryNative.length} ≠ nativeDim ${this.nativeDim}`,
      );
    }

    // Tier 0: scan everyone.
    const first = this.tiers[0];
    const q0 = mrlSlice(queryNative, first.index.d);
    let survivors = first.index.topK(q0, first.keepTopK).map((s) => s.idx);

    // Subsequent quantum tiers: rerank survivors only.
    for (let i = 1; i < this.tiers.length; i++) {
      const t = this.tiers[i];
      const qi = mrlSlice(queryNative, t.index.d);
      survivors = t.index.rerank(qi, survivors, t.keepTopK).map((s) => s.idx);
    }

    // Optional exact fp32 rerank — pulls real scores so the caller can
    // threshold meaningfully (e.g. cosine ≥ 0.7).
    if (this.exact) {
      return this.exact.index.rerank(queryNative, survivors, finalK);
    }
    // No exact rerank: re-score survivors at the finest quantum tier to
    // return scores+ids together.
    const fine = this.tiers[this.tiers.length - 1];
    const qFine = mrlSlice(queryNative, fine.index.d);
    return fine.index.rerank(qFine, survivors, finalK);
  }

  /** Aggregate compression description for logging. */
  describe(): string {
    const parts = this.tiers.map(
      (t) => `d=${t.index.d}/b=${t.index.b} (${t.index.n}×${recordBytes(t.index.d, t.index.b)}B, keep top ${t.keepTopK})`,
    );
    return `cascade[${parts.join(' → ')}${this.exact ? ` → fp32×${this.exact.index.d}` : ''}]`;
  }
}

function mrlSlice(v: Float32Array, dim: number): Float32Array {
  if (dim === v.length) return v;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = v[i];
  // Re-L2-normalize per EmbeddingGemma's MRL contract.
  let n2 = 0;
  for (let i = 0; i < dim; i++) n2 += out[i] * out[i];
  if (n2 > 0) {
    const inv = 1 / Math.sqrt(n2);
    for (let i = 0; i < dim; i++) out[i] *= inv;
  }
  return out;
}

function recordBytes(d: number, b: number): number {
  return (d * b) / 8 + d / 8 + 8;
}
