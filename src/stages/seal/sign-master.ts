/**
 * seal/sign-master — HMAC-Signatur über das master-Snapshot.
 *
 * Verwendet src/lib/master-signer.ts (signMaster, resolveMasterKey). Der
 * Schlüssel wird aus STURM_MASTER_HMAC_KEY oder .master-key.json gezogen
 * (idempotent, vorhandene Infrastruktur).
 *
 * Vor der Signatur wird `signature` auf null gesetzt; nach der Signatur
 * wird die Signatur ins master eingebettet.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../../core/stage.ts';
import { signMaster, resolveMasterKey } from '../../lib/master-signer.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../../..');

export interface SignMasterInput {
  master: Record<string, unknown>;
}

export interface SignMasterOutput {
  master: Record<string, unknown>;
  signature: { alg: string; value: string; keyId: string };
}

export interface SignMasterConfig {
  /** Optional override of the project root (where .master-key.json lives). */
  rootDir?: string;
  /** Optional keyId override (for rotation). Default 'sturm-master-v1'. */
  keyId?: string;
}

export const signMasterStage = defineStage<
  SignMasterInput,
  SignMasterOutput,
  SignMasterConfig
>({
  id: 'seal/sign-master',
  name: 'Seal · Sign Master',
  description:
    'HMAC-SHA256-Signatur über den master-Snapshot. Schlüssel aus ' +
    'STURM_MASTER_HMAC_KEY env oder .master-key.json (idempotent angelegt).',
  hints: { inputs: 'master', outputs: 'master (mit signature), signature' },
  async run(input, ctx) {
    const cfg = ctx.config ?? {};
    const rootDir = cfg.rootDir ?? PROJECT_ROOT;
    const keyId = cfg.keyId ?? 'sturm-master-v1';
    if (!input.master || typeof input.master !== 'object') {
      throw new Error('seal/sign-master: input.master required');
    }
    const key = await resolveMasterKey(rootDir);
    const sig = signMaster(input.master, key, keyId);
    const signed = { ...input.master, signature: sig };
    await ctx.artifacts.write('master.signed.json', signed);
    ctx.emit('master_signed', { alg: sig.alg, keyId: sig.keyId });
    return { master: signed, signature: sig };
  },
});
