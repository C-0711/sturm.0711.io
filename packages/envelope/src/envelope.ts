/**
 * Project-scoped HMAC envelope (v2).
 *
 * Wraps an arbitrary payload with a `project` identifier and binds the project
 * into the canonical-JSON signing input. Two projects signing the *same*
 * payload produce *different* signatures — preventing cross-project replay
 * even if a shared key is misused.
 *
 * Wire shape (the bytes that get HMAC'd):
 *   canonicalJson({ version, project, payload, keyId, signedAt })
 *
 * The signature, alg, and any service-side metadata are NOT part of the hash
 * input — only fields that the verifier must reproduce.
 */

import { createHmac } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import { ED25519_ALG, signPayloadEd25519, verifyPayloadEd25519, type Ed25519Signature, type PublicKeyResolver } from './ed25519.ts';

export const ENVELOPE_VERSION = 2;
export const ENVELOPE_ALG = 'HMAC-SHA256' as const;

export type EnvelopeSignature =
  | { alg: typeof ENVELOPE_ALG; value: string; keyId: string; signedAt: string }
  | Ed25519Signature;

export type { PublicKeyResolver } from './ed25519.ts';

export interface Envelope<P = Record<string, unknown>> {
  version: typeof ENVELOPE_VERSION;
  project: string;
  payload: P;
  signature?: EnvelopeSignature;
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

/**
 * Resolver lets the verifier look up keys by id. Returning undefined means
 * "unknown keyId" — the caller decides whether to fail-closed or try a
 * fallback. Async because production resolvers may hit Vault/KMS.
 */
export type KeyResolver = (keyId: string) => string | Promise<string | undefined> | undefined;

function payloadForSigning(envelope: Omit<Envelope, 'signature'>, keyId: string, signedAt: string): string {
  return canonicalJson({
    version: envelope.version,
    project: envelope.project,
    payload: envelope.payload,
    keyId,
    signedAt,
  });
}

export function signEnvelope<P>(
  input: Omit<Envelope<P>, 'signature' | 'version'> & { version?: typeof ENVELOPE_VERSION },
  key: string,
  keyId: string,
  options: { signedAt?: string } = {},
): Envelope<P> {
  if (!input.project || typeof input.project !== 'string') {
    throw new TypeError('signEnvelope: project must be a non-empty string');
  }
  if (!key || key.length < 32) {
    throw new TypeError('signEnvelope: key must be ≥32 chars');
  }
  if (!keyId || typeof keyId !== 'string') {
    throw new TypeError('signEnvelope: keyId must be a non-empty string');
  }
  const envelope: Omit<Envelope<P>, 'signature'> = {
    version: input.version ?? ENVELOPE_VERSION,
    project: input.project,
    payload: input.payload,
  };
  const signedAt = options.signedAt ?? new Date().toISOString();
  const sig = createHmac('sha256', key).update(payloadForSigning(envelope, keyId, signedAt)).digest('base64');
  return {
    ...envelope,
    signature: { alg: ENVELOPE_ALG, value: sig, keyId, signedAt },
  };
}

export async function verifyEnvelope<P>(
  envelope: Envelope<P>,
  keyResolver: KeyResolver,
): Promise<VerifyResult> {
  const errors: string[] = [];

  if (envelope.version !== ENVELOPE_VERSION) {
    errors.push(`unsupported envelope version ${envelope.version}`);
    return { valid: false, errors };
  }
  if (!envelope.signature) {
    errors.push('missing signature');
    return { valid: false, errors };
  }
  const sig = envelope.signature;
  if (sig.alg !== ENVELOPE_ALG) {
    errors.push(`unsupported alg ${sig.alg} for HMAC verifier`);
    return { valid: false, errors };
  }
  const { value, keyId, signedAt } = sig;
  if (typeof value !== 'string' || value.length === 0) {
    errors.push('signature.value must be a non-empty string');
    return { valid: false, errors };
  }

  const key = await keyResolver(keyId);
  if (!key) {
    errors.push(`unknown keyId ${keyId}`);
    return { valid: false, errors };
  }

  const unsigned: Omit<Envelope<P>, 'signature'> = {
    version: envelope.version,
    project: envelope.project,
    payload: envelope.payload,
  };
  const expected = createHmac('sha256', key)
    .update(payloadForSigning(unsigned, keyId, signedAt))
    .digest('base64');

  if (expected !== value) {
    errors.push('signature mismatch');
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

/**
 * Asymmetric counterpart to signEnvelope. Use when external verifiers must
 * check without sharing the private key. Same canonical-JSON signing input
 * as the HMAC path — only the primitive differs.
 */
export function signEnvelopeEd25519<P>(
  input: Omit<Envelope<P>, 'signature' | 'version'> & { version?: typeof ENVELOPE_VERSION },
  privatePem: string,
  keyId: string,
  options: { signedAt?: string } = {},
): Envelope<P> {
  if (!input.project) throw new TypeError('signEnvelopeEd25519: project must be a non-empty string');
  if (!keyId) throw new TypeError('signEnvelopeEd25519: keyId must be a non-empty string');
  const envelope: Omit<Envelope<P>, 'signature'> = {
    version: input.version ?? ENVELOPE_VERSION,
    project: input.project,
    payload: input.payload,
  };
  const sig = signPayloadEd25519(envelope, privatePem, keyId, options);
  return { ...envelope, signature: sig };
}

/**
 * Dispatches verification by signature.alg. Provide whichever resolvers your
 * project expects. Returns invalid if the signature alg has no matching
 * resolver — fail-closed by design.
 */
export async function verifyEnvelopeAny<P>(
  envelope: Envelope<P>,
  resolvers: { hmac?: KeyResolver; ed25519?: PublicKeyResolver },
): Promise<VerifyResult> {
  if (envelope.version !== ENVELOPE_VERSION) {
    return { valid: false, errors: [`unsupported envelope version ${envelope.version}`] };
  }
  if (!envelope.signature) {
    return { valid: false, errors: ['missing signature'] };
  }
  const sig = envelope.signature;

  if (sig.alg === ENVELOPE_ALG) {
    if (!resolvers.hmac) {
      return { valid: false, errors: ['no hmac resolver provided for HMAC-SHA256 signature'] };
    }
    return verifyEnvelope(envelope, resolvers.hmac);
  }
  if (sig.alg === ED25519_ALG) {
    if (!resolvers.ed25519) {
      return { valid: false, errors: ['no ed25519 resolver provided for Ed25519 signature'] };
    }
    const pem = await resolvers.ed25519(sig.keyId);
    if (!pem) return { valid: false, errors: [`unknown keyId ${sig.keyId}`] };
    const unsigned = {
      version: envelope.version,
      project: envelope.project,
      payload: envelope.payload,
    };
    return verifyPayloadEd25519(unsigned, sig, pem);
  }
  return { valid: false, errors: [`unsupported alg ${(sig as { alg: string }).alg}`] };
}

/** Convenience: build a single-key resolver from a (keyId, key) pair. */
export function staticKeyResolver(keyId: string, key: string): KeyResolver {
  return (id) => (id === keyId ? key : undefined);
}

/** Convenience: build a multi-key resolver from a map (supports rotation). */
export function mapKeyResolver(keys: Record<string, string>): KeyResolver {
  return (id) => keys[id];
}
