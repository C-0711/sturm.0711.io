/* STURM Document Detail — Phase 3.
 * Doc viewer left, tabbed metadata right.
 * Extract + Approve buttons are placeholders for Phase 4/5.
 */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const wsId = params.get('ws');
const uuid = params.get('uuid');
if (!wsId || !uuid) {
  // Graceful empty-state — kein pageerror in der Console, einfach Hinweis +
  // Link. Caller (document.html) checkt typeof wsId; alle async-init's sind
  // ohnehin nach diesem if-Block.
  document.body.innerHTML = '<p style="padding:40px;font-family:system-ui">?ws=&lt;id&gt;&amp;uuid=&lt;uuid&gt; fehlt. <a href="/workspaces.html">Zurück</a></p>';
  console.info('[document] missing params; showing redirect');
  // Stop further script execution by short-circuiting all DOM bindings below.
  // We use a sentinel that all initializer functions check.
  window.__sturmDocumentNoParams = true;
}
if (!window.__sturmDocumentNoParams) {

const titleEl = $('doc-title');
const classPill = $('doc-class-pill');
const viewer = $('doc-viewer');
const backLink = $('back-link');
backLink.href = `/workspace.html?ws=${encodeURIComponent(wsId)}`;
backLink.title = 'Zurück zum Workspace';
const playgroundLink = $('action-playground');
if (playgroundLink) {
  playgroundLink.href = `/studio-ocr.html?ws=${encodeURIComponent(wsId)}&uuid=${encodeURIComponent(uuid)}`;
}

let meta = null;
let canonicals = null;

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

// ----------------------------------------------------------------------------
// Version pill + structured-change formatting
// ----------------------------------------------------------------------------

function renderVersionPill() {
  const pill = $('doc-version');
  if (!pill) return;
  if (typeof meta?.version !== 'number' || !meta?.sha) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.innerHTML = `<span class="vp-lock" aria-hidden="true">🔒</span>v${meta.version}<span class="vp-sep">·</span><span class="vp-sha">${escapeHtml(meta.sha.slice(0, 6))}…</span>`;
  pill.title =
    `Version ${meta.version} · sha ${meta.sha}\n` +
    `Inhaltsfingerabdruck — bereit zur Verankerung auf Base Mainnet, sobald der GitChain-Container hochgezogen wird.\n` +
    `Klick öffnet Verlauf.`;
  if (!pill.__sturmWired) {
    pill.__sturmWired = true;
    pill.addEventListener('click', () => {
      document.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'verlauf'));
      document.querySelectorAll('.doc-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== 'verlauf'));
    });
  }
}

function formatChangeLine(entry) {
  const c = entry.change;
  if (!c) return '';
  const parts = [];
  if (c.tag) parts.push(`<span class="history-tag-pill">🏷 ${escapeHtml(c.tag)}</span>`);
  if (typeof c.squashedCount === 'number') parts.push(`<em class="muted">${c.squashedCount} Einträge zusammengefasst</em>`);
  if (Array.isArray(c.added) && c.added.length > 0) {
    parts.push(`<span class="hc-add">+ ${escapeHtml(c.added.slice(0, 3).join(', '))}${c.added.length > 3 ? ` +${c.added.length - 3}` : ''}</span>`);
  }
  if (Array.isArray(c.removed) && c.removed.length > 0) {
    parts.push(`<span class="hc-rm">− ${escapeHtml(c.removed.slice(0, 3).join(', '))}</span>`);
  }
  if (Array.isArray(c.kpisAdded) && c.kpisAdded.length > 0) {
    parts.push(`<span class="hc-add">+ ${c.kpisAdded.length} KPIs erkannt</span>`);
  }
  if (typeof c.schemaSize === 'number') {
    parts.push(`<span class="hc-mod">${c.schemaSize} Schema-Felder</span>`);
  }
  if (typeof c.leavesPopulated === 'number') {
    parts.push(`<span class="hc-add">+ ${c.leavesPopulated} Werte extrahiert</span>`);
  }
  if (c.flags && (c.flags.validation > 0 || c.flags.hallucination > 0)) {
    const flags = [];
    if (c.flags.validation > 0) flags.push(`${c.flags.validation} Validierung`);
    if (c.flags.hallucination > 0) flags.push(`${c.flags.hallucination} Halluzinationen`);
    parts.push(`<span class="hc-warn">⚠ ${flags.join(', ')}</span>`);
  }
  if (Array.isArray(c.modified)) {
    for (const m of c.modified.slice(0, 2)) {
      const before = m.before == null ? '∅' : String(m.before).slice(0, 32);
      const after = m.after == null ? '∅' : String(m.after).slice(0, 32);
      parts.push(`<span class="hc-mod">→ ${escapeHtml(m.path)}: <code>${escapeHtml(before)}</code> → <code>${escapeHtml(after)}</code></span>`);
    }
  }
  return parts.length ? `<div class="history-change">${parts.join(' · ')}</div>` : '';
}
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('de-DE'); } catch { return iso; } };

document.querySelectorAll('.doc-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.doc-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab));
  });
});

function renderViewer() {
  const fileUrl = `/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}/file`;
  const isImage = (meta?.mime ?? '').startsWith('image/');
  viewer.innerHTML = isImage
    ? `<img src="${fileUrl}" alt="${escapeHtml(meta.originalFilename)}" />`
    : `<iframe src="${fileUrl}" title="${escapeHtml(meta.originalFilename)}"></iframe>`;
}

// ============================================================================
// INSIGHT — type-aware aggregation over meta.classification.kpis + meta.extraction.annotation
// ============================================================================

const PERSON_A_RE = /(_a$|^person_a$|_person_a$|person\s*a\b)/i;
const PERSON_B_RE = /(_b$|^person_b$|_person_b$|person\s*b\b)/i;
const VAL_PATTERNS = {
  steuer_id: /^\d{11}$/,
  iban: /^[A-Z]{2}\d{2}[A-Z0-9]{12,30}$/,
  ust_id: /^DE\d{9}$/,
  bic: /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
  date_de: /^(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])\.(19|20)\d{2}$/,
  date_iso: /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
  year: /^(19|20)\d{2}$/,
  eur: /^-?[\d.]+,\d{2}\s*(€|EUR)?$/i,
  percent: /^-?\d+([.,]\d+)?\s*%$/,
};
function detectValueType(rawValue) {
  if (rawValue == null) return null;
  const v = String(rawValue).trim();
  if (!v) return null;
  for (const [type, re] of Object.entries(VAL_PATTERNS)) {
    if (re.test(v.replace(/\s/g, ''))) return type;
  }
  return null;
}

// Walk classification.kpis + extraction.annotation into a flat list of {keyPath, key, value, type}.
function flattenAll(meta) {
  const out = [];
  for (const k of meta.classification?.kpis ?? []) {
    out.push({ keyPath: k.key, key: k.key, value: String(k.value ?? ''), type: detectValueType(k.value), source: 'kpi' });
  }
  function walk(node, path) {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    } else {
      const key = path.split('.').pop().replace(/\[\d+\]$/, '') || path;
      out.push({ keyPath: path, key, value: String(node), type: detectValueType(node), source: 'extraction' });
    }
  }
  walk(meta.extraction?.annotation, '');
  return out;
}

// Schema leaf walker — mirror of countLeaves() in src/server/workspaces.ts.
// Tolerates both proper JSON Schema and the playground's informal
// `{Foo: {string: true}}` shape.
function countSchemaLeaves(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
  if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
    let n = 0;
    for (const child of Object.values(node.properties)) n += countSchemaLeaves(child) || 1;
    return n;
  }
  if (node.type === 'array' && node.items) return countSchemaLeaves(node.items) || 1;
  if (node.type === 'string' || node.type === 'number' || node.type === 'integer' || node.type === 'boolean') return 1;

  const informalLeafMarkers = ['string', 'number', 'integer', 'boolean'];
  const keys = Object.keys(node);
  const allLeafMarkers = keys.length > 0 && keys.every((k) => informalLeafMarkers.includes(k) && node[k] === true);
  if (allLeafMarkers) return 1;

  let n = 0;
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') n += countSchemaLeaves(child);
  }
  return n;
}

function isPersonA(p) { return PERSON_A_RE.test(p); }
function isPersonB(p) { return PERSON_B_RE.test(p); }
function personOf(keyPath) {
  if (isPersonA(keyPath)) return 'A';
  if (isPersonB(keyPath)) return 'B';
  return null;
}

function parseEur(v) {
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[\s€]|EUR/gi, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function fmtEur(n) {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function categorizeMoney(key) {
  const k = key.toLowerCase();
  if (/(brutto|gehalt|einkommen|arbeitslohn|kapitalertr|zinsen|miete|lohn|honorar)/.test(k) && !/lohnsteuer/.test(k)) return 'income';
  if (/(steuer|solidarit|kirchensteuer|abzug)/.test(k)) return 'tax';
  if (/(rentenversich|krankenversich|arbeitslosenvers|pflegeversich|versich.*beitrag|sozialvers|av_|kv_|rv_|pv_)/.test(k)) return 'sv';
  return null;
}

// ============================================================================
// WERTE-FLUSS — per-document extraction-completeness diagnostic
// ============================================================================

/** Walk any object/array, collect leaves as {path, value}. */
function flattenLeaves(node, path = '', out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => flattenLeaves(v, `${path}[${i}]`, out));
  } else if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) flattenLeaves(v, path ? `${path}.${k}` : k, out);
  } else {
    if (typeof node === 'string' ? node.trim() !== '' : node != null) {
      out.push({ path: path || '', value: String(node) });
    }
  }
  return out;
}

/** Walk a schema-shaped tree, collect leaves as {path, type, required}.
 *  Tolerates both proper JSON Schema and the playground's informal shape. */
function flattenSchemaLeaves(node, path = '', isRequired = false, out = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
    const required = new Set(node.required ?? []);
    for (const [k, child] of Object.entries(node.properties)) {
      const childPath = path ? `${path}.${k}` : k;
      const r = required.has(k);
      const leaves = flattenSchemaLeaves(child, childPath, r, []);
      if (leaves.length > 0) out.push(...leaves);
      else out.push({ path: childPath, type: child?.type ?? 'unknown', required: r });
    }
    return out;
  }
  if (node.type === 'array' && node.items) {
    return flattenSchemaLeaves(node.items, `${path}[]`, isRequired, out);
  }
  if (['string', 'number', 'integer', 'boolean'].includes(node.type)) {
    out.push({ path, type: node.type, required: isRequired });
    return out;
  }
  // Informal playground leaf marker `{string|number|...: true}`
  const leafMarkers = ['string', 'number', 'integer', 'boolean'];
  const keys = Object.keys(node);
  if (keys.length > 0 && keys.every((k) => leafMarkers.includes(k) && node[k] === true)) {
    out.push({ path, type: keys[0], required: isRequired });
    return out;
  }
  // Bare named-branch (informal)
  for (const [k, child] of Object.entries(node)) {
    const childPath = path ? `${path}.${k}` : k;
    if (child && typeof child === 'object') flattenSchemaLeaves(child, childPath, false, out);
  }
  return out;
}

/** Idempotent normalizer: dates DE↔ISO, EUR formatting, whitespace, case.
 *  Pure formatting — NO domain semantics. */
