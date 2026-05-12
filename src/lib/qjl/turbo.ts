/**
 * TurboQuantizer — composite of Stage 1 (PolarQuant) and Stage 2 (QJL).
 *
 * Reference: arxiv 2504.19874, Thm 2. The unbiased inner-product
 * estimator is
 *
 *     ⟨q, x⟩ ≈ ⟨q, x̂⟩ + ‖r‖ · ⟨q, sign(S·r)⟩·(correction)
 *
 * where x̂ is the PolarQuant reconstruction, r = x − x̂, and S is a QJL
 * random-Gaussian projection. The first term is deterministic (given
 * q, x̂); the second term is an unbiased sketch estimator for ⟨q, r⟩.
 *
 * We use the Phase 1a QJL estimator convention
 *     ⟨q, r⟩ ≈ ‖r‖ · sqrt(π/2) · (1/d) · Σ (S·q)[i] · sign((S·r)[i])
 * (see src/index.ts for derivation). This is passed through
 * `QjlProjector.estimateFromSq` so turbo.ts never has to re-derive the
 * debias factor.
 *
 * Compression: b bits/dim for the polar codes, 1 bit/dim for the QJL
 * signs, plus two float32 scalars (‖x‖ and ‖r‖). At d=1024, b=3:
 *     polar:  1024 · 3 / 8 = 384 bytes
 *     qjl:    1024 · 1 / 8 = 128 bytes
 *     scalars: 8 bytes
 *     total:  520 bytes vs 1024·4 = 4096 bytes FP32 → 7.88× compression.
 * Paper claims 6–7× on KV cache. We match the target.
 */

import { PolarQuantizer, type PolarEncoded } from "./polar.ts";

import { makeQjlProjector, type QjlProjector } from "./index.ts";

export interface TurboEncoded {
  /** Stage-1 PolarQuant output. */
  polar: PolarEncoded;
  /** Stage-2 QJL signs: sign(S · r), bit-packed, ceil(d/8) bytes. */
  qjlSigns: Uint8Array;
  /** ‖r‖ stashed at the top level for convenience (equal to polar.residualNorm). */
  residualNorm: number;
}

export class TurboQuantizer {
  readonly polar: PolarQuantizer;
  readonly qjl: QjlProjector;

  constructor(
    public readonly d: number,
    public readonly bMse: number,
    public readonly seed: number
  ) {
    this.polar = new PolarQuantizer(d, bMse, seed);
    // Use a derived seed for S so Π and S are statistically independent.
    this.qjl = makeQjlProjector(d, seed ^ 0x5a5a5a5a);
  }

  encode(x: Float32Array): TurboEncoded {
    if (x.length !== this.d) {
      throw new Error(`TurboQuantizer.encode: expected length ${this.d}, got ${x.length}`);
    }
    const polar = this.polar.encode(x);
    const xHat = this.polar.decode(polar);
    // r = x − x̂
    const r = new Float32Array(this.d);
    for (let i = 0; i < this.d; i++) r[i] = x[i] - xHat[i];
    // sign(S · r)
    const qjlSigns = this.qjl.project(r);
    return {
      polar,
      qjlSigns,
      residualNorm: polar.residualNorm,
    };
  }

  /**
   * Deterministic Stage-1 reconstruction (useful for diagnostics).
   */
  decodeStageOne(encoded: TurboEncoded): Float32Array {
    return this.polar.decode(encoded.polar);
  }

  /**
   * Unbiased Thm-2 inner-product estimate ⟨q, x⟩.
   *
   *   term1 = ⟨q, x̂⟩        -- deterministic
   *   term2 = ‖r‖ · ⟨q, sign(S·r)⟩ debiased by sqrt(π/2)/d (QJL estimator)
   *
   * The QjlProjector.estimateFromSq already does the sqrt(π/2)/d scaling
   * and multiplies by the supplied residualNorm, so we just hand it
   * (S·q, sign(S·r), ‖r‖) and add to the deterministic term.
   */
  estimateInnerProduct(q: Float32Array, encoded: TurboEncoded): number {
    if (q.length !== this.d) {
      throw new Error(
        `TurboQuantizer.estimateInnerProduct: expected length ${this.d}, got ${q.length}`
      );
    }
    // Term 1: ⟨q, x̂⟩
    const xHat = this.polar.decode(encoded.polar);
    let term1 = 0;
    for (let i = 0; i < this.d; i++) term1 += q[i] * xHat[i];

    // Term 2: S-based residual estimator.
    const Sq = this.qjl.projectFloat(q);
    const term2 = this.qjl.estimateFromSq(Sq, encoded.qjlSigns, encoded.residualNorm);

    return term1 + term2;
  }

  /**
   * Scan-oriented variant: precompute S·q and x̂ externally where
   * possible. The deterministic first term requires decoding x̂, which
   * costs a d×d matrix product per candidate — in a real scan you'd
   * keep x̂ cached or re-derive during batched rotation. Exposed as a
   * convenience for benchmarks.
   */
  estimateFromSq(q: Float32Array, Sq: Float32Array, encoded: TurboEncoded): number {
    if (Sq.length !== this.d) {
      throw new Error(
        `TurboQuantizer.estimateFromSq: expected Sq length ${this.d}, got ${Sq.length}`
      );
    }
    const xHat = this.polar.decode(encoded.polar);
    let term1 = 0;
    for (let i = 0; i < this.d; i++) term1 += q[i] * xHat[i];
    const term2 = this.qjl.estimateFromSq(Sq, encoded.qjlSigns, encoded.residualNorm);
    return term1 + term2;
  }

  /** Bytes-per-vector of the compressed representation (excluding scalars). */
  get bytesPerVector(): number {
    const polarBytes = this.d; // one byte per index (loose packing for now)
    const qjlBytes = Math.ceil(this.d / 8);
    return polarBytes + qjlBytes + 8; // + 2 float32 scalars
  }

  /** Effective bits-per-dim with tight bit-packing applied. */
  get effectiveBitsPerDim(): number {
    // polar: bMse bits/dim. qjl: 1 bit/dim. Scalars amortize to ~0.
    return this.bMse + 1;
  }
}
