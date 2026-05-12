/**
 * PolarQuantizer — Stage 1 of TurboQuant (arxiv 2504.19874 §3).
 *
 * Pipeline:
 *
 *     x ∈ R^d
 *       │  rotate y = Π · x (Π Haar-random, same seed across encoder/decoder)
 *       ▼
 *     y ∈ R^d       -- post-rotation coords are asymptotically N(0, ‖x‖²/d)
 *       │  scale by 1/‖x‖  (so the quantizer sees unit-norm-target coords)
 *       ▼
 *     ỹ             -- i.i.d.-ish N(0, 1/d)
 *       │  Lloyd-Max codebook (b bits per coord, designed for N(0, 1/d))
 *       ▼
 *     q ∈ {0..2^b−1}^d         -- store this (b bits per dim)
 *       plus ‖x‖   (float32)   -- one scalar per vector
 *
 * Decode:
 *
 *     q   → ŷ  (Lloyd-Max dequantize) → scale by ‖x‖ → un-rotate via Πᵀ
 *
 * The residual r = x − x̂ is what TurboQuant's Stage 2 (QJL) then attacks
 * with a random-sign Johnson-Lindenstrauss sketch (see turbo.ts).
 */

import { makeHaarRotation, rotate, transpose } from "./haar.ts";
import { quantizeScalar, dequantizeScalar } from "./lloyd-max.ts";

export interface PolarEncoded {
  /** Lloyd-Max indices in the rotated, norm-normalized coord system. */
  quantizedBits: Uint8Array;
  /** ‖x‖ for un-scaling on decode. */
  norm: number;
  /** ‖x − x̂‖ — filled in by encode() and reused by the TurboQuant stage 2 estimator. */
  residualNorm: number;
  /** bits-per-dim (mirrors the quantizer the encoder was configured with). */
  b: number;
  /** dimensionality (sanity check across encode/decode). */
  d: number;
}

export class PolarQuantizer {
  /** Row-major d×d Haar rotation. */
  readonly Pi: Float32Array;
  /** Cached transpose for the inverse rotation on decode. */
  readonly PiT: Float32Array;

  constructor(
    public readonly d: number,
    public readonly b: number,
    public readonly seed: number
  ) {
    if (!Number.isInteger(d) || d <= 0) {
      throw new Error(`PolarQuantizer: d must be positive int (got ${d})`);
    }
    if (!Number.isInteger(b) || b < 1 || b > 8) {
      throw new Error(`PolarQuantizer: b must be 1..8 (got ${b})`);
    }
    this.Pi = makeHaarRotation(d, seed);
    this.PiT = transpose(this.Pi, d);
  }

  encode(x: Float32Array): PolarEncoded {
    if (x.length !== this.d) {
      throw new Error(`PolarQuantizer.encode: expected length ${this.d}, got ${x.length}`);
    }
    // y = Π · x
    const y = rotate(this.Pi, x, this.d);

    // ‖x‖ = ‖y‖ because Π is orthogonal.
    let norm2 = 0;
    for (let i = 0; i < this.d; i++) norm2 += y[i] * y[i];
    const xNorm = Math.sqrt(norm2);
    const invNorm = xNorm > 0 ? 1 / xNorm : 0;

    // Scale so that ỹ ~ N(0, 1/d) on average (the quantizer's design point).
    const yTilde = new Float32Array(this.d);
    for (let i = 0; i < this.d; i++) yTilde[i] = y[i] * invNorm;

    const quantizedBits = quantizeScalar(yTilde, this.b, this.d);

    // We also want the residual norm for the Stage-2 estimator. Compute
    // it now so callers don't pay the cost of re-decoding.
    const yHatTilde = dequantizeScalar(quantizedBits, this.b, this.d);
    let residual2 = 0;
    for (let i = 0; i < this.d; i++) {
      const diff = yTilde[i] - yHatTilde[i];
      residual2 += diff * diff;
    }
    // residualNorm in the *scaled* coord system is ‖ỹ − ŷ̃‖; in the
    // original coord system it's ‖x − x̂‖ = ‖x‖ · ‖ỹ − ŷ̃‖ (orthogonal Π
    // preserves norms too).
    const residualNorm = xNorm * Math.sqrt(residual2);

    return {
      quantizedBits,
      norm: xNorm,
      residualNorm,
      b: this.b,
      d: this.d,
    };
  }

  decode(encoded: PolarEncoded): Float32Array {
    if (encoded.d !== this.d) {
      throw new Error(
        `PolarQuantizer.decode: dimension mismatch (encoded d=${encoded.d}, quantizer d=${this.d})`
      );
    }
    if (encoded.b !== this.b) {
      throw new Error(
        `PolarQuantizer.decode: bit-width mismatch (encoded b=${encoded.b}, quantizer b=${this.b})`
      );
    }
    const yHatTilde = dequantizeScalar(encoded.quantizedBits, this.b, this.d);
    // Scale back by ‖x‖.
    const yHat = new Float32Array(this.d);
    for (let i = 0; i < this.d; i++) yHat[i] = yHatTilde[i] * encoded.norm;
    // x̂ = Πᵀ · ŷ
    return rotate(this.PiT, yHat, this.d);
  }
}
