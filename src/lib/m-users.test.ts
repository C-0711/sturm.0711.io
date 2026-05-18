/**
 * Tests für die Mandanten-Userverwaltung.
 *
 * Run: node --test --import tsx src/lib/m-users.test.ts
 * Oder via package.json-Script (siehe `test:m-users`).
 *
 * Deckt ab:
 *   - createUser → roundtrip via getUserByEmail / getUserById
 *   - verifyPassword (positiv + negativ)
 *   - User-ID / Workspace-ID Format
 *   - UserExistsError bei doppeltem Login
 *   - deleteUser, listUsers
 *   - Hash-Rückwärtskompatibilität (gespeicherter Hash bleibt verifizierbar)
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createUser,
  getUserByEmail,
  getUserById,
  verifyPassword,
  listUsers,
  deleteUser,
  hashPassword,
  verifyPasswordHash,
  UserExistsError,
  makeUserId,
  makeWorkspaceId,
} from './m-users.ts';

async function tempUsersDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sturm-musers-'));
}

test('makeUserId / makeWorkspaceId — korrektes Format', () => {
  const uid = makeUserId();
  const wid = makeWorkspaceId();
  assert.match(uid, /^u_[a-z0-9]{12}$/, `uid ungültig: ${uid}`);
  assert.match(wid, /^ws_[a-z0-9]{12}$/, `wid ungültig: ${wid}`);
});

test('hashPassword / verifyPasswordHash — Roundtrip', async () => {
  const h = await hashPassword('correct-horse-battery-staple');
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[a-f0-9]+\$[a-f0-9]+$/);
  assert.equal(await verifyPasswordHash('correct-horse-battery-staple', h), true);
  assert.equal(await verifyPasswordHash('falsch', h), false);
  assert.equal(await verifyPasswordHash('', h), false);
});

test('hashPassword — kurzes Passwort wird abgelehnt', async () => {
  await assert.rejects(() => hashPassword('kurz'), /Passwort zu kurz/);
});

test('createUser → getUserByEmail / getUserById Roundtrip', async () => {
  const dir = await tempUsersDir();
  try {
    const u = await createUser(dir, {
      email: 'Mandant@Example.com',
      password: 'sehrgeheim123',
    });
    assert.match(u.id, /^u_[a-z0-9]{12}$/);
    assert.match(u.workspaceId, /^ws_[a-z0-9]{12}$/);
    assert.equal(u.email, 'mandant@example.com'); // normalisiert lowercase

    const byEmail = await getUserByEmail(dir, 'MANDANT@example.com');
    assert.ok(byEmail);
    assert.equal(byEmail!.id, u.id);

    const byId = await getUserById(dir, u.id);
    assert.ok(byId);
    assert.equal(byId!.email, 'mandant@example.com');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createUser — doppelte E-Mail wirft UserExistsError', async () => {
  const dir = await tempUsersDir();
  try {
    await createUser(dir, { email: 'a@b.de', password: 'passwort1234' });
    await assert.rejects(
      () => createUser(dir, { email: 'A@B.de', password: 'andereswort' }),
      (err) => err instanceof UserExistsError,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('verifyPassword — korrekte Credentials → User', async () => {
  const dir = await tempUsersDir();
  try {
    const created = await createUser(dir, { email: 'foo@bar.de', password: 'einsicheres_pw' });
    const u = await verifyPassword(dir, 'foo@bar.de', 'einsicheres_pw');
    assert.ok(u);
    assert.equal(u!.id, created.id);
    assert.equal(u!.workspaceId, created.workspaceId);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('verifyPassword — falsches Passwort → null', async () => {
  const dir = await tempUsersDir();
  try {
    await createUser(dir, { email: 'foo@bar.de', password: 'einsicheres_pw' });
    const u = await verifyPassword(dir, 'foo@bar.de', 'falsch');
    assert.equal(u, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('verifyPassword — unbekannter Account → null', async () => {
  const dir = await tempUsersDir();
  try {
    const u = await verifyPassword(dir, 'unbekannt@x.de', 'irgendwas');
    assert.equal(u, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listUsers — sortiert nach createdAt', async () => {
  const dir = await tempUsersDir();
  try {
    await createUser(dir, { email: 'a@x.de', password: 'pwpwpwpw' });
    await new Promise((r) => setTimeout(r, 10));
    await createUser(dir, { email: 'b@x.de', password: 'pwpwpwpw' });
    const list = await listUsers(dir);
    assert.equal(list.length, 2);
    assert.equal(list[0].email, 'a@x.de');
    assert.equal(list[1].email, 'b@x.de');
    // listUsers liefert MUserPublic — kein Hash-Feld.
    assert.equal((list[0] as unknown as { passwordHash?: string }).passwordHash, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deleteUser — entfernt User und macht Lookup leer', async () => {
  const dir = await tempUsersDir();
  try {
    const u = await createUser(dir, { email: 'gone@x.de', password: 'pwpwpwpw' });
    assert.equal(await deleteUser(dir, u.id), true);
    assert.equal(await getUserByEmail(dir, 'gone@x.de'), null);
    assert.equal(await getUserById(dir, u.id), null);
    // doppeltes Löschen → false
    assert.equal(await deleteUser(dir, u.id), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('getUserById — ungültiges Format → null (kein Throw)', async () => {
  const dir = await tempUsersDir();
  try {
    assert.equal(await getUserById(dir, 'evil/../etc/passwd'), null);
    assert.equal(await getUserById(dir, ''), null);
    assert.equal(await getUserById(dir, 'u_TOOSHORT'), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
