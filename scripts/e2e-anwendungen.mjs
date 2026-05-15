#!/usr/bin/env node
/**
 * scripts/e2e-anwendungen.mjs
 *
 * Vollständiger Headless-Browser-E2E der "Anwendungen"-Pipeline:
 *
 *   1. /anwendungen.html öffnen
 *   2. "Neuer Fall" Modal → submit
 *   3. Redirect zu /steuerfall.html validieren
 *   4. Test-Dokument hochladen, SSE-Stream konsumieren
 *   5. canonical_layer-Tabelle prüfen
 *   6. "Versiegeln" klicken
 *   7. "An ELSTER senden" klicken
 *   8. Bei jedem Schritt Screenshot + JSON-Log; finaler Markdown-Report.
 *
 * Aufruf:
 *   node scripts/e2e-anwendungen.mjs \
 *     --base https://sturm.0711.io \
 *     --fixture ./runs/elster-v5_1/mp3wk06p-uagm9y/_input/VAST_Belege_Stricker.pdf \
 *     --out ./reports/anwendungen-e2e-<ts>
 */

import puppeteer from 'puppeteer-core';
import { mkdir, writeFile, copyFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = {
    base: 'https://sturm.0711.io',
    fixture: path.join(REPO, 'runs/elster-v5_1/mp3wk06p-uagm9y/_input/VAST_Belege_Stricker.pdf'),
    out: path.join(REPO, `reports/anwendungen-e2e-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`),
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    waitMs: 180000, // 3min für Extraktion
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--fixture') out.fixture = path.resolve(argv[++i]);
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--chrome') out.chrome = argv[++i];
    else if (a === '--headed') out.headless = false;
    else if (a === '--wait') out.waitMs = Number(argv[++i]);
  }
  return out;
}

