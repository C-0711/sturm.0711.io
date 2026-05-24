/**
 * sign-container — Ed25519 issuer signing for ctx-bootstrap containers (C2).
 *
 * Re-uses the canonical-bytes scheme proven in 0711-quantum-tax/scripts/seal_taxstack.mjs:
 *   1. Canonicalize container.json with sorted keys, no whitespace
 *   2. sha256 the canonical bytes  → container_sha256
 *   3. Sign sha256 with Ed25519 issuer key (PKCS#8 PEM)
 *   4. Write signature.json next to container.json
 *
 * Key material:
 *   - Private key PEM at $STURM_CTX_ISSUER_KEY (default ~/.0711/keys/sturm-ed25519.key)
 *   - Public key PEM at $STURM_CTX_ISSUER_PUB (default ~/.0711/keys/sturm-ed25519.pub)
 *   - Generated on first use if missing; mode 0600 on the private key
 *
 * DID: did:0711:sturm  (placeholder until full DID method spec is registered)
 *
 * Verification: scripts/verify-ctx.ts (or any standard ed25519 verifier with the pubkey).
 */

import {
  createPrivateKey,
  createPublicKey,
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const STURM_ISSUER_DID = 'did:0711:sturm' as const;
export const SIGN_ALG = 'Ed25519' as const;
export const SIGN_VERSION = 1 as const;

const DEFAULT_KEY_DIR = path.join(homedir(), '.0711', 'keys');
const PRIV_KEY_PATH =
  process.env.STURM_CTX_ISSUER_KEY || path.join(DEFAULT_KEY_DIR, 'sturm-ed25519.key');
const PUB_KEY_PATH =
  process.env.STURM_CTX_ISSUER_PUB || path.join(DEFAULT_KEY_DIR, 'sturm-ed25519.pub');

// ============== canonical JSON ==============

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object' && (v as object).constructor === Object) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(v as Record<string, unknown>).sort();
    for (const k of keys) out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj));
}

export function sha256Hex(bytesOrStr: Buffer | string): string {
  const h = createHash('sha256');
  h.update(typeof bytesOrStr === 'string' ? Buffer.from(bytesOrStr, 'utf8') : bytesOrStr);
  return h.digest('hex');
}

// ============== key cache + load/gen ==============

let cachedPriv: KeyObject | null = null;
let cachedPub: KeyObject | null = null;
let cachedPubPem: string | null = null;
let cachedPubFingerprint: string | null = null;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadOrCreateIssuerKeys(): Promise<void> {
  if (cachedPriv && cachedPub) return;
  const havePriv = await pathExists(PRIV_KEY_PATH);
  const havePub = await pathExists(PUB_KEY_PATH);

  let privPem: string;
  let pubPem: string;

  if (havePriv && havePub) {
    privPem = await readFile(PRIV_KEY_PATH, 'utf8');
    pubPem = await readFile(PUB_KEY_PATH, 'utf8');
  } else {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await mkdir(path.dirname(PRIV_KEY_PATH), { recursive: true });
    await writeFile(PRIV_KEY_PATH, privPem, { mode: 0o600 });
    await writeFile(PUB_KEY_PATH, pubPem, { mode: 0o644 });
    await chmod(PRIV_KEY_PATH, 0o600);
    // eslint-disable-next-line no-console
    console.log('[sign-container] generated new ed25519 issuer key at', PRIV_KEY_PATH);
  }

  cachedPriv = createPrivateKey(privPem);
  cachedPub = createPublicKey(pubPem);
  cachedPubPem = pubPem;
  cachedPubFingerprint = 'sha256:' + sha256Hex(pubPem).slice(0, 32);
}

export async function getIssuerPublicKeyPem(): Promise<string> {
  if (!cachedPubPem) await loadOrCreateIssuerKeys();
  return cachedPubPem!;
}

export async function getIssuerFingerprint(): Promise<string> {
  if (!cachedPubFingerprint) await loadOrCreateIssuerKeys();
  return cachedPubFingerprint!;
}

