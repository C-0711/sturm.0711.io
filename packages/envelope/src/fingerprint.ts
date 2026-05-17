/**
 * Extraction-Fingerprint — content-addressed end-to-end identity for a run.
 *
 * Every workflow run (ELSTER, Atlas-KC, …) produces a cryptographic fingerprint
 * that binds ALL determinants:
 *
 *   container.merkle_root      — which truth source
 *   container.container_sha256 — catalog manifest hash
 *   embedder.family + seed     — which vector space, deterministic
 *   cascade.artifact_sha256s   — TurboQuant index identifiers
 *   llm.model_pin              — pinned model snapshot (no "latest")
 *   schema.sha256              — nested schema for FSM path
 *   input.pdf_sha256           — input document
 *   input.text_sha256          — pdftotext output (deterministic)
 *   stage_versions             — code versions of stages traversed
 *
 * sha256(canonicalJson(components)) → 32-byte digest. Identical input +
 * identical components → identical fingerprint → byte-for-byte replay.
 *
 * Signature: HMAC-SHA256 with rotatable keyId. Phase G+ migration to Ed25519
 * is planned but not in scope here.
 */

import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalJson } from './canonical.ts';

const ALG = 'HMAC-SHA256';
const FINGERPRINT_VERSION = 1;

export interface FingerprintComponents {
  fingerprint_version: number;
  container: {
    id: string;
    catalog_version: string;
    merkle_root: string;
    container_sha256: string;
  };
  embedder: {
    family: string;
    /** Native dim before MRL truncation. */
    dim: number;
    /** TurboQuant projection seed if quantized. */
    seed?: number;
    /** sha256 of each loaded embedding artifact (cascade + exact). */
    artifact_sha256s: Record<string, string>;
  };
  /** Optional — only present when an LLM-disambig hop actually fired. */
  llm?: {
    /** Pinned model id, e.g. "google/gemma-4-31b-it@sha256:abc…". */
    model_pin: string;
    kv_quant_b?: number;
    temperature: number;
    max_tokens?: number;
    schema_sha256?: string;
  };
  input: {
    pdf_sha256: string;
    text_sha256?: string;
    filename: string;
  };
  /** Code versions of stages traversed — drift detection. */
  stage_versions: Record<string, string>;
  /** ISO timestamp — informational, NOT part of the fingerprint hash. */
  generated_at?: string;
}

export interface FingerprintSignature {
  alg: typeof ALG;
  value: string;
  keyId: string;
}

export interface ExtractionFingerprint {
  /** sha256 over canonicalJson(components). */
  digest: string;
  components: FingerprintComponents;
  signature?: FingerprintSignature;
}

/** sha256 hex over bytes or string. */
export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 hex over a file's contents. */
export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

/**
 * Build the deterministic fingerprint. The `generated_at` timestamp is
 * stripped from the hash payload so replays at different wall-clock times
 * produce identical digests.
 */
export function computeFingerprint(
  components: Omit<FingerprintComponents, 'fingerprint_version'> &
    Partial<Pick<FingerprintComponents, 'fingerprint_version'>>,
): ExtractionFingerprint {
  const full: FingerprintComponents = {
    fingerprint_version: components.fingerprint_version ?? FINGERPRINT_VERSION,
    ...components,
  };
  const { generated_at: _ignored, ...forHash } = full;
  void _ignored;
  const digest = sha256(canonicalJson(forHash));
  return {
    digest,
    components: { ...full, generated_at: full.generated_at ?? new Date().toISOString() },
  };
}

/**
 * Attach an HMAC signature over the digest. Same key mechanism as the master
 * envelope — symmetric, rotation-capable via keyId.
 */
export function signFingerprint(
  fp: ExtractionFingerprint,
  key: string,
  keyId = 'sturm-extract-v1',
): ExtractionFingerprint {
  const value = createHmac('sha256', key).update(fp.digest).digest('base64');
  return { ...fp, signature: { alg: ALG, value, keyId } };
}

export function verifyFingerprint(
  fp: ExtractionFingerprint,
  key: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!fp.signature) {
    errors.push('missing signature');
    return { valid: false, errors };
  }
  if (fp.signature.alg !== ALG) {
    errors.push(`unsupported alg ${fp.signature.alg}`);
    return { valid: false, errors };
  }
  const recomputed = computeFingerprint(fp.components).digest;
  if (recomputed !== fp.digest) {
    errors.push('digest mismatch — components were modified after signing');
  }
  const expected = createHmac('sha256', key).update(fp.digest).digest('base64');
  if (expected !== fp.signature.value) errors.push('signature mismatch');
  return { valid: errors.length === 0, errors };
}

/**
 * Replay-Cert = Fingerprint + extracted result + per-field attestations.
 *
 * One file per run, deterministically reproducible if input + container +
 * code are identical. This is THE audit artifact: hand it to an external
 * verifier, they replay independently.
 */
export interface ReplayCertificate {
  fingerprint: ExtractionFingerprint;
  attestations: Array<{
    ecode: string;
    value: string | number | null;
    drucktext: string;
    anlage: string;
    pflicht: boolean;
    method: 'regex-match' | 'cascade-grounded' | 'llm-disambig' | 'no-evidence';
    confidence: number;
    source?: {
      beleg?: string;
      page?: number;
      line_no?: number;
      snippet?: string;
      bbox?: [number, number, number, number];
    };
    cosine?: number;
    format_valid?: boolean;
    normalized?: string;
  }>;
  pflicht_completeness?: Array<{
    anlage: string;
    expected: number;
    found: number;
    missing_ecodes: string[];
  }>;
}

/** Attach an LLM component to existing components post-hoc (when the
 *  disambig hop actually fired). */
export function attachLlmComponent(
  components: FingerprintComponents,
  llm: NonNullable<FingerprintComponents['llm']>,
): FingerprintComponents {
  return { ...components, llm };
}
