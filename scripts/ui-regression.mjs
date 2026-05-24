#!/usr/bin/env node
/**
 * UI D8 suite: route smoke + visual regression.
 *
 * Smoke: checks key STURM/Gateway routes for reachable HTTP status.
 * Visual: compares canonical routes against alpha.6_2 reference pages under /v6/*
 *         for desktop + mobile screenshots.
 *
 * Usage:
 *   node scripts/ui-regression.mjs --base http://127.0.0.1:7800 --smoke-only
 *   node scripts/ui-regression.mjs --base http://127.0.0.1:7800 --max-diff 18
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const BASE = arg('--base', process.env.BASE_URL ?? 'http://127.0.0.1:7800');
const SMOKE_ONLY = has('--smoke-only');
const FULL_VISUAL = has('--full-visual') || process.env.UI_VISUAL_FULL === '1';
const MAX_DIFF_PERCENT = Number(arg('--max-diff', process.env.UI_VISUAL_MAX_DIFF_PERCENT ?? '18'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, 'reports', `ui-regression-${stamp}`);
await mkdir(outDir, { recursive: true });

const SMOKE_ROUTES = [
  '/',
  '/gateway',
  '/designer.html',
  '/pipeline.html',
  '/studio-ocr.html',
  '/anwendungen.html',
  '/steuerfall.html',
  '/abrechnung.html',
  '/workspaces.html',
  '/workspace.html',
  '/document.html',
  '/source-viewer.html',
  '/ctx-doku',
  '/ctx-demo.html',
  '/fleet',
  '/orchestrator',
  '/ui/',
  '/v6/',
];

// Canonical page vs design-pack reference route (alpha.6_2 deployed under /v6/*)
// Default gate checks only migrated parity routes. Use --full-visual for audit mode.
const VISUAL_ROUTES_MIGRATED = [
  { id: 'home', canonical: '/', reference: '/v6/index.html' },
];
const VISUAL_ROUTES_AUDIT = [
  { id: 'home', canonical: '/', reference: '/v6/index.html' },
  { id: 'gateway', canonical: '/gateway', reference: '/v6/gateway.html' },
  { id: 'designer', canonical: '/designer.html', reference: '/v6/designer.html' },
  { id: 'ocr', canonical: '/studio-ocr.html', reference: '/v6/ocr-studio.html' },
];
const VISUAL_ROUTES = FULL_VISUAL ? VISUAL_ROUTES_AUDIT : VISUAL_ROUTES_MIGRATED;

const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'mobile', width: 390, height: 844 },
];

const results = {
  base: BASE,
  maxDiffPercent: MAX_DIFF_PERCENT,
  smokeOnly: SMOKE_ONLY,
  fullVisual: FULL_VISUAL,
  smoke: [],
  visual: [],
  createdAt: new Date().toISOString(),
};

async function smokeCheck(route) {
  const url = new URL(route, BASE).toString();
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const ms = Date.now() - started;
    const ok = (res.status >= 200 && res.status < 400);
    const entry = { route, url, status: res.status, ok, ms };
    results.smoke.push(entry);
    return entry;
  } catch (err) {
    const ms = Date.now() - started;
    const entry = { route, url, ok: false, error: String(err?.message ?? err), ms };
    results.smoke.push(entry);
    return entry;
  }
}

const smokeResults = await Promise.all(SMOKE_ROUTES.map(smokeCheck));
const smokeFailures = smokeResults.filter((r) => !r.ok);

if (!SMOKE_ONLY) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch (err) {
    console.error('playwright is required for visual mode. Run: npm i -D playwright');
    throw err;
  }

  const { PNG } = await import('pngjs');
  const pixelmatchMod = await import('pixelmatch');
  const pixelmatch = pixelmatchMod.default ?? pixelmatchMod;

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const screenshotCss = `
    *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
    .live-panel, .hero-meta, [data-regression-ignore] { visibility: hidden !important; }
  `;

  for (const vp of VIEWPORTS) {
    for (const route of VISUAL_ROUTES) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const pageA = await ctx.newPage();
      const pageB = await ctx.newPage();

      await pageA.goto(new URL(route.canonical, BASE).toString(), { waitUntil: 'networkidle' });
      await pageB.goto(new URL(route.reference, BASE).toString(), { waitUntil: 'networkidle' });

      await pageA.addStyleTag({ content: screenshotCss });
      await pageB.addStyleTag({ content: screenshotCss });

      const canonicalPath = path.join(outDir, `${route.id}-${vp.id}-canonical.png`);
      const referencePath = path.join(outDir, `${route.id}-${vp.id}-reference.png`);
      const diffPath = path.join(outDir, `${route.id}-${vp.id}-diff.png`);

      await pageA.screenshot({ path: canonicalPath, fullPage: true });
      await pageB.screenshot({ path: referencePath, fullPage: true });

      const aBuf = await readFile(canonicalPath);
      const bBuf = await readFile(referencePath);
      const aPng = PNG.sync.read(aBuf);
      const bPng = PNG.sync.read(bBuf);

      const width = Math.min(aPng.width, bPng.width);
      const height = Math.min(aPng.height, bPng.height);
      const aCrop = new PNG({ width, height });
      const bCrop = new PNG({ width, height });
      PNG.bitblt(aPng, aCrop, 0, 0, width, height, 0, 0);
      PNG.bitblt(bPng, bCrop, 0, 0, width, height, 0, 0);

      const diff = new PNG({ width, height });
      const diffPixels = pixelmatch(aCrop.data, bCrop.data, diff.data, width, height, {
        threshold: 0.12,
        includeAA: false,
      });
      await writeFile(diffPath, PNG.sync.write(diff));

      const total = width * height;
      const diffPercent = (diffPixels / total) * 100;
      const ok = diffPercent <= MAX_DIFF_PERCENT;

      results.visual.push({
        id: route.id,
        viewport: vp.id,
        canonical: route.canonical,
        reference: route.reference,
        diffPixels,
        totalPixels: total,
        diffPercent: Number(diffPercent.toFixed(3)),
        maxAllowed: MAX_DIFF_PERCENT,
        ok,
        artifacts: {
          canonical: path.relative(ROOT, canonicalPath),
          reference: path.relative(ROOT, referencePath),
          diff: path.relative(ROOT, diffPath),
        },
      });

      await ctx.close();
    }
  }

  await browser.close();
}

const visualFailures = results.visual.filter((r) => !r.ok);
const summary = {
  smokeTotal: results.smoke.length,
  smokeFailures: smokeFailures.length,
  visualTotal: results.visual.length,
  visualFailures: visualFailures.length,
  outDir: path.relative(ROOT, outDir),
};
results.summary = summary;

await writeFile(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));

const lines = [];
lines.push('# UI Regression Report');
lines.push('');
lines.push(`- Base: \`${BASE}\``);
lines.push(`- Smoke failures: **${summary.smokeFailures}/${summary.smokeTotal}**`);
lines.push(`- Visual failures: **${summary.visualFailures}/${summary.visualTotal}**`);
lines.push(`- Max visual diff: **${MAX_DIFF_PERCENT}%**`);
lines.push('');
lines.push('## Smoke');
for (const r of results.smoke) {
  lines.push(`- ${r.ok ? '✅' : '❌'} \`${r.route}\` → ${r.status ?? r.error} (${r.ms}ms)`);
}
if (results.visual.length > 0) {
  lines.push('');
  lines.push('## Visual');
  for (const v of results.visual) {
    lines.push(`- ${v.ok ? '✅' : '❌'} \`${v.id}/${v.viewport}\` diff=${v.diffPercent}% (max ${v.maxAllowed}%)`);
  }
}
await writeFile(path.join(outDir, 'REPORT.md'), lines.join('\n'));

console.log(JSON.stringify(summary, null, 2));

if (smokeFailures.length > 0 || visualFailures.length > 0) {
  process.exit(1);
}
