/* STURM Workspace detail — pipeline-as-primary-lens.
 * Strip + matrix come from /api/workspaces/:ws/pipeline.
 * Cell click navigates to the document detail with ?tab= deep-link.
 */

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const wsId = params.get('ws');
if (!wsId) {
  document.body.innerHTML = '<p style="padding:40px;font-family:system-ui">?ws=&lt;id&gt; fehlt. <a href="/workspaces.html">Zurück</a></p>';
  throw new Error('no ws id');
}

const titleEl = $('ws-title');
const idPill = $('ws-id-pill');
const dropZoneMini = $('drop-zone-mini');
const dropStatus = $('drop-status');
const fileInput = $('file-input');
const stripEl = $('pipeline-strip');
const matrixEl = $('pipeline-matrix');
const totalsEl = $('pipeline-totals');
const canonicalsEl = $('pipeline-canonicals');
const matrixTitleEl = $('matrix-title');
const filterEl = $('matrix-filter');
const clearFilterBtn = $('matrix-clear-filter');

let activeNodeFilter = null;     // null | 'classify' | 'template' | 'extract' | etc — filters matrix to docs not "ok" at this node
let selectedUuid = null;          // null = consolidated view; <uuid> = strip shows that doc only
let lastPipeline = null;          // cached response from /pipeline
const selectedRows = new Set();   // doc uuids checked for bulk operations
let lastJobs = [];                // recent jobs for the workspace
let jobsPollHandle = null;        // setInterval handle for jobs polling

