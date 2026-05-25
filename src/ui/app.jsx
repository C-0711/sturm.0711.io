/* app.jsx — extracted from src/ui/app.html, compiled with esbuild
   The page still loads react + react-dom production UMD as window.React/window.ReactDOM.
   Babel runtime no longer needed in the browser. */
const { useState, useEffect } = React;

/* ==================== Icons ==================== */
const I = {
  grid: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/></svg>,
  layers: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L2 5l6 3 6-3-6-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>,
  play: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 3l9 5-9 5V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>,
  pen: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>,
  sliders: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4h4M11 4h2M3 8h2M9 8h4M3 12h7M13 12h0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="9" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.3"/><circle cx="7" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.3"/><circle cx="12" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.3"/></svg>,
  panel: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M6 3v10" stroke="currentColor" strokeWidth="1.3"/></svg>,
  flow: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="4" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.2"/><rect x="9" y="3" width="4" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.2"/><rect x="5" y="8.5" width="4" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.2"/><path d="M5 4.25L9 4.25M3 5.5v3M11 5.5v3M3 8.5L5 9.75M11 8.5L9 9.75" stroke="currentColor" strokeWidth="1.2"/></svg>,
  receipt: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2v10l1.5-1L6 12l1.5-1L9 12l1.5-1L12 12V2H3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M5 5h5M5 7h5M5 9h3" stroke="currentColor" strokeWidth="1.2"/></svg>,
  pulse: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h3l1.5-4 3 8L10 7h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>,
  scan: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 4V2h2M11 2h2v2M13 10v2h-2M3 12H1v-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M3 7h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  beaker: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 1v4.5L2 11a1.5 1.5 0 001.3 2.2h7.4A1.5 1.5 0 0012 11L9 5.5V1" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M4 1h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  sidebar: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M6 3v10" stroke="currentColor" strokeWidth="1.3"/></svg>,
  sun: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  caret: () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  arr: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h7m0 0L7 4m3 3L7 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  plus: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
};

/* ==================== Data ==================== */
const NAV = [
  { id: 'workflows', label: 'Workflows', icon: I.grid },
  { id: 'apps', label: 'Anwendungen', icon: I.layers, href: 'anwendungen.html' },
  { id: 'runner', label: 'Pipeline-Runner', icon: I.play, href: 'pipeline.html' },
  { id: 'designer', label: 'Designer', icon: I.pen, href: 'designer.html' },
  { id: 'ocr', label: 'OCR Studio', icon: I.sliders, href: 'studio-ocr.html' },
  { id: 'assistant', label: 'Assistant', icon: I.spark || I.pen, href: 'orchestrator.html' },
  { id: 'fleet', label: 'Fleet', icon: I.layers, href: '0711-fleet.html' },
];

const CATEGORIES = [
  { id: 'all',     label: 'All',                 count: 21, icon: null },
  { id: 'tax',     label: 'ELSTER & Tax',        count: 13, icon: I.flow },
  { id: 'receipt', label: 'Receipts',            count: 2,  icon: I.receipt },
  { id: 'med',     label: 'Medical',             count: 2,  icon: I.pulse },
  { id: 'ocr',     label: 'OCR & Benchmark',     count: 2,  icon: I.scan },
  { id: 'lab',     label: 'Lab & Tests',         count: 2,  icon: I.beaker },
];