// ─── Logger ─────────────────────────────────────────────────────────────
class StepLog {
  constructor(outDir) {
    this.outDir = outDir;
    this.steps = [];
    this.consoleMsgs = [];
    this.networkErrors = [];
    this.startedAt = new Date().toISOString();
  }
  async begin(name, descr) {
    const stepIdx = this.steps.length + 1;
    const step = {
      idx: stepIdx,
      name,
      descr,
      startedAt: new Date().toISOString(),
      events: [],
      screenshots: [],
      status: 'running',
      error: null,
    };
    this.steps.push(step);
    console.log(`\n━━━ Step ${stepIdx}: ${name} ━━━`);
    if (descr) console.log(`    ${descr}`);
    return step;
  }
  log(step, msg, payload) {
    const ts = new Date().toISOString();
    const ev = { ts, msg, ...(payload !== undefined ? { payload } : {}) };
    step.events.push(ev);
    console.log(`  [${ts.slice(11, 19)}] ${msg}`, payload ?? '');
  }
  async screenshot(step, page, label) {
    const file = `step-${String(step.idx).padStart(2, '0')}-${label}.png`;
    const full = path.join(this.outDir, file);
    try {
      await page.screenshot({ path: full, fullPage: true });
      step.screenshots.push({ label, file });
      this.log(step, `screenshot → ${file}`);
    } catch (e) {
      this.log(step, `screenshot failed: ${(e && e.message) || e}`);
    }
  }
  finish(step, status, error) {
    step.status = status;
    step.finishedAt = new Date().toISOString();
    if (error) step.error = String(error?.message || error);
    console.log(`  → ${status}${error ? ` · ${step.error}` : ''}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────
async function waitFor(page, predicate, opts = {}) {
  const timeout = opts.timeout ?? 30000;
  const interval = opts.interval ?? 250;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  console.log(`E2E target:  ${args.base}`);
  console.log(`Fixture:     ${args.fixture}`);
  console.log(`Output:      ${args.out}`);

  // Fixture vorhanden?
  try {
    const st = await stat(args.fixture);
    if (!st.isFile()) throw new Error('not a file');
  } catch (e) {
    console.error(`❌ Fixture not readable: ${args.fixture}`);
    process.exit(1);
  }

  const log = new StepLog(args.out);
  const browser = await puppeteer.launch({
    executablePath: args.chrome,
    headless: args.headless,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  // Console + Network logging
  page.on('console', (m) => {
    log.consoleMsgs.push({ ts: new Date().toISOString(), type: m.type(), text: m.text() });
  });
  page.on('pageerror', (e) => {
    log.consoleMsgs.push({ ts: new Date().toISOString(), type: 'pageerror', text: String(e?.message || e) });
  });
  page.on('requestfailed', (req) => {
    log.networkErrors.push({
      ts: new Date().toISOString(),
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText,
    });
  });
  page.on('response', async (resp) => {
    const status = resp.status();
    const url = resp.url();
    if (status >= 400 && url.includes('/api/')) {
      let body = '';
      try { body = (await resp.text()).slice(0, 400); } catch {}
      log.networkErrors.push({
        ts: new Date().toISOString(),
        url, method: resp.request().method(), status, body,
      });
    }
  });

  let createdCaseId = null;

  try {
    // ── Step 1: /anwendungen.html laden ─────────────────────────────────
    {
      const s = await log.begin('open-anwendungen', 'GET /anwendungen.html');
      try {
        await page.goto(`${args.base}/anwendungen.html`, { waitUntil: 'networkidle2', timeout: 30000 });
        await log.screenshot(s, page, 'loaded');
        const hasSection = await page.$('.app-section, .empty');
        if (!hasSection) throw new Error('No .app-section or .empty found — page incomplete');
        const appCount = await page.evaluate(() => document.querySelectorAll('.app-section').length);
        log.log(s, `App-Sections gerendert: ${appCount}`);
        log.finish(s, 'ok');
      } catch (e) {
        await log.screenshot(s, page, 'failure');
        log.finish(s, 'fail', e);
      }
    }

    // ── Step 2: Neuer Fall Modal ────────────────────────────────────────
    {
      const s = await log.begin('open-new-case-modal', 'Click "Neuer Fall" button');
      try {
        const btn = await page.$('[data-action="new-case"]');
        if (!btn) throw new Error('No "Neuer Fall" button found');
        await btn.click();
        await waitFor(page, () => page.evaluate(() => !!document.querySelector('#create-modal.open')), { timeout: 5000 });
        await log.screenshot(s, page, 'modal-open');
        log.finish(s, 'ok');
      } catch (e) {
        await log.screenshot(s, page, 'failure');
        log.finish(s, 'fail', e);
      }
    }

    // ── Step 3: Fall erstellen ──────────────────────────────────────────
    {
      const s = await log.begin('create-case', 'Fill modal + submit POST /api/applications/.../instances');
      try {
        await page.evaluate(() => {
          document.getElementById('m-display').value = '';
          document.getElementById('m-mandant').value = '';
        });
        const fallName = `E2E ${new Date().toISOString().slice(0, 19)}`;
        await page.type('#m-display', fallName, { delay: 10 });
        await page.type('#m-mandant', 'e2e-test', { delay: 10 });
        await log.screenshot(s, page, 'filled');

        // Catch the case-create response so we can validate the redirect
        const respPromise = page.waitForResponse(
          (r) => r.url().includes('/api/applications/') && r.url().endsWith('/instances') && r.request().method() === 'POST',
          { timeout: 15000 },
        );
        await page.click('#m-create');
        const resp = await respPromise;
        const status = resp.status();
        let body = null;
        try { body = await resp.json(); } catch {}
        log.log(s, `POST instances → ${status}`, body);
        if (status !== 201) throw new Error(`expected 201, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
        createdCaseId = body?.caseId;
        // Wait for navigation to /steuerfall.html
        await waitFor(page, () => page.url().includes('/steuerfall.html'), { timeout: 15000 });
        log.log(s, `redirected → ${page.url()}`);
        // Fallback: wenn body.caseId nicht ankam (race), aus der URL ziehen.
        if (!createdCaseId) {
          const u = new URL(page.url());
          createdCaseId = u.searchParams.get('case');
          log.log(s, `caseId fallback aus URL: ${createdCaseId}`);
        }
        if (!createdCaseId) throw new Error('caseId not in response and not in redirect URL');
        log.finish(s, 'ok');
      } catch (e) {
        await log.screenshot(s, page, 'failure');
        log.finish(s, 'fail', e);
      }
    }

