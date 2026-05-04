/**
 * Workspace token + session endpoints.
 *
 * /api/workspaces/:ws/tokens          (admin Bearer required)
 *   GET    list tokens (no secrets)
 *   POST   issue token  → returns { token, secret } (secret shown once)
 *   DELETE revoke token (PUT/DELETE/:tokenId)
 *
 * /api/workspaces/:ws/sessions        (workspace token Bearer required)
 *   POST   exchange token → { sessionId, expiresAt }
 *
 * /api/sessions/redeem                (no auth required — sessionId in body)
 *   POST { sessionId } → sets HttpOnly cookie, returns { workspaceId, scopes }
 *
 * /api/sessions/me                    (cookie required)
 *   GET    → { workspaceId, scopes, expiresAt } or 401
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { issueToken, listTokens, revokeToken, verifyTokenSecret, createSession, getSession, revokeSession } from '../lib/sessions.ts';

interface SessionsOpts {
  workspacesDir: string;
  /** Cookie name for the session id. */
  cookieName?: string;
  /** Set Secure on the cookie? Default: true (assumes HTTPS). */
  secureCookie?: boolean;
}

/** Admin token-management router (mounted under /api/workspaces, requires Bearer). */
export function createTokensRouter(opts: SessionsOpts): Router {
  const router = Router();

  router.get('/:ws/tokens', async (req, res) => {
    try {
      const wsId = String(req.params.ws);
      const tokens = await listTokens(opts.workspacesDir, wsId);
      res.json(tokens.map((t) => ({ ...t, secretHash: undefined })));
    } catch (e) {
      res.status(500).json({ error: 'tokens_list_failed', message: (e as Error).message });
    }
  });

  router.post('/:ws/tokens', async (req, res) => {
    try {
      const wsId = String(req.params.ws);
      const scopes = (Array.isArray(req.body?.scopes) ? req.body.scopes : ['embed']) as Array<'read' | 'write' | 'embed'>;
      const label = typeof req.body?.label === 'string' ? req.body.label : undefined;
      const expiresInDays = typeof req.body?.expiresInDays === 'number' ? req.body.expiresInDays : undefined;
      const { token, secret } = await issueToken(opts.workspacesDir, wsId, { scopes, label, expiresInDays, createdBy: 'api' });
      // The secret is returned ONCE. Caller must persist it.
      res.status(201).json({
        token: { ...token, secretHash: undefined },
        secret,
        message: 'Save this secret — it cannot be retrieved later.',
      });
    } catch (e) {
      res.status(500).json({ error: 'token_issue_failed', message: (e as Error).message });
    }
  });

  router.delete('/:ws/tokens/:tokenId', async (req, res) => {
    try {
      const wsId = String(req.params.ws);
      const tokenId = String(req.params.tokenId);
      const ok = await revokeToken(opts.workspacesDir, wsId, tokenId);
      if (!ok) { res.status(404).json({ error: 'token_not_found' }); return; }
      res.json({ revoked: true });
    } catch (e) {
      res.status(500).json({ error: 'token_revoke_failed', message: (e as Error).message });
    }
  });

  /** Token → session exchange. Authorization: Bearer <wskSecret>. */
  router.post('/:ws/sessions', async (req, res) => {
    try {
      const wsId = String(req.params.ws);
      const auth = req.header('authorization') ?? '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      const secret = m?.[1];
      if (!secret) { res.status(401).json({ error: 'missing_token', message: 'Authorization: Bearer <wskSecret>' }); return; }
      const tk = await verifyTokenSecret(opts.workspacesDir, wsId, secret);
      if (!tk) { res.status(403).json({ error: 'invalid_token' }); return; }
      const ttlMs = typeof req.body?.ttlMs === 'number' ? req.body.ttlMs : undefined;
      const session = await createSession(opts.workspacesDir, wsId, tk, ttlMs);
      res.status(201).json({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        scopes: session.scopes,
        expiresAt: session.expiresAt,
      });
    } catch (e) {
      res.status(500).json({ error: 'session_create_failed', message: (e as Error).message });
    }
  });

  return router;
}

/** Cookie-redemption router (mounted standalone, no Bearer required). */
export function createSessionRedeemRouter(opts: SessionsOpts): Router {
  const router = Router();
  const cookieName = opts.cookieName ?? 'sturm-session';
  const secure = opts.secureCookie !== false;

  router.post('/redeem', async (req, res) => {
    try {
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      if (!sessionId) { res.status(400).json({ error: 'missing_sessionId' }); return; }
      const session = await getSession(opts.workspacesDir, sessionId);
      if (!session) { res.status(404).json({ error: 'session_not_found_or_expired' }); return; }
      // Set HttpOnly cookie. SameSite=None+Secure for cross-site iframe embed.
      const cookieParts = [
        `${cookieName}=${sessionId}`,
        'HttpOnly',
        'Path=/',
        `Expires=${new Date(session.expiresAt).toUTCString()}`,
        'SameSite=None',
      ];
      if (secure) cookieParts.push('Secure');
      res.setHeader('Set-Cookie', cookieParts.join('; '));
      res.json({ workspaceId: session.workspaceId, scopes: session.scopes, expiresAt: session.expiresAt });
    } catch (e) {
      res.status(500).json({ error: 'redeem_failed', message: (e as Error).message });
    }
  });

  router.get('/me', async (req, res) => {
    try {
      const sessionId = readCookie(req, cookieName);
      if (!sessionId) { res.status(401).json({ error: 'no_session' }); return; }
      const session = await getSession(opts.workspacesDir, sessionId);
      if (!session) { res.status(401).json({ error: 'session_expired' }); return; }
      res.json({ workspaceId: session.workspaceId, scopes: session.scopes, expiresAt: session.expiresAt });
    } catch (e) {
      res.status(500).json({ error: 'me_failed', message: (e as Error).message });
    }
  });

  router.post('/logout', async (req, res) => {
    const sessionId = readCookie(req, cookieName);
    if (sessionId) await revokeSession(opts.workspacesDir, sessionId);
    res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=None${secure ? '; Secure' : ''}`);
    res.json({ loggedOut: true });
  });

  return router;
}

/** Express middleware that reads the sturm-session cookie and attaches the
 *  session info to req.sturmSession. Does NOT enforce — combine with a
 *  per-route check or the existing Bearer middleware. */
export function sessionCookieMiddleware(opts: SessionsOpts): (req: Request, res: Response, next: NextFunction) => void {
  const cookieName = opts.cookieName ?? 'sturm-session';
  return async (req, _res, next) => {
    const sessionId = readCookie(req, cookieName);
    if (sessionId) {
      const session = await getSession(opts.workspacesDir, sessionId);
      if (session) (req as Request & { sturmSession?: typeof session }).sturmSession = session;
    }
    next();
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
