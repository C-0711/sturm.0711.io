/* OCR Studio — client */

window.addEventListener('error', (e) => {
  console.error('[studio] uncaught:', e.error || e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[studio] unhandled promise rejection:', e.reason);
});

// ============ Auth: bearer token bootstrap ==================================
(function bootstrapToken() {
  try {
    const u = new URL(window.location.href);
    const t = u.searchParams.get('token');
    if (t) {
      localStorage.setItem('sturm-token', t);
      u.searchParams.delete('token');
      window.history.replaceState({}, '', u.toString());
    }
  } catch (e) { console.warn('[studio] token bootstrap failed:', e); }
})();

const _origFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const tok = localStorage.getItem('sturm-token');
  if (!tok) return _origFetch(input, init);
  const headers = new Headers(init.headers || {});
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${tok}`);
  return _origFetch(input, { ...init, headers });
};

const $ = (id) => document.getElementById(id);
const setHidden = (el, hide) => {
  if (!el) return;
  el.classList.toggle('hidden', hide);
  if (hide) {
    el.setAttribute('aria-hidden', 'true');
    if (el.tagName === 'BUTTON' || el.tagName === 'A') el.setAttribute('tabindex', '-1');
  } else {
    el.removeAttribute('aria-hidden');
    el.removeAttribute('tabindex');
  }
};

// withTransition: run mutator inside startViewTransition when supported,
// otherwise just call it directly. Layout-changing state mutations should
// flow through this helper (3.3).
function withTransition(fn) {
  if (document.startViewTransition) {
    const tx = document.startViewTransition(fn);
    // Suppress "Transition was skipped" rejection when transitions overlap —
    // the mutator already ran; the abort is purely about animation.
    tx?.finished?.catch(() => {});
    tx?.ready?.catch(() => {});
    return tx;
  }
  fn();
  return null;
}

const els = {
  fileInput: $('file-input'),
  filePickerLabel: document.querySelector('.file-picker span'),
  docMeta: $('doc-meta'),
  docViewer: $('doc-viewer'),
  docEmpty: $('doc-empty'),
  pageConfPill: $('page-conf-pill'),
  runBtn: $('run-btn'),
  statusPill: $('status-pill'),
  statusMeta: $('status-meta'),
  cfg: {
    model: $('cfg-model'),
    pages: $('cfg-pages'),
    pagesError: $('cfg-pages-error'),
    extractHeader: $('cfg-extract-header'),
    extractFooter: $('cfg-extract-footer'),
    tableFormat: $('cfg-table-format'),
    includeBase64: $('cfg-include-base64'),
    imageMinSize: $('cfg-image-min-size'),
    imageLimit: $('cfg-image-limit'),
    confidence: $('cfg-confidence'),
    schemaName: $('cfg-schema-name'),
    prompt: $('cfg-prompt'),
  },
  out: {
    annotation: $('out-annotation'),
    annotationRich: $('out-annotation-rich'),
    markdown: $('out-markdown'),
    links: $('out-links'),
    quality: $('out-quality'),
    raw: $('out-raw'),
    diff: $('out-diff'),
  },
  applyBtn: $('apply-btn'),
  revertBtn: $('revert-btn'),
  rerunBtn: $('rerun-btn'),
  overridePill: $('override-pill'),
  tabDiff: $('tab-diff'),
  toastContainer: $('toast-container'),
  costMeter: $('cost-meter'),
  costMeterValue: $('cost-meter-value'),
  rightRail: $('right-rail'),
  draftCta: $('draft-cta'),
  draftCtaPrimary: $('draft-cta-primary'),
  draftCtaSecondary: $('draft-cta-secondary'),
  draftCtaTitle: $('draft-cta-title'),
  draftCtaSub: $('draft-cta-sub'),
  draftCtaHint: $('draft-cta-hint'),
};

// ============ Stage manager (commit 1/3) ====================================
// Single source of truth for the data-stage attribute on <body>. CSS in
// /stages.css drives the actual show/hide; JS only mutates the attribute and
// runs entry hooks (focus management, draft-cta refresh, etc.).
const STAGES = ['empty', 'drafting', 'reading', 'tuning'];
const SHEETS = ['schema', 'params', 'history', 'detail'];
let currentStage = 'empty';
let currentSheet = null;

function setStage(next) {
  if (!STAGES.includes(next)) {
    console.warn('[studio] setStage: unknown stage', next);
    return;
  }
  if (next === currentStage) return;
  const prev = currentStage;
  currentStage = next;
  withTransition(() => {
    document.body.setAttribute('data-stage', next);
    if (next !== 'tuning') {
      currentSheet = null;
      delete document.body.dataset.activeSheet;
      // Clear pressed state on all rail buttons
      document.querySelectorAll('.rr-btn[aria-pressed="true"]')
        .forEach((b) => b.setAttribute('aria-pressed', 'false'));
    }
  });
  // Entry hooks
  setTimeout(() => runStageEntryHook(next, prev), 0);
}

function runStageEntryHook(stage, _prev) {
  try {
    if (stage === 'empty') {
      els.fileInput?.focus?.();
    } else if (stage === 'drafting') {
      refreshDraftCta();
      $('draft-cta-primary')?.focus?.();
    } else if (stage === 'reading') {
      els.docViewer?.focus?.();
      // Make sure the result tab is the active run-tab so the user sees output
      activateRunTab('result');
    } else if (stage === 'tuning') {
      // Focus first focusable inside the active sheet
      const sel = currentSheet === 'schema' ? '.pane-schema'
                : currentSheet === 'params' ? '.pane-run .run-tab-body[data-runbody="parameters"]'
                : currentSheet === 'history' ? '.pane-run .run-tab-body[data-runbody="history"]'
                : currentSheet === 'detail' ? '.pane-run .run-tab-body[data-runbody="result"]'
                : null;
      if (sel) {
        const root = document.querySelector(sel);
        const focusable = root?.querySelector('button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
        focusable?.focus?.();
      }
    }
  } catch (e) { console.warn('[studio] stage entry hook failed:', e); }
}

function openSheet(name) {
  if (!SHEETS.includes(name)) return;
  currentSheet = name;
  document.body.dataset.activeSheet = name;
  // Sync run-tab visibility for sheets that overlay .pane-run
  if (name === 'params') activateRunTab('parameters');
  else if (name === 'history') activateRunTab('history');
  else if (name === 'detail') activateRunTab('result');
  setStage('tuning');
  // Update aria-pressed on rail buttons
  document.querySelectorAll('.rr-btn').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.railAction === name ? 'true' : 'false');
  });
}

function closeSheet() {
  if (currentStage !== 'tuning') return;
  setStage('reading');
}

function toggleSheet(name) {
  if (currentStage === 'tuning' && currentSheet === name) closeSheet();
  else openSheet(name);
}

let currentFile = null;
let currentDocUrl = null;
let activeAbort = null;
let lastParsed = null; // last preview result (for OCR-text↔schema coupling)

const tuning = {
  workflowId: null,
  stageId: null,
  runId: null,
  hasOverride: false,
  originalOutput: null,
  lastPreview: null,
};

// ============ Result inner-tabs (Annotation/Markdown/...) ===================
function activateResultTab(tabName) {
  document.querySelectorAll('.run-tab-body[data-runbody="result"] .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.run-tab-body[data-runbody="result"] .tab-panel').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.panel !== tabName);
  });
}

document.querySelectorAll('.run-tab-body[data-runbody="result"] .tab').forEach((tab) => {
  tab.addEventListener('click', () => withTransition(() => activateResultTab(tab.dataset.tab)));
});

// ============ Run-column outer tabs (Parameters/Result/Variants/History) ====
function activateRunTab(name) {
  document.querySelectorAll('.run-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.runtab === name);
  });
  document.querySelectorAll('.run-tab-body').forEach((b) => {
    setHidden(b, b.dataset.runbody !== name);
  });
}
document.querySelectorAll('.run-tab').forEach((tab) => {
  tab.addEventListener('click', () => withTransition(() => activateRunTab(tab.dataset.runtab)));
});

// Legacy hidden #tab-variants reveal — when studio code unhides it, also reveal
// the run-column variants tab.
const tabVariantsStage = $('tab-variants-stage');
function syncVariantsTabReveal() {
  const legacy = $('tab-variants');
  if (!legacy || !tabVariantsStage) return;
  const hide = legacy.classList.contains('hidden');
  setHidden(tabVariantsStage, hide);
}
new MutationObserver(syncVariantsTabReveal).observe(
  $('tab-variants'),
  { attributes: true, attributeFilter: ['class'] },
);

// ============ File picker / loadFile ========================================
els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) loadFile(file);
});

function loadFile(file) {
  currentFile = file;
  if (currentDocUrl) URL.revokeObjectURL(currentDocUrl);
  currentDocUrl = URL.createObjectURL(file);
  els.filePickerLabel.textContent = file.name;
  els.docMeta.textContent = `${file.name} · ${formatBytes(file.size)} · ${file.type || 'unknown'}`;
  withTransition(() => {
    els.docViewer.innerHTML = '';
    if ((file.type || '').startsWith('image/')) {
      const img = document.createElement('img');
      img.src = currentDocUrl;
      img.addEventListener('load', () => {
        const px = (img.naturalWidth || 0) * (img.naturalHeight || 0);
        if (px > 0 && px < 1000) {
          toast('Sehr kleine Eingabe — Modell könnte halluzinieren. Trotzdem fortfahren?', 'warn', 6000);
        }
      }, { once: true });
      els.docViewer.appendChild(img);
    } else {
      const iframe = document.createElement('iframe');
      iframe.src = currentDocUrl;
      iframe.title = file.name;
      els.docViewer.appendChild(iframe);
    }
  });
  if (file.size < 5 * 1024) {
    toast('Sehr kleine Eingabe — Modell könnte halluzinieren. Trotzdem fortfahren?', 'warn', 6000);
  }
  els.runBtn.disabled = false;
  const sgBtn = $('schema-generate-btn');
  if (sgBtn) sgBtn.disabled = false;
  // Stage transition: empty | reading | tuning  →  drafting whenever a file
  // is freshly loaded. (drafting → reading happens later on ocr_done.)
  setStage('drafting');
  // Kick off mistral-small classification immediately so the user sees what
  // the document is + a first KPI extraction without lifting a finger.
  autoClassify(file);
}

// ============ Auto-classify on file drop ====================================
let currentClassifyAbort = null;

function autoClassify(file) {
  if (currentClassifyAbort) { try { currentClassifyAbort.abort(); } catch { /* ignore */ } }
  currentClassifyAbort = new AbortController();

  const inner = document.querySelector('.draft-cta-inner');
  if (!inner) return;
  let panel = document.getElementById('auto-classify-panel');
  if (panel) panel.remove();
  panel = document.createElement('div');
  panel.id = 'auto-classify-panel';
  panel.className = 'auto-classify auto-classify-pending';
  panel.innerHTML = '<div class="ac-spinner">Klassifiziere mit mistral-small …</div>';
  inner.prepend(panel);

  const fd = new FormData();
  fd.append('file', file);
  const headers = {};
  const tok = localStorage.getItem('sturm-token');
  if (tok) headers['Authorization'] = `Bearer ${tok}`;

  fetch('/api/classify', { method: 'POST', body: fd, headers, signal: currentClassifyAbort.signal })
    .then(async (resp) => {
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      }
      let lastError = null;
      let result = null;
      await consumeSse(resp.body, (event, data) => {
        if (event === 'classify_done') result = data;
        else if (event === 'error') lastError = data.message ?? 'unknown';
      });
      if (lastError) throw new Error(lastError);
      if (!result) throw new Error('classify ohne Ergebnis');
      renderAutoClassify(panel, result);
    })
    .catch((e) => {
      if (e.name === 'AbortError') return;
      panel.classList.remove('auto-classify-pending');
      panel.classList.add('auto-classify-error');
      panel.innerHTML = `<div class="ac-error">Klassifikation fehlgeschlagen: ${escapeHtml(e.message)}</div>`;
    });
}

function renderAutoClassify(panel, data) {
  panel.classList.remove('auto-classify-pending');
  panel.classList.add('auto-classify-done');
  const kpiCount = data.kpis?.length ?? 0;
  const kpiHtml = (data.kpis ?? []).map((k) =>
    `<li><span class="ac-k">${escapeHtml(k.key)}</span><span class="ac-v">${escapeHtml(k.value)}</span></li>`
  ).join('');
  panel.innerHTML = `
    <div class="ac-head">
      <span class="ac-pill">${escapeHtml(data.label)}</span>
      <span class="ac-meta">${(data.confidence * 100).toFixed(0)}% conf · ${kpiCount} KPIs · ${data.ms} ms · ${data.tokens ?? '?'} tok</span>
    </div>
    <p class="ac-summary">${escapeHtml(data.summary ?? '')}</p>
    ${kpiCount > 0 ? `<details class="ac-kpis"><summary>${kpiCount} KPI${kpiCount === 1 ? '' : 's'} anzeigen</summary><ul>${kpiHtml}</ul></details>` : ''}
  `;
  // Auto-save back to workspace meta when we're scoped to one.
  saveToWorkspace({
    classification: {
      label: data.label,
      confidence: data.confidence,
      summary: data.summary,
      kpis: data.kpis,
      valueCount: data.valueCount,
      mistralUsage: { total_tokens: data.tokens },
      ms: data.ms,
      classifiedAt: new Date().toISOString(),
    },
    ...(data.fileId ? { fileId: data.fileId } : {}),
  }, `classify=${data.label} (${(data.confidence * 100).toFixed(0)}%)`);
}

// ============ Pages validator ===============================================
if (els.cfg.pages) {
  els.cfg.pages.addEventListener('input', () => {
    if (els.cfg.pagesError) els.cfg.pagesError.textContent = '';
    const v = els.cfg.pages.value.trim();
    if (!v) return;
    try {
      parsePageRange(v);
    } catch (e) {
      if (els.cfg.pagesError) els.cfg.pagesError.textContent = e.message;
    }
    updateCostMeter();
  });
}

// ============ Build config ==================================================
function collectConfig() {
  const cfg = { model: els.cfg.model.value };

  const pagesVal = els.cfg.pages.value.trim();
  if (pagesVal) cfg.pages = parsePageRange(pagesVal);

  if (els.cfg.extractHeader.checked) cfg.extractHeader = true;
  if (els.cfg.extractFooter.checked) cfg.extractFooter = true;
  cfg.tableFormat = els.cfg.tableFormat.value;

  if (els.cfg.includeBase64.checked) cfg.includeImageBase64 = true;
  const minSize = numOrNull(els.cfg.imageMinSize.value);
  if (minSize !== null) cfg.imageMinSize = minSize;
  const limit = numOrNull(els.cfg.imageLimit.value);
  if (limit !== null) cfg.imageLimit = limit;

  if (els.cfg.confidence.value !== 'none') cfg.confidenceScoresGranularity = els.cfg.confidence.value;

  const builder = window.__schemaBuilder;
  if (builder) {
    const builderError = builder.getError?.();
    if (builderError) throw new Error(`Schema-JSON invalid: ${builderError}`);
    const schema = builder.getSchema?.();
    if (schema) {
      cfg.documentAnnotation = {
        schema,
        name: els.cfg.schemaName.value.trim() || undefined,
        prompt: els.cfg.prompt.value.trim() || undefined,
      };
    }
  }
  return cfg;
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parsePageRange(input) {
  const out = new Set();
  for (const part of input.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(trimmed);
    if (!m) throw new Error(`Ungültig: "${trimmed}"`);
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : start;
    if (start < 1) throw new Error('Seiten sind 1-indexiert');
    if (end < start) throw new Error(`Range invertiert: "${trimmed}"`);
    for (let i = start; i <= end; i++) out.add(i - 1);
  }
  return Array.from(out).sort((a, b) => a - b);
}

// ============ Cost meter (2.1) ==============================================
// Pricing model:
//   Mistral OCR ≈ $0.001/page → €0.00093/page
//   Schema generator (mistral-small-latest) ≈ €0.20/1M input tokens, x3 candidates
//   We expose a per-config estimate computed before run (no usage data yet).
const PAGE_COST_EUR = 0.00093;
function estimateCostEur() {
  // Use #pages if specified, else assume 1.
  let pages = 1;
  try {
    const v = els.cfg.pages.value.trim();
    if (v) pages = parsePageRange(v).length || 1;
  } catch { /* invalid range — fall through with 1 */ }
  let cost = pages * PAGE_COST_EUR;
  // Image base64 inflates response size but not Mistral price. tableFormat is free.
  // Confidence-word adds zero billing impact; stay simple.
  if (els.cfg.includeBase64?.checked) cost *= 1; // no markup
  return cost;
}

// Animated number morph — wraps requestAnimationFrame to ease from prev → next.
let _costAnim = null;
let _costShown = 0;
function updateCostMeter() {
  if (!els.costMeterValue) return;
  const target = estimateCostEur();
  const start = _costShown;
  const t0 = performance.now();
  const dur = 280;
  if (_costAnim) cancelAnimationFrame(_costAnim);
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const v = start + (target - start) * k;
    els.costMeterValue.textContent = `€${v.toFixed(4)}`;
    if (k < 1) _costAnim = requestAnimationFrame(tick);
    else { _costShown = target; _costAnim = null; }
  };
  _costAnim = requestAnimationFrame(tick);
}

// Wire all config inputs to recompute on change
['cfg-model','cfg-pages','cfg-extract-header','cfg-extract-footer','cfg-table-format',
 'cfg-include-base64','cfg-image-min-size','cfg-image-limit','cfg-confidence']
  .forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', updateCostMeter);
    if (el && el.tagName === 'INPUT') el.addEventListener('input', updateCostMeter);
  });

// ============ Run ===========================================================
function onRunClick() {
  if (!currentFile) {
    setStatus('error', 'Keine Datei ausgewählt — bitte zuerst eine PDF/Bilddatei wählen.');
    return;
  }
  let config;
  try { config = collectConfig(); }
  catch (e) {
    setStatus('error', e.message);
    return;
  }

  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();

  setStatus('running', 'preview wird gestartet…');
  els.runBtn.disabled = true;

  // Switch to Result tab so the user sees outputs land
  withTransition(() => activateRunTab('result'));

  const fd = new FormData();
  fd.append('file', currentFile);
  fd.append('config', JSON.stringify(config));

  fetch('/api/ocr/preview', { method: 'POST', body: fd, signal: activeAbort.signal })
    .then(async (resp) => {
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      }
      await consumeSse(resp.body, handleEvent);
    })
    .catch((e) => {
      if (e.name === 'AbortError') return;
      console.error('[studio] preview fetch failed:', e);
      setStatus('error', e.message);
    })
    .finally(() => {
      els.runBtn.disabled = false;
    });
}

function attachRunButton() {
  const btn = els.runBtn || $('run-btn');
  if (!btn) return false;
  if (btn.__sturmRunHandlerAttached) return true;
  btn.addEventListener('click', onRunClick);
  btn.__sturmRunHandlerAttached = true;
  return true;
}
if (!attachRunButton()) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachRunButton, { once: true });
  else setTimeout(attachRunButton, 0);
}

function handleEvent(event, data) {
  if (event === 'ocr_start') {
    setStatus('running', `${data.filename} (${formatBytes(data.size)})`);
  } else if (event === 'ocr_degraded') {
    setStatus('warn', `Degradiert: ${data.reason}`);
  } else if (event === 'ocr_done') {
    lastParsed = data;
    renderResult(data);
    tuning.lastPreview = data;
    refreshDiffTabVisibility();
    if (tuning.originalOutput) renderDiffPanel();
    const degraded = data.degradation ? ` · ⚠ ${data.degradation.strippedFields.join(',')} entfernt` : '';
    setStatus('ok', `${data.usage.pagesProcessed} Seiten · ${data.ms} ms · ${data.chars} chars${degraded}`);
    // Stage: drafting → reading once the first preview lands.
    setStage('reading');
    // Auto-save extraction back to workspace meta if scoped.
    saveToWorkspace({
      extraction: {
        ranAt: new Date().toISOString(),
        annotation: data.documentAnnotation ?? null,
        pages: data.pages?.length ?? data.usage?.pagesProcessed ?? 0,
        chars: data.chars ?? 0,
        ms: data.ms ?? 0,
        model: data.model,
        validationIssueCount: data.validation?.documentAnnotation?.length ?? 0,
        hallucinationCount: data.hallucinations?.length ?? 0,
        usage: data.usage,
        degradation: data.degradation ?? null,
      },
    }, `extract=${data.usage?.pagesProcessed ?? 0}p/${data.chars ?? 0}c (${data.model})`);
  } else if (event === 'ocr_error') {
    const detail = data.status ? `HTTP ${data.status}: ${data.message}` : data.message;
    setStatus('error', detail);
    if (data.body) els.out.raw.textContent = data.body;
  }
}

function renderResult(parsed) {
  // Annotation: prefer rich render with confidence bars (2.3); keep raw JSON pre as fallback
  if (parsed.documentAnnotation) {
    renderAnnotationRich(parsed);
    setHidden(els.out.annotation, true);
  } else {
    if (els.out.annotationRich) els.out.annotationRich.innerHTML = '<div class="muted">(kein Schema gesetzt → keine Annotation)</div>';
    els.out.annotation.textContent = '(kein Schema gesetzt → keine Annotation)';
    setHidden(els.out.annotation, true);
  }

  els.out.markdown.textContent = parsed.text || '(leer)';

  const links = collectAllLinks(parsed);
  els.out.links.innerHTML = '';
  if (links.length === 0) {
    els.out.links.innerHTML = '<li class="muted">Keine Links erkannt.</li>';
  } else {
    for (const url of links) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = url;
      li.appendChild(a); els.out.links.appendChild(li);
    }
  }

  renderQuality(parsed);
  els.out.raw.textContent = JSON.stringify(parsed.raw, null, 2);
  renderPageConfPill(parsed);
}

// ============ Page-confidence pill (2.2) ====================================
function renderPageConfPill(parsed) {
  const pill = els.pageConfPill;
  if (!pill) return;
  const granularity = els.cfg.confidence.value;
  if (granularity === 'none') { setHidden(pill, true); return; }
  const pages = parsed.raw?.pages ?? parsed.pages ?? [];
  const scores = pages
    .map((p) => p.confidence_scores?.average_page_confidence_score)
    .filter((n) => typeof n === 'number');
  if (scores.length === 0) { setHidden(pill, true); return; }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  pill.textContent = `${(avg * 100).toFixed(1)}%`;
  pill.classList.remove('conf-good','conf-warn','conf-bad');
  if (avg >= 0.95) pill.classList.add('conf-good');
  else if (avg >= 0.7) pill.classList.add('conf-warn');
  else pill.classList.add('conf-bad');
  setHidden(pill, false);
}

// ============ Annotation rich (2.3 + 2.4) ===================================
function renderAnnotationRich(parsed) {
  const el = els.out.annotationRich;
  if (!el) return;
  const ann = parsed.documentAnnotation;
  if (!ann || typeof ann !== 'object') {
    el.innerHTML = '<div class="muted">(leere Annotation)</div>';
    return;
  }
  const text = parsed.text || '';
  const wordScores = collectWordScores(parsed);
  const rows = [];
  flattenAnnotation(ann, '$', rows);
  el.innerHTML = '';
  for (const row of rows) {
    el.appendChild(buildAnnotationRow(row, text, wordScores));
  }
}

function collectWordScores(parsed) {
  const out = [];
  let pageOffset = 0;
  const pages = parsed.raw?.pages ?? parsed.pages ?? [];
  const text = parsed.text || '';
  // Note: parsed.text concatenates pages; we approximate per-page offsets by
  // searching each page's first word. For coupling/confidence purposes, page-
  // level offsets are good enough.
  for (const page of pages) {
    const ws = page.confidence_scores?.word_confidence_scores;
    if (!Array.isArray(ws) || ws.length === 0) continue;
    // Try to anchor this page by finding the first word in the global text
    const firstWord = ws.find((w) => w.text && w.text.trim())?.text?.trim();
    let base = 0;
    if (firstWord) {
      const idx = text.indexOf(firstWord, pageOffset);
      base = idx >= 0 ? idx - (ws.find((w) => w.text && w.text.trim())?.start_index ?? 0) : pageOffset;
    } else base = pageOffset;
    for (const w of ws) {
      out.push({
        text: w.text || '',
        confidence: typeof w.confidence === 'number' ? w.confidence : null,
        start: base + (w.start_index ?? 0),
      });
    }
    pageOffset = base + (ws[ws.length - 1].start_index ?? 0) + (ws[ws.length - 1].text?.length ?? 0);
  }
  return out;
}

function flattenAnnotation(node, path, out) {
  if (node === null || node === undefined) {
    out.push({ path, value: null });
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) { out.push({ path, value: '[]' }); return; }
    node.forEach((item, i) => flattenAnnotation(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node);
    if (keys.length === 0) { out.push({ path, value: '{}' }); return; }
    for (const k of keys) flattenAnnotation(node[k], `${path}.${k}`, out);
    return;
  }
  out.push({ path, value: node });
}

function buildAnnotationRow(row, text, wordScores) {
  const div = document.createElement('div');
  div.className = 'ann-row';
  div.dataset.fieldPath = row.path;
  div.tabIndex = 0;

  const key = document.createElement('div');
  key.className = 'ann-key';
  key.textContent = row.path;
  div.appendChild(key);

  const wrap = document.createElement('div');
  wrap.className = 'ann-val-wrap';
  const val = document.createElement('div');
  val.className = 'ann-val';
  if (row.value === null || row.value === undefined) { val.classList.add('is-null'); val.textContent = 'null'; }
  else val.textContent = String(row.value);
  wrap.appendChild(val);

  // Confidence bar
  const meta = document.createElement('div');
  meta.className = 'ann-val-meta';
  const bar = document.createElement('div');
  bar.className = 'ann-conf-bar';
  const fill = document.createElement('div');
  bar.appendChild(fill);
  const pct = document.createElement('span');
  pct.className = 'ann-conf-pct';

  const valueStr = row.value === null || row.value === undefined ? '' : String(row.value);
  const matched = valueStr ? matchValueToWords(valueStr, text, wordScores) : null;
  if (matched && matched.scores.length > 0) {
    const avg = matched.scores.reduce((a, b) => a + b, 0) / matched.scores.length;
    fill.style.width = `${Math.round(avg * 100)}%`;
    if (avg >= 0.95) bar.classList.add('conf-good');
    else if (avg >= 0.7) bar.classList.add('conf-warn');
    else bar.classList.add('conf-bad');
    pct.textContent = `${(avg * 100).toFixed(0)}%`;
    if (avg < 0.7) {
      const tog = document.createElement('button');
      tog.className = 'ann-conf-toggle';
      tog.type = 'button';
      tog.textContent = '▾';
      const popId = `ann-pop-${Math.random().toString(36).slice(2, 9)}`;
      const pop = document.createElement('div');
      pop.id = popId; pop.className = 'ann-pop'; pop.setAttribute('popover', 'auto');
      pop.innerHTML = `<h5>Wort-Confidence</h5><ul>${matched.tokens.map((t) =>
        `<li><span>${escapeHtml(t.text)}</span><span class="pct">${(t.confidence*100).toFixed(0)}%</span></li>`).join('')}</ul>`;
      document.body.appendChild(pop);
      tog.setAttribute('popovertarget', popId);
      meta.appendChild(tog);
    }
  } else {
    bar.classList.add('is-na');
    fill.style.width = '100%';
    pct.textContent = '—';
  }
  meta.appendChild(bar);
  meta.appendChild(pct);
  wrap.appendChild(meta);
  div.appendChild(wrap);

  // Hover/click → flash in Markdown tab (2.4)
  div.addEventListener('mouseenter', () => {
    document.querySelectorAll('.ann-row').forEach((r) => r.classList.remove('is-active'));
    div.classList.add('is-active');
    flashFieldInMarkdown(valueStr, false);
  });
  div.addEventListener('mouseleave', () => {
    div.classList.remove('is-active');
    if (!div.classList.contains('is-pinned')) clearFlash(false);
  });
  div.addEventListener('click', () => {
    document.querySelectorAll('.ann-row').forEach((r) => r.classList.remove('is-pinned'));
    div.classList.add('is-pinned');
    withTransition(() => activateResultTab('markdown'));
    flashFieldInMarkdown(valueStr, true);
  });
  div.addEventListener('focus', () => {
    document.querySelectorAll('.ann-row').forEach((r) => r.classList.remove('is-active'));
    div.classList.add('is-active');
    flashFieldInMarkdown(valueStr, false);
  });

  return div;
}

function matchValueToWords(valueStr, text, wordScores) {
  if (!valueStr || !text || wordScores.length === 0) return null;
  const idx = text.indexOf(valueStr);
  if (idx < 0) return null;
  const end = idx + valueStr.length;
  const tokens = [];
  for (const w of wordScores) {
    if (w.start >= end) break;
    const wEnd = w.start + (w.text?.length ?? 0);
    if (wEnd <= idx) continue;
    if (typeof w.confidence === 'number') tokens.push(w);
  }
  return { scores: tokens.map((t) => t.confidence), tokens };
}

function flashFieldInMarkdown(valueStr, pinned) {
  if (!valueStr || !els.out.markdown) return;
  clearFlash(true);
  const pre = els.out.markdown;
  const text = pre.textContent || '';
  const idx = text.indexOf(valueStr);
  if (idx < 0) return;
  // Rebuild pre with a mark in place. Safe because pre.textContent is plain text.
  const before = text.slice(0, idx);
  const middle = text.slice(idx, idx + valueStr.length);
  const after = text.slice(idx + valueStr.length);
  pre.textContent = '';
  pre.append(document.createTextNode(before));
  const mark = document.createElement('mark');
  mark.className = 'sturm-field-flash' + (pinned ? ' is-pinned' : '');
  mark.textContent = middle;
  pre.appendChild(mark);
  pre.append(document.createTextNode(after));
  // Scroll into view if Markdown panel is visible
  mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (!pinned) {
    setTimeout(() => { if (!mark.classList.contains('is-pinned')) clearFlash(false); }, 1600);
  }
}

function clearFlash(rebuild) {
  if (!els.out.markdown || !lastParsed) return;
  const pre = els.out.markdown;
  if (rebuild) {
    pre.textContent = lastParsed.text || '(leer)';
  } else {
    pre.textContent = lastParsed.text || '(leer)';
  }
}

function collectAllLinks(parsed) {
  const out = [];
  for (const p of parsed.pages ?? []) for (const link of p.hyperlinks ?? []) out.push(link);
  return Array.from(new Set(out));
}

function renderQuality(parsed) {
  const validationIssues = parsed.validation?.documentAnnotation ?? [];
  const halls = parsed.hallucinations ?? [];
  const cost = (parsed.usage?.pagesProcessed ?? 0) * 0.001;

  const cards = `
    <div class="quality-grid">
      <div class="quality-card">
        <h4>Latenz</h4>
        <div class="v">${parsed.ms} ms</div>
        <div class="sub">${parsed.usage?.pagesProcessed ?? 0} Seiten verarbeitet</div>
      </div>
      <div class="quality-card">
        <h4>Geschätzte Kosten</h4>
        <div class="v">$${cost.toFixed(4)}</div>
        <div class="sub">@ $0.001 / Seite (Annahme)</div>
      </div>
      <div class="quality-card ${validationIssues.length > 0 ? 'warn' : ''}">
        <h4>Schema-Validierung</h4>
        <div class="v">${validationIssues.length === 0 ? '✓' : validationIssues.length}</div>
        <div class="sub">${validationIssues.length === 0 ? 'alle Felder OK' : 'Verstöße'}</div>
      </div>
      <div class="quality-card ${halls.length > 0 ? 'alarm' : ''}">
        <h4>Halluzinations-Flag</h4>
        <div class="v">${halls.length === 0 ? '✓' : halls.length}</div>
        <div class="sub">Werte nicht im OCR-Text</div>
      </div>
    </div>
  `;
  let issuesHtml = '';
  if (validationIssues.length > 0) {
    issuesHtml += '<h4 style="margin:18px 0 6px;font-size:12px;color:var(--text-muted)">Validierungsfehler</h4><ul class="issue-list">';
    for (const i of validationIssues.slice(0, 30)) {
      issuesHtml += `<li><span class="path">${escapeHtml(i.path)}</span> <span class="msg">${escapeHtml(i.message)}</span></li>`;
    }
    if (validationIssues.length > 30) issuesHtml += `<li class="muted">…und ${validationIssues.length - 30} weitere</li>`;
    issuesHtml += '</ul>';
  }
  if (halls.length > 0) {
    issuesHtml += '<h4 style="margin:18px 0 6px;font-size:12px;color:var(--text-muted)">Mögliche Halluzinationen</h4><ul class="issue-list">';
    for (const h of halls.slice(0, 30)) {
      issuesHtml += `<li><span class="path">${escapeHtml(h.path)}</span> <span class="msg">→ ${escapeHtml(h.value)}</span></li>`;
    }
    if (halls.length > 30) issuesHtml += `<li class="muted">…und ${halls.length - 30} weitere</li>`;
    issuesHtml += '</ul>';
  }
  els.out.quality.innerHTML = cards + issuesHtml;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function consumeSse(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sepIdx;
    while ((sepIdx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, sepIdx);
      buf = buf.slice(sepIdx + 2);
      const lines = block.split('\n');
      let event = 'message';
      let dataLines = [];
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let data;
      try { data = JSON.parse(dataLines.join('\n')); }
      catch { data = dataLines.join('\n'); }
      onEvent(event, data);
    }
  }
}

function setStatus(state, msg) {
  els.statusPill.className = `status-pill status-${state}`;
  els.statusPill.textContent = state;
  els.statusMeta.textContent = msg ?? '';
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ============ Deep-link prefill =============================================
function applyConfigToForm(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  if (cfg.model) els.cfg.model.value = cfg.model;
  if (Array.isArray(cfg.pages) && cfg.pages.length > 0) {
    els.cfg.pages.value = cfg.pages.map((n) => n + 1).join(',');
  }
  els.cfg.extractHeader.checked = !!cfg.extractHeader;
  els.cfg.extractFooter.checked = !!cfg.extractFooter;
  if (cfg.tableFormat) els.cfg.tableFormat.value = cfg.tableFormat;
  els.cfg.includeBase64.checked = !!cfg.includeImageBase64;
  if (cfg.imageMinSize != null) els.cfg.imageMinSize.value = String(cfg.imageMinSize);
  if (cfg.imageLimit != null) els.cfg.imageLimit.value = String(cfg.imageLimit);
  els.cfg.confidence.value = cfg.confidenceScoresGranularity || 'none';

  const docAnn = cfg.documentAnnotation;
  const schema = docAnn?.schema ?? cfg.schema;
  const schemaName = docAnn?.name ?? cfg.schemaName;
  const prompt = docAnn?.prompt;
  if (schemaName) els.cfg.schemaName.value = schemaName;
  if (prompt) els.cfg.prompt.value = prompt;
  if (schema !== undefined) setBuilderSchema(schema);
  updateCostMeter();
}

function setBuilderSchema(schema) {
  if (window.__schemaBuilder?.setSchema) {
    window.__schemaBuilder.setSchema(schema);
  } else {
    window.__schemaBuilderQueue = window.__schemaBuilderQueue || [];
    window.__schemaBuilderQueue.push(schema);
  }
}

function showTuningContext({ workflowId, stageId, runId }) {
  const ctx = $('tuning-context');
  const back = $('back-to-pipeline');
  const title = $('studio-title');
  const badge = $('studio-badge');
  if (!ctx) return;
  ctx.classList.remove('hidden');
  ctx.innerHTML = runId
    ? `Tuning <strong>${escapeHtml(workflowId)}</strong> → <strong>${escapeHtml(stageId)}</strong> · run <strong>${escapeHtml(runId)}</strong>`
    : `Tuning <strong>${escapeHtml(workflowId)}</strong> → <strong>${escapeHtml(stageId)}</strong>`;
  if (back && workflowId) back.href = `/pipeline.html?workflow=${encodeURIComponent(workflowId)}`;
  if (title) title.textContent = 'OCR Studio';
  if (badge) badge.textContent = 'Tuning';
}

async function loadFileFromRun(workflowId, runId) {
  const metaResp = await fetch(`/api/runs/${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}/_input.json`);
  if (!metaResp.ok) throw new Error(`input metadata not available (HTTP ${metaResp.status})`);
  const meta = await metaResp.json();
  const fileResp = await fetch(`/api/runs/${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}/_input/${encodeURIComponent(meta.filename)}`);
  if (!fileResp.ok) throw new Error(`input file not available (HTTP ${fileResp.status})`);
  const blob = await fileResp.blob();
  const file = new File([blob], meta.originalFilename || meta.filename, { type: meta.mime || blob.type });
  loadFile(file);
}

async function loadStageConfig(workflowId, stageId) {
  const resp = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/stages/${encodeURIComponent(stageId)}/config`);
  if (!resp.ok) throw new Error(`stage config not available (HTTP ${resp.status})`);
  const data = await resp.json();
  applyConfigToForm(data.config || {});
  tuning.hasOverride = !!data.hasOverride;
  refreshOverrideUi();
  return data;
}

