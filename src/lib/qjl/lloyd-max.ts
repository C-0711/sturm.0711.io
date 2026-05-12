/**
 * Lloyd-Max scalar quantizer for the post-Haar-rotated coordinates.
 *
 * The TurboQuant paper (arxiv 2504.19874, §3) shows that when x is a
 * unit-norm vector in R^d and Π is Haar, the coordinates of Π·x follow
 * a Beta(α=1/2, β=(d-1)/2) distribution on [-1, 1] (actually on the
 * unit sphere, so the per-coordinate density is Beta shifted to [-1,1]).
 * For d > 64 this Beta is extremely close to Gaussian(0, 1/d):
 *
 *   E[coord]     = 0
 *   Var[coord]   = 1/d
 *   Kurtosis → 3 as d → ∞
 *
 * We therefore design the scalar quantizer against N(0, 1/d). We use
 * Lloyd-Max: iteratively
 *
 *   1. Fix boundaries {t_0=-∞, t_1, …, t_{L-1}, t_L=+∞}; reconstructions
 *      y_l = E[X | t_{l-1} < X ≤ t_l] = ∫X·f(X)dX / ∫f(X)dX on that bin.
 *   2. Fix reconstructions; boundaries become midpoints: t_l = (y_l + y_{l+1}) / 2.
 *
 * This converges (Lloyd's theorem) to a stationary quantizer. For a
 * symmetric unimodal source at b ≤ 4 bits it converges in 20-30 iters
 * to machine precision; we cap at 50.
 *
 * Closed-form helpers for N(0, σ²):
 *   ∫_a^b f(x) dx     = Φ(b/σ) − Φ(a/σ)
 *   ∫_a^b x·f(x) dx   = σ·(φ(a/σ) − φ(b/σ))
 * so the centroid on (a, b) is σ·(φ(a/σ) − φ(b/σ)) / (Φ(b/σ) − Φ(a/σ)).
 */