const WORKFLOWS = [
  {
    name: 'Hello OCR', id: 'hello-ocr', cat: 'ocr',
    desc: 'Loads image / PDF, runs Mistral OCR, returns plain-text stats.',
    badge: 'OCR & Benchmark', stages: 2, runs: '2 runs · ⌀ 2.5s · 100% ok',
    formats: 'PDF · PNG · JPG · JPEG · WEBP',
  },
  {
    name: 'ELSTER — attachment detection & field extraction', id: 'elster-v1', cat: 'tax',
    desc: 'OCR on uploaded tax document → hybrid classification of ELSTER attachments (regex + LLM fallback against 35-attachment enum) → parallel field extraction per detected attachment against the curated field catalogue.',
    badge: 'ELSTER & Tax', stages: 7, runs: '20 runs · ⌀ 8.5s · 100% ok',
    formats: 'PDF · PNG · JPG · JPEG',
  },
  {
    name: 'Single receipt — classification & field extraction', id: 'steuerbelege-v1', cat: 'receipt',
    desc: 'OCR on a single receipt → hybrid classification against type catalogue (regex + LLM fallback) → field extraction against all target ELSTER attachments (eCode hints or container-anchored).',
    badge: 'Receipts', stages: 3, runs: '20 runs · ⌀ 4.8s · 100% ok',
    formats: 'PDF · PNG · JPG · JPEG',
  },
  {
    name: 'Receipt bundle — split, classify & extract', id: 'belege-bundle-v1', cat: 'receipt',
    desc: 'Multi-receipt PDF → OCR → page splitter (by # headings) → per-sub-receipt classification + per-attachment field extraction. For VAST exports and mixed receipt collections.',
    badge: 'Receipts', stages: 5, runs: '12 runs · ⌀ 6.1s · 100% ok',
    formats: 'PDF',
  },
  {
    name: 'ELSTER v2 — funnel cascade & hint-rule validator', id: 'elster-v2', cat: 'tax',
    desc: 'OCR → hybrid classification of ELSTER attachments → parallel field extraction against curated catalogue → funnel cascade on the canonical ELSTER layer → hint-rule validator. Output: a complete tax filing draft.',
    badge: 'ELSTER & Tax', stages: 8, runs: '34 runs · ⌀ 11.2s · 97% ok',
    formats: 'PDF · PNG · JPG',
  },
  {
    name: 'ELSTER v3 — gitchain three-lane', id: 'elster-v3', cat: 'tax',
    desc: 'OCR → hybrid classification → Layer 1 strict json-schema nested extraction via Gemma-4 (vLLM) → Layer 2 entity resolution against curated legal-entity whitelist → Layer 4 deterministic rules.',
    badge: 'ELSTER & Tax', stages: 9, runs: '18 runs · ⌀ 14.8s · 94% ok',
    formats: 'PDF · PNG · JPG',
  },
];

/* ==================== Sidebar ==================== */
function Sidebar({ active, onNav }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-l">
          <span className="brand-tile">S</span>
          <span className="brand-name">STURM</span>
        </div>
        <button className="icon-btn" aria-label="Toggle sidebar"><I.sidebar /></button>
      </div>

      {NAV.map(item => (
        <a key={item.id}
           href={item.href || `#${item.id}`}
           className={`nav-item${active === item.id ? ' active' : ''}`}
           onClick={(e) => { if (!item.href) { e.preventDefault(); onNav(item.id); } }}>
          <item.icon />
          <span>{item.label}</span>
        </a>
      ))}

      {active === 'workflows' && (
        <React.Fragment>
          <div className="sidebar-section"><span>Categories</span></div>
          {CATEGORIES.filter(c => c.id !== 'all').map(c => (
            <a key={c.id} className="nav-item" style={{paddingLeft: 12, fontSize: 13}} href="#">
              {c.icon && <c.icon />}
              <span style={{flex: 1}}>{c.label}</span>
              <span style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--ink-3)'}}>{c.count}</span>
            </a>
          ))}
        </React.Fragment>
      )}

      <div style={{flex: 1}} />

      <div className="sidebar-user">
        <div className="sidebar-user-avatar">C</div>
        <div>
          <div className="sidebar-user-name">Christoph</div>
          <div className="sidebar-user-sub">0711 Intelligence</div>
        </div>
      </div>
    </aside>
  );
}

