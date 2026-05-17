/**
 * Extraction-Fingerprint for ELSTER + downstream replay certificates.
 *
 * Thin re-export over `@0711/envelope`. See `packages/envelope/src/fingerprint.ts`
 * for the actual implementation and rationale. This file exists so existing
 * sturm imports keep working without a path rewrite.
 */

export {
  computeFingerprint,
  signFingerprint,
  verifyFingerprint,
  attachLlmComponent,
  sha256,
  sha256File,
} from '../../packages/envelope/src/fingerprint.ts';

export type {
  ExtractionFingerprint,
  FingerprintComponents,
  FingerprintSignature,
  ReplayCertificate,
} from '../../packages/envelope/src/fingerprint.ts';