async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  const tok = localStorage.getItem('sturm-token');
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const resp = await fetch(path, { ...opts, headers });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j.message || j.error || msg; } catch {}
    throw new Error(msg);
  }
  return resp.json();
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(2)} MB`;

// Snake_case slug → "Title Case" (Steuerbescheinigung Kapitalert).
function prettyLabel(slug) {
  if (!slug) return '';
  return String(slug)
    .replace(/[/_-]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Color class for confidence values (≥95 grün, 80-95 gelb, <80 rot).
function confClass(conf) {
  if (conf == null) return '';
  const pct = conf * 100;
  if (pct >= 95) return 'pl-conf-good';
  if (pct >= 80) return 'pl-conf-mid';
  return 'pl-conf-low';
}

// File-type icon (small inline emoji/glyph, ARIA-hidden).
function fileIcon(filename, mime) {
  const ext = (filename ?? '').toLowerCase().match(/\.(\w+)$/)?.[1] ?? '';
  const m = (mime ?? '').toLowerCase();
  if (ext === 'pdf' || m === 'application/pdf') return '<span class="ws-fileicon ws-fi-pdf" aria-hidden="true">PDF</span>';
  if (['jpg','jpeg','png','webp','gif','heic','heif'].includes(ext) || m.startsWith('image/')) return '<span class="ws-fileicon ws-fi-img" aria-hidden="true">IMG</span>';
  if (['doc','docx','odt','txt','md','rtf'].includes(ext)) return '<span class="ws-fileicon ws-fi-doc" aria-hidden="true">DOC</span>';
  return '<span class="ws-fileicon ws-fi-other" aria-hidden="true">·</span>';
}

// Truncate filename in the middle so extension stays visible.
// Also NFC-normalizes (Mac uploads use NFD which renders Umlaute as "a" + combining
// diaeresis, breaking display + word-wrap).
function truncateFilename(name, maxLen = 50) {
  if (!name) return name;
  const normalized = name.normalize ? name.normalize('NFC') : name;
  if (normalized.length <= maxLen) return normalized;
  const ext = normalized.match(/(\.[^.]{1,8})$/)?.[1] ?? '';
  const head = normalized.slice(0, maxLen - ext.length - 1);
  return head + '…' + ext;
}
function fullFilename(name) {
  if (!name) return name;
  return name.normalize ? name.normalize('NFC') : name;
}

// Stat-Cards row: 4 tiles for Dokumente / Datenvolumen / KPIs / Citations / Kosten.
// Phase Simplify: Citation-Coverage ersetzt Extract-Coverage als Qualitäts-Metric.
function renderStats(pipeline) {
  const el = document.getElementById('ws-stats');
  if (!el) return;
  const s = pipeline.summary ?? {};
  const totalDocs = pipeline.totalDocs ?? pipeline.docs?.length ?? 0;
  el.innerHTML = `
    <div class="ws-stat">
      <div class="ws-stat-label">Dokumente</div>
      <div class="ws-stat-value">${totalDocs}</div>
      <div class="ws-stat-sub muted">${s.totalBytes > 0 ? fmtBytesShort(s.totalBytes) : '—'}</div>
    </div>
    <div class="ws-stat">
      <div class="ws-stat-label">KPIs extrahiert</div>
      <div class="ws-stat-value">${s.totalKpis ?? 0}</div>
      ${s.totalClassifyTokens > 0 ? `<div class="ws-stat-sub muted">${fmtTokens(s.totalClassifyTokens)} Tokens</div>` : ''}
    </div>
    <div class="ws-stat" id="ws-stat-citations" title="Anteil der KPIs deren Wert im OCR-Text verifiziert wurde (Citation-Pass aus Phase H).">
      <div class="ws-stat-label">Citations · zitierte KPIs</div>
      <div class="ws-stat-value" id="ws-stat-citations-val">…</div>
      <div class="ws-stat-sub muted" id="ws-stat-citations-sub">lade case.json</div>
    </div>
    <div class="ws-stat" title="Geschätzte Mistral-API-Kosten für alle bisherigen Klassifikations- und Extraktions-Calls in diesem Workspace.">
      <div class="ws-stat-label">Kosten <span class="muted" style="font-weight:400">(gesamt)</span></div>
      <div class="ws-stat-value">${s.totalCostEur > 0 ? '€' + s.totalCostEur.toFixed(4) : '€0.0000'}</div>
      <div class="ws-stat-sub muted">Mistral API · alle Calls</div>
    </div>
  `;
  // Citations-Tile populates async from case.json
  populateCitationsTile();
}

async function populateCitationsTile() {
  try {
    if (!lastCase) return;
    const vals = lastCase.values ?? [];
    let cited = 0, uncited = 0, noField = 0;
    for (const v of vals) {
      const b = v.belege?.[0];
      if (!b) continue;
      if ('citation' in b) {
        if (b.citation) cited++;
        else uncited++;
      } else noField++;
    }
    const verified = cited;
    const totalKpiBased = cited + uncited;
    const valEl = document.getElementById('ws-stat-citations-val');
    const subEl = document.getElementById('ws-stat-citations-sub');
    if (!valEl || !subEl) return;
    if (totalKpiBased === 0) {
      valEl.textContent = '—';
      subEl.textContent = 'noch kein Citation-Pass gelaufen';
    } else {
      const pct = Math.round((verified / totalKpiBased) * 100);
      valEl.textContent = `${verified}/${totalKpiBased}`;
      subEl.innerHTML = `<span class="${pct >= 90 ? 'pl-conf-good' : pct >= 70 ? 'pl-conf-mid' : 'pl-conf-low'}">${pct}% verifiziert</span>${uncited > 0 ? ` · ⚠ ${uncited} uncitable` : ''}`;
    }
  } catch { /* silent */ }
}

// Overall progress bar: how many docs cleared each step (passed/total) per node.
// Phase Simplify: optional steps (template, extract) are dimmed and don't count
// toward overall completion percentage in the strip header.
function renderProgress(pipeline) {
  const el = document.getElementById('pipeline-progress');
  if (!el) return;
  const total = pipeline.totalDocs || 1;
  const segments = (pipeline.nodes ?? []).map((n) => {
    const pct = (n.passed / total) * 100;
    const optionalCls = n.optional ? 'pl-progress-seg-optional' : '';
    return `<div class="pl-progress-seg ${optionalCls}" title="${escapeHtml(n.name)}: ${n.passed}/${n.total}${n.optional ? ' (optional)' : ''}" style="flex:1">
      <div class="pl-progress-fill" style="width:${pct.toFixed(1)}%"></div>
    </div>`;
  }).join('');
  el.innerHTML = segments;
}
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; } };

// ---------------------------------------------------------------------------
// Workspace header (name + master.json + playground links)
// ---------------------------------------------------------------------------

async function loadWorkspaceHeader() {
  try {
    const ws = await api(`/api/workspaces/${encodeURIComponent(wsId)}`);
    titleEl.textContent = ws.name;
    idPill.textContent = ws.id;
    document.title = `STURM · ${ws.name}`;
    const pgLink = $('ws-playground-link');
    if (pgLink) pgLink.href = `/studio-ocr.html?ws=${encodeURIComponent(ws.id)}`;
    const masterLink = $('ws-master-link');
    if (masterLink) masterLink.href = `/api/workspaces/${encodeURIComponent(ws.id)}/master.json?download=1`;
    const caseLink = $('ws-case-link');
    if (caseLink) caseLink.href = `/api/workspaces/${encodeURIComponent(ws.id)}/case.json?download=1`;
  } catch (e) {
    titleEl.textContent = 'Fehler';
  }
}

// Export-Dropdown: simple click-to-toggle, click-outside dismiss.
const exportBtn = document.getElementById('ws-export-btn');
const exportMenu = document.getElementById('ws-export-menu');
function closeExportMenu() {
  exportMenu?.classList.add('hidden');
  exportBtn?.setAttribute('aria-expanded', 'false');
}
exportBtn?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const isOpen = !exportMenu.classList.contains('hidden');
  if (isOpen) closeExportMenu();
  else { exportMenu.classList.remove('hidden'); exportBtn.setAttribute('aria-expanded', 'true'); }
});
document.addEventListener('click', (ev) => {
  if (!exportMenu?.contains(ev.target) && ev.target !== exportBtn) closeExportMenu();
});
exportMenu?.querySelectorAll('a[role="menuitem"]').forEach((a) => {
  a.addEventListener('click', () => closeExportMenu());
});

// ---------------------------------------------------------------------------
// Case-Steckbrief + Content-Cards — pure projection over /case.json
// ---------------------------------------------------------------------------

let lastCase = null;
const expandedCards = new Set(); // uuids of currently-expanded content cards

async function loadCase() {
  try {
    lastCase = await api(`/api/workspaces/${encodeURIComponent(wsId)}/case.json`);
    renderCaseHeader(lastCase);
    renderContentCards(lastCase);
    populateCitationsTile();
  } catch (e) {
    const ch = document.getElementById('ws-case-header');
    if (ch) ch.innerHTML = `<p class="muted" style="padding:16px">Fall-Steckbrief nicht ladbar: ${escapeHtml(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Jobs (Phase C) — list, render, bulk-trigger, live polling.
// ---------------------------------------------------------------------------

async function loadJobs() {
  try {
    lastJobs = await api(`/api/workspaces/${encodeURIComponent(wsId)}/jobs?limit=15`);
    renderJobs(lastJobs);
  } catch (e) {
    const sec = document.getElementById('ws-jobs-section');
    if (sec) { sec.hidden = false; }
    const list = document.getElementById('ws-jobs-list');
    if (list) list.innerHTML = `<p class="muted" style="padding:12px">Jobs nicht ladbar: ${escapeHtml(e.message)}</p>`;
  }
}

function renderJobs(jobs) {
  const sec = document.getElementById('ws-jobs-section');
  const meta = document.getElementById('ws-jobs-meta');
  const list = document.getElementById('ws-jobs-list');
  if (!sec || !list) return;
  if (!jobs || jobs.length === 0) { sec.hidden = true; return; }
  sec.hidden = false;
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  meta.textContent = `${jobs.length} insgesamt · ${active.length} aktiv`;
  list.innerHTML = jobs.map(renderJobRow).join('');
  list.querySelectorAll('button[data-cancel]').forEach((b) => {
    b.addEventListener('click', async () => {
      const jid = b.dataset.cancel;
      if (!jid) return;
      try {
        await api(`/api/jobs/${encodeURIComponent(jid)}/cancel`, { method: 'POST' });
        loadJobs();
      } catch (e) { alert('Cancel fehlgeschlagen: ' + e.message); }
    });
  });
  // Auto-poll every 2s while any job is active
  if (active.length > 0 && !jobsPollHandle) {
    jobsPollHandle = setInterval(loadJobs, 2000);
  } else if (active.length === 0 && jobsPollHandle) {
    clearInterval(jobsPollHandle); jobsPollHandle = null;
    // One last refresh of the data the jobs touched
    loadPipeline(); loadCase();
  }
}

function renderJobRow(j) {
  const statusIcon = j.status === 'completed' ? '✓'
    : j.status === 'failed' ? '⚠'
    : j.status === 'cancelled' ? '✕'
    : j.status === 'running' ? '◐'
    : '○';
  const pct = j.progress?.total > 0 ? Math.round((j.progress.current / j.progress.total) * 100) : 0;
  const pctStr = j.progress?.total > 1 ? ` · ${j.progress.current}/${j.progress.total}` : '';
  const cancelBtn = (j.status === 'running' || j.status === 'queued')
    ? `<button type="button" data-cancel="${escapeHtml(j.jobId)}" class="btn-ghost-sm" title="Abbrechen">✕</button>` : '';
  const errMsg = j.error?.message ? `<div class="ws-job-error">${escapeHtml(j.error.message)}</div>` : '';
  return `
    <div class="ws-job-row ws-job-${j.status}">
      <span class="ws-job-icon" title="${j.status}">${statusIcon}</span>
      <span class="ws-job-kind"><strong>${escapeHtml(j.kind)}</strong>${j.inputs?.step ? ` <span class="muted">${escapeHtml(j.inputs.step)}</span>` : ''}</span>
      <span class="ws-job-progress">${pctStr}</span>
      <span class="ws-job-time muted">${fmtDate(j.createdAt)}</span>
      <span class="ws-job-pipe muted mono">${escapeHtml(j.pipelineRef ?? '')}</span>
      ${j.status === 'running' && j.progress?.total > 0
        ? `<div class="ws-job-bar"><div class="ws-job-bar-fill" style="width:${pct}%"></div></div>` : ''}
      ${cancelBtn}
      ${errMsg}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Bulk-Selection state + Bulk-Bar wiring
// ---------------------------------------------------------------------------

function refreshBulkBar() {
  const bar = document.getElementById('ws-bulk-bar');
  const num = document.getElementById('ws-bulk-count-num');
  if (!bar || !num) return;
  const n = selectedRows.size;
  num.textContent = n;
  bar.hidden = n === 0;
  // Sync header check-all state
  const headCheck = document.getElementById('pl-check-all');
  if (headCheck && lastPipeline) {
    const totalRows = lastPipeline.docs?.length ?? 0;
    headCheck.checked = totalRows > 0 && n === totalRows;
    headCheck.indeterminate = n > 0 && n < totalRows;
  }
}

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (t.classList.contains('pl-check')) {
    const u = t.dataset.uuid;
    if (!u) return;
    if (t.checked) selectedRows.add(u); else selectedRows.delete(u);
    refreshBulkBar();
  } else if (t.id === 'pl-check-all') {
    const checked = t.checked;
    selectedRows.clear();
    if (checked) for (const d of (lastPipeline?.docs ?? [])) selectedRows.add(d.uuid);
    if (lastPipeline) renderMatrix(lastPipeline);
    refreshBulkBar();
  }
});

document.getElementById('ws-bulk-clear')?.addEventListener('click', () => {
  selectedRows.clear();
  if (lastPipeline) renderMatrix(lastPipeline);
  refreshBulkBar();
});

document.querySelectorAll('.ws-bulk-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const step = btn.dataset.bulkStep;
    const uuids = [...selectedRows];
    if (uuids.length === 0 || !step) return;
    btn.disabled = true;
    try {
      const job = await api(`/api/workspaces/${encodeURIComponent(wsId)}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: uuids.length > 1 ? 'batch' : step, inputs: { docUuids: uuids, step } }),
      });
      // Show jobs panel + start polling
      loadJobs();
      // Clear selection after kicking off
      selectedRows.clear();
      if (lastPipeline) renderMatrix(lastPipeline);
      refreshBulkBar();
    } catch (e) {
      alert(`Bulk-${step} fehlgeschlagen: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });
});

document.getElementById('ws-jobs-refresh')?.addEventListener('click', () => loadJobs());

// Verbindende Werte: jeder Wert mit belege.length >= 2 — also Werte die in mehreren
// Dokumenten desselben Workspaces wieder auftauchen. Pure Datenaggregation, keine Heuristik.
function renderCaseHeader(c) {
  const el = document.getElementById('ws-case-header');
  if (!el) return;
  const docs = c.documents ?? [];
  if (docs.length === 0) { el.innerHTML = ''; return; }

  // Verbindende Werte: jeder values[]-Eintrag mit ≥ 2 Belegen.
  const linkers = (c.values ?? [])
    .filter((v) => (v.belege?.length ?? 0) >= 2)
    .sort((a, b) => (b.belege.length - a.belege.length));

  // Klassifikations-Verteilung (Counts pro label, gruppiert nach displayName wenn vorhanden).
  const labelCounts = new Map();
  for (const d of docs) {
    const k = d.klassifikation;
    if (!k?.label) continue;
    // Phase B: gruppiere nach displayName wenn pipeline-classification gematcht
    const key = k.displayName ?? prettyLabel(k.label);
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const labels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Render
  const linkersHtml = linkers.length === 0
    ? `<p class="muted" style="margin:0">Noch keine Werte, die in mehreren Dokumenten vorkommen — entweder zu wenige Dokumente, oder keine Überschneidungen erkannt.</p>`
    : `<table class="case-linkers">
        <thead><tr><th>Wert</th><th>Pfad</th><th>Belege</th></tr></thead>
        <tbody>${linkers.slice(0, 12).map((v) => `
          <tr>
            <td class="case-linker-val mono">${escapeHtml(v.wert)}</td>
            <td class="case-linker-path muted">${escapeHtml(v.pfad)}</td>
            <td><span class="case-linker-count" title="${escapeHtml(v.belege.map((b) => b.dateiname).join(', '))}">${v.belege.length}× <span class="muted">in ${v.belege.length} Dokumenten</span></span></td>
          </tr>
        `).join('')}</tbody>
      </table>`;

  const labelsHtml = labels.length === 0
    ? '<span class="muted">Keine Klassifikationen vorhanden.</span>'
    : labels.map(([lbl, n]) => `
        <span class="case-label-chip" title="${n} Dokument${n === 1 ? '' : 'e'}">
          <span class="case-label-name">${escapeHtml(lbl)}</span>
          <span class="case-label-count">${n}</span>
        </span>
      `).join('');

  el.innerHTML = `
    <header class="ws-case-head">
      <h3>Fall-Steckbrief</h3>
      <span class="muted">${docs.length} Dokumente · ${c.values?.length ?? 0} eindeutige Werte · ${linkers.length} verbindende</span>
    </header>
    <div class="ws-case-body">
      <div class="ws-case-section">
        <h4>Verbindende Werte <span class="muted">(in ≥ 2 Dokumenten)</span></h4>
        ${linkersHtml}
      </div>
      <div class="ws-case-section">
        <h4>Dokument-Klassen <span class="muted">(${labels.length})</span></h4>
        <div class="case-labels">${labelsHtml}</div>
      </div>
    </div>
  `;
}

function renderContentCards(c) {
  const root = document.getElementById('ws-content-cards');
  const meta = document.getElementById('ws-content-meta');
  if (!root) return;
  const docs = c.documents ?? [];
  const valuesByDoc = new Map(); // uuid → values[]
  for (const v of (c.values ?? [])) {
    for (const b of (v.belege ?? [])) {
      if (!valuesByDoc.has(b.uuid)) valuesByDoc.set(b.uuid, []);
      valuesByDoc.get(b.uuid).push(v);
    }
  }
  if (meta) meta.textContent = `${docs.length} Dokument${docs.length === 1 ? '' : 'e'}`;
  if (docs.length === 0) {
    root.innerHTML = '<p class="muted" style="padding:24px">Noch keine klassifizierten Dokumente.</p>';
    return;
  }
  root.innerHTML = docs.map((d) => renderContentCard(d, valuesByDoc.get(d.uuid) ?? [])).join('');
  root.querySelectorAll('.cc-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.cc-card');
      const uuid = card.dataset.uuid;
      if (expandedCards.has(uuid)) { expandedCards.delete(uuid); card.classList.remove('cc-expanded'); btn.textContent = 'Werte zeigen ▾'; }
      else { expandedCards.add(uuid); card.classList.add('cc-expanded'); btn.textContent = 'Werte verbergen ▴'; }
    });
  });
}

function renderContentCard(d, values) {
  const k = d.klassifikation ?? {};
  const e = d.extraktion ?? {};
  const isExpanded = expandedCards.has(d.uuid);
  const conf = k.confidence != null ? `<span class="pl-conf ${confClass(k.confidence)}">${(k.confidence * 100).toFixed(0)}%</span>` : '';
  // Phase B: bevorzuge displayName aus pipeline.classifications, fallback auf prettyLabel(raw label)
  const chipLabel = k.displayName ?? (k.label ? prettyLabel(k.label) : null);
  const labelChip = chipLabel ? `<span class="case-label-chip"><span class="case-label-name">${escapeHtml(chipLabel)}</span></span>` : '';
  const fullName = fullFilename(d.dateiname);

  // Stats-Reihe — nur was vorhanden ist
  const stats = [];
  stats.push(`<span class="cc-stat"><strong>${k.kpiCount ?? 0}</strong> KPIs</span>`);
  if (e.pages) stats.push(`<span class="cc-stat"><strong>${e.pages}</strong> Seiten</span>`);
  if (e.chars) stats.push(`<span class="cc-stat"><strong>${(e.chars/1000).toFixed(1)}k</strong> Zeichen</span>`);
  if (k.tokens) stats.push(`<span class="cc-stat"><strong>${fmtTokens(k.tokens)}</strong> Tokens</span>`);
  if (k.ms) stats.push(`<span class="cc-stat"><strong>${fmtMs(k.ms)}</strong> Klassifikation</span>`);

  const valuesTable = values.length === 0
    ? `<p class="muted">Keine Werte für dieses Dokument.</p>`
    : `<table class="cc-values-table">
        <thead><tr><th>Pfad</th><th>Wert</th><th>Quelle</th></tr></thead>
        <tbody>
          ${values.slice(0, 100).map((v) => {
            const norm = v.wertNormalisiert !== undefined && String(v.wertNormalisiert) !== v.wert
              ? ` <span class="muted mono">→ ${escapeHtml(String(v.wertNormalisiert))}</span>` : '';
            const provBadge = v.herkunft && v.herkunft !== 'mistral'
              ? ` <span class="prov-badge prov-${v.herkunft.includes('claude') ? 'claude' : v.herkunft.includes('manual') ? 'manual' : 'rescue'}">${escapeHtml(v.herkunft)}</span>` : '';
            return `<tr>
              <td class="mono">${escapeHtml(v.pfad)}</td>
              <td>${escapeHtml(v.wert)}${norm}</td>
              <td><span class="ws-pill">${escapeHtml(v.quelle)}</span>${provBadge}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>${values.length > 100 ? `<p class="muted">… ${values.length - 100} weitere ausgeblendet</p>` : ''}`;

  return `
    <article class="cc-card ${isExpanded ? 'cc-expanded' : ''}" data-uuid="${escapeHtml(d.uuid)}">
      <header class="cc-card-head">
        <div class="cc-card-title-row">
          ${fileIcon(d.dateiname, d.mime)}
          <a class="cc-filename" href="/document.html?ws=${encodeURIComponent(wsId)}&uuid=${encodeURIComponent(d.uuid)}" title="${escapeHtml(fullName)} — Detail-Seite öffnen">${escapeHtml(truncateFilename(d.dateiname, 64))}</a>
          ${labelChip}
          ${conf}
        </div>
        ${k.summary ? `<p class="cc-summary">${escapeHtml(k.summary)}</p>` : ''}
        <div class="cc-stats-row">${stats.join('')}</div>
      </header>
      <div class="cc-card-actions">
        <button type="button" class="cc-toggle btn-ghost-sm">${isExpanded ? 'Werte verbergen ▴' : 'Werte zeigen ▾'}</button>
      </div>
      <div class="cc-card-body">${valuesTable}</div>
    </article>
  `;
}

// ---------------------------------------------------------------------------
// Pipeline — fetch + render strip + matrix
// ---------------------------------------------------------------------------

async function loadPipeline() {
  try {
    lastPipeline = await api(`/api/workspaces/${encodeURIComponent(wsId)}/pipeline`);
    renderPipelinePill(lastPipeline);
    renderStats(lastPipeline);
    renderProgress(lastPipeline);
    renderStrip(lastPipeline);
    renderMatrix(lastPipeline);
    renderCanonicals(lastPipeline);
  } catch (e) {
    stripEl.innerHTML = `<p class="error-text">${escapeHtml(e.message)}</p>`;
    matrixEl.innerHTML = '';
  }
}

function dotChar(passed, partial, total) {
  if (total === 0) return '○';
  if (passed === total) return '●';
  if (passed + partial === total) return '◑';
  if (passed > 0 || partial > 0) return '◐';
  return '○';
}

function fmtBytesShort(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function fmtMs(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}
function fmtTokens(t) {
  if (t < 1000) return `${t} tok`;
  if (t < 1_000_000) return `${(t / 1000).toFixed(1)}k tok`;
  return `${(t / 1_000_000).toFixed(2)}M tok`;
}

/** Per-doc detail lines for a single node when one row is selected.
 *  Pulls from doc.status — derived server-side per doc. */
function docDetailLines(nodeId, doc) {
  if (!doc) return [];
  const s = doc.status?.[nodeId];
  if (!s || s.state === 'pending') return ['—'];
  const out = [];
  switch (nodeId) {
    case 'ingest':
      if (s.sizeBytes != null) out.push(fmtBytesShort(s.sizeBytes));
      if (s.mime) out.push(s.mime.split('/')[1] ?? s.mime);
      if (s.ingestedAt) out.push(fmtDate(s.ingestedAt));
      break;
    case 'classify':
      if (s.label) out.push(s.label);
      if (s.confidence != null) out.push(`${(s.confidence * 100).toFixed(0)}% conf`);
      if (s.kpiCount != null) out.push(`${s.kpiCount} KPIs`);
      if (s.tokens != null) out.push(fmtTokens(s.tokens));
      if (s.ms != null) out.push(fmtMs(s.ms));
      break;
    case 'route':
      if (s.folder) out.push(`${s.folder}/`);
      break;
    case 'template':
      if (s.name) out.push(s.name);
      if (s.id) out.push(s.id);
      if (s.source) out.push(s.source);
      if (s.schemaSize != null) out.push(`${s.schemaSize} Felder`);
      break;
    case 'extract':
      if (s.coveragePct != null) out.push(`${s.coveragePct}% cov`);
      if (s.filledCount != null && s.schemaTotal != null) out.push(`${s.filledCount}/${s.schemaTotal} Felder`);
      if (s.leakage != null) out.push(`⚠ ${s.leakage} untapped`);
      if (s.pages != null) out.push(`${s.pages} S.`);
      if (s.ms != null) out.push(fmtMs(s.ms));
      if (s.hallucinations != null && s.hallucinations > 0) out.push(`⚠ ${s.hallucinations} hallu`);
      if (s.costEur != null) out.push(`€${s.costEur.toFixed(4)}`);
      if (s.model) out.push(s.model.replace(/^mistral-/, ''));
      break;
    case 'approve':
      if (s.at) out.push(fmtDate(s.at));
      else out.push('offen');
      break;
  }
  return out;
}

/** ONE main metric per node — kept short (≤ 24 chars) so all cards line up. */
function nodeMainMetric(n) {
  const q = n.quality;
  if (!q) return null;
  switch (q.kind) {
    case 'ingest':   return q.totalBytes > 0 ? fmtBytesShort(q.totalBytes) : null;
    case 'classify': return q.avgConfidence != null ? `Ø Konfidenz ${(q.avgConfidence * 100).toFixed(0)}%` : null;
    case 'route':    return q.folders ? `${Object.values(q.folders).filter((c) => c > 0).length} Klassen` : null;
    case 'template': {
      if (q.none > 0) return `${q.none} ohne Vorlage`;
      if (q.canonical > 0) return `${q.canonical} kanonisch`;
      return null;
    }
    case 'extract':  return q.avgCoverage != null ? `Ø Abdeckung ${q.avgCoverage}%` : null;
    case 'approve':  return q.latestAt ? `zuletzt ${fmtDate(q.latestAt)}` : null;
  }
  return null;
}

/** Detail lines — shown only on hover/tooltip, not by default in the card. */
function nodeDetailLines(n) {
  const q = n.quality;
  if (!q) return [];
  const out = [];
  switch (q.kind) {
    case 'ingest': {
      if (q.mimes && Object.keys(q.mimes).length > 0) {
        out.push(Object.entries(q.mimes).map(([m, n]) => `${n} ${m}`).join(' · '));
      }
      break;
    }
    case 'classify': {
      if (q.totalKpis > 0) out.push(`${q.totalKpis} KPIs gesamt`);
      if (q.totalTokens > 0) out.push(`${fmtTokens(q.totalTokens)} Tokens`);
      if (q.totalMs > 0) out.push(`Gesamtdauer ${fmtMs(q.totalMs)}`);
      if (q.distinctLabels?.length > 0) out.push(`${q.distinctLabels.length} Klassen`);
      break;
    }
    case 'route': {
      if (q.folders) {
        const entries = Object.entries(q.folders).filter(([, c]) => c > 0);
        for (const [f, c] of entries) out.push(`${prettyLabel(f)} · ${c}`);
      }
      break;
    }
    case 'template': {
      const parts = [];
      if (q.canonical > 0) parts.push(`${q.canonical} kanonisch`);
      if (q.playground > 0) parts.push(`${q.playground} Playground`);
      if (q.manual > 0) parts.push(`${q.manual} manuell`);
      if (q.none > 0) parts.push(`${q.none} ohne Vorlage`);
      if (parts.length) out.push(parts.join(' · '));
      break;
    }
    case 'extract': {
      if (q.totalFilledFields > 0) out.push(`${q.totalFilledFields}/${q.totalSchemaFields} Felder befüllt`);
      if (q.avgLeakage != null) out.push(`Ø ⚠ ${q.avgLeakage} ungenutzt`);
      if (q.totalPages > 0) out.push(`${q.totalPages} Seiten`);
      if (q.totalHallucinations > 0) out.push(`⚠ ${q.totalHallucinations} Halluzinationen`);
      break;
    }
    case 'approve': {
      if (q.distinctTemplates?.length > 0) out.push(`${q.distinctTemplates.length} Templates`);
      break;
    }
  }
  return out;
}

function renderStrip(pipeline) {
  const summary = pipeline.summary ?? {};
  const selectedDoc = selectedUuid ? pipeline.docs.find((d) => d.uuid === selectedUuid) : null;

  // Header: workspace summary OR selected-doc summary
  if (selectedDoc) {
    totalsEl.innerHTML = `
      <span class="pl-selected-pill">
        <strong>${escapeHtml(selectedDoc.filename)}</strong>
        <button type="button" class="pl-selected-clear" title="Auswahl aufheben">×</button>
      </span>
    `;
    const clearBtn = totalsEl.querySelector('.pl-selected-clear');
    clearBtn?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectedUuid = null;
      renderStrip(lastPipeline);
      renderMatrix(lastPipeline);
    });
  } else {
    // Pipeline-Simplify: nur Core-Steps zählen für den Fortschritts-Hint.
    // Optional steps (template/extract) sind Side-Branches — nicht jedes Doc
    // braucht sie.
    const coreNodes = pipeline.nodes.filter((n) => !n.optional);
    const stepsDone = coreNodes.filter((n) => n.passed === n.total && n.total > 0).length;
    const stepsTotal = coreNodes.length;
    const nextNode = coreNodes.find((n) => n.passed < n.total);
    const parts = [`${stepsDone} von ${stepsTotal} Core-Schritten abgeschlossen`];
    if (nextNode) parts.push(`als nächstes: ${nextNode.name}`);
    const optionalCount = pipeline.nodes.length - coreNodes.length;
    if (optionalCount > 0) parts.push(`+${optionalCount} optional`);
    totalsEl.textContent = parts.join(' · ');
  }

  stripEl.innerHTML = pipeline.nodes.map((n) => {
    // Status: empty (0/N) gets a dimmed pending look; partial = ◐; full = ●
    const isEmpty = !selectedDoc && n.passed === 0 && n.total > 0;
    const isComplete = !selectedDoc && n.passed === n.total && n.total > 0;
    const dot = selectedDoc
      ? (selectedDoc.status[n.id]?.state === 'ok' ? '●'
        : selectedDoc.status[n.id]?.state === 'partial' ? '◐'
        : selectedDoc.status[n.id]?.state === 'fail' ? '×'
        : '○')
      : dotChar(n.passed, n.partial ?? 0, n.total);
    const detailLines = selectedDoc ? docDetailLines(n.id, selectedDoc) : nodeDetailLines(n);
    const mainMetric = selectedDoc ? null : nodeMainMetric(n);
    const isFilter = activeNodeFilter === n.id;
    let countLine;
    if (selectedDoc) {
      const s = selectedDoc.status[n.id];
      countLine = s?.state === 'ok' ? '✓ erledigt'
        : s?.state === 'partial' ? '◐ teilweise'
        : s?.state === 'fail' ? '✗ Fehler'
        : '○ offen';
    } else {
      const partialBit = (n.partial ?? 0) > 0 ? `<span class="pl-partial muted"> + ${n.partial} ◐</span>` : '';
      countLine = `${n.passed}/${n.total}${partialBit}`;
    }
    const filterIcon = !selectedDoc ? `<span class="pl-filter-icon" aria-hidden="true">⌕</span>` : '';
    // Tooltip carries the verbose detail lines so we can keep the card itself clean.
    const detailTooltip = detailLines.length > 0 ? '\n\n' + detailLines.join('\n') : '';
    const tooltip = (selectedDoc
      ? `${n.name} – Status für ausgewähltes Dokument`
      : `Klick zum Filtern: nur Dokumente, die ${n.name} noch nicht abgeschlossen haben`) + detailTooltip;
    const stateCls = isEmpty ? 'pl-node-empty' : isComplete ? 'pl-node-complete' : 'pl-node-partial';
    const optionalCls = n.optional ? 'pl-node-optional' : '';
    const optionalBadge = n.optional ? '<span class="pl-optional-badge" title="Optional — Side-Branch, nicht für jedes Dokument nötig">opt</span>' : '';
    return `
      <button type="button" class="pipeline-node ${stateCls} ${optionalCls} ${isFilter ? 'is-filter' : ''}" data-node="${escapeHtml(n.id)}" title="${escapeHtml(tooltip)}">
        ${filterIcon}
        ${optionalBadge}
        <div class="pl-dot">${dot}</div>
        <div class="pl-name">${escapeHtml(n.name)}</div>
        <div class="pl-count">${countLine}</div>
        <div class="pl-main-metric">${mainMetric ? escapeHtml(mainMetric) : '<span class="muted">—</span>'}</div>
      </button>
    `;
  }).join('<span class="pl-arrow muted">→</span>');
  stripEl.querySelectorAll('.pipeline-node').forEach((btn) => {
    btn.addEventListener('click', () => {
      // When a doc is selected, node click does nothing (strip is a passive dashboard).
      if (selectedDoc) return;
      const node = btn.dataset.node;
      activeNodeFilter = activeNodeFilter === node ? null : node;
      renderStrip(lastPipeline);
      renderMatrix(lastPipeline);
    });
  });
}

function renderCanonicals(pipeline) {
  const tplNode = pipeline.nodes.find((n) => n.id === 'template');
  const usage = tplNode?.quality?.canonicalUsage ?? {};
  const ids = Object.keys(usage);
  if (ids.length === 0) {
    canonicalsEl.textContent = '';
    return;
  }
  canonicalsEl.innerHTML = `Canonical-Ziele: ${ids.map((id) => `<span class="ws-pill" style="margin-right:4px">${escapeHtml(id)} · ${usage[id]}</span>`).join('')}`;
}

// NODES + NODE_LABEL kommen jetzt aus der Pipeline-Definition (lastPipeline.nodes
// vom /api/workspaces/:ws/pipeline-Endpoint, der pipelines-seed/<id>@<v>.json
// auflöst). Die folgenden Helpers lesen die aktuelle Pipeline aus lastPipeline,
// damit sich Reihenfolge und Anzeige-Namen pro Workspace-Bindung ändern können
// ohne UI-Code-Patch.
function renderPipelinePill(pipeline) {
  const el = document.getElementById('ws-pipeline-pill');
  if (!el) return;
  const p = pipeline?.pipeline;
  if (!p) { el.hidden = true; return; }
  el.hidden = false;
  const tag = `${p.id}@${p.version}`;
  el.textContent = p.bound ? tag : `${tag} (default)`;
  el.title = `Pipeline: ${p.displayName ?? tag} — ${p.bound ? 'explizit gebunden via binding.json' : 'Default-Fallback (kein binding.json gesetzt)'}`;
  el.classList.toggle('ws-pipeline-pill-default', !p.bound);
}

function pipelineNodes() { return lastPipeline?.nodes ?? []; }
function pipelineNodeIds() { return pipelineNodes().map((n) => n.id); }
function pipelineNodeLabel(nodeId) {
  const n = pipelineNodes().find((x) => x.id === nodeId);
  return n?.displayName ?? nodeId;
}

function cellHtml(nodeId, status) {
  const s = status[nodeId];
  const state = s?.state ?? 'pending';
  let inner;
  let extraCls = '';
  if (state === 'pending') {
    inner = '<span class="pl-cell-mark" title="Ausstehend">○</span>';
  } else {
    let mark = '✓';
    let markTitle = 'Erledigt';
    if (state === 'fail') { mark = '⚠'; markTitle = 'Fehler / Blockiert'; }
    else if (state === 'partial') { mark = '◐'; markTitle = 'Teilweise erledigt'; }
    let detail = '';
    if (nodeId === 'classify' && s.label) {
      const confPct = s.confidence != null ? (s.confidence * 100).toFixed(0) : null;
      const confSpan = confPct != null
        ? `<span class="pl-conf ${confClass(s.confidence)}" title="Konfidenz ${confPct}%">${confPct}%</span>`
        : '';
      // Phase B: bevorzuge pipeline-displayName, fallback auf prettyLabel(raw)
      const shown = s.displayName ?? prettyLabel(s.label);
      detail = `<span class="pl-cell-detail" title="${escapeHtml(s.label)}">${escapeHtml(shown)} ${confSpan}</span>`;
    } else if (nodeId === 'route' && s.folder) {
      // Phase B: bevorzuge displayName aus classification, fallback prettyLabel(folder-slug)
      const shown = s.displayName ?? prettyLabel(s.folder);
      detail = `<span class="pl-cell-detail" title="${escapeHtml(s.folder)}">${escapeHtml(shown)}</span>`;
    } else if (nodeId === 'template' && s.name) {
      detail = `<span class="pl-cell-detail">${escapeHtml(s.name)}</span>`;
    } else if (nodeId === 'extract' && s.coveragePct != null) {
      const leak = s.leakage != null ? ` <span class="muted">⚠${s.leakage}</span>` : '';
      const halls = s.hallucinations > 0 ? ` <span class="pl-conf-low">⚠${s.hallucinations}h</span>` : '';
      detail = `<span class="pl-cell-detail">${s.coveragePct}%${leak}${halls}</span>`;
    } else if (nodeId === 'approve' && s.at) {
      detail = `<span class="pl-cell-detail">${fmtDate(s.at)}</span>`;
    }
    inner = `<span class="pl-cell-mark" title="${markTitle}">${mark}</span>${detail}`;
  }
  return `<td class="pl-cell pl-cell-${state}${extraCls}" data-node="${nodeId}">${inner}</td>`;
}

function destinationTab(nodeId, status) {
  const s = status[nodeId];
  if (nodeId === 'template' && s.state === 'pending') return 'schema';
  if (nodeId === 'extract') return 'werte-fluss';
  if (nodeId === 'approve' && s.state === 'pending') return 'master';
  return 'insight';
}

function passesFilter(status) {
  if (!activeNodeFilter) return true;
  const s = status[activeNodeFilter];
  return !s || s.state !== 'ok'; // show docs that haven't cleared this node
}

function renderMatrix(pipeline) {
  const docs = pipeline.docs.filter((d) => passesFilter(d.status));
  if (activeNodeFilter) {
    filterEl.textContent = `Nur ausstehende: ${pipelineNodeLabel(activeNodeFilter)}`;
    filterEl.classList.remove('hidden');
  } else {
    filterEl.textContent = '';
    filterEl.classList.add('hidden');
  }
  clearFilterBtn.classList.toggle('hidden', !activeNodeFilter);
  matrixTitleEl.textContent = activeNodeFilter
    ? `${docs.length} von ${pipeline.docs.length} (${pipelineNodeLabel(activeNodeFilter)} offen)`
    : `${pipeline.docs.length} ${pipeline.docs.length === 1 ? 'Dokument' : 'Dokumente'}`;

  if (pipeline.docs.length === 0) {
    matrixEl.innerHTML = '<p class="muted" style="padding:24px">Keine Dokumente. Lade oben rechts welche hoch.</p>';
    return;
  }
  if (docs.length === 0) {
    matrixEl.innerHTML = `<p class="muted" style="padding:24px">Keine Dokumente passen zum Filter.</p>`;
    return;
  }

  const nodeIds = pipelineNodeIds();
  const head = `
    <thead>
      <tr>
        <th class="pl-check-head"><input type="checkbox" id="pl-check-all" title="Alle aus-/abwählen" /></th>
        <th class="pl-doc-head">Dokument</th>
        ${nodeIds.map((n) => `<th class="pl-node-head">${escapeHtml(pipelineNodeLabel(n))}</th>`).join('')}
        <th class="pl-open-head"></th>
      </tr>
    </thead>
  `;
  const body = docs.map((d) => {
    const isSelected = d.uuid === selectedUuid;
    return `
    <tr data-uuid="${escapeHtml(d.uuid)}" class="${isSelected ? 'pl-row-selected' : ''} ${selectedRows.has(d.uuid) ? 'pl-row-checked' : ''}">
      <td class="pl-check-cell"><input type="checkbox" class="pl-check" data-uuid="${escapeHtml(d.uuid)}" ${selectedRows.has(d.uuid) ? 'checked' : ''} /></td>
      <td class="pl-doc-cell" title="Klick: Strip-Ansicht auf dieses Dokument setzen">
        <div class="pl-doc-name-row">
          ${fileIcon(d.filename, d.mime)}
          <a class="pl-filename" href="/document.html?ws=${encodeURIComponent(wsId)}&uuid=${encodeURIComponent(d.uuid)}" title="${escapeHtml(fullFilename(d.filename))} — Detail-Seite öffnen">${escapeHtml(truncateFilename(d.filename, 56))}</a>
        </div>
        <div class="muted pl-doc-meta">${fmtBytes(d.size)} · ${fmtDate(d.ingestedAt)}</div>
      </td>
      ${nodeIds.map((n) => cellHtml(n, d.status)).join('')}
      <td class="pl-open-cell">
        <button type="button" class="pl-vc-btn" data-vc-uuid="${escapeHtml(d.uuid)}" title="Visuelle Kontrolle öffnen">👁</button>
        <a class="pl-open-link" href="/document.html?ws=${encodeURIComponent(wsId)}&uuid=${encodeURIComponent(d.uuid)}" title="Detail-Seite öffnen">↗</a>
      </td>
    </tr>
  `;
  }).join('');
  matrixEl.innerHTML = `<table class="pl-table">${head}<tbody>${body}</tbody></table>`;

  // Row click → select for the strip dashboard.
  // Anchor links (filename + ↗) keep their default navigate behavior via stopPropagation.
  matrixEl.querySelectorAll('a.pl-filename, a.pl-open-link').forEach((link) => {
    link.addEventListener('click', (ev) => ev.stopPropagation());
  });
  matrixEl.querySelectorAll('button.pl-vc-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openVisualControl(btn.dataset.vcUuid);
    });
  });
  matrixEl.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      const uuid = tr.dataset.uuid;
      if (!uuid) return;
      selectedUuid = selectedUuid === uuid ? null : uuid;
      renderStrip(lastPipeline);
      renderMatrix(lastPipeline);
    });
  });
}

