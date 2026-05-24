#!/usr/bin/env node
/**
 * UI-06 sister-surface parity probe.
 *
 * Captures live HTTP/title baseline + desktop/mobile screenshots for P1/P2 surfaces.
 * Writes report artifacts under reports/sister-parity-<timestamp>/.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, 'reports', `sister-parity-${stamp}`);
await mkdir(outDir, { recursive: true });

const surfaces = [
  { id: 'sturm-mandanten', tier: 'P1', url: 'https://sturm-mandanten.0711.io' },
  { id: 'cornea-quantum', tier: 'P1', url: 'https://quantum.0711.io' },
  { id: 'elster-quantum', tier: 'P2', url: 'https://elster-quantum.0711.io' },
  { id: 'bosch-edu', tier: 'P2', url: 'https://bosch-edu.0711.io' },
  { id: 'hoor', tier: 'P2', url: 'https://hoor.0711.io' },
];

const viewports = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'mobile', width: 390, height: 844 },
];

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '(no title)';
}

const report = {
  createdAt: new Date().toISOString(),
  outDir: path.relative(ROOT, outDir),
  surfaces: [],
};

let playwright;
try {
  playwright = await import('playwright');
} catch (err) {
  console.error('playwright missing. install with: npm i -D playwright');
  throw err;
}

const browser = await playwright.chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const surface of surfaces) {
  const entry = { ...surface, ok: false, status: null, title: null, screenshots: [] };
  try {
    const res = await fetch(surface.url, { redirect: 'follow' });
    const html = await res.text();
    entry.status = res.status;
    entry.ok = res.status >= 200 && res.status < 400;
    entry.title = extractTitle(html);

    for (const vp of viewports) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await page.goto(surface.url, { waitUntil: 'networkidle' });
      const file = `${surface.id}-${vp.id}.png`;
      const filePath = path.join(outDir, file);
      await page.screenshot({ path: filePath, fullPage: true });
      entry.screenshots.push(path.posix.join(path.basename(outDir), file));
      await ctx.close();
    }
  } catch (err) {
    entry.error = String(err?.message ?? err);
  }
  report.surfaces.push(entry);
}

await browser.close();

report.summary = {
  total: report.surfaces.length,
  ok: report.surfaces.filter((s) => s.ok).length,
  failed: report.surfaces.filter((s) => !s.ok).length,
};

await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

const md = [];
md.push('# Sister Surface Parity Probe');
md.push('');
md.push(`- Created: ${report.createdAt}`);
md.push(`- Total: ${report.summary.total}`);
md.push(`- OK: ${report.summary.ok}`);
md.push(`- Failed: ${report.summary.failed}`);
md.push('');
md.push('| Surface | Tier | HTTP | Title | Desktop | Mobile |');
md.push('|---|---|---:|---|---|---|');
for (const s of report.surfaces) {
  const desktop = s.screenshots.find((x) => x.includes('-desktop.png'));
  const mobile = s.screenshots.find((x) => x.includes('-mobile.png'));
  md.push(`| ${s.id} | ${s.tier} | ${s.status ?? 'ERR'} | ${s.title ?? s.error ?? 'n/a'} | ${desktop ? `[shot](${desktop})` : 'n/a'} | ${mobile ? `[shot](${mobile})` : 'n/a'} |`);
}
await writeFile(path.join(outDir, 'REPORT.md'), md.join('\n'));

console.log(JSON.stringify({
  outDir: report.outDir,
  summary: report.summary,
}, null, 2));

if (report.summary.failed > 0) {
  process.exit(1);
}
