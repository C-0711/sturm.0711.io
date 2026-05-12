/**
 * @0711/qjl — Quantized Johnson-Lindenstrauss retrieval primitives.
 *
 * Reference: "TurboQuant: Near-Optimal Unbiased Vector-Quantization"
 *            (arXiv:2504.19874).
 *
 * Phase 1a scaffold: pure QJL only. The full TurboQuant estimator is
 *
 *     <q, x> ≈ <q, x̂> + ||r|| · <q, sign(S·r)>
 *
 * where x̂ is the MSE-optimal scalar-quantized reconstruction of x and
 * r = x − x̂ is the residual. For this scaffold we set x̂ = 0 so
 * r = x — i.e. we ignore the scalar-quantizer half and benchmark the
 * pure QJL estimator. The `estimateInnerProduct` method exposes the
 * full API so that Phase 1b can plug the MSE quantizer in without a
 * breaking change.
 *
 * Determinism is achieved via a seeded Mulberry32 PRNG and Box–Muller
 * Gaussian transform, so the same `seed` always produces the same
 * projection matrix.
 *
 * No external dependencies (no WASM, no native). Pure TypeScript.
 */

// ----------------------------------------------------------------------
// Deterministic PRNG: Mulberry32 → uniforms → Box–Muller Gaussians
// ----------------------------------------------------------------------

/**
 * Mulberry32: 32-bit PRNG. 10 lines, good enough statistical quality
 * for generating a JL projection matrix. Returns a function that
 * yields uniforms in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box–Muller: two independent N(0,1) samples per call. We buffer the
 * second sample internally to keep the generator cheap.
 */
function makeGaussian(uniform: () => number): () => number {
  let spare: number | null = null;
  return function (): number {
    if (spare !== null) {
      const g = spare;
      spare = null;
      return g;
    }
    // avoid log(0)
    let u1 = uniform();
    while (u1 <= Number.EPSILON) u1 = uniform();
    const u2 = uniform();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const a = 2.0 * Math.PI * u2;
    spare = mag * Math.sin(a);
    return mag * Math.cos(a);
  };
}

// ----------------------------------------------------------------------
// Bit-packing helpers
// ----------------------------------------------------------------------

/** Popcount on a 32-bit integer (Hamming weight). */
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

/**
 * Hamming distance on bit-packed Uint8Arrays. Both arrays must have
 * the same length; bits within a byte are MSB-first.
 */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) {
    throw new Error(`hammingDistance: length mismatch (${a.length} vs ${b.length})`);
  }
  let d = 0;
  // Process 4 bytes at a time when possible.
  const full = a.length & ~3;
  for (let i = 0; i < full; i += 4) {
    const av = (a[i] << 24) | (a[i + 1] << 16) | (a[i + 2] << 8) | a[i + 3];
    const bv = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    d += popcount32((av ^ bv) >>> 0);
  }
  for (let i = full; i < a.length; i++) {
    d += popcount32((a[i] ^ b[i]) & 0xff);
  }
  return d;
}

// ----------------------------------------------------------------------
// QJL projector
// ----------------------------------------------------------------------

export interface QjlProjector {
  /** Input/output dimensionality (square projection for now). */
  readonly d: number;
  /** Length of the packed bit vector in bytes: ceil(d/8). */
  readonly byteLength: number;
  /** Seed used to generate the Gaussian matrix. */
  readonly seed: number;

  /** Project x to sign(S·x) as ceil(d/8) packed bytes. */
  project(x: Float32Array): Uint8Array;

  /**
   * Full-precision projection S·x (no sign reduction). Useful for
   * queries: during a large scan you want to compute S·q once and
   * then dot against each dataset vector's sign bits.
   */
  projectFloat(x: Float32Array): Float32Array;

  /**
   * Like `estimateInnerProduct` but takes the precomputed S·q for
   * efficiency across a scan over many candidates.
   */
  estimateFromSq(Sq: Float32Array, aSigns: Uint8Array, aResidualNorm: number): number;

  /**
   * Full TurboQuant estimator (Phase 1a: x̂ = 0).
   *
   * Computes <q, x̂> + ||r|| · <q, sign(S·r)>. For the scaffold the
   * first term is zero (x̂ = 0, r = x), so we reduce to
   *     ||x|| · sqrt(π/2) · (1/d) · <q, signedDecode(aSigns)>.
   * The sqrt(π/2) factor debiases sign(S·r): E[sign(g)·g] = sqrt(2/π),
   * so the unbiased dot-product estimate is
   *     sqrt(π/2) · (1/d) · Σ_i q_proj[i] · sign(S·x)[i] · ||x||,
   * where q_proj = S·q. We compute S·q internally from the seed.
   *
   * @param qFull         the full-precision query vector (length d)
   * @param aSigns        packed bit-signs of S·x (from project())
   * @param aResidualNorm ||r|| — for Phase 1a callers pass ||x||
   */
  estimateInnerProduct(qFull: Float32Array, aSigns: Uint8Array, aResidualNorm: number): number;
}

/** Debiasing factor for sign(S·r): 1 / E[|g|] = sqrt(π/2). */
const SQRT_PI_OVER_2 = Math.sqrt(Math.PI / 2);

