/**
 * HMAC-SHA256 signing for master.json snapshots.
 *
 * Symmetric key (server-only env STURM_MASTER_HMAC_KEY); receivers verify with
 * the same key. Phase G+ would replace with asymmetric (Ed25519) once external
 * untrusted consumers need to verify.
 *
 * Signature is over the canonical-JSON form of the master object with the
 * `signature` field set to null. KeyId allows rotation: future requests can
 * use a new key while old snapshots remain verifiable with the old key.
 */

import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const ALG = 'HMAC-SHA256';
const DEFAULT_KEY_ID = 'sturm-master-v1';

export interface MasterSignature {
  alg: typeof ALG;
  value: string;     // base64
  keyId: string;
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
}

/** Strip the signature field for hashing. */
function payloadForSigning(master: Record<string, unknown>): string {
  const clone = { ...master, signature: null };
  return canonicalJson(clone);
}

export function signMaster(master: Record<string, unknown>, key: string, keyId = DEFAULT_KEY_ID): MasterSignature {
  const payload = payloadForSigning(master);
  const sig = createHmac('sha256', key).update(payload).digest('base64');
  return { alg: ALG, value: sig, keyId };
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

export function verifyMaster(master: Record<string, unknown>, key: string): VerifyResult {
  const errors: string[] = [];
  const sig = master.signature as MasterSignature | undefined;
  if (!sig) { errors.push('missing signature'); return { valid: false, errors }; }
  if (sig.alg !== ALG) { errors.push(`unsupported alg ${sig.alg}`); return { valid: false, errors }; }
  if (typeof sig.value !== 'string') { errors.push('signature.value must be string'); return { valid: false, errors }; }
  const expected = createHmac('sha256', key).update(payloadForSigning(master)).digest('base64');
  if (expected !== sig.value) { errors.push('signature mismatch'); return { valid: false, errors }; }
  return { valid: true, errors: [] };
}

/** Resolve the HMAC secret. Reads STURM_MASTER_HMAC_KEY from env, or generates
 *  a random key on first run and persists to .master-key.json (chmod 600).
 *  Idempotent — subsequent calls return the same key. */
export async function resolveMasterKey(rootDir: string): Promise<string> {
  const fromEnv = process.env.STURM_MASTER_HMAC_KEY;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  const keyFile = path.join(rootDir, '.master-key.json');
  try {
    const raw = await fs.readFile(keyFile, 'utf8');
    const parsed = JSON.parse(raw) as { key: string };
    if (parsed.key) return parsed.key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const generated = randomBytes(32).toString('hex');
  await fs.writeFile(keyFile, JSON.stringify({ key: generated, generatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return generated;
}
