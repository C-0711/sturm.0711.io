/**
 * Opt-in bearer-token gate.
 *
 * Env: STURM_BEARER_TOKEN
 *   unset → log warning at boot, middleware is a no-op
 *   set   → require `Authorization: Bearer <token>` (or `?token=` for HTML)
 *
 * Path through Cloudflare Access later: see report.
 */

import type { Request, Response, NextFunction } from 'express';

let warned = false;

export function authConfigured(): boolean {
  return !!process.env.STURM_BEARER_TOKEN;
}

export function warnIfDisabled(): void {
  if (warned) return;
  warned = true;
  if (!authConfigured()) {
    console.warn('[auth] STURM_BEARER_TOKEN not set; OCR Studio is publicly accessible');
  } else {
    console.log('[auth] STURM_BEARER_TOKEN set; protected routes require Bearer token');
  }
}

function extractToken(req: Request): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
    return h.slice(7).trim();
  }
  // Allow `?token=` for the static HTML route (one-shot bookmark seed).
  const q = req.query?.token;
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

export function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.STURM_BEARER_TOKEN;
  if (!expected) { next(); return; }
  const tok = extractToken(req);
  if (tok && tok === expected) { next(); return; }
  // Phase E: session cookie also satisfies authentication (limited to
  // the bound workspace — workspace-level enforcement happens per-route via
  // req.sturmSession.workspaceId checks, which is route-handler responsibility).
  const session = (req as Request & { sturmSession?: { workspaceId: string } }).sturmSession;
  if (session) { next(); return; }
  // Distinguish HTML-page hits (return a friendly minimal page) from API hits.
  const wantsHtml = (req.headers['accept'] ?? '').toString().includes('text/html');
  if (wantsHtml) {
    // Wenn der Browser schon mal ein Token in localStorage hat (z.B. via
    // erstmaligem Besuch auf `/`), redirecten wir automatisch mit ?token=…
    // an dieselbe URL — danach matched extractToken() und der zweite Hit
    // ist authenticated. So funktioniert Token-Persistence cross-page,
    // ohne dass der User auf jeder Subpage ?token=… nachreichen muss.
    const safeUrl = (req.originalUrl || req.url || '/').replace(/['"<>]/g, '');
    res.status(401).type('text/html').send(
      `<!doctype html><html><head><meta charset="utf-8"><title>STURM · 401</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#333">
<h1 style="margin:0 0 12px;font-size:20px">401 — Token required</h1>
<p id="msg">Checking local token …</p>
<p id="hint" style="display:none">Set <code>?token=…</code> in the URL once. It will be stored locally and stripped from the URL.</p>
<script>
(function(){
  try {
    var t = localStorage.getItem('sturm-token');
    if (t && t.length > 0) {
      var url = new URL(${JSON.stringify(safeUrl)}, window.location.origin);
      // Wenn das aktuelle 401 von genau diesem Token kam, nicht erneut redirecten
      // (sonst Endlosschleife bei abgelaufenem/falschem Token).
      var attempted = sessionStorage.getItem('sturm-token-attempted');
      if (attempted !== t) {
        sessionStorage.setItem('sturm-token-attempted', t);
        url.searchParams.set('token', t);
        window.location.replace(url.toString());
        return;
      }
      // Token war bereits versucht und abgelehnt → entfernen + Hint zeigen
      localStorage.removeItem('sturm-token');
      sessionStorage.removeItem('sturm-token-attempted');
      document.getElementById('msg').textContent = 'Local token rejected. Please re-issue.';
      document.getElementById('hint').style.display = '';
      return;
    }
    document.getElementById('msg').style.display = 'none';
    document.getElementById('hint').style.display = '';
  } catch (e) {
    document.getElementById('msg').style.display = 'none';
    document.getElementById('hint').style.display = '';
  }
})();
</script>
</body></html>`,
    );
    return;
  }
  res.status(401).json({ error: 'unauthorized', message: 'missing or invalid bearer token' });
}
