/* OCR Studio — client */

// Surface any module-level error to the console with a clear prefix so a
// silent failure (e.g. addEventListener never reached) is never silent again.
window.addEventListener('error', (e) => {
  console.error('[studio] uncaught:', e.error || e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[studio] unhandled promise rejection:', e.reason);
});

// ============ Auth: bearer token bootstrap ==================================
// First-load may carry ?token=… — persist to localStorage and strip from URL
// so the bookmark doesn't include the secret. Token is attached to all fetches.
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
  // Keep a11y tree in sync with visibility — assistive tech shouldn't see
  // header buttons that aren't currently usable.
  if (hide) {
    el.setAttribute('aria-hidden', 'true');
    if (el.tagName === 'BUTTON' || el.tagName === 'A') el.setAttribute('tabindex', '-1');
  } else {
    el.removeAttribute('aria-hidden');
    el.removeAttribute('tabindex');
  }
};

const els = {
  fileInput: $('file-input'),
  filePickerLabel: document.querySelector('.file-picker span'),
  docMeta: $('doc-meta'),
  docViewer: $('doc-viewer'),
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
    // schema textarea is gone — replaced by the React schema builder mounted at
    // #schema-builder-mount. Read/write via window.__schemaBuilder.
  },
  out: {
    annotation: $('out-annotation'),
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
};

let currentFile = null;
let currentDocUrl = null;
let activeAbort = null;

// Tuning-mode state. Populated by init() when URL params indicate a deep-link.
const tuning = {
  workflowId: null,    // e.g. "elster-v1"
  stageId: null,       // e.g. "ocr"
  runId: null,         // e.g. "lxyz-abc"; null if Mode B (workflow only)
  hasOverride: false,  // current override status from server
  originalOutput: null, // persisted ParsedOcrResponse from the original run (Mode A only)
  lastPreview: null,   // last successful preview result for diffing
};

// ---- Tabs ----
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
  });
});

// ---- File picker ----
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
  if (file.size < 5 * 1024) {
    toast('Sehr kleine Eingabe — Modell könnte halluzinieren. Trotzdem fortfahren?', 'warn', 6000);
  }
  els.runBtn.disabled = false;
  const sg = document.getElementById('schema-generate-btn');
  if (sg) sg.disabled = false;
}

// ---- Pages validator (live) ----
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
  });
} else {
  console.warn('[studio] #cfg-pages missing; live page-range validation disabled');
}

// Schema validation now lives inside the React schema builder
// (src/ui/schema-builder.jsx → JsonTab error state).

// ---- Build config ----
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

  // Schema comes from the React builder bridge (Visual or JSON tab — whichever is active).
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

// 1-indexed display "1-4,8" → 0-indexed [0,1,2,3,7]. Mirror of pages.ts.
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

// ---- Run ----
function onRunClick() {
  console.log('[studio] runBtn click fired; currentFile=', currentFile && currentFile.name);
  if (!currentFile) {
    setStatus('error', 'Keine Datei ausgewählt — bitte zuerst eine PDF/Bilddatei wählen.');
    return;
  }
  let config;
  try { config = collectConfig(); }
  catch (e) {
    console.error('[studio] collectConfig threw:', e);
    setStatus('error', e.message);
    return;
  }

  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();

  setStatus('running', 'preview wird gestartet…');
  els.runBtn.disabled = true;

  let body;
  try {
    const fd = new FormData();
    fd.append('file', currentFile);
    fd.append('config', JSON.stringify(config));
    body = fd;
  } catch (e) {
    console.error('[studio] failed to build FormData:', e);
    setStatus('error', `Konfiguration nicht serialisierbar: ${e.message}`);
    els.runBtn.disabled = false;
    return;
  }

  fetch('/api/ocr/preview', { method: 'POST', body, signal: activeAbort.signal })
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

// Defensive attach: if the element exists at module load, attach now; if
// something above this line has thrown silently, also retry on DOMContentLoaded
// so the button is wired up no matter what.
function attachRunButton() {
  const btn = els.runBtn || document.getElementById('run-btn');
  if (!btn) {
    console.warn('[studio] #run-btn not in DOM yet; will retry');
    return false;
  }
  if (btn.__sturmRunHandlerAttached) return true;
  btn.addEventListener('click', onRunClick);
  btn.__sturmRunHandlerAttached = true;
  console.log('[studio] runBtn handler attached to', btn);
  return true;
}
if (!attachRunButton()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachRunButton, { once: true });
  } else {
    setTimeout(attachRunButton, 0);
  }
}