/* ==================== Topbar ==================== */
function Topbar({ crumb, theme, setTheme }) {
  return (
    <div className="topbar">
      <div className="topbar-l">
        <span className="topbar-crumb">{crumb}</span>
      </div>
      <div className="topbar-r">
        <button className="kbd-pill">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M8.5 8.5L11 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <span>Search</span>
          <span className="kbd">⌘K</span>
        </button>
        <button className="icon-btn" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <I.sun /> : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M13 9.5A5 5 0 017.5 3a5.5 5.5 0 105.5 6.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

/* ==================== Workflows screen ==================== */
function WorkflowsScreen() {
  // Honour ?category=tax|receipt|med|ocr|lab from URL (used by landing page deep-links)
  const initialCat = (() => {
    try {
      const c = new URL(location.href).searchParams.get('category');
      const valid = ['all', 'tax', 'receipt', 'med', 'ocr', 'lab'];
      return valid.indexOf(c) !== -1 ? c : 'all';
    } catch { return 'all'; }
  })();
  const [cat, setCat] = useState(initialCat);
  const visible = WORKFLOWS.filter(w => cat === 'all' || w.cat === cat);
  return (
    <div className="content">
      <div className="page-head">
        <div className="icon-ring">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <path d="M11 3l2 4 4.5.5-3.3 3.2.8 4.5L11 13l-4 2.2.8-4.5L4.5 7.5 9 7l2-4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
          </svg>
        </div>
        <h1>Workflow Engine</h1>
        <p>Every workflow is a graph of stages — from OCR to evaluation. Document in, result out, every step traceable.</p>
      </div>

      <div className="pill-row" style={{justifyContent: 'center'}}>
        {CATEGORIES.map(c => (
          <button key={c.id} className={`pill${cat === c.id ? ' active' : ''}`} onClick={() => setCat(c.id)}>
            {c.icon && <c.icon />}
            <span>{c.label}</span>
            <span className="count">{c.count}</span>
          </button>
        ))}
      </div>

      <div className="wf-grid">
        {visible.map(w => (
          <div className="card" key={w.id}>
            <div className="card-head">
              <h3 className="card-title">{w.name}</h3>
              <span className="card-id">{w.id}</span>
            </div>
            <p className="card-desc">{w.desc}</p>
            <div className="card-foot">
              <div className="card-foot-cell">
                <span className="label">Category</span>
                <span className="val">{w.badge}</span>
              </div>
              <div className="card-foot-cell">
                <span className="label">Stages</span>
                <span className="val">{w.stages}</span>
              </div>
              <div className="card-foot-cell">
                <span className="label">Formats</span>
                <span className="val">{w.formats}</span>
              </div>
              <div className="card-foot-cell">
                <span className="label">Runs</span>
                <span className="val">{w.runs}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ==================== Applications screen ==================== */
function AppsScreen() {
  const [tab, setTab] = useState('all');
  return (
    <div className="content">
      <div className="page-head">
        <div className="icon-ring"><I.layers /></div>
        <h1>Applications</h1>
        <p>Full applications with persistent case state — workflows + RAG + MCPs orchestrated around long-lived domain objects. Pick an application or start a new case.</p>
      </div>

      <div className="app-card">
        <div className="app-card-head">
          <div>
            <h2 className="app-card-title">Income tax case · <span style={{color: 'var(--ink-3)'}}>Steuer</span></h2>
            <div className="app-card-sub">steuerfall-est</div>
          </div>
          <button className="btn btn-primary"><I.plus /> New case</button>
        </div>
        <p className="app-card-desc">
          Income tax return as a versioned, sealable case — receipt capture with retrieval-augmented extraction (TurboQuant + 4-LLM consensus), BMF Lane-1 tax calculation, ELSTER Lane-5 submission.
        </p>
        <div className="accordion">
          <div className="accordion-l">
            <I.caret /> <span>Tools (10)</span>
          </div>
          <div className="accordion-r">
            <span className="stat-dot ok"><span className="dot" /> 10</span>
            <span className="stat-dot warn"><span className="dot" /> 0</span>
            <span className="stat-dot err"><span className="dot" /> 0</span>
          </div>
        </div>

        <div className="app-card-row" style={{justifyContent: 'space-between'}}>
          <div className="pill-row">
            {[['all','All',0],['wip','In progress',0],['sealed','Sealed',0],['submitted','Submitted',0],['archived','Archived',0]].map(([k,l,n]) => (
              <button key={k} className={`pill${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
                <span>{l}</span><span className="count">{n}</span>
              </button>
            ))}
          </div>
          <input className="search-input" placeholder="Search (name, client, ID)…" />
        </div>

        <div className="empty-state">No cases yet. Create one with <strong style={{color: 'var(--ink-2)'}}>New case</strong>.</div>
      </div>
    </div>
  );
}

/* ==================== Pipeline Runner screen ==================== */
const RUNS = [
  { name: 'ELSTER v5.2-RAG + 4-LLM-Ensemble', pipeline: 'elster-v5_2-rag-ensemble', status: 'ok', stages: ['ocr','classify','extract','validate','file'], time: '11.2 s', when: '2 min ago' },
  { name: 'Single receipt — classification', pipeline: 'steuerbelege-v1', status: 'ok', stages: ['ocr','classify','fields'], time: '4.8 s', when: '14 min ago' },
  { name: 'Hello OCR', pipeline: 'hello-ocr', status: 'ok', stages: ['ocr','stats'], time: '2.5 s', when: '1 h ago' },
  { name: 'ELSTER v4 — Stricker', pipeline: 'elster-v4-stricker', status: 'warn', stages: ['ocr','classify','extract','funnel'], time: '14.0 s', when: '3 h ago' },
  { name: 'OCR Shootout (A/B Benchmark)', pipeline: 'ocr-shootout', status: 'ok', stages: ['ocr-a','ocr-b','diff','score'], time: '6.7 s', when: 'yesterday' },
  { name: 'Pentacam — clinical fields', pipeline: 'pentacam', status: 'err', stages: ['parse','normalize','range'], time: '2.1 s', when: 'yesterday' },
];

function RunnerScreen() {
  return (
    <div className="content">
      <div className="page-head">
        <div className="icon-ring"><I.play /></div>
        <h1>Pipeline Runner</h1>
        <p>Watch runs as they happen. Inspect outputs, retry failed stages, compare to baseline.</p>
      </div>

      <div className="pill-row" style={{justifyContent: 'center'}}>
        <button className="pill active"><span>All runs</span><span className="count">42</span></button>
        <button className="pill"><span>OK</span><span className="count">38</span></button>
        <button className="pill"><span>Warn</span><span className="count">3</span></button>
        <button className="pill"><span>Error</span><span className="count">1</span></button>
      </div>

      <div className="runner-list">
        {RUNS.map((r, i) => (
          <div className="run-row" key={i}>
            <span className={`run-dot`} style={{background: r.status === 'ok' ? 'var(--ok)' : r.status === 'warn' ? 'var(--warn)' : 'var(--err)'}} />
            <div>
              <div className="run-name">{r.name}</div>
              <div className="run-pipeline">{r.pipeline}</div>
            </div>
            <div className="run-stages">
              {r.stages.map((s, j) => (
                <React.Fragment key={s}>
                  {j > 0 && <span className="run-arr">→</span>}
                  <span>{s}</span>
                </React.Fragment>
              ))}
            </div>
            <div className="run-time">{r.time}</div>
            <div className="run-status">{r.when}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ==================== App shell ==================== */
function App() {
  const [active, setActive] = useState(() => {
    const h = window.location.hash.replace('#', '');
    return ['workflows','apps','runner'].includes(h) ? h : 'workflows';
  });
  const [theme, setThemeState] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');
  const setTheme = (t) => {
    setThemeState(t);
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('sturm-theme', t); } catch (e) {}
  };
  useEffect(() => {
    window.location.hash = active;
  }, [active]);

  const crumbMap = { workflows: 'Workflow Engine', apps: 'Applications', runner: 'Pipeline Runner' };

  return (
    <div className="shell">
      <Sidebar active={active} onNav={setActive} />
      <div className="main">
        <Topbar crumb={crumbMap[active]} theme={theme} setTheme={setTheme} />
        {active === 'workflows' && <WorkflowsScreen />}
        {active === 'apps' && <AppsScreen />}
        {active === 'runner' && <RunnerScreen />}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);