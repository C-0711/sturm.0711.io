#!/usr/bin/env node
// STURM Tool-Roster — Smoke-Test für externe Tool-Bindings (P0).
//
// Probiert jeden konfigurierten Endpoint mit kurzem Timeout an und gibt
// einen Roster-Report aus. Keine Dependencies außer Node 20+ stdlib.
// Druckt NIEMALS API-Key-Werte — nur "gesetzt" / "fehlt".
//
// Exit-Codes:
//   0 — kein Fehler (✕ kommt nicht vor)
//   1 — mindestens ein Tool gemeldet als Fehler

const TIMEOUT_MS = 5000;

const env = process.env;

// ── Helpers ──────────────────────────────────────────────────────────
function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout (${ms} ms) — ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function shortenUrl(url, maxLen = 28) {
  if (!url) return '—';
  if (url.length <= maxLen) return url;
  // Replace middle path component with …
  try {
    const u = new URL(url);
    const host = u.host;
    const path = u.pathname === '/' ? '' : u.pathname;
    const candidate = `${u.protocol}//${host}${path}`;
    if (candidate.length <= maxLen) return candidate;
    return `${u.protocol}//${host}…`;
  } catch {
    return url.slice(0, maxLen - 1) + '…';
  }
}

function pad(str, len) {
  const s = String(str ?? '');
  if (s.length >= len) return s.slice(0, len);
  return s + ' '.repeat(len - s.length);
}

// ── Probes ───────────────────────────────────────────────────────────
async function probeVllm() {
  const url = env.VLLM_URL;
  if (!url) {
    return { status: 'skip', detail: 'VLLM_URL nicht gesetzt', url: null };
  }
  const target = url.replace(/\/$/, '') + '/v1/models';
  const t0 = nowMs();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(target, { signal: ctrl.signal });
    clearTimeout(tid);
    const ms = nowMs() - t0;
    if (res.status !== 200) {
      return { status: 'fail', detail: `HTTP ${res.status}`, ms, url };
    }
    const body = await res.json();
    const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
    const found = ids.find((id) => id === 'gemma4-mm' || id.includes('gemma4-mm'));
    if (!found) {
      return { status: 'fail', detail: `gemma4-mm fehlt (gefunden: ${ids.slice(0, 3).join(', ') || 'keine'})`, ms, url };
    }
    return { status: 'ok', detail: `${found} ✓`, ms, url };
  } catch (err) {
    const ms = nowMs() - t0;
    return { status: 'fail', detail: err?.message || String(err), ms, url };
  }
}

async function probeOllama() {
  const url = env.OLLAMA_URL || 'http://localhost:11434';
  const target = url.replace(/\/$/, '') + '/api/tags';
  const t0 = nowMs();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(target, { signal: ctrl.signal });
    clearTimeout(tid);
    const ms = nowMs() - t0;
    if (res.status !== 200) {
      return { status: 'fail', detail: `HTTP ${res.status}`, ms, url };
    }
    const body = await res.json();
    const names = Array.isArray(body?.models) ? body.models.map((m) => m?.name).filter(Boolean) : [];
    const found = names.find(
      (n) => n === 'embeddinggemma:latest' || n === 'embeddinggemma' || n.startsWith('embeddinggemma:'),
    );
    if (!found) {
      return {
        status: 'fail',
        detail: `embeddinggemma fehlt (${names.length} andere Modelle geladen)`,
        ms,
        url,
      };
    }
    return { status: 'ok', detail: 'model loaded', ms, url };
  } catch (err) {
    const ms = nowMs() - t0;
    return { status: 'fail', detail: err?.message || String(err), ms, url };
  }
}

async function probeMcp(name, url) {
  if (!url) {
    return { status: 'skip', detail: 'nicht konfiguriert', url: null };
  }
  const t0 = nowMs();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    clearTimeout(tid);
    const ms = nowMs() - t0;
    if (res.status < 200 || res.status >= 300) {
      return { status: 'fail', detail: `HTTP ${res.status}`, ms, url };
    }
    // Try to count tools — accept SSE or JSON.
    const ct = res.headers.get('content-type') || '';
    let toolCount = null;
    if (ct.includes('application/json')) {
      try {
        const body = await res.json();
        const tools = body?.result?.tools;
        if (Array.isArray(tools)) toolCount = tools.length;
      } catch {
        // ignore
      }
    }
    const detail = toolCount !== null ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : 'reachable';
    return { status: 'ok', detail, ms, url };
  } catch (err) {
    const ms = nowMs() - t0;
    return { status: 'fail', detail: err?.message || String(err), ms, url };
  }
}