clearFilterBtn.addEventListener('click', () => {
  activeNodeFilter = null;
  renderStrip(lastPipeline);
  renderMatrix(lastPipeline);
});

// ---------------------------------------------------------------------------
// Upload (multi-file with SSE per file). Reuses existing endpoint.
// ---------------------------------------------------------------------------

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
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let data;
      try { data = JSON.parse(dataLines.join('\n')); } catch { data = dataLines.join('\n'); }
      onEvent(event, data);
    }
  }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList ?? []);
  if (files.length === 0) return;
  const headers = {};
  const tok = localStorage.getItem('sturm-token');
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const tag = `(${i + 1}/${files.length}) ${f.name}`;
    dropStatus.textContent = `${tag} – hochladen…`;
    try {
      const fd = new FormData();
      fd.append('file', f);
      const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/upload`, { method: 'POST', body: fd, headers });
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      }
      let lastError = null;
      await consumeSse(resp.body, (event, data) => {
        if (event === 'ingested') dropStatus.textContent = `${tag} – klassifiziere…`;
        else if (event === 'classify_started') dropStatus.textContent = `${tag} – mistral-small analysiert…`;
        else if (event === 'classify_done') dropStatus.textContent = `${tag} – ${data.label} (${(data.confidence * 100).toFixed(0)}% / ${data.kpis?.length ?? 0} KPIs / ${data.ms} ms)`;
        else if (event === 'routed') dropStatus.textContent = `${tag} – verschoben → ${data.classification}/`;
        else if (event === 'classify_skipped') dropStatus.textContent = `${tag} – nur abgelegt (${data.reason})`;
        else if (event === 'error') lastError = data.message ?? 'unknown';
      });
      if (lastError) throw new Error(lastError);
    } catch (e) {
      dropStatus.textContent = `Fehler bei ${f.name}: ${e.message}`;
      return;
    }
  }
  dropStatus.textContent = `${files.length} verarbeitet.`;
  await loadPipeline();
  loadCase();
}

dropZoneMini?.addEventListener('click', (ev) => {
  if (ev.target !== fileInput) fileInput.click();
});
fileInput?.addEventListener('change', (ev) => uploadFiles(ev.target.files));

// Drag & drop on the matrix area too — convenience.
['dragenter', 'dragover'].forEach((ev) => {
  matrixEl.addEventListener(ev, (e) => { e.preventDefault(); matrixEl.classList.add('hover'); });
});
['dragleave', 'drop'].forEach((ev) => {
  matrixEl.addEventListener(ev, (e) => { e.preventDefault(); matrixEl.classList.remove('hover'); });
});
matrixEl.addEventListener('drop', (e) => uploadFiles(e.dataTransfer?.files));

// ---------------------------------------------------------------------------
// Visuelle Kontrolle — 3-Pane Modal-Overlay (Doc + KPIs + OCR-Text)
// ---------------------------------------------------------------------------

let vcCurrentMeta = null;

async function openVisualControl(uuid) {
  const modal = document.getElementById('vc-modal');
  if (!modal) return;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  // Reset
  document.getElementById('vc-filename').textContent = 'Lade…';
  document.getElementById('vc-label').textContent = '';
  document.getElementById('vc-conf').textContent = '';
  document.getElementById('vc-stats').textContent = '';
  document.getElementById('vc-kpi-list').innerHTML = '';
  document.getElementById('vc-doc-viewer').innerHTML = '<p class="muted" style="padding:20px">Lade…</p>';
  document.getElementById('vc-ocr-text').innerHTML = '<p class="muted" style="padding:14px">Lade Metadaten…</p>';
  try {
    const meta = await api(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`);
    vcCurrentMeta = meta;
    renderVisualControl(meta);
  } catch (e) {
    document.getElementById('vc-filename').textContent = 'Fehler';
    document.getElementById('vc-doc-viewer').innerHTML = `<p class="error-text" style="padding:20px">${escapeHtml(e.message)}</p>`;
  }
}

