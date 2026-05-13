/* global React, ReactDOM, ReactFlow */
const { useState, useEffect, useMemo, useRef, useCallback } = React;
const RF = window.ReactFlow;

function authHeaders() {
  const tok = localStorage.getItem('sturm-token');
  return tok ? { 'Authorization': `Bearer ${tok}` } : {};
}

// Query-string form of the bearer token — for URLs handed to non-fetch
// consumers (img/iframe/PDF.js worker) that cannot set request headers.
// Returns empty string if no token (server treats local-dev as un-gated).
function authTokenQuery() {
  const tok = localStorage.getItem('sturm-token');
  return tok ? `?token=${encodeURIComponent(tok)}` : '';
}

// Count primitive leaf-values (string/number/boolean) in a JSON tree,
// ignoring annotation siblings (keys starting with `_`). Used to display
// the field-flow rate (in → out) on each stage node so the graph shows
// where data expands/contracts.
function countFieldLeaves(node) {
  if (node == null) return 0;
  if (Array.isArray(node)) {
    let s = 0;
    for (const v of node) s += countFieldLeaves(v);
    return s;
  }
  if (typeof node === 'object') {
    let total = 0;
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        if (String(v).length === 0) continue;
        total += 1;
      } else if (v && typeof v === 'object') {
        total += countFieldLeaves(v);
      }
    }
    return total;
  }
  return 0;
}

// Pick the most representative subtree from an arbitrary stage output, so
// the field-counter behaves uniformly across the Quality-Trias + adjacent
// stages without needing per-stage knowledge.
function representativeOutputTree(output) {
  if (!output || typeof output !== 'object') return null;
  return output.extracted_with_spans
      ?? output.extracted_with_codes
      ?? output.validated
      ?? output.extracted
      ?? null;
}

// Resolve a workflow input-template (`"${stageId.field.sub}"`) against the
// per-stage outputs we have on hand. The runner does the same substitution
// at run-time; this is the read-only inspector flavour for the UI.
function resolveInputRef(ref, stageOutputs) {
  if (ref == null) return { kind: 'literal', value: ref };
  if (typeof ref !== 'string') return { kind: 'literal', value: ref };
  const m = ref.match(/^\$\{([^}]+)\}$/);
  if (!m) return { kind: 'literal', value: ref };
  const expr = m[1].trim();
  // First segment names the source stage (or "input" for the workflow input).
  const parts = expr.split('.');
  const [stageId, ...path] = parts;
  let cur = stageOutputs?.[stageId];
  if (cur == null) return { kind: 'pending', ref: expr };
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return { kind: 'missing', ref: expr, partial: cur };
    cur = cur[p];
  }
  return { kind: 'resolved', ref: expr, value: cur };
}

