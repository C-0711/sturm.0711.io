#!/usr/bin/env node
/**
 * Diagnostic: prüft ob Hover über felder-row + abrechnung-Werte den
 * Source-Viewer aktualisiert.
 *
 * STURM_TEST_PASSWORD=... node scripts/probe-hover.mjs \
 *   --base https://ctax.0711.io --email christoph@0711.io \
 *   --case est-2024-mpb90x9c
 */
import puppeteer from 'puppeteer-core';

function parseArgs(argv) {
  const out = {
    base: 'https://ctax.0711.io', email: '', password: process.env.STURM_TEST_PASSWORD ?? '',
    case: '', chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--case') out.case = argv[++i];
    else if (a === '--chrome') out.chrome = argv[++i];
  }
  if (!out.email || !out.password || !out.case) throw new Error('--email, --password, --case required');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const browser = await puppeteer.launch({ executablePath: args.chrome, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

console.log('1. Login…');
await page.goto(`${args.base}/m/login`, { waitUntil: 'networkidle2' });
await page.type('#email', args.email);
await page.type('#password', args.password);
await Promise.all([page.waitForNavigation(), page.click('#submitBtn')]);

console.log('2. Open case…');
await page.goto(`${args.base}/m/case/${encodeURIComponent(args.case)}#felder`, { waitUntil: 'networkidle2' });
// Wait up to 30s for felder body to populate (cross-doc-audit LLM call inside /master takes ~10s)
console.log('   waiting for #felder-body to populate…');
try {
  await page.waitForFunction(() => {
    const body = document.querySelector('#felder-body');
    return body && !!body.querySelector('table');
  }, { timeout: 30000 });
  console.log('   table appeared');
} catch (e) {
  console.log('   timeout waiting for table — checking what is in #felder-body');
  const bodyHtml = await page.evaluate(() => document.querySelector('#felder-body')?.innerHTML.slice(0, 500));
  console.log('   ', bodyHtml);
}
await new Promise((r) => setTimeout(r, 1500));

console.log('3. Check Felder-Tab structure…');
const felderInfo = await page.evaluate(() => {
  const rows = document.querySelectorAll('.felder-row');
  const withData = [...rows].filter((r) => r.hasAttribute('data-sha256'));
  const split = !!document.querySelector('#felder-split');
  const viewerCanvas = document.querySelector('#felder-viewer-canvas');
  const hasViewer = !!viewerCanvas;
  const initialViewerHtml = viewerCanvas ? viewerCanvas.innerHTML.slice(0, 200) : 'NO CANVAS';
  const firstRow = withData[0];
  const firstRowAttrs = firstRow ? {
    sha: firstRow.getAttribute('data-sha256'),
    page: firstRow.getAttribute('data-page'),
    filename: firstRow.getAttribute('data-filename'),
    snippet: (firstRow.getAttribute('data-snippet') || '').slice(0, 80),
    ecode: firstRow.getAttribute('data-ecode'),
  } : null;
  return {
    totalRows: rows.length,
    rowsWithData: withData.length,
    hasSplit: split,
    hasViewer,
    initialViewerHtml,
    firstRow: firstRowAttrs,
  };
});
console.log('   ', JSON.stringify(felderInfo, null, 2));

if (felderInfo.rowsWithData === 0) {
  console.log('❌ KEINE felder-row mit data-sha256 — Source-Daten fehlen!');
  await page.screenshot({ path: '/tmp/probe-felder.png', fullPage: true });
  console.log('   screenshot → /tmp/probe-felder.png');
  await browser.close();
  process.exit(1);
}

console.log('4. Hover über erste Zeile mit data-sha256…');
await page.hover('.felder-row[data-sha256]');
await new Promise((r) => setTimeout(r, 1500));

console.log('5. Viewer-State nach Hover:');
const afterHover = await page.evaluate(() => {
  const canvas = document.querySelector('#felder-viewer-canvas');
  const img = canvas?.querySelector('img');
  const label = document.querySelector('#felder-page-label');
  const activeRow = document.querySelector('.felder-row.viewer-active');
  return {
    canvasHtml: canvas ? canvas.innerHTML.slice(0, 300) : 'NO CANVAS',
    imgSrc: img ? img.getAttribute('src') : null,
    pageLabel: label ? label.textContent : null,
    activeRowEcode: activeRow ? activeRow.getAttribute('data-ecode') : null,
  };
});
console.log('   ', JSON.stringify(afterHover, null, 2));

if (!afterHover.imgSrc) {
  console.log('❌ Hover hat keinen Img-Tag erzeugt → Hover-Handler greift nicht');
} else {
  console.log('✓  Img geladen:', afterHover.imgSrc);
}

console.log('6. Console errors:', consoleErrors.length);
for (const e of consoleErrors) console.log('   ', e);

await page.screenshot({ path: '/tmp/probe-hover.png', fullPage: true });
console.log('screenshot → /tmp/probe-hover.png');

await browser.close();
process.exit(afterHover.imgSrc ? 0 : 1);
