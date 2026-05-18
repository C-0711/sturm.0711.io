/**
 * Mandanten-Auth-Router. Mounted unter `/api/m`.
 *
 * Endpoints (siehe docs/MANDANTEN_WORKSPACE.md):
 *   POST /login   — E-Mail + Passwort → Session-Cookie + Userinfo
 *   POST /logout  — Cookie revoken
 *   GET  /me      — Cookie-Probe für UI ("Bin ich eingeloggt?")
 *
 * Wir nutzen die bestehende Session-Maschinerie aus `src/lib/sessions.ts`:
 * Pro Login wird via `createSession` ein Sidecar unter
 * `workspaces/<workspaceId>/.sessions/<sid>.json` angelegt; das Cookie
 * `sturm-session` (HttpOnly) trägt die Session-ID. `sessionCookieMiddleware`
 * im server.ts attached `req.sturmSession` für nachgelagerte Guards.
 *
 * Bewusst KEIN eigenes Session-Schema — die Wiederverwendung garantiert, dass
 * Mandanten-Sessions denselben Lifecycle (TTL, Persistenz, Revoke) haben wie
 * die Embed-Sessions, und der bestehende Cookie-Reader greift unverändert.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createSession, revokeSession, getSession, type Session, type WorkspaceToken } from '../lib/sessions.ts';
import { verifyPassword, getUserById } from '../lib/m-users.ts';

export interface MandantenAuthRouterOptions {
  /** Pfad zu `runs/_users/`. */
  usersDir: string;
  /** Wird an `createSession` durchgereicht — muss derselbe sein wie im server.ts. */
  workspacesDir: string;
  /** Default `sturm-session` — muss zum sessionCookieMiddleware passen. */
  cookieName?: string;
  /** Default `true`. In Dev-Setups ohne HTTPS auf `false` setzen. */
  secureCookie?: boolean;
  /** Default 7 Tage. Mandanten-Login soll länger leben als die Embed-Default-1h. */
  sessionTtlMs?: number;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Synthetisches Token-Stub für `createSession`. Die Session-Maschinerie braucht
 * nur `id` (für Audit) und `scopes` — wir geben einen festen Pseudo-Token-ID
 * mit Prefix `mtok_` und Scope `embed` (read+write reicht).
 */
