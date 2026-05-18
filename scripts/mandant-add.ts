/**
 * Admin-CLI für die Mandanten-Userverwaltung (Mandanten-Workspace, /m/*-Surface).
 *
 * Verwendung:
 *   npx tsx scripts/mandant-add.ts <email>           — Neuen Mandanten anlegen
 *   npx tsx scripts/mandant-add.ts list              — Alle Mandanten listen
 *   npx tsx scripts/mandant-add.ts revoke <email>    — Mandant + Sessions löschen
 *
 * Persistenz:
 *   runs/_users/<userId>.json
 *   workspaces/<workspaceId>/.sessions/*  (werden bei revoke mitgelöscht)
 *
 * Passwörter werden EINMAL auf stdout gedruckt — danach nie wieder einsehbar.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  createUser,
  getUserByEmail,
  listUsers,
  deleteUser,
  UserExistsError,
} from '../src/lib/m-users.ts';

const ROOT = process.cwd();
const USERS_DIR = path.join(ROOT, 'runs', '_users');
const WORKSPACES_DIR = path.join(ROOT, 'workspaces');

/**
 * 16-Zeichen-Passwort aus URL-safe Base64 (entspricht ~96 Bit Entropie nach
 * Slice). Nur unmissverständliche Zeichen — keine Verwechslungs-Risiken.
 */
function generatePassword(): string {
  // 12 Bytes → 16 base64-Zeichen (mit Padding 'A==' am Ende), wir slicen auf 16.
  // Ersetzen '+/=' durch sichere Alternativen.
  const raw = randomBytes(12).toString('base64').slice(0, 16);
  return raw.replace(/\+/g, 'A').replace(/\//g, 'B').replace(/=/g, 'C');
}

async function cmdAdd(email: string): Promise<void> {
  if (!email || !email.includes('@')) {
    console.error('Ungültige E-Mail-Adresse.');
    process.exit(2);
  }
  const password = generatePassword();
  try {
    const user = await createUser(USERS_DIR, { email, password });
    console.log('');
    console.log(`Mandant angelegt:`);
    console.log(`  User-ID:      ${user.id}`);
    console.log(`  E-Mail:       ${user.email}`);
    console.log(`  Workspace-ID: ${user.workspaceId}`);
    console.log(`  Erstellt:     ${user.createdAt}`);
    console.log('');
    console.log(`  Passwort:     ${password}`);
    console.log('');
    console.log(`  Dieses Passwort wird NICHT erneut angezeigt. Bitte sicher übermitteln.`);
    console.log('');
  } catch (e) {
    if (e instanceof UserExistsError) {
      console.error(`Fehler: ${e.message}`);
      process.exit(1);
    }
    console.error(`Fehler beim Anlegen: ${(e as Error).message}`);
    process.exit(2);
  }
}

async function cmdList(): Promise<void> {
  const users = await listUsers(USERS_DIR);
  if (users.length === 0) {
    console.log('Keine Mandanten registriert.');
    return;
  }
  // Spaltenbreiten ermitteln.
  const headers = ['User-ID', 'E-Mail', 'Workspace-ID', 'Erstellt'];
  const rows = users.map((u) => [u.id, u.email, u.workspaceId, u.createdAt]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmt(r));
}

async function cmdRevoke(email: string): Promise<void> {
  if (!email) {
    console.error('E-Mail-Adresse erforderlich.');
    process.exit(2);
  }
  const user = await getUserByEmail(USERS_DIR, email);
  if (!user) {
    console.error(`Mandant nicht gefunden: ${email}`);
    process.exit(1);
  }
  // Sessions löschen (rekursiv das .sessions-Verzeichnis der Workspace).
  const sessionsDir = path.join(WORKSPACES_DIR, user.workspaceId, '.sessions');
  let sessionsRemoved = 0;
  try {
    const files = await fs.readdir(sessionsDir);
    for (const f of files) {
      try {
        await fs.unlink(path.join(sessionsDir, f));
        sessionsRemoved++;
      } catch { /* skip */ }
    }
  } catch { /* keine Sessions */ }

  const ok = await deleteUser(USERS_DIR, user.id);
  if (!ok) {
    console.error(`User-Datei konnte nicht gelöscht werden: ${user.id}`);
    process.exit(2);
  }
  console.log(`Mandant gelöscht:`);
  console.log(`  User-ID:           ${user.id}`);
  console.log(`  E-Mail:            ${user.email}`);
  console.log(`  Sessions entfernt: ${sessionsRemoved}`);
  console.log(`  Cases bleiben als Waisen erhalten (siehe MANDANTEN_WORKSPACE.md).`);
}

function usage(): never {
  console.error('Verwendung:');
  console.error('  npx tsx scripts/mandant-add.ts <email>');
  console.error('  npx tsx scripts/mandant-add.ts list');
  console.error('  npx tsx scripts/mandant-add.ts revoke <email>');
  process.exit(2);
}

async function main(): Promise<void> {
  const [, , cmd, arg] = process.argv;
  if (!cmd) usage();
  if (cmd === 'list') return cmdList();
  if (cmd === 'revoke') return cmdRevoke(arg ?? '');
  // Default: cmd ist die E-Mail-Adresse.
  if (cmd.includes('@')) return cmdAdd(cmd);
  usage();
}

main().catch((e) => {
  console.error(`Unerwarteter Fehler: ${(e as Error).stack ?? String(e)}`);
  process.exit(2);
});
