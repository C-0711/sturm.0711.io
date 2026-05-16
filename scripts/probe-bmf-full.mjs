import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
  defaultViewport: { width: 1100, height: 1800, deviceScaleFactor: 2 },
});
const out = path.resolve('reports', 'probe-bmf-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19));
await mkdir(out, { recursive: true });
const page = await browser.newPage();
const CASE = process.argv[2];
await page.goto(`http://localhost:7800/steuerfall.html?app=steuerfall-est&case=${CASE}`, { waitUntil:'networkidle2' });
await new Promise(r => setTimeout(r, 20000));
await page.evaluate(() => { const d = document.getElementById('bmf-detail'); if (d) d.open = true; });
await new Promise(r => setTimeout(r, 800));
const el = await page.$('#aggregate-panel');
if (el) await el.screenshot({ path: path.join(out, 'bmf-detail-only.png') });
else await page.screenshot({ path: path.join(out, 'fallback.png'), fullPage: true });
console.log(path.join(out, 'bmf-detail-only.png'));
await browser.close();
