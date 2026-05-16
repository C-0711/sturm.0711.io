import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

const CASE = 'stricker-e2e-2026-05-16t03-41-14-2023-mp7suavp';
const BASE = 'http://localhost:7800';
const OUT = path.resolve('reports', 'screenshot-tour-deeper-' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19));
await mkdir(OUT, { recursive: true });

const ROUTES = [
  { id: 'steuerfall-active', path: `/steuerfall.html?app=steuerfall-est&case=${CASE}` },
  { id: 'document-viewer', path: `/document.html?case=${CASE}` },
  { id: 'pipeline-elster-v4-stricker', path: '/pipeline.html?workflow=elster-v4-stricker' },
  { id: 'pipeline-quality-demo', path: '/pipeline.html?workflow=elster-quality-demo' },
];

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
});

const findings = [];
for (const r of ROUTES) {
  console.log('→', r.id);
  const page = await browser.newPage();
  const msgs = [], nets = [];
  page.on('console', m => { if (m.type()==='error'||m.type()==='warning') msgs.push({t:m.type(),text:m.text()}); });
  page.on('pageerror', e => msgs.push({t:'pageerror', text:String(e.message||e)}));
  page.on('response', res => { const s=res.status(); if (s>=400 && res.request().resourceType()!=='image') nets.push({url:res.url(),s}); });
  try {
    await page.goto(`${BASE}${r.path}`, { waitUntil: 'networkidle2', timeout: 15000 });
  } catch (e) {
    findings.push({route:r.id, sev:'critical', msg:'goto fail: '+e.message});
    await page.close(); continue;
  }
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(OUT, r.id+'.png'), fullPage: true });
  for (const m of msgs) findings.push({route:r.id, sev: m.t==='warning' ? 'medium':'high', msg:m.t+': '+m.text.slice(0,200)});
  for (const n of nets) findings.push({route:r.id, sev: n.s>=500?'high':'medium', msg:`HTTP ${n.s} ${n.url}`});
  console.log(`   ${msgs.length} msg ${nets.length} net`);
  await page.close();
}
await browser.close();
console.log('\n══ Findings:', findings.length);
for (const f of findings.slice(0,15)) console.log(`  [${f.sev}] ${f.route}: ${f.msg}`);
console.log('Output:', OUT);
