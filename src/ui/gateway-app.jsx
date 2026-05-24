/* eslint-disable */
const { useState, useEffect, useMemo, useRef } = React;

/* ==================== ICONS ==================== */
const I = {
  grid: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="0.7" stroke="currentColor" strokeWidth="1.2"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="0.7" stroke="currentColor" strokeWidth="1.2"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="0.7" stroke="currentColor" strokeWidth="1.2"/><rect x="8" y="8" width="4.5" height="4.5" rx="0.7" stroke="currentColor" strokeWidth="1.2"/></svg>,
  graph: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="3" cy="11" r="1.5" stroke="currentColor" strokeWidth="1.2"/><circle cx="11" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.2"/><circle cx="11" cy="11" r="1.5" stroke="currentColor" strokeWidth="1.2"/><circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M4.5 11h5M7 5l3-1M7 7l3 3" stroke="currentColor" strokeWidth="1.1"/></svg>,
  matrix: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="11" height="11" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M5 1.5v11M9 1.5v11M1.5 5h11M1.5 9h11" stroke="currentColor" strokeWidth="1.1"/></svg>,
  box: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5L2 4v6l5 2.5L12 10V4L7 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M2 4l5 2.5L12 4M7 6.5v6" stroke="currentColor" strokeWidth="1.2"/></svg>,
  fleet: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/><path d="M1.5 7h11M7 1.5a8 8 0 010 11M7 1.5a8 8 0 000 11" stroke="currentColor" strokeWidth="1.1"/></svg>,
  pulse: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1.5 7h2.5L5.5 3l3 8L10 7h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round"/></svg>,
  shield: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5L12 3v4c0 3-2 5-5 6-3-1-5-3-5-6V3l5-1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>,
  doc: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 1.5h6l2 2v9H3v-11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M9 1.5v2h2M5 7h4M5 9.5h4" stroke="currentColor" strokeWidth="1.2"/></svg>,
  sun: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.2"/><path d="M7 1.5v1.4M7 11.1v1.4M1.5 7h1.4M11.1 7h1.4M2.7 2.7l1 1M10.3 10.3l1 1M2.7 11.3l1-1M10.3 3.7l1-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  moon: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 8.5A4.5 4.5 0 016.5 4a5 5 0 105 5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>,
  check: () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  alert: () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v4M6 8.5v0.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/></svg>,
  x: () => <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M2 2l5 5M7 2l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  zoomIn: () => <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 2.5v8M2.5 6.5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  zoomOut: () => <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 6.5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  fit: () => <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 2.5h3M10.5 2.5h-3v3M10.5 10.5h-3v-3M2.5 10.5h3v-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  refresh: () => <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M11 3.5v3h-3M2 9.5v-3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><path d="M3 5.5a4 4 0 017.5-1M10 7.5a4 4 0 01-7.5 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  external: () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5H2v8h8V8M7.5 2.5H10V5M10 2.5L5.5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
};

/* ==================== TRUTH SYSTEM ==================== */
const TRUTH = {
  live: { label: 'LIVE',        desc: 'real-time data from authoritative endpoint' },
  mixed: { label: 'MIXED',      desc: 'live where available, fallback elsewhere' },
  seeded: { label: 'SEEDED',    desc: 'fixture data — not yet wired to live source' },
  inferred: { label: 'INFERRED',desc: 'derived from indirect signals, not directly observed' },
  unavailable: { label: 'UNAVAILABLE', desc: 'no data — endpoint down or not yet implemented' },
};

const Truth = ({ s }) => (
  <span className={`truth ${s}`} title={TRUTH[s].desc}>{TRUTH[s].label}</span>
);

/* ==================== MOCKED DATA ==================== */
const SOURCES = {
  health: { endpoint: '/api/health', truth: 'live' },
  containers: { endpoint: '/api/containers', truth: 'live' },
  topology: { endpoint: '/api/fleet/topology', truth: 'live' },
  chain: { endpoint: '/api/chain/status', truth: 'live' },
  doku: { endpoint: '/api/doku', truth: 'live' },
  klavis: { endpoint: '/quantum-klavis', truth: 'live' },
  projects: { endpoint: '/api/projects', truth: 'mixed' },
  agents: { endpoint: '/api/agents', truth: 'seeded' },
};

const CONTAINERS = [
  { name: 'gitchain',         image: 'ghcr.io/0711/gitchain:1.4.2',          host: 'gw-01', port: 7081, health: 'ok',   role: 'context · routing', truth: 'live' },
  { name: 'turbo',            image: 'ghcr.io/0711/turbo:0.9.1',             host: 'gw-01', port: 7082, health: 'ok',   role: 'orchestration',     truth: 'live' },
  { name: 'quantum-gateway',  image: 'ghcr.io/0711/quantum-gateway:2.1.0',   host: 'gw-01', port: 7080, health: 'ok',   role: 'gateway',           truth: 'live' },
  { name: 'klavis',           image: 'ghcr.io/0711/klavis:0.6.3',            host: 'gw-02', port: 7090, health: 'ok',   role: 'model · LLM',       truth: 'live' },
  { name: 'mistral-router',   image: 'ghcr.io/0711/mistral-router:0.3.0',    host: 'gw-01', port: 7083, health: 'warn', role: 'proxy · LLM',       truth: 'live' },
  { name: 'doku-svc',         image: 'ghcr.io/0711/doku:0.2.0',              host: 'gw-01', port: 7084, health: 'ok',   role: 'execution',         truth: 'live' },
  { name: 'agent-orchestrator', image: 'ghcr.io/0711/agent-orch:0.4.0',      host: 'gw-02', port: 7091, health: 'idle', role: 'agents',            truth: 'mixed' },
  { name: 'context-cache',    image: 'redis:7.2-alpine',                     host: 'gw-01', port: 6379, health: 'ok',   role: 'context',           truth: 'live' },
  { name: 'auth-broker',      image: 'ghcr.io/0711/auth-broker:1.1.0',       host: 'gw-01', port: 7085, health: 'ok',   role: 'auth',              truth: 'live' },
  { name: 'model-registry',   image: 'ghcr.io/0711/registry:0.8.0',          host: 'gw-02', port: 7092, health: 'ok',   role: 'registry',          truth: 'live' },
  { name: 'edge-proxy',       image: 'ghcr.io/0711/edge-proxy:1.0.0',        host: 'edge-01', port: 443, health: 'ok', role: 'ingress',           truth: 'live' },
  { name: 'observer',         image: 'ghcr.io/0711/observer:0.7.0',          host: 'gw-01', port: 7086, health: 'ok',   role: 'observability',     truth: 'live' },
];

const SERVICES = [
  { id: 'gitchain', name: 'gitchain', kind: 'service', role: 'context · routing' },
  { id: 'turbo', name: 'turbo', kind: 'service', role: 'orchestration' },
  { id: 'quantum-gateway', name: 'quantum-gateway', kind: 'service', role: 'gateway' },
  { id: 'klavis', name: 'klavis', kind: 'service', role: 'LLM bridge' },
  { id: 'agent-a', name: 'agent-a', kind: 'agent', role: 'planner' },
  { id: 'agent-b', name: 'agent-b', kind: 'agent', role: 'writer' },
  { id: 'mistral-router', name: 'mistral-router', kind: 'proxy', role: 'proxy' },
];

const MODELS = [
  { id: 'opus-47', name: 'Opus 4.7', vendor: 'Anthropic' },
  { id: 'sonnet-45', name: 'Sonnet 4.5', vendor: 'Anthropic' },
  { id: 'haiku-45', name: 'Haiku 4.5', vendor: 'Anthropic' },
  { id: 'gpt-5', name: 'GPT-5', vendor: 'OpenAI' },
  { id: 'gemini-25', name: 'Gemini 2.5', vendor: 'Google' },
  { id: 'gemma-4', name: 'gemma-4 (local)', vendor: 'local / vLLM' },
];

/* matrix cell: { state, path, auth, truth } */
const _r = (path, auth, truth) => ({ state: 'reach', path, auth, truth });
const _p = (path, auth, truth) => ({ state: 'proxy', path, auth, truth });
const _b = (truth) => ({ state: 'block', path: '—', auth: '—', truth });
const _u = (truth) => ({ state: 'unknown', path: '—', auth: '—', truth });

const MATRIX = {
  gitchain:         { 'opus-47': _r('direct', 'sa-key', 'live'),  'sonnet-45': _r('direct','sa-key','live'),'haiku-45': _r('direct','sa-key','live'),'gpt-5': _p('via-router','sa-key','live'), 'gemini-25': _p('via-router','oauth','mixed'), 'gemma-4': _r('local','none','live') },
  turbo:            { 'opus-47': _r('gateway','sa-key','live'),    'sonnet-45': _r('gateway','sa-key','live'),'haiku-45': _r('gateway','sa-key','live'),'gpt-5': _p('via-router','sa-key','live'), 'gemini-25': _b('seeded'),                     'gemma-4': _r('local','none','live') },
  'quantum-gateway':{ 'opus-47': _r('direct','sa-key','live'),    'sonnet-45': _r('direct','sa-key','live'),'haiku-45': _r('direct','sa-key','live'),'gpt-5': _r('direct','sa-key','live'),     'gemini-25': _r('direct','oauth','live'),     'gemma-4': _r('local','none','live') },
  klavis:           { 'opus-47': _r('pinned','sa-key','live'),     'sonnet-45': _b('live'),                  'haiku-45': _b('live'),                  'gpt-5': _b('live'),                       'gemini-25': _b('live'),                      'gemma-4': _b('live') },
  'agent-a':        { 'opus-47': _p('via-gateway','jwt','live'),   'sonnet-45': _p('via-gateway','jwt','live'),'haiku-45': _p('via-gateway','jwt','live'),'gpt-5': _b('live'),                    'gemini-25': _u('inferred'),                  'gemma-4': _p('via-gateway','none','mixed') },
  'agent-b':        { 'opus-47': _p('via-gateway','jwt','mixed'),  'sonnet-45': _p('via-gateway','jwt','mixed'),'haiku-45': _u('inferred'),               'gpt-5': _u('inferred'),                   'gemini-25': _u('unavailable'),              'gemma-4': _u('inferred') },
  'mistral-router': { 'opus-47': _b('live'),                       'sonnet-45': _b('live'),                  'haiku-45': _b('live'),                  'gpt-5': _r('direct','sa-key','live'),     'gemini-25': _r('direct','oauth','mixed'),    'gemma-4': _b('live') },
};

const ALERTS = [
  { sev: 'warn', name: 'mistral-router · degraded',    desc: '12% timeouts on /v1/messages over last 5m', when: '2 min ago' },
  { sev: 'warn', name: 'agent-b · routing inferred',   desc: 'no direct probe; status derived from gateway logs', when: '8 min ago' },
  { sev: 'err',  name: 'gemini-25 ← agent-b',          desc: 'no successful call in 24h; marked UNAVAILABLE', when: '1 h ago' },
  { sev: 'ok',   name: 'klavis · smoke pass',          desc: 'restart-safe verified, Opus 4.7 responding', when: '14 min ago' },
];