function renderVisualControl(meta) {
  const k = meta.classification ?? {};
  const e = meta.extraction ?? {};
  const fileUrl = `/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(meta.uuid)}/file`;
  const isImage = (meta.mime ?? '').startsWith('image/');

  // Header
  document.getElementById('vc-icon').innerHTML = fileIcon(meta.originalFilename, meta.mime);
  document.getElementById('vc-filename').textContent = fullFilename(meta.originalFilename);
  const lbl = document.getElementById('vc-label');
  if (k.displayName || k.label) {
    lbl.textContent = k.displayName ?? prettyLabel(k.label);
    lbl.style.display = '';
  } else lbl.style.display = 'none';
  const conf = document.getElementById('vc-conf');
  if (k.confidence != null) {
    const pct = (k.confidence * 100).toFixed(0);
    conf.textContent = `${pct}%`;
    conf.className = 'pl-conf ' + confClass(k.confidence);
    conf.style.display = '';
  } else conf.style.display = 'none';
  const stats = [];
  stats.push(`${k.kpis?.length ?? 0} KPIs`);
  if (e.pages) stats.push(`${e.pages} Seiten`);
  if (e.chars) stats.push(`${(e.chars / 1000).toFixed(1)}k Zeichen OCR`);
  if (k.ms) stats.push(`Classify ${fmtMs(k.ms)}`);
  document.getElementById('vc-stats').textContent = stats.join(' · ');

  // Document viewer (left)
  const vcDoc = document.getElementById('vc-doc-viewer');
  vcDoc.innerHTML = isImage
    ? `<div class="vc-img-wrap" style="position:relative; display:inline-block"><img id="vc-doc-img" src="${fileUrl}" alt="${escapeHtml(meta.originalFilename)}" /></div>`
    : `<iframe id="vc-doc-iframe" src="${fileUrl}#view=Fit" title="${escapeHtml(meta.originalFilename)}"></iframe>`;
  vcImgEl = isImage ? document.getElementById('vc-doc-img') : null;
  vcBboxes = null;
  // Auto-load existing bboxes if available (no OCR needed)
  if (isImage && vcImgEl) {
    vcImgEl.addEventListener('load', async () => {
      try {
        const headers = {};
        const tok = localStorage.getItem('sturm-token');
        if (tok) headers['Authorization'] = `Bearer ${tok}`;
        const r = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(meta.uuid)}/bboxes`, { headers });
        if (r.status === 200) {
          vcBboxes = await r.json();
          await applyLiveTextLayer();
          const btn = document.getElementById('vc-livetext');
          if (btn) btn.textContent = `📐 ${vcBboxes.pages?.[0]?.words?.length ?? 0} Wörter (cached)`;
        }
        // 204 = no bboxes yet → silent, user can click 📐 Live Text
      } catch { /* silent — user can click 📐 Live Text to OCR */ }
    }, { once: true });
  }

  // KPI list (middle)
  const kpis = k.kpis ?? [];
  document.getElementById('vc-kpi-count').textContent = String(kpis.length);
  renderVcKpiList(kpis, '');

  // OCR-Text (right) — von extraction.markdown wenn vorhanden
  const ocrEl = document.getElementById('vc-ocr-text');
  const ocrMeta = document.getElementById('vc-ocr-meta');
  if (e.markdown) {
    ocrMeta.textContent = `(${e.chars ?? e.markdown.length} Zeichen, ${e.pages ?? '?'} Seiten)`;
    ocrEl.innerHTML = `<pre id="vc-ocr-pre">${escapeHtml(e.markdown)}</pre>`;
  } else {
    ocrMeta.textContent = '(nicht verfügbar)';
    ocrEl.innerHTML = `
      <div style="padding:14px">
        <p class="muted">Kein OCR-Text. Klick auf einen KPI links → Wert wird in die Zwischenablage kopiert + im PDF browser-find getriggert.</p>
        <button type="button" id="vc-trigger-extract" class="btn-secondary" style="margin-top:8px">▸ OCR-Text jetzt holen (mistral-ocr-latest, ~3 s)</button>
      </div>
    `;
    document.getElementById('vc-trigger-extract')?.addEventListener('click', triggerVcExtract);
  }
}

function renderVcKpiList(kpis, filter) {
  const list = document.getElementById('vc-kpi-list');
  const lc = filter.toLowerCase();
  const filtered = filter
    ? kpis.filter((k) => k.key.toLowerCase().includes(lc) || k.value.toLowerCase().includes(lc))
    : kpis;
  // Coverage-Summary oben anzeigen wenn citations vorhanden sind
  const haveCitations = kpis.some((k) => 'citation' in k);
  let summaryHtml = '';
  if (haveCitations) {
    const cited = kpis.filter((k) => k.citation).length;
    const uncitable = kpis.length - cited;
    summaryHtml = `<li class="vc-kpi-summary">
      <span class="vc-cite-pill vc-cite-good">📌 ${cited} zitiert</span>
      ${uncitable > 0 ? `<span class="vc-cite-pill vc-cite-bad">⚠ ${uncitable} uncitable</span>` : ''}
    </li>`;
  }
  list.innerHTML = summaryHtml + filtered.map((k, i) => {
    const cit = k.citation;
    const badge = cit
      ? (cit.confidence === 'verbatim' ? '<span class="vc-cite-badge vc-cite-verbatim" title="Wortgleich im OCR-Text">📌</span>'
        : cit.confidence === 'normalized' ? '<span class="vc-cite-badge vc-cite-normalized" title="Format-normalisiert gefunden">🔍</span>'
        : '<span class="vc-cite-badge vc-cite-partial" title="Teilweise im Text">~</span>')
      : haveCitations ? '<span class="vc-cite-badge vc-cite-uncitable" title="Nicht im OCR-Text gefunden — möglicherweise halluziniert">⚠</span>' : '';
    const dim = haveCitations && !cit ? 'vc-kpi-uncitable' : '';
    const pageHint = cit?.page ? `<span class="vc-cite-page">S.${cit.page}</span>` : '';
    return `
      <li class="vc-kpi ${dim}" data-idx="${i}" data-value="${escapeHtml(k.value)}" data-page="${cit?.page ?? ''}" data-offset="${cit?.charOffset ?? ''}" data-len="${cit?.length ?? ''}" data-matched="${escapeHtml(cit?.matchedText ?? '')}">
        <div class="vc-kpi-head">${badge}${pageHint}</div>
        <div class="vc-kpi-key">${escapeHtml(k.key)}</div>
        <div class="vc-kpi-val mono">${escapeHtml(k.value)}</div>
      </li>
    `;
  }).join('');
  list.querySelectorAll('.vc-kpi').forEach((li) => {
    if (li.classList.contains('vc-kpi-summary')) return;
    li.addEventListener('click', () => onVcKpiClick(li));
  });
}

function onVcKpiClick(li) {
  const value = li.dataset.value;
  if (!value) return;
  navigator.clipboard?.writeText(value).catch(() => {});
  const matched = li.dataset.matched || value;
  highlightInOcr(matched);
  // PDF.js Search via URL-Hash für PDFs
  const iframe = document.getElementById('vc-doc-iframe');
  if (iframe?.contentWindow) {
    try {
      const src = iframe.src.split('#')[0];
      iframe.src = `${src}#search=${encodeURIComponent(matched)}`;
    } catch { /* cross-origin etc. */ }
  }
  // Phase H+: für Bilder mit Tesseract-Bboxes → Pixel-Highlight rendern
  let imgHighlighted = false;
  if (vcBboxes && vcImgEl) {
    highlightInImage(matched).then((ok) => {
      if (ok) setVcSearchStatus(`„${value}" → S.${li.dataset.page ?? '?'} markiert auf Bild`);
    });
    imgHighlighted = true;
  }
  if (!imgHighlighted) {
    const page = li.dataset.page;
    const status = page ? `„${value}" → S.${page} im OCR-Text` : `„${value}" kopiert + gesucht`;
    setVcSearchStatus(status);
  }
}

function highlightInOcr(value) {
  const pre = document.getElementById('vc-ocr-pre');
  if (!pre || !value) return;
  // Remove old marks, then re-render with highlights
  const meta = vcCurrentMeta;
  const md = meta?.extraction?.markdown ?? '';
  if (!md) return;
  // Build highlighted html (case-insensitive find-all)
  const escaped = escapeHtml(md);
  const re = new RegExp(escapeRegExp(value), 'gi');
  const escapedSearch = escapeHtml(value);
  // Apply to ESCAPED md so we don't break tags. We escape the search-term too.
  const reEsc = new RegExp(escapeRegExp(escapedSearch), 'gi');
  pre.innerHTML = escaped.replace(reEsc, (m) => `<mark class="vc-mark">${m}</mark>`);
  const first = pre.querySelector('mark');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function triggerVcExtract() {
  const btn = document.getElementById('vc-trigger-extract');
  if (!btn || !vcCurrentMeta) return;
  btn.disabled = true;
  btn.textContent = 'Hole OCR-Text…';
  try {
    // Use the audit-visual path which lazy-fetches OCR text without requiring a template
    const headers = { 'Content-Type': 'application/json' };
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(vcCurrentMeta.uuid)}/audit`, {
      method: 'POST', headers, body: JSON.stringify({ kind: 'visual' }),
    }).then((r) => r.text());
    // Re-fetch meta and re-render
    vcCurrentMeta = await api(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(vcCurrentMeta.uuid)}`);
    renderVisualControl(vcCurrentMeta);
  } catch (e) {
    btn.textContent = 'Fehler: ' + e.message;
  }
}