async function loadOriginalOutput(workflowId, runId, stageId) {
  const resp = await fetch(`/api/runs/${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/output`);
  if (!resp.ok) return null;
  return await resp.json();
}

function refreshOverrideUi() {
  setHidden(els.overridePill, !tuning.hasOverride);
  setHidden(els.revertBtn, !tuning.hasOverride || !tuning.workflowId);
}

function showTuningButtons() {
  if (tuning.workflowId && tuning.stageId) setHidden(els.applyBtn, false);
  if (tuning.runId) setHidden(els.rerunBtn, false);
}

function refreshDiffTabVisibility() {
  const showTab = !!(tuning.originalOutput && tuning.lastPreview);
  setHidden(els.tabDiff, !showTab);
  if (!showTab && els.tabDiff?.classList.contains('active')) {
    activateResultTab('annotation');
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const fromParam = params.get('from');
  const stageParam = params.get('stage');
  const workflowParam = params.get('workflow');

  if (fromParam && fromParam.startsWith('run:') && stageParam) {
    const [, workflowId, runId] = fromParam.split(':');
    if (!workflowId || !runId) return;
    tuning.workflowId = workflowId; tuning.stageId = stageParam; tuning.runId = runId;
    showTuningContext({ workflowId, stageId: stageParam, runId });
    showTuningButtons();
    setStatus('running', 'Lade Run-Input, Stage-Config und Original-Output…');
    try {
      const [, , original] = await Promise.all([
        loadFileFromRun(workflowId, runId),
        loadStageConfig(workflowId, stageParam),
        loadOriginalOutput(workflowId, runId, stageParam),
      ]);
      tuning.originalOutput = original;
      refreshDiffTabVisibility();
      if (original) renderDiffPanel();
      setStatus('idle', 'Bereit. Tweak und Preview ausführen.');
    } catch (e) {
      setStatus('error', `Prefill fehlgeschlagen: ${e.message}`);
    }
    return;
  }

  if (workflowParam && stageParam) {
    tuning.workflowId = workflowParam; tuning.stageId = stageParam;
    showTuningContext({ workflowId: workflowParam, stageId: stageParam });
    showTuningButtons();
    setStatus('running', 'Lade Stage-Config…');
    try {
      await loadStageConfig(workflowParam, stageParam);
      setStatus('idle', 'Bereit. Datei wählen und Preview ausführen.');
    } catch (e) {
      setStatus('error', `Prefill fehlgeschlagen: ${e.message}`);
    }
    return;
  }
}

// ============ Tuning actions: Apply / Revert / Re-run =======================
els.applyBtn?.addEventListener('click', async () => {
  if (!tuning.workflowId || !tuning.stageId) return;
  let cfg;
  try { cfg = collectConfig(); }
  catch (e) { toast(`Konfiguration ungültig: ${e.message}`, 'error'); return; }
  if (!confirm(`Konfiguration als Override für ${tuning.workflowId}/${tuning.stageId} speichern?`)) return;
  els.applyBtn.disabled = true;
  try {
    const resp = await fetch(`/api/workflows/${encodeURIComponent(tuning.workflowId)}/stages/${encodeURIComponent(tuning.stageId)}/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: cfg }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    tuning.hasOverride = true; refreshOverrideUi();
    toast(`Override für ${tuning.stageId} gespeichert.`, 'success');
  } catch (e) { toast(`Speichern fehlgeschlagen: ${e.message}`, 'error'); }
  finally { els.applyBtn.disabled = false; }
});

els.revertBtn?.addEventListener('click', async () => {
  if (!tuning.workflowId || !tuning.stageId) return;
  if (!confirm(`Override für ${tuning.workflowId}/${tuning.stageId} entfernen?`)) return;
  els.revertBtn.disabled = true;
  try {
    const resp = await fetch(`/api/workflows/${encodeURIComponent(tuning.workflowId)}/stages/${encodeURIComponent(tuning.stageId)}/config`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    tuning.hasOverride = false; refreshOverrideUi();
    toast(`Override entfernt — Workflow-Quelle ist wieder aktiv.`, 'success');
    if (tuning.workflowId && tuning.stageId) await loadStageConfig(tuning.workflowId, tuning.stageId);
  } catch (e) { toast(`Revert fehlgeschlagen: ${e.message}`, 'error'); }
  finally { els.revertBtn.disabled = false; }
});

els.rerunBtn?.addEventListener('click', async () => {
  if (!tuning.workflowId || !currentFile) return;
  if (!confirm(`Eingabe nochmal durch ${tuning.workflowId} laufen lassen?`)) return;
  els.rerunBtn.disabled = true;
  toast(`Starte Re-Run von ${tuning.workflowId}…`, 'success');
  try {
    const fd = new FormData();
    fd.append('file', currentFile);
    const resp = await fetch(`/api/workflows/${encodeURIComponent(tuning.workflowId)}/run`, { method: 'POST', body: fd });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
    let newRunId = null;
    await consumeSse(resp.body, (event, data) => {
      if (event === 'run_meta' && data?.runId) {
        newRunId = data.runId;
        toast(`Run gestartet: <strong>${escapeHtml(newRunId)}</strong>`, 'success', 8000);
      } else if (event === 'run_done') {
        toast(`Run <strong>${escapeHtml(newRunId)}</strong> fertig.`, 'success', 12000);
      } else if (event === 'run_error' || event === 'stage_error') {
        toast(`Re-Run-Fehler: ${escapeHtml(data?.message ?? 'unbekannt')}`, 'error', 10000);
      }
    });
  } catch (e) { toast(`Re-Run fehlgeschlagen: ${e.message}`, 'error'); }
  finally { els.rerunBtn.disabled = false; }
});

// ============ Toast =========================================================
function toast(html, kind = 'success', durationMs = 4000) {
  if (!els.toastContainer) return;
  const div = document.createElement('div');
  div.className = `toast toast-${kind}`;
  div.innerHTML = html;
  els.toastContainer.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transition = 'opacity 0.2s';
    setTimeout(() => div.remove(), 200);
  }, durationMs);
}

// ============ Diff against original output ==================================
function diffParsedOutputs(originalParsed, currentParsed) {
  const a = originalParsed?.documentAnnotation ?? originalParsed?.annotation ?? null;
  const b = currentParsed?.documentAnnotation ?? null;
  const result = { added: [], removed: [], changed: [] };
  walk(a, b, '$', result);
  return result;
}
function walk(a, b, path, out) {
  if (a === undefined && b === undefined) return;
  if (a === undefined) { out.added.push({ path, value: b }); return; }
  if (b === undefined) { out.removed.push({ path, value: a }); return; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (!deepEqual(a, b)) out.changed.push({ path, old: a, new: b });
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!deepEqual(a, b)) out.changed.push({ path, old: a, new: b });
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) walk(a[k], b[k], `${path}.${k}`, out);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function renderDiffPanel() {
  const el = els.out.diff;
  if (!el) return;
  if (!tuning.originalOutput) { el.innerHTML = '<div class="muted">Kein Original-Output verfügbar.</div>'; return; }
  if (!tuning.lastPreview) { el.innerHTML = '<div class="muted">Preview ausführen, um Änderungen vs. Original zu sehen.</div>'; return; }
  const d = diffParsedOutputs(tuning.originalOutput, tuning.lastPreview);
  const total = d.added.length + d.removed.length + d.changed.length;
  if (total === 0) { el.innerHTML = '<div class="diff-summary"><span><strong>Identisch</strong> — keine Änderungen vs. Original.</span></div>'; return; }
  let html = `
    <div class="diff-summary">
      <span><strong>${d.added.length}</strong> hinzugefügt</span>
      <span><strong>${d.removed.length}</strong> entfernt</span>
      <span><strong>${d.changed.length}</strong> geändert</span>
    </div>`;
  if (d.changed.length > 0) {
    html += '<div class="diff-section"><h4>Geändert</h4><ul class="diff-list">';
    for (const c of d.changed.slice(0, 50)) {
      html += `<li class="diff-row changed"><span class="marker">~</span><div>
        <div class="diff-path">${escapeHtml(c.path)}</div>
        <div class="diff-old">- ${escapeHtml(formatValue(c.old))}</div>
        <div class="diff-new">+ ${escapeHtml(formatValue(c.new))}</div>
      </div></li>`;
    }
    if (d.changed.length > 50) html += `<li class="muted">…und ${d.changed.length - 50} weitere</li>`;
    html += '</ul></div>';
  }
  if (d.added.length > 0) {
    html += '<div class="diff-section"><h4>Hinzugefügt</h4><ul class="diff-list">';
    for (const c of d.added.slice(0, 50)) {
      html += `<li class="diff-row added"><span class="marker">+</span><div>
        <div class="diff-path">${escapeHtml(c.path)}</div>
        <div class="diff-new">${escapeHtml(formatValue(c.value))}</div>
      </div></li>`;
    }
    if (d.added.length > 50) html += `<li class="muted">…und ${d.added.length - 50} weitere</li>`;
    html += '</ul></div>';
  }
  if (d.removed.length > 0) {
    html += '<div class="diff-section"><h4>Entfernt</h4><ul class="diff-list">';
    for (const c of d.removed.slice(0, 50)) {
      html += `<li class="diff-row removed"><span class="marker">−</span><div>
        <div class="diff-path">${escapeHtml(c.path)}</div>
        <div class="diff-old">${escapeHtml(formatValue(c.value))}</div>
      </div></li>`;
    }
    if (d.removed.length > 50) html += `<li class="muted">…und ${d.removed.length - 50} weitere</li>`;
    html += '</ul></div>';
  }
  el.innerHTML = html;
}

function formatValue(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v.length > 140 ? v.slice(0, 140) + '…' : v;
  if (typeof v === 'object') { const s = JSON.stringify(v); return s.length > 140 ? s.slice(0, 140) + '…' : s; }
  return String(v);
}

// ============ Templates dropdown ============================================
let _templates = [];

// Map template-id-prefix to thumbnail-class + tiny SVG-ish skeleton.
function _thumbForTemplate(t) {
  const id = t.id || '';
  if (id.startsWith('belege/rechnung')) {
    return `<div class="empty-thumb empty-thumb-invoice" aria-hidden="true">
      <span class="t-block t-head"></span>
      <span class="t-line t-w60"></span>
      <span class="t-line t-w40"></span>
      <span class="t-table"><span></span><span></span><span></span><span></span><span></span><span></span></span>
      <span class="t-line t-w30 t-right"></span>
    </div>`;
  }
  if (id.startsWith('belege/spende') || id.includes('spende')) {
    return `<div class="empty-thumb empty-thumb-receipt" aria-hidden="true">
      <span class="t-stamp"></span>
      <span class="t-line t-w80"></span>
      <span class="t-line t-w60"></span>
      <span class="t-amount"></span>
      <span class="t-line t-w50"></span>
    </div>`;
  }
  // Default: ELSTER-style "form" skeleton.
  return `<div class="empty-thumb empty-thumb-form" aria-hidden="true">
    <span class="t-line t-w70"></span>
    <span class="t-line t-w90"></span>
    <span class="t-line t-w50"></span>
    <span class="t-line t-w80"></span>
    <span class="t-line t-w40"></span>
  </div>`;
}

function _renderEmptyCards() {
  const grid = document.getElementById('empty-cards');
  if (!grid) return;
  grid.innerHTML = '';
  if (!_templates.length) {
    grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--color-text-tertiary); padding: 24px;">Keine Vorlagen verfügbar.</div>';
    return;
  }
  for (const t of _templates) {
    const btn = document.createElement('button');
    btn.className = 'empty-card';
    btn.type = 'button';
    btn.dataset.templateId = t.id;
    if (t.description) btn.title = t.description;
    const subParts = [];
    // Try to derive a short "sub" line from the schema's top-level properties.
    try {
      const props = t?.schema?.properties || {};
      const keys = Object.keys(props).slice(0, 3);
      if (keys.length) subParts.push(keys.join(', '));
    } catch { /* ignore */ }
    const sub = subParts.join(' · ') || (t.description || '').slice(0, 50);
    btn.innerHTML = `
      ${_thumbForTemplate(t)}
      <div class="empty-card-title">${escapeHtml(t.name || t.id)}</div>
      <div class="empty-card-sub">${escapeHtml(sub)}</div>
      <span class="empty-card-cta">Schema laden →</span>
    `;
    btn.addEventListener('click', () => _onCardClick(t.id));
    grid.appendChild(btn);
  }
}

async function _onCardClick(id) {
  if (!id) return;
  const ok = applyTemplateById(id);
  if (!ok) { toast(`Vorlage nicht verfügbar: ${escapeHtml(id)} — lege manuell ein Schema an.`, 'warn'); return; }
  const sel = $('cfg-template');
  if (sel) sel.value = id;
  // S2 fix: in empty-stage the schema-pane is display:none via stages.css.
  // Replace the card grid with a prominent confirmation + file-CTA.
  const t = _templates.find((x) => x.id === id);
  const grid = document.getElementById('empty-cards');
  if (grid && t) {
    const props = t?.schema?.properties ? Object.keys(t.schema.properties) : [];
    const fieldList = props.length
      ? `<div style="font-size: 12px; color: var(--color-text-secondary); margin-top: 8px;">${props.length} Felder: <code style="font-family: var(--font-mono); font-size: 11.5px;">${props.slice(0, 8).map(escapeHtml).join(', ')}${props.length > 8 ? `, … +${props.length - 8}` : ''}</code></div>`
      : '';
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 24px; border: 1px solid var(--border, #21262d); border-radius: 8px; background: var(--surface-2, rgba(88, 166, 255, 0.04));">
        <div style="display: flex; align-items: flex-start; gap: 12px;">
          <span style="display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: rgba(46, 160, 67, 0.18); color: var(--color-success, #2ea043); flex-shrink: 0; font-size: 16px;">✓</span>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; font-size: 14px; color: var(--color-text-primary);">Vorlage geladen: ${escapeHtml(t.name || t.id)}</div>
            <div style="font-size: 12px; color: var(--color-text-tertiary); margin-top: 2px;">${escapeHtml(t.description || '')}</div>
            ${fieldList}
            <div style="margin-top: 16px; display: flex; gap: 12px; flex-wrap: wrap;">
              <button type="button" class="btn-primary" id="empty-confirm-pickfile">Datei wählen …</button>
              <button type="button" class="btn-secondary" id="empty-confirm-back">Andere Vorlage</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('empty-confirm-pickfile')?.addEventListener('click', () => {
      const fi = document.getElementById('file-input') || document.querySelector('input[type="file"]');
      if (fi) fi.click();
    });
    document.getElementById('empty-confirm-back')?.addEventListener('click', () => {
      _renderEmptyCards();
    });
  }
  toast(`Vorlage geladen: ${escapeHtml(t?.name || id)}. Jetzt Datei wählen.`, 'success', 4000);
}

async function loadTemplates() {
  const sel = $('cfg-template');
  try {
    const resp = await fetch('/api/studio/templates');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    _templates = data.templates || [];
    if (sel) {
      for (const t of _templates) {
        const opt = document.createElement('option');
        opt.value = t.id; opt.textContent = t.name; opt.title = t.description || '';
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => applyTemplateById(sel.value));
    }
  } catch (e) {
    console.warn('[studio] failed to load templates:', e);
    const grid = document.getElementById('empty-cards');
    if (grid) grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--color-text-tertiary); padding: 24px;">Konnte Vorlagen nicht laden: ${escapeHtml(String(e.message || e))}</div>`;
    return;
  }
  _renderEmptyCards();
}

function applyTemplateById(id) {
  const t = _templates.find((x) => x.id === id);
  if (!t) return false;
  setBuilderSchema(t.schema);
  if (t.defaultPrompt) els.cfg.prompt.value = t.defaultPrompt;
  const lastSeg = t.id.split('/').pop();
  if (lastSeg) els.cfg.schemaName.value = lastSeg;
  toast(`Vorlage geladen: <strong>${escapeHtml(t.name)}</strong>`, 'success', 3000);
  return true;
}

// ============ Save schema ===================================================
const saveSchemaBtn = $('save-schema-btn');
saveSchemaBtn?.addEventListener('click', async () => {
  const builder = window.__schemaBuilder;
  const schema = builder?.getSchema?.();
  if (!schema) { toast('Kein Schema im Builder.', 'error'); return; }
  const id = window.prompt('Schema-ID (z.B. elster/anlagen-klassifizierung):', '');
  if (!id) return;
  if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(id)) { toast('Ungültige ID.', 'error'); return; }
  saveSchemaBtn.disabled = true;
  try {
    const resp = await fetch(`/api/schemas/${encodeURI(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema, name: els.cfg.schemaName.value.trim() || undefined, defaultPrompt: els.cfg.prompt.value.trim() || undefined }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    toast(`Schema gespeichert: <strong>${escapeHtml(id)}</strong> @ <strong>${escapeHtml(data.version)}</strong>`, 'success', 5000);
  } catch (e) { toast(`Speichern fehlgeschlagen: ${e.message}`, 'error'); }
  finally { saveSchemaBtn.disabled = false; }
});

// ============ Variants A/B/N ================================================
const variants = [];
let activeVariantIdx = -1;
const variantsRail = $('variants-rail');
const variantsList = $('variants-list');
const variantsAddBtn = $('variants-add');
const variantsRunBtn = $('variants-run');
const variantsCloseBtn = $('variants-close');
const addVariantBtn = $('add-variant-btn');
const tabVariants = $('tab-variants');

function nextVariantName() {
  const letters = 'ABCDEFGHIJ';
  return `Variant ${letters[variants.length] || (variants.length + 1)}`;
}
function captureCurrentConfig() {
  try { return collectConfig(); }
  catch (e) { toast(`Konfiguration ungültig: ${e.message}`, 'error'); return null; }
}
function renderVariantsRail() {
  if (!variantsList) return;
  variantsList.innerHTML = '';
  variants.forEach((v, i) => {
    const li = document.createElement('li');
    if (i === activeVariantIdx) li.classList.add('active');
    li.innerHTML = `<div><div class="vname">${escapeHtml(v.name)}</div><div class="vmeta">${escapeHtml(v.id)}</div></div>`;
    const rm = document.createElement('button');
    rm.className = 'vremove'; rm.title = 'Entfernen'; rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      variants.splice(i, 1);
      if (activeVariantIdx === i) activeVariantIdx = -1;
      else if (activeVariantIdx > i) activeVariantIdx--;
      renderVariantsRail();
    });
    li.appendChild(rm);
    li.addEventListener('click', () => {
      if (activeVariantIdx >= 0 && variants[activeVariantIdx]) {
        const cur = captureCurrentConfig();
        if (cur) variants[activeVariantIdx].config = cur;
      }
      activeVariantIdx = i;
      applyConfigToForm(v.config);
      renderVariantsRail();
    });
    variantsList.appendChild(li);
  });
}
function openVariantsRail() {
  setHidden(variantsRail, false);
  if (variants.length === 0) addVariantFromCurrent();
  renderVariantsRail();
}
function addVariantFromCurrent() {
  if (variants.length >= 5) { toast('Max. 5 Varianten.', 'error'); return; }
  const cfg = captureCurrentConfig();
  if (!cfg) return;
  const id = `v${Date.now().toString(36)}_${variants.length}`;
  variants.push({ id, name: nextVariantName(), config: cfg });
  renderVariantsRail();
}
addVariantBtn?.addEventListener('click', openVariantsRail);
variantsAddBtn?.addEventListener('click', addVariantFromCurrent);
variantsCloseBtn?.addEventListener('click', () => withTransition(() => setHidden(variantsRail, true)));

variantsRunBtn?.addEventListener('click', async () => {
  if (!currentFile) { toast('Bitte zuerst eine Datei wählen.', 'error'); return; }
  if (activeVariantIdx >= 0 && variants[activeVariantIdx]) {
    const cur = captureCurrentConfig();
    if (cur) variants[activeVariantIdx].config = cur;
  }
  if (variants.length === 0) { toast('Keine Variants.', 'error'); return; }

  variantsRunBtn.disabled = true;
  setHidden(tabVariants, false);
  withTransition(() => activateRunTab('variants'));
  const out = $('out-variants');
  if (out) out.innerHTML = '<div class="muted">Läuft…</div>';

  const results = new Map();
  const startedAt = Date.now();
  const fd = new FormData();
  fd.append('file', currentFile);
  fd.append('variants', JSON.stringify(variants.map((v) => ({ id: v.id, config: v.config }))));

  try {
    const resp = await fetch('/api/ocr/preview/batch', { method: 'POST', body: fd });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    await consumeSse(resp.body, (event, data) => {
      if (event === 'variant_done') { results.set(data.variantId, { parsed: data.parsed }); renderVariantsTable(results); }
      else if (event === 'variant_error') { results.set(data.variantId, { error: data.message }); renderVariantsTable(results); }
      else if (event === 'batch_done') { toast(`Batch fertig in ${data.totalMs} ms`, 'success', 4000); }
    });
  } catch (e) {
    toast(`Batch fehlgeschlagen: ${e.message}`, 'error');
    if (out) out.innerHTML = `<div class="muted">Fehler: ${escapeHtml(e.message)}</div>`;
  } finally {
    variantsRunBtn.disabled = false;
    console.log('[studio] batch wall time:', Date.now() - startedAt, 'ms');
  }
});

function renderVariantsTable(results) {
  const out = $('out-variants');
  if (!out) return;
  let html = '<table class="variants-table"><thead><tr>'
    + '<th>Variante</th><th>Status</th><th class="num">ms</th><th class="num">Seiten</th>'
    + '<th class="num">Validierung</th><th class="num">Halluzinationen</th><th class="num">$</th></tr></thead><tbody>';
  for (const v of variants) {
    const r = results.get(v.id);
    if (!r) html += `<tr><td>${escapeHtml(v.name)}</td><td class="muted">…</td><td colspan="5" class="muted">läuft</td></tr>`;
    else if (r.error) html += `<tr class="error"><td>${escapeHtml(v.name)}</td><td>error</td><td colspan="5">${escapeHtml(r.error)}</td></tr>`;
    else {
      const p = r.parsed;
      const cost = (p.usage?.pagesProcessed ?? 0) * 0.001;
      const valIssues = p.validation?.documentAnnotation?.length ?? 0;
      const halls = p.hallucinations?.length ?? 0;
      html += `<tr><td>${escapeHtml(v.name)}</td><td>ok</td><td class="num">${p.ms}</td><td class="num">${p.usage?.pagesProcessed ?? 0}</td><td class="num">${valIssues}</td><td class="num">${halls}</td><td class="num">$${cost.toFixed(4)}</td></tr>`;
    }
  }
  html += '</tbody></table>';
  out.innerHTML = html;
}

// ============ Cmd-K palette (3.1) ===========================================
const cmdkDialog = $('cmdk-dialog');
const cmdkInput = $('cmdk-input');
const cmdkList = $('cmdk-list');
const cmdkOpen = $('cmdk-open');

const COMMANDS = [
  { id: 'run', label: 'Run preview', keywords: ['preview','ocr','run'], action: () => $('run-btn')?.click() },
  { id: 'gen', label: 'Generate schema from document', keywords: ['schema','generate','✨'], action: () => $('schema-generate-btn')?.click() },
  { id: 'save', label: 'Save schema as…', keywords: ['save','schema','repo'], action: () => $('save-schema-btn')?.click() },
  { id: 'tpl', label: 'Load template…', keywords: ['template','vorlage'], action: () => { activateRunTab('parameters'); $('cfg-template')?.focus(); } },
  { id: 'apply', label: 'Apply override', keywords: ['override','apply','workflow'], action: () => $('apply-btn')?.click() },
  { id: 'revert', label: 'Revert override', keywords: ['override','revert'], action: () => $('revert-btn')?.click() },
  { id: 'rerun', label: 'Re-run input', keywords: ['rerun','workflow'], action: () => $('rerun-btn')?.click() },
  { id: 'diff', label: 'Diff vs. original', keywords: ['diff'], action: () => { activateRunTab('result'); activateResultTab('diff'); } },
  { id: 'variant', label: 'Open Variants rail', keywords: ['variant','ab'], action: () => openVariantsRail() },
  { id: 'tab-md', label: 'Show Markdown', keywords: ['markdown','text'], action: () => { activateRunTab('result'); activateResultTab('markdown'); } },
  { id: 'tab-ann', label: 'Show Annotation', keywords: ['annotation','schema','json'], action: () => { activateRunTab('result'); activateResultTab('annotation'); } },
  { id: 'tab-quality', label: 'Show Qualität', keywords: ['quality','metrics'], action: () => { activateRunTab('result'); activateResultTab('quality'); } },
  { id: 'tab-raw', label: 'Show Raw', keywords: ['raw','json'], action: () => { activateRunTab('result'); activateResultTab('raw'); } },
  { id: 'tab-params', label: 'Show Parameters', keywords: ['parameters','config'], action: () => activateRunTab('parameters') },
  { id: 'tab-history', label: 'Show History', keywords: ['history'], action: () => activateRunTab('history') },
];

function fuzzyMatch(q, str) {
  if (!q) return true;
  q = q.toLowerCase(); str = str.toLowerCase();
  let i = 0;
  for (const ch of q) { i = str.indexOf(ch, i); if (i < 0) return false; i++; }
  return true;
}
function renderCmdk(query) {
  if (!cmdkList) return;
  const matches = COMMANDS.filter((c) => fuzzyMatch(query, c.label) || c.keywords.some((k) => fuzzyMatch(query, k)));
  cmdkList.innerHTML = '';
  if (matches.length === 0) {
    cmdkList.innerHTML = '<li class="cmdk-empty">Keine Treffer</li>';
    return;
  }
  matches.forEach((c, i) => {
    const li = document.createElement('li');
    li.dataset.cmdId = c.id;
    if (i === 0) li.setAttribute('aria-selected', 'true');
    li.innerHTML = `<span>${escapeHtml(c.label)}</span><span class="cmdk-kbd">${escapeHtml(c.id)}</span>`;
    li.addEventListener('click', () => execCmdk(c.id));
    cmdkList.appendChild(li);
  });
}
function execCmdk(id) {
  const cmd = COMMANDS.find((c) => c.id === id);
  closeCmdk();
  if (cmd) cmd.action();
}
function openCmdk() {
  if (!cmdkDialog) return;
  cmdkInput.value = ''; renderCmdk('');
  if (typeof cmdkDialog.showModal === 'function') cmdkDialog.showModal();
  else cmdkDialog.setAttribute('open', '');
  setTimeout(() => cmdkInput.focus(), 0);
}
function closeCmdk() {
  if (!cmdkDialog) return;
  if (typeof cmdkDialog.close === 'function') cmdkDialog.close();
  else cmdkDialog.removeAttribute('open');
}
cmdkOpen?.addEventListener('click', openCmdk);
cmdkInput?.addEventListener('input', () => renderCmdk(cmdkInput.value));
cmdkInput?.addEventListener('keydown', (e) => {
  const items = Array.from(cmdkList.querySelectorAll('li[data-cmd-id]'));
  if (items.length === 0) return;
  const cur = cmdkList.querySelector('li[aria-selected="true"]') || items[0];
  let idx = items.indexOf(cur);
  if (e.key === 'ArrowDown') { idx = (idx + 1) % items.length; e.preventDefault(); }
  else if (e.key === 'ArrowUp') { idx = (idx - 1 + items.length) % items.length; e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); execCmdk(cur.dataset.cmdId); return; }
  else return;
  items.forEach((li) => li.removeAttribute('aria-selected'));
  items[idx].setAttribute('aria-selected', 'true');
  items[idx].scrollIntoView({ block: 'nearest' });
});
// Close on backdrop click
cmdkDialog?.addEventListener('click', (e) => { if (e.target === cmdkDialog) closeCmdk(); });

// ============ Single-key shortcuts (3.2) ====================================
function isEditingTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}

let kbdRowFocus = -1;
function focusSchemaRow(delta) {
  const rows = Array.from(document.querySelectorAll('#schema-builder-mount .sb-row'));
  if (rows.length === 0) return;
  rows.forEach((r) => r.classList.remove('kbd-focus'));
  kbdRowFocus = (kbdRowFocus + delta + rows.length) % rows.length;
  if (kbdRowFocus < 0) kbdRowFocus = rows.length - 1;
  const target = rows[kbdRowFocus];
  target.classList.add('kbd-focus');
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

window.addEventListener('keydown', (e) => {
  // Cmd/Ctrl-K opens palette regardless of focus target
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (cmdkDialog?.hasAttribute('open')) closeCmdk(); else openCmdk();
    return;
  }
  if (e.key === 'Escape') {
    // 1) Cmd-K dialog wins.
    if (cmdkDialog?.hasAttribute('open')) { closeCmdk(); return; }
    // 2) An open right-rail sheet is the next-most-modal thing.
    if (currentStage === 'tuning') { closeSheet(); return; }
    // 3) Existing behavior: clear annotation pins and field flash.
    document.querySelectorAll('.ann-row.is-pinned').forEach((r) => r.classList.remove('is-pinned'));
    clearFlash(true);
    return;
  }
  if (isEditingTarget(e.target)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key.toLowerCase()) {
    case 'g': $('schema-generate-btn')?.click(); e.preventDefault(); break;
    case 'r': $('run-btn')?.click(); e.preventDefault(); break;
    case 'd': activateRunTab('result'); activateResultTab('diff'); e.preventDefault(); break;
    // Right-rail sheet toggles. `d` is already Diff; `e` ("Extract details")
    // is the Detail sheet — documented in the help popover.
    case 's': toggleSheet('schema'); e.preventDefault(); break;
    case 'p': toggleSheet('params'); e.preventDefault(); break;
    case 'h': toggleSheet('history'); e.preventDefault(); break;
    case 'e': toggleSheet('detail'); e.preventDefault(); break;
    case 'j': focusSchemaRow(+1); e.preventDefault(); break;
    case 'k': focusSchemaRow(-1); e.preventDefault(); break;
    case '1': document.querySelector('#schema-builder-mount .sb-tab')?.click(); e.preventDefault(); break;
    case '2': {
      const tabs = document.querySelectorAll('#schema-builder-mount .sb-tab');
      if (tabs[1]) tabs[1].click();
      e.preventDefault();
      break;
    }
    case '3': {
      const tabs = document.querySelectorAll('#schema-builder-mount .sb-tab');
      if (tabs[2]) tabs[2].click();
      e.preventDefault();
      break;
    }
  }
});

// Help button: show popover (uses native Popover API; fallback toggles class)
const kbdHelpBtn = $('kbd-help-btn');
const kbdHelpPop = $('kbd-help-popover');
kbdHelpBtn?.addEventListener('click', () => {
  if (kbdHelpPop?.togglePopover) kbdHelpPop.togglePopover();
  else kbdHelpPop?.classList.toggle('is-open');
});

// ============ Workspace context (set by hydrateWorkspaceContext below) ======
const wsCtx = { wsId: null, uuid: null, name: null };

async function saveToWorkspace(patch, summary) {
  if (!wsCtx.wsId || !wsCtx.uuid) return null;
  try {
    const headers = { 'Content-Type': 'application/json' };
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const body = { ...patch, source: 'playground' };
    if (summary) body.summary = summary;
    const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsCtx.wsId)}/documents/${encodeURIComponent(wsCtx.uuid)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn('[studio] saveToWorkspace failed', resp.status, txt.slice(0, 200));
      return null;
    }
    const meta = await resp.json();
    flashWorkspaceSaved(summary ?? 'gespeichert');
    return meta;
  } catch (e) {
    console.warn('[studio] saveToWorkspace exception', e);
    return null;
  }
}

function flashWorkspaceSaved(text) {
  const ctx = document.querySelector('.studio-ws-context');
  if (!ctx) return;
  const flash = document.createElement('span');
  flash.className = 'ws-saved-flash';
  flash.textContent = `✓ ${text}`;
  ctx.appendChild(flash);
  setTimeout(() => flash.remove(), 2400);
}

// ============ Bootstrap =====================================================
loadTemplates();
init();
updateCostMeter();
hydrateWorkspaceContext();

// ============ Workspace context (deep-link from /workspace.html) =============
async function hydrateWorkspaceContext() {
  const params = new URLSearchParams(location.search);
  const wsId = params.get('ws');
  const uuid = params.get('uuid');
  if (!wsId) return;

  try {
    const ws = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}`).then((r) => r.ok ? r.json() : null);
    if (!ws) return;
    wsCtx.wsId = ws.id;
    wsCtx.name = ws.name;
    insertWorkspacePill(ws);

    if (!uuid) return;
    wsCtx.uuid = uuid;
    const meta = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`).then((r) => r.ok ? r.json() : null);
    if (!meta) return;

    // Pull the binary, wrap as a File, hand to the existing loadFile() so all
    // existing studio plumbing (preview, classify, schema-gen) just works.
    const fileResp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}/file`);
    if (!fileResp.ok) throw new Error(`file fetch HTTP ${fileResp.status}`);
    const blob = await fileResp.blob();
    const file = new File([blob], meta.originalFilename, { type: meta.mime || blob.type || 'application/pdf' });
    loadFile(file);
  } catch (e) {
    console.warn('[studio] workspace context hydration failed:', e);
  }
}

function insertWorkspacePill(ws) {
  // Place a pill + back-link into the studio header so the user sees they're
  // operating in a workspace context. Removes the static "MVP" badge while
  // we're scoped to a workspace.
  const headerActions = document.querySelector('.studio-header .header-actions');
  if (!headerActions) return;
  const wrap = document.createElement('span');
  wrap.className = 'studio-ws-context';
  wrap.innerHTML = `
    <a class="link-secondary" href="/workspace.html?ws=${encodeURIComponent(ws.id)}" title="Zurück zum Workspace">← ${escapeHtml(ws.name)}</a>
  `;
  headerActions.insertBefore(wrap, headerActions.firstChild);
  const badge = document.getElementById('studio-badge');
  if (badge) badge.textContent = ws.id;
}

// ============ /api/schema/generate wiring ===================================
function wireSchemaGenerator() {
  const btn = document.getElementById('schema-generate-btn');
  const progressEl = document.getElementById('schema-generate-progress');
  if (!btn) {
    console.warn('[studio] schema-generate-btn not in DOM yet');
    return false;
  }
  if (btn.__sturmSchemaGenWired) return true;
  if (!progressEl) {
    console.warn('[studio] schema-generate-progress not in DOM');
    return false;
  }

  let activeAbort = null;
  const card = { el: null };

  let originalBtnHtml = '';
  let originalDraftHtml = '';
  const setBtnText = (txt) => {
    btn.innerHTML = txt;
    const dp = $('draft-cta-primary');
    if (dp) dp.innerHTML = txt;
  };
  const restoreBtnText = () => {
    btn.innerHTML = originalBtnHtml;
    const dp = $('draft-cta-primary');
    if (dp && originalDraftHtml) dp.innerHTML = originalDraftHtml;
  };

  btn.addEventListener('click', async () => {
    console.log('[studio] schema-generate-btn click fired; currentFile=', currentFile && currentFile.name);
    if (!currentFile) { toast('Bitte zuerst eine Datei wählen.', 'error'); return; }
    if (activeAbort) activeAbort.abort();
    activeAbort = new AbortController();
    // The progress card renders into #schema-generate-progress, which lives
    // inside .pane-schema. That pane is hidden in drafting/reading/tuning by
    // the stage rules — open the Schema sheet so the user actually sees it.
    if (currentStage === 'drafting' || currentStage === 'reading' || currentStage === 'tuning') {
      openSheet('schema');
    }

    // Visual feedback on both the schema-pane button AND the draft-cta primary.
    const draftPrimary = $('draft-cta-primary');
    originalBtnHtml = btn.innerHTML;
    originalDraftHtml = draftPrimary?.innerHTML ?? '';
    setBtnText(`Generiere Schema…`);
    if (draftPrimary) draftPrimary.disabled = true;

    btn.disabled = true;
    progressEl.classList.remove('hidden');
    progressEl.innerHTML = `
      <div class="sg-row">
        <div class="sg-card sg-pending" data-i="0" style="--sg-card-name: sg-card-0;">
          <div class="sg-card-head"><span class="sg-seed">mistral-small-latest</span><span class="sg-state">lädt hoch…</span></div>
          <div class="sg-card-body">
            <div class="sg-name muted">—</div>
            <div class="sg-metrics muted">eine Anfrage, document_url + json_schema</div>
          </div>
        </div>
      </div>
      <div class="sg-actions">
        <button type="button" class="btn-secondary" id="sg-cancel">Abbrechen</button>
      </div>
    `;
    card.el = progressEl.querySelector('[data-i="0"]');
    $('sg-cancel')?.addEventListener('click', () => activeAbort?.abort());

    const fd = new FormData();
    fd.append('file', currentFile);

    try {
      const headers = {};
      const tok = localStorage.getItem('sturm-token');
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
      const resp = await fetch('/api/schema/generate', { method: 'POST', body: fd, signal: activeAbort.signal, headers });
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      }
      await consumeSse(resp.body, handleEvent);
    } catch (e) {
      if (e.name !== 'AbortError') toast(`Schema-Generierung fehlgeschlagen: ${escapeHtml(e.message)}`, 'error', 8000);
      if (card.el && card.el.classList.contains('sg-pending')) {
        card.el.classList.remove('sg-pending'); card.el.classList.add('sg-error');
        const s = card.el.querySelector('.sg-state');
        if (s) s.textContent = e.name === 'AbortError' ? 'abgebrochen' : 'Fehler';
      }
    } finally {
      btn.disabled = false;
      if (draftPrimary) draftPrimary.disabled = false;
      // Hold the success/error label briefly, then restore.
      setTimeout(restoreBtnText, 2500);
    }
  });

  function handleEvent(event, data) {
    if (event === 'schema_start') {
      const c = card.el; if (!c) return;
      const s = c.querySelector('.sg-state');
      if (s) s.textContent = data.fileId ? 'analysiere Dokument…' : 'analysiere…';
      return;
    }
    if (event === 'winner') {
      withTransition(() => {
        if (card.el) {
          card.el.classList.remove('sg-pending');
          card.el.classList.add('sg-ok', 'sg-winner');
          const s = card.el.querySelector('.sg-state'); if (s) s.textContent = 'OK';
          const n = card.el.querySelector('.sg-name');
          if (n) { n.classList.remove('muted'); n.textContent = data.name || '(unbenannt)'; }
          const tk = (data.total_tokens && typeof data.total_tokens === 'object')
            ? (data.total_tokens.total_tokens ?? 0)
            : (data.total_tokens ?? 0);
          const m = card.el.querySelector('.sg-metrics');
          if (m) { m.classList.remove('muted'); m.innerHTML = `${data.total_ms ?? 0} ms · ${tk} tok`; }
        }
        setBuilderSchema(data.schema);
        const nameEl = $('cfg-schema-name');
        if (nameEl && data.name) nameEl.value = data.name;
      });
      const tokTotal = (data.total_tokens && typeof data.total_tokens === 'object')
        ? (data.total_tokens.total_tokens ?? 0)
        : (data.total_tokens ?? 0);
      toast(`Schema generiert: <strong>${escapeHtml(data.name)}</strong> (${data.total_ms} ms, ${tokTotal} tok)`, 'success', 6000);
      // Auto-save the generated schema as a "playground" template back to the workspace.
      saveToWorkspace({
        template: { source: 'playground', name: data.name, schema: data.schema },
      }, `template=${data.name} (mistral-small)`);
    } else if (event === 'done') {
      // no-op; winner already handled
    } else if (event === 'error') {
      toast(`Schema-Fehler: ${escapeHtml(data.message ?? 'unbekannt')}`, 'error', 8000);
    }
  }
  btn.__sturmSchemaGenWired = true;
  console.log('[studio] schema-generate-btn handler attached to', btn);
  return true;
}

// Defensive attach: try now, retry on DOMContentLoaded if anything above silently threw.
try { wireSchemaGenerator(); } catch (e) { console.error('[studio] wireSchemaGenerator immediate attach failed:', e); }
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    try { wireSchemaGenerator(); } catch (e) { console.error('[studio] wireSchemaGenerator DOMContentLoaded attach failed:', e); }
  }, { once: true });
} else {
  setTimeout(() => {
    try { wireSchemaGenerator(); } catch (e) { console.error('[studio] wireSchemaGenerator setTimeout attach failed:', e); }
  }, 0);
}