function normalizeForCompare(v) {
  if (v == null) return '';
  let s = String(v).trim().toLowerCase();
  const de = s.match(/^(\d{2})\.(\d{2})\.((19|20)\d{2})$/);
  if (de) return `${de[3]}-${de[2]}-${de[1]}`;
  if (/(€|eur)/.test(s) || /^[\d.]+,\d{2}$/.test(s)) {
    s = s.replace(/€|eur/g, '').replace(/\s/g, '');
    if (/^-?[\d.]+,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  }
  return s.replace(/\s+/g, '');
}

/** Find a KPI value inside the extraction's flat leaf list. Strict + normalized. */
function matchKpiToExtraction(kpiValue, flatExtraction) {
  if (kpiValue == null) return null;
  const target = normalizeForCompare(kpiValue);
  if (!target) return null;
  // verbatim first
  for (const leaf of flatExtraction) {
    if (String(leaf.value) === String(kpiValue)) return { path: leaf.path, foundValue: leaf.value, matchKind: 'verbatim' };
  }
  // normalized
  for (const leaf of flatExtraction) {
    if (normalizeForCompare(leaf.value) === target) return { path: leaf.path, foundValue: leaf.value, matchKind: 'normalized' };
  }
  return null;
}

/** Tokenize markdown for value-shaped tokens, return ones not in extraction. */
const VF_TOKEN_PATTERNS = [
  /\b\d{2}\.\d{2}\.(19|20)\d{2}\b/g,
  /\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
  /\b[\d.]+,\d{2}\s*(€|EUR)\b/g,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  /\bDE\d{9}\b/g,
  /\b\d{11}\b/g,
  /\b\d+([.,]\d+)?\s*%\b/g,
];

function findUntappedValues(markdown, flatExtraction) {
  if (!markdown) return [];
  const tokens = [];
  for (const re of VF_TOKEN_PATTERNS) {
    const matches = markdown.match(re);
    if (matches) tokens.push(...matches);
  }
  const annotSet = new Set(flatExtraction.map((l) => normalizeForCompare(l.value)));
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const norm = normalizeForCompare(t);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (!annotSet.has(norm)) out.push(t);
  }
  return out;
}

function buildValueFlow(meta) {
  const kpis = meta?.classification?.kpis ?? [];
  const annotation = meta?.extraction?.annotation;
  const markdown = meta?.extraction?.markdown ?? '';
  const flatExtraction = annotation ? flattenLeaves(annotation) : [];
  const schemaLeaves = meta?.template?.schema ? flattenSchemaLeaves(meta.template.schema) : [];

  const kpiMappings = kpis.map((kpi) => ({ kpi, mapping: matchKpiToExtraction(kpi.value, flatExtraction) }));

  const filledPathsByNorm = new Map(flatExtraction.map((l) => [normalizeForCompare(l.value), l.path]));
  void filledPathsByNorm;
  const schemaCoverage = schemaLeaves.map((leaf) => {
    const found = flatExtraction.find((l) => l.path === leaf.path);
    return {
      path: leaf.path,
      type: leaf.type,
      required: leaf.required,
      filled: !!found,
      value: found?.value,
    };
  });

  const untappedTokens = findUntappedValues(markdown, flatExtraction);
  const kpisWithoutHome = kpiMappings.filter((m) => m.mapping == null).map((m) => m.kpi);
  const schemaFieldsEmpty = schemaCoverage.filter((c) => !c.filled);

  return {
    counts: {
      sizeBytes: meta?.size ?? 0,
      pages: meta?.extraction?.pages ?? null,
      kpisDetected: kpis.length,
      schemaFields: schemaLeaves.length,
      filledFields: schemaCoverage.filter((c) => c.filled).length,
      hallucinations: meta?.extraction?.hallucinationCount ?? 0,
      untapped: untappedTokens.length,
      hasExtraction: !!annotation,
      hasMarkdown: !!markdown,
    },
    kpiMappings,
    schemaCoverage,
    untappedSample: untappedTokens.slice(0, 20),
    suggestions: {
      kpisWithoutHome,
      schemaFieldsEmpty,
      hallucinationPaths: meta?.extraction?.hallucinationCount ? ['(siehe Annotation-Tab)'] : [],
    },
  };
}

function renderValueFlow() {
  const root = $('werte-fluss-root');
  if (!root) return;
  if (!meta) { root.innerHTML = '<p class="muted">Lade…</p>'; return; }
  const m = buildValueFlow(meta);
  const c = m.counts;

  const stripHtml = `
    <section class="vf-step-strip">
      <div class="vf-step"><div class="vf-step-icon">📄</div><div class="vf-step-label muted">Datei</div><div class="vf-step-count">${fmtBytes(c.sizeBytes)}</div></div>
      <span class="vf-step-arrow">→</span>
      <div class="vf-step"><div class="vf-step-icon">📋</div><div class="vf-step-label muted">Mistral-Small</div><div class="vf-step-count">${c.kpisDetected} KPIs</div></div>
      <span class="vf-step-arrow">→</span>
      <div class="vf-step"><div class="vf-step-icon">🗂</div><div class="vf-step-label muted">Schema</div><div class="vf-step-count">${c.schemaFields > 0 ? c.schemaFields + ' Felder' : '—'}</div></div>
      <span class="vf-step-arrow">→</span>
      <div class="vf-step"><div class="vf-step-icon">✓</div><div class="vf-step-label muted">Mistral-OCR</div><div class="vf-step-count">${c.hasExtraction ? `${c.filledFields}${c.schemaFields > 0 ? '/' + c.schemaFields : ''} gefüllt${c.pages ? ' · ' + c.pages + ' S.' : ''}` : '—'}</div></div>
      <span class="vf-step-arrow">→</span>
      <div class="vf-step vf-step-leakage">${c.hasMarkdown ? `<div class="vf-leakage-badge ${c.untapped > 0 ? 'is-warn' : ''}">⚠ ${c.untapped}</div><div class="vf-step-label muted">weitere Werte im OCR-Text NICHT im Schema</div>` : `<div class="muted vf-step-label">Werte werden nach Extraktion sichtbar</div>`}</div>
    </section>
  `;

  // KPI mapping table
  let kpiHtml = '';
  if (c.kpisDetected > 0) {
    const rows = m.kpiMappings.map(({ kpi, mapping }) => {
      if (!c.hasExtraction) {
        return `<tr class="vf-mapping-row vf-pending"><td>${escapeHtml(kpi.key)}</td><td class="muted mono">${escapeHtml(kpi.value)}</td><td class="muted">→ keine Extraktion</td></tr>`;
      }
      if (!mapping) {
        return `<tr class="vf-mapping-row vf-no-home"><td>${escapeHtml(kpi.key)}</td><td class="mono">${escapeHtml(kpi.value)}</td><td class="vf-no-home-mark">✗ kein Schema-Feld</td></tr>`;
      }
      const reformatted = mapping.matchKind === 'normalized' ? ' <span class="muted">(umformatiert)</span>' : '';
      const mark = mapping.matchKind === 'normalized' ? '↻' : '✓';
      return `<tr class="vf-mapping-row vf-found"><td>${escapeHtml(kpi.key)}</td><td class="mono">${escapeHtml(kpi.value)}</td><td><span class="vf-found-mark">${mark}</span> <span class="mono muted">${escapeHtml(mapping.path)}</span> ${escapeHtml(mapping.foundValue)}${reformatted}</td></tr>`;
    }).join('');
    kpiHtml = `<section class="vf-section"><h3>KPI-Mapping <span class="muted">(${c.kpisDetected})</span></h3><table class="vf-mapping-table">${rows}</table></section>`;
  }

  // Schema coverage table
  let coverageHtml = '';
  if (c.schemaFields > 0) {
    const rows = m.schemaCoverage.slice(0, 50).map((sc) => {
      const dot = sc.filled ? '●' : '○';
      const cls = sc.filled ? 'vf-coverage-filled' : 'vf-coverage-empty';
      const valDisplay = sc.filled ? `<span class="mono">${escapeHtml(String(sc.value).slice(0, 80))}</span>` : '<span class="muted">— leer</span>';
      const req = sc.required ? '<span class="vf-req-pill" title="required">!</span>' : '';
      return `<tr class="vf-coverage-row ${cls}"><td><span class="vf-cov-dot">${dot}</span> <span class="mono">${escapeHtml(sc.path)}</span> ${req}</td><td>${valDisplay}</td></tr>`;
    }).join('');
    const more = m.schemaCoverage.length > 50 ? `<tr><td colspan="2" class="muted">… ${m.schemaCoverage.length - 50} weitere</td></tr>` : '';
    coverageHtml = `<section class="vf-section"><h3>Schema-Coverage <span class="muted">(${c.filledFields} / ${c.schemaFields})</span></h3><table class="vf-coverage-table">${rows}${more}</table></section>`;
  }

  // Untapped tokens sample
  let untappedHtml = '';
  if (c.untapped > 0) {
    const items = m.untappedSample.map((t) => `<li class="mono">${escapeHtml(t)}</li>`).join('');
    untappedHtml = `<section class="vf-section"><h3>Werte im OCR-Text NICHT im Schema <span class="muted">(${c.untapped})</span></h3><ul class="vf-untapped-list">${items}</ul>${c.untapped > m.untappedSample.length ? `<p class="muted">… ${c.untapped - m.untappedSample.length} weitere</p>` : ''}</section>`;
  }

  // Suggestions
  let suggestionsHtml = '';
  const suggParts = [];
  if (m.suggestions.kpisWithoutHome.length > 0) {
    const list = m.suggestions.kpisWithoutHome.slice(0, 5).map((k) => `<code>${escapeHtml(k.key)}</code>`).join(', ');
    suggParts.push(`<li><strong>${m.suggestions.kpisWithoutHome.length} KPIs ohne Schema-Feld</strong> → Schema erweitern um ${list}${m.suggestions.kpisWithoutHome.length > 5 ? ' …' : ''}</li>`);
  }
  if (c.untapped > 0) {
    suggParts.push(`<li><strong>${c.untapped} Werte im OCR-Text</strong> die das Schema nicht abfragt → reicheres Schema wählen oder generieren</li>`);
  }
  if (m.suggestions.schemaFieldsEmpty.length > 0) {
    suggParts.push(`<li><strong>${m.suggestions.schemaFieldsEmpty.length} Schema-Felder leer</strong> → Schema schmäler machen, oder Annotation-Prompt schärfen</li>`);
  }
  if (c.hallucinations > 0) {
    suggParts.push(`<li><strong>${c.hallucinations} Halluzinations-Flags</strong> → Normalisierungs-Regel prüfen (oft sind das umformatierte Daten/Beträge, false positives)</li>`);
  }
  if (suggParts.length > 0) {
    suggestionsHtml = `<section class="vf-section vf-suggestions"><h3>Vorschläge</h3><ul>${suggParts.join('')}</ul></section>`;
  }

  root.innerHTML = stripHtml + kpiHtml + coverageHtml + untappedHtml + suggestionsHtml;
}

// ============================================================================
// KLASSIFIKATION — raw upload-stage data (everything mistral-small produced)
// ============================================================================