function setVcSearchStatus(msg) {
  const el = document.getElementById('vc-search-status');
  if (el) el.textContent = msg;
}

document.getElementById('vc-regen-citations')?.addEventListener('click', regenerateCitations);
document.getElementById('vc-livetext')?.addEventListener('click', runLiveText);
document.getElementById('vc-close')?.addEventListener('click', closeVisualControl);

// ---------- Phase H+: Tesseract.js Live-Text-Layer ----------
let vcBboxes = null;     // current doc's bboxes (loaded or freshly OCR'd)
let vcImgEl = null;      // currently displayed <img> (or null for PDF)

async function runLiveText() {
  console.log('[livetext] start, meta=', vcCurrentMeta?.uuid, 'imgEl=', vcImgEl?.tagName);
  if (!vcCurrentMeta) {
    setVcSearchStatus('⚠ Live Text: kein Doc-Meta geladen — Modal neu öffnen.');
    return;
  }
  if (!vcImgEl) {
    setVcSearchStatus('⚠ Live Text geht aktuell nur für Bilder (JPG/PNG). PDFs brauchen PDF→Canvas Render (Roadmap).');
    return;
  }
  const btn = document.getElementById('vc-livetext');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '📐 lade Tesseract.js…';
  setVcSearchStatus('Lade Tesseract (~2 MB einmalig)…');
  try {
    // 1. Try persisted first
    const headers = {};
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    let bboxes = null;
    const cacheResp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(vcCurrentMeta.uuid)}/bboxes`, { headers });
    if (cacheResp.status === 200) {
      bboxes = await cacheResp.json();
      btn.textContent = '📐 lade cached…';
      setVcSearchStatus('Cached Bboxes geladen');
    } else if (cacheResp.status !== 204 && !cacheResp.ok) {
      // 204 = no bboxes yet → fall through to OCR. Other non-2xx = real error.
      throw new Error(`bbox-cache HTTP ${cacheResp.status}`);
    }
    // 2. If no cache, run OCR
    if (!bboxes) {
      const { loadTesseract, ocrImage } = await import('/tesseract-bboxer.js?v=20260428h');
      btn.textContent = '📐 OCR läuft…';
      setVcSearchStatus('Tesseract OCR läuft (5-10s)…');
      const img = vcImgEl;
      if (!img) {
        setVcSearchStatus('Live Text geht aktuell nur für Bilder, nicht PDFs (PDF→Canvas-Render in Roadmap).');
        return;
      }
      const result = await ocrImage(img, {
        lang: 'deu+eng',
        onProgress: (p) => { btn.textContent = `📐 OCR ${Math.round(p * 100)}%`; setVcSearchStatus(`OCR ${Math.round(p * 100)}%…`); },
      });
      bboxes = {
        engine: 'tesseract.js',
        pages: [{ page: 1, words: result.words }],
        pageDimensions: [{ page: 1, width: result.width, height: result.height }],
      };
      // 3. Persist server-side
      await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(vcCurrentMeta.uuid)}/bboxes`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(bboxes),
      });
      setVcSearchStatus(`✓ ${result.words.length} Wörter erkannt + persistiert`);
    }
    vcBboxes = bboxes;
    await applyLiveTextLayer();
    btn.textContent = `📐 ${vcBboxes.pages?.[0]?.words?.length ?? 0} Wörter`;
  } catch (e) {
    console.error('[livetext] failed', e);
    setVcSearchStatus(`Live Text fehlgeschlagen: ${e.message ?? e}`);
    btn.textContent = orig;
  } finally {
    btn.disabled = false;
  }
}