async function probeGitchain() {
  const url = env.GITCHAIN_API_URL;
  if (!url) {
    return { status: 'skip', detail: 'nicht konfiguriert', url: null };
  }
  const base = url.replace(/\/$/, '');
  const t0 = nowMs();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(base + '/healthz', { signal: ctrl.signal });
    clearTimeout(tid);
    const ms = nowMs() - t0;
    if (res.status === 200) {
      return { status: 'ok', detail: 'healthy', ms, url };
    }
    if (res.status === 404) {
      // Fallback to root
      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), TIMEOUT_MS);
      const t1 = nowMs();
      const res2 = await fetch(base + '/', { signal: ctrl2.signal });
      clearTimeout(tid2);
      const ms2 = nowMs() - t1;
      if (res2.status >= 200 && res2.status < 300) {
        return { status: 'ok', detail: `root ${res2.status}`, ms: ms2, url };
      }
      return { status: 'fail', detail: `HTTP ${res2.status} (root fallback)`, ms: ms2, url };
    }
    return { status: 'fail', detail: `HTTP ${res.status}`, ms, url };
  } catch (err) {
    const ms = nowMs() - t0;
    return { status: 'fail', detail: err?.message || String(err), ms, url };
  }
}

function probeApiKey(name) {
  const value = env[name];
  if (value && value.length > 0) {
    return { status: 'ok', detail: 'gesetzt', url: null };
  }
  return { status: 'skip', detail: 'fehlt', url: null };
}

// ── Roster-Layout ────────────────────────────────────────────────────
const ICON = { ok: '●', skip: '○', fail: '✕' };

function renderRow(label, url, result) {
  const icon = ICON[result.status] || '?';
  const urlText = result.status === 'skip' && !url ? 'nicht konfiguriert' : shortenUrl(url || '');
  const msText = result.ms !== undefined ? `${result.ms} ms` : '—';
  return `${icon}  ${pad(label, 19)} ${pad(urlText, 28)} ${pad(msText, 8)} ${result.detail || ''}`;
}

async function main() {
  const [vllm, ollama, bmf, elster, gitchain] = await Promise.all([
    probeVllm(),
    probeOllama(),
    probeMcp('bmf', env.BMF_MCP_URL || 'http://localhost:12010/mcp'),
    probeMcp('elster', env.ELSTER_MCP_URL || ''),
    probeGitchain(),
  ]);
  const anthropic = probeApiKey('ANTHROPIC_API_KEY');
  const mistral = probeApiKey('MISTRAL_API_KEY');

  const rows = [
    { label: 'gemma4-mm (vLLM)', url: env.VLLM_URL, result: vllm },
    { label: 'embeddinggemma', url: env.OLLAMA_URL || 'http://localhost:11434', result: ollama },
    { label: 'bmf-lane1', url: env.BMF_MCP_URL || 'http://localhost:12010/mcp', result: bmf },
    { label: 'elster-lane5', url: env.ELSTER_MCP_URL || '', result: elster },
    { label: 'gitchain', url: env.GITCHAIN_API_URL || '', result: gitchain },
    { label: 'ANTHROPIC_API_KEY', url: null, result: anthropic },
    { label: 'MISTRAL_API_KEY', url: null, result: mistral },
  ];

  const sep = '─'.repeat(65);
  process.stdout.write('STURM Tool-Roster\n');
  process.stdout.write(sep + '\n');
  for (const row of rows) {
    if (row.url === null) {
      // API-Key compact row
      const icon = ICON[row.result.status] || '?';
      process.stdout.write(`${icon}  ${pad(row.label, 19)} ${row.result.detail}\n`);
    } else {
      process.stdout.write(renderRow(row.label, row.url, row.result) + '\n');
    }
  }
  process.stdout.write(sep + '\n');

  const ok = rows.filter((r) => r.result.status === 'ok').length;
  const skip = rows.filter((r) => r.result.status === 'skip').length;
  const fail = rows.filter((r) => r.result.status === 'fail').length;
  process.stdout.write(`${ok} OK · ${skip} nicht konfiguriert · ${fail} Fehler\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`verify-tools: unerwarteter Fehler: ${err?.message || err}\n`);
  process.exit(1);
});