    // ── Step 4: /steuerfall.html geladen ────────────────────────────────
    {
      const s = await log.begin('steuerfall-loaded', 'Verify /steuerfall.html rendered with case data');
      try {
        await waitFor(page, () => page.evaluate(() => {
          const t = document.getElementById('case-display')?.textContent || '';
          return t && t !== '…' && !t.includes('nicht gefunden');
        }), { timeout: 10000 });
        await log.screenshot(s, page, 'loaded');
        const title = await page.$eval('#case-display', e => e.textContent.trim());
        const meta = await page.$eval('#case-meta', e => e.textContent.trim());
        log.log(s, `case-display: ${title}`);
        log.log(s, `case-meta:    ${meta}`);
        const dropPresent = await page.$('#drop');
        if (!dropPresent) throw new Error('upload drop zone not present');
        log.finish(s, 'ok');
      } catch (e) {
        await log.screenshot(s, page, 'failure');
        log.finish(s, 'fail', e);
      }
    }

    // ── Step 5: Dokument hochladen + SSE-Stream konsumieren ────────────
    {
      const s = await log.begin('upload-and-extract', `Upload ${path.basename(args.fixture)} → SSE`);
      try {
        // Copy fixture to /tmp to ensure no permission/symlink issues
        const tmpCopy = path.join('/tmp', `e2e-${Date.now()}-${path.basename(args.fixture)}`);
        await copyFile(args.fixture, tmpCopy);
        const fileInput = await page.$('#file');
        if (!fileInput) throw new Error('#file input missing');
        await fileInput.uploadFile(tmpCopy);
        log.log(s, `file selected: ${tmpCopy}`);
        await log.screenshot(s, page, 'uploading-start');
        // Warte, bis Drop-Result fertig signalisiert (✓ oder ✕) — bis zu waitMs
        const done = await waitFor(page, () => page.evaluate(() => {
          const r = document.getElementById('drop-result');
          if (!r || r.hidden) return false;
          return /^(✓|✕|⚠)/.test(r.textContent || '');
        }), { timeout: args.waitMs, interval: 500 });
        await log.screenshot(s, page, 'after-upload');
        if (!done) throw new Error(`extraction did not finish within ${args.waitMs}ms`);
        const resultText = await page.$eval('#drop-result', e => e.textContent.trim());
        log.log(s, `drop-result: ${resultText}`);
        if (resultText.startsWith('✕')) throw new Error(`extraction failed: ${resultText}`);
        // Sammle die letzten SSE-Events aus dem Events-Panel
        const events = await page.$eval('#events', e => e.textContent.trim().split('\n').slice(-20).join('\n'));
        log.log(s, `last events:\n${events}`);
        log.finish(s, 'ok');
      } catch (e) {
        await log.screenshot(s, page, 'failure');
        log.finish(s, 'fail', e);
      }
    }

    // ── Step 6: canonical_layer Tabelle prüfen ─────────────────────────
    {
      const s = await log.begin('verify-canonical-layer', 'Result table rendered with ≥1 row');
      try {
        const hasRows = await waitFor(page, () => page.evaluate(() => {
          const tbody = document.getElementById('layer-rows');
          return tbody && tbody.querySelectorAll('tr').length > 0;
        }), { timeout: 15000 });
        await log.screenshot(s, page, 'layer');
        if (!hasRows) throw new Error('layer-rows tbody empty');
        const rowCount = await page.evaluate(() => document.querySelectorAll('#layer-rows tr').length);
        const layerSub = await page.$eval('#layer-sub', e => e.textContent.trim()).catch(() => '');
        log.log(s, `layer rows: ${rowCount}`);
        log.log(s, `layer-sub:  ${layerSub}`);
        // GET /result direkt — Statistik
        const stats = await page.evaluate(async (caseId) => {
          const r = await fetch(`/api/applications/steuerfall-est/instances/${encodeURIComponent(caseId)}/result`);
          return r.ok ? r.json() : null;
        }, createdCaseId);
        log.log(s, 'GET /result stats', stats?.stats);
        log.finish(s, 'ok');
      } catch (e) {
        await log.screenshot(s, page, 'failure');
        log.finish(s, 'fail', e);
      }
    }