async function applyLiveTextLayer() {
  if (!vcBboxes || !vcImgEl) return;
  const { renderSelectableLayer } = await import('/tesseract-bboxer.js?v=20260428h');
  // Clean previous layer
  const docPane = document.getElementById('vc-doc-viewer');
  docPane.querySelectorAll('.iostext-layer, .iostext-highlight').forEach((el) => el.remove());
  const wrapper = vcImgEl.parentElement;
  if (wrapper && wrapper.style.position !== 'relative') wrapper.style.position = 'relative';
  const allWords = (vcBboxes.pages ?? []).flatMap((p) => p.words);
  renderSelectableLayer(wrapper, vcImgEl, allWords);
}

async function highlightInImage(value) {
  if (!vcBboxes || !vcImgEl) return false;
  const { findWordsForValue, renderHighlight } = await import('/tesseract-bboxer.js?v=20260428h');
  const allWords = (vcBboxes.pages ?? []).flatMap((p) => p.words);
  const matched = findWordsForValue(allWords, value);
  if (matched.length === 0) return false;
  const wrapper = vcImgEl.parentElement;
  // Clean old highlight
  wrapper.querySelectorAll('.iostext-highlight').forEach((el) => el.remove());
  renderHighlight(wrapper, vcImgEl, matched);
  return true;
}

