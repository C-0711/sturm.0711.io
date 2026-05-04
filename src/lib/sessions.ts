/**
 * Workspace tokens + ephemeral sessions for embed-friendly auth.
 *
 * Two layers:
 *
 *   1. WorkspaceToken (long-lived, persistent):
 *      Stored in workspaces/<wsId>/.tokens.json
 *      Issued via POST /api/workspaces/:ws/tokens (admin Bearer required)
 *      Bearer-style usage in the Authorization header
 *
 *   2. Session (short-lived, ephemeral):
 *      Bound to one workspaceId, derived from a token via session-exchange
 *      Storage: in-memory + workspaces/<wsId>/.sessions/<sid>.json
 *      TTL default 1h, sliding expiration
 *      Browser cookie: sturm-session=<sid>
 *
 * Embed-flow:
 *   - cb-chat opens iframe to /embed/workspace?ws=<id>
 *   - iframe posts {type:'sturm:ready', wsId} to parent
 *   - parent posts {type:'sturm:auth', sessionId} to iframe (with targetOrigin)
 *   - iframe POSTs the sessionId to /api/sessions/redeem → sets HttpOnly cookie
 *   - iframe redirects to /workspace.html?ws=<id> (now authenticated)
 *
 * Caller (cb-chat backend) does the token→session exchange server-side, so
 * the long-lived token never reaches the browser.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

const TOKENS_FILE = '.tokens.json';
const SESSIONS_SUBDIR = '.sessions';
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1h

// ---------- Tokens (long-lived) ----------

export interface WorkspaceToken {
  id: string;            // 'wsk_<random>'
  prefix: string;        // first 8 chars of the secret, for log/preview without exposing full secret
  secretHash: string;    // sha256 of the secret (for verify), NOT reversible
  /** Plain secret returned ONCE on creation. Caller persists it. */
  scopes: Array<'read' | 'write' | 'embed'>;
  workspaceId: string;
  createdAt: string;
  createdBy?: string;
  label?: string;
  expiresAt?: string;
  revokedAt?: string;
}

import { createHash } from 'node:crypto';
function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

async function readTokens(workspacesDir: string, wsId: string): Promise<WorkspaceToken[]> {
  const fp = path.join(workspacesDir, wsId, TOKENS_FILE);
  try { return JSON.parse(await fs.readFile(fp, 'utf8')); } catch { return []; }
}
async function writeTokens(workspacesDir: string, wsId: string, tokens: WorkspaceToken[]): Promise<void> {
  await fs.mkdir(path.join(workspacesDir, wsId), { recursive: true });
  await fs.writeFile(path.join(workspacesDir, wsId, TOKENS_FILE), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function issueToken(
  workspacesDir: string,
  wsId: string,
  args: { scopes: WorkspaceToken['scopes']; label?: string; createdBy?: string; expiresInDays?: number },
): Promise<{ token: WorkspaceToken; secret: string }> {
  const secret = randomBytes(32).toString('hex');
  const tokens = await readTokens(workspacesDir, wsId);
  const tk: WorkspaceToken = {
    id: 'wsk_' + randomUUID(),
    prefix: secret.slice(0, 8),
    secretHash: sha256(secret),
    scopes: args.scopes,
    workspaceId: wsId,
    createdAt: new Date().toISOString(),
    createdBy: args.createdBy,
    label: args.label,
    expiresAt: args.expiresInDays
      ? new Date(Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined,
  };
  tokens.push(tk);
  await writeTokens(workspacesDir, wsId, tokens);
  return { token: tk, secret };
}

export async function listTokens(workspacesDir: string, wsId: string): Promise<WorkspaceToken[]> {
  return readTokens(workspacesDir, wsId);
}

export async function revokeToken(workspacesDir: string, wsId: string, tokenId: string): Promise<boolean> {
  const tokens = await readTokens(workspacesDir, wsId);
  const t = tokens.find((x) => x.id === tokenId);
  if (!t) return false;
  t.revokedAt = new Date().toISOString();
  await writeTokens(workspacesDir, wsId, tokens);
  return true;
}

export async function verifyTokenSecret(workspacesDir: string, wsId: string, secret: string): Promise<WorkspaceToken | null> {
  const hash = sha256(secret);
  const tokens = await readTokens(workspacesDir, wsId);
  const found = tokens.find((t) => t.secretHash === hash);
  if (!found) return null;
  if (found.revokedAt) return null;
  if (found.expiresAt && new Date(found.expiresAt).getTime() < Date.now()) return null;
  return found;
}

// ---------- Sessions (short-lived) ----------

export interface Session {
  sessionId: string;
  workspaceId: string;
  scopes: WorkspaceToken['scopes'];
  createdAt: string;
  expiresAt: string;
  derivedFromTokenId: string;
}

const sessionStore = new Map<string, Session>();
let storeLoaded = false;

async function loadSessionStore(workspacesDir: string): Promise<void> {
  if (storeLoaded) return;
  storeLoaded = true;
  // Load existing session sidecars across all workspaces
  let wsIds: string[];
  try { wsIds = await fs.readdir(workspacesDir); } catch { return; }
  for (const wsId of wsIds) {
    const dir = path.join(workspacesDir, wsId, SESSIONS_SUBDIR);
    let entries: string[];
    try { entries = await fs.readdir(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Session;
        if (new Date(s.expiresAt).getTime() > Date.now()) sessionStore.set(s.sessionId, s);
      } catch { /* skip */ }
    }
  }
}

export async function createSession(
  workspacesDir: string,
  wsId: string,
  derivedFromToken: WorkspaceToken,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): Promise<Session> {
  await loadSessionStore(workspacesDir);
  const sessionId = 'sess_' + randomBytes(24).toString('hex');
  const session: Session = {
    sessionId,
    workspaceId: wsId,
    scopes: derivedFromToken.scopes,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    derivedFromTokenId: derivedFromToken.id,
  };
  sessionStore.set(sessionId, session);
  // Persist for restart-safety
  await fs.mkdir(path.join(workspacesDir, wsId, SESSIONS_SUBDIR), { recursive: true });
  await fs.writeFile(
    path.join(workspacesDir, wsId, SESSIONS_SUBDIR, `${sessionId}.json`),
    JSON.stringify(session, null, 2),
    { mode: 0o600 },
  );
  return session;
}

export async function getSession(workspacesDir: string, sessionId: string): Promise<Session | null> {
  await loadSessionStore(workspacesDir);
  const s = sessionStore.get(sessionId);
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() < Date.now()) {
    sessionStore.delete(sessionId);
    return null;
  }
  return s;
}

export async function revokeSession(workspacesDir: string, sessionId: string): Promise<boolean> {
  const s = sessionStore.get(sessionId);
  if (!s) return false;
  sessionStore.delete(sessionId);
  try { await fs.unlink(path.join(workspacesDir, s.workspaceId, SESSIONS_SUBDIR, `${sessionId}.json`)); }
  catch { /* already gone */ }
  return true;
}
