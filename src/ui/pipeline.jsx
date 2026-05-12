/* global React, ReactDOM, ReactFlow */
const { useState, useEffect, useMemo, useRef, useCallback } = React;
const RF = window.ReactFlow;

function authHeaders() {
  const tok = localStorage.getItem('sturm-token');
  return tok ? { 'Authorization': `Bearer ${tok}` } : {};
}

/* ------------------------------------------------------------
   Topo-Layout: aus stages + edges x/y-Positionen berechnen.
   Spalten = Topo-Layer; parallele Stages stapeln sich vertikal.
   ------------------------------------------------------------ */
function layoutWorkflow(wf) {
  const stageIds = wf.stages.map(s => s.id);
  const inDeg = new Map(stageIds.map(id => [id, 0]));
  const adj = new Map(stageIds.map(id => [id, []]));
  for (const [a, b] of wf.edges) {
    adj.get(a).push(b);
    inDeg.set(b, (inDeg.get(b) || 0) + 1);
  }
  const layers = [];
  let frontier = stageIds.filter(id => inDeg.get(id) === 0);
  const seen = new Set();
  while (frontier.length) {
    layers.push(frontier);
    frontier.forEach(id => seen.add(id));
    const next = [];
    for (const id of frontier) {
      for (const to of adj.get(id)) {
        const d = inDeg.get(to) - 1;
        inDeg.set(to, d);
        if (d === 0) next.push(to);
      }
    }
    frontier = next;
  }
  // Stages ohne Topo-Ordnung (z.B. isoliert) einfach hinten ranhängen
  for (const id of stageIds) if (!seen.has(id)) layers[layers.length - 1 || 0]?.push(id);

  const COL_W = 240, ROW_H = 140;
  const positions = {};
  layers.forEach((layer, col) => {
    layer.forEach((id, row) => {
      positions[id] = { x: 20 + col * COL_W, y: 60 + row * ROW_H };
    });
  });
  return { positions, layers };
}

/* ------------------------------------------------------------
   Stage-Node (Neo-styled) — zeigt State, Titel, Sub, KPI-Chips,
   optional Fortschrittsbalken und Laufzeit.
   ------------------------------------------------------------ */
function StageNode({ data, selected }) {
  const stateLabel = {
    idle: 'wartet', running: 'läuft', ok: 'fertig', error: 'fehler', skipped: 'übersprungen',
  }[data.state || 'idle'];

  const progress = data.progress; // { value: 0..1 } oder null
  const kpis = data.kpis || [];

  return (
    <div className="sturm-node" data-state={data.state || 'idle'} data-selected={selected}>
      <RF.Handle type="target" position="left" style={{ background: 'var(--color-border)', width: 6, height: 6 }} />
      <div className="sturm-node-state">{stateLabel}</div>
      <div className="sturm-node-title">{data.label}</div>
      {data.sub && <div className="sturm-node-sub">{data.sub}</div>}
      {kpis.length > 0 && (
        <div className="sturm-node-kpis">
          {kpis.map((k, i) => (
            <span key={i} className="sturm-kpi-chip" data-tone={k.tone || undefined}>
              <span className="sturm-kpi-chip-label">{k.label}</span>
              <span className="sturm-kpi-chip-value">{k.value}</span>
            </span>
          ))}
        </div>
      )}
      {progress && typeof progress.value === 'number' && (
        <div className="sturm-node-progress">
          <div
            className="sturm-node-progress-bar"
            style={{ width: `${Math.max(0, Math.min(1, progress.value)) * 100}%` }}
          />
        </div>
      )}
      {data.ms != null && <div className="sturm-node-time">{fmtDur(data.ms)}</div>}
      <RF.Handle type="source" position="right" style={{ background: 'var(--color-border)', width: 6, height: 6 }} />
    </div>
  );
}
/* ------------------------------------------------------------
   ContainerNode — visualisiert einen gitchain Catalog-Container
   (z.B. ELSTER, BMF-Codes). Visuell distinkt von StageNode:
   - Hexagonal clip-path (oktogonale Form, 'gesiegelter Stempel')
   - Doppelter Border (innen accent, außen gold/silver depending lock-state)
   - Merkle-Hash-Strip + atoms-count badge
   - State: 'sealed' (lokal signiert) | 'anchored' (on-chain) | 'loading'
   ------------------------------------------------------------ */
