/**
 * Shared sidebar for STURM HTML-Seiten (Landing, Anwendungen, Steuerfall).
 *
 * Render-Modell: zwei Bereiche in einer Sidebar
 *   1. Primary Nav — 5 Top-Level-Einträge (Workflows, Anwendungen, Pipeline,
 *      Designer, OCR Studio). Identisch auf jeder Seite. Aktiv basierend auf
 *      location.pathname.
 *   2. Context Section — pro Seite anders gefüllt:
 *        Landing:     Workflow-Kategorien
 *        Anwendungen: registrierte Apps mit Case-Counts
 *        Steuerfall:  Fall-Kontext + Back-Link
 *
 * Eine Seite ruft `renderSturmNav({ activeNav, contextRenderer })` einmal beim
 * DOMContentLoaded auf. Die Funktion ersetzt das `<aside id="sturm-nav-host">`-
 * Element mit dem fertigen Markup.
 */

// ─── ?token=… aus URL übernehmen und in localStorage persistieren ───────
// Wird einmal beim Import des Moduls ausgeführt (vor renderSturmNav). Lässt
// User token-eingebettete Bookmarks teilen ohne den Token in jeder URL zu
// behalten. Wird von authHeaders() in den HTML-Seiten konsumiert.
(function captureUrlToken() {
  try {
    const params = new URLSearchParams(location.search);
    const tok = params.get('token');
    if (tok && tok.length > 0) {
      localStorage.setItem('sturm-token', tok);
      params.delete('token');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    }
  } catch { /* localStorage / URL APIs unavailable */ }
})();

const PRIMARY_NAV = [
  { id: 'workflows',  label: 'Workflows',       href: '/',                 icon: 'layout-grid' },
  { id: 'anwendungen', label: 'Anwendungen',     href: '/anwendungen.html', icon: 'boxes' },
  { id: 'pipeline',    label: 'Pipeline-Runner', href: '/pipeline.html',    icon: 'play' },
  { id: 'designer',    label: 'Designer',        href: '/designer.html',    icon: 'pen-tool' },
  { id: 'studio-ocr',  label: 'OCR Studio',      href: '/studio-ocr.html',  icon: 'sliders-horizontal' },
];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/**
 * @param {Object} opts
 * @param {string} opts.activeNav — id aus PRIMARY_NAV (workflows|anwendungen|pipeline|designer|studio-ocr)
 * @param {(host: HTMLElement) => Promise<void>|void} [opts.contextRenderer] — füllt #sturm-nav-context
 * @param {string} [opts.contextHeading] — Heading über der Context-Section
 * @param {string} [opts.hostId='sturm-nav-host'] — Element-ID, in das die Sidebar gerendert wird
 */
export async function renderSturmNav(opts = {}) {
  const hostId = opts.hostId || 'sturm-nav-host';
  const host = document.getElementById(hostId);
  if (!host) {
    console.warn(`[nav] host #${hostId} not found`);
    return;
  }
  const activeNav = opts.activeNav || autoDetectActive();

  host.outerHTML = `
    <aside class="sturm-sidebar" id="${hostId}">
      <div class="sturm-sb-head">
        <a href="/" class="sturm-sb-brand" style="text-decoration:none; color:inherit;">
          <span class="sturm-mark">S</span>
          <span class="sturm-brand-word">STURM</span>
        </a>
        <button class="sturm-sb-toggle" aria-label="Sidebar umschalten" onclick="document.getElementById('${hostId}').classList.toggle('is-collapsed')">
          <i data-lucide="panel-left"></i>
        </button>
      </div>

      <nav class="sturm-sb-nav" style="margin-top: 6px;">
        ${PRIMARY_NAV.map(n => `
          <a class="sturm-sb-item ${n.id === activeNav ? 'is-active' : ''}"
             href="${escapeHtml(n.href)}"
             style="text-decoration:none;">
            <i data-lucide="${n.icon}"></i>
            <span class="sturm-sb-item-main"><span class="sturm-sb-item-label">${escapeHtml(n.label)}</span></span>
          </a>
        `).join('')}
      </nav>

      ${opts.contextHeading ? `
        <div class="sturm-sb-section" style="margin-top: 14px;">
          <span>${escapeHtml(opts.contextHeading)}</span>
        </div>
      ` : ''}
      <div id="sturm-nav-context" class="sturm-sb-nav-scroll"></div>

      <div class="sturm-sb-foot">
        <div class="sturm-avatar">C</div>
        <div>
          <div class="sturm-sb-user-name">Christoph</div>
          <div class="sturm-sb-user-plan">0711 Intelligence</div>
        </div>
      </div>
    </aside>
  `;

  // Lucide nach DOM-Replacement neu initialisieren
  window.lucide && window.lucide.createIcons();

  // Context-Section füllen (lazy)
  const ctxHost = document.getElementById('sturm-nav-context');
  if (ctxHost && typeof opts.contextRenderer === 'function') {
    try {
      await opts.contextRenderer(ctxHost);
      window.lucide && window.lucide.createIcons();
    } catch (e) {
      console.warn('[nav] context renderer failed:', e);
    }
  }
}

