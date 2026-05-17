/**
 * Wire-compatible HMAC signing for legacy sturm `master.json` snapshots.
 *
 * Reproduces the exact byte-for-byte behavior of the pre-extraction
 * `src/lib/master-signer.ts` so existing `master.json` files keep verifying
 * after the move into this package. New code should prefer `signEnvelope`
 * from `./envelope.ts` — it binds a `project` field to prevent cross-project
 * replay.
 *
 * Signing input: canonicalJson({ ...master, signature: null })
 * — i.e. the payload is the master object with `signature` overwritten to
 * null. The HMAC is then embedded back as `master.signature`.
 */

import { createHmac } from 'node:crypto';
import { canonicalJson } from './canonical.ts';

const ALG = 'HMAC-SHA256';
const DEFAULT_KEY_ID = 'sturm-master-v1';

export interface MasterSignature {
  alg: typeof ALG;
  value: string;
  keyId: string;
}

function payloadForSigning(master: Record<string, unknown>): string {
  return canonicalJson({ ...master, signature: null });
}

export function signMaster(
  master: Record<string, unknown>,
  key: string,
  keyId: string = DEFAULT_KEY_ID,
): MasterSignature {
  const sig = createHmac('sha256', key).update(payloadForSigning(master)).digest('base64');
  return { alg: ALG, value: sig, keyId };
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

export function verifyMaster(master: Record<string, unknown>, key: string): VerifyResult {
  const errors: string[] = [];
  const sig = master.signature as MasterSignature | undefined;
  if (!sig) {
    errors.push('missing signature');
    return { valid: false, errors };
  }
  if (sig.alg !== ALG) {
    errors.push(`unsupported alg ${sig.alg}`);
    return { valid: false, errors };
  }
  if (typeof sig.value !== 'string') {
    errors.push('signature.value must be string');
    return { valid: false, errors };
  }
  const expected = createHmac('sha256', key).update(payloadForSigning(master)).digest('base64');
  if (expected !== sig.value) {
    errors.push('signature mismatch');
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}
