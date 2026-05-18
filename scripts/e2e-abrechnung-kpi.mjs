#!/usr/bin/env node
/**
 * scripts/e2e-abrechnung-kpi.mjs
 *
 * Generischer E2E-Test der vollen Mandanten-Pipeline:
 *   Login → Case-Anlage → Bulk-Upload (drag&drop via UI) →
 *   Pipeline-warten → Abrechnung-Tab → KPI-Audit.
 *
 * KPIs (alle generisch, keine Fall-spezifischen Werte):
 *   K1  upload_success_rate          100% Dateien im Manifest
 *   K2  classification_non_empty     ≥1 Anlage pro nicht-meta-doc
 *   K3  bmf_compute_success          bmf.erfolg=true ∧ zvE>0 ∧ ESt>0
 *   K4  eric_xml_min_size            > 5000 chars
 *   K5  ui_console_errors            0 Errors auf /abrechnung Tab
 *   K6  abrechnung_sections          ≥6 h2/h3 Sektionen sichtbar
 *   K7  wallclock_under_threshold    < waitMs (default 5min)
 *   K8  expected_anlagen_match       wenn --expected JSON: jeder Doc enthält
 *                                    seine erwarteten Anlagen
 *
 * Aufruf:
 *   STURM_TEST_PASSWORD=… node scripts/e2e-abrechnung-kpi.mjs \
 *     --base https://ctax.0711.io \
 *     --email user@example.com \
 *     --fixtures ./path/to/files/ \
 *     [--expected ./path/to/expected.json] \
 *     [--workflow elster-v6-vision] \
 *     [--out reports/abrechnung-kpi-<ts>] \
 *     [--headed]
 *
 * Sidecar-Format (expected.json, optional):
 *   { "<filename>": { "expectedAnlagen": ["N","VOR"] }, ... }
 *
 * Keine Hardcoded-Werte. Alle Eingaben über CLI/Env. Reports nach --out.
 */
import puppeteer from 'puppeteer-core';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ─── CLI ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    base: 'https://ctax.0711.io',
    email: '',
    password: process.env.STURM_TEST_PASSWORD ?? '',
    fixtures: '',
    expected: '',
    workflow: '',
    caseName: '',
    jahr: 2024,
    out: '',
    chrome: process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome',
    headless: true,
    waitMs: 300_000, // 5 min default
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--fixtures') out.fixtures = path.resolve(argv[++i]);
    else if (a === '--expected') out.expected = path.resolve(argv[++i]);
    else if (a === '--workflow') out.workflow = argv[++i];
    else if (a === '--case-name') out.caseName = argv[++i];
    else if (a === '--jahr') out.jahr = Number(argv[++i]);
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--chrome') out.chrome = argv[++i];
    else if (a === '--headed') out.headless = false;
    else if (a === '--wait') out.waitMs = Number(argv[++i]);
  }
  if (!out.email) throw new Error('--email required');
  if (!out.password) throw new Error('--password (or STURM_TEST_PASSWORD env) required');
  if (!out.fixtures) throw new Error('--fixtures <directory> required');
  if (!out.out) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    out.out = path.join(REPO, `reports/abrechnung-kpi-${ts}`);
  }
  return out;
}

// ─── Logger ─────────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }
function ts() { return nowIso().slice(11, 19); }
function log(msg, payload) {
  if (payload !== undefined) console.log(`[${ts()}] ${msg}`, payload);
  else console.log(`[${ts()}] ${msg}`);
}

