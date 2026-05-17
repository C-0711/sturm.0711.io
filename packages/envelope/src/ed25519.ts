/**
 * Ed25519 signing/verification — asymmetric counterpart to the HMAC envelope.
 *
 * Use when external (untrusted) verifiers must check a signature without
 * sharing the signing key. Required for:
 *   - Medical-device-class attestations (eyeAI / OCULUS Atlas-KC)
 *   - Inter-org provenance (one project signs, another org verifies)
 *   - Future Phase G+ migration of sturm replay certs
 *
 * Key material is PEM-encoded (PKCS#8 private, SPKI public) — same shape as
 * eyeAI's existing `device-keys.ts`. Both sturm and eyeAI can share the same
 * key files. Production deployments can swap PEM-on-disk for HSM-backed keys
 * by replacing the resolver functions in `keys.ts`.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from './canonical.ts';

export const ED25519_ALG = 'Ed25519' as const;

export interface Ed25519Signature {
  alg: typeof ED25519_ALG;
  value: string;       // base64 raw signature (64 bytes encoded)
  keyId: string;       // e.g. 'eyeai-device-pentacam-A0042'
  signedAt: string;
}

export interface Ed25519KeyPair {
  /** PEM (PKCS#8). */
  privatePem: string;
  /** PEM (SPKI). */
  publicPem: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function importPrivate(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem' });
}

function importPublic(pem: string): KeyObject {
  return createPublicKey({ key: pem, format: 'pem' });
}

/**
 * Sign a payload with Ed25519. The signing input is exactly the same
 * canonical-JSON form used by the HMAC envelope, so an envelope can be
 * counter-signed by both algorithms over identical bytes.
 */
export function signPayloadEd25519(
  payload: { version: number; project: string; payload: unknown },
  privatePem: string,
  keyId: string,
  options: { signedAt?: string } = {},
): Ed25519Signature {
  const signedAt = options.signedAt ?? new Date().toISOString();
  const input = canonicalJson({ ...payload, keyId, signedAt });
  const sig = edSign(null, Buffer.from(input, 'utf8'), importPrivate(privatePem));
  return { alg: ED25519_ALG, value: sig.toString('base64'), keyId, signedAt };
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

export function verifyPayloadEd25519(
  payload: { version: number; project: string; payload: unknown },
  signature: Ed25519Signature,
  publicPem: string,
): VerifyResult {
  const errors: string[] = [];
  if (signature.alg !== ED25519_ALG) {
    errors.push(`unsupported alg ${signature.alg}`);
    return { valid: false, errors };
  }
  const input = canonicalJson({ ...payload, keyId: signature.keyId, signedAt: signature.signedAt });
  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(input, 'utf8'), importPublic(publicPem), Buffer.from(signature.value, 'base64'));
  } catch (e) {
    errors.push(`verify_threw: ${e instanceof Error ? e.message : String(e)}`);
    return { valid: false, errors };
  }
  if (!ok) {
    errors.push('signature mismatch');
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}

/** Resolver returns the public PEM for a given keyId. Async to support
 *  HSM/Vault-backed implementations. */
export type PublicKeyResolver = (keyId: string) => string | Promise<string | undefined> | undefined;