function renderKlassifikation() {
  const root = $('klassifikation-root');
  if (!root) return;
  if (!meta) { root.innerHTML = '<p class="muted">Lade…</p>'; return; }

  const cls = meta.classification;
  if (!cls) {
    root.innerHTML = `
      <section class="vf-section">
        <h3>Stage 1 · Ingest</h3>
        <p class="muted">Noch nicht klassifiziert.</p>
        <dl class="kv">
          <dt>UUID</dt><dd class="mono">${escapeHtml(meta.uuid)}</dd>
          <dt>Originalname</dt><dd>${escapeHtml(meta.originalFilename)}</dd>
          <dt>MIME</dt><dd class="mono">${escapeHtml(meta.mime)}</dd>
          <dt>Größe</dt><dd>${fmtBytes(meta.size)}</dd>
          <dt>Eingegangen</dt><dd>${fmtDate(meta.ingestedAt)}</dd>
        </dl>
      </section>
    `;
    return;
  }

  // Header summary card
  const headerHtml = `
    <section class="vf-section">
      <h3>Stage 1 · Ingest <span class="muted">— mistral-small-latest</span></h3>
      <div class="meta-class" style="margin-bottom:8px">
        <span class="ws-pill">${escapeHtml(cls.label)}</span>
        <span class="muted">${(cls.confidence * 100).toFixed(0)}% conf · ${cls.ms ?? '—'} ms · ${cls.mistralUsage?.total_tokens ?? '?'} tok</span>
      </div>
      <p class="meta-summary">${escapeHtml(cls.summary ?? '')}</p>
    </section>
  `;

  // KPIs (parsed)
  const kpiRows = (cls.kpis ?? []).map((k) => `
    <li><span class="kpi-key">${escapeHtml(k.key)}</span><span class="kpi-val">${escapeHtml(k.value)}</span></li>
  `).join('');
  const kpisHtml = `
    <section class="vf-section">
      <h3>KPIs <span class="muted">(${cls.kpis?.length ?? 0} · valueCount=${cls.valueCount ?? '?'})</span></h3>
      ${kpiRows ? `<ul class="kpi-list">${kpiRows}</ul>` : '<p class="muted">Keine KPIs.</p>'}
    </section>
  `;

  // File metadata
  const fileHtml = `
    <section class="vf-section">
      <h3>Datei + Files-API</h3>
      <dl class="kv">
        <dt>UUID</dt><dd class="mono">${escapeHtml(meta.uuid)}</dd>
        <dt>Originalname</dt><dd>${escapeHtml(meta.originalFilename)}</dd>
        <dt>MIME</dt><dd class="mono">${escapeHtml(meta.mime)}</dd>
        <dt>Größe</dt><dd>${fmtBytes(meta.size)}</dd>
        <dt>Pfad</dt><dd class="mono">${escapeHtml(meta.currentPath)}</dd>
        <dt>Eingegangen</dt><dd>${fmtDate(meta.ingestedAt)}</dd>
        <dt>Klassifiziert</dt><dd>${fmtDate(cls.classifiedAt)}</dd>
        ${meta.fileId ? `<dt>Mistral file_id</dt><dd class="mono">${escapeHtml(meta.fileId)}</dd>` : ''}
      </dl>
    </section>
  `;

  // Raw model exchange
  let rawHtml = '';
  if (cls.raw) {
    const reqJson = JSON.stringify(cls.raw.request, null, 2);
    const respJson = JSON.stringify(cls.raw.response, null, 2);
    rawHtml = `
      <section class="vf-section">
        <h3>Roh-Daten · vollständiger Modell-Austausch</h3>
        <details>
          <summary>Request (mistral-small Chat-Completion)</summary>
          <pre class="json-out">${escapeHtml(reqJson)}</pre>
        </details>
        <details open>
          <summary>Response (Roh-JSON, ${(respJson.length / 1024).toFixed(1)} kB)</summary>
          <pre class="json-out">${escapeHtml(respJson)}</pre>
        </details>
      </section>
    `;
  } else {
    rawHtml = `
      <section class="vf-section">
        <h3>Roh-Daten</h3>
        <p class="muted">Roh-Antwort wurde bei diesem Upload nicht persistiert (Dokument vor Aktivierung dieses Features hochgeladen). Beim nächsten Upload wird sie verfügbar sein.</p>
      </section>
    `;
  }

  root.innerHTML = headerHtml + kpisHtml + fileHtml + rawHtml;
}

function buildInsight(meta) {
  const flat = flattenAll(meta);

  // Hero
  const cls = meta.classification ?? {};
  const peopleSet = new Set();
  for (const r of flat) {
    const p = personOf(r.keyPath);
    if (p) peopleSet.add(p);
  }
  // Year — prefer dedicated year tokens or keys mentioning "jahr/year/steuerjahr".
  // Fall back to the most recent date that isn't a Geburtsdatum.
  let year = null;
  const yearKeyHit = flat.find((r) => /jahr|year|steuerjahr|veranlagung/i.test(r.key) && /(19|20)\d{2}/.test(r.value));
  if (yearKeyHit) {
    year = yearKeyHit.value.match(/(19|20)\d{2}/)[0];
  } else {
    const yearOnly = flat.find((r) => r.type === 'year');
    if (yearOnly) year = yearOnly.value;
  }
  if (!year) {
    const dates = flat
      .filter((r) => (r.type === 'date_de' || r.type === 'date_iso') && !/geburt/i.test(r.key))
      .map((r) => ({ ...r, y: parseInt(String(r.value).match(/(19|20)\d{2}/)?.[0] ?? '0', 10) }))
      .filter((r) => r.y >= 2000)
      .sort((a, b) => b.y - a.y);
    if (dates[0]) year = String(dates[0].y);
  }
  // Last fallback: any key with "Bruttoarbeitslohn 2024" → extract embedded year.
  if (!year) {
    const embedded = flat.find((r) => /(20\d{2})/.test(r.key));
    if (embedded) year = embedded.key.match(/20\d{2}/)[0];
  }
  const hero = {
    label: cls.label ?? null,
    summary: cls.summary ?? null,
    confidence: cls.confidence ?? null,
    personCount: peopleSet.size,
    year,
  };

  // People & parties
  const personMap = new Map(); // 'A'|'B' → {label, values:[{key,value,type}]}
  for (const r of flat) {
    const p = personOf(r.keyPath);
    if (!p) continue;
    if (!personMap.has(p)) personMap.set(p, { id: p, label: `Person ${p}`, values: [] });
    personMap.get(p).values.push({ key: r.key, value: r.value, type: r.type, keyPath: r.keyPath });
  }
  // Orgs (flat — no person split)
  const orgs = [];
  const orgPaths = ['arbeitgeber', 'bankverbindung', 'finanzamt', 'lieferant', 'empfaenger'];
  for (const op of orgPaths) {
    const matches = flat.filter((r) => r.keyPath.toLowerCase().startsWith(op + '.') || r.keyPath.toLowerCase() === op);
    if (matches.length === 0) continue;
    orgs.push({ id: op, label: op.charAt(0).toUpperCase() + op.slice(1), values: matches.map((r) => ({ key: r.key, value: r.value, type: r.type, keyPath: r.keyPath })) });
  }
  const people = [...personMap.values(), ...orgs];

  // Money
  const moneyRows = flat.filter((r) => r.type === 'eur').map((r) => ({
    ...r,
    eur: parseEur(r.value),
    category: categorizeMoney(r.key),
    person: personOf(r.keyPath),
  })).filter((r) => r.eur !== null);
  function moneyForPerson(p) {
    const rows = p ? moneyRows.filter((r) => r.person === p) : moneyRows.filter((r) => !r.person);
    const income = rows.filter((r) => r.category === 'income').reduce((a, r) => a + r.eur, 0);
    const tax = rows.filter((r) => r.category === 'tax').reduce((a, r) => a + r.eur, 0);
    const sv = rows.filter((r) => r.category === 'sv').reduce((a, r) => a + r.eur, 0);
    const items = rows.filter((r) => r.category != null).map((r) => ({ key: r.key, eur: r.eur, category: r.category }));
    const net = income - tax - sv;
    return { income, tax, sv, net, items };
  }
  const money = {
    perPerson: {},
    total: moneyForPerson(null),
  };
  for (const p of peopleSet) money.perPerson[p] = moneyForPerson(p);

  // Identifiers — dedupe by value+type
  const idMap = new Map();
  const idTypes = new Set(['steuer_id', 'iban', 'ust_id', 'bic']);
  for (const r of flat) {
    if (!idTypes.has(r.type)) continue;
    const k = `${r.type}|${r.value}`;
    if (!idMap.has(k)) idMap.set(k, { type: r.type, value: r.value, paths: [] });
    idMap.get(k).paths.push(r.keyPath);
  }
  const identifiers = [...idMap.values()];

  // Dates — collect, derive earliest/latest
  const dateRows = flat.filter((r) => r.type === 'date_de' || r.type === 'date_iso' || r.type === 'year');
  function toIso(s, type) {
    if (type === 'date_iso') return s;
    if (type === 'date_de') {
      const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    }
    if (type === 'year') return `${s}-01-01`;
    return null;
  }
  const datesIso = dateRows.map((r) => ({ ...r, iso: toIso(r.value, r.type) })).filter((r) => r.iso);
  datesIso.sort((a, b) => a.iso.localeCompare(b.iso));
  const dates = {
    earliest: datesIso[0] ?? null,
    latest: datesIso[datesIso.length - 1] ?? null,
    rows: dateRows.map((r) => ({ key: r.key, value: r.value, keyPath: r.keyPath })),
  };

  // Coverage & quality
  const total = countSchemaLeaves(meta.template?.schema);
  const filled = flat.filter((r) => r.source === 'extraction' && r.value && r.value.trim()).length;
  const coverage = {
    total,
    filled: total > 0 ? Math.min(filled, total) : 0,
    validationIssues: meta.extraction?.validationIssueCount ?? 0,
    hallucinations: meta.extraction?.hallucinationCount ?? 0,
    model: meta.extraction?.model ?? null,
    ms: meta.extraction?.ms ?? 0,
    classifyTokens: meta.classification?.mistralUsage?.total_tokens ?? 0,
    pages: meta.extraction?.pages ?? 0,
  };

  // History tail — exclude superseded entries from the Insight preview.
  const history = (meta.history ?? []).filter((h) => !h.superseded).slice(-5);

  return { hero, people, money, identifiers, dates, coverage, history };
}

// ----------------------------------------------------------------------------
// RENDER
// ----------------------------------------------------------------------------

function svgConfidenceRing(pct) {
  // pct 0..1 → SVG ring
  const r = 18, c = 2 * Math.PI * r;
  const off = c * (1 - pct);
  return `
    <svg class="conf-ring" viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="currentColor" stroke-width="3" opacity="0.18"/>
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="currentColor" stroke-width="3"
              stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
              transform="rotate(-90 22 22)" stroke-linecap="round"/>
      <text x="22" y="22" text-anchor="middle" dominant-baseline="central"
            font-size="11" font-weight="500" fill="currentColor">${Math.round(pct * 100)}</text>
    </svg>
  `;
}

function svgCoverageDonut(filled, total) {
  const pct = total > 0 ? filled / total : 0;
  const r = 24, c = 2 * Math.PI * r;
  const off = c * (1 - pct);
  return `
    <svg class="cov-donut" viewBox="0 0 60 60" width="60" height="60" aria-hidden="true">
      <circle cx="30" cy="30" r="${r}" fill="none" stroke="currentColor" stroke-width="6" opacity="0.18"/>
      <circle cx="30" cy="30" r="${r}" fill="none" stroke="currentColor" stroke-width="6"
              stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
              transform="rotate(-90 30 30)" stroke-linecap="round"/>
    </svg>
  `;
}

