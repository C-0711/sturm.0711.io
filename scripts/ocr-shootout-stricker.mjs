#!/usr/bin/env node
/**
 * Run all 7 Stricker fixtures through the ocr-shootout workflow (4-OCR fanout)
 * and aggregate per-engine timing + content stats.
 *
 *   node scripts/ocr-shootout-stricker.mjs --base http://localhost:7800
 */
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const args = process.argv.slice(2);
let base = 'http://localhost:7800';
let fixtures = path.join(REPO, 'tests/fixtures/stricker');
let outDir = path.join(REPO, `reports/ocr-shootout-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base') base = args[++i];
  else if (args[i] === '--fixtures') fixtures = path.resolve(args[++i]);
  else if (args[i] === '--out') outDir = path.resolve(args[++i]);
}
await mkdir(outDir, { recursive: true });

function ts() { return new Date().toISOString().slice(11, 19); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

const files = (await readdir(fixtures)).filter((f) => /\.(pdf|jpe?g|png)$/i.test(f)).sort();
log(`Running ${files.length} fixtures through ocr-shootout`);

const ENGINES = ['text_layer', 'mistral', 'lighton', 'paddle'];
const results = [];

for (const fn of files) {
  const filePath = path.join(fixtures, fn);
  const fileSize = (await stat(filePath)).size;
  log(`  → ${fn} (${(fileSize / 1024).toFixed(1)} KB)`);

  // multipart upload
  const form = new FormData();
  const buf = await readFile(filePath);
  form.append('file', new Blob([buf]), fn);

  const t0 = Date.now();
  const resp = await fetch(`${base}/api/workflows/ocr-shootout/run`, {
    method: 'POST',
    body: form,
  });
  if (!resp.ok) {
    log(`     ✗ HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    results.push({ filename: fn, error: `HTTP ${resp.status}`, perEngine: {} });
    continue;
  }

  // consume the SSE stream
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf2 = '';
  let runId = null;
  let runDone = false;
  while (!runDone) {
    const { value, done } = await reader.read();
    if (done) break;
    buf2 += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf2.indexOf('\n\n')) >= 0) {
      const chunk = buf2.slice(0, nl);
      buf2 = buf2.slice(nl + 2);
      const ev = parseSSE(chunk);
      if (!ev) continue;
      if (ev.event === 'run_meta' || ev.event === 'run_start') runId = runId ?? ev.data?.runId;
      if (ev.event === 'run_done' || ev.event === 'run_error') runDone = true;
    }
  }
  const wallMs = Date.now() - t0;

  if (!runId) { log(`     ✗ no runId returned`); results.push({ filename: fn, error: 'no runId' }); continue; }

  // fetch the run result
  const r = await fetch(`${base}/api/runs/ocr-shootout/${runId}`);
  if (!r.ok) { log(`     ✗ result fetch: HTTP ${r.status}`); results.push({ filename: fn, runId, error: `result ${r.status}` }); continue; }
  const rr = await r.json();

  const perEngine = {};
  const fanout = rr?.stages?.ocr_fanout?.output ?? {};
  const branches = fanout.branches || {};
  const perBranchMs = fanout.perBranchMs || {};
  const errors = fanout.errors || {};
  for (const engine of ENGINES) {
    const b = branches[engine] ?? null;
    let textChars = null;
    if (b) {
      if (typeof b.text === 'string') textChars = b.text.length;
      else if (Array.isArray(b.pages)) textChars = b.pages.reduce((a, p) => a + (p?.markdown?.length ?? 0), 0);
      else if (typeof b.markdown === 'string') textChars = b.markdown.length;
    }
    perEngine[engine] = {
      ok: !errors[engine] && b != null,
      ms: perBranchMs[engine] ?? null,
      chars: textChars,
      error: errors[engine] ?? null,
    };
  }

  log(`     ✓ ${wallMs}ms total · ${ENGINES.map(e => `${e}=${perEngine[e].ok ? perEngine[e].ms + 'ms/' + (perEngine[e].chars ?? '?') + 'c' : 'ERR'}`).join(', ')}`);
  results.push({ filename: fn, runId, wallMs, perEngine, fileSizeKb: +(fileSize / 1024).toFixed(1) });
}

function parseSSE(chunk) {
  const lines = chunk.split('\n');
  const ev = { event: null, data: null };
  for (const l of lines) {
    if (l.startsWith('event:')) ev.event = l.slice(6).trim();
    else if (l.startsWith('data:')) {
      try { ev.data = JSON.parse(l.slice(5).trim()); } catch { /* ignore */ }
    }
  }
  return ev.event ? ev : null;
}

// Summary
const summary = {
  fixtures: files,
  byEngine: {},
};
for (const engine of ENGINES) {
  const recs = results.flatMap((r) => (r.perEngine?.[engine] ? [r.perEngine[engine]] : []));
  const ok = recs.filter((r) => r.ok);
  const fail = recs.filter((r) => !r.ok);
  const msSum = ok.reduce((a, r) => a + (r.ms || 0), 0);
  const charsSum = ok.reduce((a, r) => a + (r.chars || 0), 0);
  summary.byEngine[engine] = {
    okCount: ok.length,
    failCount: fail.length,
    avgMs: ok.length ? Math.round(msSum / ok.length) : null,
    p95Ms: percentile(ok.map((r) => r.ms || 0), 0.95),
    avgChars: ok.length ? Math.round(charsSum / ok.length) : null,
    errors: fail.map((r) => r.error).filter(Boolean),
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

await writeFile(path.join(outDir, 'results.json'), JSON.stringify({ results, summary }, null, 2));
console.log('\n══════════ Summary ══════════');
console.log(`Fixtures: ${files.length}`);
console.log();
console.log('Engine          OK   Fail   AvgMs   P95Ms   AvgChars');
console.log('───────────────────────────────────────────────────────');
for (const engine of ENGINES) {
  const s = summary.byEngine[engine];
  console.log(
    `${engine.padEnd(15)} ${String(s.okCount).padStart(2)}    ${String(s.failCount).padStart(2)}    ${String(s.avgMs ?? '—').padStart(5)}   ${String(s.p95Ms ?? '—').padStart(5)}   ${String(s.avgChars ?? '—').padStart(7)}`
  );
}
console.log();
console.log(`Report: ${outDir}/results.json`);