    // ── Step 7: Versiegeln ─────────────────────────────────────────────
    {
      const s = await log.begin('seal', 'Click "Versiegeln" → steuerfall-seal workflow');
      try {
        const sealBtn = await page.$('#btn-seal');
        if (!sealBtn) throw new Error('#btn-seal not found');
        // Override window.alert so the test doesn't block
        await page.evaluate(() => {
          window.__alerts = [];
          window.alert = (msg) => { window.__alerts.push(String(msg)); };
        });
        const isDisabled = await page.evaluate(() => document.getElementById('btn-seal').disabled);
        log.log(s, `btn-seal disabled? ${isDisabled}`);
        if (isDisabled) {
          await log.screenshot(s, page, 'seal-disabled');
          throw new Error('seal button still disabled — extraction not eligible');
        }
        const respPromise = page.waitForResponse(
          (r) => r.url().includes('/seal') && r.request().method() === 'POST',
          { timeout: 30000 },
        );
        await sealBtn.click();
        const resp = await respPromise;
        log.log(s, `POST /seal → ${resp.status()}`);
        // Wait briefly for alert + status reload
        await new Promise(r => setTimeout(r, 2500));
        await log.screenshot(s, page, 'after-seal');
        const alerts = await page.evaluate(() => window.__alerts || []);
        log.log(s, 'alerts captured', alerts);
        const statusAfter = await page.$eval('#case-meta', e => e.textContent.trim());
        log.log(s, `case-meta after seal: ${statusAfter}`);
        log.finish(s, resp.status() === 200 ? 'ok' : 'fail', resp.status() !== 200 ? `HTTP ${resp.status()}` : null);
      } catch (e) {
        await log.screenshot(s, page, 'failure');
        log.finish(s, 'fail', e);
      }
    }