function handleEvent(event, data) {
  if (event === 'ocr_start') {
    setStatus('running', `${data.filename} (${formatBytes(data.size)})`);
  } else if (event === 'ocr_degraded') {
    // API rejected an undocumented param; the request was retried with it stripped.
    setStatus('warn', `Degradiert: ${data.reason}`);
  } else if (event === 'ocr_done') {
    renderResult(data);
    tuning.lastPreview = data;
    refreshDiffTabVisibility();
    if (tuning.originalOutput) renderDiffPanel();
    const degraded = data.degradation ? ` · ⚠ ${data.degradation.strippedFields.join(',')} entfernt` : '';
    setStatus('ok', `${data.usage.pagesProcessed} Seiten · ${data.ms} ms · ${data.chars} chars${degraded}`);
  } else if (event === 'ocr_error') {
    const detail = data.status ? `HTTP ${data.status}: ${data.message}` : data.message;
    setStatus('error', detail);
    if (data.body) {
      els.out.raw.textContent = data.body;
    }
  }
}

function renderResult(parsed) {
  els.out.annotation.textContent = parsed.documentAnnotation
    ? JSON.stringify(parsed.documentAnnotation, null, 2)
    : '(kein Schema gesetzt → keine Annotation)';

  els.out.markdown.textContent = parsed.text || '(leer)';

  const links = collectAllLinks(parsed);
  els.out.links.innerHTML = '';
  if (links.length === 0) {
    els.out.links.innerHTML = '<li class="muted">Keine Links erkannt.</li>';
  } else {
    for (const url of links) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = url;
      li.appendChild(a);
      els.out.links.appendChild(li);
    }
  }

  renderQuality(parsed);
  els.out.raw.textContent = JSON.stringify(parsed.raw, null, 2);
}

function collectAllLinks(parsed) {
  const out = [];
  for (const p of parsed.pages ?? []) {
    for (const link of p.hyperlinks ?? []) out.push(link);
  }
  return Array.from(new Set(out));
}

