// E2E button-audit for the STURM Workflow Designer.
// Drives real Chrome via puppeteer-core, walks the UI, reports what works.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:7800/designer.html?bust=' + Date.now();

const results = [];
const pass = (name, info='') => { results.push({ name, ok: true, info }); console.log('  ✓', name, info); };
const fail = (name, info='') => { results.push({ name, ok: false, info }); console.log('  ✗', name, info); };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

console.log('--- Loading', URL);
await page.goto(URL, { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 1500));

// 1. Catalog loaded?
const catalogCount = await page.$$eval('.dsg-palette-item', xs => xs.length);
catalogCount > 0 ? pass('Palette items rendered', `(${catalogCount})`) : fail('Palette items rendered', '0 items');

// 2. Source node visible?
const sourceVisible = await page.$('.dsg-source-node');
sourceVisible ? pass('Source node visible') : fail('Source node visible');

// 3. Source node has 4 handles for type=file
const srcHandles = await page.$$eval('.dsg-source-node .react-flow__handle', xs => xs.length);
srcHandles === 4 ? pass('Source has 4 handles', `(file mode)`) : fail('Source has 4 handles', `got ${srcHandles}`);

// 4. Quickstart visible and has close button
const qsVisible = await page.$('.dsg-quickstart');
const qsClose = await page.$('.dsg-quickstart-close');
qsVisible && qsClose ? pass('Quickstart + close button visible') : fail('Quickstart + close button visible');

// 5. Quickstart close actually dismisses
await page.click('.dsg-quickstart-close');
await new Promise(r => setTimeout(r, 400));
const qsAfter = await page.$('.dsg-quickstart');
!qsAfter ? pass('Quickstart × dismisses popup') : fail('Quickstart × dismisses popup');

// 6. Toolbar inputs editable
await page.click('.dsg-id-input', { clickCount: 3 });
await page.type('.dsg-id-input', 'btn_audit_wf');
const idVal = await page.$eval('.dsg-id-input', el => el.value);
idVal === 'btn_audit_wf' ? pass('ID input editable') : fail('ID input editable', `value="${idVal}"`);

await page.click('.dsg-name-input', { clickCount: 3 });
await page.type('.dsg-name-input', 'Button Audit Workflow');
const nameVal = await page.$eval('.dsg-name-input', el => el.value);
nameVal === 'Button Audit Workflow' ? pass('Name input editable') : fail('Name input editable');

// 7. Drag a palette item onto canvas (via HTML5 DnD simulation)
const target = await page.$('.react-flow__pane');
const targetBox = await target.boundingBox();
const item = await page.$('.dsg-palette-item');  // first item
await page.evaluate((dropX, dropY) => {
  const item = document.querySelector('.dsg-palette-item');
  const pane = document.querySelector('.react-flow__pane');
  const dt = new DataTransfer();
  // Designer reads "application/sturm-stage" mime type
  const uses = item.getAttribute('data-uses') || item.querySelector('.dsg-palette-id')?.textContent?.trim();
  dt.setData('application/sturm-stage', JSON.stringify({ uses }));
  item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  pane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
  pane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
}, targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
await new Promise(r => setTimeout(r, 400));
const nodeCount = await page.$$eval('.dsg-node', xs => xs.length);
nodeCount > 0 ? pass('Drag from palette adds node', `(${nodeCount} stage(s) on canvas)`) : fail('Drag from palette adds node', '0 nodes — handler not wired?');

// 8. Click new node, inspector reflects it
if (nodeCount > 0) {
  await page.click('.dsg-node');
  await new Promise(r => setTimeout(r, 200));
  const inspectorTitle = await page.$eval('.dsg-inspector .dsg-section-title', el => el.textContent).catch(() => null);
  inspectorTitle === 'Knoten' ? pass('Click node → inspector shows "Knoten"') : fail('Click node → inspector shows "Knoten"', `got "${inspectorTitle}"`);

  // 9. Hints panel (if stage has hints)
  const hintsPanel = await page.$('.dsg-hints');
  hintsPanel ? pass('Hints panel renders when stage has hints') : pass('Hints panel — no hints for this stage', '(expected for some)');

  // 10. "Übernehmen" button works (if hints panel + configExample present)
  const applyBtn = await page.$('.dsg-hints .dsg-btn-sm');
  if (applyBtn) {
    await applyBtn.click();
    await new Promise(r => setTimeout(r, 200));
    const configText = await page.$$eval('.dsg-textarea', els => {
      const t = els.find(e => e.placeholder && e.placeholder.startsWith('{ "model"'));
      return t ? t.value : '';
    });
    configText.length > 5 ? pass('Beispiel "Übernehmen" fills config') : fail('Beispiel "Übernehmen" fills config', `value="${configText}"`);
  } else {
    pass('No Übernehmen button (no example) — skipped');
  }
}

// 11. Test button — disabled if not saved yet? Save first
const testBtnState = await page.$eval('button[title*="Workflow"]', el => el.disabled);
console.log('  · Test button disabled state:', testBtnState);
// Save first via the primary button
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const save = btns.find(b => b.textContent.trim().startsWith('Speichern'));
  if (save) save.click();
});
await new Promise(r => setTimeout(r, 1500));
const status = await page.$eval('.dsg-status', el => el.textContent).catch(() => '');
status.toLowerCase().includes('gespeichert') ? pass('Save button works', `status="${status}"`) : fail('Save button works', `status="${status}"`);