function moneyBar(pp) {
  if (!pp || pp.income <= 0) return '';
  const taxPct = (pp.tax / pp.income) * 100;
  const svPct = (pp.sv / pp.income) * 100;
  const netPct = Math.max(0, 100 - taxPct - svPct);
  return `
    <div class="money-bar" role="img" aria-label="Brutto ${pp.income} EUR, Steuer ${pp.tax}, SV ${pp.sv}, Netto ${pp.net}">
      <span class="mb-tax" style="width:${taxPct.toFixed(2)}%" title="Steuer ${fmtEur(pp.tax)}"></span>
      <span class="mb-sv" style="width:${svPct.toFixed(2)}%" title="SV ${fmtEur(pp.sv)}"></span>
      <span class="mb-net" style="width:${netPct.toFixed(2)}%" title="Netto ${fmtEur(pp.net)}"></span>
    </div>
  `;
}

const TYPE_LABEL = { steuer_id: 'Steuer-ID', iban: 'IBAN', ust_id: 'USt-IdNr', bic: 'BIC' };

function renderInsight() {
  const root = $('insight-root');
  if (!meta) { root.innerHTML = '<p class="muted">Lade…</p>'; return; }
  const insight = buildInsight(meta);

  // Hero
  const heroParts = [];
  if (insight.hero.label) heroParts.push(`<span class="ws-pill insight-hero-pill">${escapeHtml(insight.hero.label)}</span>`);
  if (insight.hero.year) heroParts.push(`<span class="muted">· ${escapeHtml(insight.hero.year)}</span>`);
  if (insight.hero.personCount > 0) heroParts.push(`<span class="muted">· ${insight.hero.personCount} ${insight.hero.personCount === 1 ? 'Person' : 'Personen'}</span>`);
  if (meta.approvedAt) {
    heroParts.push(`<span class="insight-approved-pill" title="Freigegeben am ${escapeHtml(fmtDate(meta.approvedAt))}">✓ Freigegeben</span>`);
  }
  const heroRing = insight.hero.confidence != null ? svgConfidenceRing(insight.hero.confidence) : '';
  const heroHtml = `
    <section class="insight-hero">
      <div class="insight-hero-head">${heroParts.join(' ')}</div>
      ${insight.hero.summary ? `<p class="insight-hero-summary">${escapeHtml(insight.hero.summary)}</p>` : ''}
      ${heroRing ? `<div class="insight-hero-ring">${heroRing}<span class="muted">conf</span></div>` : ''}
    </section>
  `;

  // People
  let peopleHtml = '';
  if (insight.people.length > 0) {
    const chips = insight.people.map((p) => {
      const rows = p.values.slice(0, 6).map((v) => `
        <div class="ipc-row">
          <span class="ipc-key">${escapeHtml(v.key)}</span>
          <span class="ipc-val ${v.type === 'eur' ? '' : 'mono'}">${escapeHtml(v.value)}</span>
        </div>
      `).join('');
      return `
        <article class="insight-people-chip">
          <header class="ipc-head"><strong>${escapeHtml(p.label)}</strong>
            <span class="muted">${p.values.length} Werte</span>
          </header>
          <div class="ipc-rows">${rows}</div>
        </article>
      `;
    }).join('');
    peopleHtml = `
      <section class="insight-section">
        <h3>Personen &amp; Parteien</h3>
        <div class="insight-people-grid">${chips}</div>
      </section>
    `;
  }

  // Money
  let moneyHtml = '';
  const moneySegments = [];
  for (const [pid, pp] of Object.entries(insight.money.perPerson)) {
    if (pp.income <= 0) continue;
    moneySegments.push({ id: `Person ${pid}`, pp });
  }
  if (moneySegments.length === 0 && insight.money.total.income > 0) {
    moneySegments.push({ id: 'Gesamt', pp: insight.money.total });
  }
  if (moneySegments.length > 0) {
    const blocks = moneySegments.map(({ id, pp }) => `
      <div class="insight-money-block">
        <div class="imb-head">
          <strong>${escapeHtml(id)}</strong>
          <span class="muted">Brutto ${fmtEur(pp.income)}</span>
        </div>
        ${moneyBar(pp)}
        <div class="imb-legend">
          <span><i class="lg-tax"></i> Steuer ${fmtEur(pp.tax)}</span>
          <span><i class="lg-sv"></i> SV ${fmtEur(pp.sv)}</span>
          <span><i class="lg-net"></i> Netto ~${fmtEur(pp.net)}</span>
        </div>
      </div>
    `).join('');
    moneyHtml = `<section class="insight-section"><h3>Geldfluss</h3>${blocks}</section>`;
  }

  // Identifiers
  let idsHtml = '';
  if (insight.identifiers.length > 0) {
    const rows = insight.identifiers.map((i) => `
      <li class="insight-id-row">
        <span class="iid-type ws-pill">${escapeHtml(TYPE_LABEL[i.type] ?? i.type)}</span>
        <span class="iid-value mono">${escapeHtml(i.value)}</span>
        <span class="iid-paths muted">${escapeHtml(i.paths[0])}${i.paths.length > 1 ? ` +${i.paths.length - 1}` : ''}</span>
      </li>
    `).join('');
    idsHtml = `
      <section class="insight-section">
        <h3>Identifikatoren</h3>
        <ul class="insight-id-grid">${rows}</ul>
      </section>
    `;
  }

  // Dates
  let datesHtml = '';
  if (insight.dates.rows.length > 0) {
    const range = (insight.dates.earliest && insight.dates.latest && insight.dates.earliest.iso !== insight.dates.latest.iso)
      ? `${escapeHtml(insight.dates.earliest.value)} → ${escapeHtml(insight.dates.latest.value)}`
      : escapeHtml(insight.dates.earliest?.value ?? '—');
    const list = insight.dates.rows.slice(0, 8).map((d) => `<li><span class="muted">${escapeHtml(d.key)}</span><span class="mono">${escapeHtml(d.value)}</span></li>`).join('');
    datesHtml = `
      <section class="insight-section">
        <h3>Daten</h3>
        <div class="insight-date-range mono">${range}</div>
        <ul class="insight-date-list">${list}</ul>
      </section>
    `;
  }

  // Coverage & quality
  const cov = insight.coverage;
  let qualityHtml = '';
  if (cov.total > 0 || cov.model || cov.classifyTokens > 0) {
    const tokens = cov.classifyTokens;
    const eurCost = (tokens / 1_000_000) * 0.20 + cov.pages * 0.001; // rough mistral-small + ocr-latest mix
    qualityHtml = `
      <section class="insight-section insight-quality">
        <h3>Abdeckung &amp; Qualität</h3>
        <div class="insight-quality-row">
          ${cov.total > 0 ? `
            <div class="insight-quality-donut">
              ${svgCoverageDonut(cov.filled, cov.total)}
              <div class="iqd-text"><strong>${cov.filled}</strong> / ${cov.total}<br><span class="muted">Felder gefüllt</span></div>
            </div>` : ''}
          <ul class="insight-quality-stats">
            ${cov.model ? `<li><span class="muted">Modell</span><span class="mono">${escapeHtml(cov.model)}</span></li>` : ''}
            ${cov.pages > 0 ? `<li><span class="muted">Seiten</span><span>${cov.pages}</span></li>` : ''}
            ${cov.ms > 0 ? `<li><span class="muted">Latenz</span><span>${cov.ms} ms</span></li>` : ''}
            ${cov.validationIssues > 0 ? `<li class="warn"><span>Validierungs-Issues</span><span>${cov.validationIssues}</span></li>` : ''}
            ${cov.hallucinations > 0 ? `<li class="warn"><span>Halluzinations-Flags</span><span>${cov.hallucinations}</span></li>` : ''}
            ${tokens > 0 ? `<li><span class="muted">Klassifikation</span><span>${tokens} tok</span></li>` : ''}
            <li><span class="muted">≈ Kosten</span><span>€${eurCost.toFixed(4)}</span></li>
          </ul>
        </div>
      </section>
    `;
  }

  // History preview
  let histHtml = '';
  if (insight.history.length > 0) {
    const items = insight.history.map((h) => `
      <li class="insight-history-row">
        <span class="ih-time mono muted">${escapeHtml(new Date(h.at).toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }))}</span>
        <span class="ih-kind ws-pill">${h.kind === 'tag' ? '🏷 ' : ''}${escapeHtml(h.kind)}</span>
        <span class="ih-summary">${escapeHtml(h.summary)}</span>
        <span class="ih-source muted">${escapeHtml(h.source)}</span>
        ${formatChangeLine(h)}
      </li>
    `).join('');
    histHtml = `
      <section class="insight-section">
        <h3>Verlauf <a class="muted" data-jump-tab="verlauf" href="#">vollständig →</a></h3>
        <ol class="insight-history">${items}</ol>
      </section>
    `;
  }

  // File details (collapsed)
  const fileHtml = `
    <details class="insight-file">
      <summary>Datei-Details</summary>
      <dl class="kv">
        <dt>UUID</dt><dd class="mono">${escapeHtml(meta.uuid)}</dd>
        <dt>Originalname</dt><dd>${escapeHtml(meta.originalFilename)}</dd>
        <dt>MIME</dt><dd class="mono">${escapeHtml(meta.mime)}</dd>
        <dt>Größe</dt><dd>${fmtBytes(meta.size)}</dd>
        <dt>Pfad</dt><dd class="mono">${escapeHtml(meta.currentPath)}</dd>
        <dt>Eingegangen</dt><dd>${fmtDate(meta.ingestedAt)}</dd>
        ${meta.fileId ? `<dt>Mistral file_id</dt><dd class="mono">${escapeHtml(meta.fileId)}</dd>` : ''}
      </dl>
    </details>
  `;

  root.innerHTML = heroHtml + peopleHtml + moneyHtml + idsHtml + datesHtml + qualityHtml + histHtml + fileHtml;

  // Wire jump-tab links inside the panel.
  root.querySelectorAll('[data-jump-tab]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const target = a.dataset.jumpTab;
      document.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
      document.querySelectorAll('.doc-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== target));
    });
  });

  // Header pill + title (kept from old renderMetadata).
  classPill.textContent = meta.classification?.label ?? 'inbox';
  titleEl.textContent = meta.originalFilename;
  document.title = `STURM · ${meta.originalFilename}`;
}

function renderVerlauf() {
  const list = $('verlauf-list');
  const entries = meta?.history ?? [];
  if (entries.length === 0) {
    list.innerHTML = '<li class="muted">Noch keine Einträge.</li>';
    return;
  }
  const showSuperseded = $('show-superseded')?.checked === true;
  const visible = entries
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => showSuperseded || !h.superseded);
  if (visible.length === 0) {
    list.innerHTML = '<li class="muted">Alle Einträge superseded — Toggle aktivieren um anzuzeigen.</li>';
    return;
  }
  // Newest at top
  list.innerHTML = visible.reverse().map(({ h, idx }) => {
    const supClass = h.superseded ? 'history-superseded' : '';
    const tagPill = h.kind === 'tag' ? '<span class="history-tag-pill">🏷</span>' : '';
    return `
      <li class="insight-history-row history-row-2 ${supClass}" data-idx="${idx}">
        <span class="ih-time mono muted">${escapeHtml(new Date(h.at).toLocaleString('de-DE'))}</span>
        <span class="ih-version mono muted" title="Version nach diesem Eintrag">v${idx + 1}</span>
        <span class="ih-kind ws-pill">${tagPill}${escapeHtml(h.kind)}</span>
        <span class="ih-summary">${escapeHtml(h.summary)}</span>
        <span class="ih-source muted">${escapeHtml(h.source)}</span>
        <label class="ih-pick" title="Markieren für Squash"><input type="checkbox" data-pick-idx="${idx}" ${h.superseded ? 'disabled' : ''}/></label>
        <button class="ih-supersede" type="button" title="Diesen Eintrag als superseded markieren" data-sup-idx="${idx}" ${h.superseded ? 'disabled' : ''}>✂</button>
        ${formatChangeLine(h)}
      </li>
    `;
  }).join('');
  // Wire checkboxes + supersede buttons
  list.querySelectorAll('input[data-pick-idx]').forEach((cb) => {
    cb.addEventListener('change', updateSquashButton);
  });
  list.querySelectorAll('button[data-sup-idx]').forEach((btn) => {
    btn.addEventListener('click', () => supersedeEntry(parseInt(btn.dataset.supIdx, 10)));
  });
  updateSquashButton();
}

