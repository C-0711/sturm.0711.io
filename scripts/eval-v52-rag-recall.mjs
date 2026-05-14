#!/usr/bin/env node
/**
 * scripts/eval-v52-rag-recall.mjs
 *
 * Misst per-K Recall von `elster-v5_2-rag` gegen `elster-v5_2` auf einer
 * Sammlung von Test-Dokumenten. Ersetzt die im Spec geforderte fiktive
 * "99.9% certainty" mit einer ehrlichen, reproduzierbaren Zahl.
 *
 * Voraussetzungen:
 *   • sturm läuft (lokal :7800 oder via STURM_URL env)
 *   • Workflow-Runs benötigen Bearer-Token (STURM_BEARER_TOKEN env)
 *   • Mistral- + Anthropic-API-Keys sowie vLLM/Ollama-Endpoints konfiguriert
 *   • Ein Verzeichnis mit Test-PDFs/PNGs (--fixtures <dir>)
 *   • Für jedes Fixture eine Groundtruth-JSON unter
 *       tests/groundtruth/expected/<filename>.json
 *     mit Shape: { canonical_layer: { eCode: { normalized: "…" } } }
 *
 * Output: ein Markdown-Tabellen-Report mit:
 *   • per-Datei: Recall@K für beide Workflows
 *   • Aggregat: Mittlerer Recall, Anzahl korrekt extrahierter Pflicht-Felder,
 *     Anzahl ENSEMBLE_TIE-Flags (falls aktiviert)
 *
 * Aufruf:
 *   STURM_URL=http://localhost:7800 STURM_BEARER_TOKEN=… \
 *     node scripts/eval-v52-rag-recall.mjs \
 *       --fixtures ./tests/fixtures/lohnsteuer \
 *       --workflows elster-v5_2,elster-v5_2-rag \
 *       --out reports/v52-rag-recall.md
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const STURM_URL = process.env.STURM_URL ?? 'http://localhost:7800';
const TOKEN = process.env.STURM_BEARER_TOKEN ?? '';

function parseArgs(argv) {
  const out = { fixtures: null, workflows: ['elster-v5_2', 'elster-v5_2-rag'], out: 'reports/v52-rag-recall.md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixtures') out.fixtures = argv[++i];
    else if (a === '--workflows') out.workflows = argv[++i].split(',').map(s => s.trim());
    else if (a === '--out') out.out = argv[++i];
  }
  if (!out.fixtures) throw new Error('--fixtures <dir> required');
  return out;
}

async function runWorkflow(workflowId, filePath) {
  // Multipart upload to /api/workflows/:id/run; consume SSE → last run_done event.
  const url = `${STURM_URL}/api/workflows/${encodeURIComponent(workflowId)}/run`;
  const form = new FormData();
  const data = await readFile(filePath);
  form.append('file', new Blob([data]), path.basename(filePath));
  const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
  const res = await fetch(url, { method: 'POST', body: form, headers });
  if (!res.ok) throw new Error(`${workflowId} run failed: ${res.status} ${await res.text()}`);
  // Stream SSE → capture runId + last canonical_layer artifact reference.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let runId = null;
  let finalState = null;
  let canonicalLayer = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const m = /^data:\s*(.+)$/m.exec(p);
      if (!m) continue;
      try {
        const ev = JSON.parse(m[1]);
        if (ev.name === 'run_meta') runId = ev.runId;
        if (ev.name === 'stage_done' && ev.payload?.output) {
          const out = ev.payload.output;
          if (out.canonicalLayer?.codes) canonicalLayer = out.canonicalLayer.codes;
          else if (out.canonical_layer) canonicalLayer = out.canonical_layer;
        }
        if (ev.name === 'run_done') finalState = 'ok';
        if (ev.name === 'run_error') finalState = 'error';
      } catch { /* ignore */ }
    }
  }
  return { runId, finalState, canonicalLayer: canonicalLayer ?? {} };
}

