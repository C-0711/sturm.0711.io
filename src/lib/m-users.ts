/**
 * Mandanten-Userverwaltung (Mandanten-Workspace, /m/*-Surface).
 *
 * MVP-Persistenz: JSON-Datei pro User unter `runs/_users/{userId}.json`.
 * E-Mail wird beim Lookup über Verzeichnis-Scan gefunden — bei <= 10 Mandanten
 * akzeptabel. Wenn das mal mehr wird, hier einen Index einziehen.
 *
 * Passwort-Hash: Node-Builtin `crypto.scrypt` (kein argon2-Dep im Repo). Format
 * `scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>`, sodass der Hash selbst alle Parameter
 * trägt und ein späterer Migrations-Wechsel (z.B. auf argon2id) möglich bleibt.
 *
 * IDs:
 *   userId      → `u_`  + 12 base36 Zeichen
 *   workspaceId → `ws_` + 12 base36 Zeichen
 *
 * Eine User-Anlage erzeugt automatisch genau eine Workspace-ID (1:1).
 * Das Verzeichnis `workspaces/<workspaceId>/` wird hier NICHT angelegt — das
 * passiert lazy beim ersten Session-Create (createSession schreibt dort den
 * Session-Sidecar).
 *
 * Siehe docs/MANDANTEN_WORKSPACE.md für den vollständigen API-Contract.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

// scrypt-Parameter — Default-Empfehlung der Node-Doku, ergibt ~64 MB Memory.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
// scrypt maxmem-Default ist 32 MB — zu klein für N=16384. 128 MB ist sicher.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

export interface MUser {
  /** `u_` + 12 base36 Zeichen. */
  id: string;
  /** Lowercase, getrimmt. */
  email: string;
  /** Format: `scrypt$N$r$p$saltHex$keyHex`. */
  passwordHash: string;
  /** 1:1 — pro User genau eine Workspace-ID. */
  workspaceId: string;
  createdAt: string;
}

export interface MUserPublic {
  id: string;
  email: string;
  workspaceId: string;
  createdAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function base36(n: number): string {
  // Liefert n base36-Zeichen aus Zufallsbytes.
  // randomBytes(n) → Hex liefert 2*n Zeichen; wir parsen in 5er-Chunks (max 0xfffff
  // passt in Number sicher) und konkatenieren das Ergebnis.
  let out = '';
  while (out.length < n) {
    const buf = randomBytes(8);
    out += buf.readBigUInt64BE().toString(36);
  }
  return out.slice(0, n);
}

export function makeUserId(): string {
  return 'u_' + base36(12);
}

export function makeWorkspaceId(): string {
  return 'ws_' + base36(12);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function userFilePath(usersDir: string, userId: string): string {
  return path.join(usersDir, `${userId}.json`);
}

async function ensureUsersDir(usersDir: string): Promise<void> {
  await fs.mkdir(usersDir, { recursive: true });
}

// ── Passwort-Hash ──────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error('Passwort zu kurz — mindestens 8 Zeichen');
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  if (!password || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer; let key: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    key = Buffer.from(parts[5], 'hex');
  } catch { return false; }
  let candidate: Buffer;
  try {
    candidate = await scrypt(password, salt, key.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  } catch { return false; }
  if (candidate.length !== key.length) return false;
  return timingSafeEqual(candidate, key);
}

// ── CRUD ───────────────────────────────────────────────────────────────

export interface CreateUserArgs {
  email: string;
  password: string;
}

export class UserExistsError extends Error {
  constructor(email: string) {
    super(`E-Mail bereits vergeben: ${email}`);
    this.name = 'UserExistsError';
  }
}

export async function createUser(usersDir: string, args: CreateUserArgs): Promise<MUserPublic> {
  await ensureUsersDir(usersDir);
  const email = normalizeEmail(args.email);
  if (!email.includes('@')) {
    throw new Error('Ungültige E-Mail-Adresse');
  }
  const existing = await getUserByEmail(usersDir, email);
  if (existing) throw new UserExistsError(email);

  const user: MUser = {
    id: makeUserId(),
    email,
    passwordHash: await hashPassword(args.password),
    workspaceId: makeWorkspaceId(),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(userFilePath(usersDir, user.id), JSON.stringify(user, null, 2), { mode: 0o600 });
  return toPublic(user);
}

export async function getUserById(usersDir: string, userId: string): Promise<MUser | null> {
  if (!/^u_[a-z0-9]{12}$/.test(userId)) return null;
  try {
    const raw = await fs.readFile(userFilePath(usersDir, userId), 'utf8');
    return JSON.parse(raw) as MUser;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function getUserByEmail(usersDir: string, email: string): Promise<MUser | null> {
  const target = normalizeEmail(email);
  let files: string[];
  try { files = await fs.readdir(usersDir); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(usersDir, f), 'utf8');
      const u = JSON.parse(raw) as MUser;
      if (normalizeEmail(u.email) === target) return u;
    } catch { /* skip corrupted */ }
  }
  return null;
}

export async function verifyPassword(
  usersDir: string,
  email: string,
  password: string,
): Promise<MUser | null> {
  const user = await getUserByEmail(usersDir, email);
  if (!user) return null;
  const ok = await verifyPasswordHash(password, user.passwordHash);
  return ok ? user : null;
}

export async function listUsers(usersDir: string): Promise<MUserPublic[]> {
  let files: string[];
  try { files = await fs.readdir(usersDir); } catch { return []; }
  const out: MUserPublic[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(usersDir, f), 'utf8');
      const u = JSON.parse(raw) as MUser;
      out.push(toPublic(u));
    } catch { /* skip */ }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export async function deleteUser(usersDir: string, userId: string): Promise<boolean> {
  const u = await getUserById(usersDir, userId);
  if (!u) return false;
  try {
    await fs.unlink(userFilePath(usersDir, userId));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function toPublic(u: MUser): MUserPublic {
  return { id: u.id, email: u.email, workspaceId: u.workspaceId, createdAt: u.createdAt };
}
