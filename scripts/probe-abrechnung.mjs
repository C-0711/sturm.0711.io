import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
  defaultViewport: { width: 900, height: 2400, deviceScaleFactor: 2 },
});
const out = path.resolve('reports', 'probe-abrechnung-' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19));
await mkdir(out, { recursive: true });
const page = await browser.newPage();
const CASE = process.argv[2];
await page.goto(`http://localhost:7800/abrechnung.html?app=steuerfall-est&case=${CASE}`, { waitUntil:'networkidle2' });
await new Promise(r => setTimeout(r, 6000));
await page.screenshot({ path: path.join(out, 'abrechnung.png'), fullPage: true });
console.log(path.join(out, 'abrechnung.png'));
await browser.close();