function normalize(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ').toLowerCase();
  return String(v).trim().toLowerCase();
}

function compareLayer(actual, expected) {
  const expKeys = Object.keys(expected);
  let matched = 0;
  const misses = [];
  for (const k of expKeys) {
    const a = actual?.[k];
    const e = expected[k];
    const aVal = normalize(a?.normalized ?? a?.value);
    const eVal = normalize(e?.normalized ?? e?.value);
    if (aVal && eVal && aVal === eVal) matched++;
    else misses.push({ eCode: k, expected: eVal, actual: aVal });
  }
  return {
    matched,
    total: expKeys.length,
    recall: expKeys.length === 0 ? 0 : matched / expKeys.length,
    misses,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(HERE, '..');
  const fixturesDir = path.resolve(args.fixtures);
  const truthDir = path.join(REPO, 'tests', 'groundtruth', 'expected');

  const files = (await readdir(fixturesDir))
    .filter(f => /\.(pdf|png|jpe?g)$/i.test(f))
    .sort();
  if (files.length === 0) { console.error(`no fixtures in ${fixturesDir}`); process.exit(1); }

  const rows = []; // { file, perWorkflow: { wfId: { recall, matched, total } } }
  for (const f of files) {
    const truthPath = path.join(truthDir, `${f}.json`);
    let expected;
    try {
      expected = JSON.parse(await readFile(truthPath, 'utf-8')).canonical_layer ?? {};
    } catch {
      console.warn(`skip ${f}: no groundtruth at ${truthPath}`);
      continue;
    }
    const perWf = {};
    for (const wf of args.workflows) {
      console.log(`run ${wf} on ${f}…`);
      const { canonicalLayer, finalState } = await runWorkflow(wf, path.join(fixturesDir, f));
      const cmp = compareLayer(canonicalLayer, expected);
      perWf[wf] = { ...cmp, state: finalState };
      console.log(`  ${wf}: ${cmp.matched}/${cmp.total} = ${(cmp.recall * 100).toFixed(1)}%`);
    }
    rows.push({ file: f, perWorkflow: perWf, expectedCount: Object.keys(expected).length });
  }

  // Markdown-Report
  const lines = [];
  lines.push('# elster-v5_2-rag vs elster-v5_2 — Recall-Delta');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Fixtures: ${fixturesDir}`);
  lines.push(`Workflows: ${args.workflows.join(', ')}`);
  lines.push('');
  lines.push('| Datei | Pflicht-Felder | ' + args.workflows.map(w => `${w} (recall)`).join(' | ') + ' | Δ |');
  lines.push('|---|---|' + args.workflows.map(() => '---').join('|') + '|---|');
  let sumDelta = 0;
  for (const r of rows) {
    const a = r.perWorkflow[args.workflows[0]]?.recall ?? 0;
    const b = r.perWorkflow[args.workflows[1]]?.recall ?? 0;
    sumDelta += (b - a);
    lines.push(`| ${r.file} | ${r.expectedCount} | ` +
      args.workflows.map(w => `${(r.perWorkflow[w].recall * 100).toFixed(1)}%`).join(' | ') +
      ` | ${((b - a) * 100).toFixed(1)}pp |`);
  }
  lines.push('');
  lines.push(`**Mittleres Recall-Δ (v5_2-rag − v5_2):** ${((sumDelta / Math.max(1, rows.length)) * 100).toFixed(1)} pp`);
  lines.push('');
  lines.push('Misses-Details siehe `*.misses.json` neben diesem Report.');

  const outAbs = path.resolve(args.out);
  await mkdir(path.dirname(outAbs), { recursive: true });
  await writeFile(outAbs, lines.join('\n'), 'utf-8');
  await writeFile(outAbs.replace(/\.md$/, '.misses.json'), JSON.stringify(rows, null, 2), 'utf-8');
  console.log(`\nReport → ${outAbs}`);
}

main().catch(e => { console.error(e); process.exit(1); });