function renderQuality(parsed) {
  const validationIssues = parsed.validation?.documentAnnotation ?? [];
  const halls = parsed.hallucinations ?? [];
  const cost = estimateCostUsd(parsed.usage?.pagesProcessed ?? 0);

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

function estimateCostUsd(pages) {
  // Rough placeholder — Mistral OCR pricing is per-page; actual rate to be plumbed in.
  return pages * 0.001;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- SSE consumer ----
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

// ---- Status / utils ----
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
// URL forms:
//   /studio-ocr.html?from=run:<workflowId>:<runId>&stage=<stageId>
//     → load the input file persisted with that run + that stage's config
//   /studio-ocr.html?workflow=<workflowId>&stage=<stageId>
//     → load only the stage's current config, no document
//   /studio-ocr.html
//     → blank, manual upload

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

  // Backwards-compat: schema/schemaName at top level OR documentAnnotation.{schema, name, prompt}
  const docAnn = cfg.documentAnnotation;
  const schema = docAnn?.schema ?? cfg.schema;
  const schemaName = docAnn?.name ?? cfg.schemaName;
  const prompt = docAnn?.prompt;
  if (schemaName) els.cfg.schemaName.value = schemaName;
  if (prompt) els.cfg.prompt.value = prompt;
  // Push schema into the React builder. If it hasn't mounted yet (first render
  // races babel-standalone transform), queue it; the component drains the queue
  // on mount.
  if (schema !== undefined) setBuilderSchema(schema);
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
  const ctx = document.getElementById('tuning-context');
  const back = document.getElementById('back-to-pipeline');
  const title = document.getElementById('studio-title');
  const badge = document.getElementById('studio-badge');
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
  // Show the Diff tab only when we both have an original output (loaded from
  // a tuning deep-link) AND at least one preview to compare against.
  const showTab = !!(tuning.originalOutput && tuning.lastPreview);
  setHidden(els.tabDiff, !showTab);
  // If the diff tab was active and is now hiding, fall back to Annotation.
  if (!showTab && els.tabDiff?.classList.contains('active')) {
    document.querySelector('.tab[data-tab="annotation"]')?.click();
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const fromParam = params.get('from');               // "run:<workflowId>:<runId>"
  const stageParam = params.get('stage');             // stageId
  const workflowParam = params.get('workflow');       // explicit workflow (no run)

  // Mode A: deep-link from a specific run + stage
  if (fromParam && fromParam.startsWith('run:') && stageParam) {
    const [, workflowId, runId] = fromParam.split(':');
    if (!workflowId || !runId) return;
    tuning.workflowId = workflowId;
    tuning.stageId = stageParam;
    tuning.runId = runId;
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

  // Mode B: workflow + stage (config only, no document)
  if (workflowParam && stageParam) {
    tuning.workflowId = workflowParam;
    tuning.stageId = stageParam;
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

  // Mode C: blank (manual upload)
}

// ============ Tuning actions: Apply / Revert / Re-run =======================

els.applyBtn?.addEventListener('click', async () => {
  if (!tuning.workflowId || !tuning.stageId) return;
  let cfg;
  try { cfg = collectConfig(); }
  catch (e) { toast(`Konfiguration ungültig: ${e.message}`, 'error'); return; }
  if (!confirm(`Konfiguration als Override für ${tuning.workflowId}/${tuning.stageId} speichern?\n\nFolgeläufe verwenden diese Werte. Quelldatei bleibt unverändert; Override unter config-overrides/${tuning.workflowId}.json.`)) return;
  els.applyBtn.disabled = true;
  try {
    const resp = await fetch(`/api/workflows/${encodeURIComponent(tuning.workflowId)}/stages/${encodeURIComponent(tuning.stageId)}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: cfg }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    tuning.hasOverride = true;
    refreshOverrideUi();
    toast(`Override für ${tuning.stageId} gespeichert.`, 'success');
  } catch (e) {
    toast(`Speichern fehlgeschlagen: ${e.message}`, 'error');
  } finally {
    els.applyBtn.disabled = false;
  }
});

els.revertBtn?.addEventListener('click', async () => {
  if (!tuning.workflowId || !tuning.stageId) return;
  if (!confirm(`Override für ${tuning.workflowId}/${tuning.stageId} entfernen?\n\nDie Stage verwendet danach wieder die Workflow-Quelle.`)) return;
  els.revertBtn.disabled = true;
  try {
    const resp = await fetch(`/api/workflows/${encodeURIComponent(tuning.workflowId)}/stages/${encodeURIComponent(tuning.stageId)}/config`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    tuning.hasOverride = false;
    refreshOverrideUi();
    toast(`Override entfernt — Workflow-Quelle ist wieder aktiv.`, 'success');
    // Reload the source config into the form
    if (tuning.workflowId && tuning.stageId) await loadStageConfig(tuning.workflowId, tuning.stageId);
  } catch (e) {
    toast(`Revert fehlgeschlagen: ${e.message}`, 'error');
  } finally {
    els.revertBtn.disabled = false;
  }
});

els.rerunBtn?.addEventListener('click', async () => {
  if (!tuning.workflowId || !currentFile) return;
  if (!confirm(`Eingabe nochmal durch ${tuning.workflowId} laufen lassen?\n\nVerwendet die aktuell gespeicherte Override-Konfiguration. Klick zum Bestätigen.`)) return;
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
        toast(
          `Run gestartet: <strong>${escapeHtml(newRunId)}</strong> · <a href="/pipeline.html?workflow=${encodeURIComponent(tuning.workflowId)}" target="_blank">Pipeline öffnen</a>`,
          'success', 8000,
        );
      } else if (event === 'run_done') {
        toast(
          `Run <strong>${escapeHtml(newRunId)}</strong> fertig. <a href="/studio-ocr.html?from=run:${encodeURIComponent(tuning.workflowId)}:${encodeURIComponent(newRunId)}&stage=${encodeURIComponent(tuning.stageId)}">Im Studio öffnen</a>`,
          'success', 12000,
        );
      } else if (event === 'run_error' || event === 'stage_error') {
        toast(`Re-Run-Fehler: ${escapeHtml(data?.message ?? 'unbekannt')}`, 'error', 10000);
      }
    });
  } catch (e) {
    toast(`Re-Run fehlgeschlagen: ${e.message}`, 'error');
  } finally {
    els.rerunBtn.disabled = false;
  }
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

/**
 * Compare two ParsedOcrResponse objects field-by-field on documentAnnotation.
 * Returns { added, removed, changed } with leaf-level entries; falls back to
 * key-level when objects are nested.
 */
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
  if (!tuning.originalOutput) {
    el.innerHTML = '<div class="muted">Kein Original-Output verfügbar (Stage hat noch nichts geschrieben?).</div>';
    return;
  }
  if (!tuning.lastPreview) {
    el.innerHTML = '<div class="muted">Preview ausführen, um Änderungen vs. Original zu sehen.</div>';
    return;
  }
  const d = diffParsedOutputs(tuning.originalOutput, tuning.lastPreview);
  const total = d.added.length + d.removed.length + d.changed.length;
  if (total === 0) {
    el.innerHTML = '<div class="diff-summary"><span><strong>Identisch</strong> — keine Änderungen vs. Original.</span></div>';
    return;
  }
  let html = `
    <div class="diff-summary">
      <span><strong>${d.added.length}</strong> hinzugefügt</span>
      <span><strong>${d.removed.length}</strong> entfernt</span>
      <span><strong>${d.changed.length}</strong> geändert</span>
    </div>
  `;
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
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  }
  return String(v);
}

// ============ Templates dropdown (P2.6) =====================================

let _templates = [];
async function loadTemplates() {
  const sel = document.getElementById('cfg-template');
  if (!sel) return;
  try {
    const resp = await fetch('/api/studio/templates');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    _templates = data.templates || [];
    for (const t of _templates) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      opt.title = t.description || '';
      sel.appendChild(opt);
    }
  } catch (e) {
    console.warn('[studio] failed to load templates:', e);
  }
  sel.addEventListener('change', () => {
    const t = _templates.find((x) => x.id === sel.value);
    if (!t) return;
    setBuilderSchema(t.schema);
    if (t.defaultPrompt) els.cfg.prompt.value = t.defaultPrompt;
    const lastSeg = t.id.split('/').pop();
    if (lastSeg) els.cfg.schemaName.value = lastSeg;
    toast(`Vorlage geladen: <strong>${escapeHtml(t.name)}</strong>`, 'success', 3000);
  });
}

// ============ Save schema (P2.5) ============================================

const saveSchemaBtn = document.getElementById('save-schema-btn');
saveSchemaBtn?.addEventListener('click', async () => {
  const builder = window.__schemaBuilder;
  const schema = builder?.getSchema?.();
  if (!schema) { toast('Kein Schema im Builder.', 'error'); return; }
  const id = window.prompt('Schema-ID (z.B. elster/anlagen-klassifizierung):', '');
  if (!id) return;
  if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(id)) {
    toast('Ungültige ID — lowercase a-z, 0-9, -, _, optional /-getrennt.', 'error');
    return;
  }
  saveSchemaBtn.disabled = true;
  try {
    const resp = await fetch(`/api/schemas/${encodeURI(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema,
        name: els.cfg.schemaName.value.trim() || undefined,
        defaultPrompt: els.cfg.prompt.value.trim() || undefined,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    toast(`Schema gespeichert: <strong>${escapeHtml(id)}</strong> @ <strong>${escapeHtml(data.version)}</strong>`, 'success', 5000);
  } catch (e) {
    toast(`Speichern fehlgeschlagen: ${e.message}`, 'error');
  } finally {
    saveSchemaBtn.disabled = false;
  }
});

// ============ Variants A/B/N (P2.7) =========================================

const variants = []; // [{ id, name, config }]
let activeVariantIdx = -1; // -1 = main config form is independent
const variantsRail = document.getElementById('variants-rail');
const variantsList = document.getElementById('variants-list');
const variantsAddBtn = document.getElementById('variants-add');
const variantsRunBtn = document.getElementById('variants-run');
const variantsCloseBtn = document.getElementById('variants-close');
const addVariantBtn = document.getElementById('add-variant-btn');
const tabVariants = document.getElementById('tab-variants');

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
    rm.className = 'vremove';
    rm.title = 'Entfernen';
    rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      variants.splice(i, 1);
      if (activeVariantIdx === i) activeVariantIdx = -1;
      else if (activeVariantIdx > i) activeVariantIdx--;
      renderVariantsRail();
    });
    li.appendChild(rm);
    li.addEventListener('click', () => {
      // Save current form into prior active variant first.
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
variantsCloseBtn?.addEventListener('click', () => setHidden(variantsRail, true));

variantsRunBtn?.addEventListener('click', async () => {
  if (!currentFile) { toast('Bitte zuerst eine Datei wählen.', 'error'); return; }
  // Persist edits to active variant before submit.
  if (activeVariantIdx >= 0 && variants[activeVariantIdx]) {
    const cur = captureCurrentConfig();
    if (cur) variants[activeVariantIdx].config = cur;
  }
  if (variants.length === 0) { toast('Keine Variants.', 'error'); return; }

  variantsRunBtn.disabled = true;
  setHidden(tabVariants, false);
  document.querySelector('.tab[data-tab="variants"]')?.click();
  const out = document.getElementById('out-variants');
  if (out) out.innerHTML = '<div class="muted">Läuft…</div>';

  const results = new Map(); // variantId → { parsed?, error? }
  const startedAt = Date.now();

  const fd = new FormData();
  fd.append('file', currentFile);
  fd.append('variants', JSON.stringify(variants.map((v) => ({ id: v.id, config: v.config }))));

  try {
    const resp = await fetch('/api/ocr/preview/batch', { method: 'POST', body: fd });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    await consumeSse(resp.body, (event, data) => {
      if (event === 'variant_done') {
        results.set(data.variantId, { parsed: data.parsed });
        renderVariantsTable(results);
      } else if (event === 'variant_error') {
        results.set(data.variantId, { error: data.message });
        renderVariantsTable(results);
      } else if (event === 'batch_done') {
        toast(`Batch fertig in ${data.totalMs} ms`, 'success', 4000);
      }
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
  const out = document.getElementById('out-variants');
  if (!out) return;
  let html = '<table class="variants-table"><thead><tr>'
    + '<th>Variante</th><th>Status</th><th class="num">ms</th><th class="num">Seiten</th>'
    + '<th class="num">Validierung</th><th class="num">Halluzinationen</th><th class="num">$</th></tr></thead><tbody>';
  for (const v of variants) {
    const r = results.get(v.id);
    if (!r) {
      html += `<tr><td>${escapeHtml(v.name)}</td><td class="muted">…</td><td colspan="5" class="muted">läuft</td></tr>`;
    } else if (r.error) {
      html += `<tr class="error"><td>${escapeHtml(v.name)}</td><td>error</td><td colspan="5">${escapeHtml(r.error)}</td></tr>`;
    } else {
      const p = r.parsed;
      const cost = (p.usage?.pagesProcessed ?? 0) * 0.001;
      const valIssues = p.validation?.documentAnnotation?.length ?? 0;
      const halls = p.hallucinations?.length ?? 0;
      html += `<tr>
        <td>${escapeHtml(v.name)}</td>
        <td>ok</td>
        <td class="num">${p.ms}</td>
        <td class="num">${p.usage?.pagesProcessed ?? 0}</td>
        <td class="num">${valIssues}</td>
        <td class="num">${halls}</td>
        <td class="num">$${cost.toFixed(4)}</td>
      </tr>`;
    }
  }
  html += '</tbody></table>';
  out.innerHTML = html;
}

loadTemplates();

// ============ Schema Generator (LLM-driven) =================================
// 3 parallel candidates against /api/schema/generate; SSE stream into a small
// progress UI; winner schema is pushed into the React schema builder.
(function wireSchemaGenerator() {
  const btn = document.getElementById('schema-generate-btn');
  const progress = document.getElementById('schema-generate-progress');
  if (!btn || !progress) return;

  let abort = null;

  function setProgressVisible(v) {
    progress.classList.toggle('hidden', !v);
    if (v) progress.removeAttribute('aria-hidden');
    else progress.setAttribute('aria-hidden', 'true');
  }

  function renderCards(state) {
    // state: { runs, candidates: { [seed]: {seed,name,score,issues,elapsed_ms,tokens,error,done} }, winnerSeed }
    const cards = [];
    for (let i = 0; i < state.runs; i++) {
      const seed = (state.baseSeed ?? 1000) + i;
      const c = state.candidates[seed];
      const isWinner = state.winnerSeed === seed;
      const cls = ['sg-card'];
      if (!c) cls.push('sg-card-pending');
      else if (c.error) cls.push('sg-card-error');
      else if (c.done) cls.push('sg-card-done');
      if (isWinner) cls.push('sg-card-winner');
      const pulsing = !c ? '<span class="sg-pulse"></span>' : '';
      const star = isWinner ? '<span class="sg-star" title="Sieger">★</span>' : '';
      const body = !c
        ? `<div class="sg-row sg-muted">Pending…</div>`
        : c.error
          ? `<div class="sg-row sg-err">Fehler</div><div class="sg-sub">${escapeHtml(String(c.error).slice(0, 90))}</div>`
          : `
            <div class="sg-row"><span class="sg-name">${escapeHtml(c.name ?? '—')}</span></div>
            <div class="sg-row"><span class="sg-label">Score</span><span class="sg-val">${c.score == null ? '—' : c.score.toFixed(1)}</span></div>
            <div class="sg-row"><span class="sg-label">Issues</span><span class="sg-val ${c.issues > 0 ? 'sg-warn' : ''}">${c.issues ?? 0}</span></div>
            <div class="sg-row"><span class="sg-label">ms</span><span class="sg-val">${c.elapsed_ms ?? '—'}</span></div>
            <div class="sg-row"><span class="sg-label">tok</span><span class="sg-val">${c.tokens?.total_tokens ?? '—'}</span></div>`;
      cards.push(`
        <div class="${cls.join(' ')}" data-seed="${seed}">
          <header class="sg-head">
            <span class="sg-seed">#${seed}</span>${star}${pulsing}
          </header>
          ${body}
        </div>`);
    }
    progress.innerHTML = `
      <div class="sg-bar">
        <span class="sg-title">Schema-Generator</span>
        <span class="sg-meta">${state.statusText ?? ''}</span>
        <button type="button" class="sg-cancel link-secondary">Abbrechen</button>
      </div>
      <div class="sg-cards">${cards.join('')}</div>`;
    const cancelBtn = progress.querySelector('.sg-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      if (abort) abort.abort();
      cancelBtn.textContent = 'abgebrochen';
      cancelBtn.disabled = true;
    });
  }

  btn.addEventListener('click', async () => {
    if (!currentFile) { toast('Bitte zuerst eine Datei wählen.', 'error'); return; }
    if (abort) abort.abort();
    abort = new AbortController();

    const runs = 3;
    const baseSeed = 1000;
    const state = {
      runs, baseSeed,
      candidates: {},
      winnerSeed: null,
      statusText: 'Starte 3 LLM-Kandidaten…',
    };
    btn.disabled = true;
    setProgressVisible(true);
    renderCards(state);

    const fd = new FormData();
    fd.append('file', currentFile);
    fd.append('runs', String(runs));

    try {
      const resp = await fetch('/api/schema/generate', { method: 'POST', body: fd, signal: abort.signal });
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      }
      await consumeSse(resp.body, (event, data) => {
        if (event === 'schema_start') {
          state.statusText = `Erzeuge ${data.runs} Kandidaten…`;
          renderCards(state);
        } else if (event === 'candidate') {
          state.candidates[data.seed] = { ...data, done: true };
          state.statusText = `${Object.keys(state.candidates).length}/${runs} fertig`;
          renderCards(state);
        } else if (event === 'winner') {
          // Mark the winning seed by name match — server doesn't echo the seed
          // on `winner`, but candidate names + scores let us identify it.
          let bestSeed = null;
          let best = -Infinity;
          for (const [s, c] of Object.entries(state.candidates)) {
            if (c.name === data.name && (c.score ?? -Infinity) > best) {
              best = c.score ?? -Infinity;
              bestSeed = Number(s);
            }
          }
          state.winnerSeed = bestSeed;
          state.statusText = `Sieger: ${data.name} · ${data.total_ms} ms · ${data.total_tokens?.total_tokens ?? '—'} tok`;
          renderCards(state);
          // Push schema into React builder + populate name field.
          setBuilderSchema(data.schema);
          if (els.cfg?.schemaName) els.cfg.schemaName.value = data.name;
          toast(`Schema generiert: <strong>${escapeHtml(data.name)}</strong> (Sieger #${bestSeed ?? '?'}, score=${best === -Infinity ? '?' : best.toFixed(1)})`, 'success', 5000);
        } else if (event === 'error') {
          toast(`Schema-Generator: ${escapeHtml(String(data.message ?? 'Fehler'))}`, 'error', 6000);
          state.statusText = `Fehler: ${data.message ?? ''}`;
          renderCards(state);
        }
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('[studio] schema-generate failed:', e);
        toast(`Schema-Generator: ${escapeHtml(e.message)}`, 'error', 6000);
      }
    } finally {
      btn.disabled = !currentFile;
      abort = null;
    }
  });
})();

init();
