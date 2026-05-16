import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 1300 },
});
const out = path.resolve('reports', 'probe-steuerfall-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19));
await mkdir(out, { recursive: true });
const page = await browser.newPage();
page.on('console', m => { if (m.type()==='error'||m.type()==='pageerror') console.log('  console:', m.type(), m.text().slice(0,200)); });
page.on('pageerror', e => console.log('  pageerror:', String(e.message).slice(0,200)));
const CASE = process.argv[2] || 'stricker-e2e-2026-05-16t03-41-14-2023-mp7suavp';
await page.goto(`http://localhost:7800/steuerfall.html?app=steuerfall-est&case=${CASE}`, { waitUntil:'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 20000));
// open the bmf-detail
await page.evaluate(() => {
  const d = document.getElementById('bmf-detail');
  if (d) d.open = true;
});
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: path.join(out,'steuerfall-with-detail.png'), fullPage: true });
console.log('Screenshot:', path.join(out,'steuerfall-with-detail.png'));
await browser.close();