// Short, glanceable preview of any value for the inspector's input-table.
function valuePreview(value) {
  if (value == null) return '—';
  if (typeof value === 'string') {
    const trimmed = value.length > 240 ? value.slice(0, 240) + '…' : value;
    return trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} Elemente]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => !k.startsWith('_'));
    return `{${keys.length} Felder}`;
  }
  return String(value);
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
      {(data.fieldsIn != null || data.fieldsOut != null) && (
        <div className="sturm-node-flow" title="Business-Felder (primitive Leaf-Werte) rein → raus, ohne Audit-Annotationen">
          <span className="sturm-node-flow-in">
            {data.fieldsIn != null ? data.fieldsIn : '·'}
          </span>
          <span className="sturm-node-flow-arrow">→</span>
          <span className="sturm-node-flow-out">
            {data.fieldsOut != null ? data.fieldsOut : '·'}
          </span>
          <span className="sturm-node-flow-label">Felder</span>
        </div>
      )}
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

  // ────────────────────────────────────────────────────────────────────────
  // elster-v5 / v5.1 / v5.2 family — Regex-First + LLM-Lückenfüller + BMF
  // ────────────────────────────────────────────────────────────────────────

  // Phase 1: 4-/3-Faktor Regex über die Felder-Kataloge der erkannten Anlagen
  'elster-v5/phase1-regex': (acc, name, p) => {
    if (name === 'phase1_done') {
      const hits = p?.totalHits ?? 0;
      const miss = p?.totalMissing ?? 0;
      const an = p?.anlagen ?? 0;
      const ratio = hits + miss > 0 ? (hits / (hits + miss)) * 100 : 0;
      return {
        kpis: [
          { label: 'Hits', value: fmtInt(hits), tone: hits > 0 ? 'ok' : 'warn' },
          { label: 'Miss', value: fmtInt(miss) },
          { label: 'Coverage', value: `${ratio.toFixed(0)}%`, tone: ratio >= 30 ? 'ok' : 'warn' },
          { label: 'Anlagen', value: fmtInt(an), tone: 'accent' },
        ],
        progress: null,
      };
    }
    return acc;
  },

  // Phase 3: vLLM Gemma-4 strict-JSON Lückenfüller pro Anlage
  'elster-v5/phase3-llm-fill': (acc, name, p) => {
    const st = acc._st || { total: 0, done: 0, filled: 0 };
    if (name === 'phase3_start') {
      st.total = p?.anlagen ?? 0;
      return { _st: st, kpis: [{ label: 'Anlagen', value: `0/${st.total}`, tone: 'accent' }], progress: { value: 0 } };
    }
    if (name === 'phase3_anlage_done') {
      st.done += 1;
      st.filled += p?.filled ?? 0;
      return {
        _st: st,
        kpis: [
          { label: 'Anlagen', value: `${st.done}/${st.total}`, tone: 'accent' },
          { label: 'Felder LLM', value: fmtInt(st.filled), tone: 'ok' },
        ],
        progress: st.total > 0 ? { value: st.done / st.total } : null,
      };
    }
    if (name === 'phase3_done' || (name === 'stage_done' && p?.output?.totalFilled != null)) {
      const filled = p?.totalFilled ?? p?.output?.totalFilled ?? st.filled;
      return {
        _st: st,
        kpis: [{ label: 'Felder LLM', value: fmtInt(filled), tone: filled > 0 ? 'ok' : 'warn' }],
        progress: null,
      };
    }
    return acc;
  },

  // Phase 4: Layer-2 Disambiguierung — Mini-Calls pro PFLICHT-Restfeld
  'elster-v5_1/phase4-entity-disambig': (acc, name, p) => {
    const st = acc._st || { todo: 0, filled: 0, skipped: 0 };
    if (name === 'phase4_start') {
      st.todo = p?.tasks ?? 0;
      return { _st: st, kpis: [{ label: 'Disambig', value: `0/${st.todo}`, tone: 'accent' }], progress: { value: 0 } };
    }
    if (name === 'phase4_field_fill') {
      st.filled += 1;
      return {
        _st: st,
        kpis: [{ label: 'Disambig', value: `${st.filled}/${st.todo}`, tone: 'ok' }],
        progress: st.todo > 0 ? { value: (st.filled + st.skipped) / st.todo } : null,
      };
    }
    if (name === 'phase4_field_skip') {
      st.skipped += 1;
      return { _st: st, kpis: [{ label: 'Disambig', value: `${st.filled}/${st.todo}`, tone: 'accent' }], progress: st.todo > 0 ? { value: (st.filled + st.skipped) / st.todo } : null };
    }
    if (name === 'phase4_done' || (name === 'stage_done' && p?.output?.totalFilled != null)) {
      const filled = p?.totalFilled ?? p?.output?.totalFilled ?? st.filled;
      return {
        _st: st,
        kpis: [{ label: 'Layer-2 fills', value: fmtInt(filled), tone: filled > 0 ? 'ok' : 'accent' }],
        progress: null,
      };
    }
    return acc;
  },

  // Phase 5: Canonical Merge — vereint phase1 (regex) + phase3+4 (llm)
  'elster-v5/phase5-merge': (acc, name, p) => {
    if (name === 'phase5_done' || (name === 'stage_done' && p?.output?.canonical_layer)) {
      const total = p?.total ?? Object.keys(p?.output?.canonical_layer ?? {}).length;
      const fromR = p?.from_regex ?? p?.output?.stats?.from_regex ?? 0;
      const fromL = p?.from_llm ?? p?.output?.stats?.from_llm ?? 0;
      return {
        kpis: [
          { label: 'Total', value: fmtInt(total), tone: total > 0 ? 'ok' : 'warn' },
          { label: 'Regex', value: fmtInt(fromR), tone: 'accent' },
          { label: 'LLM', value: fmtInt(fromL) },
        ],
        progress: null,
      };
    }
    return acc;
  },

  // Phase 6: Lane-1 BMF Steuerberechnung — eingehende eCodes → berechnete
  'elster-v5_2/bmf-rechner-compute': (acc, name, p) => {
    if (name === 'bmf_rechner_start') {
      return { kpis: [{ label: 'BMF MCP', value: 'läuft', tone: 'accent' }], progress: { value: 0.1 } };
    }
    if (name === 'bmf_rechner_compute') {
      return acc;
    }
    if (name === 'bmf_rechner_done' || (name === 'stage_done' && p?.output?.stats)) {
      const decl = p?.declared ?? p?.output?.stats?.declared_in ?? 0;
      const comp = p?.computed ?? p?.output?.stats?.computed_out ?? 0;
      return {
        kpis: [
          { label: 'eCodes in', value: fmtInt(decl), tone: 'accent' },
          { label: 'berechnet', value: fmtInt(comp), tone: comp > 0 ? 'ok' : 'warn' },
        ],
        progress: null,
      };
    }
    if (name === 'kpi_warning' && p?.stage === 'bmf-rechner-compute') {
      return { kpis: [{ label: 'BMF', value: 'unreachable', tone: 'warn' }], progress: null };
    }
    return acc;
  },

  // Felder-Katalog: Container-Lookup, eCodes pro erkannter Anlage
  'elster-v4/felder-katalog': (acc, name, p) => {
    if (name === 'stage_done' && p?.output) {
      const o = p.output;
      return {
        kpis: [
          { label: 'Anlagen', value: fmtInt(Object.keys(o.per_anlage || {}).length), tone: 'accent' },
          { label: 'Felder', value: fmtInt(o.total_felder ?? 0), tone: 'ok' },
        ],
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
          aria-label="Datei für Workflow-Lauf hochladen"
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

function Drawer({ events, issues, setIssues, workflowId, workflow, stageStates, stageKpis, selectedStage, runId, stageUses, collapsed, onToggleCollapsed, resultModel,
                  previousRuns, compareRunId, onCompareChange, diffModel,
                  pdfAvailable, pdfShown, onTogglePdf, hoverPath, onHoverPath }) {
  const [tab, setTab] = useState('events');
  const [autoFlipped, setAutoFlipped] = useState(false);
  // Auto-flip to result when:
  //  - replay: resultModel arrives via fetch and we never touched the tab
  //  - live run: run_done event seen + resultModel present
  useEffect(() => {
    if (autoFlipped || tab !== 'events' || !resultModel) return;
    const liveDone = events.some(e => e.name === 'run_done');
    const isReplay = events.length === 0; // no live SSE → must be replay
    if (liveDone || isReplay) {
      setTab('result');
      setAutoFlipped(true);
    }
  }, [resultModel, events.length, tab, autoFlipped]);
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
          <button className={`sturm-drawer-tab ${tab === 'result' ? 'is-active' : ''}`} onClick={() => openTab('result')} title="Ergebnis">
            <i data-lucide="table-2"></i>
            {!collapsed && <>Ergebnis {resultModel && <span className="sturm-badge sturm-badge-muted">{resultModel.meta.totalFields}</span>}</>}
            {collapsed && resultModel && <span className="sturm-badge sturm-badge-muted">{resultModel.meta.totalFields}</span>}
          </button>
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

      {!collapsed && tab === 'result' && (
        <div className="sturm-drawer-body">
          <ResultPanel
            model={resultModel}
            runId={runId}
            workflowId={workflowId}
            previousRuns={previousRuns}
            compareRunId={compareRunId}
            onCompareChange={onCompareChange}
            diffModel={diffModel}
            pdfAvailable={pdfAvailable}
            pdfShown={pdfShown}
            onTogglePdf={onTogglePdf}
            hoverPath={hoverPath}
            onHoverPath={onHoverPath}
          />
        </div>
      )}

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
              aria-label="Neuer Issue"
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
   Result-Model — joins quality-trias outputs into per-field rows
   for the "Ergebnis" tab. Pure function; no React deps.

   Inputs: artefacts from container-field-mapper, span-linker,
   cross-validator, critic. Output: { groups[{ key, label, rows[] }],
   meta }. Each row = one extracted leaf, fully decorated for display.
   ------------------------------------------------------------ */
const GROUP_LABELS = {
  arbeitnehmer: 'Arbeitnehmer',
  arbeitgeber:  'Arbeitgeber',
  lohn:         'Lohn (Anlage N)',
  versorgungsbezug: 'Versorgungsbezug',
  sozialversicherung: 'Sozialversicherung (Anlage VOR)',
  zeitraum:     'Bescheinigungszeitraum',
  bescheinigung: 'Bescheinigung',
};
function groupLabel(key) {
  return GROUP_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '));
}

/**
 * Container-aware value formatter — drives display formatting from the
 * BMF atom's `formatRegex` and `formatkennzeichen` rather than hardcoded
 * datentyp branches. Examples:
 *
 *   Bruttoarbeitslohn (regex `\d{1,12}`, no comma) →  "69.292 €"   (rounded, no cents)
 *   Solidaritätszuschlag (regex `\d{1,12},\d{2}`)  →  "0,00 €"     (2 decimals)
 *   IDNr                                             →  "8523 674 9007"
 *   Datum (ISO)                                      →  "01.01.2024"
 */
function formatValue(value, datentyp, formatRegex) {
  if (value == null) return '—';
  const s = String(value);
  if (!s.length) return '—';

  const isCurrency = datentyp === 'currency'
    || datentyp === 'GeldBetrag'
    || datentyp === 'geldbetrag';

  // Decimals expected iff regex permits a comma+digits OR a dot+digits.
  const allowsDecimals = formatRegex
    ? /,\\d|,\d|\.\\d|\.\d/.test(formatRegex)
    : true; // fallback: assume decimals if no regex available

  if (isCurrency) {
    const n = typeof value === 'number'
      ? value
      : Number(s.replace(/[€\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    if (isFinite(n)) {
      const opts = allowsDecimals
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { minimumFractionDigits: 0, maximumFractionDigits: 0 };
      // Round (not truncate) when no decimals — matches ELSTER convention.
      const rounded = allowsDecimals ? n : Math.round(n);
      return rounded.toLocaleString('de-DE', opts) + ' €';
    }
  }
  if (datentyp === 'idnr' || datentyp === 'identifikationsnummer') {
    const m = s.replace(/\s+/g, '').match(/^(\d{4})(\d{3})(\d{4})$/);
    if (m) return `${m[1]} ${m[2]} ${m[3]}`;
  }
  if (datentyp === 'date' || datentyp === 'Datum') {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  }
  if (datentyp === 'boolean' || typeof value === 'boolean') {
    return value ? 'ja' : 'nein';
  }
  return s;
}

/**
 * Render the raw extraction value into every form the ELSTER submission
 * could accept under its `formatRegex`. The container's `formatRegex`
 * describes the SUBMISSION shape (often integer euros, e.g. `\d{1,5}`),
 * not the human-readable OCR form like "6.544,01 €". Coercion drives
 * formatValid; without it, every Euro-Wert with a decimal would flag.
 */
function canonicalSubmissionForms(value, datentyp, formatRegex) {
  const raw = value == null ? '' : String(value);
  const out = new Set([raw, raw.trim()]);
  const dt = datentyp || '';
  const isCurrency = dt === 'currency' || dt === 'GeldBetrag' || dt === 'geldbetrag';
  if (isCurrency) {
    const cleaned = raw.replace(/[€$£\s]/g, '');
    // Detect German format (last comma after last dot) → US-normalize.
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    let n;
    if (typeof value === 'number') n = value;
    else if (cleaned.includes(',') && lastDot < lastComma) {
      n = Number(cleaned.replace(/\./g, '').replace(',', '.'));
    } else n = Number(cleaned);
    if (isFinite(n)) {
      const intStr = String(Math.trunc(n));
      const intRound = String(Math.round(n));
      const dec = n.toFixed(2);
      const decGer = dec.replace('.', ',');
      out.add(intStr);
      out.add(intRound);
      out.add(dec);
      out.add(decGer);
      // Negative variants — the regex sometimes allows a leading `-`.
      if (n < 0) {
        out.add(intStr);   // already negative
      }
    }
  } else if (dt === 'date' || dt === 'date-iso' || dt === 'date-de' || dt === 'Datum') {
    // ISO ↔ German
    const m1 = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m1) { out.add(`${m1[1]}-${m1[2]}-${m1[3]}`); out.add(`${m1[3]}.${m1[2]}.${m1[1]}`); }
    const m2 = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m2) {
      const d = m2[1].padStart(2, '0'), mo = m2[2].padStart(2, '0');
      out.add(`${d}.${mo}.${m2[3]}`);
      out.add(`${m2[3]}-${mo}-${d}`);
    }
  } else if (dt === 'iban' || dt === 'IBAN' || dt === 'idnr' || dt === 'identifikationsnummer') {
    out.add(raw.replace(/\s+/g, '').toUpperCase());
    out.add(raw.replace(/\s+/g, ''));
  }
  return Array.from(out).filter(s => s.length > 0);
}

/**
 * Walk extracted_with_codes (output of container-field-mapper) and flatten
 * into rows. The sibling _meta_<leaf> / _span_<leaf> / _ecode_<leaf> keys
 * embed everything we need on the leaf's parent.
 */
/**
 * v5/v5.1 Result-Model — baut rows[] aus phase5-merge.canonical_layer.
 * Shape kompatibel mit PdfSidePanel.hoverPath-Highlighting.
 * row.span.snippet = evidence_line von phase1Regex → besserer Search-Needle
 * als der bare value (currency-Werte sind oft mehrdeutig im Dokument).
 */
function buildResultModelFromCanonical({ phase5Merge, workflow }) {
  if (!phase5Merge || !phase5Merge.canonical_layer) return null;
  const canonical = phase5Merge.canonical_layer; // { eCode → CanonicalValue }
  const stats = phase5Merge.stats || {};
  const rows = [];
  for (const [eCode, cv] of Object.entries(canonical)) {
    const path = `${cv.anlage || 'X'}.${eCode}`;
    rows.push({
      path,
      group: cv.anlage || 'X',
      leaf: eCode,
      label: cv.drucktext || eCode,
      value: cv.value,
      formatted: cv.normalized != null ? String(cv.normalized) : (cv.value != null ? String(cv.value) : ''),
      ecode: eCode,
      anlage: cv.anlage,
      vordruckzeile: cv.vordruckzeile,
      datentyp: cv.datentyp,
      pflicht: null,
      formatRegex: null,
      formatValid: null,
      // PdfSidePanel reads span.snippet first (long, unique) then falls back to value
      span: cv.evidence_line ? { snippet: cv.evidence_line, page: null, origin: cv.origin } : null,
      issues: [],
      violations: [],
      matchMethod: cv.origin, // REGEX_100% | REGEX_3F | LLM_FSM
      anleitung: null,
    });
  }
  // Group by Anlage
  const groupsMap = new Map();
  for (const row of rows) {
    const arr = groupsMap.get(row.group) || [];
    arr.push(row);
    groupsMap.set(row.group, arr);
  }
  const groups = Array.from(groupsMap.entries()).map(([key, rs]) => ({
    key, label: key, rows: rs,
  }));
  return {
    rows,
    groups,
    meta: {
      totalFields: rows.length,
      spanLinked: rows.filter(r => r.span).length,
      flagged: 0,
      fromRegex: stats.from_regex ?? rows.filter(r => r.matchMethod !== 'LLM_FSM').length,
      fromLlm: stats.from_llm ?? rows.filter(r => r.matchMethod === 'LLM_FSM').length,
      source: 'phase5-merge',
      dokumenttypId: null,
      workflowId: workflow?.id || null,
    },
  };
}

function buildResultModel({ fieldMapper, spanLinker, crossValidator, critic, workflow, kpiReport }) {
  if (!fieldMapper) return null;
  // Walk the decorated tree, collecting leaves with their sibling meta/span
  const rows = [];
  const issuesByField = new Map();
  const violationsByField = new Map();
  if (critic?.per_field_issues) {
    for (const iss of critic.per_field_issues) {
      const arr = issuesByField.get(iss.field) || [];
      arr.push(iss);
      issuesByField.set(iss.field, arr);
    }
  }
  if (crossValidator?.violations) {
    for (const v of crossValidator.violations) {
      const arr = violationsByField.get(v.field) || [];
      arr.push(v);
      violationsByField.set(v.field, arr);
    }
  }
  // The decorated tree is the most useful source — has _meta_<k> and (if span_linker ran) _span_<k>
  // We prefer span_linker's output as the root, because it carries the _span_ siblings AND the meta.
  const root = spanLinker?.extracted_with_spans || fieldMapper.extracted_with_codes || fieldMapper.extracted;

  function walk(node, path) {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, path ? `${path}[${i}]` : `[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      const obj = node;
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue; // skip annotation siblings
        const childPath = path ? `${path}.${k}` : k;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          // Pull sibling meta + span from this object scope
          const meta = obj[`_meta_${k}`] || {};
          const span = obj[`_span_${k}`] || null;
          const ecode = obj[`_ecode_${k}`] || meta.ecode || null;
          const dataType = meta.datentyp || null;
          const group = childPath.split('.')[0];
          const fmtRegex = meta.formatRegex || null;
          // The container's formatRegex describes the ELSTER SUBMISSION shape
          // (e.g. integer euros for "ohne Cent"-fields), NOT the human-readable
          // OCR form. Coerce the raw value to its canonical submission shape
          // before testing — otherwise "6.544,01" always fails a `\d{1,5}` regex
          // even though the field is valid (it'd be submitted as 6544).
          let formatValid = null;
          if (fmtRegex) {
            const candidates = canonicalSubmissionForms(v, dataType, fmtRegex);
            try {
              const re = new RegExp(fmtRegex);
              formatValid = candidates.some(c => re.test(c));
            } catch { formatValid = null; }
          }
          const fieldIssues = issuesByField.get(childPath) || [];
          const fieldViolations = violationsByField.get(childPath) || [];
          // Also match issues that cite the eCode in their field-path slot (critic emits "lohn.bruttoarbeitslohn" already, but be defensive)
          rows.push({
            path: childPath,
            group,
            leaf: k,
            label: meta.drucktext || k.replace(/_/g, ' '),
            value: v,
            formatted: formatValue(v, dataType, fmtRegex),
            ecode,
            anlage: meta.anlage,
            vordruckzeile: meta.vordruckzeile,
            datentyp: dataType,
            pflicht: meta.pflicht,
            formatRegex: fmtRegex,
            formatValid,
            span,
            issues: fieldIssues,
            violations: fieldViolations.filter(x => x.severity === 'block' || x.severity === 'warn'),
            matchMethod: meta.matchMethod,
            anleitung: meta.anleitung,
          });
        }
        walk(v, childPath);
      }
    }
  }
  walk(root, '');

  // Group by first path-segment, preserving insertion order
  const groupsMap = new Map();
  for (const row of rows) {
    const arr = groupsMap.get(row.group) || [];
    arr.push(row);
    groupsMap.set(row.group, arr);
  }
  const groups = Array.from(groupsMap.entries()).map(([key, rows]) => ({
    key, label: groupLabel(key), rows,
  }));

  const spanLinked = rows.filter(r => r.span).length;
  const flagged = rows.filter(r => r.issues.length > 0 || r.violations.length > 0).length;

  // ── Summary derivation: doc-type, person, key amounts ──────────────────────
  const rowByPath = new Map(rows.map(r => [r.path, r]));
  const findRow = (suffix) => {
    // exact path or end-with-segment match
    if (rowByPath.has(suffix)) return rowByPath.get(suffix);
    for (const r of rows) {
      if (r.path === suffix || r.path.endsWith('.' + suffix) || r.leaf === suffix) return r;
    }
    return null;
  };
  // Doc-type from workflow's field-mapper stage config
  const fieldMapperStage = workflow?.stages?.find?.(s => s.uses === 'quality/container-field-mapper');
  const dokumenttypId = fieldMapper?.dokumenttyp_id
    || fieldMapperStage?.config?.dokumenttyp_id
    || null;
  const dokumenttypLabel = (() => {
    if (!dokumenttypId) return null;
    return String(dokumenttypId)
      .split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  })();
  // Pull required-fields from kpi config in workflow def, fallback to defaults
  const kpiStage = workflow?.stages?.find?.(s => s.uses === 'eval/kpi');
  const requiredFields = (kpiStage?.config?.requiredFields)
    || ['steuer_id', 'bruttoarbeitslohn', 'lohnsteuer_einbehalten'];
  const keyAmounts = requiredFields.map(f => findRow(f)).filter(Boolean).map(r => ({
    label: r.label,
    formatted: r.formatted,
    valid: r.formatValid,
    span: r.span,
    datentyp: r.datentyp,
  }));
  const person = {
    familienname: findRow('familienname')?.value || findRow('nachname')?.value || null,
    vorname:      findRow('vorname')?.value || null,
    steuer_id:    findRow('steuer_id')?.formatted || findRow('idnr')?.formatted || null,
  };

  return {
    groups,
    rows,                                     // flat list (for Export-CSV + Diff)
    extracted: fieldMapper?.extracted || null,// raw extracted tree (clean, no annotations)
    extractedAudit: spanLinker?.extracted_with_spans
                 || fieldMapper?.extracted_with_codes
                 || fieldMapper?.extracted || null, // with _ecode_/_meta_/_span_ siblings
    summary: { dokumenttypId, dokumenttypLabel, person, keyAmounts },
    meta: {
      workflowName: workflow?.name || workflow?.id || '—',
      totalFields: rows.length,
      spanLinked,
      flagged,
      criticScore: critic?.score,
      criticAccept: critic?.accept,
      validatorPass: crossValidator?.pass,
      spanCoverage: typeof spanLinker?.coverage === 'number' ? spanLinker.coverage : null,
      kpiScore: typeof kpiReport?.score === 'number' ? kpiReport.score : null,
      kpiPass: typeof kpiReport?.pass === 'boolean' ? kpiReport.pass : null,
    },
  };
}

/* ─── Helpers for Export / JSON-Viewer / Diff ─────────────────────────────── */

// Strip `_ecode_*`, `_meta_*`, `_span_*` annotation siblings from a tree.
function stripAnnotations(node) {
  if (Array.isArray(node)) return node.map(stripAnnotations);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('_')) continue;
      out[k] = stripAnnotations(v);
    }
    return out;
  }
  return node;
}

// Trigger a client-side download.
function downloadBlob(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// CSV-quote a single cell.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Flatten resultModel rows to CSV string.
function rowsToCsv(rows) {
  const head = ['path', 'label', 'ecode', 'anlage', 'vordruckzeile', 'value_formatted', 'datentyp', 'pflicht', 'formatValid', 'page', 'snippet'];
  const lines = [head.join(';')];
  for (const r of rows) {
    lines.push([
      r.path, r.label, r.ecode || '', r.anlage || '', r.vordruckzeile || '',
      r.formatted, r.datentyp || '', r.pflicht ? '1' : '',
      r.formatValid === true ? '1' : r.formatValid === false ? '0' : '',
      r.span?.page ?? '', r.span?.snippet || '',
    ].map(csvCell).join(';'));
  }
  return lines.join('\n');
}

// Minimal JSON syntax-highlight → HTML string (no library, ~30 lines).
function jsonToHtml(node, depth = 0, opts = {}) {
  const ind = '  '.repeat(depth);
  if (node === null) return '<span class="sturm-json-null">null</span>';
  if (typeof node === 'boolean') return `<span class="sturm-json-bool">${node}</span>`;
  if (typeof node === 'number') return `<span class="sturm-json-num">${node}</span>`;
  if (typeof node === 'string') return `<span class="sturm-json-str">${JSON.stringify(node)}</span>`;
  if (Array.isArray(node)) {
    if (node.length === 0) return '[]';
    const items = node.map(v => ind + '  ' + jsonToHtml(v, depth + 1, opts)).join(',\n');
    return `[\n${items}\n${ind}]`;
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node);
    if (keys.length === 0) return '{}';
    const lines = keys.map(k => {
      const dim = k.startsWith('_') ? ' sturm-json-key--dim' : '';
      return `${ind}  <span class="sturm-json-key${dim}">${JSON.stringify(k)}</span>: ${jsonToHtml(node[k], depth + 1, opts)}`;
    });
    return `{\n${lines.join(',\n')}\n${ind}}`;
  }
  return String(node);
}

// Per-run diff: { added[], removed[], changed[], unchanged[] } over flat row paths.
function buildDiffModel(current, previous) {
  if (!current || !previous) return null;
  const aByPath = new Map(current.rows.map(r => [r.path, r]));
  const bByPath = new Map(previous.rows.map(r => [r.path, r]));
  const allPaths = new Set([...aByPath.keys(), ...bByPath.keys()]);
  const items = [];
  for (const p of allPaths) {
    const a = aByPath.get(p);
    const b = bByPath.get(p);
    let kind;
    if (a && !b) kind = 'added';
    else if (!a && b) kind = 'removed';
    else if (String(a.value) !== String(b.value)) kind = 'changed';
    else kind = 'unchanged';
    items.push({
      path: p,
      kind,
      group: (a || b).group,
      label: (a || b).label,
      ecode: (a || b).ecode,
      current: a ? a.formatted : null,
      previous: b ? b.formatted : null,
    });
  }
  // Group by first segment, preserving current's group order
  const groupsMap = new Map();
  for (const it of items) {
    const arr = groupsMap.get(it.group) || [];
    arr.push(it);
    groupsMap.set(it.group, arr);
  }
  const groups = Array.from(groupsMap.entries()).map(([k, rows]) => ({ key: k, label: groupLabel(k), rows }));
  const changed = items.filter(i => i.kind === 'changed').length;
  const added = items.filter(i => i.kind === 'added').length;
  const removed = items.filter(i => i.kind === 'removed').length;
  return {
    groups,
    counts: { changed, added, removed, unchanged: items.length - changed - added - removed },
    deltas: {
      kpi: numDelta(current.meta.kpiScore, previous.meta.kpiScore),
      coverage: numDelta(current.meta.spanCoverage, previous.meta.spanCoverage),
      critic: numDelta(current.meta.criticScore, previous.meta.criticScore),
    },
  };
}

function numDelta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return { current: a, previous: b, diff: a - b };
}

/* ------------------------------------------------------------
   SummaryCard — Doc-Profile, person chips, key amounts, KPI badge.
   ------------------------------------------------------------ */
function SummaryCard({ summary, meta }) {
  if (!summary) return null;
  const { dokumenttypLabel, person, keyAmounts } = summary;
  // Show only when we have at least one signal
  if (!dokumenttypLabel && !person.familienname && !person.vorname && !person.steuer_id && keyAmounts.length === 0 && meta.kpiScore == null) {
    return null;
  }
  const kpiTone = meta.kpiScore == null ? null
    : meta.kpiScore >= 0.85 ? 'ok'
    : meta.kpiScore >= 0.70 ? 'warn'
    : 'err';
  return (
    <div className="sturm-result-card">
      <div className="sturm-result-card-main">
        {dokumenttypLabel && <div className="sturm-result-card-doctype">{dokumenttypLabel}</div>}
        {(person.vorname || person.familienname || person.steuer_id) && (
          <div className="sturm-result-card-person">
            {(person.vorname || person.familienname) && (
              <span className="sturm-result-card-chip">
                {[person.vorname, person.familienname].filter(Boolean).join(' ')}
              </span>
            )}
            {person.steuer_id && (
              <span className="sturm-result-card-chip" title="Steuer-Identifikationsnummer">
                IDNr {person.steuer_id}
              </span>
            )}
          </div>
        )}
        {keyAmounts.length > 0 && (
          <div className="sturm-result-card-amounts">
            {keyAmounts.map((a, i) => (
              <div key={i} className={`sturm-result-card-amount ${a.valid === false ? 'is-invalid' : ''}`}>
                <div className="sturm-result-card-amount-label">{a.label}</div>
                <div className="sturm-result-card-amount-value">{a.formatted}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sturm-result-card-side">
        {meta.kpiScore != null && (
          <div className={`sturm-result-card-kpi tone-${kpiTone}`}>
            <div className="sturm-result-card-kpi-num">{(meta.kpiScore * 100).toFixed(1)}%</div>
            <div className="sturm-result-card-kpi-label">KPI</div>
          </div>
        )}
        <div className="sturm-result-card-stats">
          {meta.spanCoverage != null && <span>Quelle <strong>{(meta.spanCoverage * 100).toFixed(0)}%</strong></span>}
          {meta.criticScore != null && <span>Critic <strong>{(meta.criticScore * 100).toFixed(0)}%</strong> {meta.criticAccept ? '✓' : '✗'}</span>}
          {meta.validatorPass != null && <span>Validator {meta.validatorPass ? '✓' : '✗'}</span>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   ExportBar — Download JSON / Audit-JSON / CSV. Diff-Run-Picker if previous.
   ------------------------------------------------------------ */
function ExportBar({ model, runId, workflowId, previousRuns, compareRunId, onCompareChange }) {
  const doExport = (kind) => {
    const base = runId ? `${workflowId}-${runId}` : `${workflowId}`;
    if (kind === 'json') {
      downloadBlob(`${base}.json`, 'application/json',
        JSON.stringify(stripAnnotations(model.extracted ?? {}), null, 2));
    } else if (kind === 'audit') {
      downloadBlob(`${base}-audit.json`, 'application/json',
        JSON.stringify(model.extractedAudit ?? {}, null, 2));
    } else if (kind === 'csv') {
      downloadBlob(`${base}.csv`, 'text/csv;charset=utf-8',
        '﻿' + rowsToCsv(model.rows));
    }
  };
  const otherRuns = (previousRuns || []).filter(r => r.runId !== runId && r.state === 'ok');
  return (
    <div className="sturm-result-export">
      <div className="sturm-result-export-buttons">
        <button className="sturm-btn sturm-btn-ghost sturm-btn-xs" onClick={() => doExport('json')} title="Sauberes JSON ohne Audit-Annotationen">JSON ↓</button>
        <button className="sturm-btn sturm-btn-ghost sturm-btn-xs" onClick={() => doExport('audit')} title="JSON inkl. _ecode_/_meta_/_span_ Annotationen">Audit-JSON ↓</button>
        <button className="sturm-btn sturm-btn-ghost sturm-btn-xs" onClick={() => doExport('csv')} title="Flache CSV mit eCode + Anlage + Span">CSV ↓</button>
      </div>
      {otherRuns.length > 0 && (
        <label className="sturm-result-compare">
          <span>Vergleichen mit</span>
          <select value={compareRunId || ''} onChange={e => onCompareChange(e.target.value || null)}>
            <option value="">— kein Vergleich —</option>
            {otherRuns.slice(0, 12).map(r => (
              <option key={r.runId} value={r.runId}>
                {r.runId} · {r.kpiScore != null ? (r.kpiScore * 100).toFixed(0) + '%' : '—'} · {r.state}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   RawJsonViewer — collapsible per-group JSON view.
   ------------------------------------------------------------ */
function RawJsonViewer({ subtree }) {
  const html = useMemo(() => jsonToHtml(subtree ?? null), [subtree]);
  return (
    <pre
      className="sturm-json-viewer"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/* ------------------------------------------------------------
   DiffPanel — pre-result banner + diff rows.
   ------------------------------------------------------------ */
function DiffPanel({ diffModel, compareRunId }) {
  if (!diffModel) return null;
  const { counts, deltas, groups } = diffModel;
  const fmtDelta = (d, asPct) => {
    if (!d) return null;
    const pct = asPct ? '%' : '';
    const sign = d.diff > 0 ? '+' : '';
    const value = asPct ? (d.diff * 100).toFixed(1) : d.diff.toFixed(2);
    const tone = d.diff > 0 ? 'pos' : d.diff < 0 ? 'neg' : 'zero';
    return <span className={`sturm-result-diff-delta tone-${tone}`}>{sign}{value}{pct}</span>;
  };
  return (
    <div className="sturm-result-diff">
      <div className="sturm-result-diff-banner">
        <div className="sturm-result-diff-counts">
          <span className="tone-changed"><strong>{counts.changed}</strong> geändert</span>
          <span className="tone-added"><strong>{counts.added}</strong> neu</span>
          <span className="tone-removed"><strong>{counts.removed}</strong> entfernt</span>
          <span className="tone-unchanged"><strong>{counts.unchanged}</strong> gleich</span>
        </div>
        <div className="sturm-result-diff-deltas">
          {deltas.kpi && <span>KPI {fmtDelta(deltas.kpi, true)}</span>}
          {deltas.coverage && <span>Quelle {fmtDelta(deltas.coverage, true)}</span>}
          {deltas.critic && <span>Critic {fmtDelta(deltas.critic, true)}</span>}
        </div>
        <div className="sturm-result-diff-ref">vs. <code>{compareRunId}</code></div>
      </div>
      {groups.map(group => {
        const interesting = group.rows.filter(r => r.kind !== 'unchanged');
        if (interesting.length === 0) return null;
        return (
          <div key={group.key} className="sturm-result-group">
            <div className="sturm-result-group-head">
              <span className="sturm-result-group-label">{group.label}</span>
              <span className="sturm-result-group-count">{interesting.length} Änderungen</span>
            </div>
            <div className="sturm-result-diff-rows">
              {interesting.map(r => (
                <div key={r.path} className={`sturm-result-diff-row kind-${r.kind}`}>
                  <div className="sturm-result-diff-row-label">
                    <span className="sturm-result-diff-kind">{r.kind === 'added' ? '+' : r.kind === 'removed' ? '−' : '≠'}</span>
                    {r.label}
                    {r.ecode && <span className="sturm-result-cite">{r.ecode}</span>}
                  </div>
                  <div className="sturm-result-diff-row-values">
                    {r.kind !== 'added' && <span className="sturm-result-diff-prev">{r.previous ?? '—'}</span>}
                    {r.kind === 'changed' && <span className="sturm-result-diff-arrow">→</span>}
                    {r.kind !== 'removed' && <span className="sturm-result-diff-curr">{r.current ?? '—'}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------
   StageInspectorPanel — bottom-of-canvas panel that opens when
   a node is clicked. Shows three sections:
     · Eingaben — resolved ${stageId.field} refs with live values
     · Was passiert — description + config
     · Ausgaben — raw output tree (collapsed JSON viewer)
   ------------------------------------------------------------ */
function StageInspectorPanel({ stageId, workflow, stageStates, stageOutputs, stageFieldFlow, stageKpis, onClose }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!stageId || !workflow) return null;
  const stage = workflow.stages.find(s => s.id === stageId);
  if (!stage) return null;
  const state = stageStates[stageId] || {};
  const output = stageOutputs[stageId];
  const flow = stageFieldFlow[stageId];
  const kpis = (stageKpis && stageKpis[stageId]?.kpis) || [];
  const inputs = stage.inputs || {};
  const cfg = stage.config || {};
  // Stage-Definition Metadata (from /api/workflows enrichment):
  // - stage.description  : aus defineStage().description
  // - stage.hints        : { inputs, outputs, inputPorts[], outputPorts[], configExample }
  const hints = stage.hints || {};
  const inputPorts = Array.isArray(hints.inputPorts) ? hints.inputPorts : null;
  const outputPorts = Array.isArray(hints.outputPorts) ? hints.outputPorts : null;

  const stateLabel = {
    idle: 'wartet', running: 'läuft', ok: 'fertig', error: 'fehler', skipped: 'übersprungen',
  }[state.state || 'idle'] || state.state;

  return (
    <div className={`sturm-inspector ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="sturm-inspector-head">
        <button
          type="button"
          className="sturm-inspector-collapse"
          onClick={() => setCollapsed(v => !v)}
          title={collapsed ? 'Aufklappen' : 'Einklappen'}
        >{collapsed ? '▲' : '▼'}</button>
        <div className="sturm-inspector-title">
          <span className="sturm-inspector-pill">Node</span>
          <span className="sturm-inspector-name">{stage.name || stage.id}</span>
          <code className="sturm-inspector-uses">{stage.uses}</code>
        </div>
        <div className="sturm-inspector-meta">
          {state.state && <span className={`sturm-inspector-state is-${state.state}`}>{stateLabel}</span>}
          {state.ms != null && <span className="sturm-inspector-time">{fmtDur(state.ms)}</span>}
          {flow && (flow.in != null || flow.out != null) && (
            <span className="sturm-inspector-flow">
              {flow.in != null ? flow.in : '·'} → {flow.out != null ? flow.out : '·'} Felder
            </span>
          )}
          <button type="button" className="sturm-icon-btn" onClick={onClose} title="Schließen">✕</button>
        </div>
      </div>

      {!collapsed && (
        <div className="sturm-inspector-body">

          {/* ─── Transformation: was die Stage tut + Ports ─── */}
          {(stage.description || inputPorts || outputPorts) && (
            <section className="sturm-inspector-section sturm-inspector-transform">
              <h4>Transformation</h4>
              {stage.description && (
                <p className="sturm-inspector-desc">{stage.description}</p>
              )}
              {(inputPorts || outputPorts) && (
                <div className="sturm-inspector-ports">
                  {inputPorts && inputPorts.length > 0 && (
                    <div className="sturm-inspector-ports-col">
                      <div className="sturm-inspector-ports-label">empfängt</div>
                      <ul className="sturm-inspector-ports-list">
                        {inputPorts.map((p, i) => (
                          <li key={`in-${i}`}>
                            <code>{p.name}</code>
                            {p.type && <span className="sturm-inspector-port-type">{p.type}</span>}
                            {p.description && <span className="sturm-inspector-port-desc"> — {p.description}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {outputPorts && outputPorts.length > 0 && (
                    <div className="sturm-inspector-ports-col">
                      <div className="sturm-inspector-ports-label">produziert</div>
                      <ul className="sturm-inspector-ports-list">
                        {outputPorts.map((p, i) => (
                          <li key={`out-${i}`}>
                            <code>{p.name}</code>
                            {p.type && <span className="sturm-inspector-port-type">{p.type}</span>}
                            {p.description && <span className="sturm-inspector-port-desc"> — {p.description}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ─── KPIs vom laufenden/letzten Run ─── */}
          {kpis.length > 0 && (
            <section className="sturm-inspector-section">
              <h4>KPIs</h4>
              <div className="sturm-inspector-kpis">
                {kpis.map((k, i) => (
                  <div key={i} className={`sturm-inspector-kpi tone-${k.tone || 'default'}`}>
                    <div className="sturm-inspector-kpi-label">{k.label}</div>
                    <div className="sturm-inspector-kpi-value">{k.value}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="sturm-inspector-section">
            <h4>Eingaben</h4>
            {Object.keys(inputs).length === 0 ? (
              <div className="sturm-inspector-empty">Diese Node deklariert keine Eingaben.</div>
            ) : (
              <table className="sturm-inspector-table">
                <thead><tr><th>Key</th><th>Quelle</th><th>Wert</th></tr></thead>
                <tbody>
                  {Object.entries(inputs).map(([k, ref]) => {
                    const r = resolveInputRef(ref, stageOutputs);
                    return (
                      <tr key={k}>
                        <td className="sturm-inspector-key">{k}</td>
                        <td className="sturm-inspector-ref">
                          {r.kind === 'literal' && <em>literal</em>}
                          {r.kind !== 'literal' && <code>{'${' + r.ref + '}'}</code>}
                        </td>
                        <td className="sturm-inspector-val">
                          {r.kind === 'pending'  && <span className="sturm-inspector-val-pending">noch nicht verfügbar</span>}
                          {r.kind === 'missing'  && <span className="sturm-inspector-val-missing">nicht gefunden</span>}
                          {(r.kind === 'literal' || r.kind === 'resolved') && (
                            <span className="sturm-inspector-val-preview" title={typeof r.value === 'string' ? r.value : ''}>
                              {valuePreview(r.value)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          {Object.keys(cfg).length > 0 && (
            <section className="sturm-inspector-section">
              <h4>Konfiguration</h4>
              <pre
                className="sturm-json-viewer"
                style={{ marginLeft: 0, marginRight: 0, maxHeight: 200 }}
                dangerouslySetInnerHTML={{ __html: jsonToHtml(cfg) }}
              />
            </section>
          )}

          <section className="sturm-inspector-section">
            <h4>
              Ausgaben
              {flow?.out != null && <span className="sturm-inspector-tag">{flow.out} Felder</span>}
            </h4>
            {state.error && (
              <div className="sturm-inspector-error">{String(state.error)}</div>
            )}
            {output ? (
              <pre
                className="sturm-json-viewer"
                style={{ marginLeft: 0, marginRight: 0, maxHeight: 280 }}
                dangerouslySetInnerHTML={{ __html: jsonToHtml(output) }}
              />
            ) : state.state === 'running' ? (
              <div className="sturm-inspector-empty">Läuft gerade …</div>
            ) : state.state === 'ok' ? (
              <div className="sturm-inspector-empty">Output wird geladen …</div>
            ) : (
              <div className="sturm-inspector-empty">Noch kein Output — die Stage wurde noch nicht ausgeführt.</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   PdfSidePanel — lazy-loaded PDF.js viewer with hover-highlight.
   Sits to the LEFT of the drawer, doesn't move the canvas — the
   designer area shrinks to make room. Closes via onClose or by
   toggling pdfShown back off.
   ------------------------------------------------------------ */
let __pdfJsPromise = null;
function loadPdfJs() {
  if (__pdfJsPromise) return __pdfJsPromise;
  const CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
  const WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
  __pdfJsPromise = import(/* webpackIgnore: true */ CDN)
    .then(mod => {
      mod.GlobalWorkerOptions.workerSrc = WORKER;
      return mod;
    })
    .catch(err => { __pdfJsPromise = null; throw err; });
  return __pdfJsPromise;
}

function PdfSidePanel({ pdfUrl, hoverPath, resultModel, onClose }) {
  const containerRef = useRef(null);
  const [error, setError] = useState(null);
  // pageState[i] = { canvas, charIndex: [{item, start, end, transform, width, height, fontHeight}] }
  const pageStateRef = useRef([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!pdfUrl || !containerRef.current) return;
    let cancelled = false;
    setError(null);
    setReady(false);
    pageStateRef.current = [];
    const root = containerRef.current;
    root.innerHTML = '';
    loadPdfJs().then(async (pdfjs) => {
      try {
        const loadingTask = pdfjs.getDocument(pdfUrl);
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1.4 });
          const pageWrap = document.createElement('div');
          pageWrap.className = 'sturm-pdf-page';
          pageWrap.style.width = viewport.width + 'px';
          pageWrap.style.height = viewport.height + 'px';
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          pageWrap.appendChild(canvas);
          const overlay = document.createElement('div');
          overlay.className = 'sturm-pdf-overlay';
          pageWrap.appendChild(overlay);
          root.appendChild(pageWrap);
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          const textContent = await page.getTextContent();
          // Build a cumulative char-index across the page (matches OCR markdown order roughly).
          const charIndex = [];
          let cursor = 0;
          for (const item of textContent.items) {
            const str = item.str || '';
            // pdfjs transform: [a, b, c, d, e, f] — e,f are x,y; width/height in viewport units
            charIndex.push({
              start: cursor,
              end: cursor + str.length,
              str,
              transform: item.transform,
              width: item.width,
              height: item.height,
            });
            cursor += str.length;
            // newline as soft-break — approximate; OCR text differs anyway
            if (item.hasEOL) cursor += 1;
          }
          pageStateRef.current.push({ wrap: pageWrap, overlay, viewport, charIndex, totalChars: cursor });
        }
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      }
    }).catch(e => { if (!cancelled) setError('PDF.js konnte nicht geladen werden'); });
    return () => { cancelled = true; };
  }, [pdfUrl]);

  // Hover-highlight: when hoverPath changes, search across pages for the row's
  // value and draw overlay rects on every match. Scroll the FIRST match into
  // view. The span.page hint from OCR is used as a search-priority bias, not
  // a hard filter — OCR page-indexing can drift from the PDF text-layer.
  useEffect(() => {
    if (!ready) return;
    // Clear all overlays first.
    for (const ps of pageStateRef.current) ps.overlay.innerHTML = '';
    if (!hoverPath || !resultModel) return;
    const row = resultModel.rows.find(r => r.path === hoverPath);
    if (!row) return;
    // v5/v5.1: prefer the OCR evidence_line (snippet) — it's longer and more
    // unique than the bare value, which is critical for currency/dates that
    // appear many times in a multi-doc bundle. Fall back to row.value.
    const snippet = (row.span && typeof row.span.snippet === 'string') ? row.span.snippet.trim() : '';
    const valueStr = (row.value != null ? String(row.value) : '').trim();
    const target = snippet || valueStr;
    if (!target) return;
    const needle = target.toLowerCase();

    // Search-order: indicated page first, then the rest. Picks up matches
    // wherever they actually live in the PDF text-layer.
    const order = [];
    const hintIdx = row.span && typeof row.span.page === 'number' && row.span.page > 0
      ? row.span.page - 1
      : -1;
    if (hintIdx >= 0 && hintIdx < pageStateRef.current.length) order.push(hintIdx);
    for (let i = 0; i < pageStateRef.current.length; i++) {
      if (i !== hintIdx) order.push(i);
    }

    let firstHitPageWrap = null;
    let firstHitTopInPage = null;

    for (const pIdx of order) {
      const ps = pageStateRef.current[pIdx];
      if (!ps) continue;
      const fullText = ps.charIndex.map(ci => ci.str).join('');
      const fullLower = fullText.toLowerCase();

      // Find all occurrences on this page (not just first). Important for
      // values like "0" or "01.01.2024" which may appear in many rows.
      let from = 0;
      const ranges = [];
      while (true) {
        const at = fullLower.indexOf(needle, from);
        if (at < 0) break;
        ranges.push([at, at + needle.length]);
        from = at + Math.max(1, needle.length);
      }
      if (ranges.length === 0) continue;

      // For each range, walk through items, accumulating char offsets, and
      // draw a rect for each item that overlaps the range.
      for (const [hitStart, hitEnd] of ranges) {
        let off = 0;
        for (const item of ps.charIndex) {
          const itemStart = off;
          const itemEnd = off + item.str.length;
          off = itemEnd;
          if (itemEnd <= hitStart || itemStart >= hitEnd) continue;
          const [, , , d, e, f] = item.transform;
          const w = item.width;
          const h = item.height || Math.abs(d) || 12;
          const [vx1, vy1, vx2, vy2] = ps.viewport.convertToViewportRectangle([e, f, e + w, f + h]);
          const left = Math.min(vx1, vx2);
          const top = Math.min(vy1, vy2);
          const width = Math.abs(vx2 - vx1);
          const height = Math.abs(vy2 - vy1);
          const box = document.createElement('div');
          box.className = 'sturm-pdf-hit';
          box.style.left = left + 'px';
          box.style.top = top + 'px';
          box.style.width = width + 'px';
          box.style.height = height + 'px';
          ps.overlay.appendChild(box);
          if (firstHitPageWrap == null) {
            firstHitPageWrap = ps.wrap;
            firstHitTopInPage = top;
          }
        }
      }
      // Stop after the first page that produced any match — keeps the
      // highlight focused on one page rather than scattering across many.
      if (firstHitPageWrap) break;
    }

    if (firstHitPageWrap && firstHitPageWrap.parentElement) {
      const scroller = firstHitPageWrap.parentElement;
      const containerRect = scroller.getBoundingClientRect();
      const pageRect = firstHitPageWrap.getBoundingClientRect();
      const hitTopAbs = pageRect.top + (firstHitTopInPage || 0) - containerRect.top + scroller.scrollTop;
      scroller.scrollTo({ top: Math.max(0, hitTopAbs - 80), behavior: 'smooth' });
    }
  }, [hoverPath, ready, resultModel]);

  return (
    <aside className="sturm-pdf-side">
      <div className="sturm-pdf-side-head">
        <span>PDF</span>
        <button className="sturm-icon-btn" onClick={onClose} title="Schließen">✕</button>
      </div>
      {error && <div className="sturm-pdf-side-error">PDF konnte nicht geladen werden: {error}</div>}
      <div className="sturm-pdf-side-pages" ref={containerRef} />
    </aside>
  );
}

/* ------------------------------------------------------------
   ResultPanel — Card + Export + (Diff?) + grouped tables with JSON-toggle.
   ------------------------------------------------------------ */
function ResultPanel({ model, runId, workflowId, previousRuns, compareRunId, onCompareChange, diffModel,
                      pdfAvailable, pdfShown, onTogglePdf, hoverPath, onHoverPath }) {
  const [openPath, setOpenPath] = useState(null);
  const [rawJsonGroup, setRawJsonGroup] = useState({}); // { [groupKey]: bool }
  if (!model) {
    return (
      <div style={{ padding: 18, textAlign: 'center', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
        Noch kein Ergebnis. Starte den Workflow — extrahierte Werte erscheinen hier nach dem Lauf.
      </div>
    );
  }
  if (model.groups.length === 0) {
    return (
      <div style={{ padding: 18, textAlign: 'center', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
        Lauf abgeschlossen, aber keine extrahierten Felder. Prüfe den Events-Tab nach Fehlern.
      </div>
    );
  }
  return (
    <div className="sturm-result-panel">
      <SummaryCard summary={model.summary} meta={model.meta} />
      <ExportBar
        model={model}
        runId={runId}
        workflowId={workflowId}
        previousRuns={previousRuns}
        compareRunId={compareRunId}
        onCompareChange={onCompareChange}
      />
      {onTogglePdf && (
        <div className="sturm-result-toolbar">
          <button
            className={`sturm-btn sturm-btn-ghost sturm-btn-xs ${pdfShown ? 'is-active' : ''}`}
            onClick={onTogglePdf}
            disabled={!pdfAvailable}
            title={pdfAvailable ? 'PDF neben den Feldern anzeigen' : 'PDF-Viewer nicht verfügbar (kein PDF-Input oder PDF.js nicht geladen)'}
          >
            {pdfShown ? '← PDF ausblenden' : 'PDF anzeigen →'}
          </button>
        </div>
      )}
      <div className="sturm-result-meta">
        <span><strong>{model.meta.totalFields}</strong> Felder</span>
        <span><strong>{model.meta.spanLinked}</strong> ✓ Quelle</span>
        {model.meta.flagged > 0 && <span style={{ color: 'var(--color-amber)' }}>⚠ <strong>{model.meta.flagged}</strong> markiert</span>}
      </div>
      {diffModel
        ? <DiffPanel diffModel={diffModel} compareRunId={compareRunId} />
        : model.groups.map(group => {
            const isJson = !!rawJsonGroup[group.key];
            const toggleJson = () => setRawJsonGroup(m => ({ ...m, [group.key]: !m[group.key] }));
            const subtree = isJson ? (model.extractedAudit?.[group.key] ?? null) : null;
            return (
              <div key={group.key} className="sturm-result-group">
                <div className="sturm-result-group-head">
                  <span className="sturm-result-group-label">{group.label}</span>
                  <span className="sturm-result-group-count">{group.rows.length} Felder</span>
                  <button
                    type="button"
                    className={`sturm-result-group-jsonbtn ${isJson ? 'is-active' : ''}`}
                    onClick={toggleJson}
                    title={isJson ? 'Tabellen-Ansicht' : 'Raw JSON anzeigen'}
                  >{isJson ? '⊞' : '⟨/⟩'}</button>
                </div>
                {isJson
                  ? <RawJsonViewer subtree={subtree} />
                  : (
                    <div className="sturm-result-rows">
                      {group.rows.map(row => (
                        <ResultRow
                          key={row.path}
                          row={row}
                          expanded={openPath === row.path}
                          onToggle={() => setOpenPath(openPath === row.path ? null : row.path)}
                          onHover={onHoverPath}
                          hovered={hoverPath === row.path}
                        />
                      ))}
                    </div>
                  )}
              </div>
            );
          })}
    </div>
  );
}

function ResultRow({ row, expanded, onToggle, onHover, hovered }) {
  const hasIssues = row.issues.length > 0 || row.violations.length > 0;
  const sevTone = (() => {
    if (row.issues.some(i => i.severity === 'block') || row.violations.some(v => v.severity === 'block')) return 'err';
    if (hasIssues) return 'warn';
    return null;
  })();
  // Compact citation, only when we have one: "E0200201 · N Z.5"
  const cite = row.ecode
    ? `${row.ecode}${row.anlage ? ` · ${row.anlage}` : ''}${row.vordruckzeile ? ` Z.${row.vordruckzeile}` : ''}`
    : null;
  return (
    <div
      className={`sturm-result-row ${expanded ? 'is-expanded' : ''} ${hovered ? 'is-hovered' : ''}`}
      data-tone={sevTone}
      onMouseEnter={onHover ? () => onHover(row.path) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <button type="button" className="sturm-result-row-main" onClick={onToggle}>
        <div className="sturm-result-row-top">
          <span className="sturm-result-row-label">
            {row.label}
            {row.pflicht && <span className="sturm-result-pflicht" title="Pflichtfeld">*</span>}
          </span>
          <span className="sturm-result-row-flags">
            {row.span && <span className="sturm-result-span" title={`Seite ${row.span.page} · Pos ${row.span.charStart}-${row.span.charEnd}`}>🔗</span>}
            {row.formatValid === true && <span className="sturm-result-fmt-ok" title="Format gültig">✓</span>}
            {row.formatValid === false && <span className="sturm-result-fmt-bad" title="Format weicht ab">⚠</span>}
            {hasIssues && <span className="sturm-result-issue-count" title="Critic/Validator-Hinweise">{row.issues.length + row.violations.length}</span>}
          </span>
        </div>
        <div className="sturm-result-row-bottom">
          <span className="sturm-result-row-value">{row.formatted}</span>
          {cite && <span className="sturm-result-cite">{cite}</span>}
        </div>
      </button>
      {expanded && (
        <div className="sturm-result-row-detail">
          {row.span && (
            <div className="sturm-result-detail-snippet">
              <span className="sturm-result-detail-eyebrow">Quellzeile · Seite {row.span.page}</span>
              <code>…{row.span.snippet}…</code>
            </div>
          )}
          <dl className="sturm-result-detail-grid">
            {row.datentyp && (<><dt>Typ</dt><dd>{row.datentyp}</dd></>)}
            {row.formatRegex && (<><dt>Format</dt><dd className="sturm-result-mono-wrap">{row.formatRegex}</dd></>)}
            {row.anleitung && (<><dt>Quelle</dt><dd>{row.anleitung.document} — {row.anleitung.section}</dd></>)}
            {row.matchMethod && (<><dt>Mapping</dt><dd>{row.matchMethod}</dd></>)}
          </dl>
          {row.issues.length > 0 && (
            <div className="sturm-result-issues">
              <div className="sturm-result-issues-head">Critic</div>
              {row.issues.map((i, idx) => (
                <div key={idx} className={`sturm-result-issue sev-${i.severity}`}>
                  <span className="sturm-result-issue-sev">{i.severity}</span>
                  <span>{i.msg}</span>
                </div>
              ))}
            </div>
          )}
          {row.violations.length > 0 && (
            <div className="sturm-result-issues">
              <div className="sturm-result-issues-head">Validator</div>
              {row.violations.map((v, idx) => (
                <div key={idx} className={`sturm-result-issue sev-${v.severity}`}>
                  <span className="sturm-result-issue-sev">{v.kind}</span>
                  <span>{v.msg}</span>
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
        {/* Quality-only composite — speed reported separately as latency info. */}
        <ScoreBar label="schema_coverage" value={c.schema_coverage ?? report.schema_coverage} />
        <ScoreBar label="format_conformance" value={c.format_conformance ?? report.format_conformance} />
        {c.critic != null && <ScoreBar label="critic" value={c.critic} />}
        {c.span_coverage != null && <ScoreBar label="span_coverage" value={c.span_coverage} />}
        {c.validator != null && <ScoreBar label="validator" value={c.validator} />}
        {(c.cross_branch_agreement ?? 0) > 0 && <ScoreBar label="cross_branch_agreement" value={c.cross_branch_agreement} />}
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
  // When replaying a run via URL (?run=…), default to open drawer so the
  // Result-tab is visible immediately.
  const [drawerCollapsed, setDrawerCollapsed] = useState(() => {
    return !new URLSearchParams(location.search).get('run');
  });
  const [branchStates, setBranchStates] = useState({}); // { [fanoutStageId]: { [branchId]: {state, ms, error} } }
  const [kpiReport, setKpiReport] = useState(null);
  const [fanoutOutput, setFanoutOutput] = useState(null); // { branches, perBranchMs, errors }
  // Quality-Trias outputs — fetched after run_done for the Result-tab merge.
  const [qualityArtifacts, setQualityArtifacts] = useState({
    fieldMapper: null,
    spanLinker: null,
    crossValidator: null,
    critic: null,
    phase5Merge: null, // v5/v5.1: canonical_layer source for the Result tab
  });
  // Per-stage raw outputs (lazy-fetched after a stage finishes). Used by
  // the field-flow counter on each StageNode (in → out) and could be reused
  // by any future inspector that wants the same data without re-fetching.
  const [stageOutputs, setStageOutputs] = useState({}); // { [stageId]: outputJson }
  // Result-tab UX extras: previous runs (Diff-dropdown), compare-run data, PDF-Split, Hover-link.
  const [previousRuns, setPreviousRuns] = useState([]);
  const [compareRunId, setCompareRunId] = useState(() => {
    return new URLSearchParams(location.search).get('compare') || null;
  });
  const [compareArtifacts, setCompareArtifacts] = useState({
    fieldMapper: null, spanLinker: null, crossValidator: null, critic: null, kpiReport: null,
  });
  const [inputMeta, setInputMeta] = useState(null); // { filename, mime }
  const [pdfShown, setPdfShown] = useState(false);
  const [hoverPath, setHoverPath] = useState(null);

  // Workflow-ID aus URL — akzeptiert ?workflow= UND ?wf= (Alias, vom Designer benutzt)
  // Replay support: ?run=<runId> loads a completed run's artefacts so the
  // Result-tab can be inspected without re-running. Set ONCE from URL.
  const runIdFromUrl = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('run') || null;
  }, []);
  useEffect(() => {
    if (runIdFromUrl && !runId) setRunId(runIdFromUrl);
  }, [runIdFromUrl]);

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
    // When replaying a run, keep drawer open (the Result-tab is the whole point).
    if (runIdFromUrl) return;
    setDrawerCollapsed(true);
  }, [workflow?.id, runIdFromUrl]);

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
    // Quality-Trias artefacts — needed for the Result tab.
    const fieldMapperStage    = workflow.stages.find(s => s.uses === 'quality/container-field-mapper');
    const spanLinkerStage     = workflow.stages.find(s => s.uses === 'extract/span-linker');
    const crossValidatorStage = workflow.stages.find(s => s.uses === 'extract/cross-validator');
    const criticStage         = workflow.stages.find(s => s.uses === 'eval/critic-llm');
    const fetchArtifact = (stage, key) => {
      if (!stage || qualityArtifacts[key]) return;
      fetch(`/api/runs/${encodeURIComponent(workflow.id)}/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stage.id)}/output`, { headers })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j) setQualityArtifacts(prev => ({ ...prev, [key]: j })); })
        .catch(() => {});
    };
    fetchArtifact(fieldMapperStage, 'fieldMapper');
    fetchArtifact(spanLinkerStage, 'spanLinker');
    fetchArtifact(crossValidatorStage, 'crossValidator');
    fetchArtifact(criticStage, 'critic');
    // v5/v5.1: phase5-merge produces the canonical_layer for citation-verify
    const phase5Stage = workflow.stages.find(s => s.uses === 'elster-v5/phase5-merge');
    fetchArtifact(phase5Stage, 'phase5Merge');
    // Per-stage outputs for the field-flow counter on each node. Only pull
    // for stages that finished OK and we haven't fetched yet. Loop is cheap
    // for small graphs; for big ones the natural state-tick re-entry
    // de-dups via the `stageOutputs[id]` guard.
    for (const s of workflow.stages) {
      if (stageStates[s.id]?.state !== 'ok') continue;
      if (stageOutputs[s.id]) continue;
      fetch(`/api/runs/${encodeURIComponent(workflow.id)}/${encodeURIComponent(runId)}/stages/${encodeURIComponent(s.id)}/output`, { headers })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j) setStageOutputs(prev => prev[s.id] ? prev : ({ ...prev, [s.id]: j })); })
        .catch(() => {});
    }
  }, [workflow, runId, status, stageStates]);

  // Compute per-stage field-flow counts: out = leaves in this stage's
  // representative tree; in = sum of upstream stages' out. Containers don't
  // count as predecessors here — they're configuration, not field-flow.
  const stageFieldFlow = useMemo(() => {
    const flow = {};
    if (!workflow) return flow;
    // First pass: out-count per stage.
    for (const s of workflow.stages) {
      const out = stageOutputs[s.id];
      const tree = representativeOutputTree(out);
      const cnt = tree ? countFieldLeaves(tree) : null;
      flow[s.id] = { in: null, out: cnt };
    }
    // Second pass: in-count = sum of upstream out-counts.
    for (const [from, to] of workflow.edges) {
      if (!flow[to]) continue;
      const u = flow[from]?.out;
      if (typeof u !== 'number') continue;
      flow[to].in = (flow[to].in ?? 0) + u;
    }
    return flow;
  }, [workflow, stageOutputs]);

  // Build the joined result model from the four artefacts.
  // v5/v5.1 fallback: phase5-merge.canonical_layer when no fieldMapper present.
  const resultModel = useMemo(() => {
    if (qualityArtifacts.fieldMapper) {
      return buildResultModel({
        fieldMapper: qualityArtifacts.fieldMapper,
        spanLinker: qualityArtifacts.spanLinker,
        crossValidator: qualityArtifacts.crossValidator,
        critic: qualityArtifacts.critic,
        workflow,
        kpiReport,
      });
    }
    if (qualityArtifacts.phase5Merge) {
      return buildResultModelFromCanonical({
        phase5Merge: qualityArtifacts.phase5Merge,
        workflow,
      });
    }
    return null;
  }, [qualityArtifacts, workflow, kpiReport]);

  // ── Previous-runs listing (for Diff-dropdown) ──
  useEffect(() => {
    if (!workflow) return;
    fetch(`/api/workflows/${encodeURIComponent(workflow.id)}/runs`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(list => setPreviousRuns(Array.isArray(list) ? list : []))
      .catch(() => setPreviousRuns([]));
  }, [workflow, runId]);

  // ── Compare-run artefacts ──
  useEffect(() => {
    if (!workflow || !compareRunId) {
      setCompareArtifacts({ fieldMapper: null, spanLinker: null, crossValidator: null, critic: null, kpiReport: null });
      return;
    }
    const headers = authHeaders();
    const fmStage = workflow.stages.find(s => s.uses === 'quality/container-field-mapper');
    const slStage = workflow.stages.find(s => s.uses === 'extract/span-linker');
    const cvStage = workflow.stages.find(s => s.uses === 'extract/cross-validator');
    const ccStage = workflow.stages.find(s => s.uses === 'eval/critic-llm');
    const kpiStage = workflow.stages.find(s => s.uses === 'eval/kpi');
    const fetchStage = (stage) => stage
      ? fetch(`/api/runs/${encodeURIComponent(workflow.id)}/${encodeURIComponent(compareRunId)}/stages/${encodeURIComponent(stage.id)}/output`, { headers })
          .then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);
    Promise.all([fetchStage(fmStage), fetchStage(slStage), fetchStage(cvStage), fetchStage(ccStage), fetchStage(kpiStage)])
      .then(([fm, sl, cv, cc, kp]) => setCompareArtifacts({
        fieldMapper: fm, spanLinker: sl, crossValidator: cv, critic: cc, kpiReport: kp,
      }));
  }, [workflow, compareRunId]);

  const compareModel = useMemo(() => {
    if (!compareArtifacts.fieldMapper) return null;
    return buildResultModel({
      fieldMapper: compareArtifacts.fieldMapper,
      spanLinker: compareArtifacts.spanLinker,
      crossValidator: compareArtifacts.crossValidator,
      critic: compareArtifacts.critic,
      workflow,
      kpiReport: compareArtifacts.kpiReport,
    });
  }, [compareArtifacts, workflow]);

  const diffModel = useMemo(() => {
    if (!resultModel || !compareModel) return null;
    return buildDiffModel(resultModel, compareModel);
  }, [resultModel, compareModel]);

  // Update URL when compare changes (deeplinkable diff).
  useEffect(() => {
    if (!runId) return;
    const url = new URL(location.href);
    if (compareRunId) url.searchParams.set('compare', compareRunId);
    else url.searchParams.delete('compare');
    history.replaceState(null, '', url.toString());
  }, [compareRunId, runId]);

  // ── Input meta (filename + mime) — used to gate the PDF-toggle ──
  useEffect(() => {
    if (!workflow || !runId) { setInputMeta(null); return; }
    fetch(`/api/runs/${encodeURIComponent(workflow.id)}/${encodeURIComponent(runId)}/_input.json`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(j => setInputMeta(j || null))
      .catch(() => setInputMeta(null));
  }, [workflow, runId]);

  const pdfAvailable = !!inputMeta && (inputMeta.mime === 'application/pdf' || /\.pdf$/i.test(inputMeta.filename || ''));
  const pdfUrl = (pdfAvailable && workflow && runId)
    ? `/api/runs/${encodeURIComponent(workflow.id)}/${encodeURIComponent(runId)}/_input/${encodeURIComponent(inputMeta.filename)}${authTokenQuery()}`
    : null;

  useEffect(() => {
    if (events.length > 0 || issues.length > 0) setDrawerCollapsed(false);
  }, [events.length, issues.length]);

  // Replay: auto-expand drawer once the result-model becomes available
  // (no live events fired the auto-open path).
  useEffect(() => {
    if (resultModel && resultModel.meta.totalFields > 0) setDrawerCollapsed(false);
  }, [resultModel?.meta.totalFields]);

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
          fieldsIn:  stageFieldFlow[s.id]?.in  ?? null,
          fieldsOut: stageFieldFlow[s.id]?.out ?? null,
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
  }, [workflow, layout, stageStates, stageKpis, branchStates, stageFieldFlow, nodePosOverrides]);

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
    setQualityArtifacts({ fieldMapper: null, spanLinker: null, crossValidator: null, critic: null, phase5Merge: null });
    setStageOutputs({});

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
              {selectedStage && (
                <StageInspectorPanel
                  stageId={selectedStage}
                  workflow={workflow}
                  stageStates={stageStates}
                  stageOutputs={stageOutputs}
                  stageFieldFlow={stageFieldFlow}
                  stageKpis={stageKpis}
                  onClose={() => setSelectedStage(null)}
                />
              )}
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
        resultModel={resultModel}
        previousRuns={previousRuns}
        compareRunId={compareRunId}
        onCompareChange={setCompareRunId}
        diffModel={diffModel}
        pdfAvailable={pdfAvailable}
        pdfShown={pdfShown}
        onTogglePdf={() => setPdfShown(v => !v)}
        hoverPath={hoverPath}
        onHoverPath={setHoverPath}
      />
      {pdfShown && pdfUrl && (
        <PdfSidePanel
          pdfUrl={pdfUrl}
          hoverPath={hoverPath}
          resultModel={resultModel}
          onClose={() => setPdfShown(false)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
