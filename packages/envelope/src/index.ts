/**
 * @0711/envelope — project-scoped HMAC envelope + extraction fingerprints.
 *
 * Public surface:
 *
 *   v2 envelope (use for new code, project-bound):
 *     signEnvelope, verifyEnvelope, staticKeyResolver, mapKeyResolver
 *     types: Envelope, EnvelopeSignature, KeyResolver, VerifyResult
 *
 *   v1 master (wire-compat with existing sturm master.json files):
 *     signMaster, verifyMaster
 *     types: MasterSignature
 *
 *   fingerprints (replay certs):
 *     computeFingerprint, signFingerprint, verifyFingerprint,
 *     attachLlmComponent, sha256, sha256File
 *     types: ExtractionFingerprint, FingerprintComponents,
 *            FingerprintSignature, ReplayCertificate
 *
 *   keys:
 *     resolveSharedKey
 *     types: ResolveKeyOptions
 *
 *   canonical:
 *     canonicalJson
 */

export {
  signEnvelope,
  signEnvelopeEd25519,
  verifyEnvelope,
  verifyEnvelopeAny,
  staticKeyResolver,
  mapKeyResolver,
  ENVELOPE_VERSION,
  ENVELOPE_ALG,
} from './envelope.ts';
export type { Envelope, EnvelopeSignature, KeyResolver, VerifyResult, PublicKeyResolver } from './envelope.ts';

export {
  generateEd25519KeyPair,
  signPayloadEd25519,
  verifyPayloadEd25519,
  ED25519_ALG,
} from './ed25519.ts';
export type { Ed25519Signature, Ed25519KeyPair } from './ed25519.ts';

export { signMaster, verifyMaster } from './master.ts';
export type { MasterSignature } from './master.ts';

export {
  computeFingerprint,
  signFingerprint,
  verifyFingerprint,
  attachLlmComponent,
  sha256,
  sha256File,
} from './fingerprint.ts';
export type {
  ExtractionFingerprint,
  FingerprintComponents,
  FingerprintSignature,
  ReplayCertificate,
} from './fingerprint.ts';

export { resolveSharedKey } from './keys.ts';
export type { ResolveKeyOptions } from './keys.ts';

export { canonicalJson } from './canonical.ts';