async function regenerateCitations() {
  if (!vcCurrentMeta) return;
  const btn = document.getElementById('vc-regen-citations');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '↻ läuft…';
  setVcSearchStatus('Citations werden generiert (lazy-OCR wenn nötig)…');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const job = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/jobs`, {
      method: 'POST', headers,
      body: JSON.stringify({ kind: 'citations', inputs: { docUuids: [vcCurrentMeta.uuid] } }),
    }).then((r) => r.json());
    // Poll until done (max 60s)
    let job2 = job;
    for (let i = 0; i < 30 && job2.status !== 'completed' && job2.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      job2 = await fetch(`/api/jobs/${encodeURIComponent(job.jobId)}`, { headers }).then((r) => r.json());
      btn.textContent = `↻ ${job2.status === 'running' ? job2.progress?.current + '/' + job2.progress?.total : job2.status}…`;
    }
    if (job2.status === 'failed') throw new Error(job2.error?.message ?? 'job failed');
    // Reload meta + re-render
    vcCurrentMeta = await api(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(vcCurrentMeta.uuid)}`);
    renderVisualControl(vcCurrentMeta);
    const cov = job2.result?.results?.[0]?.coverage;
    if (cov) setVcSearchStatus(`✓ ${cov.cited}/${cov.total} zitiert (${cov.uncitable} uncitable)`);
    else setVcSearchStatus('✓ Citations aktualisiert');
  } catch (e) {
    setVcSearchStatus(`Fehler: ${e.message ?? String(e)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeVisualControl();
});
document.getElementById('vc-modal')?.addEventListener('click', (ev) => {
  if (ev.target?.id === 'vc-modal') closeVisualControl();
});
document.getElementById('vc-kpi-filter')?.addEventListener('input', (ev) => {
  if (vcCurrentMeta) renderVcKpiList(vcCurrentMeta.classification?.kpis ?? [], ev.target.value);
});
document.getElementById('vc-search')?.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const v = ev.target.value.trim();
  if (v) onVcKpiClick(v);
});

function closeVisualControl() {
  const modal = document.getElementById('vc-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
  vcCurrentMeta = null;
  // Clean iframe to release the file
  const v = document.getElementById('vc-doc-viewer');
  if (v) v.innerHTML = '';
}

// Boot
await loadWorkspaceHeader();
await loadPipeline();
loadCase(); // non-blocking — content cards + case header populate independently
loadJobs(); // non-blocking — jobs panel populates if any exist