const FLEET_OBSERVABLE = [
  { name: 'gitchain', meta: 'gw-01 · :7081 · 1.4.2', health: 'ok',  truth: 'live' },
  { name: 'turbo', meta: 'gw-01 · :7082 · 0.9.1', health: 'ok',  truth: 'live' },
  { name: 'quantum-gateway', meta: 'gw-01 · :7080 · 2.1.0', health: 'ok',  truth: 'live' },
  { name: 'klavis', meta: 'gw-02 · :7090 · 0.6.3 · Opus 4.7', health: 'ok',  truth: 'live' },
  { name: 'doku-svc', meta: 'gw-01 · :7084 · 0.2.0', health: 'ok',  truth: 'live' },
  { name: 'auth-broker', meta: 'gw-01 · :7085 · 1.1.0', health: 'ok',  truth: 'live' },
  { name: 'mistral-router', meta: 'gw-01 · :7083 · 0.3.0', health: 'warn', truth: 'live' },
  { name: 'context-cache', meta: 'gw-01 · redis :6379', health: 'ok',  truth: 'live' },
];
const FLEET_UNOBSERVABLE = [
  { name: 'edge-proxy', meta: 'edge-01 · :443 · 1.0.0', truth: 'inferred', reason: 'not observable from gateway runtime — health derived from upstream probes' },
  { name: 'agent-orchestrator', meta: 'gw-02 · :7091 · 0.4.0', truth: 'mixed', reason: 'partial telemetry; agents reported via /api/agents (seeded subset)' },
  { name: 'model-registry', meta: 'gw-02 · :7092 · 0.8.0', truth: 'inferred', reason: 'not on observer bus; presence confirmed by registry lookups only' },
];

const RUNTIME_SIGNALS = [
  { sev: 'ok',   name: 'Gateway runtime',          desc: 'quantum-gateway main loop OK · 6 d uptime',                    val: 'OK' },
  { sev: 'ok',   name: 'Chain advancement',        desc: 'gitchain at block 41284 · last commit 3s ago',                  val: '41284' },
  { sev: 'ok',   name: 'Context cache',            desc: 'redis healthy · 142k keys · 312 MB',                            val: '142k' },
  { sev: 'warn', name: 'Mistral router latency',   desc: 'p95 1240ms (threshold 800ms)',                                  val: '1240ms' },
  { sev: 'ok',   name: 'Auth broker',              desc: 'JWT signer rotating · last rotation 18 h ago',                  val: 'OK' },
  { sev: 'err',  name: 'Gemini connector',         desc: 'oauth refresh failed · last success 26h ago',                    val: 'FAIL' },
  { sev: 'ok',   name: 'Klavis smoke',             desc: 'last run 14 min ago · all probes green',                        val: 'PASS' },
  { sev: 'warn', name: 'Doku queue depth',         desc: '14 pending tickets (target ≤ 10)',                              val: '14' },
];

const KLAVIS_EVIDENCE = [
  { what: 'Smoke test · /v1/messages probe',         when: '14 min ago', truth: 'live' },
  { what: 'Restart-safe run (rolling restart probe)', when: '1 h 02 min ago', truth: 'live' },
  { what: 'Auth probe · service account header',     when: '14 min ago', truth: 'live' },
  { what: 'Latency probe · p50 / p95 / p99',         when: '34 sec ago', truth: 'live' },
  { what: 'Token budget probe (1k / 4k / 16k)',      when: '7 h 12 min ago', truth: 'mixed' },
  { what: 'Failover drill · secondary path',         when: '3 d ago', truth: 'live' },
];

/* ==================== NAVIGATION ==================== */
const NAV = [
  { section: 'CONTROL' },
  { id: 'overview',     label: 'Overview',     icon: I.grid },
  { id: 'topology',     label: 'Context topology', icon: I.graph },
  { id: 'connectivity', label: 'LLM connectivity', icon: I.matrix },
  { section: 'FLEET' },
  { id: 'containers',   label: 'Containers',   icon: I.box,   tag: '12' },
  { id: 'fleet',        label: 'Fleet topology', icon: I.fleet },
  { id: 'runtime',      label: 'Runtime & chain', icon: I.pulse },
  { section: 'COLLAB' },
  { id: 'multillm',     label: 'Multi-LLM workspace', icon: I.matrix },
  { section: 'SERVICES' },
  { id: 'klavis',       label: 'Klavis', icon: I.shield, tag: 'live', tagCls: 'live' },
  { id: 'doku',         label: 'Doku & exec', icon: I.doc },
];

const TITLE_MAP = {
  overview:     { crumb: 'Overview',           title: 'Control plane',           lede: 'What is live right now across the fleet. Every dataset declares its truth state.' },
  topology:     { crumb: 'Topology',           title: 'Context topology graph',  lede: 'How request, context, auth, and model paths connect across services. Inferred edges marked.' },
  connectivity: { crumb: 'Connectivity',       title: 'LLM connectivity matrix', lede: 'Service → model reachability, path, auth, and truth status. Click a cell for the call evidence.' },
  containers:   { crumb: 'Containers',         title: 'Containers',              lede: 'Live container inventory from /api/containers. Whether each participates in the context-to-LLM path.' },
  fleet:        { crumb: 'Fleet topology',     title: 'Fleet topology',          lede: 'Members observable from the gateway runtime vs. those whose status is inferred or partial.' },
  runtime:      { crumb: 'Runtime',            title: 'Runtime & chain status',  lede: 'Core runtime, chain advancement, and connector health. Warnings surfaced honestly, not hidden.' },
  multillm:     { crumb: 'Multi-LLM',          title: 'Multi-LLM workspace',     lede: 'Container-bound topic with multiple models collaborating under one shared context. Truth and trust boundaries enforced.' },
  klavis:       { crumb: 'Klavis',             title: 'Klavis · LLM bridge',     lede: 'First-class fleet member. Live health, model pinning, auth, smoke + restart-safe evidence.' },
  doku:         { crumb: 'Doku',               title: 'Doku & execution',       lede: 'Blockers, progress, and owners at a glance. Pulled from /api/doku.' },
};

/* ==================== SHELL ==================== */
function Side({ active, onNav, theme, setTheme }) {
  return (
    <aside className="gw-side">
      <div className="gw-side-brand">
        <span className="brand-tile">S</span>
        <div className="gw-side-brand-text">
          <span className="gw-side-brand-l1">QUANTUM</span>
          <span className="gw-side-brand-l2">gateway · control</span>
        </div>
      </div>
      <div className="gw-nav">
        {NAV.map((n, i) => n.section ? (
          <div className="gw-nav-section" key={`s-${i}`}>{n.section}</div>
        ) : (
          <a key={n.id}
             className={active === n.id ? 'active' : ''}
             onClick={() => onNav(n.id)}>
            <span className="ic"><n.icon /></span>
            <span>{n.label}</span>
            {n.tag && <span className={`tag ${n.tagCls || ''}`}>{n.tag}</span>}
          </a>
        ))}
      </div>
      <div className="gw-side-foot">
        <div className="gw-side-foot-row"><span>build</span><strong>2.1.0-rc3</strong></div>
        <div className="gw-side-foot-row"><span>region</span><strong>eu-central · gw-cluster</strong></div>
        <div className="gw-side-foot-row" style={{marginTop: 4, alignItems: 'center'}}>
          <span>theme</span>
          <button
            className="icon-btn"
            style={{width: 24, height: 24, borderRadius: 4}}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme">
            {theme === 'dark' ? <I.sun /> : <I.moon />}
          </button>
        </div>
      </div>
    </aside>
  );
}

function TopBar({ active }) {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const m = TITLE_MAP[active] || {};
  const fmt = (n) => String(n).padStart(2, '0');
  const time = `${fmt(t.getUTCHours())}:${fmt(t.getUTCMinutes())}:${fmt(t.getUTCSeconds())} UTC`;
  return (
    <header className="gw-top">
      <div className="gw-top-title">
        <span>{m.title}</span>
        <span className="gw-top-crumb">{m.crumb}</span>
      </div>
      <div className="gw-top-spacer" />
      <div className="gw-top-clock"><span className="dot" />{time}</div>
    </header>
  );
}

/* ==================== TRUTH BAR (legend strip used on most pages) ==================== */
function TruthBar({ source, hint }) {
  return (
    <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-3)', padding: '12px 16px', background: 'var(--bg-2)', border: '1px solid var(--line-2)', borderRadius: 'var(--radius)'}}>
      <Truth s={source.truth} />
      <span>{source.endpoint}</span>
      {hint && <span style={{marginLeft: 'auto', color: 'var(--ink-4)'}}>{hint}</span>}
    </div>
  );
}