function autoDetectActive() {
  const p = location.pathname;
  if (p === '/' || p === '/index.html') return 'workflows';
  if (p.startsWith('/anwendungen') || p.startsWith('/steuerfall')) return 'anwendungen';
  if (p.startsWith('/pipeline')) return 'pipeline';
  if (p.startsWith('/designer')) return 'designer';
  if (p.startsWith('/studio-ocr')) return 'studio-ocr';
  return null;
}

// ============ Helpers: Context-Renderer ===========================
// Diese Funktionen sind Default-Renderer für die drei Seiten. Eine Seite kann
// sie direkt einbinden oder einen eigenen Renderer übergeben.

export async function contextRendererAnwendungen(host) {
  try {
    const apps = await fetch('/api/applications').then(r => r.json());
    if (!Array.isArray(apps) || apps.length === 0) {
      host.innerHTML = '<div style="padding: 8px 12px; font-size: 11.5px; color: var(--color-text-tertiary);">Keine Anwendungen registriert.</div>';
      return;
    }
    const blocks = await Promise.all(apps.map(async (app) => {
      const cases = await fetch(`/api/applications/${encodeURIComponent(app.id)}/instances`)
        .then(r => r.ok ? r.json() : []);
      const inBearb = cases.filter(c => c.status === 'in_bearbeitung').length;
      const sealed = cases.filter(c => c.status === 'versiegelt' || c.status === 'eingereicht').length;
      return `
        <a class="sturm-sb-item" href="/anwendungen.html#${encodeURIComponent(app.id)}" style="text-decoration:none;">
          <i data-lucide="box"></i>
          <span class="sturm-sb-item-main">
            <span class="sturm-sb-item-label">${escapeHtml(app.name)}</span>
            <span class="sturm-sb-item-sub" title="${cases.length} Fall${cases.length === 1 ? '' : 'en'} · ${inBearb} offen · ${sealed} versiegelt">${cases.length} · ${inBearb} offen · ${sealed} vers.</span>
          </span>
        </a>
      `;
    }));
    host.innerHTML = blocks.join('');
  } catch (e) {
    host.innerHTML = `<div style="padding: 8px 12px; font-size: 11.5px; color: #ef4444;">Anwendungen-Liste fehlgeschlagen: ${escapeHtml(String(e?.message || e))}</div>`;
  }
}

