/**
 * STURM Embed bootstrap.
 *
 * Loaded inside an iframe by a parent frame (e.g. cb-chat-frontend on a
 * different origin). Performs a postMessage handshake to receive a one-time
 * sessionId, exchanges it for an HttpOnly cookie, then redirects into the
 * actual workspace UI.
 *
 * Protocol:
 *   1. iframe → parent.postMessage({type:'sturm:ready', wsId, version:'v1'}, '*')
 *   2. parent → iframe.postMessage({type:'sturm:auth', sessionId, redirectTo?}, IFRAME_ORIGIN)
 *   3. iframe POSTs sessionId to /api/sessions/redeem (sets cookie)
 *   4. iframe redirects to redirectTo or default workspace.html
 *
 * Parent must specify a `targetOrigin` matching the iframe origin (NOT '*')
 * when posting auth — otherwise the iframe rejects the message.
 *
 * No tokens in URL. The sessionId from the parent is one-time and short-lived.
 */

const params = new URLSearchParams(location.search);
const wsId = params.get('ws') || '';
const debugMode = params.has('debug');

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const errorEl = $('error');
const spinEl = $('spin');
const debugEl = $('debug');

function setError(msg) {
  spinEl.style.display = 'none';
  statusEl.textContent = '';
  errorEl.hidden = false;
  errorEl.textContent = msg;
}
function setStatus(msg) {
  statusEl.textContent = msg;
}
function dbg(msg) {
  if (!debugMode) return;
  debugEl.textContent += (debugEl.textContent ? '\n' : '') + msg;
}

if (!wsId) {
  setError('Embed-Fehler: ?ws=<workspaceId> fehlt in der URL.');
} else {
  bootstrap();
}

function bootstrap() {
  // 1. Tell parent we're ready
  if (window.parent === window) {
    setError('Embed-Fehler: nicht in einem iframe (kein parent frame).');
    return;
  }
  setStatus(`Lade Workspace ${wsId.slice(0, 8)}… handshake mit parent…`);
  dbg('postMessage sturm:ready');
  window.parent.postMessage({ type: 'sturm:ready', wsId, version: 'v1' }, '*');

  // 2. Wait for auth from parent (or redeem an existing cookie if already valid)
  const authTimeout = setTimeout(async () => {
    // Maybe we already have a valid session cookie?
    const ok = await tryExistingSession();
    if (!ok) {
      setError('Timeout: Parent hat keinen sessionId geliefert. Stelle sicher, dass der Parent {type:\'sturm:auth\', sessionId} via postMessage schickt.');
    }
  }, 8000);

  window.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object' || msg.type !== 'sturm:auth') return;
    clearTimeout(authTimeout);
    dbg(`auth from ${ev.origin}`);
    if (typeof msg.sessionId !== 'string') {
      setError('Auth-Message hatte keinen sessionId.');
      return;
    }
    setStatus('Tausche sessionId gegen Cookie…');
    try {
      const resp = await fetch('/api/sessions/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sessionId: msg.sessionId }),
      });
      if (!resp.ok) throw new Error(`/redeem HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      if (data.workspaceId !== wsId) {
        setError(`Session-Workspace mismatch: erwartet ${wsId}, bekommen ${data.workspaceId}.`);
        return;
      }
      // 3. Redirect
      const redirectTo = typeof msg.redirectTo === 'string' && msg.redirectTo.startsWith('/')
        ? msg.redirectTo
        : `/workspace.html?ws=${encodeURIComponent(wsId)}`;
      setStatus('Authentifiziert. Lade UI…');
      window.location.replace(redirectTo);
    } catch (e) {
      setError(`Redeem fehlgeschlagen: ${e.message ?? String(e)}`);
    }
  });
}

async function tryExistingSession() {
  try {
    const resp = await fetch('/api/sessions/me', { credentials: 'include' });
    if (!resp.ok) return false;
    const data = await resp.json();
    if (data.workspaceId !== wsId) return false;
    setStatus('Bestehende Session gefunden, lade UI…');
    window.location.replace(`/workspace.html?ws=${encodeURIComponent(wsId)}`);
    return true;
  } catch {
    return false;
  }
}