class QjlProjectorImpl implements QjlProjector {
  readonly d: number;
  readonly byteLength: number;
  readonly seed: number;

  /**
   * The d×d Gaussian matrix in row-major order: row i contains the
   * weights that produce the i-th projected coordinate, i.e.
   *     (S·x)[i] = Σ_j S[i*d + j] · x[j].
   */
  private readonly S: Float32Array;

  constructor(d: number, seed: number) {
    if (!Number.isInteger(d) || d <= 0) {
      throw new Error(`QjlProjector: d must be a positive integer (got ${d})`);
    }
    this.d = d;
    this.byteLength = Math.ceil(d / 8);
    this.seed = seed;
    const S = new Float32Array(d * d);
    const g = makeGaussian(mulberry32(seed));
    for (let i = 0; i < S.length; i++) S[i] = g();
    this.S = S;
  }

  project(x: Float32Array): Uint8Array {
    if (x.length !== this.d) {
      throw new Error(`QjlProjector.project: expected length ${this.d}, got ${x.length}`);
    }
    const out = new Uint8Array(this.byteLength);
    const S = this.S;
    const d = this.d;
    for (let i = 0; i < d; i++) {
      let acc = 0;
      const rowOff = i * d;
      // Sum S[i, :] · x
      for (let j = 0; j < d; j++) {
        acc += S[rowOff + j] * x[j];
      }
      if (acc >= 0) {
        // MSB-first packing.
        out[i >>> 3] |= 1 << (7 - (i & 7));
      }
    }
    return out;
  }

  /**
   * Full projection without sign reduction — used internally so we can
   * reuse S·q as full-precision floats in the estimator.
   */
  projectFloat(x: Float32Array): Float32Array {
    if (x.length !== this.d) {
      throw new Error(`QjlProjector.projectFloat: expected length ${this.d}, got ${x.length}`);
    }
    const S = this.S;
    const d = this.d;
    const out = new Float32Array(d);
    for (let i = 0; i < d; i++) {
      let acc = 0;
      const rowOff = i * d;
      for (let j = 0; j < d; j++) acc += S[rowOff + j] * x[j];
      out[i] = acc;
    }
    return out;
  }

  estimateInnerProduct(qFull: Float32Array, aSigns: Uint8Array, aResidualNorm: number): number {
    // Full-precision projection of q. In Phase 1b we'd split q into
    // q̂ + q_r and use <q, x̂> + <q_r, S·r> appropriately, but for
    // pure QJL we project q as-is.
    const Sq = this.projectFloat(qFull);
    return this.estimateFromSq(Sq, aSigns, aResidualNorm);
  }

  estimateFromSq(Sq: Float32Array, aSigns: Uint8Array, aResidualNorm: number): number {
    if (Sq.length !== this.d) {
      throw new Error(
        `QjlProjector.estimateFromSq: expected Sq length ${this.d}, got ${Sq.length}`
      );
    }
    if (aSigns.length !== this.byteLength) {
      throw new Error(
        `QjlProjector.estimateFromSq: expected sign length ${this.byteLength}, got ${aSigns.length}`
      );
    }
    const d = this.d;
    let acc = 0;
    for (let i = 0; i < d; i++) {
      const bit = (aSigns[i >>> 3] >>> (7 - (i & 7))) & 1;
      const s = bit === 1 ? 1 : -1;
      acc += Sq[i] * s;
    }
    // Unbiased estimator of <q, r> given sign(S·r):
    //   (sqrt(π/2) / d) · Σ_i (S·q)[i] · sign((S·r)[i]) · ||r||.
    return (SQRT_PI_OVER_2 / d) * acc * aResidualNorm;
  }
}

/**
 * Build a deterministic d×d QJL projector.
 *
 * @param d    embedding dimensionality
 * @param seed 32-bit unsigned integer; same seed ⇒ same S
 */
export function makeQjlProjector(d: number, seed: number): QjlProjector {
  return new QjlProjectorImpl(d, seed);
}

/**
 * Convenience: unpack a bit-packed signs array to a ±1 Float32Array.
 * Useful for offline analysis.
 */
export function unpackSigns(bits: Uint8Array, d: number): Float32Array {
  if (bits.length < Math.ceil(d / 8)) {
    throw new Error(
      `unpackSigns: bits too short for d=${d} (need ${Math.ceil(d / 8)}, got ${bits.length})`
    );
  }
  const out = new Float32Array(d);
  for (let i = 0; i < d; i++) {
    const bit = (bits[i >>> 3] >>> (7 - (i & 7))) & 1;
    out[i] = bit === 1 ? 1 : -1;
  }
  return out;
}

// ----------------------------------------------------------------------
// Phase 1b: TurboQuant Stage 1 (PolarQuant) + composite (TurboQuantizer).
// These are additive — the QjlProjector API above is preserved verbatim
// so the Phase 1a baseline remains callable for T3 comparison.
// ----------------------------------------------------------------------

export { makeHaarRotation, rotate, transpose } from "./haar.ts";
export {
  lloydMax,
  quantizeScalar,
  dequantizeScalar,
  getCodebook,
  type LloydMaxQuantizer,
} from "./lloyd-max.ts";
export { PolarQuantizer, type PolarEncoded } from "./polar.ts";
export { TurboQuantizer, type TurboEncoded } from "./turbo.ts";