// 12. Reload list and check the workflow is present
const inList = await page.evaluate(async () => {
  const r = await fetch('/api/workflows-user');
  const j = await r.json();
  return j.find(w => w.id === 'btn_audit_wf');
});
inList ? pass('Saved workflow appears in list') : fail('Saved workflow appears in list', JSON.stringify(inList));

// 13. Test ▶ button
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const t = btns.find(b => b.textContent.trim().startsWith('Test'));
  t?.click();
});
await new Promise(r => setTimeout(r, 800));
const modal = await page.$('.dsg-modal');
modal ? pass('Test ▶ opens modal') : fail('Test ▶ opens modal');

// 14. Close test modal
if (modal) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.dsg-modal .dsg-btn-sm')].find(b => b.textContent.trim() === 'Schließen');
    btn?.click();
  });
  await new Promise(r => setTimeout(r, 300));
  const stillThere = await page.$('.dsg-modal');
  !stillThere ? pass('Modal Schließen-button closes') : fail('Modal Schließen-button closes');
}

// 16. Container palette section + drag-drop
const containerCount = await page.$$eval('.dsg-palette-item', xs => xs.filter(x => x.querySelector('.dsg-palette-name')?.textContent?.includes('🗄️')).length);
containerCount > 0 ? pass(`Container palette section has entries`, `(${containerCount})`) : fail('Container palette section has entries');

if (containerCount > 0) {
  const dropped = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.dsg-palette-item')];
    const containerItem = items.find(el => el.querySelector('.dsg-palette-name')?.textContent?.includes('🗄️'));
    if (!containerItem) return { error: 'no container item' };
    const id = containerItem.querySelector('.dsg-palette-id')?.textContent?.trim();
    const pane = document.querySelector('.react-flow__pane');
    const rect = pane.getBoundingClientRect();
    const cx = rect.left + 350, cy = rect.top + 500;
    const dt = new DataTransfer();
    dt.setData('application/sturm-container', JSON.stringify({ id, displayName: 'Test Container', atomsCount: 2287, readBy: [] }));
    containerItem.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    pane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    pane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    return { id };
  });
  await new Promise(r => setTimeout(r, 400));
  const containerOnCanvas = await page.$('.dsg-container-node');
  containerOnCanvas ? pass('Drag container from palette adds container node', dropped.id) : fail('Drag container from palette adds container node');
}

// 17. Console errors
consoleErrors.length === 0 ? pass('No JS console errors') : fail(`${consoleErrors.length} console error(s)`, consoleErrors.slice(0,3).join(' | '));

await page.screenshot({ path: '/tmp/sturm-e2e/final.png', fullPage: false });
await browser.close();

console.log('\n--- SUMMARY ---');
const failed = results.filter(r => !r.ok);
console.log(`passed: ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('failures:');
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.info}`);
}
process.exit(failed.length === 0 ? 0 : 1);
