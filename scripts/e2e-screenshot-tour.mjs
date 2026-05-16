#!/usr/bin/env node
/**
 * E2E-Screenshot-Tour: klickt durch alle sturm-UI-Routen, macht Screenshots,
 * loggt Console-Errors + 404s, schreibt Report.
 *
 *   node scripts/e2e-screenshot-tour.mjs --base http://localhost:7800
 *
 * Output: reports/screenshot-tour-<ts>/
 *   - *.png          (screenshots)
 *   - console.log    (console errors + warnings pro Route)
 *   - network.log    (failed requests + 4xx/5xx)
 *   - BUGS.md        (severity-sortierte Findings)
 */
import puppeteer from 'puppeteer-core';
import * as path from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const args = process.argv.slice(2);
let base = 'http://localhost:7800';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base') base = args[++i];
}
const outDir = path.join(REPO, `reports/screenshot-tour-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
await mkdir(outDir, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ROUTES = [
  { id: 'landing',       path: '/',                                                desc: 'Landing — Workflow-Übersicht' },
  { id: 'anwendungen',   path: '/anwendungen.html',                                desc: 'Anwendungen / Steuerfall' },
  { id: 'workspaces',    path: '/workspaces.html',                                 desc: 'Workspaces-Liste' },
  { id: 'studio-ocr',    path: '/studio-ocr.html',                                 desc: 'OCR Studio' },
  { id: 'designer',      path: '/designer.html',                                   desc: 'Workflow Designer' },
  { id: 'pipeline-v52rag', path: '/pipeline.html?workflow=elster-v5_2-rag',         desc: 'Pipeline elster-v5_2-rag DAG' },
  { id: 'pipeline-hello', path: '/pipeline.html?workflow=hello-ocr',                desc: 'Pipeline hello-ocr (minimal)' },
  { id: 'pipeline-shootout', path: '/pipeline.html?workflow=ocr-shootout',          desc: 'Pipeline ocr-shootout (4-OCR fanout)' },
  { id: 'steuerfall',    path: '/steuerfall.html',                                 desc: 'Steuerfall-Übersicht' },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=de-DE'],
  defaultViewport: { width: 1440, height: 900 },
});

const findings = []; // { route, type, severity, msg, screenshot }

function record(route, type, severity, msg, screenshot) {
  findings.push({ route: route.id, routePath: route.path, type, severity, msg, screenshot });
}

for (const route of ROUTES) {
  console.log(`\n→ ${route.id}: ${base}${route.path}`);
  const page = await browser.newPage();
  const consoleMessages = [];
  const networkFails = [];

  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') consoleMessages.push({ type: t, text: msg.text() });
  });
  page.on('pageerror', (e) => consoleMessages.push({ type: 'pageerror', text: String(e.message || e) }));
  page.on('requestfailed', (req) => networkFails.push({ url: req.url(), error: req.failure()?.errorText, method: req.method() }));
  page.on('response', (res) => {
    const st = res.status();
    if (st >= 400 && res.request().resourceType() !== 'image') {
      networkFails.push({ url: res.url(), status: st, method: res.request().method() });
    }
  });

  try {
    await page.goto(`${base}${route.path}`, { waitUntil: 'networkidle2', timeout: 15000 });
  } catch (e) {
    record(route, 'load', 'critical', `Page failed to load: ${e.message}`, null);
    await page.close();
    continue;
  }

  // wait a bit for late renders + lucide icons
  await new Promise((r) => setTimeout(r, 1500));

  const screenshotName = `${route.id}.png`;
  await page.screenshot({ path: path.join(outDir, screenshotName), fullPage: true });

  // Findings — console
  for (const m of consoleMessages) {
    let sev = 'low';
    if (m.type === 'error' || m.type === 'pageerror') sev = 'high';
    else if (m.type === 'warning') sev = 'medium';
    record(route, `console-${m.type}`, sev, m.text.slice(0, 300), screenshotName);
  }
  // Findings — network
  for (const n of networkFails) {
    const sev = n.status >= 500 ? 'high' : 'medium';
    record(route, 'network', sev, `${n.method || 'GET'} ${n.url} → ${n.status || n.error}`, screenshotName);
  }

  // Layout / visible-error probes
  try {
    const empty = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const sig = text.replace(/\s+/g, ' ').trim();
      // empty / "Not Found" / cannot GET / red error blocks
      if (sig.length < 50) return { reason: 'page-mostly-empty', length: sig.length };
      if (/Cannot GET|Not Found|404/i.test(sig.slice(0, 200))) return { reason: 'visible-404-text' };
      // common error-tone divs
      const errs = document.querySelectorAll('[data-state="error"], .error, .text-red-500, .text-red-600');
      if (errs.length > 0) return { reason: 'error-element', count: errs.length };
      return null;
    });
    if (empty) {
      record(route, 'visible', 'high', `Visible issue: ${JSON.stringify(empty)}`, screenshotName);
    }
  } catch { /* ignore */ }

  console.log(`   ${consoleMessages.length} console msgs, ${networkFails.length} network issues, screenshot=${screenshotName}`);
  await page.close();
}

await browser.close();

// ─── Write logs ───
await writeFile(path.join(outDir, 'findings.json'), JSON.stringify(findings, null, 2));

// Severity-Order
const BY_SEV = { critical: 0, high: 1, medium: 2, low: 3 };
findings.sort((a, b) => (BY_SEV[a.severity] - BY_SEV[b.severity]) || a.route.localeCompare(b.route));

const md = [];
md.push(`# UI E2E Screenshot-Tour — Bug-Report\n`);
md.push(`Datum: ${new Date().toISOString()}\nBase: ${base}\nRouten: ${ROUTES.length}\nFindings: ${findings.length}\n`);
md.push(`Screenshots im selben Ordner.\n`);

const sevs = ['critical', 'high', 'medium', 'low'];
for (const sev of sevs) {
  const rows = findings.filter((f) => f.severity === sev);
  if (rows.length === 0) continue;
  const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[sev];
  md.push(`\n## ${icon} ${sev.toUpperCase()} (${rows.length})\n`);
  for (const r of rows) {
    md.push(`- **[${r.route}](./${r.screenshot})** \`${r.routePath}\` — ${r.type}`);
    md.push(`  ${r.msg}`);
  }
}
md.push(`\n---\n## Alle Routen (Screenshot-Index)\n`);
for (const r of ROUTES) {
  md.push(`- [${r.id}](./${r.id}.png) — ${r.desc} (\`${r.path}\`)`);
}
await writeFile(path.join(outDir, 'BUGS.md'), md.join('\n'));

console.log(`\n══════════════════════════════════════════════`);
console.log(`Tour complete. ${ROUTES.length} routes, ${findings.length} findings.`);
console.log(`Output: ${outDir}/BUGS.md`);