export async function contextRendererWorkflows(host) {
  try {
    const wfs = await fetch('/api/workflows').then(r => r.json());
    if (!Array.isArray(wfs) || wfs.length === 0) {
      host.innerHTML = '<div style="padding: 8px 12px; font-size: 11.5px; color: var(--color-text-tertiary);">Keine Workflows registriert.</div>';
      return;
    }
    // Group by category (analog zum existing index.html)
    const CATEGORIES = [
      { id: 'elster',  label: 'ELSTER & Steuer', match: id => id.startsWith('elster') },
      { id: 'belege',  label: 'Belege',          match: id => id.startsWith('belege') || id.startsWith('steuerbelege') },
      { id: 'medizin', label: 'Medizin',         match: id => id === 'pentacam-kc-score' || id === 'myopia-progression' },
      { id: 'ocr',     label: 'OCR & Benchmark', match: id => id === 'hello-ocr' || id === 'ocr-shootout' },
      { id: 'lab',     label: 'Labor & Tests',   match: () => true },
    ];
    const groups = new Map(CATEGORIES.map(c => [c.id, []]));
    for (const w of wfs) {
      const cat = CATEGORIES.find(c => c.match(w.id || ''));
      groups.get(cat.id).push(w);
    }
    // Aktiv-Workflow aus URL ermitteln (für Highlight + ggf. vorne anpinnen).
    const activeId = (() => {
      try {
        const u = new URL(window.location.href);
        return u.searchParams.get('workflow') || '';
      } catch { return ''; }
    })();
    const blocks = CATEGORIES.filter(c => groups.get(c.id).length > 0).map(cat => {
      // Alle Workflows zeigen — keine künstliche Truncation mehr.
      // Aktiv-Workflow nach oben ziehen wenn er in dieser Kategorie ist.
      const all = groups.get(cat.id).slice();
      if (activeId) {
        const idx = all.findIndex(w => w.id === activeId);
        if (idx > 0) {
          const [a] = all.splice(idx, 1);
          all.unshift(a);
        }
      }
      return `
        <div style="padding: 6px 0;">
          <div style="padding: 4px 12px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-tertiary);">
            ${escapeHtml(cat.label)} <span style="float: right;">${all.length}</span>
          </div>
          ${all.map(w => {
            const short = (w.name || w.id).split('—')[0].trim();
            const isActive = w.id === activeId;
            const activeStyle = isActive
              ? 'background: var(--color-surface-hover, rgba(255,255,255,.05)); border-left: 2px solid var(--color-accent, #d4a373);'
              : '';
            return `
              <a class="sturm-sb-item${isActive ? ' sturm-sb-item--active' : ''}" href="/pipeline.html?workflow=${encodeURIComponent(w.id)}" style="text-decoration:none;${activeStyle}">
                <i data-lucide="workflow"></i>
                <span class="sturm-sb-item-main"><span class="sturm-sb-item-label">${escapeHtml(short)}</span></span>
              </a>
            `;
          }).join('')}
        </div>
      `;
    });
    host.innerHTML = blocks.join('');
  } catch (e) {
    host.innerHTML = `<div style="padding: 8px 12px; font-size: 11.5px; color: #ef4444;">Workflow-Liste fehlgeschlagen.</div>`;
  }
}

export function contextRendererSteuerfall(host, ctx) {
  // ctx = { caseId, appId, instance? }
  if (!ctx) {
    host.innerHTML = '';
    return;
  }
  const back = `<a class="sturm-sb-item" href="/anwendungen.html" style="text-decoration:none;">
      <i data-lucide="arrow-left"></i>
      <span class="sturm-sb-item-main"><span class="sturm-sb-item-label">← Alle Fälle</span></span>
    </a>`;
  if (!ctx.instance) {
    host.innerHTML = back;
    return;
  }
  const inst = ctx.instance;
  host.innerHTML = `
    ${back}
    <div style="padding: 12px 12px 6px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-tertiary);">Aktiver Fall</div>
    <div style="padding: 4px 12px 12px;">
      <div style="font-size: 13px; color: var(--color-text-primary); font-weight: 500;">${escapeHtml(inst.displayName)}</div>
      <div style="font-size: 11px; color: var(--color-text-tertiary); margin-top: 2px;">${escapeHtml(inst.mandantId || '—')} · ${inst.veranlagungsjahr ?? '—'}</div>
      <div style="font-size: 11px; color: var(--color-text-tertiary); margin-top: 4px;">${inst.runs?.length ?? 0} Run${(inst.runs?.length ?? 0) === 1 ? '' : 's'} · ${escapeHtml(inst.status)}</div>
    </div>
  `;
}