// ============== signature envelope ==============

export interface CtxSignature {
  version: typeof SIGN_VERSION;
  alg: typeof SIGN_ALG;
  issuer_did: typeof STURM_ISSUER_DID;
  issuer_public_pem: string;
  issuer_fingerprint: string;
  container_sha256: string;
  signed_at: string;
  signature: string; // base64
}

/**
 * Compute the canonical sha256 of a container.json object and sign it.
 *
 * NOTE: the container.json object MUST NOT already contain a `container_sha256`
 * field — we strip it before canonicalising to keep the hash idempotent.
 */
export async function signContainer(container: Record<string, unknown>): Promise<CtxSignature> {
  await loadOrCreateIssuerKeys();
  if (!cachedPriv || !cachedPubPem || !cachedPubFingerprint) {
    throw new Error('issuer_keys_not_loaded');
  }
  const stripped = { ...container };
  delete (stripped as { container_sha256?: unknown }).container_sha256;
  delete (stripped as { signature?: unknown }).signature;
  const canonical = canonicalize(stripped);
  const containerSha = sha256Hex(canonical);
  const sigBytes = edSign(null, Buffer.from(containerSha, 'utf8'), cachedPriv);
  return {
    version: SIGN_VERSION,
    alg: SIGN_ALG,
    issuer_did: STURM_ISSUER_DID,
    issuer_public_pem: cachedPubPem,
    issuer_fingerprint: cachedPubFingerprint,
    container_sha256: containerSha,
    signed_at: new Date().toISOString(),
    signature: sigBytes.toString('base64'),
  };
}

/**
 * Verify a CtxSignature against a container.json object.
 * Returns true iff:
 *   - canonical sha256 of stripped container == signature.container_sha256
 *   - ed25519 verify(public_pem, signature.signature, container_sha256) == true
 */
export async function verifyContainerSignature(
  container: Record<string, unknown>,
  signature: CtxSignature,
): Promise<{ valid: boolean; reason?: string }> {
  if (signature.alg !== SIGN_ALG) {
    return { valid: false, reason: `unsupported_alg: ${signature.alg}` };
  }
  if (signature.version !== SIGN_VERSION) {
    return { valid: false, reason: `unsupported_version: ${signature.version}` };
  }
  const stripped = { ...container };
  delete (stripped as { container_sha256?: unknown }).container_sha256;
  delete (stripped as { signature?: unknown }).signature;
  const recomputed = sha256Hex(canonicalize(stripped));
  if (recomputed !== signature.container_sha256) {
    return {
      valid: false,
      reason: `container_sha256_mismatch: expected ${signature.container_sha256}, got ${recomputed}`,
    };
  }
  let pub: KeyObject;
  try {
    pub = createPublicKey(signature.issuer_public_pem);
  } catch (err) {
    return { valid: false, reason: `bad_public_pem: ${(err as Error).message}` };
  }
  const sigBytes = Buffer.from(signature.signature, 'base64');
  const ok = edVerify(null, Buffer.from(recomputed, 'utf8'), pub, sigBytes);
  if (!ok) return { valid: false, reason: 'ed25519_verify_failed' };
  return { valid: true };
}

// ============== filesystem helpers ==============

/**
 * Write `signature.json` alongside `container.json` in the given directory.
 * Returns the absolute path of the written signature file.
 */
export async function writeSignatureFile(
  containerDir: string,
  signature: CtxSignature,
): Promise<string> {
  const out = path.join(containerDir, 'signature.json');
  await writeFile(out, JSON.stringify(signature, null, 2) + '\n', 'utf8');
  return out;
}

export async function readSignatureFile(containerDir: string): Promise<CtxSignature | null> {
  const p = path.join(containerDir, 'signature.json');
  if (!(await pathExists(p))) return null;
  return JSON.parse(await readFile(p, 'utf8')) as CtxSignature;
}
