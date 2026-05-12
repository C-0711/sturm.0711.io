/**
 * Haar-distributed random d×d orthogonal matrix.
 *
 * Generation: Householder QR of a d×d i.i.d. N(0,1) matrix.  The Q factor
 * of a Gaussian matrix is, up to a diagonal sign correction, uniformly
 * distributed on the orthogonal group O(d). This is the standard
 * "QR-of-Gaussian" construction used in the TurboQuant paper (arxiv
 * 2504.19874) for the post-rotation scalar quantizer.
 *
 * We inline Box–Muller + Mulberry32 (same deterministic RNG used by
 * `@0711/qjl` elsewhere) so this module has zero external deps and a
 * given `seed` always yields the same rotation.
 */

import { mulberry32 } from "./index.ts";

// ----------------------------------------------------------------------
// Deterministic Gaussian RNG — same construction as src/index.ts, but
// local to keep this module self-contained if we ever split packages.
// ----------------------------------------------------------------------

function makeGaussian(uniform: () => number): () => number {
  let spare: number | null = null;
  return function (): number {
    if (spare !== null) {
      const g = spare;
      spare = null;
      return g;
    }
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
// Householder QR of a Gaussian matrix → Haar-distributed Π
// ----------------------------------------------------------------------

/**
 * Build a d×d Haar-random orthogonal matrix Π as a row-major flat
 * Float32Array: Π[i*d + j] is row i, column j.
 *
 * Algorithm (Mezzadri 2007, "How to generate random matrices from the
 * classical compact groups"):
 *
 *   1. Draw A ∈ R^{d×d} with i.i.d. N(0,1) entries.
 *   2. Run Householder QR to obtain A = Q·R.
 *   3. Correct the sign: Q ← Q · diag(sign(R_ii)) so that the R has
 *      positive diagonal. This is the piece that makes Q uniform on O(d)
 *      rather than just "some orthogonal basis of A's columns".
 *
 * We compute Q column-by-column via a sequence of Householder reflectors
 * applied to the columns of A, avoiding any explicit matrix inverse.
 *
 * Determinism: same `seed` → same Π (consumes d² Gaussians in row-major
 * order from a fresh Mulberry32 stream).
 */
export function makeHaarRotation(d: number, seed: number): Float32Array {
  if (!Number.isInteger(d) || d <= 0) {
    throw new Error(`makeHaarRotation: d must be a positive integer (got ${d})`);
  }
  const g = makeGaussian(mulberry32(seed));

  // A ∈ R^{d×d} as Float64 (QR stability). Row-major.
  const A = new Float64Array(d * d);
  for (let i = 0; i < A.length; i++) A[i] = g();

  // Q starts as identity.
  const Q = new Float64Array(d * d);
  for (let i = 0; i < d; i++) Q[i * d + i] = 1;

  // Scratch vector for Householder reflectors.
  const v = new Float64Array(d);

  // For each column k we build a Householder reflector that zeroes out
  // A[k+1:d, k]. The reflector H = I − 2 v vᵀ / (vᵀv) is applied to
  // both A (from the left) and Q (from the right, as Q ← Q·H). At the
  // end, Q is the Householder product and A is upper triangular (= R).
  for (let k = 0; k < d - 1; k++) {
    // x = A[k:d, k]
    let sigma = 0;
    for (let i = k; i < d; i++) {
      const aik = A[i * d + k];
      sigma += aik * aik;
      v[i] = aik;
    }
    const xNorm = Math.sqrt(sigma);
    if (xNorm === 0) continue; // nothing to reflect
    // v ← x − sign(x_k)·‖x‖·e_k  (numerically stable choice)
    const sign = v[k] >= 0 ? 1 : -1;
    v[k] = v[k] + sign * xNorm;
    // β = 2 / (vᵀv)
    let vNorm2 = 0;
    for (let i = k; i < d; i++) vNorm2 += v[i] * v[i];
    if (vNorm2 === 0) continue;
    const beta = 2 / vNorm2;

    // Apply H to columns k..d-1 of A: A[:, j] ← A[:, j] − β·v·(vᵀA[:, j])
    for (let j = k; j < d; j++) {
      let dotvA = 0;
      for (let i = k; i < d; i++) dotvA += v[i] * A[i * d + j];
      const c = beta * dotvA;
      for (let i = k; i < d; i++) A[i * d + j] -= c * v[i];
    }
    // Apply H to Q on the right: Q ← Q − β·(Q·v)·vᵀ. We iterate over
    // rows i of Q, computing (Q·v)[i] = Σ_m Q[i, m]·v[m] (m ∈ [k..d-1]).
    for (let i = 0; i < d; i++) {
      let dotQv = 0;
      for (let m = k; m < d; m++) dotQv += Q[i * d + m] * v[m];
      const c = beta * dotQv;
      for (let m = k; m < d; m++) Q[i * d + m] -= c * v[m];
    }
  }

  // Sign correction: scale each column of Q by sign(R_ii) so the
  // distribution is exactly Haar. R_ii = A[i*d + i] after the QR sweep.
  for (let j = 0; j < d; j++) {
    const rjj = A[j * d + j];
    const s = rjj >= 0 ? 1 : -1;
    if (s === -1) {
      for (let i = 0; i < d; i++) Q[i * d + j] = -Q[i * d + j];
    }
  }

  // Downcast to Float32 for storage + runtime compatibility with the
  // existing QJL API.
  const out = new Float32Array(d * d);
  for (let i = 0; i < out.length; i++) out[i] = Q[i];
  return out;
}

/**
 * Apply an orthogonal rotation y = Π·x where Π is row-major d×d.
 *
 *   y[i] = Σ_j Π[i*d + j] · x[j]
 */
export function rotate(Pi: Float32Array, x: Float32Array, d: number): Float32Array {
  if (Pi.length !== d * d) {
    throw new Error(`rotate: Pi length ${Pi.length} ≠ d² = ${d * d}`);
  }
  if (x.length !== d) {
    throw new Error(`rotate: x length ${x.length} ≠ d = ${d}`);
  }
  const y = new Float32Array(d);
  for (let i = 0; i < d; i++) {
    let acc = 0;
    const rowOff = i * d;
    for (let j = 0; j < d; j++) acc += Pi[rowOff + j] * x[j];
    y[i] = acc;
  }
  return y;
}

/**
 * Transpose a row-major d×d matrix in place-free fashion. The transpose
 * of a Haar-random Π is still Haar-random (both are uniform on O(d)),
 * so this is what we cache for the inverse rotation x = Πᵀ · y.
 */
export function transpose(M: Float32Array, d: number): Float32Array {
  if (M.length !== d * d) {
    throw new Error(`transpose: M length ${M.length} ≠ d² = ${d * d}`);
  }
  const T = new Float32Array(d * d);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      T[j * d + i] = M[i * d + j];
    }
  }
  return T;
}