function ContainerNode({ data, selected }) {
  const lockState = data.lockState || 'sealed'; // 'sealed' | 'anchored' | 'loading'
  const lockLabel = {
    sealed: '🔒 lokal signiert',
    anchored: '⚓ on-chain',
    loading: '◌ lädt…',
  }[lockState];
  const merkle = data.merkleRoot ? data.merkleRoot.slice(0, 8) + '…' + data.merkleRoot.slice(-4) : null;
  const issuer = data.issuerFingerprint ? data.issuerFingerprint.replace('sha256:', '').slice(0, 8) : null;

  return (
    <div className="sturm-container-node" data-lock-state={lockState} data-selected={selected}>
      <RF.Handle type="source" position="right" style={{ background: 'var(--color-accent-gold, #d4a574)', width: 8, height: 8, border: '2px solid var(--color-bg-primary)' }} />
      <div className="sturm-container-node-inner">
        <div className="sturm-container-node-badge">{lockLabel}</div>
        <div className="sturm-container-node-type">CATALOG · v{data.schemaVersion || 5}.1</div>
        <div className="sturm-container-node-title">{data.label}</div>
        {data.sub && <div className="sturm-container-node-sub">{data.sub}</div>}
        <div className="sturm-container-node-stats">
          {typeof data.atomsCount === 'number' && (
            <span className="sturm-container-stat">
              <span className="sturm-container-stat-value">{fmtInt(data.atomsCount)}</span>
              <span className="sturm-container-stat-label">atoms</span>
            </span>
          )}
          {typeof data.anlagenCount === 'number' && (
            <span className="sturm-container-stat">
              <span className="sturm-container-stat-value">{data.anlagenCount}</span>
              <span className="sturm-container-stat-label">Anlagen</span>
            </span>
          )}
          {typeof data.embeddingDim === 'number' && (
            <span className="sturm-container-stat">
              <span className="sturm-container-stat-value">{data.embeddingDim}d</span>
              <span className="sturm-container-stat-label">vec</span>
            </span>
          )}
        </div>
        {merkle && (
          <div className="sturm-container-node-hash">
            <span className="sturm-container-hash-label">merkle</span>
            <span className="sturm-container-hash-value">{merkle}</span>
          </div>
        )}
        {issuer && (
          <div className="sturm-container-node-hash">
            <span className="sturm-container-hash-label">issuer</span>
            <span className="sturm-container-hash-value">{issuer}…</span>
          </div>
        )}
        {data.anchorBlock && (
          <a
            className="sturm-container-node-anchor"
            href={data.anchorUrl || `https://basescan.org/block/${data.anchorBlock}`}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
          >
            ↗ Base #{fmtInt(data.anchorBlock)}
          </a>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   FanoutNode — Stage-node variant for `compare/fanout`. Renders
   per-branch chips with live state (pending/running/done/error)
   and ms badges driven by branch_started/branch_done/branch_error.
   ------------------------------------------------------------ */
function FanoutNode({ data, selected }) {
  const stateLabel = {
    idle: 'wartet', running: 'läuft', ok: 'fertig', error: 'fehler', skipped: 'übersprungen',
  }[data.state || 'idle'];
  const branches = data.branches || []; // [{id, state, ms, error}]
  return (
    <div className="sturm-node sturm-fanout-node" data-state={data.state || 'idle'} data-selected={selected}>
      <RF.Handle type="target" position="left" style={{ background: 'var(--color-border)', width: 6, height: 6 }} />
      <div className="sturm-node-state">{stateLabel}</div>
      <div className="sturm-node-title">{data.label}</div>
      {data.sub && <div className="sturm-node-sub">{data.sub}</div>}
      {branches.length > 0 && (
        <div className="sturm-fanout-branches">
          {branches.map(b => (
            <span key={b.id} className="sturm-branch-chip" data-state={b.state || 'pending'} title={b.error || b.id}>
              <span className="sturm-branch-icon">
                {b.state === 'done' ? '✓' : b.state === 'error' ? '✗' : b.state === 'running' ? '◌' : '·'}
              </span>
              <span className="sturm-branch-id">{b.id}</span>
              {b.ms != null && <span className="sturm-branch-ms">{fmtDur(b.ms)}</span>}
            </span>
          ))}
        </div>
      )}
      {data.ms != null && <div className="sturm-node-time">{fmtDur(data.ms)}</div>}
      <RF.Handle type="source" position="right" style={{ background: 'var(--color-border)', width: 6, height: 6 }} />
    </div>
  );
}

const nodeTypes = { stage: StageNode, container: ContainerNode, fanout: FanoutNode };

/* ------------------------------------------------------------
   KPI-Aggregation: pro Stage-`uses` eine Reducer-Funktion, die
   aus dem laufenden State + Event (name, payload) die aktualisierten
   kpis[] und einen optionalen Fortschritt berechnet.
   ------------------------------------------------------------ */
function fmtInt(n) { return typeof n === 'number' ? n.toLocaleString('de-DE') : String(n); }
function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function workflowVersionLabel(id) {
  const m = String(id || '').match(/-(v\d+)$/i);
  return m ? m[1].toUpperCase() : '';
}

function compactWorkflowName(workflow) {
  const raw = String(workflow?.name || workflow?.id || '').trim();
  const base = raw.split(' — ')[0].trim();
  const version = workflowVersionLabel(workflow?.id);
  if (!base) return workflow?.id || 'Workflow';
  if (/^elster$/i.test(base) && version && version !== 'V1') return `${base} ${version}`;
  return base;
}

const KPI_BUILDERS = {
  // Mistral OCR — pages, chars
  'mistral-ocr': (acc, name, p) => {
    if (name === 'stage_start') return { kpis: [], progress: null };
    if (name === 'ocr_pages') {
      const pages = p?.pages ?? p?.count ?? null;
      const chars = p?.chars ?? null;
      return {
        kpis: [
          pages != null && { label: 'Seiten', value: fmtInt(pages), tone: 'accent' },
          chars != null && { label: 'chars', value: fmtInt(chars) },
        ].filter(Boolean),
        progress: null,
      };
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      return {
        kpis: [
          o.pages?.length != null && { label: 'Seiten', value: fmtInt(o.pages.length), tone: 'accent' },
          o.chars != null && { label: 'chars', value: fmtInt(o.chars) },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  'text-stats': (acc, name, p) => {
    if (name === 'stage_done') {
      const o = p?.output || {};
      return {
        kpis: [
          o.chars != null && { label: 'chars', value: fmtInt(o.chars) },
          o.words != null && { label: 'words', value: fmtInt(o.words) },
          o.lines != null && { label: 'zeilen', value: fmtInt(o.lines) },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  // ELSTER-Klassifizierer — erkannte Anlagen (Regex + optional LLM-Fallback)
  'elster/klassifizierung': (acc, name, p) => {
    const st = acc._st || { regex: 0, llm: 0 };
    if (name === 'regex_hits') {
      st.regex = (p?.anlagen || []).length;
      return {
        _st: st,
        kpis: [
          { label: 'Regex', value: fmtInt(st.regex), tone: 'accent' },
        ],
        progress: null,
      };
    }
    if (name === 'llm_hits') {
      st.llm = (p?.anlagen || []).length;
      return {
        _st: st,
        kpis: [
          { label: 'Regex', value: fmtInt(st.regex), tone: 'accent' },
          { label: 'LLM+', value: fmtInt(st.llm), tone: 'warn' },
        ],
        progress: null,
      };
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      const anl = o.erkannte_anlagen || [];
      return {
        _st: st,
        kpis: [
          { label: 'Anlagen', value: fmtInt(anl.length), tone: 'accent' },
          anl.length > 0 && { label: 'liste', value: anl.slice(0,4).join(',') + (anl.length > 4 ? '…' : '') },
          o.used_llm && { label: 'LLM-fallback', value: 'ja', tone: 'warn' },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  // ELSTER-Extraktion — Progress pro Anlage (done/total), kumulative filled
  'elster/extraktion': (acc, name, p) => {
    const prog = acc._prog || { total: 0, done: 0, filled: 0, fields: 0, errors: 0, durSum: 0 };
    if (name === 'extraktion_start') {
      prog.total = p?.total ?? 0;
      return {
        _prog: prog,
        kpis: [
          { label: 'Anlagen', value: fmtInt(prog.total), tone: 'accent' },
          p?.concurrency && { label: 'par', value: String(p.concurrency) },
        ].filter(Boolean),
        progress: prog.total > 0 ? { value: 0 } : null,
      };
    }
    if (name === 'anlage_done') {
      prog.done += 1;
      prog.filled += (p?.filled ?? 0);
      prog.fields += (p?.fieldCount ?? 0);
      prog.durSum += (p?.durationMs ?? 0);
      return {
        _prog: prog,
        kpis: [
          { label: 'Anlagen', value: `${fmtInt(prog.done)}/${fmtInt(prog.total)}`, tone: 'accent' },
          { label: 'Felder', value: `${fmtInt(prog.filled)}/${fmtInt(prog.fields)}`, tone: prog.filled > 0 ? 'ok' : undefined },
          prog.errors > 0 && { label: 'err', value: fmtInt(prog.errors), tone: 'warn' },
        ].filter(Boolean),
        progress: prog.total > 0 ? { value: prog.done / prog.total } : null,
      };
    }
    if (name === 'anlage_error') {
      prog.errors += 1;
      prog.done += 1;
      return {
        _prog: prog,
        kpis: [
          { label: 'Anlagen', value: `${fmtInt(prog.done)}/${fmtInt(prog.total)}`, tone: 'accent' },
          { label: 'Felder', value: `${fmtInt(prog.filled)}/${fmtInt(prog.fields)}`, tone: prog.filled > 0 ? 'ok' : undefined },
          { label: 'err', value: fmtInt(prog.errors), tone: 'warn' },
        ],
        progress: prog.total > 0 ? { value: prog.done / prog.total } : null,
      };
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      const perAnlage = o.per_anlage || {};
      const anzahl = Object.keys(perAnlage).length;
      const totalFields = Object.values(perAnlage).reduce((s, r) => s + (r?.fieldCount || 0), 0);
      const avgPer = anzahl > 0 ? Math.round(prog.durSum / anzahl) : 0;
      return {
        _prog: prog,
        kpis: [
          { label: 'Anlagen', value: fmtInt(anzahl), tone: 'accent' },
          { label: 'Felder', value: `${fmtInt(o.totalFilled || 0)}/${fmtInt(totalFields)}`, tone: 'ok' },
          avgPer > 0 && { label: 'ø/Anl', value: fmtDur(avgPer) },
          prog.errors > 0 && { label: 'err', value: fmtInt(prog.errors), tone: 'warn' },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  // ELSTER-Anreicherung — Werte mit Metadaten, Pflichtfeld-Tracking
  'elster/anreicherung': (acc, name, p) => {
    const st = acc._st || { anlagen: 0, werte: 0, unbelegt: 0 };
    if (name === 'anlage_angereichert') {
      st.anlagen += 1;
      st.werte += (p?.werte ?? 0);
      st.unbelegt += (p?.unbelegt ?? 0);
      return {
        _st: st,
        kpis: [
          { label: 'Anlagen', value: fmtInt(st.anlagen), tone: 'accent' },
          { label: 'Werte', value: fmtInt(st.werte), tone: st.werte > 0 ? 'ok' : undefined },
          st.unbelegt > 0 && { label: 'leer', value: fmtInt(st.unbelegt) },
        ].filter(Boolean),
        progress: null,
      };
    }
    if (name === 'anreicherung_done') {
      return {
        _st: st,
        kpis: [
          { label: 'Anlagen', value: fmtInt(p?.anlagen_belegt ?? 0), tone: 'accent' },
          { label: 'Werte', value: fmtInt(p?.werte_gesamt ?? 0), tone: 'ok' },
          p?.pflichtfelder_belegt > 0 && { label: 'Pflicht', value: fmtInt(p.pflichtfelder_belegt), tone: 'ok' },
        ].filter(Boolean),
        progress: null,
      };
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      const s = o.summen || {};
      return {
        kpis: [
          { label: 'Anlagen', value: fmtInt(s.anlagen_belegt ?? 0), tone: 'accent' },
          { label: 'Werte', value: fmtInt(s.werte_gesamt ?? 0), tone: 'ok' },
          s.pflichtfelder_belegt > 0 && { label: 'Pflicht', value: fmtInt(s.pflichtfelder_belegt), tone: 'ok' },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  // ELSTER-Qualitätsgate — Haiku-Repair: werte vorher -> nachher, ergänzt, status
  'elster/qualitaetsgate': (acc, name, p) => {
    const st = acc._st || { vorher: 0, ergaenzt: 0, verworfen: 0, status: null, skipped: false };
    if (name === 'gate_start') {
      st.vorher = p?.werte_vorher ?? 0;
      return {
        _st: st,
        kpis: [
          { label: 'Werte in', value: fmtInt(st.vorher), tone: 'accent' },
          p?.anlagen_anzahl != null && { label: 'Anlagen', value: fmtInt(p.anlagen_anzahl) },
        ].filter(Boolean),
        progress: null,
      };
    }
    if (name === 'gate_skip') {
      st.skipped = true;
      return {
        _st: st,
        kpis: [
          { label: 'skip', value: p?.reason === 'einzelbeleg_fast_path' ? 'fast-path' : String(p?.reason || 'skip') },
          { label: 'Werte', value: fmtInt(p?.werte ?? st.vorher), tone: 'ok' },
        ],
        progress: null,
      };
    }
    if (name === 'gate_ergaenzung') {
      st.ergaenzt += 1;
      return {
        _st: st,
        kpis: [
          { label: 'Werte in', value: fmtInt(st.vorher), tone: 'accent' },
          { label: 'ergänzt', value: fmtInt(st.ergaenzt), tone: 'ok' },
        ],
        progress: null,
      };
    }
    if (name === 'gate_done') {
      const status = p?.status || st.status;
      const statusTone =
        status === 'ok_vollstaendig' ? 'ok' :
        status === 'ok_ergaenzt'     ? 'ok' :
        status === 'fehler'          ? 'warn' :
        undefined;
      return {
        _st: { ...st, status },
        kpis: [
          status && { label: 'status', value: status.replace(/^ok_/, ''), tone: statusTone },
          { label: 'Werte', value: `${fmtInt(p?.werte_vorher ?? 0)}→${fmtInt(p?.werte_nachher ?? 0)}`, tone: 'accent' },
          (p?.ergaenzt ?? 0) > 0 && { label: 'ergänzt', value: fmtInt(p.ergaenzt), tone: 'ok' },
          (p?.verworfen ?? 0) > 0 && { label: 'verworfen', value: fmtInt(p.verworfen) },
          (p?.calls ?? 0) > 0 && { label: 'calls', value: fmtInt(p.calls) },
        ].filter(Boolean),
        progress: null,
      };
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      const s = o.summen || {};
      const statusTone =
        o.status === 'ok_vollstaendig' ? 'ok' :
        o.status === 'ok_ergaenzt'     ? 'ok' :
        o.status === 'fehler'          ? 'warn' :
        undefined;
      return {
        kpis: [
          o.status && { label: 'status', value: String(o.status).replace(/^ok_/, ''), tone: statusTone },
          { label: 'Werte', value: `${fmtInt(s.werte_vorher ?? 0)}→${fmtInt(s.werte_nachher ?? 0)}`, tone: 'accent' },
          (s.ergaenzt ?? 0) > 0 && { label: 'ergänzt', value: fmtInt(s.ergaenzt), tone: 'ok' },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  // ELSTER-Seitenchips — 1-Satz pro Seite
  'elster/seiten-chips': (acc, name, p) => {
    const st = acc._st || { total: 0, done: 0 };
    if (name === 'chips_start') {
      st.total = p?.pages ?? 0;
      return {
        _st: st,
        kpis: [{ label: 'Seiten', value: fmtInt(st.total), tone: 'accent' }],
        progress: st.total > 0 ? { value: 0 } : null,
      };
    }
    if (name === 'seite_chip') {
      st.done += 1;
      return {
        _st: st,
        kpis: [
          { label: 'Chips', value: `${fmtInt(st.done)}/${fmtInt(st.total)}`, tone: 'accent' },
        ],
        progress: st.total > 0 ? { value: st.done / st.total } : null,
      };
    }
    if (name === 'chips_done') {
      return {
        _st: st,
        kpis: [{ label: 'Chips', value: fmtInt(p?.count ?? st.done), tone: 'ok' }],
        progress: null,
      };
    }
    return acc;
  },

  // ELSTER-Fall-Summary — 1-Satz-Befund
  'elster/fall-summary': (acc, name, p) => {
    if (name === 'befund_start') {
      return {
        kpis: [
          { label: 'Werte', value: fmtInt(p?.werte ?? 0), tone: 'accent' },
          p?.anlagen != null && { label: 'Anlagen', value: fmtInt(p.anlagen) },
        ].filter(Boolean),
        progress: null,
      };
    }
    if (name === 'fall_befund') {
      const b = p?.befund || '';
      const short = b.length > 40 ? b.slice(0, 38) + '…' : b;
      return {
        kpis: [
          short && { label: 'Befund', value: short, tone: p?.fallback ? 'warn' : 'ok' },
          (p?.hinweise?.length > 0) && { label: 'Hinweise', value: fmtInt(p.hinweise.length) },
        ].filter(Boolean),
        progress: null,
      };
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      const b = o.befund || '';
      const short = b.length > 40 ? b.slice(0, 38) + '…' : b;
      return {
        kpis: [
          short && { label: 'Befund', value: short, tone: o.error ? 'warn' : 'ok' },
          (o.hinweise?.length > 0) && { label: 'Hinweise', value: fmtInt(o.hinweise.length) },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  'steuerbelege/seiten-splitter': (acc, name, p) => {
    if (name === 'split_ergebnis') {
      return {
        kpis: [
          { label: 'Belege', value: fmtInt(p?.anzahl ?? 0), tone: 'accent' },
          p?.methode && { label: 'split', value: p.methode },
        ].filter(Boolean),
        progress: null,
      };
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      return {
        kpis: [
          { label: 'Belege', value: fmtInt(o.subBelege?.length ?? 0), tone: 'accent' },
          o.methode && { label: 'split', value: o.methode },
          o.anzahlSeiten != null && { label: 'Seiten', value: fmtInt(o.anzahlSeiten) },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  'steuerbelege/dokument-typ': (acc, name, p) => {
    if (name === 'stage_done') {
      const o = p?.output || {};
      const anlagenStr = (o.anlagen || []).join('+') || '—';
      return {
        kpis: [
          o.typ_id && { label: 'Typ', value: o.typ_id, tone: 'ok' },
          { label: 'Anlagen', value: anlagenStr, tone: o.anlagen?.length ? 'accent' : undefined },
          o.konfidenz && { label: 'konf', value: o.konfidenz },
          o.used_llm && { label: 'LLM', value: 'ja' },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },

  'steuerbelege/beleg-extraktion': (acc, name, p) => {
    if (name === 'anlagen_ausgewählt') {
      const anl = (p?.anlagen || []).join('+') || '—';
      return { kpis: [{ label: 'Anlagen', value: anl, tone: 'accent' }], progress: null };
    }
    if (name === 'felder_extrahiert') {
      const prev = acc.kpis.filter(k => k.label !== 'filled');
      return {
        kpis: [...prev, { label: 'filled', value: `${p?.filled}/${p?.fieldCount}`, tone: 'ok' }],
        progress: null,
      };
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      if (o.skipped) {
        return { kpis: [{ label: 'skip', value: 'ja' }], progress: null };
      }
      return {
        kpis: [
          { label: 'Anlagen', value: (o.anlagen || []).join('+') || '—', tone: 'accent' },
          { label: 'filled', value: `${o.filled}/${o.fieldCount}`, tone: o.filled ? 'ok' : undefined },
        ],
        progress: null,
      };
    }
    return acc;
  },

  'steuerbelege/belege-multi': (acc, name, p) => {
    // Fortschritt pro Sub-Beleg tracken
    const prog = acc._prog || { total: 0, klass: 0, extr: 0, filled: 0, fields: 0 };
    if (name === 'split_ergebnis') {
      // not on this stage, ignore
      return acc;
    }
    if (name === 'beleg_start') {
      // nothing, start marker
      return acc;
    }
    if (name === 'beleg_klassifiziert') {
      prog.klass += 1;
      if (prog.total === 0) prog.total = Math.max(prog.total, prog.klass);
      return buildMultiKpis(prog);
    }
    if (name === 'beleg_extrahiert') {
      prog.extr += 1;
      prog.filled += (p?.filled ?? 0);
      prog.fields += (p?.fieldCount ?? 0);
      return buildMultiKpis(prog);
    }
    if (name === 'beleg_uebersprungen') {
      prog.extr += 1;
      return buildMultiKpis(prog);
    }
    if (name === 'stage_done') {
      const o = p?.output || {};
      return {
        kpis: [
          { label: 'Belege', value: fmtInt(o.anzahlBelege ?? 0), tone: 'accent' },
          { label: 'mit Anlage', value: fmtInt(o.anzahlMitAnlage ?? 0), tone: 'ok' },
          o.anzahlDokumentation > 0 && { label: 'nur Doku', value: fmtInt(o.anzahlDokumentation) },
          { label: 'filled', value: `${fmtInt(o.filledSumme ?? 0)}/${fmtInt(o.fieldCountSumme ?? 0)}`, tone: 'ok' },
        ].filter(Boolean),
        progress: null,
      };
    }
    return acc;
  },
};

// compare/fanout — show branch ok/err tally on the node
KPI_BUILDERS['compare/fanout'] = (acc, name, p) => {
  const st = acc._st || { ok: 0, err: 0, total: 0 };
  if (name === 'fanout_started') {
    st.total = (p?.branches || []).length;
    return { _st: st, kpis: [{ label: 'Branches', value: fmtInt(st.total), tone: 'accent' }], progress: 0 };
  }
  if (name === 'branch_done') {
    st.ok += 1;
    return {
      _st: st,
      kpis: [
        { label: 'ok', value: `${fmtInt(st.ok)}/${fmtInt(st.total)}`, tone: 'ok' },
        st.err > 0 && { label: 'err', value: fmtInt(st.err), tone: 'warn' },
      ].filter(Boolean),
      progress: st.total > 0 ? { value: (st.ok + st.err) / st.total } : null,
    };
  }
  if (name === 'branch_error') {
    st.err += 1;
    return {
      _st: st,
      kpis: [
        { label: 'ok', value: `${fmtInt(st.ok)}/${fmtInt(st.total)}`, tone: st.ok ? 'ok' : undefined },
        { label: 'err', value: fmtInt(st.err), tone: 'warn' },
      ],
      progress: st.total > 0 ? { value: (st.ok + st.err) / st.total } : null,
    };
  }
  if (name === 'stage_done') {
    const o = p?.output || {};
    const ok = Object.keys(o.branches || {}).length;
    const err = Object.keys(o.errors || {}).length;
    return {
      _st: st,
      kpis: [
        { label: 'ok', value: fmtInt(ok), tone: 'ok' },
        err > 0 && { label: 'err', value: fmtInt(err), tone: 'warn' },
      ].filter(Boolean),
      progress: null,
    };
  }
  return acc;
};

// compare/merge — show picked branch + policy
KPI_BUILDERS['compare/merge'] = (acc, name, p) => {
  if (name === 'merge_done') {
    return {
      kpis: [
        p?.picked && { label: 'picked', value: String(p.picked), tone: 'ok' },
        p?.policy && { label: 'policy', value: String(p.policy) },
      ].filter(Boolean),
      progress: null,
    };
  }
  if (name === 'stage_done') {
    const o = p?.output || {};
    return {
      kpis: [
        o.picked && { label: 'picked', value: String(o.picked), tone: 'ok' },
        o.policy && { label: 'policy', value: String(o.policy) },
      ].filter(Boolean),
      progress: null,
    };
  }
  return acc;
};

// eval/kpi — show score + verdict on the node
KPI_BUILDERS['eval/kpi'] = (acc, name, p) => {
  if (name === 'kpi_report') {
    const score = typeof p?.score === 'number' ? p.score.toFixed(2) : '—';
    const tone = p?.verdict === 'pass' ? 'ok' : p?.verdict === 'fail' ? 'warn' : undefined;
    return {
      kpis: [
        { label: 'Score', value: score, tone },
        p?.verdict && { label: 'verdict', value: p.verdict, tone },
      ].filter(Boolean),
      progress: null,
    };
  }
  return acc;
};

function buildMultiKpis(prog) {
  const total = prog.total;
  const pct = total > 0 ? prog.extr / total : null;
  return {
    _prog: prog,
    kpis: [
      { label: 'klassifiziert', value: fmtInt(prog.klass), tone: 'accent' },
      { label: 'extrahiert', value: fmtInt(prog.extr), tone: prog.extr > 0 ? 'ok' : undefined },
      prog.fields > 0 && { label: 'filled', value: `${fmtInt(prog.filled)}/${fmtInt(prog.fields)}`, tone: 'ok' },
    ].filter(Boolean),
    progress: pct != null ? { value: pct } : null,
  };
}

function applyKpiEvent(stageUses, state, name, payload) {
  const builder = KPI_BUILDERS[stageUses];
  if (!builder) return state;
  const next = builder(state, name, payload);
  // Interne Akkumulatoren (_prog, _st, …) vom letzten State durchreichen,
  // damit Builder inkrementell aggregieren können.
  return {
    ...state,
    ...next,
    kpis: next.kpis ?? state.kpis ?? [],
    progress: next.progress ?? null,
  };
}

/* ------------------------------------------------------------
   Sidebar + TopBar + Composer + Drawer (wie vorher, nur kleinere Tweaks)
   ------------------------------------------------------------ */
function SidebarUpload({ workflow, file, onFile, onStart, running }) {
  const inputRef = useRef(null);
  const [dragover, setDragover] = useState(false);
  const accept = workflow?.input?.accept?.map(x => '.' + x).join(',') || '.pdf,.jpg,.jpeg,.png';
  const maxMb = workflow?.input?.maxSizeMb ?? 20;
  const isFileInput = workflow?.input?.type === 'file';

  function onDrop(e) {
    e.preventDefault(); setDragover(false);
    const f = e.dataTransfer.files?.[0]; if (f) onFile(f);
  }

  if (!isFileInput) return null;

  return (
    <>
      <div
        className={`sturm-sb-upload ${dragover ? 'is-dragover' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragover(true); }}
        onDragLeave={() => setDragover(false)}
        onDrop={onDrop}
      >
        <div className="sturm-sb-upload-row">
          <i data-lucide={file ? 'file-check-2' : 'upload'}></i>
          <span>{file ? 'Datei gewählt' : 'Datei ablegen oder wählen'}</span>
        </div>
        {file ? (
          <div className="sturm-sb-upload-name">{file.name}</div>
        ) : (
          <div className="sturm-sb-upload-hint">
            {(workflow?.input?.accept || []).map(x => x.toUpperCase()).join(' · ')} · bis {maxMb} MB
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          style={{ display: 'none' }}
          accept={accept}
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
        />
      </div>
      <button className="sturm-sb-upload-start" disabled={!file || running || !workflow} onClick={onStart}>
        <i data-lucide={running ? 'loader' : 'play'}></i>
        <span>{running ? 'läuft …' : 'Workflow starten'}</span>
      </button>
    </>
  );
}

function Sidebar({ collapsed, onToggle, workflows, activeId, workflow, file, onFile, onStart, running }) {
  if (collapsed) {
    return (
      <aside className="sturm-sidebar is-collapsed">
        <button className="sturm-sb-toggle" onClick={onToggle} aria-label="Sidebar öffnen">
          <i data-lucide="panel-left"></i>
        </button>
      </aside>
    );
  }
  return (
    <aside className="sturm-sidebar">
      <div className="sturm-sb-head">
        <div className="sturm-sb-brand">
          <span className="sturm-mark">S</span>
          <span className="sturm-brand-word">STURM</span>
        </div>
        <button className="sturm-sb-toggle" onClick={onToggle} aria-label="Sidebar einklappen">
          <i data-lucide="panel-left"></i>
        </button>
      </div>

      <SidebarUpload
        workflow={workflow}
        file={file}
        onFile={onFile}
        onStart={onStart}
        running={running}
      />

      <div className="sturm-sb-section"><span>Workflows</span></div>
      <nav className="sturm-sb-nav">
        {workflows.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>keine geladen</div>
        )}
        {workflows.map(w => {
          const compactName = compactWorkflowName(w);
          const version = workflowVersionLabel(w.id);
          return (
            <a
              key={w.id}
              href={`/pipeline.html?workflow=${encodeURIComponent(w.id)}`}
              className={`sturm-sb-item ${w.id === activeId ? 'is-active' : ''}`}
              style={{ textDecoration: 'none' }}
              title={`${w.name} (${w.id})`}
            >
              <i data-lucide="git-branch"></i>
              <span className="sturm-sb-item-main">
                <span className="sturm-sb-item-label">{compactName}</span>
                <span className="sturm-sb-item-sub">{w.id}</span>
              </span>
              {version && <span className="sturm-sb-item-meta">{version}</span>}
            </a>
          );
        })}
      </nav>

      <div className="sturm-sb-section"><span>Werkzeuge</span></div>
      <nav className="sturm-sb-nav">
        <a
          href="/studio-ocr.html"
          className="sturm-sb-item"
          style={{ textDecoration: 'none' }}
          title="OCR Studio öffnen"
        >
          <i data-lucide="sliders-horizontal"></i>
          <span>OCR Studio</span>
          <span className="sturm-sb-item-meta">tune</span>
        </a>
      </nav>

      <div className="sturm-sb-section"><span>Letzte Runs</span></div>
      <div className="sturm-sb-nav sturm-sb-nav-scroll">
        <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          folgen nach erstem Lauf
        </div>
      </div>

      <div className="sturm-sb-foot">
        <a
          href="/"
          className="sturm-sb-item"
          style={{ textDecoration: 'none', marginRight: 8 }}
          title="Zur Übersicht"
        >
          <i data-lucide="arrow-left"></i>
        </a>
        <div className="sturm-avatar">C</div>
        <div>
          <div className="sturm-sb-user-name">Christoph</div>
          <div className="sturm-sb-user-plan">0711 Intelligence</div>
        </div>
      </div>
    </aside>
  );
}

function TopBar({ workflow, status, runId, collapsedSidebar, onOpenSidebar, theme, onToggleTheme }) {
  const statusLabel = { idle: 'bereit', running: 'läuft', ok: 'fertig', error: 'fehler' }[status];
  return (
    <header className="sturm-topbar">
      <div className="sturm-topbar-l">
        {collapsedSidebar && (
          <button className="sturm-icon-btn" onClick={onOpenSidebar} aria-label="Sidebar öffnen">
            <i data-lucide="panel-left"></i>
          </button>
        )}
        <span className="sturm-topbar-title">
          <strong className="sturm-topbar-workflow" title={workflow?.name || ''}>{workflow?.name || 'Lädt …'}</strong>
          {workflow && <>
            <span className="sturm-topbar-sep">·</span>
            <span className="sturm-wf-chip" title={workflow.id}><span>{workflow.id}</span></span>
          </>}
          {runId && <span className="sturm-run-id">{runId}</span>}
        </span>
      </div>
      <div className="sturm-topbar-r">
        <span className={`sturm-status ${status === 'running' ? 'is-running' : status === 'ok' ? 'is-ok' : status === 'error' ? 'is-error' : ''}`}>
          {statusLabel}
        </span>
        <button className="sturm-icon-btn" onClick={onToggleTheme} aria-label="Theme umschalten">
          <i data-lucide={theme === 'dark' ? 'sun' : 'moon'}></i>
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------
   StageChipBar — Claude-Desktop-Stil: Header (State-Dot · Stage ·
   Mikro-KPIs · Event-Count · Chevron), Expand-Panel mit Events.
   ------------------------------------------------------------ */
function StageChipBar({ stageId, stageName, stageState, stageMs, kpis, events, defaultOpen, onToggle, open, workflowId, runId, stageUses }) {
  const label = {
    idle: 'wartet', running: 'läuft', ok: 'fertig', error: 'fehler', skipped: 'übersprungen',
  }[stageState || 'idle'];
  const count = events.length;

  return (
    <div className="sturm-stagebar" data-state={stageState || 'idle'} data-open={open}>
      <button className="sturm-stagebar-head" onClick={onToggle} aria-expanded={open}>
        <span className="sturm-stagebar-dot" />
        <span className="sturm-stagebar-name">{stageName || stageId}</span>
        <span className="sturm-stagebar-state">{label}</span>
        {kpis.length > 0 && (
          <span className="sturm-stagebar-kpis">
            {kpis.slice(0, 3).map((k, i) => (
              <span key={i} className="sturm-stagebar-kpi" data-tone={k.tone || undefined}>
                <span className="sturm-stagebar-kpi-label">{k.label}</span>
                <span className="sturm-stagebar-kpi-value">{k.value}</span>
              </span>
            ))}
          </span>
        )}
        {stageMs != null && <span className="sturm-stagebar-time">{fmtDur(stageMs)}</span>}
        {count > 0 && <span className="sturm-stagebar-count">{count}</span>}
        {stageUses === 'mistral-ocr' && stageState === 'ok' && workflowId && runId && (
          <a
            className="sturm-stagebar-tune"
            href={`/studio-ocr.html?from=run:${encodeURIComponent(workflowId)}:${encodeURIComponent(runId)}&stage=${encodeURIComponent(stageId)}`}
            onClick={(e) => e.stopPropagation()}
            title="Diese Stage im OCR Studio öffnen"
          >
            <i data-lucide="sliders-horizontal"></i>
            <span>Tune</span>
          </a>
        )}
        <svg className="sturm-stagebar-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="sturm-stagebar-body">
          {count === 0 && (
            <div className="sturm-stagebar-empty">noch keine Events</div>
          )}
          {events.map((e, i) => {
            const payloadStr = e.payload != null
              ? (typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2))
              : null;
            return (
              <div className="sturm-event" key={i}>
                <div className="sturm-event-time">{e.t}</div>
                <div className="sturm-event-name">{e.name}</div>
                {payloadStr && <div className="sturm-event-payload">{payloadStr}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Drawer({ events, issues, setIssues, workflowId, workflow, stageStates, stageKpis, selectedStage, runId, stageUses, collapsed, onToggleCollapsed }) {
  const [tab, setTab] = useState('events');
  const [newIssue, setNewIssue] = useState('');
  const [manualOpen, setManualOpen] = useState({}); // { [stageId]: boolean }
  // "run" ist die Pseudo-Stage für globale Events
  const stageOrder = useMemo(() => {
    if (!workflow) return [];
    return ['__run__', ...workflow.stages.map(s => s.id)];
  }, [workflow]);
  const stageNames = useMemo(() => {
    const m = { __run__: 'Run' };
    if (workflow) for (const s of workflow.stages) m[s.id] = s.name || s.id;
    return m;
  }, [workflow]);

  const grouped = useMemo(() => {
    const g = {};
    for (const id of stageOrder) g[id] = [];
    for (const e of events) {
      const key = e.stageId || '__run__';
      if (!g[key]) g[key] = [];
      g[key].push(e);
    }
    return g;
  }, [events, stageOrder]);

  function isOpen(stageId) {
    if (manualOpen[stageId] != null) return manualOpen[stageId];
    if (stageId === '__run__') return false;
    const st = stageStates[stageId]?.state;
    // Auto-Open: laufend oder fehlerhaft offen, Rest zu
    return st === 'running' || st === 'error';
  }
  function toggle(stageId) {
    setManualOpen(m => ({ ...m, [stageId]: !isOpen(stageId) }));
  }

  function addIssue() {
    const t = newIssue.trim();
    if (!t) return;
    setIssues(list => [...list, { id: Date.now(), title: t, tag: 'neu', done: false }]);
    setNewIssue('');
  }

  const openTab = (nextTab) => {
    setTab(nextTab);
    if (collapsed) onToggleCollapsed(false);
  };

  return (
    <aside className={`sturm-drawer ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="sturm-drawer-head">
        <div className="sturm-drawer-tabs">
          <button className={`sturm-drawer-tab ${tab === 'events' ? 'is-active' : ''}`} onClick={() => openTab('events')} title="Events">
            <i data-lucide="list-tree"></i>
            {!collapsed && <>Events <span className="sturm-badge sturm-badge-muted">{events.length}</span></>}
            {collapsed && <span className="sturm-badge sturm-badge-muted">{events.length}</span>}
          </button>
          <button className={`sturm-drawer-tab ${tab === 'issues' ? 'is-active' : ''}`} onClick={() => openTab('issues')} title="Issues">
            <i data-lucide="bug"></i>
            {!collapsed && <>Issues <span className="sturm-badge sturm-badge-muted">{issues.filter(i => !i.done).length}</span></>}
            {collapsed && <span className="sturm-badge sturm-badge-muted">{issues.filter(i => !i.done).length}</span>}
          </button>
        </div>
        <button className="sturm-icon-btn" onClick={() => onToggleCollapsed(!collapsed)} aria-label={collapsed ? 'Drawer öffnen' : 'Drawer einklappen'}>
          <i data-lucide={collapsed ? 'chevron-left' : 'chevron-right'}></i>
        </button>
      </div>

      {!collapsed && tab === 'events' && (
        <div className="sturm-drawer-body sturm-drawer-body--bars">
          {events.length === 0 && (
            <div style={{ padding: 18, textAlign: 'center', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
              Events erscheinen hier, sobald der Lauf startet.
            </div>
          )}
          {events.length > 0 && stageOrder.map(stageId => {
            const evs = grouped[stageId] || [];
            // Run-Bar nur anzeigen wenn sie Events hat
            if (stageId === '__run__' && evs.length === 0) return null;
            // Stage-Bars immer anzeigen (auch ohne Events), sobald Workflow geladen
            if (stageId !== '__run__' && !workflow) return null;
            const state = stageId === '__run__'
              ? (events.some(e => e.name === 'run_error' || e.name === 'client_error')
                  ? 'error'
                  : (events.some(e => e.name === 'run_done') ? 'ok' : 'running'))
              : (stageStates[stageId]?.state || 'idle');
            const ms = stageId === '__run__' ? undefined : stageStates[stageId]?.ms;
            const kpis = stageId === '__run__' ? [] : (stageKpis[stageId]?.kpis || []);
            return (
              <StageChipBar
                key={stageId}
                stageId={stageId}
                stageName={stageNames[stageId]}
                stageState={state}
                stageMs={ms}
                kpis={kpis}
                events={evs}
                open={isOpen(stageId)}
                onToggle={() => toggle(stageId)}
                workflowId={workflowId}
                runId={runId}
                stageUses={stageUses?.[stageId]}
              />
            );
          })}
        </div>
      )}

      {!collapsed && tab === 'issues' && (
        <div className="sturm-drawer-body">
          <div className="sturm-issue-add">
            <input
              placeholder="Neuer Issue …"
              value={newIssue}
              onChange={e => setNewIssue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addIssue()}
            />
            <button onClick={addIssue} disabled={!newIssue.trim()}>+</button>
          </div>
          {issues.length === 0 && (
            <div style={{ padding: 18, textAlign: 'center', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
              Noch keine Issues für {workflowId}.
            </div>
          )}
          {issues.map(iss => (
            <div className={`sturm-issue ${iss.done ? 'is-done' : ''}`} key={iss.id}>
              <button
                className="sturm-issue-check"
                aria-label={iss.done ? 'wieder öffnen' : 'erledigt'}
                onClick={() => setIssues(list => list.map(x => x.id === iss.id ? { ...x, done: !x.done } : x))}
              >
                {iss.done && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                )}
              </button>
              <div className="sturm-issue-body">
                <div className="sturm-issue-title">{iss.title}</div>
                <div className="sturm-issue-tag">{iss.tag}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------
   Run-Streamer — liest SSE von POST /api/workflows/:id/run
   ------------------------------------------------------------ */
async function streamRun(workflowId, file, onEvent) {
  const form = new FormData();
  form.append('file', file);
  const resp = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/run`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`run HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const lines = part.split('\n');
      let name = 'message';
      let dataRaw = '';
      for (const ln of lines) {
        if (ln.startsWith('event: ')) name = ln.slice(7).trim();
        else if (ln.startsWith('data: ')) dataRaw += ln.slice(6);
      }
      if (!dataRaw) continue;
      let env;
      try { env = JSON.parse(dataRaw); } catch { env = { raw: dataRaw }; }
      onEvent(name, env);
    }
  }
}

function FlowViewportManager({ workflowId, nodes, edges, nodeTypes, onNodeClick, onNodeDragStop, drawerCollapsed }) {
  const flowRef = useRef(null);

  useEffect(() => {
    if (!flowRef.current || nodes.length === 0) return;
    const scheduleFit = () => {
      flowRef.current?.fitView({ padding: 0.24, duration: 220, maxZoom: 1 });
    };
    requestAnimationFrame(() => requestAnimationFrame(scheduleFit));
  }, [workflowId, drawerCollapsed, nodes.length, edges.length]);

  return (
    <RF.ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={(instance) => {
        flowRef.current = instance;
        setTimeout(() => instance.fitView({ padding: 0.24, duration: 0, maxZoom: 1 }), 0);
      }}
      nodesDraggable={true}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={onNodeClick}
      onNodeDragStop={onNodeDragStop}
      proOptions={{ hideAttribution: false }}
    >
      <RF.Background color="var(--color-border-light)" gap={22} size={1} />
      <RF.Controls />
      <RF.MiniMap
        nodeColor={(n) => {
          const s = n.data?.state;
          if (s === 'running') return 'var(--color-accent)';
          if (s === 'ok')      return 'var(--color-success)';
          if (s === 'error')   return 'var(--color-danger)';
          return 'var(--color-bg-tertiary)';
        }}
        maskColor="rgba(26, 24, 22, 0.6)"
        style={{ background: 'var(--color-bg-secondary)' }}
      />
    </RF.ReactFlow>
  );
}

/* ------------------------------------------------------------
   KpiPanel — verdict, component bars, per-branch table, disputed.
   Renders below the canvas when an eval/kpi stage produced a report.
   ------------------------------------------------------------ */
function ScoreBar({ label, value }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <div className="sturm-kpi-bar">
      <div className="sturm-kpi-bar-label">{label}</div>
      <div className="sturm-kpi-bar-track"><div className="sturm-kpi-bar-fill" style={{ width: `${v * 100}%` }} /></div>
      <div className="sturm-kpi-bar-value">{v.toFixed(2)}</div>
    </div>
  );
}

function KpiPanel({ report, fanoutOutput }) {
  const [disputedOpen, setDisputedOpen] = useState(false);
  if (!report) return null;
  const verdict = report.verdict || 'fail';
  const score = typeof report.score === 'number' ? report.score : 0;
  const c = report.components || {};
  const cb = report.cross_branch;
  const branchKeys = cb ? Object.keys(cb.per_branch || {}) : [];
  // Best branch by score (schema_coverage*format_conformance fallback)
  const branchScore = (b) => (b.schema_coverage ?? 0) * 0.5 + (b.format_conformance ?? 0) * 0.5;
  const bestBranch = branchKeys.reduce((best, k) => {
    const s = branchScore(cb.per_branch[k]);
    return !best || s > best.s ? { k, s } : best;
  }, null);
  const branchValues = fanoutOutput?.branches || {};

  function valueFor(branchId, key) {
    const v = branchValues?.[branchId];
    if (v == null || typeof v !== 'object') return '—';
    // Walk dotted path: key may be "a.b.c"
    const parts = String(key).split('.');
    let cur = v;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return '—';
      cur = cur[p];
    }
    if (cur == null) return '—';
    if (typeof cur === 'object') return JSON.stringify(cur);
    return String(cur);
  }

  return (
    <div className="sturm-kpi-panel">
      <div className="sturm-kpi-panel-head">
        <div className="sturm-kpi-score">
          <span className="sturm-kpi-score-label">Score</span>
          <span className="sturm-kpi-score-value">{score.toFixed(2)}</span>
          <span className="sturm-kpi-score-sep">·</span>
          <span className={`sturm-kpi-verdict is-${verdict}`}>{verdict}</span>
        </div>
        <div className="sturm-kpi-panel-meta">
          {report.field_count != null && <span>{fmtInt(report.field_count)} Felder</span>}
          {report.total_duration_ms != null && <span>{fmtDur(report.total_duration_ms)}</span>}
        </div>
      </div>

      <div className="sturm-kpi-bars">
        <ScoreBar label="schema_coverage" value={c.schema_coverage ?? report.schema_coverage} />
        <ScoreBar label="format_conformance" value={c.format_conformance ?? report.format_conformance} />
        <ScoreBar label="cross_branch_agreement" value={c.cross_branch_agreement ?? 0} />
        <ScoreBar label="speed" value={c.speed ?? 0} />
      </div>

      {branchKeys.length > 0 && (
        <table className="sturm-kpi-table">
          <thead>
            <tr><th>Branch</th><th>ms</th><th>Felder</th><th>Coverage</th><th>Conformance</th><th>Score</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {branchKeys.map(k => {
              const b = cb.per_branch[k];
              const isBest = bestBranch?.k === k;
              return (
                <tr key={k} className={isBest ? 'is-best' : ''}>
                  <td><span className="sturm-branch-tag">{k}</span>{b.error && <span className="sturm-kpi-err" title={b.error}> err</span>}</td>
                  <td>{fmtDur(b.ms)}</td>
                  <td>{fmtInt(b.fields ?? 0)}</td>
                  <td>{(b.schema_coverage ?? 0).toFixed(2)}</td>
                  <td>{(b.format_conformance ?? 0).toFixed(2)}</td>
                  <td>{branchScore(b).toFixed(2)}</td>
                  <td>{b.cost_usd != null ? `$${Number(b.cost_usd).toFixed(4)}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {cb && (cb.disputed_keys?.length || 0) > 0 && (
        <div className="sturm-kpi-disputed">
          <button className="sturm-kpi-disputed-head" onClick={() => setDisputedOpen(o => !o)}>
            <span className="sturm-kpi-disputed-chev">{disputedOpen ? '▾' : '▸'}</span>
            <span>Disputed keys</span>
            <span className="sturm-kpi-disputed-count">{cb.disputed_keys.length}</span>
          </button>
          {disputedOpen && (
            <div className="sturm-kpi-disputed-body">
              {cb.disputed_keys.map(key => (
                <div key={key} className="sturm-disputed-row">
                  <div className="sturm-disputed-key">{key}</div>
                  <div className="sturm-disputed-values">
                    {branchKeys.map(bk => (
                      <div key={bk} className="sturm-disputed-val">
                        <span className="sturm-branch-tag">{bk}</span>
                        <span className="sturm-disputed-v">{valueFor(bk, key)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   App
   ------------------------------------------------------------ */
function App() {
  const [theme, setTheme] = useState(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workflows, setWorkflows] = useState([]);
  const [workflow, setWorkflow] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [file, setFile] = useState(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('idle');
  const [runId, setRunId] = useState(null);
  const [events, setEvents] = useState([]);
  const [stageStates, setStageStates] = useState({});
  const [stageKpis, setStageKpis] = useState({}); // { [stageId]: { kpis, progress, _prog } }
  const [selectedStage, setSelectedStage] = useState(null);
  const [drawerCollapsed, setDrawerCollapsed] = useState(true);
  const [branchStates, setBranchStates] = useState({}); // { [fanoutStageId]: { [branchId]: {state, ms, error} } }
  const [kpiReport, setKpiReport] = useState(null);
  const [fanoutOutput, setFanoutOutput] = useState(null); // { branches, perBranchMs, errors }

  // Workflow-ID aus URL — akzeptiert ?workflow= UND ?wf= (Alias, vom Designer benutzt)
  const wfIdFromUrl = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('workflow') || p.get('wf') || 'hello-ocr';
  }, []);

  const [issues, setIssues] = useState([]);

  // Node-Positionen-Overrides — der Operator kann Stages umsortieren, das wird
  // pro Workflow in localStorage gehalten und vor dem auto-layout angewandt.
  const [nodePosOverrides, setNodePosOverrides] = useState({});

  // Issues pro Workflow persistieren
  useEffect(() => {
    if (!workflow) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`sturm-issues:${workflow.id}`) || '[]');
      setIssues(saved);
    } catch { setIssues([]); }
    // Position-Overrides pro Workflow laden (separater Key so Issues & Layout unabhängig sind)
    try {
      const layoutSaved = JSON.parse(localStorage.getItem(`sturm-layout:${workflow.id}`) || '{}');
      setNodePosOverrides(layoutSaved && typeof layoutSaved === 'object' ? layoutSaved : {});
    } catch { setNodePosOverrides({}); }
  }, [workflow?.id]);
  useEffect(() => {
    if (!workflow) return;
    localStorage.setItem(`sturm-issues:${workflow.id}`, JSON.stringify(issues));
  }, [issues, workflow?.id]);

  useEffect(() => {
    setDrawerCollapsed(true);
  }, [workflow?.id]);

  // Operator-dragged node positions get persisted per workflow. Container nodes
  // (id prefixed with "container:") share the same map.
  const handleNodeDragStop = useCallback((_event, node) => {
    if (!workflow || !node?.id || !node.position) return;
    setNodePosOverrides(prev => {
      const next = { ...prev, [node.id]: { x: node.position.x, y: node.position.y } };
      try { localStorage.setItem(`sturm-layout:${workflow.id}`, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [workflow]);

  const resetLayout = useCallback(() => {
    if (!workflow) return;
    setNodePosOverrides({});
    try { localStorage.removeItem(`sturm-layout:${workflow.id}`); } catch {}
  }, [workflow]);

  // Fallback: when a run completes and we missed live SSE for kpi/fanout
  // (e.g. user reloads, or events arrived before listeners), pull artefacts.
  useEffect(() => {
    if (!workflow || !runId) return;
    const kpiStage = workflow.stages.find(s => s.uses === 'eval/kpi');
    const fanoutStage = workflow.stages.find(s => s.uses === 'compare/fanout');
    const headers = authHeaders();
    if (kpiStage && !kpiReport) {
      fetch(`/api/runs/${encodeURIComponent(workflow.id)}/${encodeURIComponent(runId)}/stages/${encodeURIComponent(kpiStage.id)}/output`, { headers })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j) setKpiReport(j); })
        .catch(() => {});
    }
    if (fanoutStage && !fanoutOutput) {
      fetch(`/api/runs/${encodeURIComponent(workflow.id)}/${encodeURIComponent(runId)}/stages/${encodeURIComponent(fanoutStage.id)}/output`, { headers })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j) setFanoutOutput(j); })
        .catch(() => {});
    }
  }, [workflow, runId, status]);

  useEffect(() => {
    if (events.length > 0 || issues.length > 0) setDrawerCollapsed(false);
  }, [events.length, issues.length]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('sturm-theme', theme);
  }, [theme]);

  useEffect(() => { window.lucide && window.lucide.createIcons(); });

  // Workflows laden
  useEffect(() => {
    (async () => {
      try {
        const [listResp, wfResp] = await Promise.all([
          fetch('/api/workflows', { headers: authHeaders() }).then(r => r.json()),
          fetch(`/api/workflows/${encodeURIComponent(wfIdFromUrl)}`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null),
        ]);
        setWorkflows(listResp || []);
        if (!wfResp) {
          setLoadError(`Workflow "${wfIdFromUrl}" nicht gefunden.`);
          // Falls ein anderer existiert, den ersten laden
          if (listResp?.[0]) setWorkflow(listResp[0]);
        } else {
          setWorkflow(wfResp);
        }
      } catch (e) {
        setLoadError(`API nicht erreichbar: ${e.message}`);
      }
    })();
  }, [wfIdFromUrl]);

  const layout = useMemo(() => workflow ? layoutWorkflow(workflow) : null, [workflow]);

  const stageUsesById = useMemo(() => {
    if (!workflow) return {};
    const m = {};
    for (const s of workflow.stages) m[s.id] = s.uses;
    return m;
  }, [workflow]);

  const nodes = useMemo(() => {
    if (!workflow || !layout) return [];
    const stageNodes = workflow.stages.map(s => {
      const isFanout = s.uses === 'compare/fanout';
      const branchesMap = branchStates[s.id] || {};
      const branches = Object.keys(branchesMap).map(id => ({ id, ...branchesMap[id] }));
      // User-overrides gewinnen über das auto-Layout.
      const pos = nodePosOverrides[s.id] || layout.positions[s.id] || { x: 0, y: 0 };
      return {
        id: s.id,
        type: isFanout ? 'fanout' : 'stage',
        position: pos,
        data: {
          label: s.name,
          sub: s.description || s.uses,
          state: stageStates[s.id]?.state,
          ms: stageStates[s.id]?.ms,
          kpis: stageKpis[s.id]?.kpis || [],
          progress: stageKpis[s.id]?.progress || null,
          branches: isFanout ? branches : undefined,
        },
        draggable: true,
      };
    });
    // Container nodes (read-only catalog artifacts referenced by stages)
    const containerNodes = (workflow.containers || []).map((c, idx) => ({
      id: `container:${c.id}`,
      type: 'container',
      // Containers float to the left of the stage row by default; layout-system can override
      position: layout.containerPositions?.[c.id] || { x: -300, y: -60 + idx * 220 },
      data: {
        label: c.displayName || c.id,
        sub: c.description,
        lockState: c.lockState || (c.anchorBlock ? 'anchored' : 'sealed'),
        atomsCount: c.atomsCount,
        anlagenCount: c.anlagenCount,
        embeddingDim: c.embeddingDim,
        merkleRoot: c.merkleRoot,
        issuerFingerprint: c.issuerFingerprint,
        anchorBlock: c.anchorBlock,
        anchorUrl: c.anchorUrl,
        schemaVersion: c.schemaVersion,
        containerId: c.id,
      },
      draggable: true, // operator can move containers around the canvas
    }));
    return [...stageNodes, ...containerNodes];
  }, [workflow, layout, stageStates, stageKpis, branchStates]);

  const edges = useMemo(() => {
    if (!workflow) return [];
    const stageEdges = workflow.edges.map(([a, b]) => ({
      id: `${a}-${b}`,
      source: a, target: b,
      animated: stageStates[a]?.state === 'running' || stageStates[b]?.state === 'running',
      style: { stroke: 'var(--color-border)', strokeWidth: 1.5 },
      markerEnd: { type: 'arrowclosed', color: 'var(--color-border)' },
    }));
    // Reference-edges: container -> stage (dashed, gold). One per readBy entry.
    const containerEdges = (workflow.containers || []).flatMap(c =>
      (c.readBy || []).map(stageId => ({
        id: `ref:${c.id}->${stageId}`,
        source: `container:${c.id}`,
        target: stageId,
        animated: false,
        data: { kind: 'reference' },
        style: {
          stroke: 'var(--color-accent-gold, #d4a574)',
          strokeWidth: 1.2,
          strokeDasharray: '4 4',
          opacity: 0.6,
        },
        markerEnd: { type: 'arrowclosed', color: 'var(--color-accent-gold, #d4a574)' },
      }))
    );
    return [...stageEdges, ...containerEdges];
  }, [workflow, stageStates]);

  async function start() {
    if (!workflow || !file) return;
    setRunning(true); setStatus('running');
    setRunId(null); setEvents([]); setStageStates({}); setStageKpis({});
    setBranchStates({}); setKpiReport(null); setFanoutOutput(null);

    const onEvent = (name, env) => {
      const t = new Date().toLocaleTimeString();
      setEvents(prev => [...prev, { t, name, stageId: env.stageId, payload: env.payload }]);
      if (name === 'run_meta') {
        setRunId(env.runId);
      } else if (name === 'stage_start') {
        setStageStates(prev => ({ ...prev, [env.stageId]: { state: 'running' } }));
      } else if (name === 'stage_done') {
        setStageStates(prev => ({ ...prev, [env.stageId]: { state: 'ok', ms: env.payload?.ms } }));
      } else if (name === 'stage_error') {
        setStageStates(prev => ({ ...prev, [env.stageId]: { state: 'error', ms: env.payload?.ms } }));
      } else if (name === 'stage_skipped') {
        setStageStates(prev => ({ ...prev, [env.stageId]: { state: 'skipped' } }));
      } else if (name === 'run_done') {
        setStatus('ok');
      } else if (name === 'run_error') {
        setStatus('error');
      } else if (name === 'fanout_started' && env.stageId) {
        const sid = env.stageId;
        const init = {};
        for (const b of (env.payload?.branches || [])) init[b] = { state: 'pending' };
        setBranchStates(prev => ({ ...prev, [sid]: init }));
      } else if (name === 'branch_started' && env.stageId) {
        const sid = env.stageId, bid = env.payload?.branchId;
        if (bid) setBranchStates(prev => ({
          ...prev,
          [sid]: { ...(prev[sid] || {}), [bid]: { ...(prev[sid]?.[bid] || {}), state: 'running' } },
        }));
      } else if (name === 'branch_done' && env.stageId) {
        const sid = env.stageId, bid = env.payload?.branchId;
        if (bid) setBranchStates(prev => ({
          ...prev,
          [sid]: { ...(prev[sid] || {}), [bid]: { state: 'done', ms: env.payload?.ms } },
        }));
      } else if (name === 'branch_error' && env.stageId) {
        const sid = env.stageId, bid = env.payload?.branchId;
        if (bid) setBranchStates(prev => ({
          ...prev,
          [sid]: { ...(prev[sid] || {}), [bid]: { state: 'error', ms: env.payload?.ms, error: env.payload?.error } },
        }));
      } else if (name === 'kpi_report') {
        setKpiReport(env.payload || null);
      } else if (name === 'stage_done' && env.stageId && stageUsesById[env.stageId] === 'compare/fanout') {
        if (env.payload?.output) setFanoutOutput(env.payload.output);
      }

      // KPIs pro Stage aus stage-gebundenem Event anreichern
      if (env.stageId) {
        const uses = stageUsesById[env.stageId];
        if (uses) {
          setStageKpis(prev => ({
            ...prev,
            [env.stageId]: applyKpiEvent(uses, prev[env.stageId] || { kpis: [], progress: null }, name, env.payload),
          }));
        }
      }
    };

    try {
      await streamRun(workflow.id, file, onEvent);
    } catch (e) {
      setStatus('error');
      setEvents(prev => [...prev, {
        t: new Date().toLocaleTimeString(), name: 'client_error', payload: e.message,
      }]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="sturm-app">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(c => !c)}
        workflows={workflows}
        activeId={workflow?.id}
        workflow={workflow}
        file={file}
        onFile={setFile}
        onStart={start}
        running={running}
      />

      <div className="sturm-main">
        <TopBar
          workflow={workflow}
          status={status}
          runId={runId}
          collapsedSidebar={sidebarCollapsed}
          onOpenSidebar={() => setSidebarCollapsed(false)}
          theme={theme}
          onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        />

        {loadError && (
          <div style={{
            margin: '10px 14px', padding: '10px 14px',
            background: 'rgba(212, 160, 160, 0.15)',
            border: '1px solid rgba(212, 160, 160, 0.5)',
            borderRadius: 'var(--radius-lg)', color: 'var(--color-danger)',
            fontSize: 13,
          }}>{loadError}</div>
        )}

        <div className="sturm-canvas" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {workflow ? (
            <>
              <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <RF.ReactFlowProvider>
                  <FlowViewportManager
                    workflowId={workflow.id}
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    drawerCollapsed={drawerCollapsed}
                    onNodeClick={(_e, n) => {
                      setSelectedStage(n.id);
                      setDrawerCollapsed(false);
                    }}
                    onNodeDragStop={handleNodeDragStop}
                  />
                  {Object.keys(nodePosOverrides).length > 0 && (
                    <button
                      type="button"
                      onClick={resetLayout}
                      title="Eigene Node-Positionen verwerfen und automatisches Layout wiederherstellen"
                      style={{
                        position: 'absolute', top: 10, right: 10, zIndex: 5,
                        height: 26, padding: '0 10px',
                        fontSize: 11.5,
                        fontFamily: 'var(--font-inter)',
                        color: 'var(--color-text-secondary)',
                        background: 'var(--color-bg-secondary)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                      }}
                    >
                      Layout zurücksetzen
                    </button>
                  )}
                </RF.ReactFlowProvider>
              </div>
              {kpiReport && <KpiPanel report={kpiReport} fanoutOutput={fanoutOutput} />}
            </>
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              {loadError ? loadError : 'Workflow wird geladen …'}
            </div>
          )}
        </div>
      </div>

      <Drawer
        events={events}
        issues={issues}
        setIssues={setIssues}
        workflowId={workflow?.id}
        workflow={workflow}
        stageStates={stageStates}
        stageKpis={stageKpis}
        selectedStage={selectedStage}
        runId={runId}
        stageUses={stageUsesById}
        collapsed={drawerCollapsed}
        onToggleCollapsed={setDrawerCollapsed}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