function makeMandantenTokenStub(workspaceId: string): WorkspaceToken {
  return {
    id: 'mtok_' + workspaceId,
    prefix: 'mandant',
    secretHash: '',
    scopes: ['read', 'write'],
    workspaceId,
    createdAt: new Date().toISOString(),
  };
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.header('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function buildCookie(name: string, value: string, expiresAt: Date, secure: boolean): string {
  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
    // Same-Origin — Mandanten-Surface ist /m/* auf demselben Host wie /api/m/*.
    // `Lax` reicht und ist sicherer als `None`.
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearCookie(name: string, secure: boolean): string {
  return `${name}=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function createMandantenAuthRouter(opts: MandantenAuthRouterOptions): Router {
  const router = Router();
  router.use(express.json({ limit: '32kb' }));
  const cookieName = opts.cookieName ?? 'sturm-session';
  const secure = opts.secureCookie !== false;
  const ttlMs = opts.sessionTtlMs ?? DEFAULT_TTL_MS;

  // Rate-Limit: 5 Login-Versuche pro IP pro 5 Minuten.
  // Trusted-Proxy-Aware (express-rate-limit liest req.ip).
  const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_attempts', message: 'Zu viele Login-Versuche. Bitte in 5 Minuten erneut versuchen.' },
  });

  // ── POST /login ──────────────────────────────────────────────────────
  router.post('/login', loginLimiter, async (req, res) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!email || !password) {
        return res.status(400).json({ error: 'invalid_request', message: 'email und password erforderlich' });
      }
      const user = await verifyPassword(opts.usersDir, email, password);
      if (!user) {
        // Generisches 401 — kein Hinweis, ob Account existiert.
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      // Workspace-Verzeichnis muss existieren, damit der Session-Sidecar
      // geschrieben werden kann.
      await fs.mkdir(path.join(opts.workspacesDir, user.workspaceId), { recursive: true });

      const stub = makeMandantenTokenStub(user.workspaceId);
      const session = await createSession(opts.workspacesDir, user.workspaceId, stub, ttlMs);

      // userId zusätzlich im Session-Sidecar persistieren, damit die
      // Ownership-Guard-Middleware den User aus der Session ableiten kann
      // (sturmSession.workspaceId → User-Lookup über workspaceId-Index).
      // Wir hängen es als zweite Datei daneben: `<sid>.user.json`.
      try {
        await fs.writeFile(
          path.join(opts.workspacesDir, user.workspaceId, '.sessions', `${session.sessionId}.user.json`),
          JSON.stringify({ userId: user.id, email: user.email }, null, 2),
          { mode: 0o600 },
        );
      } catch { /* Best-Effort — Session funktioniert auch ohne den Hint. */ }

      res.setHeader('Set-Cookie', buildCookie(cookieName, session.sessionId, new Date(session.expiresAt), secure));
      return res.json({ userId: user.id, workspaceId: user.workspaceId, email: user.email });
    } catch (e) {
      return res.status(500).json({ error: 'login_failed', message: (e as Error).message });
    }
  });

  // ── POST /logout ─────────────────────────────────────────────────────
  router.post('/logout', async (req, res) => {
    try {
      const sid = readCookie(req, cookieName);
      if (sid) {
        await revokeSession(opts.workspacesDir, sid);
        // Begleit-Sidecar mit User-Hint mit aufräumen.
        const session = (req as Request & { sturmSession?: Session }).sturmSession;
        if (session) {
          try {
            await fs.unlink(path.join(opts.workspacesDir, session.workspaceId, '.sessions', `${sid}.user.json`));
          } catch { /* already gone */ }
        }
      }
      res.setHeader('Set-Cookie', buildClearCookie(cookieName, secure));
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'logout_failed', message: (e as Error).message });
    }
  });

  // ── GET /me ──────────────────────────────────────────────────────────
  router.get('/me', async (req, res) => {
    try {
      const session = (req as Request & { sturmSession?: Session }).sturmSession;
      if (!session) {
        return res.status(401).json({ error: 'no_session' });
      }
      const userId = await readUserIdFromSession(opts.workspacesDir, session);
      if (!userId) {
        return res.status(401).json({ error: 'no_session' });
      }
      const user = await getUserById(opts.usersDir, userId);
      if (!user) {
        return res.status(401).json({ error: 'no_session' });
      }
      return res.json({ userId: user.id, email: user.email, workspaceId: user.workspaceId });
    } catch (e) {
      return res.status(500).json({ error: 'me_failed', message: (e as Error).message });
    }
  });

  return router;
}

/**
 * Liest die `userId` aus dem `<sid>.user.json`-Sidecar einer Mandanten-Session.
 * Wird auch von der Ownership-Guard-Middleware genutzt.
 */
export async function readUserIdFromSession(
  workspacesDir: string,
  session: Session,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(workspacesDir, session.workspaceId, '.sessions', `${session.sessionId}.user.json`),
      'utf8',
    );
    const obj = JSON.parse(raw) as { userId?: string };
    return typeof obj.userId === 'string' ? obj.userId : null;
  } catch {
    return null;
  }
}

/**
 * Express-Middleware-Factory: Pflicht-Mandanten-Session. 401 sonst.
 * Setzt `req.mandantenUserId` und `req.mandantenWorkspaceId`.
 */
export function requireMandantenSession(opts: { workspacesDir: string; usersDir: string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = (req as Request & { sturmSession?: Session }).sturmSession;
    if (!session) {
      return res.status(401).json({ error: 'no_session' });
    }
    const userId = await readUserIdFromSession(opts.workspacesDir, session);
    if (!userId) {
      return res.status(401).json({ error: 'no_session' });
    }
    const user = await getUserById(opts.usersDir, userId);
    if (!user) {
      return res.status(401).json({ error: 'no_session' });
    }
    (req as Request & { mandantenUserId?: string; mandantenWorkspaceId?: string; mandantenEmail?: string }).mandantenUserId = user.id;
    (req as Request & { mandantenUserId?: string; mandantenWorkspaceId?: string; mandantenEmail?: string }).mandantenWorkspaceId = user.workspaceId;
    (req as Request & { mandantenUserId?: string; mandantenWorkspaceId?: string; mandantenEmail?: string }).mandantenEmail = user.email;
    next();
  };
}
