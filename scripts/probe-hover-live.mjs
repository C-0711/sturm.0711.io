import puppeteer from 'puppeteer-core';

const TOKEN = process.env.STURM_BEARER_TOKEN;
const URL = process.env.URL || 'https://ctax.0711.io/m-case.html?case=est-2024-bf6vvcfj5#abrechnung';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ 'Authorization': `Bearer ${TOKEN}` });
page.on('console', (m) => console.log('[browser]', m.type(), m.text().slice(0, 200)));
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));

// reload abrechnung iframe
await page.evaluate(() => {
  const tab = document.querySelector('[data-tab="abrechnung"]'); if (tab) tab.click();
});
await new Promise(r => setTimeout(r, 2000));

const frameHandle = await page.$('#abrechnung-frame');
const frame = await frameHandle.contentFrame();
await frame.waitForSelector('tr.lbl, tr.amt, .cd-warnings, table', { timeout: 15000 }).catch(() => {});
await new Promise(r => setTimeout(r, 2000));

const stats = await frame.evaluate(() => {
  const rowsWithSha = document.querySelectorAll('[data-sha256][data-page]').length;
  const trs = document.querySelectorAll('tr').length;
  const cdWarnings = document.querySelectorAll('.cd-warnings li').length;
  const samples = Array.from(document.querySelectorAll('[data-sha256][data-page]')).slice(0, 5).map(el => ({
    tag: el.tagName,
    sha: (el.getAttribute('data-sha256') || '').slice(0, 12),
    page: el.getAttribute('data-page'),
    filename: el.getAttribute('data-filename'),
    snippet: (el.getAttribute('data-snippet') || '').slice(0, 60),
    text: (el.textContent || '').trim().slice(0, 80),
  }));
  return { rowsWithSha, trs, cdWarnings, samples };
});
console.log('IFRAME STATS:', JSON.stringify(stats, null, 2));

const parentStats = await page.evaluate(() => ({
  indWertWithSha: document.querySelectorAll('.ind-wert[data-sha256]').length,
  felderRowsWithSha: document.querySelectorAll('.felder-row[data-sha256]').length,
  activePanel: (document.querySelector('.panel.active') || {}).id,
}));
console.log('PARENT STATS:', JSON.stringify(parentStats, null, 2));

await browser.close();
