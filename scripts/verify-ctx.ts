#!/usr/bin/env tsx
/**
 * verify-ctx — standalone verifier for Ed25519-signed ctx containers (C2).
 *
 * Reads <containerDir>/container.json and <containerDir>/signature.json,
 * verifies the signature against the embedded issuer_public_pem (and
 * optionally pins against an explicit --expected-fingerprint).
 *
 * Usage:
 *   tsx scripts/verify-ctx.ts <containerDir>
 *   tsx scripts/verify-ctx.ts <containerDir> --expected-fingerprint=sha256:...
 *
 *   # Or verify multiple at once:
 *   for d in ~/0711/0711-STURM/runs/ctx/*/; do tsx scripts/verify-ctx.ts "$d"; done
 *
 * Exit codes:
 *   0  ok                       container + signature both valid
 *   1  invalid_signature        signature does not verify against pubkey
 *   2  container_sha256_drift   manifest was modified after signing
 *   3  missing_files            container.json or signature.json missing
 *   4  fingerprint_mismatch     pubkey fingerprint != --expected-fingerprint
 */

import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  verifyContainerSignature,
  type CtxSignature,
} from '../src/lib/sign-container.ts';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): { dir: string; expectedFingerprint?: string } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--'))
      .map((a) => {
        const [k, v] = a.slice(2).split('=');
        return [k, v === undefined ? 'true' : v];
      }),
  );
  if (positional.length === 0) {
    console.error('Usage: tsx scripts/verify-ctx.ts <containerDir> [--expected-fingerprint=sha256:...]');
    process.exit(1);
  }
  return {
    dir: path.resolve(positional[0]),
    expectedFingerprint: flags['expected-fingerprint'],
  };
}

async function main() {
  const { dir, expectedFingerprint } = parseArgs(process.argv.slice(2));

  const containerJsonPath = path.join(dir, 'container.json');
  const signatureJsonPath = path.join(dir, 'signature.json');

  if (!(await pathExists(containerJsonPath)) || !(await pathExists(signatureJsonPath))) {
    console.error(`[verify-ctx] missing_files in ${dir}`);
    console.error(`            container.json exists: ${await pathExists(containerJsonPath)}`);
    console.error(`            signature.json exists: ${await pathExists(signatureJsonPath)}`);
    process.exit(3);
  }

  const container = JSON.parse(await readFile(containerJsonPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const signature = JSON.parse(await readFile(signatureJsonPath, 'utf8')) as CtxSignature;

  const result = await verifyContainerSignature(container, signature);

  console.log('[verify-ctx]', dir);
  console.log('  container.id          :', (container as { id?: string }).id ?? '?');
  console.log('  container.shortId     :', (container as { shortId?: string }).shortId ?? '?');
  console.log('  issuer_did            :', signature.issuer_did);
  console.log('  issuer_fingerprint    :', signature.issuer_fingerprint);
  console.log('  container_sha256      :', signature.container_sha256);
  console.log('  signed_at             :', signature.signed_at);
  console.log('  alg                   :', signature.alg, '(v' + signature.version + ')');

  if (!result.valid) {
    console.error('  ❌ INVALID:', result.reason);
    if (result.reason?.startsWith('container_sha256_mismatch')) {
      process.exit(2);
    }
    process.exit(1);
  }

  if (expectedFingerprint && expectedFingerprint !== signature.issuer_fingerprint) {
    console.error(
      `  ❌ FINGERPRINT_MISMATCH: expected ${expectedFingerprint}, got ${signature.issuer_fingerprint}`,
    );
    process.exit(4);
  }

  console.log('  ✅ signature valid · container intact · issuer authentic');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify-ctx] unexpected error:', err);
  process.exit(1);
});