function updateSquashButton() {
  const list = $('verlauf-list');
  const picked = list?.querySelectorAll('input[data-pick-idx]:checked');
  const btn = $('action-squash');
  if (!btn) return;
  btn.disabled = !picked || picked.length < 2;
  btn.title = picked && picked.length >= 2 ? `${picked.length} Einträge zusammenfassen` : 'Mindestens 2 Einträge wählen';
}

async function patchHistoryOp(body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = localStorage.getItem('sturm-token');
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ source: 'document-detail', ...body }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  meta = await resp.json();
  renderVersionPill();
  renderVerlauf();
    renderValueFlow();
    renderKlassifikation();
  renderInsight();
  renderMaster();
  renderCaseJson();
}

async function supersedeEntry(idx) {
  try { await patchHistoryOp({ historyOp: 'supersede', target: idx }); }
  catch (e) { alert(`Supersede fehlgeschlagen: ${e.message}`); }
}

async function squashSelected() {
  const list = $('verlauf-list');
  const idxs = [...list.querySelectorAll('input[data-pick-idx]:checked')].map((cb) => parseInt(cb.dataset.pickIdx, 10)).sort((a, b) => a - b);
  if (idxs.length < 2) return;
  const start = idxs[0];
  const end = idxs[idxs.length - 1];
  if (!confirm(`${end - start + 1} Einträge (Index ${start}–${end}) zusammenfassen?`)) return;
  try { await patchHistoryOp({ historyOp: 'squash', range: [start, end] }); }
  catch (e) { alert(`Squash fehlgeschlagen: ${e.message}`); }
}

async function tagCurrent() {
  const name = prompt('Tag-Name (z.B. v1, release-2026-04, golden):', `v${(meta?.history?.length ?? 0) + 1}`);
  if (!name) return;
  try { await patchHistoryOp({ historyOp: 'tag', name }); }
  catch (e) { alert(`Tag fehlgeschlagen: ${e.message}`); }
}