function TruthLegend() {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-h">Truth taxonomy</h2>
        <span className="panel-spacer" />
        <span className="panel-sub">global</span>
      </div>
      <div className="panel-body stack-8">
        {Object.entries(TRUTH).map(([k, v]) => (
          <div key={k} style={{display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'center'}}>
            <Truth s={k} />
            <span style={{fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5}}>{v.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ==================== OVERVIEW ==================== */
function Overview({ onNav }) {
  const liveTruth = Object.values(MATRIX).flatMap(row => Object.values(row)).filter(c => c.truth === 'live').length;
  const totalCells = Object.values(MATRIX).flatMap(row => Object.values(row)).length;
  const livePct = Math.round(100 * liveTruth / totalCells);
  return (
    <div className="stack-16">
      <div className="row-4">
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">Fleet members</h2><span className="panel-spacer" /><Truth s="live" /></div>
          <div className="panel-body stack-8">
            <div className="stat">
              <span className="stat-value">12<span className="unit"> total</span></span>
              <span className="stat-delta up">↑ 10 live · 1 warn · 1 inferred</span>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">Services healthy</h2><span className="panel-spacer" /><Truth s="live" /></div>
          <div className="panel-body stack-8">
            <div className="stat">
              <span className="stat-value">92<span className="unit"> %</span></span>
              <span className="stat-delta">11 / 12 reporting OK · mistral-router degraded</span>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">LLM routes live</h2><span className="panel-spacer" /><Truth s="live" /></div>
          <div className="panel-body stack-8">
            <div className="stat">
              <span className="stat-value">{liveTruth}<span className="unit"> / {totalCells}</span></span>
              <span className="stat-delta">{livePct}% of matrix cells live · rest mixed/inferred</span>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">Truth coverage</h2><span className="panel-spacer" /><Truth s="live" /></div>
          <div className="panel-body stack-8">
            <div className="stat">
              <span className="stat-value">71<span className="unit"> %</span></span>
              <span className="stat-delta down">↓ 19% inferred · 10% mixed/seeded</span>
            </div>
          </div>
        </div>
      </div>

      <div className="klavis-card">
        <div className="klavis-card-head">
          <div className="klavis-card-title">
            <span className="tile">K</span>
            <span>Klavis · LLM bridge</span>
            <Truth s="live" />
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => onNav('klavis')}>Open drilldown <I.external /></button>
        </div>
        <div className="klavis-card-grid">
          <div className="klavis-card-cell">
            <span className="label">Model · pinned</span>
            <span className="val"><span className="s-dot ok" /> Opus 4.7</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Auth</span>
            <span className="val">service-account · header injection</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Smoke test</span>
            <span className="val"><span className="s-dot ok" /> PASS · 14 min ago</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Restart-safe</span>
            <span className="val"><span className="s-dot ok" /> verified · 1 h ago</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Latency · p95</span>
            <span className="val">412 ms</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Token budget</span>
            <span className="val">1k / 4k / 16k · all green</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Endpoint</span>
            <span className="val">/quantum-klavis</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Host</span>
            <span className="val">gw-02 · :7090</span>
          </div>
        </div>
        <div className="klavis-card-foot">
          <span className="chip ok">probes green</span>
          <span className="chip">last deploy 6 d ago</span>
          <span className="chip">image klavis:0.6.3</span>
          <span className="chip dim">SLO 99.5% (28d) · current 99.8%</span>
        </div>
      </div>

      <div className="row-31">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-h">Active alerts</h2>
            <span className="panel-sub">4 unresolved</span>
            <span className="panel-spacer" />
            <Truth s="live" />
          </div>
          <div className="panel-body flush">
            {ALERTS.map((a, i) => (
              <div className="alert-row" key={i}>
                <span className={`s-dot ${a.sev}`} />
                <div>
                  <div className="name">{a.name}</div>
                  <div className="desc">{a.desc}</div>
                </div>
                <span className={`chip ${a.sev === 'ok' ? 'ok' : a.sev === 'warn' ? 'warn' : 'err'}`}>{a.sev}</span>
                <span className="when">{a.when}</span>
              </div>
            ))}
          </div>
        </div>
        <TruthLegend />
      </div>

      <div className="row-2">
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">Top runtime services</h2><span className="panel-spacer" /><Truth s="live" /></div>
          <div className="panel-body flush">
            {CONTAINERS.slice(0, 6).map(c => (
              <div className="alert-row" key={c.name}>
                <span className={`s-dot ${c.health}`} />
                <div>
                  <div className="name">{c.name}</div>
                  <div className="desc">{c.role} · {c.host}:{c.port}</div>
                </div>
                <Truth s={c.truth} />
                <span className="when">{c.health.toUpperCase()}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">Quick links</h2><span className="panel-spacer" /></div>
          <div className="panel-body stack-8">
            {[
              ['Open topology graph', 'topology'],
              ['Open connectivity matrix', 'connectivity'],
              ['Open containers', 'containers'],
              ['Open fleet topology', 'fleet'],
              ['Open runtime & chain', 'runtime'],
              ['Open Klavis drilldown', 'klavis'],
              ['Open Doku & execution', 'doku'],
            ].map(([label, route]) => (
              <button key={route}
                className="btn btn-ghost"
                style={{justifyContent: 'space-between', width: '100%'}}
                onClick={() => onNav(route)}>
                <span>{label}</span>
                <I.external />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==================== CONNECTIVITY MATRIX ==================== */
function ConnectivityMatrix() {
  const [selected, setSelected] = useState(null);
  const cell = selected ? MATRIX[selected.svc][selected.model] : null;
  const model = selected ? MODELS.find(m => m.id === selected.model) : null;
  return (
    <div className="stack-16">
      <TruthBar source={SOURCES.health} hint="probe-derived · live from /api/health gateway loop" />
      <div className="panel">
        <div className="mx-legend">
          <div className="mx-legend-item"><span className="sw" style={{background: 'var(--ok)'}} /> reachable</div>
          <div className="mx-legend-item"><span className="sw" style={{background: 'var(--info)'}} /> via proxy/router</div>
          <div className="mx-legend-item"><span className="sw" style={{background: 'var(--err)'}} /> blocked / not allowed</div>
          <div className="mx-legend-item"><span className="sw" style={{background: 'var(--ink-4)'}} /> unknown</div>
          <span style={{marginLeft: 'auto', color: 'var(--ink-4)'}}>click any cell for evidence</span>
        </div>
        <div className="mx-wrap" style={{maxHeight: 'calc(100vh - 360px)'}}>
          <table className="mx">
            <thead>
              <tr>
                <th className="row-label">Service ↘ Model</th>
                {MODELS.map(m => <th key={m.id}><div>{m.name}</div><div style={{fontSize: 9, color: 'var(--ink-4)', marginTop: 2}}>{m.vendor}</div></th>)}
              </tr>
            </thead>
            <tbody>
              {SERVICES.map(s => (
                <tr key={s.id}>
                  <th>{s.name}<span className="role">{s.role} · {s.kind}</span></th>
                  {MODELS.map(m => {
                    const c = MATRIX[s.id][m.id];
                    const label = c.state === 'reach' ? 'reach' : c.state === 'proxy' ? 'proxy' : c.state === 'block' ? 'block' : 'unknown';
                    const sym = c.state === 'reach' ? '✓' : c.state === 'proxy' ? '⇢' : c.state === 'block' ? '✕' : '?';
                    return (
                      <td className="mx-cell" key={m.id} onClick={() => setSelected({ svc: s.id, model: m.id })}>
                        <div className="mx-cell-inner">
                          <span className={`mx-state ${c.state}`}>
                            <span className="glyph">{sym}</span> {label}
                          </span>
                          <span className="mx-cell-path">{c.path}</span>
                          <span className="mx-cell-auth">auth: {c.auth}</span>
                          <Truth s={c.truth} />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-h">Evidence · {selected.svc} → {model.name}</h2>
            <span className="panel-spacer" />
            <Truth s={cell.truth} />
            <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close" style={{width: 26, height: 26}}><I.x /></button>
          </div>
          <div className="panel-body stack-8">
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16}}>
              <div><div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.06em', color: 'var(--ink-3)', textTransform: 'uppercase'}}>State</div><div className={`mx-state ${cell.state}`}>{cell.state}</div></div>
              <div><div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.06em', color: 'var(--ink-3)', textTransform: 'uppercase'}}>Path</div><div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 13}}>{cell.path}</div></div>
              <div><div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.06em', color: 'var(--ink-3)', textTransform: 'uppercase'}}>Auth</div><div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 13}}>{cell.auth}</div></div>
              <div><div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.06em', color: 'var(--ink-3)', textTransform: 'uppercase'}}>Last probe</div><div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 13}}>{cell.state === 'unknown' || cell.state === 'block' ? '—' : `${(Math.random() * 12 | 0) + 1} min ago`}</div></div>
            </div>
            <div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.6, marginTop: 8}}>
              {cell.state === 'reach' && `→ ${selected.svc} called ${model.name} successfully via ${cell.path} path with ${cell.auth}. Replay sample: 200 OK, 412ms p95.`}
              {cell.state === 'proxy' && `→ ${selected.svc} reaches ${model.name} only via the proxy/router. Direct path not allowed by current policy.`}
              {cell.state === 'block' && `→ Route from ${selected.svc} to ${model.name} is explicitly blocked by policy / not configured. No recent probe attempts.`}
              {cell.state === 'unknown' && `→ No direct evidence. Status ${cell.truth === 'inferred' ? 'inferred from indirect signals' : 'derived from seeded fixtures'}. Marked accordingly.`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==================== TOPOLOGY GRAPH ==================== */
const TOPO_NODES = [
  { id: 'edge', label: 'edge-proxy', sub: 'ingress · :443', x: 60,  y: 100, w: 110, h: 44, shape: 'rect', state: 'warn',  truth: 'inferred' },
  { id: 'gw',   label: 'quantum-gateway', sub: 'gateway · :7080', x: 240, y: 200, w: 150, h: 50, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'gitchain', label: 'gitchain', sub: 'context · :7081', x: 110, y: 320, w: 120, h: 44, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'turbo', label: 'turbo', sub: 'orchestration · :7082', x: 300, y: 380, w: 120, h: 44, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'cache', label: 'context-cache', sub: 'redis · :6379', x: 80,  y: 460, w: 130, h: 40, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'agentA', label: 'agent-a', sub: 'planner', x: 280, y: 90, w: 100, h: 44, shape: 'ellipse', state: 'live', truth: 'live' },
  { id: 'agentB', label: 'agent-b', sub: 'writer', x: 410, y: 120, w: 100, h: 44, shape: 'ellipse', state: 'warn', truth: 'inferred' },
  { id: 'auth', label: 'auth-broker', sub: 'JWT signer · :7085', x: 510, y: 220, w: 130, h: 44, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'router', label: 'mistral-router', sub: 'proxy · :7083', x: 480, y: 340, w: 130, h: 44, shape: 'rect', state: 'warn', truth: 'live' },
  { id: 'klavis', label: 'klavis', sub: 'LLM bridge · Opus 4.7', x: 720, y: 200, w: 150, h: 50, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'opus', label: 'Opus 4.7', sub: 'Anthropic', x: 900, y: 130, w: 120, h: 40, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'sonnet', label: 'Sonnet 4.5', sub: 'Anthropic', x: 900, y: 200, w: 120, h: 40, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'haiku', label: 'Haiku 4.5', sub: 'Anthropic', x: 900, y: 270, w: 120, h: 40, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'gpt5', label: 'GPT-5', sub: 'OpenAI · via router', x: 720, y: 380, w: 140, h: 40, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'gemini', label: 'Gemini 2.5', sub: 'Google · via router', x: 720, y: 450, w: 140, h: 40, shape: 'rect', state: 'live', truth: 'mixed' },
  { id: 'gemma', label: 'gemma-4', sub: 'local · vLLM', x: 540, y: 460, w: 110, h: 40, shape: 'rect', state: 'live', truth: 'live' },
  { id: 'observer', label: 'observer', sub: 'observability · :7086', x: 280, y: 540, w: 130, h: 40, shape: 'rect', state: 'live', truth: 'live' },
];

const TOPO_EDGES = [
  // request paths
  ['edge', 'gw', 'request'],
  ['agentA', 'gw', 'request'],
  ['agentB', 'gw', 'request'],
  ['gitchain', 'gw', 'request'],
  ['turbo', 'gw', 'request'],
  // context paths
  ['gitchain', 'cache', 'context'],
  ['cache', 'gw', 'context'],
  ['turbo', 'cache', 'context'],
  // auth paths
  ['gw', 'auth', 'auth'],
  ['agentA', 'auth', 'auth'],
  ['agentB', 'auth', 'auth'],
  // model paths
  ['gw', 'klavis', 'model'],
  ['klavis', 'opus', 'model'],
  ['klavis', 'sonnet', 'model'],
  ['klavis', 'haiku', 'model'],
  ['gw', 'router', 'model'],
  ['router', 'gpt5', 'model'],
  ['router', 'gemini', 'model'],
  ['gw', 'gemma', 'model'],
  // observer ingest (inferred)
  ['gw', 'observer', 'inferred'],
  ['klavis', 'observer', 'inferred'],
  ['router', 'observer', 'inferred'],
];

function TopologyGraph() {
  const W = 1080, H = 640;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState(null);
  const [hovered, setHovered] = useState(null);

  const nodeById = useMemo(() => Object.fromEntries(TOPO_NODES.map(n => [n.id, n])), []);

  const onDown = (e) => setDrag({ x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y });
  const onMove = (e) => {
    if (!drag) return;
    setPan({ x: drag.panX + (e.clientX - drag.x), y: drag.panY + (e.clientY - drag.y) });
  };
  const onUp = () => setDrag(null);
  const onWheel = (e) => {
    e.preventDefault();
    setZoom(z => Math.max(0.4, Math.min(2.0, z + (e.deltaY > 0 ? -0.08 : 0.08))));
  };

  return (
    <div className="stack-16">
      <TruthBar source={SOURCES.topology} hint="3 nodes inferred · 0 unavailable" />
      <div className="topo" onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}>
        <div className="topo-legend">
          <div className="h">Edges</div>
          <div className="topo-legend-row"><span className="sw" style={{background: 'var(--ink-3)'}} />request</div>
          <div className="topo-legend-row"><span className="sw" style={{background: 'color-mix(in oklab, var(--accent) 60%, var(--ink-2))'}} />context</div>
          <div className="topo-legend-row"><span className="sw" style={{background: 'var(--info)', backgroundImage: 'repeating-linear-gradient(90deg, var(--info) 0 3px, transparent 3px 6px)'}} />auth</div>
          <div className="topo-legend-row"><span className="sw" style={{background: 'var(--ok)'}} />model</div>
          <div className="topo-legend-row"><span className="sw" style={{background: 'var(--ink-4)', backgroundImage: 'repeating-linear-gradient(90deg, var(--ink-4) 0 2px, transparent 2px 4px)'}} />inferred</div>
        </div>
        <div className="topo-zoom">
          <button onClick={() => setZoom(z => Math.max(0.4, z - 0.1))}><I.zoomOut /></button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><I.fit /></button>
          <button onClick={() => setZoom(z => Math.min(2.0, z + 0.1))}><I.zoomIn /></button>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onMouseDown={onDown}>
          <defs>
            <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* edges */}
            {TOPO_EDGES.map(([a, b, kind], i) => {
              const na = nodeById[a], nb = nodeById[b];
              if (!na || !nb) return null;
              const ax = na.x + na.w / 2, ay = na.y + na.h / 2;
              const bx = nb.x + nb.w / 2, by = nb.y + nb.h / 2;
              const mx = (ax + bx) / 2, my = (ay + by) / 2;
              const dy = Math.abs(by - ay) * 0.3;
              const path = `M ${ax} ${ay} C ${ax} ${my + (by > ay ? -dy : dy)}, ${bx} ${my + (by > ay ? dy : -dy)}, ${bx} ${by}`;
              const isDim = hovered && hovered !== a && hovered !== b;
              return (
                <path key={i}
                      className={`edge ${kind}`}
                      d={path}
                      style={{opacity: isDim ? 0.15 : 0.75}}
                      markerEnd="url(#ah)" />
              );
            })}
            {/* nodes */}
            {TOPO_NODES.map(n => {
              const isDim = hovered && hovered !== n.id;
              const tColor = n.truth === 'live' ? 'var(--ok)' : n.truth === 'inferred' ? 'var(--info)' : n.truth === 'mixed' ? 'var(--warn)' : 'var(--ink-3)';
              return (
                <g key={n.id}
                   className={`node ${n.state}`}
                   transform={`translate(${n.x}, ${n.y})`}
                   onMouseEnter={() => setHovered(n.id)}
                   onMouseLeave={() => setHovered(null)}
                   style={{opacity: isDim ? 0.35 : 1, cursor: 'pointer'}}>
                  {n.shape === 'ellipse' ? (
                    <ellipse cx={n.w/2} cy={n.h/2} rx={n.w/2} ry={n.h/2} />
                  ) : (
                    <rect x={0} y={0} width={n.w} height={n.h} rx={6} />
                  )}
                  <text x={n.w / 2} y={n.h / 2 - 2} textAnchor="middle">{n.label}</text>
                  <text className="subtext" x={n.w / 2} y={n.h / 2 + 12} textAnchor="middle">{n.sub}</text>
                  <circle cx={n.w - 8} cy={8} r={3.5} fill={tColor} />
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

/* ==================== CONTAINERS ==================== */
function Containers({ onCreate, onOpenMultiLLM }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const filtered = CONTAINERS.filter(c => {
    if (filter === 'live-path' && !['context · routing','orchestration','gateway','model · LLM','proxy · LLM','context','auth','ingress'].includes(c.role)) return false;
    if (filter === 'warn' && c.health !== 'warn') return false;
    if (q && !`${c.name} ${c.image} ${c.host}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  return (
    <div className="stack-16">
      <TruthBar source={SOURCES.containers} hint={`${CONTAINERS.length} containers · ${CONTAINERS.filter(c => c.health === 'ok').length} OK`} />
      <div className="ct-controls">
        <input className="ct-input" placeholder="Search name, image, host…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="pill-row">
          {[['all','All'],['live-path','In live LLM path'],['warn','Warnings']].map(([k, l]) => (
            <button key={k} className={`pill${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <span style={{flex: 1}} />
        <button className="btn btn-primary btn-sm" onClick={onCreate}><span style={{fontSize: 14, lineHeight: 1}}>+</span> New container</button>
      </div>
      <div className="panel">
        <div className="panel-body flush">
          <table className="dtable">
            <thead>
              <tr>
                <th style={{width: 24}}></th>
                <th>Name</th>
                <th>Image</th>
                <th>Host · Port</th>
                <th>Role · in path</th>
                <th>Truth</th>
                <th style={{textAlign: 'right'}}>Health</th>
                <th style={{width: 1}}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.name}>
                  <td><span className={`s-dot ${c.health}`} /></td>
                  <td><span className="mono">{c.name}</span></td>
                  <td><span className="mono" style={{color: 'var(--ink-3)'}}>{c.image}</span></td>
                  <td className="mono">{c.host}<span style={{color: 'var(--ink-4)'}}> · </span>:{c.port}</td>
                  <td>{c.role}</td>
                  <td><Truth s={c.truth} /></td>
                  <td className="num">{c.health.toUpperCase()}</td>
                  <td>
                    <button
                      className="chip"
                      style={{cursor: 'pointer', whiteSpace: 'nowrap'}}
                      onClick={() => onOpenMultiLLM(c.name)}
                      title="Open multi-LLM workspace bound to this container">
                      Multi-LLM <I.external />
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan="8" style={{padding: '40px 14px', textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12}}>No containers match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ==================== CREATE CONTAINER WIZARD ==================== */
const WIZARD_STEPS = [
  { id: 'identity',  title: 'Identity',          sub: 'name · image · owner' },
  { id: 'runtime',   title: 'Runtime',           sub: 'ports · env · volumes · health' },
  { id: 'llm',       title: 'LLM connectivity',  sub: 'path · auth · context · truth' },
  { id: 'targets',   title: 'Registration',      sub: 'Gateway · Gitchain · both' },
  { id: 'review',    title: 'Review & dry-run',  sub: 'generated specs + validation' },
];

const STATE_FLOW = ['draft','validated','created','running','gateway-registered','gitchain-registered','healthy'];

const PATH_OPTS = ['direct','gateway','proxy'];
const AUTH_OPTS = ['service-account','jwt','oauth','none'];

function highlightYaml(s) {
  // escape HTML first so we can safely inject spans
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    // quoted strings first (won't match span attributes since none exist yet)
    .replace(/"([^"\n]*)"/g, '<span class="s">"$1"</span>')
    // numbers
    .replace(/\b(\d+)\b/g, '<span class="n">$1</span>')
    // comments
    .replace(/(^|\n)(\s*)(#[^\n]*)/g, '$1$2<span class="c">$3</span>')
    // keys last — the `[a-zA-Z_]...:` pattern can't match inside an already-inserted
    // <span class="..."> because the `class="..."` carries `="` not `:`.
    .replace(/(^|\n)([ \t]*-?[ \t]*)([a-zA-Z_][\w-]*)(:)/g, '$1$2<span class="k">$3</span>$4');
}
function highlightJson(s) {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/"([^"\n]+)"(\s*:)/g, '<span class="k">"$1"</span>$2')
    .replace(/:\s*"([^"\n]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/:\s*(\d+(?:\.\d+)?)/g, ': <span class="n">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="n">$1</span>');
}

function CreateContainerSheet({ open, onClose, onApplied }) {
  const [step, setStep] = useState(0);
  const [tab, setTab] = useState('compose');
  const [dryRun, setDryRun] = useState(true);
  const [applying, setApplying] = useState(null); // null | 'progress' | 'done'

  const [form, setForm] = useState({
    name: 'new-svc',
    image: 'ghcr.io/0711/new-svc:0.1.0',
    owner: 'platform',
    role: 'service',
    labels: '0711.fleet=true,0711.role=service',
    ports: [{ host: '7100', container: '7100' }],
    env: [{ k: 'LOG_LEVEL', v: 'info' }, { k: 'GATEWAY_URL', v: 'http://quantum-gateway:7080' }],
    volumes: [{ host: './data', container: '/data' }],
    network: 'gw-net',
    healthcheck: 'curl -fsS http://localhost:7100/healthz || exit 1',
    path: 'gateway',
    auth: 'service-account',
    contextSources: ['context-cache','gitchain'],
    truth: 'seeded',
    target: 'both',
  });

  // reset on open
  useEffect(() => {
    if (open) {
      setStep(0); setTab('compose'); setApplying(null);
    }
  }, [open]);

  // validation
  const conflicts = useMemo(() => {
    const issues = [];
    if (CONTAINERS.find(c => c.name === form.name)) issues.push({ sev: 'err', msg: `name "${form.name}" already in fleet` });
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(form.name)) issues.push({ sev: 'err', msg: 'name must be kebab-case (a-z, 0-9, -)' });
    const ports = form.ports.map(p => p.host).filter(Boolean);
    const usedPorts = new Set(CONTAINERS.map(c => String(c.port)));
    ports.forEach(p => { if (usedPorts.has(p)) issues.push({ sev: 'err', msg: `host port ${p} already bound on this host` }); });
    if (form.auth === 'none' && form.path !== 'proxy' && form.role !== 'observability') issues.push({ sev: 'warn', msg: 'auth=none on a non-proxy path crosses trust boundary' });
    if (!form.env.find(e => e.k === 'GATEWAY_URL') && form.path === 'gateway') issues.push({ sev: 'warn', msg: 'GATEWAY_URL env recommended when path=gateway' });
    if (form.target.includes('gitchain') && !form.labels.includes('0711.project=')) issues.push({ sev: 'warn', msg: 'gitchain registration prefers a 0711.project= label' });
    return issues;
  }, [form]);

  const hasErrors = conflicts.some(c => c.sev === 'err');

  const compose = useMemo(() => {
    const envLines = form.env.filter(e => e.k).map(e => `      ${e.k}: "${e.v}"`).join('\n');
    const portLines = form.ports.filter(p => p.host).map(p => `      - "${p.host}:${p.container}"`).join('\n');
    const volLines = form.volumes.filter(v => v.host).map(v => `      - "${v.host}:${v.container}"`).join('\n');
    return `# generated · ${form.name} · dry-run=${dryRun}
version: "3.9"
services:
  ${form.name}:
    image: ${form.image}
    container_name: ${form.name}
    restart: unless-stopped
    networks:
      - ${form.network}
    ports:
${portLines || '      []'}
    environment:
${envLines || '      []'}
    volumes:
${volLines || '      []'}
    healthcheck:
      test: ["CMD-SHELL", "${form.healthcheck}"]
      interval: 15s
      timeout: 4s
      retries: 3
    labels:
${form.labels.split(',').filter(Boolean).map(l => `      - "${l.trim()}"`).join('\n') || '      []'}

networks:
  ${form.network}:
    external: true`;
  }, [form, dryRun]);

  const gatewayPayload = useMemo(() => JSON.stringify({
    operation: dryRun ? 'register.preview' : 'register',
    container_id: form.name,
    fleet_member_id: `fleet/${form.name}`,
    runtime_role: form.role,
    model_connectivity: {
      path: form.path,
      auth_mode: form.auth,
      via: form.path === 'proxy' ? 'mistral-router' : form.path === 'gateway' ? 'quantum-gateway' : null,
    },
    context_sources: form.contextSources,
    auth_mode: form.auth,
    health_state: 'unknown',
    truth_label: form.truth,
    metadata: {
      image: form.image,
      owner: form.owner,
      labels: form.labels.split(',').map(s => s.trim()).filter(Boolean),
      ports: form.ports.filter(p => p.host).map(p => Number(p.host)),
    },
  }, null, 2), [form, dryRun]);

  const gitchainPayload = useMemo(() => JSON.stringify({
    operation: dryRun ? 'commit.preview' : 'commit',
    project: 'fleet/0711',
    container_id: form.name,
    workstream: 'fleet-bringup',
    ownership: form.owner,
    container_to_agent_linkage: form.role === 'agents' ? ['agent-orchestrator'] : [],
    execution_metadata: {
      image: form.image,
      ports: form.ports.filter(p => p.host).map(p => Number(p.host)),
      created_via: 'quantum-gateway-ui/2.1.0-rc3',
      dry_run: dryRun,
    },
    runtime_evidence: 'pending — populated after first health probe',
  }, null, 2), [form, dryRun]);

  const apply = () => {
    if (hasErrors) return;
    setApplying('progress');
    setTimeout(() => setApplying('done'), 1200);
  };

  const update = (patch) => setForm(f => ({ ...f, ...patch }));

  const next = () => setStep(s => Math.min(s + 1, WIZARD_STEPS.length - 1));
  const back = () => setStep(s => Math.max(s - 1, 0));

  return (
    <React.Fragment>
      <div className={`sheet-overlay${open ? ' open' : ''}`} onClick={onClose} />
      <div className={`sheet${open ? ' open' : ''}`} role="dialog" aria-modal="true">
        <div className="sheet-head">
          <div className="sheet-head-l">
            <span className="crumb">CONTAINERS / NEW</span>
            <h2>Create container · register on the fleet</h2>
          </div>
          <span className="spacer" />
          <StateTrack stage={applying === 'done' ? (dryRun ? 'validated' : 'gateway-registered') : applying === 'progress' ? 'created' : (hasErrors ? 'draft' : 'validated')} />
          <button className="sheet-x" onClick={onClose} aria-label="Close"><I.x /></button>
        </div>

        <aside className="sheet-steps">
          {WIZARD_STEPS.map((s, i) => (
            <div key={s.id} className={`sheet-step${i === step ? ' active' : ''}${i < step ? ' done' : ''}`} onClick={() => setStep(i)}>
              <div className="num">{i < step ? <I.check /> : i + 1}</div>
              <div>
                <div className="title">{s.title}</div>
                <div className="sub">{s.sub}</div>
              </div>
            </div>
          ))}
          <div style={{marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--line-2)'}}>
            <div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-4)', padding: '8px 12px 4px'}}>State machine</div>
            <div style={{padding: '0 12px 8px', display: 'flex', flexWrap: 'wrap', gap: 4}}>
              {STATE_FLOW.map(s => <span key={s} className="chip dim" style={{fontSize: 10}}>{s}</span>)}
            </div>
          </div>
        </aside>

        <div className="sheet-body">
          {applying === 'progress' && (
            <ApplyingView dryRun={dryRun} target={form.target} />
          )}
          {applying === 'done' && (
            <AppliedView form={form} dryRun={dryRun} onDone={() => { onApplied && onApplied(form); onClose(); }} />
          )}
          {!applying && step === 0 && (
            <IdentityStep form={form} update={update} conflicts={conflicts.filter(c => c.msg.includes('name'))} />
          )}
          {!applying && step === 1 && (
            <RuntimeStep form={form} update={update} conflicts={conflicts.filter(c => c.msg.includes('port'))} />
          )}
          {!applying && step === 2 && (
            <LLMStep form={form} update={update} conflicts={conflicts.filter(c => c.msg.includes('auth') || c.msg.includes('GATEWAY'))} />
          )}
          {!applying && step === 3 && (
            <RegistrationStep form={form} update={update} conflicts={conflicts.filter(c => c.msg.includes('label'))} />
          )}
          {!applying && step === 4 && (
            <ReviewStep form={form} conflicts={conflicts} />
          )}
        </div>

        <aside className="sheet-preview">
          <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
            <div className="preview-tabs">
              <button className={tab === 'compose' ? 'on' : ''} onClick={() => setTab('compose')}>compose.yaml</button>
              <button className={tab === 'gateway' ? 'on' : ''} onClick={() => setTab('gateway')}>gateway</button>
              <button className={tab === 'gitchain' ? 'on' : ''} onClick={() => setTab('gitchain')}>gitchain</button>
            </div>
            <span style={{flex: 1}} />
            <span className="chip dim" style={{fontSize: 10}}>{dryRun ? 'DRY-RUN' : 'APPLY'}</span>
          </div>
          <div className="preview-code"
               dangerouslySetInnerHTML={{__html:
                 tab === 'compose' ? highlightYaml(compose) :
                 tab === 'gateway' ? highlightJson(gatewayPayload) :
                 highlightJson(gitchainPayload)
               }} />
          <div className="preview-validation">
            <div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 2}}>Validation</div>
            {conflicts.length === 0 ? (
              <div className="v ok"><span className="ic"><I.check /></span> all checks pass</div>
            ) : conflicts.map((c, i) => (
              <div key={i} className={`v ${c.sev}`}>
                <span className="ic">{c.sev === 'err' ? <I.x /> : <I.alert />}</span>
                {c.msg}
              </div>
            ))}
          </div>
        </aside>

        <div className="sheet-foot">
          <label className="sheet-foot-dryrun">
            <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
            DRY-RUN
          </label>
          <span style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-3)'}}>
            Step {step + 1} / {WIZARD_STEPS.length}
          </span>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-ghost btn-sm" onClick={back} disabled={step === 0}>Back</button>
          {step < WIZARD_STEPS.length - 1 ? (
            <button className="btn btn-primary btn-sm" onClick={next}>Next →</button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={apply} disabled={hasErrors}>{dryRun ? 'Run preview' : 'Apply & register'}</button>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

function StateTrack({ stage }) {
  const idx = STATE_FLOW.indexOf(stage);
  const show = STATE_FLOW.slice(0, 5);
  return (
    <div className="state-track">
      {show.map((s, i) => (
        <React.Fragment key={s}>
          {i > 0 && <span className="state-track-arrow">›</span>}
          <span className={`seg ${i < idx ? 'done' : i === idx ? 'now' : ''}`}>{i < idx && <I.check />}{s}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function IdentityStep({ form, update, conflicts }) {
  return (
    <React.Fragment>
      <div>
        <h3>Identity</h3>
        <p className="body-lede">Name, image, owner, runtime role. These are the values STURM uses across logs, registries, and alerts — pick carefully.</p>
      </div>
      <div className="field-grid">
        <div className="form-row">
          <label>Name <span style={{color: 'var(--err)'}}>*</span></label>
          <input className="mono" value={form.name} onChange={e => update({name: e.target.value})} />
          {conflicts.map((c, i) => <span key={i} className={`hint ${c.sev}`}>{c.msg}</span>)}
        </div>
        <div className="form-row">
          <label>Image <span style={{color: 'var(--err)'}}>*</span></label>
          <input className="mono" value={form.image} onChange={e => update({image: e.target.value})} />
          <span className="hint">Pinned tag recommended — :latest blocks registration in prod</span>
        </div>
        <div className="form-row">
          <label>Owner / team</label>
          <input value={form.owner} onChange={e => update({owner: e.target.value})} />
        </div>
        <div className="form-row">
          <label>Runtime role</label>
          <select value={form.role} onChange={e => update({role: e.target.value})}>
            <option value="service">service</option>
            <option value="agents">agent-orchestrator</option>
            <option value="model · LLM">model · LLM bridge</option>
            <option value="proxy · LLM">proxy · LLM</option>
            <option value="context">context source</option>
            <option value="auth">auth broker</option>
            <option value="observability">observability</option>
            <option value="ingress">ingress</option>
          </select>
        </div>
      </div>
      <div className="form-row">
        <label>Labels (comma-separated)</label>
        <input className="mono" value={form.labels} onChange={e => update({labels: e.target.value})} />
        <span className="hint">Recommended: <code>0711.fleet=true</code>, <code>0711.project=&lt;id&gt;</code>, <code>0711.role=&lt;role&gt;</code></span>
      </div>
    </React.Fragment>
  );
}

function RuntimeStep({ form, update, conflicts }) {
  const setPort = (i, k, v) => update({ ports: form.ports.map((p, j) => j === i ? { ...p, [k]: v } : p) });
  const addPort = () => update({ ports: [...form.ports, { host: '', container: '' }] });
  const rmPort = (i) => update({ ports: form.ports.filter((_, j) => j !== i) });

  const setEnv = (i, k, v) => update({ env: form.env.map((p, j) => j === i ? { ...p, [k]: v } : p) });
  const addEnv = () => update({ env: [...form.env, { k: '', v: '' }] });
  const rmEnv = (i) => update({ env: form.env.filter((_, j) => j !== i) });

  const setVol = (i, k, v) => update({ volumes: form.volumes.map((p, j) => j === i ? { ...p, [k]: v } : p) });
  const addVol = () => update({ volumes: [...form.volumes, { host: '', container: '' }] });
  const rmVol = (i) => update({ volumes: form.volumes.filter((_, j) => j !== i) });

  return (
    <React.Fragment>
      <div>
        <h3>Runtime</h3>
        <p className="body-lede">Ports, env vars, volumes, network, and health-check. These map directly to the generated <code>compose.yaml</code> on the right.</p>
      </div>

      <div className="form-row">
        <label>Ports · host:container</label>
        <div className="kv-list">
          {form.ports.map((p, i) => (
            <div className="kv-row" key={i}>
              <input value={p.host} onChange={e => setPort(i, 'host', e.target.value)} placeholder="host port (e.g. 7100)" />
              <input value={p.container} onChange={e => setPort(i, 'container', e.target.value)} placeholder="container port" />
              <button className="rm" onClick={() => rmPort(i)} aria-label="Remove"><I.x /></button>
            </div>
          ))}
          <button className="chip" style={{alignSelf: 'flex-start', marginTop: 4, cursor: 'pointer'}} onClick={addPort}>+ port</button>
        </div>
        {conflicts.map((c, i) => <span key={i} className={`hint ${c.sev}`}>{c.msg}</span>)}
      </div>

      <div className="form-row">
        <label>Environment</label>
        <div className="kv-list">
          {form.env.map((e, i) => (
            <div className="kv-row" key={i}>
              <input value={e.k} onChange={ev => setEnv(i, 'k', ev.target.value)} placeholder="KEY" />
              <input value={e.v} onChange={ev => setEnv(i, 'v', ev.target.value)} placeholder="value" />
              <button className="rm" onClick={() => rmEnv(i)} aria-label="Remove"><I.x /></button>
            </div>
          ))}
          <button className="chip" style={{alignSelf: 'flex-start', marginTop: 4, cursor: 'pointer'}} onClick={addEnv}>+ env</button>
        </div>
      </div>

      <div className="form-row">
        <label>Volumes · host:container</label>
        <div className="kv-list">
          {form.volumes.map((v, i) => (
            <div className="kv-row" key={i}>
              <input value={v.host} onChange={e => setVol(i, 'host', e.target.value)} placeholder="./data" />
              <input value={v.container} onChange={e => setVol(i, 'container', e.target.value)} placeholder="/data" />
              <button className="rm" onClick={() => rmVol(i)} aria-label="Remove"><I.x /></button>
            </div>
          ))}
          <button className="chip" style={{alignSelf: 'flex-start', marginTop: 4, cursor: 'pointer'}} onClick={addVol}>+ volume</button>
        </div>
      </div>

      <div className="field-grid">
        <div className="form-row">
          <label>Network</label>
          <select value={form.network} onChange={e => update({network: e.target.value})}>
            <option>gw-net</option>
            <option>gw-edge-net</option>
            <option>internal</option>
          </select>
        </div>
        <div className="form-row">
          <label>Healthcheck</label>
          <input className="mono" value={form.healthcheck} onChange={e => update({healthcheck: e.target.value})} />
        </div>
      </div>
    </React.Fragment>
  );
}

function LLMStep({ form, update, conflicts }) {
  const CTX_OPTS = ['context-cache','gitchain','doku-svc','model-registry'];
  const toggleCtx = (k) => {
    const has = form.contextSources.includes(k);
    update({ contextSources: has ? form.contextSources.filter(x => x !== k) : [...form.contextSources, k] });
  };
  return (
    <React.Fragment>
      <div>
        <h3>LLM connectivity</h3>
        <p className="body-lede">How does this container talk to models, with what auth, and how do we label the truth of that wiring at registration time?</p>
      </div>
      <div className="field-grid">
        <div className="form-row">
          <label>Path</label>
          <div className="seg" role="radiogroup">
            {PATH_OPTS.map(p => (
              <button key={p} className={form.path === p ? 'on' : ''} onClick={() => update({path: p})}>{p}</button>
            ))}
          </div>
          <span className="hint">{form.path === 'direct' ? 'service calls model APIs directly · widest blast radius' : form.path === 'gateway' ? 'routed through quantum-gateway · default · auditable' : 'routed through mistral-router · for non-Anthropic models'}</span>
        </div>
        <div className="form-row">
          <label>Auth mode</label>
          <div className="seg" role="radiogroup">
            {AUTH_OPTS.map(p => (
              <button key={p} className={form.auth === p ? 'on' : ''} onClick={() => update({auth: p})}>{p}</button>
            ))}
          </div>
          {conflicts.map((c, i) => <span key={i} className={`hint ${c.sev}`}>{c.msg}</span>)}
        </div>
      </div>
      <div className="form-row">
        <label>Context sources</label>
        <div className="pill-row">
          {CTX_OPTS.map(k => (
            <button key={k} className={`pill${form.contextSources.includes(k) ? ' active' : ''}`} onClick={() => toggleCtx(k)}>
              <span>{k}</span>
              {form.contextSources.includes(k) && <I.check />}
            </button>
          ))}
        </div>
        <span className="hint">Which context this container will be allowed to read at runtime. Recorded on the Gateway side as part of the trust boundary.</span>
      </div>
      <div className="form-row">
        <label>Initial truth label</label>
        <div className="seg" role="radiogroup">
          {['seeded','mixed','inferred'].map(t => (
            <button key={t} className={form.truth === t ? 'on' : ''} onClick={() => update({truth: t})}>{t}</button>
          ))}
        </div>
        <span className="hint">No new container starts as <strong>live</strong>. Promotion happens after the first verified probe.</span>
      </div>
    </React.Fragment>
  );
}

function RegistrationStep({ form, update, conflicts }) {
  return (
    <React.Fragment>
      <div>
        <h3>Registration targets</h3>
        <p className="body-lede">Where should we register this container? Pick one or both. STURM will not show "registered" until each backend confirms.</p>
      </div>
      <div className="field-grid three">
        {[
          ['gateway','Gateway only','registers as a fleet member · gets a runtime probe'],
          ['gitchain','Gitchain only','commits container metadata to the chain · no live runtime probe'],
          ['both','Both (recommended)','register on Gateway and write the gitchain commit · 2-step'],
        ].map(([k, label, sub]) => (
          <button key={k}
            onClick={() => update({target: k})}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              background: form.target === k ? 'color-mix(in oklab, var(--accent) 10%, var(--bg))' : 'var(--bg)',
              border: '1px solid ' + (form.target === k ? 'color-mix(in oklab, var(--accent) 45%, var(--line))' : 'var(--line-2)'),
              borderRadius: 8,
              cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
            <span style={{fontSize: 13, fontWeight: 500, color: 'var(--ink)'}}>{label}</span>
            <span style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.45}}>{sub}</span>
          </button>
        ))}
      </div>
      {conflicts.map((c, i) => <div key={i} className={`hint ${c.sev}`} style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5}}>{c.msg}</div>)}
      <div style={{padding: '14px 18px', background: 'var(--bg-2)', border: '1px dashed var(--line-2)', borderRadius: 'var(--radius)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.6}}>
        <strong style={{color: 'var(--ink-2)'}}>Note:</strong> Gitchain commits are durable — we don't have a "delete". An unregister mid-flight will write a counter-commit, not a rewrite.
      </div>
    </React.Fragment>
  );
}

function ReviewStep({ form, conflicts }) {
  return (
    <React.Fragment>
      <div>
        <h3>Review</h3>
        <p className="body-lede">Final summary. The right pane shows the exact specs that will be applied. <strong>DRY-RUN</strong> sends a preview to both backends without committing.</p>
      </div>
      <div className="row-2" style={{gap: 14}}>
        <div className="panel" style={{background: 'var(--bg)'}}>
          <div className="panel-head"><h2 className="panel-h">Identity</h2></div>
          <div className="panel-body stack-8">
            <div className="kv"><strong>name</strong> <code>{form.name}</code></div>
            <div className="kv"><strong>image</strong> <code>{form.image}</code></div>
            <div className="kv"><strong>owner</strong> {form.owner}</div>
            <div className="kv"><strong>role</strong> {form.role}</div>
          </div>
        </div>
        <div className="panel" style={{background: 'var(--bg)'}}>
          <div className="panel-head"><h2 className="panel-h">Runtime</h2></div>
          <div className="panel-body stack-8">
            <div className="kv"><strong>ports</strong> <code>{form.ports.filter(p=>p.host).map(p=>`${p.host}:${p.container}`).join(', ') || '—'}</code></div>
            <div className="kv"><strong>env</strong> {form.env.filter(e=>e.k).length} entries</div>
            <div className="kv"><strong>volumes</strong> {form.volumes.filter(v=>v.host).length}</div>
            <div className="kv"><strong>network</strong> <code>{form.network}</code></div>
          </div>
        </div>
        <div className="panel" style={{background: 'var(--bg)'}}>
          <div className="panel-head"><h2 className="panel-h">LLM connectivity</h2></div>
          <div className="panel-body stack-8">
            <div className="kv"><strong>path</strong> <code>{form.path}</code></div>
            <div className="kv"><strong>auth</strong> <code>{form.auth}</code></div>
            <div className="kv"><strong>context</strong> {form.contextSources.join(', ') || '—'}</div>
            <div className="kv"><strong>truth</strong> <Truth s={form.truth} /></div>
          </div>
        </div>
        <div className="panel" style={{background: 'var(--bg)'}}>
          <div className="panel-head"><h2 className="panel-h">Registration</h2></div>
          <div className="panel-body stack-8">
            <div className="kv"><strong>target</strong> <code>{form.target}</code></div>
            <div className="kv"><strong>validation</strong> {conflicts.length === 0 ? <span style={{color: 'var(--ok)'}}>all checks pass</span> : <span style={{color: 'var(--warn)'}}>{conflicts.length} issue{conflicts.length === 1 ? '' : 's'}</span>}</div>
          </div>
        </div>
      </div>
      <style>{`.kv { display: flex; gap: 10px; font-size: 12.5px; color: var(--ink-2); }
.kv strong { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); width: 80px; flex-shrink: 0; padding-top: 1px; font-weight: 500; }
.kv code { font-size: 11.5px; }`}</style>
    </React.Fragment>
  );
}

function ApplyingView({ dryRun, target }) {
  const steps = useMemo(() => {
    const arr = [];
    if (!dryRun) arr.push({ k: 'pull image', ok: true });
    arr.push({ k: 'validate spec', ok: true });
    if (!dryRun) arr.push({ k: 'create container', ok: true });
    if (target !== 'gitchain') arr.push({ k: dryRun ? 'gateway preview' : 'register on gateway', ok: true });
    if (target !== 'gateway') arr.push({ k: dryRun ? 'gitchain preview' : 'commit to gitchain', ok: true });
    if (!dryRun) arr.push({ k: 'first health probe', ok: false, pending: true });
    return arr;
  }, [dryRun, target]);

  return (
    <React.Fragment>
      <div>
        <h3>{dryRun ? 'Running preview' : 'Applying…'}</h3>
        <p className="body-lede">{dryRun ? 'No changes will be committed. Backends respond with what they would have done.' : 'Live registration. Each step is awaited before the next is attempted.'}</p>
      </div>
      <div className="panel" style={{background: 'var(--bg)'}}>
        <div className="panel-body flush">
          {steps.map((s, i) => (
            <div className="signal-row ok" key={i} style={{padding: '12px 16px'}}>
              <div className="icon-wrap">{s.pending ? <span className="s-dot ok" /> : <I.check />}</div>
              <div>
                <div className="name">{s.k}</div>
                <div className="desc">{s.pending ? 'awaiting first probe response · ~15s' : dryRun ? 'preview returned · no commit' : 'committed'}</div>
              </div>
              <span className="val">{s.pending ? 'PENDING' : 'OK'}</span>
            </div>
          ))}
        </div>
      </div>
    </React.Fragment>
  );
}

function AppliedView({ form, dryRun, onDone }) {
  return (
    <React.Fragment>
      <div>
        <h3>{dryRun ? 'Preview returned' : 'Container registered'}</h3>
        <p className="body-lede">{dryRun
          ? 'Both backends accepted the preview. Run again with DRY-RUN off to commit.'
          : 'Container created and registered on the selected targets. Health is "unknown" until the first probe lands — STURM will not promote it to LIVE on faith.'}
        </p>
      </div>
      <StateTrack stage={dryRun ? 'validated' : 'gateway-registered'} />
      <div className="panel" style={{background: 'var(--bg)'}}>
        <div className="panel-head"><h2 className="panel-h">Evidence</h2><span className="panel-spacer" /><Truth s={dryRun ? 'inferred' : 'live'} /></div>
        <div className="panel-body flush">
          <div className="evidence-row">
            <span className="what">gateway / register · 201</span>
            <span className="chip ok">accepted</span>
            <span className="when">just now</span>
          </div>
          <div className="evidence-row">
            <span className="what">gitchain / commit · seq 41285</span>
            <span className="chip ok">sealed</span>
            <span className="when">just now</span>
          </div>
          <div className="evidence-row">
            <span className="what">first health probe</span>
            <span className="chip">pending</span>
            <span className="when">∅ probes</span>
          </div>
          <div className="evidence-row">
            <span className="what">truth label</span>
            <Truth s={form.truth} />
            <span className="when">initial</span>
          </div>
        </div>
      </div>
      <div style={{display: 'flex', gap: 10}}>
        <button className="btn btn-ghost btn-sm">Rollback / unregister</button>
        <button className="btn btn-ghost btn-sm">View in fleet</button>
        <span style={{flex: 1}} />
        <button className="btn btn-primary btn-sm" onClick={onDone}>Done</button>
      </div>
    </React.Fragment>
  );
}
function FleetTopology() {
  return (
    <div className="stack-16">
      <TruthBar source={SOURCES.topology} hint={`${FLEET_OBSERVABLE.length} observable · ${FLEET_UNOBSERVABLE.length} inferred / partial`} />
      <div className="row-2">
        <div className="zone observable">
          <div className="zone-head">
            <span className="s-dot ok" />
            <span className="zone-h">Observable from gateway runtime</span>
            <span className="zone-sub">{FLEET_OBSERVABLE.length} members</span>
          </div>
          {FLEET_OBSERVABLE.map(m => (
            <div className="fleet-member" key={m.name}>
              <span className={`s-dot ${m.health}`} />
              <div>
                <div className="fleet-member-name">{m.name}</div>
                <div className="fleet-member-meta">{m.meta}</div>
              </div>
              <span className="id-pill">{m.health.toUpperCase()}</span>
              <Truth s={m.truth} />
              <span style={{color: 'var(--ink-4)'}}><I.external /></span>
            </div>
          ))}
        </div>
        <div className="zone unobservable">
          <div className="zone-head">
            <span className="s-dot idle" />
            <span className="zone-h" style={{color: 'var(--ink-3)'}}>Not observable from gateway runtime</span>
            <span className="zone-sub">{FLEET_UNOBSERVABLE.length} members</span>
          </div>
          {FLEET_UNOBSERVABLE.map(m => (
            <div key={m.name} style={{display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8}}>
              <div className="fleet-member">
                <span className="s-dot idle" />
                <div>
                  <div className="fleet-member-name" style={{color: 'var(--ink-2)'}}>{m.name}</div>
                  <div className="fleet-member-meta">{m.meta}</div>
                </div>
                <span className="id-pill">—</span>
                <Truth s={m.truth} />
                <span style={{color: 'var(--ink-4)'}}><I.external /></span>
              </div>
              <div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-3)', padding: '0 12px 6px', lineHeight: 1.5}}>{m.reason}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{padding: '14px 18px', background: 'var(--bg-2)', border: '1px dashed var(--line-2)', borderRadius: 'var(--radius)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.6}}>
        <strong style={{color: 'var(--ink-2)'}}>Note:</strong> The gateway only sees what it can probe directly. Members in the right zone may be fully healthy — but their status is derived from upstream or out-of-band signals. We surface this, rather than promote inferred data to "live".
      </div>
    </div>
  );
}

/* ==================== RUNTIME ==================== */
function Runtime() {
  return (
    <div className="stack-16">
      <div className="row-3">
        <TruthBar source={SOURCES.health} hint="gateway loop · 6d uptime" />
        <TruthBar source={SOURCES.chain} hint="gitchain · block 41284" />
        <TruthBar source={SOURCES.doku} hint="14 pending tickets" />
      </div>
      <div className="row-31">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-h">Runtime signals</h2>
            <span className="panel-sub">{RUNTIME_SIGNALS.length} signals</span>
            <span className="panel-spacer" />
            <Truth s="live" />
          </div>
          <div className="panel-body flush">
            {RUNTIME_SIGNALS.map((s, i) => (
              <div className={`signal-row ${s.sev}`} key={i}>
                <div className="icon-wrap">
                  {s.sev === 'ok' ? <I.check /> : s.sev === 'warn' ? <I.alert /> : <I.x />}
                </div>
                <div>
                  <div className="name">{s.name}</div>
                  <div className="desc">{s.desc}</div>
                </div>
                <span className="val">{s.val}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="stack-12">
          <div className="panel">
            <div className="panel-head"><h2 className="panel-h">Chain checkpoints</h2><span className="panel-spacer" /><Truth s="live" /></div>
            <div className="panel-body stack-8">
              <div className="stat">
                <span className="stat-label">Current block</span>
                <span className="stat-value">41284</span>
                <span className="stat-delta up">+ 17 since 5 min ago</span>
              </div>
              <div style={{borderTop: '1px dashed var(--line-2)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--ink-3)'}}>
                <div style={{display: 'flex', justifyContent: 'space-between'}}><span>head commit</span><span style={{color: 'var(--ink-2)'}}>0x9f3a…b1</span></div>
                <div style={{display: 'flex', justifyContent: 'space-between'}}><span>last seal</span><span style={{color: 'var(--ink-2)'}}>3 s ago</span></div>
                <div style={{display: 'flex', justifyContent: 'space-between'}}><span>avg interval</span><span style={{color: 'var(--ink-2)'}}>4.2 s</span></div>
                <div style={{display: 'flex', justifyContent: 'space-between'}}><span>fork count (24h)</span><span style={{color: 'var(--ink-2)'}}>0</span></div>
              </div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h2 className="panel-h">Gateway warnings</h2><span className="panel-spacer" /><Truth s="live" /></div>
            <div className="panel-body stack-8" style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.6}}>
              <div><span className="chip warn">P95</span> mistral-router exceeded 800ms threshold</div>
              <div><span className="chip warn">DEPTH</span> doku queue at 14 (target ≤ 10)</div>
              <div><span className="chip err">OAUTH</span> Gemini connector refresh failing for 26h</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==================== MULTI-LLM WORKSPACE ==================== */
const MLLM_MODES = [
  { id: 'free',     label: 'Free',       desc: 'no orchestrator · models speak when they have something' },
  { id: 'debate',   label: 'Debate',     desc: 'planner ↔ critic, until convergence or impasse' },
  { id: 'consensus',label: 'Consensus',  desc: 'each model answers, moderator merges' },
  { id: 'reviewer', label: 'Reviewer',   desc: 'one author + one or more critics review the output' },
  { id: 'baton',    label: 'Baton-pass', desc: 'round-robin: each model extends the previous turn' },
];

const ROLES = ['planner','researcher','coder','critic','verifier','summarizer','operator-assistant'];

const PARTICIPANTS_INIT = [
  { id: 'opus',   model: 'Opus 4.7',    vendor: 'Anthropic',   role: 'planner',     moderator: true,
    path: 'klavis · direct', auth: 'service-account', truth: 'live',
    p50: 214, p95: 412, cost: '$3.50/1M', tokens: '12.3k / 200k' },
  { id: 'sonnet', model: 'Sonnet 4.5',  vendor: 'Anthropic',   role: 'critic',      moderator: false,
    path: 'klavis · direct', auth: 'service-account', truth: 'live',
    p50: 110, p95: 240, cost: '$0.80/1M', tokens: '8.1k / 200k' },
  { id: 'gpt5',   model: 'GPT-5',       vendor: 'OpenAI',      role: 'researcher',  moderator: false,
    path: 'mistral-router · proxy', auth: 'service-account', truth: 'mixed',
    p50: 480, p95: 1240, cost: 'pricing TBC', tokens: '3.4k / 128k' },
  { id: 'gemma',  model: 'gemma-4',     vendor: 'local · vLLM', role: 'verifier',   moderator: false,
    path: 'direct · local', auth: 'none', truth: 'live',
    p50: 95, p95: 180, cost: 'local · ∅', tokens: '2.8k / 32k' },
];

const TURNS_INIT = [
  { id: 1, by: 'op',     role: 'operator',
    body: <React.Fragment>
      <p>Topic: <code>klavis · degraded route to GPT-5</code> — yesterday p95 spiked to 1.8s for 12 minutes. Need root cause + proposed fix.</p>
      <p>Container: <code>mistral-router</code>. Logs and runtime state attached.</p>
    </React.Fragment>
  },
  { id: 2, by: 'opus',   role: 'planner',
    body: <React.Fragment>
      <p>Three plausible causes from the runtime panel:</p>
      <p>1. Connection-pool exhaustion at the router (mistral-router has <code>MAX_POOL=8</code>, p95 spike coincides with concurrent fan-out)</p>
      <p>2. Upstream rate-limit from OpenAI (would show 429s in logs)</p>
      <p>3. Local DNS resolution stall (less likely · cache shows hits)</p>
      <p>I'll have <strong>gpt-5</strong> verify (2) by sampling the log window and <strong>gemma-4</strong> verify (1) by replaying with pool=24.</p>
    </React.Fragment>
  },
  { id: 3, by: 'gpt5',   role: 'researcher',
    body: <React.Fragment>
      <p>Log window <code>2026-05-20 14:08–14:20 UTC</code>: 0 × 429, 0 × 5xx, 47 × successful 200. So the rate-limit hypothesis (2) is <strong>not supported by evidence</strong>.</p>
      <div className="quote-ref">… HTTP 200 in 1841ms … HTTP 200 in 1612ms … (47 entries, all 200)</div>
    </React.Fragment>
  },
  { id: 4, by: 'gemma',  role: 'verifier',
    body: <React.Fragment>
      <p>Replay with <code>MAX_POOL=24</code> on the same concurrency profile: <strong>p95 dropped from 1240ms → 320ms</strong>. Hypothesis (1) confirmed.</p>
      <p>Cost of fix: 16 additional file descriptors per container. Within budget.</p>
    </React.Fragment>
  },
  { id: 5, by: 'sonnet', role: 'critic',
    body: <React.Fragment>
      <p>Two caveats before we commit:</p>
      <p>· Replay used yesterday's traffic shape; today's pattern may differ. Recommend bumping pool to 16 first, observe 24h, then 24 if needed.</p>
      <p>· Pool=24 will push memory ~+40MB per replica. mistral-router is currently at 78% of its memory limit — would need a limit bump too.</p>
    </React.Fragment>
  },
];

function MultiLLMWorkspace({ initialContainer }) {
  const [containerId, setContainerId] = useState(initialContainer || 'mistral-router');
  const container = CONTAINERS.find(c => c.name === containerId) || CONTAINERS[0];
  const [mode, setMode] = useState('debate');
  const [participants, setParticipants] = useState(PARTICIPANTS_INIT);
  const [turns, setTurns] = useState(TURNS_INIT);
  const [input, setInput] = useState('');
  const threadRef = useRef(null);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [turns]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setTurns(t => [...t, { id: Date.now(), by: 'op', role: 'operator', body: <p>{text}</p> }]);
    setInput('');
  };

  const setRole = (id, role) => setParticipants(p => p.map(x => x.id === id ? { ...x, role } : x));
  const setModerator = (id) => setParticipants(p => p.map(x => ({ ...x, moderator: x.id === id })));
  const removeOne = (id) => setParticipants(p => p.filter(x => x.id !== id));

  const agreement = 'pool exhaustion is the root cause · all 4 models concur';
  const divergence = 'rollout speed: Sonnet wants staged (16 → 24), others propose direct to 24';
  const verify = 'staged rollout + memory limit bump · 24h observation window';

  return (
    <div className="stack-16">
      <div className="mllm">
        {/* CONTEXT */}
        <aside className="mllm-pane">
          <div className="mllm-pane-head">
            <span className="mllm-pane-h">Container context</span>
            <span style={{flex: 1}} />
            <Truth s="live" />
          </div>
          <div className="mllm-pane-body">
            <div className="ctx-tile">
              <div className="ctx-tile-h">
                <span className={`s-dot ${container.health}`} />
                <span style={{fontFamily: 'JetBrains Mono, monospace'}}>{container.name}</span>
              </div>
              <div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.55}}>
                {container.image}<br/>
                {container.host} · :{container.port}<br/>
                {container.role}
              </div>
            </div>

            <div className="ctx-block">
              <span className="label">Switch container</span>
              <select
                value={containerId}
                onChange={e => setContainerId(e.target.value)}
                style={{padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--line-2)', borderRadius: 6, color: 'var(--ink)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12}}>
                {CONTAINERS.map(c => <option key={c.name}>{c.name}</option>)}
              </select>
            </div>

            <div className="ctx-block">
              <span className="label">Runtime state</span>
              <span className="val">{container.health.toUpperCase()} · last probe 34s ago</span>
            </div>

            <div className="ctx-block">
              <span className="label">Context sources</span>
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2}}>
                <span className="chip">gitchain</span>
                <span className="chip">context-cache</span>
                <span className="chip">runtime-logs</span>
              </div>
            </div>

            <div className="ctx-block">
              <span className="label">Trust boundary</span>
              <span className="val">scope: <code>fleet/internal</code></span>
              <span style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-3)'}}>auth: service-account · header</span>
            </div>

            <div className="ctx-block">
              <span className="label">Linked work item</span>
              <span className="val" style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 12}}>gitchain://fleet/0711/docket/2026-05-24/route-degrade</span>
            </div>

            <div className="ctx-block">
              <span className="label">Linked gateway registration</span>
              <span className="val" style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 12}}>fleet/mistral-router · v3</span>
            </div>

            <div style={{padding: '10px 12px', background: 'var(--bg)', border: '1px dashed var(--line-2)', borderRadius: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.6}}>
              Every message in this thread can read the linked logs and runtime state. Models cannot reach beyond <code>fleet/internal</code> without an explicit operator escalation.
            </div>
          </div>
        </aside>

        {/* THREAD */}
        <section className="mllm-pane" style={{borderRight: '1px solid var(--line-2)'}}>
          <div className="mllm-mode-bar">
            <span className="mllm-pane-h">Topic · {mode}</span>
            <div className="seg" style={{marginLeft: 8}}>
              {MLLM_MODES.map(m => (
                <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)} title={m.desc}>{m.label}</button>
              ))}
            </div>
            <span style={{flex: 1}} />
            <span className="chip ok">{participants.length} models · {turns.length} turns</span>
          </div>

          <div className="mllm-thread" ref={threadRef}>
            {turns.map(t => {
              const p = participants.find(x => x.id === t.by);
              const isOp = t.by === 'op';
              return (
                <div className="turn" key={t.id}>
                  <span className={`av ${t.by}`}>
                    {isOp ? <I.shield /> : t.by === 'opus' ? 'O' : t.by === 'sonnet' ? 'S' : t.by === 'gpt5' ? 'G' : t.by === 'gemini' ? '◇' : 'γ'}
                  </span>
                  <div>
                    <div className="turn-head">
                      <span className="model">{isOp ? 'Operator' : p ? p.model : t.by}</span>
                      <span className="role">· {t.role}</span>
                      {!isOp && p && p.moderator && <span className="chip accent" style={{fontSize: 10}}>moderator</span>}
                      {!isOp && p && <Truth s={p.truth} />}
                      <span className="when">just now</span>
                    </div>
                    <div className="turn-body">{t.body}</div>
                    {!isOp && (
                      <div className="turn-actions">
                        <button>reply →</button>
                        <button>pin context</button>
                        <button>quote</button>
                        <button>flag</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mllm-input">
            <div className="mllm-input-box">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Inject prompt, paste a log line, or pass the baton…"
                rows={1} />
              <div className="mllm-input-row">
                <button className="chip" style={{cursor: 'pointer'}}>+ attach log</button>
                <button className="chip" style={{cursor: 'pointer'}}>+ pin runtime state</button>
                <button className="chip" style={{cursor: 'pointer'}}>→ pass to: <span style={{color: 'var(--accent)'}}>Opus</span></button>
                <span className="mllm-input-spacer" />
                <button className="btn btn-primary btn-sm" onClick={send} disabled={!input.trim()}>Send <I.external /></button>
              </div>
            </div>
          </div>
        </section>

        {/* ROSTER */}
        <aside className="mllm-pane" style={{borderRight: 0}}>
          <div className="mllm-pane-head">
            <span className="mllm-pane-h">Model roster</span>
            <span style={{flex: 1}} />
            <span className="chip">{participants.length}</span>
          </div>
          <div className="mllm-pane-body">
            {participants.map(p => (
              <div key={p.id} className={`roster-item${p.moderator ? ' moderator' : ''}`}>
                <div className="roster-head">
                  <span className={`av ${p.id}`} style={{width: 22, height: 22, fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--bg)', background: p.id === 'opus' ? 'oklch(0.65 0.13 35)' : p.id === 'sonnet' ? 'oklch(0.62 0.12 175)' : p.id === 'gpt5' ? 'oklch(0.55 0.14 145)' : 'oklch(0.6 0.04 60)'}}>
                    {p.id === 'opus' ? 'O' : p.id === 'sonnet' ? 'S' : p.id === 'gpt5' ? 'G' : 'γ'}
                  </span>
                  <span className="roster-name">{p.model}</span>
                  <select
                    value={p.role}
                    onChange={e => setRole(p.id, e.target.value)}
                    className="roster-role"
                    style={{background: 'transparent', border: 0, color: 'var(--ink-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer'}}>
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="roster-meta">
                  <span>vendor</span><span className="val">{p.vendor}</span>
                  <span>path</span><span className="val">{p.path}</span>
                  <span>auth</span><span className="val">{p.auth}</span>
                  <span>p50 · p95</span><span className="val">{p.p50}/{p.p95} ms</span>
                  <span>cost</span><span className="val">{p.cost}</span>
                  <span>tokens</span><span className="val">{p.tokens}</span>
                </div>
                <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
                  <Truth s={p.truth} />
                  {p.moderator && <span className="chip accent" style={{fontSize: 10}}>MODERATOR</span>}
                </div>
                <div className="roster-foot">
                  {!p.moderator && <button onClick={() => setModerator(p.id)}>set moderator</button>}
                  <button>pause</button>
                  <button>reassign</button>
                  <button className="danger" onClick={() => removeOne(p.id)}>remove</button>
                </div>
              </div>
            ))}
            <button className="roster-add">+ add model · attach to topic</button>
          </div>
        </aside>
      </div>

      {/* SYNTHESIS ROW */}
      <div className="syn-row" style={{border: '1px solid var(--line-2)', borderRadius: 'var(--radius)'}}>
        <div className="syn-cell ok">
          <span className="label">Agreement</span>
          <span className="val">{agreement}</span>
        </div>
        <div className="syn-cell warn">
          <span className="label">Divergence</span>
          <span className="val">{divergence}</span>
        </div>
        <div className="syn-cell">
          <span className="label">Still to verify</span>
          <span className="val">{verify}</span>
        </div>
        <div className="syn-cell accent">
          <span className="label">Recommended</span>
          <span className="val">stage 16 → 24 over 24h · bump memory limit · Sonnet endorsed</span>
        </div>
      </div>

      {/* EXPORT */}
      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-h">Export synthesis</h2>
          <span className="panel-sub">writes back to fleet · audit-trailed</span>
          <span className="panel-spacer" />
          <Truth s="live" />
        </div>
        <div className="panel-body" style={{display: 'flex', gap: 10, flexWrap: 'wrap'}}>
          <button className="btn btn-ghost btn-sm">→ Attach to {container.name} record</button>
          <button className="btn btn-ghost btn-sm">→ Save as runbook · 2026-05-24/route-degrade</button>
          <button className="btn btn-ghost btn-sm">→ Append to gitchain work item</button>
          <button className="btn btn-ghost btn-sm">→ Open as Doku ticket</button>
          <span style={{flex: 1}} />
          <button className="btn btn-primary btn-sm">Export & seal</button>
        </div>
      </div>
    </div>
  );
}
function Klavis() {
  return (
    <div className="stack-16">
      <TruthBar source={SOURCES.klavis} hint="Klavis exposes /quantum-klavis · probe loop every 60s" />
      <div className="klavis-card">
        <div className="klavis-card-head">
          <div className="klavis-card-title">
            <span className="tile">K</span>
            <span>Klavis · LLM bridge</span>
            <Truth s="live" />
          </div>
          <a className="btn btn-ghost btn-sm" href="#" onClick={e => e.preventDefault()}>Open /quantum-klavis <I.external /></a>
        </div>
        <div className="klavis-card-grid">
          <div className="klavis-card-cell">
            <span className="label">Model · pinned</span>
            <span className="val"><span className="s-dot ok" /> Opus 4.7</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Auth · service account</span>
            <span className="val"><span className="s-dot ok" /> header injection · rotating</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Smoke · /v1/messages</span>
            <span className="val"><span className="s-dot ok" /> PASS · 14 min ago</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Restart-safe</span>
            <span className="val"><span className="s-dot ok" /> verified · 1 h ago</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Latency p50 / p95 / p99</span>
            <span className="val">214 / 412 / 980 ms</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Failover · secondary path</span>
            <span className="val"><span className="s-dot ok" /> rehearsed · 3 d ago</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Image</span>
            <span className="val">klavis:0.6.3</span>
          </div>
          <div className="klavis-card-cell">
            <span className="label">Host · port</span>
            <span className="val">gw-02 · :7090</span>
          </div>
        </div>
      </div>
      <div className="row-2">
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">Evidence log</h2><span className="panel-sub">{KLAVIS_EVIDENCE.length} signals</span><span className="panel-spacer" /><Truth s="live" /></div>
          <div className="panel-body flush">
            {KLAVIS_EVIDENCE.map((e, i) => (
              <div className="evidence-row" key={i}>
                <span className="what">{e.what}</span>
                <Truth s={e.truth} />
                <span className="when">{e.when}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="stack-12">
          <div className="panel">
            <div className="panel-head"><h2 className="panel-h">SLO (28d)</h2><span className="panel-spacer" /><Truth s="live" /></div>
            <div className="panel-body stack-8">
              <div className="stat">
                <span className="stat-label">Availability</span>
                <span className="stat-value">99.81<span className="unit"> %</span></span>
                <span className="stat-delta up">↑ 0.06 vs prior window · target 99.5%</span>
              </div>
              <div style={{height: 6, background: 'var(--bg-3)', borderRadius: 999, overflow: 'hidden', marginTop: 4}}>
                <div style={{height: '100%', width: '99.81%', background: 'var(--ok)'}} />
              </div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h2 className="panel-h">Truth assessment</h2><span className="panel-spacer" /></div>
            <div className="panel-body" style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.65}}>
              Klavis is fully live — every signal on this page is a direct probe with a recent timestamp. The token-budget probe at the largest size (16k) is currently <Truth s="mixed" /> because it has a fallback sample. Nothing here is seeded or inferred.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==================== DOKU (lightweight stub) ==================== */
function Doku() {
  return (
    <div className="stack-16">
      <TruthBar source={SOURCES.doku} hint="14 open tickets · 3 blockers" />
      <div className="row-3">
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">Blockers</h2><span className="panel-spacer" /><Truth s="live" /></div>
          <div className="panel-body stack-8" style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.6}}>
            <div><span className="chip err">BLOCKER</span> Gemini oauth refresh failing</div>
            <div><span className="chip err">BLOCKER</span> agent-b status inferred only</div>
            <div><span className="chip err">BLOCKER</span> doku queue exceeding SLO</div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">In progress</h2><span className="panel-sub">5</span><span className="panel-spacer" /></div>
          <div className="panel-body stack-8" style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.6}}>
            <div>mistral-router p95 tuning · <span style={{color: 'var(--ink-3)'}}>@kai</span></div>
            <div>klavis token-budget probe · <span style={{color: 'var(--ink-3)'}}>@joon</span></div>
            <div>agent-b direct probe channel · <span style={{color: 'var(--ink-3)'}}>@maya</span></div>
            <div>edge-proxy observability · <span style={{color: 'var(--ink-3)'}}>@kai</span></div>
            <div>chain fork-count alerting · <span style={{color: 'var(--ink-3)'}}>@joon</span></div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-h">Recently done</h2><span className="panel-spacer" /></div>
          <div className="panel-body stack-8" style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.6}}>
            <div>klavis restart-safe drill · 1 d</div>
            <div>auth-broker key rotation · 18 h</div>
            <div>quantum-gateway 2.1.0-rc3 rollout · 2 d</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==================== APP ==================== */
function App() {
  const [active, setActive] = useState(() => {
    const h = window.location.hash.replace('#', '');
    return TITLE_MAP[h] ? h : 'overview';
  });
  const [theme, setThemeState] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');
  const [createOpen, setCreateOpen] = useState(false);
  const [mllmContainer, setMllmContainer] = useState('mistral-router');
  const setTheme = (t) => {
    setThemeState(t);
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('sturm-theme', t); } catch (e) {}
  };
  useEffect(() => { window.location.hash = active; }, [active]);

  const openMultiLLM = (name) => { setMllmContainer(name); setActive('multillm'); };

  const m = TITLE_MAP[active] || {};
  return (
    <div className="gw-shell">
      <Side active={active} onNav={setActive} theme={theme} setTheme={setTheme} />
      <div className="gw-main">
        <TopBar active={active} />
        <div className="gw-content">
          <div className="gw-page-head">
            <div>
              <h1>{m.title}</h1>
              <p className="lede">{m.lede}</p>
            </div>
            <div className="gw-page-head-actions">
              {active === 'containers' && (
                <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>+ New container</button>
              )}
              <button className="btn btn-ghost btn-sm"><I.refresh /> Refresh</button>
            </div>
          </div>
          {active === 'overview'     && <Overview onNav={setActive} />}
          {active === 'topology'     && <TopologyGraph />}
          {active === 'connectivity' && <ConnectivityMatrix />}
          {active === 'containers'   && <Containers onCreate={() => setCreateOpen(true)} onOpenMultiLLM={openMultiLLM} />}
          {active === 'fleet'        && <FleetTopology />}
          {active === 'runtime'      && <Runtime />}
          {active === 'multillm'     && <MultiLLMWorkspace initialContainer={mllmContainer} />}
          {active === 'klavis'       && <Klavis />}
          {active === 'doku'         && <Doku />}
        </div>
      </div>
      <CreateContainerSheet open={createOpen} onClose={() => setCreateOpen(false)} onApplied={() => {}} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