// ─── Fixture discovery ─────────────────────────────────────────────────
async function discoverFixtures(dir) {
  const entries = await readdir(dir);
  const out = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (name === 'expected.json') continue;
    const abs = path.join(dir, name);
    const st = await stat(abs);
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (!['.pdf', '.jpg', '.jpeg', '.png', '.webp'].includes(ext)) continue;
    out.push({ name, abs, size: st.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function loadExpected(file) {
  if (!file) return null;
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── KPI evaluator ─────────────────────────────────────────────────────
function evalKpis({ fixtures, manifestDocs, master, expected, consoleErrors, sections, wallclockMs, waitMs }) {
  const k1 = {
    id: 'K1', label: 'upload_success_rate',
    expected: '100%',
    actual: `${manifestDocs.length}/${fixtures.length}`,
    pass: manifestDocs.length === fixtures.length,
  };
  // K2: every non-meta doc has ≥1 anlage (or BMF would be empty)
  const nonMetaDocs = manifestDocs.filter((d) => !d.metaDoc);
  const withAnlage = nonMetaDocs.filter((d) => Array.isArray(d.anlagen) && d.anlagen.length > 0);
  const k2 = {
    id: 'K2', label: 'classification_non_empty',
    expected: '100%',
    actual: `${withAnlage.length}/${nonMetaDocs.length}`,
    pass: nonMetaDocs.length === 0 || withAnlage.length === nonMetaDocs.length,
  };
  const bmfDaten = (master?.bmf?.daten) ?? {};
  const bmfOk = master?.bmf?.erfolg === true
    && Number(bmfDaten.zve ?? 0) > 0
    && Number(bmfDaten.einkommensteuer ?? 0) > 0;
  const k3 = {
    id: 'K3', label: 'bmf_compute_success',
    expected: 'erfolg=true ∧ zvE>0 ∧ ESt>0',
    actual: `erfolg=${master?.bmf?.erfolg} zvE=${bmfDaten.zve} ESt=${bmfDaten.einkommensteuer}`,
    pass: bmfOk,
  };
  const ericLen = (master?.eric_xml ?? '').length;
  const k4 = {
    id: 'K4', label: 'eric_xml_min_size',
    expected: '> 5000 chars',
    actual: `${ericLen} chars`,
    pass: ericLen > 5000,
  };
  const k5 = {
    id: 'K5', label: 'ui_console_errors',
    expected: '0',
    actual: `${consoleErrors.length}`,
    pass: consoleErrors.length === 0,
  };
  const k6 = {
    id: 'K6', label: 'abrechnung_sections',
    expected: '≥6',
    actual: `${sections}`,
    pass: sections >= 6,
  };
  const k7 = {
    id: 'K7', label: 'wallclock_under_threshold',
    expected: `< ${waitMs}ms`,
    actual: `${wallclockMs}ms`,
    pass: wallclockMs < waitMs,
  };
  // K8 only if --expected sidecar provided
  let k8 = null;
  if (expected && typeof expected === 'object') {
    const violations = [];
    for (const doc of manifestDocs) {
      const exp = expected[doc.filename];
      if (!exp) continue;
      const expectedAnlagen = Array.isArray(exp.expectedAnlagen) ? exp.expectedAnlagen : [];
      const got = new Set((doc.anlagen ?? []).map(String));
      const missing = expectedAnlagen.filter((a) => !got.has(a));
      if (missing.length > 0) {
        violations.push({ doc: doc.filename, expected: expectedAnlagen, got: [...got], missing });
      }
    }
    k8 = {
      id: 'K8', label: 'expected_anlagen_match',
      expected: 'every doc matches its sidecar expectedAnlagen',
      actual: violations.length === 0 ? 'all match' : `${violations.length} violation(s)`,
      pass: violations.length === 0,
      violations,
    };
  }
  const kpis = [k1, k2, k3, k4, k5, k6, k7, ...(k8 ? [k8] : [])];
  const passed = kpis.filter((k) => k.pass).length;
  return { kpis, passed, total: kpis.length, allPass: passed === kpis.length };
}

// ─── Helpers ────────────────────────────────────────────────────────────
async function waitFor(predicate, { timeoutMs = 60_000, intervalMs = 1000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await predicate();
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for ${label}`);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const reportFile = path.join(args.out, 'kpi-result.json');
  const masterFile = path.join(args.out, 'master.json');
  const consoleFile = path.join(args.out, 'console-errors.txt');
  const screenshotsDir = path.join(args.out, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });

  const t0 = Date.now();
  log('=== E2E Abrechnung KPI ===');
  log('base', args.base);
  log('fixtures', args.fixtures);
  log('out', args.out);

  const fixtures = await discoverFixtures(args.fixtures);
  if (fixtures.length === 0) throw new Error(`no fixture files (.pdf/.jpg/.jpeg/.png/.webp) in ${args.fixtures}`);
  log(`discovered ${fixtures.length} fixture files`);
  for (const f of fixtures) log(`  - ${f.name} (${f.size} bytes)`);

  const expected = await loadExpected(args.expected);
  if (expected) log(`loaded expected.json: ${Object.keys(expected).length} entries`);

  const browser = await puppeteer.launch({
    executablePath: args.chrome,
    headless: args.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const line = `[${nowIso()}] ${msg.text()}`;
      consoleErrors.push(line);
      log(`  [console.error] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    const line = `[${nowIso()}] ${err.message}`;
    consoleErrors.push(line);
    log(`  [pageerror] ${err.message}`);
  });

  // ── 1. Login via UI ──────────────────────────────────────────────────
  log('Step 1: login');
  await page.goto(`${args.base}/m/login`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.type('#email', args.email, { delay: 10 });
  await page.type('#password', args.password, { delay: 10 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
    page.click('#submitBtn'),
  ]);
  await page.screenshot({ path: path.join(screenshotsDir, '01-dashboard.png'), fullPage: true });
  log('  logged in');

  // ── 2. Case anlegen (POST via page's session, robuster als waitForResponse) ─
  log('Step 2: create case');
  const caseName = args.caseName || `E2E ${new Date().toISOString().slice(0, 19)}`;
  const caseData = await page.evaluate(async ({ name, jahr }) => {
    const r = await fetch('/api/m/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ displayName: name, veranlagungsjahr: jahr }),
    });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, body };
  }, { name: caseName, jahr: args.jahr });
  if (caseData.status !== 200 && caseData.status !== 201) {
    throw new Error(`case create HTTP ${caseData.status}: ${JSON.stringify(caseData.body).slice(0, 200)}`);
  }
  const caseId = caseData.body?.caseId;
  if (!caseId) throw new Error(`case create no caseId: ${JSON.stringify(caseData.body)}`);
  log(`  caseId=${caseId}`);

  // ── 3. Navigate to case page ─────────────────────────────────────────
  log('Step 3: open case');
  await page.goto(`${args.base}/m/case/${encodeURIComponent(caseId)}`, {
    waitUntil: 'networkidle2', timeout: 30000,
  });
  await page.screenshot({ path: path.join(screenshotsDir, '02-case-opened.png'), fullPage: true });

  // ── 4. Upload all fixtures via the file input ────────────────────────
  log('Step 4: upload fixtures');
  const fileInput = await page.$('#file-input');
  if (!fileInput) throw new Error('no #file-input on m-case page');
  await fileInput.uploadFile(...fixtures.map((f) => f.abs));
  log(`  uploaded ${fixtures.length} files; waiting for processing…`);

  // ── 5. Wait for all docs to reach a terminal state ───────────────────
  // Polling master endpoint, since SSE-stream from UI is hard to introspect
  // outside the browser. The master is refreshed by the upload handler after
  // each doc completes.
  const masterUrl = `${args.base}/api/applications/steuerfall-est/instances/${encodeURIComponent(caseId)}/master?refresh=1`;
  const sessionCookie = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  let master = null;
  const startWait = Date.now();
  await waitFor(async () => {
    try {
      const r = await fetch(masterUrl, { headers: { cookie: sessionCookie } });
      if (!r.ok) return false;
      master = await r.json();
      const docs = master?.documents ?? [];
      // Consider complete when count matches AND fields present (or none expected meta-only)
      return docs.length >= fixtures.length;
    } catch {
      return false;
    }
  }, { timeoutMs: args.waitMs, intervalMs: 3000, label: 'all docs in master' });
  log(`  master ready after ${Date.now() - startWait}ms · ${master?.documents?.length ?? 0} docs · ${Object.keys(master?.merged_layer ?? {}).length} fields`);
  await writeFile(masterFile, JSON.stringify(master, null, 2));

  // ── 6. Open Abrechnung tab + measure render ──────────────────────────
  log('Step 6: open Abrechnung tab');
  consoleErrors.length = 0; // reset — count only Abrechnung errors
  await page.evaluate(() => {
    location.hash = '#abrechnung';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  // Wait for the iframe to load
  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(screenshotsDir, '03-abrechnung-tab.png'), fullPage: true });
  // Count h2 + h3 inside the iframe
  let sections = 0;
  try {
    const frame = page.frames().find((f) => f.url().includes('/abrechnung.html'));
    if (frame) {
      await frame.waitForSelector('h2, h3', { timeout: 30_000 }).catch(() => {});
      sections = await frame.evaluate(() => document.querySelectorAll('h2, h3').length);
    }
  } catch (e) {
    log(`  frame inspection failed: ${e.message}`);
  }
  log(`  abrechnung sections: ${sections}, console errors: ${consoleErrors.length}`);

  // ── 7. Build per-doc summary (with meta-doc flag) ────────────────────
  const manifestDocs = (master?.documents ?? []).map((d) => ({
    filename: d.filename,
    anlagen: d.anlagen ?? [],
    fields: d.fieldsExtracted ?? 0,
    metaDoc: (d.anlagen ?? []).length === 0 && d.fieldsExtracted === 0,
  }));

  // ── 8. Evaluate KPIs ─────────────────────────────────────────────────
  const wallclockMs = Date.now() - t0;
  const result = evalKpis({
    fixtures, manifestDocs, master, expected,
    consoleErrors, sections, wallclockMs, waitMs: args.waitMs,
  });

  await writeFile(consoleFile, consoleErrors.join('\n') + '\n');
  await writeFile(reportFile, JSON.stringify({
    runAt: nowIso(),
    args: { base: args.base, fixtures: args.fixtures, expected: args.expected, workflow: args.workflow, caseId, caseName },
    wallclockMs,
    fixtures: fixtures.map((f) => ({ name: f.name, size: f.size })),
    manifestDocs,
    kpis: result.kpis,
    summary: { passed: result.passed, total: result.total, allPass: result.allPass },
  }, null, 2));

  // ── 9. Steuerrechnung-Audit (Diagnostics) ────────────────────────────
  // Diese Sektion zeigt die BMF-Rechenschritte + heuristische
  // Sanity-Checks. KEINE harten Assertions auf Werte (Fall-agnostisch),
  // aber Flags die häufige Rechenfehler markieren.
  const audit = {
    veranlagungsjahr: master?.jahr ?? args.jahr,
    bmf_erfolg: master?.bmf?.erfolg ?? null,
    rechenschritte: (master?.bmf?.daten?.berechnungsdetails?.rechenschritte ?? []).map((s) => ({
      schritt: s.schritt, bezeichnung: s.bezeichnung, wert: s.wert, ecode: s.ecode ?? null,
    })),
    steuer: {
      zve: master?.bmf?.daten?.zve ?? null,
      einkommensteuer: master?.bmf?.daten?.einkommensteuer ?? null,
      soli: master?.bmf?.daten?.solidaritaetszuschlag ?? null,
      gesamtsteuer: master?.bmf?.daten?.gesamtsteuer ?? null,
      vorauszahlungen: master?.bmf?.daten?.steuervorauszahlungen ?? null,
      ergebnis: master?.bmf?.daten?.erstattung_oder_nachzahlung ?? null,
      grenzsteuersatz: master?.bmf?.daten?.grenzsteuersatz ?? null,
      durchschnittssteuersatz: master?.bmf?.daten?.durchschnittssteuersatz ?? null,
    },
    tarif: master?.bmf?.daten?.berechnungsdetails?.steuer_berechnung ?? null,
    soli_berechnung: master?.bmf?.daten?.berechnungsdetails?.soli_berechnung ?? null,
    vorauszahlungen_detail: master?.bmf?.daten?.berechnungsdetails?.vorauszahlungen ?? null,
    eingabewerte: master?.bmf?.daten?.berechnungsdetails?.eingabewerte ?? null,
    flags: {},
  };
  // Heuristische Diagnostik
  const ev = audit.eingabewerte ?? {};
  audit.flags.splittingtarif_active = ev.ehegattensplitting === true;
  audit.flags.berechnungsmethode = audit.tarif?.berechnungsmethode ?? '?';
  audit.flags.vorsorge_total_gt_zero = (Number(ev.vorsorgeaufwendungen_absetzbar ?? 0) > 0);
  audit.flags.werbungskosten_gt_zero = (Number(ev.werbungskosten ?? 0) > 0);
  audit.flags.kapitalertraege_present = (Number(ev.kapitalertraege ?? 0) > 0);
  audit.flags.kirchensteuer_gezahlt_gt_zero = (Number(ev.kirchensteuer_sa ?? 0) > 0);
  audit.flags.tax_formula = audit.tarif?.formel_verwendet ?? '?';
  audit.flags.soli_freigrenze = audit.soli_berechnung?.freigrenze ?? '?';
  audit.flags.soli_unter_freigrenze = (Number(audit.steuer.soli ?? 0) === 0);
  // Bilanz-Indikator
  const ergebnis = Number(audit.steuer.ergebnis ?? 0);
  audit.flags.bilanz = ergebnis > 0 ? 'Erstattung' : (ergebnis < 0 ? 'Nachzahlung' : 'Null');
  audit.flags.bilanz_betrag = Math.abs(ergebnis);
  // Tarif-Sanity: bei Splitting muss formel "* 2 (Ehegattensplitting)" enthalten
  const formel = String(audit.flags.tax_formula);
  audit.flags.splitting_in_formula = /splitting|\* 2/i.test(formel);

  await writeFile(path.join(args.out, 'tax-audit.json'), JSON.stringify(audit, null, 2));

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`Steuerrechnung-Audit · Veranlagungsjahr ${audit.veranlagungsjahr}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  BMF erfolg               : ${audit.bmf_erfolg}`);
  console.log(`  Berechnungsmethode       : ${audit.flags.berechnungsmethode}`);
  console.log(`  Splittingtarif aktiv     : ${audit.flags.splittingtarif_active}  (in Formel: ${audit.flags.splitting_in_formula})`);
  console.log(`  Vorsorge >0              : ${audit.flags.vorsorge_total_gt_zero}`);
  console.log(`  Werbungskosten >0        : ${audit.flags.werbungskosten_gt_zero}`);
  console.log(`  Kapitalerträge >0        : ${audit.flags.kapitalertraege_present}`);
  console.log(`  KirchSt gezahlt >0       : ${audit.flags.kirchensteuer_gezahlt_gt_zero}`);
  console.log(`  Soli-Freigrenze          : ${audit.flags.soli_freigrenze}`);
  console.log(`  Soli > Freigrenze        : ${!audit.flags.soli_unter_freigrenze}`);
  console.log(`\n  Tarif-Formel             :`);
  console.log(`    ${audit.flags.tax_formula}`);
  console.log(`\n  Rechenschritte:`);
  for (const s of audit.rechenschritte) {
    const w = typeof s.wert === 'number' ? s.wert.toLocaleString('de-DE', { minimumFractionDigits: 2 }) : s.wert;
    console.log(`    [${s.schritt}] ${(s.bezeichnung ?? '').padEnd(60)} = ${w}`);
  }
  console.log(`\n  Bilanz                   : ${audit.flags.bilanz} ${audit.flags.bilanz_betrag.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`);

  // ── 10. Console-print KPI verdict ────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`KPI Result · ${result.passed}/${result.total} passed · ${wallclockMs}ms wallclock`);
  console.log('═══════════════════════════════════════════════════════');
  for (const k of result.kpis) {
    const mark = k.pass ? '✓' : '✗';
    console.log(`  ${mark} ${k.id} ${k.label.padEnd(34)} expect=${k.expected.padEnd(40)} got=${k.actual}`);
    if (k.violations) for (const v of k.violations) {
      console.log(`      ↳ ${v.doc}: missing ${JSON.stringify(v.missing)} (expected ${JSON.stringify(v.expected)}, got ${JSON.stringify(v.got)})`);
    }
  }
  console.log('═══════════════════════════════════════════════════════');
  console.log(`report: ${reportFile}`);
  console.log(`master: ${masterFile}`);
  console.log(`screenshots: ${screenshotsDir}/`);

  await browser.close();
  process.exit(result.allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err.stack || err.message || err);
  process.exit(2);
});