function renderTemplate() {
  const picker = $('template-picker');
  const current = $('template-current');
  if (!canonicals) {
    picker.innerHTML = '<p class="muted">Lade Kanonikalien…</p>';
    return;
  }
  // Sort: hint-matches for this doc's classification first, then alphabetical.
  const docLabel = meta.classification?.label;
  const sorted = [...canonicals].sort((a, b) => {
    const aMatch = docLabel && (a.classificationHints ?? []).includes(docLabel) ? 0 : 1;
    const bMatch = docLabel && (b.classificationHints ?? []).includes(docLabel) ? 0 : 1;
    return aMatch - bMatch || a.id.localeCompare(b.id);
  });
  picker.innerHTML = sorted.map((c) => {
    const matches = docLabel && (c.classificationHints ?? []).includes(docLabel);
    const isActive = meta.template?.id === c.id;
    return `
      <div class="canon-card ${matches ? 'canon-match' : ''} ${isActive ? 'canon-active' : ''}" data-id="${escapeHtml(c.id)}">
        <div class="canon-head">
          <strong>${escapeHtml(c.name)}</strong>
          ${matches ? '<span class="canon-pill">passt</span>' : ''}
          ${isActive ? '<span class="canon-pill canon-pill-active">aktiv</span>' : ''}
        </div>
        <div class="canon-id muted mono">${escapeHtml(c.id)}</div>
        ${c.description ? `<div class="canon-desc">${escapeHtml(c.description)}</div>` : ''}
        <div class="canon-meta muted">${c.propCount ?? '?'} Felder</div>
        <button class="btn-secondary canon-pick" type="button">${isActive ? 'Aktiv' : 'Wählen'}</button>
      </div>
    `;
  }).join('');
  picker.querySelectorAll('.canon-card').forEach((card) => {
    card.querySelector('.canon-pick').addEventListener('click', async () => {
      const id = card.dataset.id;
      try {
        meta = await api(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}/template`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canonicalId: id }),
        });
        renderTemplate();
        renderInsight();
        renderValueFlow();
    renderKlassifikation();
        renderMaster();
        $('action-extract').disabled = false;
      } catch (e) {
        current.innerHTML = `<p class="error-text">Fehler: ${escapeHtml(e.message)}</p>`;
      }
    });
  });

  if (meta.template) {
    current.innerHTML = `
      <div class="template-current-card">
        <div><strong>${escapeHtml(meta.template.name ?? '(unbenannt)')}</strong>
          <span class="muted mono">[${escapeHtml(meta.template.source)}${meta.template.id ? ` · ${escapeHtml(meta.template.id)}` : ''}]</span>
        </div>
        ${meta.template.annotationPrompt ? `<p class="muted">${escapeHtml(meta.template.annotationPrompt)}</p>` : ''}
        <details><summary>JSON Schema</summary><pre class="json-out">${escapeHtml(JSON.stringify(meta.template.schema ?? {}, null, 2))}</pre></details>
      </div>
    `;
    $('action-extract').disabled = false;
    $('action-extract').title = 'Phase 4 (noch nicht implementiert)';
  } else {
    current.innerHTML = '<p class="muted">Keine Vorlage gesetzt.</p>';
  }
}

function renderExtraction() {
  if (meta.extraction) {
    $('extraction-status').textContent = `Extrahiert ${fmtDate(meta.extraction.ranAt)} · ${meta.extraction.ms} ms`;
    $('extraction-out').classList.remove('muted');
    $('extraction-out').textContent = JSON.stringify(meta.extraction.annotation, null, 2);
  } else {
    $('extraction-status').textContent = meta.template
      ? 'Bereit zur Extraktion (Phase 4 noch nicht implementiert).'
      : 'Wähle zuerst eine Vorlage im Template-Tab.';
    $('extraction-out').textContent = '—';
  }
}

async function renderMaster() {
  const out = $('master-preview');
  const wrap = out.parentElement;
  // Inject a status bar above the <pre> on first render.
  let statusBar = document.getElementById('master-status');
  if (!statusBar) {
    statusBar = document.createElement('div');
    statusBar.id = 'master-status';
    statusBar.className = 'master-status';
    wrap.insertBefore(statusBar, out);
  }
  // Inject a download link too.
  let dl = document.getElementById('master-download');
  if (!dl) {
    dl = document.createElement('a');
    dl.id = 'master-download';
    dl.className = 'btn-secondary';
    dl.style.marginLeft = '8px';
    dl.textContent = 'master.json ↓';
    dl.href = `/api/workspaces/${encodeURIComponent(wsId)}/master.json?download=1`;
    statusBar.appendChild(dl);
  }

  out.classList.add('muted');
  out.textContent = 'Lade…';
  try {
    const headers = {};
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/master.json`, { headers });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const master = await resp.json();
    const includes = (master.documents ?? []).some((d) => d.uuid === meta.uuid);
    const status = meta.approvedAt
      ? `<strong>✓ Dieses Dokument ist enthalten.</strong> ${master.approvedCount} von ${master.totalCount} Dokumenten freigegeben.`
      : `<span class="muted"><em>Noch nicht freigegeben.</em></span> ${master.approvedCount} andere Dokumente sind im Master JSON.`;
    const byClass = Object.entries(master.summary?.byClassification ?? {})
      .map(([k, v]) => `<span class="ws-pill" style="margin-right:4px">${escapeHtml(k)} · ${v}</span>`).join('');
    statusBar.innerHTML = `
      <div class="master-status-text">${status}</div>
      ${byClass ? `<div class="master-status-classes">${byClass}</div>` : ''}
    `;
    statusBar.appendChild(dl);
    out.classList.remove('muted');
    out.textContent = JSON.stringify(master, null, 2);
    void includes;
  } catch (e) {
    statusBar.innerHTML = `<span class="error-text">Fehler: ${escapeHtml(e.message)}</span>`;
    statusBar.appendChild(dl);
    out.textContent = '—';
  }
}

// ---------- Fall-JSON: workspace consolidation, no logic ----------
//
// Pulls /api/workspaces/:ws/case.json which is the pure consolidator output:
//   { workspace, documents[], values[] }
// Just renders it. No buckets, no completeness, no income/deduction logic.

let fallJsonView = 'tabelle'; // 'tabelle' | 'json'

async function renderCaseJson() {
  const root = $('fall-json-root');
  if (!root) return;
  root.innerHTML = '<p class="muted">Lade Fall-JSON…</p>';
  try {
    const headers = {};
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/case.json`, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const c = await resp.json();
    root.innerHTML = renderCaseJsonShell(c);
    root.querySelectorAll('.fj-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => { fallJsonView = btn.dataset.view; renderCaseJson(); });
    });
  } catch (e) {
    root.innerHTML = `<p class="error-text">Fehler beim Laden: ${escapeHtml(e.message)}</p>`;
  }
}

function renderCaseJsonShell(c) {
  const header = `
    <section class="vf-section fj-header">
      <h3>Fall-JSON · ${escapeHtml(c.workspace?.name ?? c.workspace?.id ?? '')}</h3>
      <p class="muted">${c.values?.length ?? 0} eindeutige Werte aus ${c.approvedCount} freigegebenen Dokument${c.approvedCount === 1 ? '' : 'en'} (von ${c.totalCount}). Generiert ${fmtDate(c.generatedAt)}.</p>
      <div class="fj-toolbar">
        <div class="fj-view-toggle">
          <button type="button" class="fj-view-btn ${fallJsonView === 'tabelle' ? 'active' : ''}" data-view="tabelle">Tabelle</button>
          <button type="button" class="fj-view-btn ${fallJsonView === 'json' ? 'active' : ''}" data-view="json">JSON</button>
        </div>
        <a class="btn-secondary" href="/api/workspaces/${encodeURIComponent(wsId)}/case.json?download=1">case.json ↓</a>
      </div>
    </section>
  `;
  if (fallJsonView === 'json') {
    return header + `<section class="vf-section"><pre class="json-out">${escapeHtml(JSON.stringify(c, null, 2))}</pre></section>`;
  }
  return header + renderDocumentsCard(c.documents ?? []) + renderValuesTable(c.values ?? []);
}

function renderDocumentsCard(docs) {
  if (!docs || docs.length === 0) {
    return `<section class="vf-section"><h3>Dokumente (0)</h3><p class="muted">Noch keine Dokumente freigegeben.</p></section>`;
  }
  const rows = docs.map((d) => `
    <tr>
      <td><a href="/document.html?ws=${encodeURIComponent(wsId)}&uuid=${encodeURIComponent(d.uuid)}">${escapeHtml(d.dateiname)}</a></td>
      <td>${d.klassifikation ? `<span class="ws-pill">${escapeHtml(d.klassifikation.label ?? '?')}</span>` : '—'}</td>
      <td class="muted">${d.template?.name ?? '—'}</td>
      <td class="fj-num">${d.klassifikation?.kpiCount ?? 0}</td>
      <td class="fj-num">${d.extraktion?.pages ?? '—'}</td>
      <td class="muted mono">${fmtDate(d.approvedAt)}</td>
    </tr>
  `).join('');
  return `
    <section class="vf-section">
      <h3>Dokumente (${docs.length})</h3>
      <table class="fj-table">
        <thead><tr><th>Datei</th><th>Klasse</th><th>Vorlage</th><th>KPIs</th><th>Seiten</th><th>Freigegeben</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderValuesTable(values) {
  if (!values || values.length === 0) {
    return `<section class="vf-section"><h3>Werte (0)</h3><p class="muted">Noch keine extrahierten Werte vorhanden.</p></section>`;
  }
  const rows = values.map((v) => {
    const provBadge = v.herkunft && v.herkunft !== 'mistral'
      ? ` <span class="prov-badge prov-${v.herkunft.includes('claude') ? 'claude' : v.herkunft.includes('manual') ? 'manual' : 'rescue'}">${escapeHtml(v.herkunft)}</span>`
      : '';
    const normBadge = v.wertNormalisiert !== undefined && String(v.wertNormalisiert) !== v.wert
      ? ` <span class="muted mono">→ ${escapeHtml(String(v.wertNormalisiert))}</span>`
      : '';
    const docs = v.belege.map((b) => `<a href="/document.html?ws=${encodeURIComponent(wsId)}&uuid=${encodeURIComponent(b.uuid)}" class="muted" title="${escapeHtml(b.dateiname)}">${escapeHtml(b.dateiname.slice(0, 18))}…</a>`).join(', ');
    return `
      <tr>
        <td class="mono">${escapeHtml(v.pfad)}</td>
        <td>${escapeHtml(v.wert)}${normBadge}</td>
        <td><span class="ws-pill">${escapeHtml(v.quelle)}</span>${provBadge}</td>
        <td>${docs}</td>
      </tr>
    `;
  }).join('');
  return `
    <section class="vf-section">
      <h3>Werte (${values.length})</h3>
      <p class="muted">Alle Werte aus allen freigegebenen Dokumenten, dedupliziert nach (Pfad, normalisiertem Wert).</p>
      <table class="fj-table">
        <thead><tr><th>Pfad</th><th>Wert</th><th>Quelle</th><th>Belege</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

async function loadAll() {
  try {
    meta = await api(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`);
  } catch (e) {
    viewer.innerHTML = `<p class="error-text">${escapeHtml(e.message)}</p>`;
    return;
  }
  renderViewer();
  renderValueFlow();
    renderKlassifikation();
  renderInsight();
  renderVerlauf();
  renderExtraction();
  renderMaster();
  renderCaseJson();

  try {
    canonicals = await api(`/api/workspaces/${encodeURIComponent(wsId)}/canonicals`);
  } catch (e) {
    $('template-picker').innerHTML = `<p class="error-text">${escapeHtml(e.message)}</p>`;
    return;
  }
  renderTemplate();
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

function showExtractionTab() {
  document.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'annotation'));
  document.querySelectorAll('.doc-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== 'annotation'));
}

$('action-extract').addEventListener('click', async () => {
  if (!meta.template?.schema) {
    alert('Bitte zuerst eine Vorlage im Template-Tab wählen.');
    return;
  }
  showExtractionTab();
  const status = $('extraction-status');
  const out = $('extraction-out');
  status.textContent = 'Lade signierte URL & rufe mistral-ocr-latest auf…';
  out.classList.add('muted');
  out.textContent = '—';
  $('action-extract').disabled = true;

  const headers = {};
  const tok = localStorage.getItem('sturm-token');
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  try {
    const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}/extract`, {
      method: 'POST',
      headers,
    });
    if (!resp.ok || !resp.body) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    let lastError = null;
    await consumeSse(resp.body, (event, data) => {
      if (event === 'extract_started') {
        status.textContent = `${data.model} läuft … (Vorlage: ${data.templateName ?? '—'})`;
      } else if (event === 'extract_done') {
        const issues = data.validationIssueCount ? ` · ${data.validationIssueCount} Validierungs-Issues` : '';
        const halls = data.hallucinationCount ? ` · ${data.hallucinationCount} Halluzinationen` : '';
        const deg = data.degradation ? ` · degraded (${data.degradation.reason})` : '';
        status.textContent = `${data.model} · ${data.pages} Seiten · ${data.chars} chars · ${data.ms} ms${issues}${halls}${deg}`;
        out.classList.remove('muted');
        out.textContent = JSON.stringify(data.annotation, null, 2);
      } else if (event === 'done') {
        meta = data.meta;
        renderInsight();
        renderVerlauf();
    renderValueFlow();
    renderKlassifikation();
        renderMaster();
      } else if (event === 'error') {
        lastError = data.message ?? 'unknown';
      }
    });
    if (lastError) throw new Error(lastError);
  } catch (e) {
    status.textContent = `Fehler: ${e.message}`;
    out.textContent = '—';
  } finally {
    $('action-extract').disabled = false;
    $('action-approve').disabled = !(meta?.classification || meta?.extraction);
  }
});

// ============================================================================
// AUDIT — Quality Check dropdown + Audit tab renderer
// ============================================================================

let auditSubTab = 'audit'; // 'audit' | 'haiku' | 'reconcile'

function renderAudit() {
  const root = $('audit-root');
  if (!root) return;
  if (!meta) { root.innerHTML = '<p class="muted">Lade…</p>'; return; }
  const audit = meta.audit;
  const haiku = meta.crossModel?.claudeHaiku;
  const mistralKpis = meta.classification?.kpis ?? [];
  const canReconcile = haiku && mistralKpis.length > 0;
  const haveAny = !!(audit || haiku);
  if (!haveAny) {
    root.innerHTML = `
      <section class="vf-section">
        <h3>Audit</h3>
        <p class="muted">Noch kein Audit ausgeführt. Wähle „Quality Check ▾" in der Aktionsleiste.</p>
      </section>
    `;
    return;
  }
  const subTabsHtml = `
    <nav class="audit-subtabs">
      ${audit ? `<button type="button" class="audit-subtab ${auditSubTab === 'audit' ? 'active' : ''}" data-sub="audit">
        Audit · ${escapeHtml(audit.kind)} <span class="muted">(${audit.totals.total})</span>
      </button>` : ''}
      ${haiku ? `<button type="button" class="audit-subtab ${auditSubTab === 'haiku' ? 'active' : ''}" data-sub="haiku">
        Claude Haiku 4.5 <span class="muted">(${haiku.kpis.length} KPIs)</span>
      </button>` : ''}
      ${canReconcile ? `<button type="button" class="audit-subtab ${auditSubTab === 'reconcile' ? 'active' : ''}" data-sub="reconcile">
        Vergleich Mistral ↔ Claude
      </button>` : ''}
    </nav>
  `;
  let bodyHtml = '';
  if (auditSubTab === 'reconcile' && canReconcile) {
    bodyHtml = renderReconcilePanel(mistralKpis, haiku.kpis);
  } else if (auditSubTab === 'haiku' && haiku) {
    bodyHtml = renderHaikuPanel(haiku);
  } else if (audit) {
    bodyHtml = renderAuditPanel(audit);
  } else if (haiku) {
    bodyHtml = renderHaikuPanel(haiku);
  }
  root.innerHTML = subTabsHtml + bodyHtml;
  root.querySelectorAll('.audit-subtab').forEach((btn) => {
    btn.addEventListener('click', () => { auditSubTab = btn.dataset.sub; renderAudit(); });
  });
}

// ---------- reconcile: Mistral KPIs ↔ Claude Haiku KPIs ----------
//
// Match by VALUE (normalized for date/currency/IBAN whitespace), not key —
// the two models name fields differently in German. Categorize:
//  - bestätigt: same normalized value appears in both extractions (any key)
//  - konflikt:  similar key, different normalized value
//  - nur-mistral / nur-claude: value only in one
//
function normValueForCompare(v) {
  if (v == null) return '';
  let s = String(v).trim().toLowerCase();
  // ISO date → DE date for comparison (canonical: ISO)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const de = s.match(/^(\d{2})\.(\d{2})\.((?:19|20)\d{2})$/);
  if (de) return `${de[3]}-${de[2]}-${de[1]}`;
  // Currency: strip €/EUR + thousand separators
  if (/(€|eur)/.test(s) || /^-?[\d.]+,\d{2}$/.test(s)) {
    s = s.replace(/€|eur/g, '').replace(/\s/g, '');
    if (/^-?[\d.]+,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  }
  // IBAN: strip whitespace
  if (/^[a-z]{2}\d{2}[a-z0-9]{11,30}$/.test(s.replace(/\s/g, ''))) return s.replace(/\s/g, '');
  // Numeric canonicalization: any value that parses as a finite number is
  // canonicalized to its parsed form so "0" === "0,00" === "0.00" === "0 €"
  const n = parseFloat(s.replace(/€|eur|\s/gi, '').replace(/\./g, '').replace(',', '.'));
  if (Number.isFinite(n) && /^-?[\d.,]+\s?(€|eur)?$/i.test(String(v).trim())) {
    return String(n);
  }
  return s.replace(/\s+/g, '');
}
function normKeyForCompare(k) {
  return String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function reconcile(mistralKpis, claudeKpis) {
  const mByVal = new Map(); // normValue → [{key,value}]
  const cByVal = new Map();
  for (const k of mistralKpis) {
    const nv = normValueForCompare(k.value);
    if (!nv) continue;
    if (!mByVal.has(nv)) mByVal.set(nv, []);
    mByVal.get(nv).push(k);
  }
  for (const k of claudeKpis) {
    const nv = normValueForCompare(k.value);
    if (!nv) continue;
    if (!cByVal.has(nv)) cByVal.set(nv, []);
    cByVal.get(nv).push(k);
  }

  const confirmed = []; // value present in both extractions (any key)
  const onlyMistral = [];
  const onlyClaude = [];

  const claimedClaudeValues = new Set();
  for (const [nv, mEntries] of mByVal) {
    if (cByVal.has(nv)) {
      const cEntries = cByVal.get(nv);
      claimedClaudeValues.add(nv);
      for (const m of mEntries) {
        confirmed.push({ value: m.value, mistralKey: m.key, claudeKey: cEntries[0].key });
      }
    } else {
      for (const m of mEntries) onlyMistral.push(m);
    }
  }
  for (const [nv, cEntries] of cByVal) {
    if (!claimedClaudeValues.has(nv)) {
      for (const c of cEntries) onlyClaude.push(c);
    }
  }

  // Conflict detection: keys that look similar (same normalized prefix) but
  // different values. Walk Mistral keys, find Claude key with similar
  // normalized form. If both extracted SOMETHING but the values differ,
  // that's a conflict — this is the highest-signal bucket.
  const conflicts = [];
  const cByKey = new Map();
  for (const c of claudeKpis) {
    const nk = normKeyForCompare(c.key);
    if (!cByKey.has(nk)) cByKey.set(nk, c);
  }
  for (const m of mistralKpis) {
    const nkm = normKeyForCompare(m.key);
    // Find any Claude key that contains or is contained in the Mistral key (≥6 chars overlap)
    let matchedClaude = cByKey.get(nkm);
    if (!matchedClaude) {
      for (const [nk, c] of cByKey) {
        if (nk.length < 6 || nkm.length < 6) continue;
        if (nk.includes(nkm) || nkm.includes(nk)) { matchedClaude = c; break; }
      }
    }
    if (matchedClaude && normValueForCompare(matchedClaude.value) !== normValueForCompare(m.value)) {
      conflicts.push({ key: m.key, mistralValue: m.value, claudeKey: matchedClaude.key, claudeValue: matchedClaude.value });
    }
  }
  return { confirmed, conflicts, onlyMistral, onlyClaude };
}

let reconcileView = 'side-by-side'; // 'side-by-side' | 'buckets'

async function mergeActions(actions) {
  if (!actions || actions.length === 0) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}/merge`, {
      method: 'POST', headers, body: JSON.stringify({ actions }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    meta = await api(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`);
    renderAudit();
    renderVerlauf();
    renderInsight();
    renderValueFlow();
    renderMaster();
  } catch (e) {
    alert(`Merge fehlgeschlagen: ${e.message}`);
  }
}

function pairForSideBySide(mistralKpis, claudeKpis) {
  // Build value→entries maps
  const mByVal = new Map(); // normValue → [{key,value,used:false}]
  const cByVal = new Map();
  const mEntries = mistralKpis.map((k) => ({ ...k, _used: false, _norm: normValueForCompare(k.value) }));
  const cEntries = claudeKpis.map((k) => ({ ...k, _used: false, _norm: normValueForCompare(k.value) }));
  for (const e of mEntries) { if (!e._norm) continue; if (!mByVal.has(e._norm)) mByVal.set(e._norm, []); mByVal.get(e._norm).push(e); }
  for (const e of cEntries) { if (!e._norm) continue; if (!cByVal.has(e._norm)) cByVal.set(e._norm, []); cByVal.get(e._norm).push(e); }

  // Index Claude by normalized key for conflict pairing (same key, diff value)
  const cByKey = new Map();
  for (const c of cEntries) { const nk = normKeyForCompare(c.key); if (nk) cByKey.set(nk, c); }

  const rows = []; // {status, mistral, claude}

  // 1. Value-matches (paired across)
  for (const [nv, mList] of mByVal) {
    if (cByVal.has(nv)) {
      const cList = cByVal.get(nv);
      const n = Math.max(mList.length, cList.length);
      for (let i = 0; i < n; i++) {
        const m = mList[i] ?? null;
        const c = cList[i] ?? null;
        if (m) m._used = true;
        if (c) c._used = true;
        rows.push({ status: 'match', mistral: m, claude: c });
      }
    }
  }

  // 2. Conflicts: same/similar key, different value (consume an unused mistral + claude pair)
  for (const m of mEntries) {
    if (m._used) continue;
    const nkm = normKeyForCompare(m.key);
    let matched = cByKey.get(nkm);
    if (!matched || matched._used) {
      for (const [nk, c] of cByKey) {
        if (c._used) continue;
        if (nk.length < 6 || nkm.length < 6) continue;
        if (nk.includes(nkm) || nkm.includes(nk)) { matched = c; break; }
      }
    }
    if (matched && !matched._used && matched._norm !== m._norm) {
      m._used = true;
      matched._used = true;
      rows.push({ status: 'conflict', mistral: m, claude: matched });
    }
  }

  // 3. Only-Mistral (unused mistral entries)
  for (const m of mEntries) {
    if (!m._used) rows.push({ status: 'only-mistral', mistral: m, claude: null });
  }
  // 4. Only-Claude (unused claude entries)
  for (const c of cEntries) {
    if (!c._used) rows.push({ status: 'only-claude', mistral: null, claude: c });
  }

  // Sort by VALUE so similar amounts/dates/strings cluster — easier to scan
  // the document's actual content top-to-bottom. Within rows that share a
  // canonical value (e.g. paired matches/conflicts), keep deterministic order.
  const sortKey = (r) => {
    const v = (r.mistral?.value ?? r.claude?.value ?? '').toString();
    // Numbers first (sorted numerically), then strings (sorted lexically)
    const num = parseFloat(v.replace(/€|EUR|\s/gi, '').replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(num) && /\d/.test(v)) return [0, num, v.toLowerCase()];
    return [1, 0, v.toLowerCase()];
  };
  rows.sort((a, b) => {
    const [ka, na, sa] = sortKey(a);
    const [kb, nb, sb] = sortKey(b);
    if (ka !== kb) return ka - kb;
    if (na !== nb) return na - nb;
    return sa.localeCompare(sb);
  });
  return rows;
}

function renderReconcilePanel(mistralKpis, claudeKpis) {
  const r = reconcile(mistralKpis, claudeKpis);
  const total = mistralKpis.length + claudeKpis.length;
  const agreementRate = mistralKpis.length > 0 ? Math.round(100 * r.confirmed.length / mistralKpis.length) : 0;

  const confirmedRows = r.confirmed.slice(0, 200).map((row) => `
    <li class="audit-finding audit-info">
      <div class="af-head">
        <span class="af-mark">✓</span>
        <span class="af-field mono">${escapeHtml(row.mistralKey)}</span>
        <span class="af-value">${escapeHtml(row.value)}</span>
      </div>
      <div class="af-msg muted">Claude: <span class="mono">${escapeHtml(row.claudeKey)}</span></div>
    </li>
  `).join('');

  const conflictRows = r.conflicts.map((c) => `
    <li class="audit-finding audit-error">
      <div class="af-head">
        <span class="af-mark">✗</span>
        <span class="af-field mono">${escapeHtml(c.key)}</span>
        <span class="af-value">Mistral: <strong>${escapeHtml(c.mistralValue)}</strong></span>
      </div>
      <div class="af-msg">
        Claude (<span class="mono">${escapeHtml(c.claudeKey)}</span>): <strong>${escapeHtml(c.claudeValue)}</strong>
      </div>
      <div class="af-evidence muted">Beide Modelle haben extrahiert, sind sich aber uneinig — eines von beiden liest falsch.</div>
    </li>
  `).join('');

  const onlyMistralRows = r.onlyMistral.slice(0, 100).map((m) => `
    <li class="audit-finding audit-warn">
      <div class="af-head">
        <span class="af-mark">↰</span>
        <span class="af-field mono">${escapeHtml(m.key)}</span>
        <span class="af-value">${escapeHtml(m.value)}</span>
      </div>
      <div class="af-msg muted">Nur Mistral hat diesen Wert extrahiert. Entweder Mistral hat halluziniert ODER Claude hat ihn übersehen.</div>
    </li>
  `).join('');

  const onlyClaudeRows = r.onlyClaude.slice(0, 100).map((c) => `
    <li class="audit-finding audit-warn">
      <div class="af-head">
        <span class="af-mark">↱</span>
        <span class="af-field mono">${escapeHtml(c.key)}</span>
        <span class="af-value">${escapeHtml(c.value)}</span>
      </div>
      <div class="af-msg muted">Nur Claude hat diesen Wert extrahiert. Möglicherweise Lücke in Mistral-Klassifikation — falls Wert real, Re-Klassifikation oder Schema-Erweiterung nötig.</div>
    </li>
  `).join('');

  const headerHtml = `
    <section class="vf-section">
      <h3>Vergleich · Mistral Small ↔ Claude Haiku 4.5</h3>
      <p class="muted">Pro Wert geprüft, ob beide Modelle dasselbe extrahiert haben (Match nach Wert, nicht nach Beschriftung — die Modelle benennen Felder unterschiedlich).</p>
      <div class="audit-totals">
        <span class="audit-pill audit-pill-ok">✓ ${r.confirmed.length} bestätigt</span>
        <span class="audit-pill audit-pill-error">✗ ${r.conflicts.length} Konflikt</span>
        <span class="audit-pill audit-pill-warn">↰ ${r.onlyMistral.length} nur Mistral</span>
        <span class="audit-pill audit-pill-warn">↱ ${r.onlyClaude.length} nur Claude</span>
        <span class="muted">Übereinstimmung: ${agreementRate}%</span>
      </div>
      <div class="reconcile-view-toggle">
        <button type="button" class="rv-btn ${reconcileView === 'side-by-side' ? 'active' : ''}" data-view="side-by-side">Tabelle nebeneinander</button>
        <button type="button" class="rv-btn ${reconcileView === 'buckets' ? 'active' : ''}" data-view="buckets">Gruppiert</button>
      </div>
    </section>
  `;

  let bodyHtml = '';
  if (reconcileView === 'side-by-side') {
    const rows = pairForSideBySide(mistralKpis, claudeKpis);
    const tableRows = rows.map((row, i) => {
      const sCls = `sxs-${row.status}`;
      // Provenance badge for Mistral side (kpi may have .from set)
      const fromBadge = (k) => {
        const f = k?.from ?? 'mistral';
        if (f === 'mistral') return '';
        if (f === 'claude-haiku-merge') return ' <span class="prov-badge prov-claude">claude</span>';
        if (f === 'manual') return ' <span class="prov-badge prov-manual">manuell</span>';
        if (f === 'structural-rescue') return ' <span class="prov-badge prov-rescue">rescue</span>';
        return '';
      };
      const mCell = row.mistral
        ? `<td class="sxs-val">${escapeHtml(row.mistral.value)}</td>
           <td class="sxs-key mono muted">${escapeHtml(row.mistral.key)}${fromBadge(row.mistral)}</td>`
        : `<td class="sxs-val sxs-empty">&nbsp;</td><td class="sxs-key sxs-empty muted">—</td>`;
      const cCell = row.claude
        ? `<td class="sxs-val">${escapeHtml(row.claude.value)}</td>
           <td class="sxs-key mono muted">${escapeHtml(row.claude.key)}</td>`
        : `<td class="sxs-val sxs-empty">&nbsp;</td><td class="sxs-key sxs-empty muted">—</td>`;
      const mark = row.status === 'match' ? '✓' : row.status === 'conflict' ? '✗' : row.status === 'only-mistral' ? '↰' : '↱';

      // Action buttons per row status. Encode the action data on the button.
      let actionsHtml = '';
      if (row.status === 'only-claude' && row.claude) {
        const payload = JSON.stringify({ type: 'add', key: row.claude.key, value: row.claude.value, from: 'claude-haiku-merge' });
        actionsHtml = `<button type="button" class="sxs-action sxs-act-add" data-action='${escapeHtml(payload)}' title="Wert in Mistral-KPIs übernehmen">+ übernehmen</button>`;
      } else if (row.status === 'only-mistral' && row.mistral) {
        const payload = JSON.stringify({ type: 'remove', key: row.mistral.key });
        actionsHtml = `<button type="button" class="sxs-action sxs-act-remove" data-action='${escapeHtml(payload)}' title="Halluzination — Mistral-KPI entfernen">✗ verwerfen</button>`;
      } else if (row.status === 'conflict' && row.mistral && row.claude) {
        const keepM = JSON.stringify({ noop: true });
        const takeC = JSON.stringify({ type: 'replace', key: row.mistral.key, newValue: row.claude.value, from: 'claude-haiku-merge' });
        actionsHtml = `
          <button type="button" class="sxs-action sxs-act-keep" data-action='${escapeHtml(keepM)}' title="Mistral-Wert behalten">← M</button>
          <button type="button" class="sxs-action sxs-act-replace" data-action='${escapeHtml(takeC)}' title="Mistral-Wert durch Claude-Wert ersetzen">→ C</button>
        `;
      }

      return `<tr class="${sCls}"><td class="sxs-mark">${mark}</td>${mCell}${cCell}<td class="sxs-actions">${actionsHtml}</td></tr>`;
    }).join('');
    const onlyClaudeCount = rows.filter((r) => r.status === 'only-claude').length;
    bodyHtml = `
      <section class="vf-section">
        <div class="sxs-toolbar">
          ${onlyClaudeCount > 0 ? `<button type="button" class="btn-secondary" id="sxs-bulk-merge">→ Auto-Merge: alle ${onlyClaudeCount} „nur Claude" übernehmen</button>` : ''}
          <span class="muted">Aktionen schreiben sofort in <code>meta.classification.kpis</code> + Verlauf.</span>
        </div>
        <table class="sxs-table">
          <thead>
            <tr>
              <th></th>
              <th colspan="2" class="sxs-col-mistral">Mistral Small <span class="muted">(${mistralKpis.length})</span></th>
              <th colspan="2" class="sxs-col-claude">Claude Haiku 4.5 <span class="muted">(${claudeKpis.length})</span></th>
              <th>Aktion</th>
            </tr>
            <tr class="sxs-subhead">
              <th></th>
              <th>Wert</th><th>Feld</th>
              <th>Wert</th><th>Feld</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </section>
    `;
    // Defer wiring (table is in bodyHtml that goes through innerHTML)
    setTimeout(() => {
      document.querySelectorAll('.sxs-action').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const payload = JSON.parse(btn.dataset.action);
          if (payload.noop) { btn.closest('tr').classList.add('sxs-decided'); btn.disabled = true; return; }
          await mergeActions([payload]);
        });
      });
      const bulk = document.getElementById('sxs-bulk-merge');
      if (bulk) bulk.addEventListener('click', async () => {
        const actions = rows
          .filter((r) => r.status === 'only-claude' && r.claude)
          .map((r) => ({ type: 'add', key: r.claude.key, value: r.claude.value, from: 'claude-haiku-merge' }));
        if (actions.length) await mergeActions(actions);
      });
    }, 0);
  } else {
    bodyHtml = `
      ${r.conflicts.length > 0 ? `
        <section class="vf-section">
          <h3>Konflikte (${r.conflicts.length}) — höchstes Fehler-Signal</h3>
          <ul class="audit-list">${conflictRows}</ul>
        </section>
      ` : ''}
      ${r.onlyMistral.length > 0 ? `
        <section class="vf-section">
          <h3>Nur Mistral (${r.onlyMistral.length})</h3>
          <ul class="audit-list">${onlyMistralRows}${r.onlyMistral.length > 100 ? '<li class="muted">…weitere ausgeblendet</li>' : ''}</ul>
        </section>
      ` : ''}
      ${r.onlyClaude.length > 0 ? `
        <section class="vf-section">
          <h3>Nur Claude (${r.onlyClaude.length})</h3>
          <ul class="audit-list">${onlyClaudeRows}${r.onlyClaude.length > 100 ? '<li class="muted">…weitere ausgeblendet</li>' : ''}</ul>
        </section>
      ` : ''}
      <section class="vf-section">
        <h3>Bestätigt (${r.confirmed.length})</h3>
        <ul class="audit-list">${confirmedRows}${r.confirmed.length > 200 ? '<li class="muted">…weitere ausgeblendet</li>' : ''}</ul>
      </section>
    `;
  }
  // Defer toggle wiring to renderAudit's afterRender (we re-bind after innerHTML)
  setTimeout(() => {
    document.querySelectorAll('.rv-btn').forEach((btn) => {
      btn.addEventListener('click', () => { reconcileView = btn.dataset.view; renderAudit(); });
    });
  }, 0);
  return headerHtml + bodyHtml;
}

function renderAuditPanel(audit) {
  const t = audit.totals;
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...audit.findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const rows = sorted.map((f) => `
    <li class="audit-finding audit-${escapeHtml(f.severity)}">
      <div class="af-head">
        <span class="af-mark">${f.status === 'ok' ? '✓' : f.status === 'invented' || f.status === 'mismatch' ? '✗' : f.status === 'wrong_context' ? '↺' : f.status === 'missing' ? '?' : f.status === 'invalid' ? '!' : '◐'}</span>
        <span class="af-field mono">${escapeHtml(f.field)}</span>
        <span class="af-value">${escapeHtml(f.value)}</span>
        <span class="af-source muted">${escapeHtml(f.source)}/${escapeHtml(f.kind)}</span>
      </div>
      <div class="af-msg">${escapeHtml(f.message)}</div>
      ${f.evidence ? `<div class="af-evidence muted mono">▸ ${escapeHtml(f.evidence)}</div>` : ''}
    </li>
  `).join('');
  return `
    <section class="vf-section">
      <h3>Letztes Audit · ${escapeHtml(audit.kind)} · ${fmtDate(audit.ranAt)}</h3>
      <div class="audit-totals">
        <span class="audit-pill audit-pill-ok">✓ ${t.ok} ok</span>
        <span class="audit-pill audit-pill-warn">⚠ ${t.warn} warn</span>
        <span class="audit-pill audit-pill-error">✗ ${t.error} error</span>
        <span class="muted">aus ${t.total} Findings · ${audit.ms} ms</span>
      </div>
    </section>
    <section class="vf-section">
      <h3>Findings</h3>
      <ul class="audit-list">${rows || '<li class="muted">Keine Findings.</li>'}</ul>
    </section>
  `;
}

function renderHaikuPanel(h) {
  const usage = h.usage ?? {};
  const kpiRows = h.kpis.map((k) => `
    <li class="audit-finding audit-info">
      <div class="af-head">
        <span class="af-mark">·</span>
        <span class="af-field mono">${escapeHtml(k.key)}</span>
        <span class="af-value">${escapeHtml(k.value)}</span>
      </div>
    </li>
  `).join('');
  return `
    <section class="vf-section">
      <h3>Claude Haiku 4.5 · zweite Meinung · ${fmtDate(h.ranAt)}</h3>
      <p class="muted">Unabhängige Klassifikation desselben Dokuments durch ein anderes Modell. Kein Diff — die Werte stehen pur, damit du selbst vergleichen kannst.</p>
      <dl class="haiku-meta">
        <dt>Label</dt><dd class="mono">${escapeHtml(h.label)}</dd>
        <dt>Confidence</dt><dd>${(h.confidence * 100).toFixed(0)}%</dd>
        <dt>Summary</dt><dd>${escapeHtml(h.summary)}</dd>
        <dt>KPIs extrahiert</dt><dd>${h.kpis.length} <span class="muted">(value_count Schätzung: ${h.valueCount})</span></dd>
        <dt>Tokens</dt><dd class="muted">${usage.input_tokens ?? '?'} in · ${usage.output_tokens ?? '?'} out · ${h.ms} ms</dd>
      </dl>
    </section>
    <section class="vf-section">
      <h3>KPIs (Claude Haiku)</h3>
      <ul class="audit-list">${kpiRows || '<li class="muted">Keine KPIs.</li>'}</ul>
    </section>
  `;
}

const qualityBtn = $('action-quality');
const qualityMenu = $('quality-menu');
function closeQualityMenu() {
  qualityMenu?.classList.add('hidden');
  qualityBtn?.setAttribute('aria-expanded', 'false');
}
qualityBtn?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (qualityBtn.disabled) return;
  const isOpen = !qualityMenu.classList.contains('hidden');
  if (isOpen) closeQualityMenu();
  else { qualityMenu.classList.remove('hidden'); qualityBtn.setAttribute('aria-expanded', 'true'); }
});
document.addEventListener('click', (ev) => {
  if (!qualityMenu?.contains(ev.target) && ev.target !== qualityBtn) closeQualityMenu();
});
qualityMenu?.querySelectorAll('button[data-kind]').forEach((mi) => {
  mi.addEventListener('click', async () => {
    const kind = mi.dataset.kind;
    closeQualityMenu();
    await runQualityCheck(kind);
  });
});

async function runQualityCheck(kind) {
  if (!meta) return;
  document.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'audit'));
  document.querySelectorAll('.doc-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== 'audit'));
  const root = $('audit-root');
  root.innerHTML = `<section class="vf-section"><h3>Audit läuft…</h3><p class="muted">${escapeHtml(kind)} · bitte warten</p></section>`;
  qualityBtn.disabled = true;
  const originalText = qualityBtn.textContent;
  qualityBtn.textContent = 'Audit läuft…';
  try {
    const headers = { 'Content-Type': 'application/json' };
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}/audit`, {
      method: 'POST', headers, body: JSON.stringify({ kind }),
    });
    if (!resp.ok || !resp.body) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    let lastError = null;
    let report = null;
    let crossModelResult = null;
    await consumeSse(resp.body, (event, data) => {
      if (event === 'audit_done') report = data.report;
      else if (event === 'cross_model_done') crossModelResult = data.result;
      else if (event === 'error') lastError = data.message;
    });
    if (lastError) throw new Error(lastError);
    if (!report && !crossModelResult) throw new Error('Kein Ergebnis empfangen');
    meta = await api(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`);
    // If a cross-model run finished, jump straight to the Haiku sub-tab
    if (crossModelResult) auditSubTab = 'haiku';
    else auditSubTab = 'audit';
    renderAudit();
    renderVerlauf();
    renderInsight();
    renderValueFlow();
    renderMaster();
  } catch (e) {
    root.innerHTML = `<section class="vf-section"><h3>Audit fehlgeschlagen</h3><p class="error-text">${escapeHtml(e.message)}</p></section>`;
  } finally {
    qualityBtn.disabled = false;
    qualityBtn.textContent = originalText;
  }
}

$('action-approve').addEventListener('click', async () => {
  const isApproved = !!meta?.approvedAt;
  const btn = $('action-approve');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = isApproved ? 'Widerrufen…' : 'Freigeben…';
  try {
    const headers = { 'Content-Type': 'application/json' };
    const tok = localStorage.getItem('sturm-token');
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const body = isApproved
      ? { approvedAt: null, source: 'document-detail', summary: 'approval revoked' }
      : { approvedAt: new Date().toISOString(), source: 'document-detail', summary: 'approved' };
    const resp = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    meta = await resp.json();
    renderInsight();
    renderVerlauf();
    renderValueFlow();
    renderKlassifikation();
    renderMaster();
    btn.textContent = meta.approvedAt ? 'Widerrufen' : 'Freigeben';
    btn.title = meta.approvedAt ? `Freigegeben am ${fmtDate(meta.approvedAt)}` : 'Dokument für master.json freigeben';
  } catch (e) {
    btn.textContent = original;
    alert(`Fehler: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

loadAll().then(() => {
  const btn = $('action-approve');
  // Enable Freigeben as soon as we have *something* worth approving — either a
  // classification or an extraction. Freigeben commits the doc to master.json.
  if (meta?.classification || meta?.extraction) btn.disabled = false;
  if (meta?.approvedAt) btn.textContent = 'Widerrufen';
  // Quality Check enables when classification OR extraction exists.
  const qBtn = $('action-quality');
  if (qBtn) qBtn.disabled = !(meta?.classification || meta?.extraction);
  renderAudit();
  btn.title = meta?.approvedAt
    ? `Freigegeben am ${fmtDate(meta.approvedAt)}`
    : 'Dokument für master.json freigeben';
  renderVersionPill();
  // Cleanup-action wiring (only after meta loaded so we know context)
  $('action-tag')?.addEventListener('click', tagCurrent);
  $('action-squash')?.addEventListener('click', squashSelected);
  $('show-superseded')?.addEventListener('change', renderVerlauf);
  // ?tab= deep-link from the workspace pipeline matrix
  const initialTab = params.get('tab');
  if (initialTab && document.querySelector(`.doc-tab[data-tab="${initialTab}"]`)) {
    document.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === initialTab));
    document.querySelectorAll('.doc-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== initialTab));
  }
});
} // end if (!window.__sturmDocumentNoParams)
