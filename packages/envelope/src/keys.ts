/**
 * Shared-key resolution — env-or-file with optional autogeneration.
 *
 * Ported from sturm's `resolveMasterKey` and generalized: callers can choose
 * the env-var name, key-file location, and whether a missing key should be
 * auto-generated. The generated key is 32 random bytes hex-encoded (64 chars)
 * and persisted with `chmod 600`.
 *
 * Use cases:
 *   - sturm: { envVar: 'STURM_MASTER_HMAC_KEY', keyFile: '.master-key.json' }
 *   - eyeAI: { envVar: 'EYEAI_HMAC_KEY', keyFile: '.atlas-key.json' }
 *   - gateway: keys live in Postgres / vault, this helper is bypassed
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ResolveKeyOptions {
  /** Env var checked first. Must be ≥32 chars to be accepted. */
  envVar: string;
  /** File path (relative to rootDir if not absolute) checked next. */
  keyFile: string;
  /** Directory used for keyFile resolution. */
  rootDir: string;
  /**
   * If true (default), generate + persist a new key when neither env nor file
   * yields one. If false, throw when no key is found.
   */
  generate?: boolean;
}

interface PersistedKeyFile {
  key: string;
  generatedAt: string;
  keyId?: string;
}

export async function resolveSharedKey(opts: ResolveKeyOptions): Promise<string> {
  const fromEnv = process.env[opts.envVar];
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  const keyFile = path.isAbsolute(opts.keyFile) ? opts.keyFile : path.join(opts.rootDir, opts.keyFile);
  try {
    const raw = await fs.readFile(keyFile, 'utf8');
    const parsed = JSON.parse(raw) as PersistedKeyFile;
    if (parsed.key) return parsed.key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (opts.generate === false) {
    throw new Error(`resolveSharedKey: no key in env ${opts.envVar} or file ${keyFile}, and generate=false`);
  }

  const generated = randomBytes(32).toString('hex');
  const body: PersistedKeyFile = {
    key: generated,
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(keyFile, JSON.stringify(body, null, 2), { mode: 0o600 });
  return generated;
}