    // ── Step 8: An ELSTER senden ───────────────────────────────────────
    {
      const s = await log.begin('export', 'Click "An ELSTER" → Lane-5 MCP (Stub erwartet)');
      try {
        const exportBtn = await page.$('#btn-export');
        if (!exportBtn) throw new Error('#btn-export not found');
        await page.evaluate(() => { window.__alerts = []; });
        const isDisabled = await page.evaluate(() => document.getElementById('btn-export').disabled);
        log.log(s, `btn-export disabled? ${isDisabled}`);
        if (isDisabled) {
          await log.screenshot(s, page, 'export-disabled');
          // Nicht fatal — wenn Versiegelung in Schritt 7 fehlschlug, Export wäre disabled
          log.finish(s, 'skip', 'export disabled (seal did not complete)');
        } else {
          const respPromise = page.waitForResponse(
            (r) => r.url().includes('/export') && r.request().method() === 'POST',
            { timeout: 30000 },
          );
          await exportBtn.click();
          const resp = await respPromise;
          const body = await resp.json().catch(() => null);
          log.log(s, `POST /export → ${resp.status()}`, body);
          await new Promise(r => setTimeout(r, 1500));
          await log.screenshot(s, page, 'after-export');
          // 503 + reason 'mcp-unavailable' ist der erwartete Stub-Zustand.
          const expected = body?.reason === 'mcp-unavailable';
          log.finish(s, expected || resp.status() === 200 ? 'ok' : 'fail',
            !expected && resp.status() !== 200 ? `unexpected: HTTP ${resp.status()}, body ${JSON.stringify(body).slice(0, 200)}` : null);
        }
      } catch (e) {
        await log.screenshot(s, page, 'failure');
        log.finish(s, 'fail', e);
      }
    }

  } finally {
    await browser.close();
  }

  // ─── Final Report ────────────────────────────────────────────────────
  const okCount = log.steps.filter(s => s.status === 'ok').length;
  const failCount = log.steps.filter(s => s.status === 'fail').length;
  const skipCount = log.steps.filter(s => s.status === 'skip').length;

  const report = [];
  report.push(`# E2E Anwendungen — Fehlerreport`);
  report.push('');
  report.push(`**Datum:** ${log.startedAt}`);
  report.push(`**Target:** ${args.base}`);
  report.push(`**Fixture:** ${path.basename(args.fixture)}`);
  report.push(`**Case-ID:** ${createdCaseId ?? '(nicht erstellt)'}`);
  report.push('');
  report.push(`## Zusammenfassung`);
  report.push('');
  report.push(`- ✅ OK:   **${okCount}**`);
  report.push(`- ❌ Fail: **${failCount}**`);
  report.push(`- ⏭ Skip: **${skipCount}**`);
  report.push('');
  report.push(`| # | Schritt | Status | Fehler |`);
  report.push(`|---|---|---|---|`);
  for (const s of log.steps) {
    const ico = s.status === 'ok' ? '✅' : s.status === 'fail' ? '❌' : '⏭';
    report.push(`| ${s.idx} | ${s.name} | ${ico} ${s.status} | ${s.error ?? ''} |`);
  }
  report.push('');

  for (const s of log.steps) {
    const ico = s.status === 'ok' ? '✅' : s.status === 'fail' ? '❌' : '⏭';
    report.push(`---`);
    report.push('');
    report.push(`## ${ico} Step ${s.idx}: ${s.name}`);
    if (s.descr) report.push(`*${s.descr}*`);
    report.push('');
    report.push(`- **Status:** ${s.status}`);
    report.push(`- **Started:** ${s.startedAt}`);
    if (s.finishedAt) report.push(`- **Finished:** ${s.finishedAt}`);
    if (s.error) report.push(`- **Fehler:** \`${s.error}\``);
    report.push('');
    if (s.screenshots.length > 0) {
      report.push(`### Screenshots`);
      report.push('');
      for (const sc of s.screenshots) {
        report.push(`**${sc.label}**`);
        report.push('');
        report.push(`![${sc.label}](./${sc.file})`);
        report.push('');
      }
    }
    if (s.events.length > 0) {
      report.push(`### Log`);
      report.push('');
      report.push('```');
      for (const ev of s.events) {
        report.push(`[${ev.ts.slice(11, 19)}] ${ev.msg}${ev.payload !== undefined ? '  ' + JSON.stringify(ev.payload) : ''}`);
      }
      report.push('```');
      report.push('');
    }
  }

  if (log.networkErrors.length > 0) {
    report.push(`---`);
    report.push('');
    report.push(`## Netzwerk-Fehler (Status ≥ 400)`);
    report.push('');
    report.push('```');
    for (const ne of log.networkErrors) {
      report.push(`[${ne.ts.slice(11, 19)}] ${ne.method || '?'} ${ne.url} → ${ne.status ?? ne.failure ?? '?'}`);
      if (ne.body) report.push(`  body: ${ne.body}`);
    }
    report.push('```');
    report.push('');
  }
  if (log.consoleMsgs.length > 0) {
    const sev = log.consoleMsgs.filter(m => m.type === 'error' || m.type === 'pageerror' || m.type === 'warning');
    if (sev.length > 0) {
      report.push(`## Console (errors + warnings)`);
      report.push('');
      report.push('```');
      for (const m of sev.slice(-50)) {
        report.push(`[${m.ts.slice(11, 19)}] ${m.type.toUpperCase()} ${m.text}`);
      }
      report.push('```');
    }
  }

  const reportPath = path.join(args.out, 'report.md');
  await writeFile(reportPath, report.join('\n'), 'utf-8');
  await writeFile(
    path.join(args.out, 'raw.json'),
    JSON.stringify({ args, log: { ...log, outDir: undefined } }, null, 2),
    'utf-8',
  );
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`Report:       ${reportPath}`);
  console.log(`OK:           ${okCount}`);
  console.log(`Fail:         ${failCount}`);
  console.log(`Skip:         ${skipCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => { console.error('E2E aborted:', e); process.exit(2); });