// ============ Right-rail wiring (commit 1/3) ================================
function wireRightRail() {
  const rail = document.getElementById('right-rail');
  if (!rail) { console.warn('[studio] right-rail not in DOM'); return; }
  rail.addEventListener('click', (e) => {
    const btn = e.target.closest('.rr-btn');
    if (!btn) return;
    const action = btn.dataset.railAction;
    if (!action) return;
    if (action === 'history') {
      // No runs API yet — surface a placeholder per spec, then still toggle
      // the sheet so the user sees the existing history-tab placeholder copy.
      toast('Verlauf folgt in Commit 2 — vorerst Platzhalter.', 'warn', 3000);
    }
    toggleSheet(action);
  });
  // Also: clicking outside an open sheet (but inside the studio shell) closes it.
  document.addEventListener('mousedown', (e) => {
    if (currentStage !== 'tuning') return;
    const inSheet = e.target.closest('.pane-schema, .pane-run, .right-rail, .cmdk-dialog, .toast, .ann-pop');
    if (inSheet) return;
    closeSheet();
  });
}

// ============ Draft-CTA (commit 1/3) ========================================
function refreshDraftCta() {
  const primary = els.draftCtaPrimary;
  const secondary = els.draftCtaSecondary;
  const title = els.draftCtaTitle;
  const sub = els.draftCtaSub;
  const hint = els.draftCtaHint;
  if (!primary || !secondary) return;
  // A schema is "present" when the builder reports a non-empty schema,
  // OR when the templates select has a non-empty value.
  let hasSchema = false;
  try {
    const s = window.__schemaBuilder?.getSchema?.();
    if (s && (Array.isArray(s.properties) || (s.properties && Object.keys(s.properties).length > 0))) hasSchema = true;
    if (s && typeof s === 'object' && !s.properties && Object.keys(s).length > 0) hasSchema = true;
  } catch { /* ignore */ }
  const tplSel = $('cfg-template');
  if (tplSel && tplSel.value) hasSchema = true;

  if (hasSchema) {
    if (title) title.textContent = 'Bereit zur Extraktion';
    if (sub) sub.textContent = 'Dein Schema ist geladen.';
    primary.textContent = 'Mit Schema extrahieren';
    secondary.textContent = 'Schema neu generieren';
    primary.onclick = () => $('run-btn')?.click();
    secondary.onclick = () => $('schema-generate-btn')?.click();
    if (hint) {
      const eur = (typeof estimateCostEur === 'function') ? estimateCostEur() : 0.001;
      hint.textContent = `≈ €${eur.toFixed(4)} · ~3 s`;
    }
  } else {
    if (title) title.textContent = 'Kein Schema gesetzt';
    if (sub) sub.textContent = 'Lass STURM das Schema vorschlagen — oder leg manuell eines an.';
    primary.textContent = 'Schema generieren & extrahieren';
    secondary.textContent = 'Manuelles Schema';
    primary.onclick = () => $('schema-generate-btn')?.click();
    secondary.onclick = () => {
      toast('Sheet öffnen', 'success', 1500);
      openSheet('schema');
    };
    if (hint) {
      const eur = (typeof estimateCostEur === 'function') ? estimateCostEur() : 0.001;
      // Generator path: ~12 s + per-page OCR cost.
      hint.textContent = `≈ €${(eur + 0.001).toFixed(4)} · ~12 s (Schema-Generator)`;
    }
  }
}

// Lucide init: replace <i data-lucide=...> with <svg>. Safe to call multiple
// times — Lucide skips already-replaced nodes.
function tryInitLucide() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try { window.lucide.createIcons(); return true; } catch (e) { console.warn('[studio] lucide.createIcons failed:', e); }
  }
  return false;
}

// ============ Stage bootstrap ===============================================
(function bootstrapStage() {
  wireRightRail();
  // Try Lucide on load AND once the script finishes loading async.
  if (!tryInitLucide()) {
    const id = setInterval(() => { if (tryInitLucide()) clearInterval(id); }, 100);
    setTimeout(() => clearInterval(id), 4000);
  }
  // If `init()` (the URL-deep-link path) is going to call loadFile, we let
  // it drive the stage. Otherwise we settle into 'empty'.
  // setStage is idempotent for currentStage === 'empty', so this is safe.
  if (!currentFile) {
    document.body.setAttribute('data-stage', 'empty');
    currentStage = 'empty';
  }
  refreshDraftCta();
})();