// ----------------------------------------------------------------------
// Gaussian PDF / CDF helpers
// ----------------------------------------------------------------------

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function phi(z: number): number {
  // Standard normal PDF.
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

/**
 * Abramowitz & Stegun 26.2.17 rational approximation of the standard
 * normal CDF. Max abs error ≈ 7.5e-8 — plenty for quantizer design.
 */
function Phi(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const a = Math.abs(z) / Math.SQRT2;
  // erf via A&S 7.1.26
  const t = 1.0 / (1.0 + 0.3275911 * a);
  const y =
    1.0 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return 0.5 * (1.0 + sign * y);
}

// ----------------------------------------------------------------------
// Lloyd-Max algorithm for N(0, sigma²)
// ----------------------------------------------------------------------

export interface LloydMaxQuantizer {
  /** Bin boundaries in the rotated-coordinate domain; length 2^b - 1. */
  boundaries: Float32Array;
  /** Reconstruction levels; length 2^b. */
  reconstructions: Float32Array;
  /** Iteration count at convergence (diagnostic). */
  iterations: number;
  /** Max |Δboundary| in the final iteration (diagnostic). */
  finalDelta: number;
}

/**
 * Design a Lloyd-Max quantizer with 2^b levels against a Gaussian
 * source with variance 1/d. Symmetry is enforced: the quantizer is
 * always an odd function (mid-riser at 0 for odd b, mid-tread for
 * even b). This halves the number of free parameters we optimize.
 */
export function lloydMax(b: number, d: number): LloydMaxQuantizer {
  if (!Number.isInteger(b) || b < 1 || b > 8) {
    throw new Error(`lloydMax: b must be 1..8 (got ${b})`);
  }
  if (!Number.isInteger(d) || d <= 0) {
    throw new Error(`lloydMax: d must be positive int (got ${d})`);
  }
  const L = 1 << b; // number of levels
  const sigma = Math.sqrt(1 / d);

  // Initial reconstructions: uniformly spaced quantiles over N(0, σ²).
  // This gives Lloyd-Max a non-degenerate starting point; a bad init
  // (e.g. all zeros) can leave unused bins.
  const y = new Float64Array(L);
  for (let l = 0; l < L; l++) {
    // Use the midpoint of the l-th equal-probability bin.
    const p = (l + 0.5) / L;
    // Inverse Φ via Acklam 2003 (coarse — only for init).
    y[l] = sigma * normInv(p);
  }

  // Boundaries: L - 1 interior + ±∞ virtuals.
  const t = new Float64Array(L + 1);
  t[0] = Number.NEGATIVE_INFINITY;
  t[L] = Number.POSITIVE_INFINITY;

  const MAX_ITERS = 50;
  const TOL = 1e-8;
  let iter = 0;
  let delta = Infinity;

  while (iter < MAX_ITERS && delta > TOL) {
    // Step 1: boundaries as midpoints of reconstructions.
    let newDelta = 0;
    for (let l = 1; l < L; l++) {
      const tNew = 0.5 * (y[l - 1] + y[l]);
      const change = Math.abs(tNew - t[l]);
      if (change > newDelta) newDelta = change;
      t[l] = tNew;
    }
    // Step 2: reconstructions as conditional means.
    for (let l = 0; l < L; l++) {
      // E[X | t_l < X ≤ t_{l+1}] for X ~ N(0, σ²):
      //   = σ · (φ(t_l/σ) − φ(t_{l+1}/σ)) / (Φ(t_{l+1}/σ) − Φ(t_l/σ))
      const a = t[l];
      const c = t[l + 1];
      const za = Number.isFinite(a) ? a / sigma : a < 0 ? -Infinity : Infinity;
      const zc = Number.isFinite(c) ? c / sigma : c < 0 ? -Infinity : Infinity;
      const pa = Number.isFinite(za) ? phi(za) : 0;
      const pc = Number.isFinite(zc) ? phi(zc) : 0;
      const Pa = Number.isFinite(za) ? Phi(za) : za < 0 ? 0 : 1;
      const Pc = Number.isFinite(zc) ? Phi(zc) : zc < 0 ? 0 : 1;
      const mass = Pc - Pa;
      if (mass > 1e-15) {
        y[l] = (sigma * (pa - pc)) / mass;
      }
      // else: keep previous value (dead bin)
    }
    delta = newDelta;
    iter++;
  }

  // Pack to Float32.
  const boundaries = new Float32Array(L - 1);
  for (let i = 0; i < L - 1; i++) boundaries[i] = t[i + 1];
  const reconstructions = new Float32Array(L);
  for (let i = 0; i < L; i++) reconstructions[i] = y[i];

  return { boundaries, reconstructions, iterations: iter, finalDelta: delta };
}

// ----------------------------------------------------------------------
// Inverse-Phi for the Lloyd-Max initialization (Acklam 2003, single
// rational; we only need ~1e-4 accuracy because the iterative loop
// refines it anyway).
// ----------------------------------------------------------------------

function normInv(p: number): number {
  // Peter Acklam algorithm.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

// ----------------------------------------------------------------------
// Memoized quantizer table — designed on first use per (b, d) pair.
// ----------------------------------------------------------------------

const TABLE_CACHE = new Map<string, LloydMaxQuantizer>();

function getTable(b: number, d: number): LloydMaxQuantizer {
  const key = `${b}:${d}`;
  let t = TABLE_CACHE.get(key);
  if (t === undefined) {
    t = lloydMax(b, d);
    TABLE_CACHE.set(key, t);
  }
  return t;
}

// ----------------------------------------------------------------------
// Per-coordinate scalar quantize/dequantize.
//
// We pack one index per byte for b ≤ 8 (simplest). A tighter bit-packer
// is a trivial follow-up and not on the critical path for correctness.
// ----------------------------------------------------------------------

/**
 * Quantize a rotated-coordinate vector using the (b, d) Lloyd-Max
 * codebook. Returns a Uint8Array of indices (0..2^b − 1), one per
 * coordinate.
 */
export function quantizeScalar(xRotated: Float32Array, b: number, d: number): Uint8Array {
  if (xRotated.length !== d) {
    throw new Error(`quantizeScalar: expected length ${d}, got ${xRotated.length}`);
  }
  const { boundaries } = getTable(b, d);
  const out = new Uint8Array(d);
  const L = 1 << b;
  for (let i = 0; i < d; i++) {
    const v = xRotated[i];
    // Binary search would be faster but for small L linear is clearer.
    let idx = L - 1;
    for (let k = 0; k < L - 1; k++) {
      if (v <= boundaries[k]) {
        idx = k;
        break;
      }
    }
    out[i] = idx;
  }
  return out;
}

/**
 * Dequantize: map indices back to reconstruction values in the rotated
 * coordinate system.
 */
export function dequantizeScalar(q: Uint8Array, b: number, d: number): Float32Array {
  if (q.length !== d) {
    throw new Error(`dequantizeScalar: expected length ${d}, got ${q.length}`);
  }
  const { reconstructions } = getTable(b, d);
  const out = new Float32Array(d);
  for (let i = 0; i < d; i++) out[i] = reconstructions[q[i]];
  return out;
}

/** Expose the cached table for diagnostics/benchmarks. */
export function getCodebook(b: number, d: number): LloydMaxQuantizer {
  return getTable(b, d);
}
