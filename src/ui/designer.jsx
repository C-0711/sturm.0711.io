/* global React, ReactDOM, ReactFlow */
/**
 * STURM Workflow-Designer — author WorkflowDef JSON via drag-and-drop.
 *
 * Layout: palette (left) | canvas (middle, ReactFlow) | inspector (right).
 * Persistence endpoints (assumed to exist by the time this ships):
 *   GET    /api/workflows-user            -> { id, name, description, updatedAt }[]
 *   GET    /api/workflows-user/<id>       -> { workflow: WorkflowDef, layout, updatedAt }
 *   POST   /api/workflows-user/<id>       body { workflow, layout }
 *   GET    /api/stages/catalog            -> { id, name, description, category }[]
 *
 * @typedef {Object} CatalogEntry
 * @property {string} id
 * @property {string} name
 * @property {string|null} description
 * @property {string} category
 *
 * @typedef {Object} StageDef
 * @property {string} uses
 * @property {string=} name
 * @property {string=} description
 * @property {Object=} config
 * @property {Object<string,string>=} inputs
 *
 * @typedef {Object} WorkflowDef
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {{type:'file'|'text'|'json', accept?:string[]}} input
 * @property {Object<string,StageDef>} stages
 * @property {Array<[string,string]>} edges
 */

const { useState, useEffect, useMemo, useCallback, useRef, useReducer } = React;
const RF = window.ReactFlow;

const ID_RE = /^[a-z][a-z0-9_]*$/;

/** Virtual node id for the workflow-input source. Never persisted as a stage. */
const SOURCE_ID = '__source__';
const SOURCE_DEFAULT_POS = { x: 80, y: 220 };

/**
 * Output-handle names exposed by the source node, keyed by workflow.input.type.
 * Each handle corresponds to a top-level field on the workflow input payload
 * (see WorkflowInputSpec). Connecting handleX -> stage auto-fills
 * `inputs[handleX] = "${input.handleX}"`.
 */
const SOURCE_HANDLES_BY_TYPE = {
  file: ['filePath', 'filename', 'size', 'mime'],
  text: ['text'],
  json: ['value'],
};
function sourceHandlesFor(inputType) {
  return SOURCE_HANDLES_BY_TYPE[inputType] || SOURCE_HANDLES_BY_TYPE.file;
}

/** Parse "${input.name}" -> "name" (or null if not an input-ref). */
const INPUT_REF_RE = /^\$\{input\.([a-zA-Z_][a-zA-Z0-9_]*)\}$/;
function parseInputRef(v) {
  if (typeof v !== 'string') return null;
  const m = INPUT_REF_RE.exec(v);
  return m ? m[1] : null;
}

function authHeaders() {
  const tok = localStorage.getItem('sturm-token');
  return tok ? { 'Authorization': `Bearer ${tok}` } : {};
}

/* --------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */
function lastSegment(uses) {
  // e.g. "elster-v3/extraktion" -> "extraktion"; "mistral-ocr" -> "mistral-ocr"
  const slash = uses.lastIndexOf('/');
  const base = slash >= 0 ? uses.slice(slash + 1) : uses;
  return base.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
}

function uniqueStageId(uses, existing) {
  const base = lastSegment(uses);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

function tryParseJSON(text, fallback) {
  if (!text || !text.trim()) return { ok: true, value: fallback };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// German labels + canonical ordering for palette + canvas tinting.
// Each category also has a 2-3 letter short tag (CANVAS badge) and a
// Neo-palette accent token used for border/badge color.
const CATEGORY_META = {
  'ocr':          { label: 'OCR',                tag: 'OCR',  accent: 'var(--color-cyan)' },
  'extract':      { label: 'Extraktion',         tag: 'EXT',  accent: 'var(--color-teal)' },
  // Quality-Trias: defensible extraction (Schema-Guard, Critic, Span-Linker, Cross-Validator).
  // Emerald — same hue as success/eval to signal "trust + correctness".
  'quality':      { label: 'Qualität · Audit',   tag: 'QLT',  accent: 'var(--color-emerald)' },
  'analysis':     { label: 'Analyse',            tag: 'ANL',  accent: 'var(--color-violet)' },
  'control-flow': { label: 'Steuerlogik',        tag: 'CF',   accent: 'var(--color-amber)' },
  'evaluation':   { label: 'Evaluation',         tag: 'KPI',  accent: 'var(--color-emerald)' },
  'elster':       { label: 'ELSTER · klassisch', tag: 'ELS',  accent: 'var(--color-orange)' },
  'elster-v3':    { label: 'ELSTER · v3',        tag: 'EL3',  accent: 'var(--color-orange)' },
  'steuerbelege': { label: 'Steuerbelege',       tag: 'STB',  accent: 'var(--color-orange)' },
  'pentacam':     { label: 'Pentacam (Med)',     tag: 'PCM',  accent: 'var(--color-pink)' },
  'myopia':       { label: 'Myopie (Med)',       tag: 'MYO',  accent: 'var(--color-pink)' },
  'general':      { label: 'Sonstige',           tag: '·',    accent: 'var(--color-zinc)' },
};
// Container layout positions are stored in state.layout under this prefix so
// they don't collide with stage IDs (which are user-defined snake_case).
const CONTAINER_KEY_PREFIX = 'container:';
function containerKey(id) { return CONTAINER_KEY_PREFIX + id; }
function isContainerKey(k) { return typeof k === 'string' && k.startsWith(CONTAINER_KEY_PREFIX); }
function containerIdFromKey(k) { return isContainerKey(k) ? k.slice(CONTAINER_KEY_PREFIX.length) : null; }

function categoryLabel(c) { return CATEGORY_META[c]?.label || c; }
function categoryTag(c) { return CATEGORY_META[c]?.tag || c.slice(0, 3).toUpperCase(); }
function categoryAccent(c) { return CATEGORY_META[c]?.accent || 'var(--color-text-tertiary)'; }

const CATEGORY_ORDER = ['ocr', 'extract', 'quality', 'analysis', 'control-flow', 'evaluation', 'elster-v3', 'elster', 'steuerbelege', 'pentacam', 'myopia', 'general'];
/**
 * Topological auto-layout. Returns position map covering all stages + the
 * source-node + all containers. Sources/containers go in a left "rail";
 * stages fan out left→right by topo depth, top-to-bottom within a layer.
 */
function computeAutoLayout(stages, edges, containers) {
  const stageIds = Object.keys(stages);
  if (stageIds.length === 0) return {};

  // Build adjacency
  const indeg = new Map(stageIds.map((id) => [id, 0]));
  const succ = new Map(stageIds.map((id) => [id, []]));
  for (const [a, b] of edges) {
    if (!indeg.has(a) || !indeg.has(b)) continue;
    succ.get(a).push(b);
    indeg.set(b, indeg.get(b) + 1);
  }
  // Kahn layers
  const layers = [];
  let frontier = stageIds.filter((id) => indeg.get(id) === 0);
  const seen = new Set();
  while (frontier.length > 0) {
    layers.push(frontier);
    frontier.forEach((id) => seen.add(id));
    const next = [];
    for (const id of frontier) {
      for (const t of succ.get(id) || []) {
        const d = indeg.get(t) - 1;
        indeg.set(t, d);
        if (d === 0) next.push(t);
      }
    }
    frontier = next;
  }
  // Orphans (cyclic remainders) into a last column.
  for (const id of stageIds) if (!seen.has(id)) {
    if (layers.length === 0) layers.push([]);
    layers[layers.length - 1].push(id);
  }

  const COL_W = 280;
  const ROW_H = 140;
  const ORIGIN_X = 280;   // Stages start right of the source-rail
  const ORIGIN_Y = 80;
  const layout = {};
  layers.forEach((layer, col) => {
    layer.forEach((id, row) => {
      layout[id] = { x: ORIGIN_X + col * COL_W, y: ORIGIN_Y + row * ROW_H };
    });
  });
  // Source rail (left column, single node).
  layout[SOURCE_ID] = { x: 40, y: ORIGIN_Y };
  // Containers stack below the source.
  const cIds = Object.keys(containers || {});
  cIds.forEach((cid, i) => {
    layout[CONTAINER_KEY_PREFIX + cid] = { x: 40, y: ORIGIN_Y + 240 + i * 180 };
  });
  return layout;
}

function compareCategory(a, b) {
  const ia = CATEGORY_ORDER.indexOf(a);
  const ib = CATEGORY_ORDER.indexOf(b);
  return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
}

/* --------------------------------------------------------------------------
   Editor reducer — keeps the WorkflowDef + ReactFlow layout in one shape.
   -------------------------------------------------------------------------- */
const INITIAL_STATE = {
  meta: {
    id: 'mein_workflow',
    name: 'Mein Workflow',
    description: '',
    inputType: 'file',
  },
  /** @type {Object<string, StageDef>} */
  stages: {},
  /**
   * Containers pinned to this workflow. Key is `WorkflowContainerRef.id`
   * (e.g. "0711:elster:bmf:jahresdok-2024:v1"). Each entry is the catalog
   * snapshot plus a `readBy: string[]` of stage IDs that consume it.
   * @type {Object<string, any>}
   */
  containers: {},
  /** @type {Array<[string,string]>} */
  edges: [],
  /** @type {Object<string, {x:number,y:number}>} */
  layout: {},
  selectedId: null,
  selectedEdge: null,
};

function editorReducer(state, action) {
  switch (action.type) {
    case 'set_meta': {
      const next = { ...state, meta: { ...state.meta, ...action.patch } };
      // When inputType changes, prune any stage inputs that reference handle
      // names no longer exposed by the source (e.g. ${input.filePath} after
      // switching from file -> text). The corresponding visible edges are
      // re-derived from inputs in the canvas memo, so no edge cleanup needed.
      if (Object.prototype.hasOwnProperty.call(action.patch, 'inputType')
          && action.patch.inputType !== state.meta.inputType) {
        const allowed = new Set(sourceHandlesFor(action.patch.inputType));
        const stages = {};
        for (const [sid, def] of Object.entries(state.stages)) {
          if (!def.inputs) { stages[sid] = def; continue; }
          let changed = false;
          const nextInputs = {};
          for (const [k, v] of Object.entries(def.inputs)) {
            const ref = parseInputRef(v);
            if (ref && !allowed.has(ref)) { changed = true; continue; }
            nextInputs[k] = v;
          }
          stages[sid] = changed
            ? { ...def, inputs: Object.keys(nextInputs).length ? nextInputs : undefined }
            : def;
        }
        next.stages = stages;
      }
      return next;
    }

    case 'wire_input_to_stage': {
      // Auto-wire from source-node handle -> target stage. Records
      // inputs[handleName] = "${input.handleName}" (merges with existing).
      const { stageId, handleName } = action;
      const prev = state.stages[stageId];
      if (!prev) return state;
      const inputs = { ...(prev.inputs || {}), [handleName]: `\${input.${handleName}}` };
      return {
        ...state,
        stages: { ...state.stages, [stageId]: { ...prev, inputs } },
      };
    }

    case 'set_source_position':
      return { ...state, layout: { ...state.layout, [SOURCE_ID]: action.position } };

    case 'add_stage': {
      const { stageId, stageDef, position } = action;
      return {
        ...state,
        stages: { ...state.stages, [stageId]: stageDef },
        layout: { ...state.layout, [stageId]: position },
        selectedId: stageId,
        selectedEdge: null,
      };
    }

    case 'update_stage': {
      const { stageId, patch } = action;
      const prev = state.stages[stageId];
      if (!prev) return state;
      return {
        ...state,
        stages: { ...state.stages, [stageId]: { ...prev, ...patch } },
      };
    }

    case 'rename_stage': {
      const { oldId, newId } = action;
      if (oldId === newId) return state;
      if (state.stages[newId]) return state; // collision guard
      const stages = {};
      // preserve insertion order — small detail but keeps JSON diff-friendly
      for (const [k, v] of Object.entries(state.stages)) {
        stages[k === oldId ? newId : k] = v;
      }
      const layout = { ...state.layout };
      if (layout[oldId]) {
        layout[newId] = layout[oldId];
        delete layout[oldId];
      }
      const edges = state.edges.map(([a, b]) => [a === oldId ? newId : a, b === oldId ? newId : b]);
      return {
        ...state, stages, layout, edges,
        selectedId: state.selectedId === oldId ? newId : state.selectedId,
      };
    }

    case 'delete_stage': {
      const { stageId } = action;
      const stages = { ...state.stages };
      const layout = { ...state.layout };
      delete stages[stageId];
      delete layout[stageId];
      const edges = state.edges.filter(([a, b]) => a !== stageId && b !== stageId);
      return { ...state, stages, layout, edges, selectedId: null, selectedEdge: null };
    }

    case 'set_position': {
      const { stageId, position } = action;
      return { ...state, layout: { ...state.layout, [stageId]: position } };
    }

    case 'add_edge': {
      const { from, to } = action;
      if (from === to) return state;
      if (state.edges.some(([a, b]) => a === from && b === to)) return state;
      return { ...state, edges: [...state.edges, [from, to]] };
    }

    case 'delete_edge': {
      const { from, to } = action;
      return {
        ...state,
        edges: state.edges.filter(([a, b]) => !(a === from && b === to)),
        selectedEdge: null,
      };
    }

    case 'add_container': {
      // action.ref = full catalog entry. Position is optional; defaults so
      // the container lands left of the canvas (consistent with pipeline.jsx).
      const ref = action.ref;
      if (state.containers[ref.id]) return state; // idempotent: already pinned
      return {
        ...state,
        containers: { ...state.containers, [ref.id]: { ...ref, readBy: [] } },
        layout: { ...state.layout, [containerKey(ref.id)]: action.pos || { x: 40, y: 480 } },
        selectedId: containerKey(ref.id),
        selectedEdge: null,
      };
    }
    case 'delete_container': {
      const { [action.id]: _gone, ...rest } = state.containers;
      const { [containerKey(action.id)]: _pos, ...layoutRest } = state.layout;
      return { ...state, containers: rest, layout: layoutRest, selectedId: null };
    }
    case 'set_container_position':
      return {
        ...state,
        layout: { ...state.layout, [containerKey(action.id)]: action.pos },
      };
    case 'wire_container_to_stage': {
      // Container "edges" are not first-class workflow edges — they live as
      // readBy[] inside the container ref. Toggle membership.
      const c = state.containers[action.containerId];
      if (!c) return state;
      const has = c.readBy.includes(action.stageId);
      const readBy = has
        ? c.readBy.filter((s) => s !== action.stageId)
        : [...c.readBy, action.stageId];
      return {
        ...state,
        containers: { ...state.containers, [action.containerId]: { ...c, readBy } },
      };
    }

    case 'select_node':
      return { ...state, selectedId: action.stageId, selectedEdge: null };

    case 'select_edge':
      return { ...state, selectedId: null, selectedEdge: action.edge };

    case 'deselect':
      return { ...state, selectedId: null, selectedEdge: null };

    case 'load': {
      // action.workflow + action.layout
      const wf = action.workflow;
      // Hydrate containers map from the workflow array (id-keyed for fast lookup).
      const containers = {};
      for (const c of (wf.containers || [])) {
        if (c && c.id) containers[c.id] = { ...c, readBy: c.readBy || [] };
      }
      return {
        ...state,
        meta: {
          id: wf.id || 'workflow',
          name: wf.name || '',
          description: wf.description || '',
          inputType: wf.input?.type || 'file',
        },
        stages: wf.stages || {},
        containers,
        edges: (wf.edges || []).map(([a, b]) => [a, b]),
        layout: action.layout || {},
        selectedId: null,
        selectedEdge: null,
      };
    }

    case 'apply_layout':
      // Wholesale layout swap — used by Auto-Layout. Per-key merge preserves
      // any layout entries not covered by the new map (defensive).
      return { ...state, layout: { ...state.layout, ...action.layout } };

    case 'reset':
      return { ...INITIAL_STATE };

    default:
      return state;
  }
}

/* --------------------------------------------------------------------------
   Stage node — designer-flavored (no live state, just identity)
   -------------------------------------------------------------------------- */
function StageNode({ data, selected }) {
  // data.category is supplied at node-build time from the catalog lookup.
  const cat = data.category || 'general';
  const accent = categoryAccent(cat);
  // data.inputPorts / data.outputPorts may be empty arrays — fall back to a
  // single generic handle so legacy stages still connect normally.
  const inputs = (data.inputPorts && data.inputPorts.length > 0) ? data.inputPorts : null;
  const outputs = (data.outputPorts && data.outputPorts.length > 0) ? data.outputPorts : null;
  return (
    <div
      className="dsg-node"
      data-selected={selected}
      data-category={cat}
      style={{ '--cat-accent': accent }}
    >
      {/* Inputs (left handles) */}
      {inputs ? (
        <div className="dsg-node-ports dsg-node-ports-in">
          {inputs.map((p) => (
            <div key={p.name} className="dsg-node-port-row dsg-node-port-row-in" title={`${p.name} : ${p.type}${p.description ? ' · ' + p.description : ''}`}>
              <RF.Handle id={p.name} type="target" position="left" className="dsg-node-h" />
              <span className="dsg-node-port-name">{p.name}</span>
              <span className="dsg-node-port-type">{p.type}</span>
            </div>
          ))}
        </div>
      ) : (
        <RF.Handle type="target" position="left" style={{ background: 'var(--color-border)', width: 8, height: 8 }} />
      )}

      <div className="dsg-node-cat-badge" title={categoryLabel(cat)}>{categoryTag(cat)}</div>
      <div className="dsg-node-name">{data.label}</div>
      <div className="dsg-node-uses">{data.uses}</div>
      <div className="dsg-node-id">#{data.stageId}</div>

      {/* Outputs (right handles) */}
      {outputs ? (
        <div className="dsg-node-ports dsg-node-ports-out">
          {outputs.map((p) => (
            <div key={p.name} className="dsg-node-port-row dsg-node-port-row-out" title={`${p.name} : ${p.type}${p.description ? ' · ' + p.description : ''}`}>
              <span className="dsg-node-port-type">{p.type}</span>
              <span className="dsg-node-port-name">{p.name}</span>
              <RF.Handle id={p.name} type="source" position="right" className="dsg-node-h" />
            </div>
          ))}
        </div>
      ) : (
        <RF.Handle type="source" position="right" style={{ background: 'var(--color-border)', width: 8, height: 8 }} />
      )}
    </div>
  );
}

/**
 * Virtual source node — represents the workflow input. Never persisted as a
 * stage; lives only as a visual anchor for "where ${input.X} comes from".
 * Each output handle is positioned to align vertically with its label row.
 */
function SourceNode({ data, selected }) {
  const handles = data.handles;
  // Each handle sits in its own row with position:relative; the handle is
  // absolutely-positioned at 50% of the row (vertically centered on the label).
  // This avoids fragile absolute pixel math that breaks as soon as the row
  // padding / font-size / handle count changes.
  return (
    <div className="dsg-source-node" data-selected={selected}>
      <div className="dsg-source-title">📤 Document upload</div>
      <div className="dsg-source-sub">workflow input · {data.inputType}</div>
      <div className="dsg-source-handles">
        {handles.map((h) => (
          <div key={h} className="dsg-source-handle-row">
            {h}
            <RF.Handle
              id={h}
              type="source"
              position="right"
              className="dsg-src-h"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Container node — pinned data assets (gitchain-anchored containers).
   Dashed orange-ish accent; non-stage, non-source. Click to open inspector.
   -------------------------------------------------------------------------- */
function ContainerNode({ data, selected }) {
  return (
    <div className="dsg-container-node" data-selected={selected}>
      <RF.Handle type="source" position="right" className="dsg-container-h" />
      <div className="dsg-container-icon">🗄️</div>
      <div className="dsg-container-title">{data.displayName || data.id}</div>
      {data.kind && <div className="dsg-container-kind">kind: {data.kind}</div>}
      {data.atomsCount != null && (
        <div className="dsg-container-meta">
          <span>{data.atomsCount.toLocaleString('de-DE')} Atoms</span>
          {data.anlagenCount ? <span> · {data.anlagenCount} Anlagen</span> : null}
          {data.embeddingDim ? <span> · {data.embeddingDim}-dim</span> : null}
        </div>
      )}
      <div className="dsg-container-id">{data.id}</div>
      {data.readBy && data.readBy.length > 0 && (
        <div className="dsg-container-readby">
          read by: {data.readBy.join(', ')}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { stage: StageNode, sourceNode: SourceNode, containerNode: ContainerNode };

/* --------------------------------------------------------------------------
   Palette
   -------------------------------------------------------------------------- */
function Palette({ catalog, containerCatalog }) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map();
    for (const e of catalog) {
      if (q && !`${e.id} ${e.name} ${e.description || ''}`.toLowerCase().includes(q)) continue;
      const cat = e.category || 'general';
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat).push(e);
    }
    const out = [];
    for (const cat of [...m.keys()].sort(compareCategory)) {
      const entries = m.get(cat).slice().sort((a, b) => a.name.localeCompare(b.name));
      out.push({ category: cat, entries });
    }
    return out;
  }, [catalog, query]);

  const onDragStart = (e, stage) => {
    e.dataTransfer.setData('application/sturm-stage', JSON.stringify(stage));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <aside className="dsg-palette">
      <input
        className="dsg-palette-search"
        type="search"
        aria-label="Stages durchsuchen"
        placeholder="Stages durchsuchen…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {grouped.length === 0 && (
        <div style={{ padding: '20px 12px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Keine Stages.
        </div>
      )}
      {grouped.map(({ category, entries }) => {
        const isCollapsed = !!collapsed[category];
        return (
          <div key={category}>
            <div
              className="dsg-cat-head"
              data-collapsed={isCollapsed}
              data-category={category}
              style={{ '--cat-accent': categoryAccent(category) }}
              onClick={() => setCollapsed(c => ({ ...c, [category]: !c[category] }))}
            >
              <span>
                <span className="dsg-cat-chev">▾</span>
                <span className="dsg-cat-dot" />
                {categoryLabel(category)}
              </span>
              <span className="dsg-cat-count">{entries.length}</span>
            </div>
            {!isCollapsed && entries.map(e => (
              <div
                key={e.id}
                className="dsg-palette-item"
                draggable
                onDragStart={(ev) => onDragStart(ev, e)}
                title={e.description || e.id}
              >
                <div className="dsg-palette-name">{e.name}</div>
                <div className="dsg-palette-id">{e.id}</div>
                {e.description && <div className="dsg-palette-desc">{e.description}</div>}
              </div>
            ))}
          </div>
        );
      })}

      {/* Datenquellen (gitchain-anchored containers) — separate drag mime type
          so the canvas drop-handler can distinguish stages from containers. */}
      {containerCatalog && containerCatalog.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="dsg-cat-head" data-category="container"
               style={{ '--cat-accent': 'var(--color-orange)' }}>
            <span>
              <span className="dsg-cat-dot" />
              Datenquellen
            </span>
            <span className="dsg-cat-count">{containerCatalog.length}</span>
          </div>
          {containerCatalog.map(c => (
            <div
              key={c.id}
              className="dsg-palette-item"
              draggable
              onDragStart={(ev) => {
                ev.dataTransfer.setData('application/sturm-container', JSON.stringify(c));
                ev.dataTransfer.effectAllowed = 'copy';
              }}
              title={c.description || c.id}
            >
              <div className="dsg-palette-name">🗄️ {c.displayName || c.id}</div>
              <div className="dsg-palette-id">{c.id}</div>
              {c.description && <div className="dsg-palette-desc">{c.description}</div>}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/* --------------------------------------------------------------------------
   Inspector — node editor with JSON validation
   -------------------------------------------------------------------------- */
function Inspector({ state, dispatch, onDelete, catalog }) {
  const { selectedId, selectedEdge, stages } = state;

  if (selectedEdge) {
    return (
      <aside className="dsg-inspector">
        <h3 className="dsg-section-title">Kante</h3>
        <div className="dsg-field-readonly">
          {selectedEdge[0]} → {selectedEdge[1]}
        </div>
        <div className="dsg-inspector-actions">
          <button
            type="button"
            className="dsg-btn dsg-btn-danger"
            onClick={() => dispatch({ type: 'delete_edge', from: selectedEdge[0], to: selectedEdge[1] })}
          >
            Kante löschen
          </button>
        </div>
      </aside>
    );
  }

  if (selectedId === SOURCE_ID) {
    const handles = sourceHandlesFor(state.meta.inputType);
    return (
      <aside className="dsg-inspector">
        <h3 className="dsg-section-title">Workflow-Input</h3>
        <div className="dsg-source-hint">
          Das ist die Eingangsquelle des Workflows. Verbinde ihre rechten Handles
          mit einer Stage, um <code>inputs.${'{input.X}'}</code> automatisch zu setzen.
          Diese Quelle ist nicht löschbar.
        </div>
        <div className="dsg-field" style={{ marginTop: 12 }}>
          <label className="dsg-field-label">Typ</label>
          <div className="dsg-field-readonly">{state.meta.inputType}</div>
        </div>
        <div className="dsg-field">
          <label className="dsg-field-label">Verfügbare Handles</label>
          <div className="dsg-field-readonly">{handles.join(', ')}</div>
        </div>
      </aside>
    );
  }

  // Container inspector — pinned data assets (containers).
  if (selectedId && isContainerKey(selectedId)) {
    const cid = containerIdFromKey(selectedId);
    const c = state.containers?.[cid];
    if (c) return (
      <aside className="dsg-inspector">
        <h3 className="dsg-section-title">Datenquelle</h3>
        <div className="dsg-field">
          <label className="dsg-field-label">Display-Name</label>
          <div className="dsg-field-readonly">{c.displayName || c.id}</div>
        </div>
        <div className="dsg-field">
          <label className="dsg-field-label">Container-ID</label>
          <div className="dsg-field-readonly" style={{ fontSize: 11 }}>{c.id}</div>
        </div>
        {c.description && (
          <div className="dsg-field">
            <label className="dsg-field-label">Beschreibung</label>
            <div className="dsg-field-readonly" style={{ fontFamily: 'var(--font-inter)' }}>{c.description}</div>
          </div>
        )}
        <div className="dsg-hints" style={{ marginTop: 4 }}>
          <div className="dsg-hints-head">Eckdaten</div>
          {c.kind && <div className="dsg-hints-row"><span className="dsg-hints-key">Kind</span><code className="dsg-hints-val">{c.kind}</code></div>}
          {c.atomsCount != null && <div className="dsg-hints-row"><span className="dsg-hints-key">Atome</span><code className="dsg-hints-val">{c.atomsCount}</code></div>}
          {c.anlagenCount != null && <div className="dsg-hints-row"><span className="dsg-hints-key">Anlagen</span><code className="dsg-hints-val">{c.anlagenCount}</code></div>}
          {c.embeddingDim && <div className="dsg-hints-row"><span className="dsg-hints-key">Embeddings</span><code className="dsg-hints-val">{c.embeddingDim}-dim ({c.embeddingModel || '—'})</code></div>}
          {c.schemaVersion && <div className="dsg-hints-row"><span className="dsg-hints-key">Schema</span><code className="dsg-hints-val">v{c.schemaVersion}</code></div>}
          {c.lockState && <div className="dsg-hints-row"><span className="dsg-hints-key">Status</span><code className="dsg-hints-val">{c.lockState}</code></div>}
          {c.merkleRoot && <div className="dsg-hints-row dsg-hints-row-block"><span className="dsg-hints-key">Merkle-Root</span><code className="dsg-hints-val" style={{ wordBreak: 'break-all' }}>{c.merkleRoot}</code></div>}
        </div>
        <div className="dsg-field" style={{ marginTop: 12 }}>
          <label className="dsg-field-label">Verbrauchende Stages</label>
          {c.readBy && c.readBy.length > 0
            ? <div className="dsg-field-readonly">{c.readBy.join(', ')}</div>
            : <div className="dsg-field-hint">Keine — ziehe eine Linie vom Container zu einer Stage</div>
          }
        </div>
        <div className="dsg-inspector-actions">
          <button
            type="button"
            className="dsg-btn dsg-btn-danger"
            onClick={() => dispatch({ type: 'delete_container', id: cid })}
          >Container entfernen</button>
        </div>
      </aside>
    );
  }

  if (!selectedId || !stages[selectedId]) {
    return (
      <aside className="dsg-inspector">
        <div className="dsg-inspector-empty">
          Wähle einen Knoten oder eine Kante,<br/>um Details zu bearbeiten.
        </div>
      </aside>
    );
  }

  return <StageInspector key={selectedId} state={state} dispatch={dispatch} onDelete={onDelete} catalog={catalog} />;
}

function StageInspector({ state, dispatch, onDelete, catalog }) {
  const { selectedId, stages, edges } = state;
  const def = stages[selectedId];

  // local input buffers — committed on blur (so reducer state doesn't churn per keystroke)
  const [stageIdInput, setStageIdInput] = useState(selectedId);
  const [nameInput, setNameInput] = useState(def.name || '');
  const [descInput, setDescInput] = useState(def.description || '');
  const [configText, setConfigText] = useState(
    def.config != null ? JSON.stringify(def.config, null, 2) : ''
  );
  const [inputsText, setInputsText] = useState(
    def.inputs != null ? JSON.stringify(def.inputs, null, 2) : ''
  );
  const [configErr, setConfigErr] = useState(null);
  const [inputsErr, setInputsErr] = useState(null);
  const [idErr, setIdErr] = useState(null);

  // resync on selection change
  useEffect(() => {
    setStageIdInput(selectedId);
    setNameInput(def.name || '');
    setDescInput(def.description || '');
    setConfigText(def.config != null ? JSON.stringify(def.config, null, 2) : '');
    setInputsText(def.inputs != null ? JSON.stringify(def.inputs, null, 2) : '');
    setConfigErr(null); setInputsErr(null); setIdErr(null);
  }, [selectedId]);

  const commitId = () => {
    const v = stageIdInput.trim();
    if (v === selectedId) { setIdErr(null); return; }
    if (!ID_RE.test(v)) { setIdErr('Snake_case, beginnt mit Buchstabe'); return; }
    if (stages[v]) { setIdErr('Stage-ID existiert bereits'); return; }
    setIdErr(null);
    dispatch({ type: 'rename_stage', oldId: selectedId, newId: v });
  };

  const commitConfig = () => {
    const r = tryParseJSON(configText, undefined);
    if (!r.ok) { setConfigErr(r.error); return; }
    setConfigErr(null);
    dispatch({ type: 'update_stage', stageId: selectedId, patch: { config: r.value } });
  };

  const commitInputs = () => {
    const r = tryParseJSON(inputsText, undefined);
    if (!r.ok) { setInputsErr(r.error); return; }
    if (r.value != null && (typeof r.value !== 'object' || Array.isArray(r.value))) {
      setInputsErr('Muss ein Objekt sein {key: "${stage.field}"}');
      return;
    }
    setInputsErr(null);
    dispatch({ type: 'update_stage', stageId: selectedId, patch: { inputs: r.value } });
  };

  const hasEdges = edges.some(([a, b]) => a === selectedId || b === selectedId);

  // Catalog entry for this stage — provides authoritative hints (inputs/outputs/configExample)
  // straight from the registered StageDefinition.hints field.
  const catalogEntry = useMemo(
    () => (catalog ?? []).find((c) => c.id === def.uses) ?? null,
    [catalog, def.uses],
  );
  const hints = catalogEntry?.hints ?? null;

  // Apply the configExample verbatim into the Config textarea (one-click prefill).
  const applyConfigExample = () => {
    if (!hints?.configExample) return;
    // Strip inline `// comment` tails the author may have included for clarity.
    const cleaned = hints.configExample.replace(/\s*\/\/[^\n]*$/gm, '').trim();
    setConfigText(cleaned);
    try {
      const parsed = JSON.parse(cleaned);
      setConfigErr(null);
      dispatch({ type: 'update_stage', stageId: selectedId, patch: { config: parsed } });
    } catch (e) {
      // Some examples are non-strict illustrations (`/* */`, trailing commas).
      // Leave the text in the textarea so the user can edit and re-blur.
      setConfigErr(e.message);
    }
  };

  return (
    <aside className="dsg-inspector">
      <h3 className="dsg-section-title">Knoten</h3>

      <div className="dsg-field">
        <label className="dsg-field-label" htmlFor="dsg-stage-id">Stage-ID</label>
        <input
          id="dsg-stage-id"
          className="dsg-input"
          value={stageIdInput}
          onChange={(e) => setStageIdInput(e.target.value)}
          onBlur={commitId}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          data-invalid={idErr ? 'true' : 'false'}
          spellCheck="false"
        />
        {idErr && <div className="dsg-field-err">{idErr}</div>}
      </div>

      <div className="dsg-field">
        <label className="dsg-field-label">Uses</label>
        <div className="dsg-field-readonly">{def.uses}</div>
      </div>

      <div className="dsg-field">
        <label className="dsg-field-label" htmlFor="dsg-stage-name">Name</label>
        <input
          id="dsg-stage-name"
          className="dsg-input"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onBlur={() => dispatch({ type: 'update_stage', stageId: selectedId, patch: { name: nameInput || undefined } })}
          placeholder={def.uses}
        />
      </div>

      <div className="dsg-field">
        <label className="dsg-field-label" htmlFor="dsg-stage-desc">Beschreibung</label>
        <textarea
          id="dsg-stage-desc"
          className="dsg-textarea"
          style={{ fontFamily: 'var(--font-inter)', fontSize: 12, minHeight: 60 }}
          value={descInput}
          onChange={(e) => setDescInput(e.target.value)}
          onBlur={() => dispatch({ type: 'update_stage', stageId: selectedId, patch: { description: descInput || undefined } })}
        />
      </div>

      {hints && (
        <div className="dsg-hints">
          <div className="dsg-hints-head">Stage-Vertrag</div>
          {hints.inputs && (
            <div className="dsg-hints-row">
              <span className="dsg-hints-key">Inputs</span>
              <code className="dsg-hints-val">{hints.inputs}</code>
            </div>
          )}
          {hints.outputs && (
            <div className="dsg-hints-row">
              <span className="dsg-hints-key">Outputs</span>
              <code className="dsg-hints-val">{hints.outputs}</code>
            </div>
          )}
          {hints.configExample && (
            <div className="dsg-hints-row dsg-hints-row-block">
              <span className="dsg-hints-key">Beispiel-Config</span>
              <pre className="dsg-hints-pre">{hints.configExample}</pre>
              <button
                type="button"
                className="dsg-btn dsg-btn-sm"
                onClick={applyConfigExample}
                title="Beispiel-Config in die Config-Textarea übernehmen"
              >
                Übernehmen
              </button>
            </div>
          )}
        </div>
      )}

      <div className="dsg-field">
        <label className="dsg-field-label" htmlFor="dsg-stage-config">Config (JSON)</label>
        <textarea
          id="dsg-stage-config"
          className="dsg-textarea"
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          onBlur={commitConfig}
          data-invalid={configErr ? 'true' : 'false'}
          spellCheck="false"
          placeholder='{ "model": "…" }'
        />
        {configErr && <div className="dsg-field-err">JSON: {configErr}</div>}
      </div>

      <div className="dsg-field">
        <label className="dsg-field-label" htmlFor="dsg-stage-inputs">Inputs (JSON)</label>
        <textarea
          id="dsg-stage-inputs"
          className="dsg-textarea"
          value={inputsText}
          onChange={(e) => setInputsText(e.target.value)}
          onBlur={commitInputs}
          data-invalid={inputsErr ? 'true' : 'false'}
          spellCheck="false"
          placeholder='{ "text": "${ocr.markdown}" }'
        />
        {inputsErr && <div className="dsg-field-err">JSON: {inputsErr}</div>}
        <div className="dsg-field-hint">
          Werte werden per <code>${'{stage.field}'}</code> oder <code>${'{input.X}'}</code> aufgelöst.
        </div>
      </div>

      <div className="dsg-inspector-actions">
        <button
          type="button"
          className="dsg-btn dsg-btn-danger"
          onClick={() => onDelete(selectedId, hasEdges)}
        >
          Knoten löschen
        </button>
      </div>
    </aside>
  );
}

/* --------------------------------------------------------------------------
   Toolbar (top)
   -------------------------------------------------------------------------- */
function Toolbar({ state, dispatch, onSave, onNew, onLoad, onTest, onAutoLayout, savedList, status, isSaving, reloadList, canTest }) {
  const [loadOpen, setLoadOpen] = useState(false);
  const loadRef = useRef(null);

  useEffect(() => {
    if (!loadOpen) return;
    const handler = (e) => {
      if (loadRef.current && !loadRef.current.contains(e.target)) setLoadOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [loadOpen]);

  const idValid = ID_RE.test(state.meta.id);

  return (
    <div className="dsg-toolbar">
      <div className="dsg-toolbar-brand">
        STURM <small>Workflow-Designer</small>
      </div>

      <input
        className="dsg-id-input"
        aria-label="Workflow-ID"
        value={state.meta.id}
        onChange={(e) => dispatch({ type: 'set_meta', patch: { id: e.target.value } })}
        placeholder="workflow_id"
        spellCheck="false"
        data-invalid={!idValid ? 'true' : 'false'}
        title="Snake_case-ID (a-z, 0-9, _)"
      />
      <input
        className="dsg-name-input"
        aria-label="Workflow-Name"
        value={state.meta.name}
        onChange={(e) => dispatch({ type: 'set_meta', patch: { name: e.target.value } })}
        placeholder="Workflow-Name"
      />
      <input
        className="dsg-desc-input"
        aria-label="Workflow-Beschreibung"
        value={state.meta.description}
        onChange={(e) => dispatch({ type: 'set_meta', patch: { description: e.target.value } })}
        placeholder="Kurze Beschreibung…"
      />
      <select
        className="dsg-input-type"
        aria-label="Workflow-Input-Typ"
        value={state.meta.inputType}
        onChange={(e) => dispatch({ type: 'set_meta', patch: { inputType: e.target.value } })}
        title="Input-Typ"
      >
        <option value="file">file</option>
        <option value="text">text</option>
        <option value="json">json</option>
      </select>

      <span className="dsg-status" data-tone={status?.tone || 'neutral'}>
        {status?.message || ''}
      </span>

      <div className="dsg-toolbar-spacer" />

      <button type="button" className="dsg-btn" onClick={onNew}>Neu</button>
      <button
        type="button"
        className="dsg-btn"
        onClick={onAutoLayout}
        disabled={Object.keys(state.stages).length === 0}
        title="Stages + Container topologisch anordnen"
      >
        Auto-Layout
      </button>

      <div className="dsg-load-wrap" ref={loadRef}>
        <button
          type="button"
          className="dsg-btn"
          onClick={() => { setLoadOpen(o => !o); if (!loadOpen) reloadList(); }}
        >
          Laden ▾
        </button>
        {loadOpen && (
          <div className="dsg-load-menu">
            {(!savedList || savedList.length === 0) && (
              <div className="dsg-load-empty">Keine gespeicherten Workflows.</div>
            )}
            {savedList && savedList.map(w => (
              <button
                key={w.id}
                type="button"
                className="dsg-load-item"
                onClick={() => { setLoadOpen(false); onLoad(w.id); }}
              >
                <div className="dsg-load-name">{w.name || w.id}</div>
                <div className="dsg-load-meta">{w.id}{w.updatedAt ? ` · ${new Date(w.updatedAt).toLocaleString()}` : ''}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <a
        className="dsg-btn-link"
        href={`/pipeline.html?wf=${encodeURIComponent(state.meta.id)}`}
        target="_blank"
        rel="noopener"
        title="Im Run-UI öffnen"
      >
        Run-UI ↗
      </a>

      <button
        type="button"
        className="dsg-btn"
        onClick={onTest}
        disabled={!canTest}
        title={canTest ? 'Workflow mit einer Datei testen' : 'Erst speichern, dann testen'}
      >
        Test ▶
      </button>

      <button type="button" className="dsg-btn" data-primary="true" onClick={onSave} disabled={isSaving}>
        {isSaving ? 'Speichert…' : 'Speichern'}
      </button>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Canvas (ReactFlow wrapper + DnD onto pane)
   -------------------------------------------------------------------------- */
/**
 * Checks whether `containerKind` is consumable by the stage whose catalog entry
 * lists which container kinds it accepts. A stage with no `acceptsContainers`
 * hint is treated as "any-kind ok" — we're not strict for un-annotated stages
 * so existing workflows don't break.
 */
function canStageReadContainer(stageCatEntry, containerKind) {
  if (!containerKind) return true; // legacy container without kind metadata
  const accepts = stageCatEntry?.hints?.acceptsContainers;
  if (!accepts || accepts.length === 0) return true; // un-annotated stage
  return accepts.includes(containerKind);
}

/**
 * Two port types are compatible if they're equal, OR if either side is `any`.
 * `null/undefined` ports (un-annotated stages) are treated as `any` so legacy
 * workflows continue to wire without friction.
 */
function arePortTypesCompatible(sourceType, targetType) {
  if (!sourceType || !targetType) return true;
  if (sourceType === 'any' || targetType === 'any') return true;
  return sourceType === targetType;
}

/** Look up an output port by name on a stage's catalog entry. */
function findOutputPort(catEntry, name) {
  if (!catEntry || !name) return null;
  const ports = catEntry?.hints?.outputPorts;
  if (!ports || ports.length === 0) return null;
  return ports.find((p) => p.name === name) || null;
}
function findInputPort(catEntry, name) {
  if (!catEntry || !name) return null;
  const ports = catEntry?.hints?.inputPorts;
  if (!ports || ports.length === 0) return null;
  return ports.find((p) => p.name === name) || null;
}

function Canvas({ state, dispatch, catalog, paneRef, onInvalidConnect }) {
  const [rfInstance, setRfInstance] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  // Quickstart is dismissible; pref lives in localStorage so it stays away
  // across reloads once the user has seen it.
  const [showQuickstart, setShowQuickstart] = useState(() => {
    try { return localStorage.getItem('sturm-designer-quickstart-dismissed') !== '1'; }
    catch { return true; }
  });
  const dismissQuickstart = () => {
    setShowQuickstart(false);
    try { localStorage.setItem('sturm-designer-quickstart-dismissed', '1'); } catch {}
  };
  const wrapperRef = useRef(null);

  const usesByCatalogId = useMemo(() => {
    const m = new Map();
    for (const e of catalog) m.set(e.id, e);
    return m;
  }, [catalog]);

  // Build RF nodes/edges from state. The source node is always rendered as
  // the first node and is NEVER part of state.stages.
  const rfNodes = useMemo(() => {
    const sourceHandles = sourceHandlesFor(state.meta.inputType);
    const sourcePos = state.layout[SOURCE_ID] || SOURCE_DEFAULT_POS;
    const sourceNode = {
      id: SOURCE_ID,
      type: 'sourceNode',
      position: sourcePos,
      data: {
        inputType: state.meta.inputType,
        handles: sourceHandles,
      },
      selected: state.selectedId === SOURCE_ID,
      deletable: false,
      draggable: true,
    };
    // Catalog lookup so each rendered node knows its category + typed ports.
    const catalogByUses = new Map((catalog ?? []).map(c => [c.id, c]));
    const stageNodes = Object.entries(state.stages).map(([stageId, def]) => {
      const pos = state.layout[stageId] || { x: 40, y: 40 };
      const cat = catalogByUses.get(def.uses);
      return {
        id: stageId,
        type: 'stage',
        position: pos,
        data: {
          stageId,
          uses: def.uses,
          label: def.name || def.uses,
          category: cat?.category || 'general',
          inputPorts: cat?.hints?.inputPorts || null,
          outputPorts: cat?.hints?.outputPorts || null,
        },
        selected: state.selectedId === stageId,
      };
    });
    const containerNodes = Object.entries(state.containers || {}).map(([cid, ref]) => {
      const pos = state.layout[containerKey(cid)] || { x: 40, y: 480 };
      return {
        id: containerKey(cid),
        type: 'containerNode',
        position: pos,
        data: { ...ref },
        selected: state.selectedId === containerKey(cid),
        deletable: true,
      };
    });
    return [sourceNode, ...stageNodes, ...containerNodes];
  }, [state.stages, state.containers, state.layout, state.selectedId, state.meta.inputType, catalog]);

  // Visible source-edges are derived purely from stage.inputs (any value of
  // shape "${input.handleName}" implies a visible wire from source to stage).
  // They are NOT in state.edges and NOT serialized into workflow.edges.
  const rfEdges = useMemo(() => {
    const stageEdges = state.edges.map(([a, b]) => ({
      id: `${a}__${b}`,
      source: a,
      target: b,
      type: 'default',
      animated: false,
      selected: state.selectedEdge && state.selectedEdge[0] === a && state.selectedEdge[1] === b,
      style: { stroke: 'var(--color-text-tertiary)', strokeWidth: 1.5 },
    }));
    const allowed = new Set(sourceHandlesFor(state.meta.inputType));
    const sourceEdges = [];
    for (const [stageId, def] of Object.entries(state.stages)) {
      if (!def.inputs) continue;
      const seen = new Set();
      for (const v of Object.values(def.inputs)) {
        const ref = parseInputRef(v);
        if (!ref || seen.has(ref) || !allowed.has(ref)) continue;
        seen.add(ref);
        sourceEdges.push({
          id: `${SOURCE_ID}__${ref}__${stageId}`,
          source: SOURCE_ID,
          sourceHandle: ref,
          target: stageId,
          type: 'default',
          animated: true,
          selectable: false,
          // Use Neo accent token so source-edges sit warm + on-brand in both themes.
          style: { stroke: 'var(--color-accent)', strokeWidth: 1.5, strokeDasharray: '4 3', opacity: 0.75 },
        });
      }
    }
    // Container → stage visual edges (one per readBy entry). Not part of
    // workflow.edges; pure visualization of `container.readBy[]`.
    const containerEdges = [];
    for (const [cid, ref] of Object.entries(state.containers || {})) {
      for (const stageId of (ref.readBy || [])) {
        if (!state.stages[stageId]) continue;
        containerEdges.push({
          id: `${containerKey(cid)}__${stageId}`,
          source: containerKey(cid),
          target: stageId,
          type: 'default',
          animated: true,
          selectable: false,
          style: { stroke: 'var(--color-orange)', strokeWidth: 1.5, strokeDasharray: '4 3', opacity: 0.65 },
        });
      }
    }
    return [...sourceEdges, ...stageEdges, ...containerEdges];
  }, [state.stages, state.containers, state.edges, state.selectedEdge, state.meta.inputType]);

  const onNodesChange = useCallback((changes) => {
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        if (c.id === SOURCE_ID) {
          dispatch({ type: 'set_source_position', position: c.position });
        } else if (isContainerKey(c.id)) {
          dispatch({ type: 'set_container_position', id: containerIdFromKey(c.id), pos: c.position });
        } else {
          dispatch({ type: 'set_position', stageId: c.id, position: c.position });
        }
      }
    }
  }, [dispatch]);

  const onConnect = useCallback((conn) => {
    if (!conn.source || !conn.target) return;
    // Source-node connects auto-wire inputs[handleName] = "${input.handleName}".
    if (conn.source === SOURCE_ID) {
      if (conn.target === SOURCE_ID) return;
      if (isContainerKey(conn.target)) return; // container has no inputs
      const handle = conn.sourceHandle;
      if (!handle) return;
      dispatch({ type: 'wire_input_to_stage', stageId: conn.target, handleName: handle });
      return;
    }
    if (conn.target === SOURCE_ID) return; // source has no inbound
    // Container → stage: not a real workflow edge — register the stage in the
    // container's readBy[]. The container becomes "consumed by this stage".
    if (isContainerKey(conn.source)) {
      if (isContainerKey(conn.target)) return;
      const cid = containerIdFromKey(conn.source);
      const container = state.containers?.[cid];
      const stageDef = state.stages?.[conn.target];
      const stageCat = (catalog || []).find((c) => c.id === stageDef?.uses);
      if (!canStageReadContainer(stageCat, container?.kind)) {
        // Typed-port mismatch: surface to the user, do NOT wire.
        onInvalidConnect?.({
          kind: 'container-mismatch',
          containerId: cid,
          containerKind: container?.kind,
          stageId: conn.target,
          stageUses: stageDef?.uses,
          accepts: stageCat?.hints?.acceptsContainers,
        });
        return;
      }
      dispatch({ type: 'wire_container_to_stage', containerId: cid, stageId: conn.target });
      return;
    }
    if (isContainerKey(conn.target)) return; // stage→container makes no sense

    // Stage → stage: enforce port-type matching if both stages declare ports.
    const srcStage = state.stages?.[conn.source];
    const tgtStage = state.stages?.[conn.target];
    const srcCat = (catalog || []).find((c) => c.id === srcStage?.uses);
    const tgtCat = (catalog || []).find((c) => c.id === tgtStage?.uses);
    if (conn.sourceHandle && conn.targetHandle) {
      const srcPort = findOutputPort(srcCat, conn.sourceHandle);
      const tgtPort = findInputPort(tgtCat, conn.targetHandle);
      if (!arePortTypesCompatible(srcPort?.type, tgtPort?.type)) {
        onInvalidConnect?.({
          kind: 'port-mismatch',
          srcStage: conn.source,
          srcPort: conn.sourceHandle,
          srcType: srcPort?.type,
          tgtStage: conn.target,
          tgtPort: conn.targetHandle,
          tgtType: tgtPort?.type,
        });
        return;
      }
    }
    dispatch({ type: 'add_edge', from: conn.source, to: conn.target });
  }, [dispatch, state.containers, state.stages, catalog, onInvalidConnect]);

  // While the user is actively dragging a connection, this fires for every
  // candidate target. Return false → ReactFlow draws the wire red and refuses
  // to call onConnect on release. We only enforce for container→stage; other
  // pairs use their own legality checks inside onConnect.
  const isValidConnection = useCallback((conn) => {
    if (!conn.source || !conn.target) return true;
    // Container → stage
    if (isContainerKey(conn.source)) {
      if (isContainerKey(conn.target) || conn.target === SOURCE_ID) return false;
      const cid = containerIdFromKey(conn.source);
      const container = state.containers?.[cid];
      const stageDef = state.stages?.[conn.target];
      if (!stageDef) return true;
      const stageCat = (catalog || []).find((c) => c.id === stageDef.uses);
      return canStageReadContainer(stageCat, container?.kind);
    }
    // Stage → stage port-type check (only when both handles named)
    if (conn.sourceHandle && conn.targetHandle && state.stages?.[conn.source] && state.stages?.[conn.target]) {
      const srcCat = (catalog || []).find((c) => c.id === state.stages[conn.source].uses);
      const tgtCat = (catalog || []).find((c) => c.id === state.stages[conn.target].uses);
      const sp = findOutputPort(srcCat, conn.sourceHandle);
      const tp = findInputPort(tgtCat, conn.targetHandle);
      return arePortTypesCompatible(sp?.type, tp?.type);
    }
    return true;
  }, [state.containers, state.stages, catalog]);

  const onNodeClick = useCallback((_e, node) => {
    dispatch({ type: 'select_node', stageId: node.id });
  }, [dispatch]);

  const onEdgeClick = useCallback((_e, edge) => {
    // Source-derived edges are virtual; they're managed via stage.inputs.
    if (edge.source === SOURCE_ID || edge.target === SOURCE_ID) return;
    dispatch({ type: 'select_edge', edge: [edge.source, edge.target] });
  }, [dispatch]);

  const onPaneClick = useCallback(() => {
    dispatch({ type: 'deselect' });
  }, [dispatch]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);
  const onDragLeave = useCallback(() => setIsDragOver(false), []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);

    // Compute drop position in flow-space — shared by stage + container branches.
    const bounds = wrapperRef.current.getBoundingClientRect();
    let position = { x: e.clientX - bounds.left - 80, y: e.clientY - bounds.top - 30 };
    if (rfInstance && rfInstance.project) {
      position = rfInstance.project({
        x: e.clientX - bounds.left,
        y: e.clientY - bounds.top,
      });
    } else if (rfInstance && rfInstance.screenToFlowPosition) {
      position = rfInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    }

    // Stage drop
    const stageRaw = e.dataTransfer.getData('application/sturm-stage');
    if (stageRaw) {
      let stage;
      try { stage = JSON.parse(stageRaw); } catch { return; }
      if (!usesByCatalogId.has(stage.id)) return;
      const existing = new Set(Object.keys(state.stages));
      const stageId = uniqueStageId(stage.id, existing);
      /** @type {StageDef} */
      const stageDef = { uses: stage.id, name: stage.name };
      dispatch({ type: 'add_stage', stageId, stageDef, position });
      return;
    }

    // Container drop — pin to workflow at drop position.
    const containerRaw = e.dataTransfer.getData('application/sturm-container');
    if (containerRaw) {
      let ref;
      try { ref = JSON.parse(containerRaw); } catch { return; }
      if (!ref?.id) return;
      dispatch({ type: 'add_container', ref, pos: position });
    }
  }, [dispatch, rfInstance, state.stages, usesByCatalogId]);

  paneRef.current = { fitView: () => rfInstance?.fitView?.({ padding: 0.15 }) };

  const stageCount = Object.keys(state.stages).length;

  return (
    <div
      ref={wrapperRef}
      className={`dsg-canvas${isDragOver ? ' is-dragover' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <RF.ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onInit={setRfInstance}
        fitView={stageCount > 0}
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{ type: 'default' }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <RF.Background gap={20} size={1} color="var(--color-border)" />
        <RF.Controls showInteractive={false} />
        <RF.MiniMap pannable zoomable style={{ background: 'var(--color-bg-secondary)' }} />
      </RF.ReactFlow>
      {stageCount === 0 && !isDragOver && showQuickstart && (
        <div className="dsg-canvas-empty">
          <div className="dsg-quickstart">
            <button
              type="button"
              className="dsg-quickstart-close"
              onClick={dismissQuickstart}
              title="Hilfe schließen (kann via Reset Quickstart-Pref wieder eingeblendet werden)"
              aria-label="Schließen"
            >×</button>
            <strong>Neuer Workflow</strong>
            <ol className="dsg-quickstart-steps">
              <li>
                <span className="dsg-quickstart-num">1</span>
                Oben in der Toolbar <em>ID</em> + <em>Name</em> setzen
                (ID = <code>snake_case</code>)
              </li>
              <li>
                <span className="dsg-quickstart-num">2</span>
                Aus der Palette links eine Stage <em>hierher</em> ziehen
                <span className="dsg-quickstart-arrow">←</span>
              </li>
              <li>
                <span className="dsg-quickstart-num">3</span>
                Vom <span className="dsg-quickstart-source">📤 Upload-Knoten</span> eine Linie
                zur Stage ziehen — Inputs werden auto-verkabelt
              </li>
              <li>
                <span className="dsg-quickstart-num">4</span>
                Stage anklicken → rechts im Inspector Config sehen,
                ggf. <em>Beispiel übernehmen</em>
                <span className="dsg-quickstart-arrow">→</span>
              </li>
              <li>
                <span className="dsg-quickstart-num">5</span>
                Oben rechts <em>Speichern</em>, dann <em>Test ▶</em> mit einer Datei
              </li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Run-Test Modal — uploads a file (or text/json) and streams the SSE run
   directly inside the designer so the user doesn't have to switch to the
   read-only pipeline viewer for a quick sanity check.
   -------------------------------------------------------------------------- */
function RunTestModal({ workflowId, inputType, onClose }) {
  const [file, setFile] = useState(null);
  const [bodyText, setBodyText] = useState('');
  const [stageStatus, setStageStatus] = useState({}); // stageId → {state, ms?, message?}
  const [stageOrder, setStageOrder] = useState([]);
  const [runId, setRunId] = useState(null);
  const [overall, setOverall] = useState(null);   // 'running' | 'ok' | 'error'
  const [totalMs, setTotalMs] = useState(null);
  const [err, setErr] = useState(null);
  const abortRef = useRef(null);

  const canStart =
    overall !== 'running' &&
    (inputType === 'file' ? !!file : bodyText.trim().length > 0);

  const start = async () => {
    setStageStatus({});
    setStageOrder([]);
    setRunId(null);
    setOverall('running');
    setTotalMs(null);
    setErr(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let resp;
    try {
      let res;
      if (inputType === 'file') {
        const fd = new FormData();
        fd.append('file', file);
        res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/run`, {
          method: 'POST',
          body: fd,
          signal: ctrl.signal,
          headers: { ...authHeaders() },
        });
      } else {
        const body = inputType === 'json'
          ? bodyText
          : JSON.stringify({ input: { text: bodyText } });
        res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/run`, {
          method: 'POST',
          body,
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);
      resp = res;
    } catch (e) {
      setErr(e.message);
      setOverall('error');
      return;
    }

    // Parse SSE: events split by `\n\n`, each event has `event: <name>\ndata: <json>`
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let name = '', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          let payload = null;
          try { payload = data ? JSON.parse(data) : null; } catch { /* ignore */ }
          handleEvent(name, payload);
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message);
    }
  };

  const handleEvent = (name, ev) => {
    if (!ev) return;
    if (name === 'run_meta') {
      setRunId(ev.runId);
      if (Array.isArray(ev.payload?.stages)) setStageOrder(ev.payload.stages);
    } else if (name === 'stage_start' && ev.stageId) {
      setStageStatus((s) => ({ ...s, [ev.stageId]: { state: 'running' } }));
    } else if (name === 'stage_done' && ev.stageId) {
      setStageStatus((s) => ({ ...s, [ev.stageId]: { state: 'ok', ms: ev.payload?.ms } }));
    } else if (name === 'stage_error' && ev.stageId) {
      setStageStatus((s) => ({ ...s, [ev.stageId]: { state: 'error', ms: ev.payload?.ms, message: ev.payload?.message } }));
    } else if (name === 'stage_skipped' && ev.stageId) {
      setStageStatus((s) => ({ ...s, [ev.stageId]: { state: 'skipped' } }));
    } else if (name === 'run_done') {
      setOverall('ok');
      setTotalMs(ev.payload?.ms);
    } else if (name === 'run_error') {
      setOverall('error');
      setTotalMs(ev.payload?.ms);
    }
  };

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const stages = stageOrder.length ? stageOrder : Object.keys(stageStatus);
  return (
    <div className="dsg-modal-backdrop" onClick={onClose}>
      <div className="dsg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dsg-modal-head">
          <h3 className="dsg-modal-title">Test-Run: <code>{workflowId}</code></h3>
          <button type="button" className="dsg-btn dsg-btn-sm" onClick={onClose}>Schließen</button>
        </div>

        {!overall && (
          <div className="dsg-modal-body">
            {inputType === 'file' && (
              <div className="dsg-field">
                <label className="dsg-field-label" htmlFor="dsg-runtest-file">Datei (PDF / Bild)</label>
                <input
                  id="dsg-runtest-file"
                  type="file"
                  className="dsg-input"
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                {file && <div className="dsg-field-hint">{file.name} · {(file.size / 1024).toFixed(0)} KB</div>}
              </div>
            )}
            {inputType === 'text' && (
              <div className="dsg-field">
                <label className="dsg-field-label" htmlFor="dsg-runtest-text">Text-Input</label>
                <textarea
                  id="dsg-runtest-text"
                  className="dsg-textarea"
                  style={{ minHeight: 140, fontFamily: 'var(--font-inter)' }}
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  placeholder="Beliebiger Text…"
                />
              </div>
            )}
            {inputType === 'json' && (
              <div className="dsg-field">
                <label className="dsg-field-label" htmlFor="dsg-runtest-json">JSON-Body</label>
                <textarea
                  id="dsg-runtest-json"
                  className="dsg-textarea"
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  placeholder='{ "input": { … } }'
                />
                <div className="dsg-field-hint">Vollständiger Request-Body — wird unverändert gesendet.</div>
              </div>
            )}
          </div>
        )}

        {overall && (
          <div className="dsg-modal-body">
            <div className="dsg-runtest-head">
              <span className="dsg-runtest-badge" data-state={overall}>
                {overall === 'running' ? 'Läuft…' : overall === 'ok' ? 'OK' : 'Fehler'}
              </span>
              {runId && <code className="dsg-runtest-runid">{runId}</code>}
              {totalMs != null && <span className="dsg-runtest-totalms">{totalMs} ms</span>}
            </div>
            <ul className="dsg-runtest-stages">
              {stages.map((sid) => {
                const s = stageStatus[sid] || { state: 'pending' };
                return (
                  <li key={sid} className="dsg-runtest-stage" data-state={s.state}>
                    <span className="dsg-runtest-stage-id">{sid}</span>
                    <span className="dsg-runtest-stage-state">{s.state}</span>
                    {s.ms != null && <span className="dsg-runtest-stage-ms">{s.ms} ms</span>}
                    {s.message && <div className="dsg-runtest-stage-err">{s.message}</div>}
                  </li>
                );
              })}
            </ul>
            {err && <div className="dsg-field-err" style={{ marginTop: 12 }}>{err}</div>}
            {overall !== 'running' && runId && (
              <div style={{ marginTop: 12 }}>
                <a
                  className="dsg-btn-link"
                  href={`/pipeline.html?wf=${encodeURIComponent(workflowId)}&run=${encodeURIComponent(runId)}`}
                  target="_blank"
                  rel="noopener"
                >
                  Vollansicht im Run-UI ↗
                </a>
              </div>
            )}
          </div>
        )}

        <div className="dsg-modal-foot">
          {!overall && (
            <button
              type="button"
              className="dsg-btn"
              data-primary="true"
              disabled={!canStart}
              onClick={start}
            >
              Starten ▶
            </button>
          )}
          {overall === 'running' && (
            <button
              type="button"
              className="dsg-btn dsg-btn-danger"
              onClick={() => abortRef.current?.abort()}
            >
              Abbrechen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Build/validate WorkflowDef from editor state
   -------------------------------------------------------------------------- */
function buildWorkflowDef(state, catalogIds, catalog) {
  /** @type {string[]} */
  const errs = [];
  /** @type {string[]} */
  const warnings = [];
  if (!ID_RE.test(state.meta.id)) {
    errs.push(`workflow-id muss snake_case sein (a-z, 0-9, _; nicht: "${state.meta.id}")`);
  }
  if (!state.meta.name.trim()) errs.push('workflow-name fehlt');
  const stageIds = new Set(Object.keys(state.stages));
  if (stageIds.size === 0) errs.push('mindestens eine Stage erforderlich');
  for (const [id, def] of Object.entries(state.stages)) {
    if (!ID_RE.test(id)) errs.push(`stage-id "${id}" ist nicht snake_case`);
    if (!def.uses) errs.push(`stage "${id}" hat kein uses`);
    else if (!catalogIds.has(def.uses)) errs.push(`stage "${id}" verweist auf unbekanntes uses="${def.uses}"`);
  }
  for (const [a, b] of state.edges) {
    if (!stageIds.has(a)) errs.push(`kante referenziert unbekannte stage "${a}"`);
    if (!stageIds.has(b)) errs.push(`kante referenziert unbekannte stage "${b}"`);
  }

  // Safety-net auto-wiring: for any "root" stage (no incoming stage→stage edge)
  // that has empty `inputs`, infer wiring from its hints.inputs against the
  // workflow input type. Prevents the "filePath fehlt" footgun where a user
  // drops a stage onto the canvas and forgets to drag from the upload-source.
  const sourceHandles = sourceHandlesFor(state.meta.inputType);
  const hasIncoming = new Set(state.edges.map(([, b]) => b));
  const catByUses = new Map((catalog || []).map(c => [c.id, c]));
  /** @type {Object<string, StageDef>} */
  const stagesPatched = {};
  for (const [id, def] of Object.entries(state.stages)) {
    stagesPatched[id] = def;
    // Skip if upstream stage edge OR user-defined inputs already present.
    if (hasIncoming.has(id)) continue;
    if (def.inputs && Object.keys(def.inputs).length > 0) continue;
    const cat = catByUses.get(def.uses);
    const hintsText = (cat?.hints?.inputs || '').toLowerCase();
    if (!hintsText) continue;
    /** @type {Object<string,string>} */
    const inferred = {};
    for (const h of sourceHandles) {
      // Substring match — hints say things like "filePath (string, absolute), filename (string)".
      if (hintsText.includes(h.toLowerCase())) inferred[h] = `\${input.${h}}`;
    }
    if (Object.keys(inferred).length > 0) {
      stagesPatched[id] = { ...def, inputs: inferred };
      warnings.push(`auto-wired "${id}".inputs ← ${Object.keys(inferred).map(k => `\${input.${k}}`).join(', ')}`);
    }
  }

  /** @type {WorkflowDef} */
  const wf = {
    id: state.meta.id,
    name: state.meta.name,
    description: state.meta.description,
    input: { type: state.meta.inputType },
    stages: stagesPatched,
    edges: state.edges.map(([a, b]) => [a, b]),
    containers: Object.values(state.containers || {}),
  };
  return { wf, errs, warnings };
}

/* --------------------------------------------------------------------------
   App
   -------------------------------------------------------------------------- */
function App() {
  const [state, dispatch] = useReducer(editorReducer, INITIAL_STATE);
  const [catalog, setCatalog] = useState([]);
  const [catalogErr, setCatalogErr] = useState(null);
  const [containerCatalog, setContainerCatalog] = useState([]);
  const [savedList, setSavedList] = useState(null);
  const [status, setStatus] = useState(null); // { message, tone }
  const [isSaving, setIsSaving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const paneRef = useRef({});

  // Status toast auto-fades
  useEffect(() => {
    if (!status || status.tone === 'err') return;
    const t = setTimeout(() => setStatus(null), 3500);
    return () => clearTimeout(t);
  }, [status]);

  // Load catalogs once
  useEffect(() => {
    fetch('/api/stages/catalog', { headers: authHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setCatalog)
      .catch(err => setCatalogErr(err.message));
    fetch('/api/containers', { headers: authHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(setContainerCatalog)
      .catch(() => setContainerCatalog([]));
  }, []);

  const catalogIds = useMemo(() => new Set(catalog.map(c => c.id)), [catalog]);

  const reloadList = useCallback(() => {
    fetch('/api/workflows-user', { headers: authHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setSavedList)
      .catch(err => {
        // Endpoint may not exist yet during parallel backend work — surface but don't crash.
        setSavedList([]);
        setStatus({ message: `Liste laden fehlgeschlagen: ${err.message}`, tone: 'err' });
      });
  }, []);

  const handleLoad = useCallback(async (id) => {
    try {
      const r = await fetch(`/api/workflows-user/${encodeURIComponent(id)}`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      dispatch({ type: 'load', workflow: body.workflow, layout: body.layout || {} });
      setStatus({ message: `"${body.workflow?.name || id}" geladen.`, tone: 'ok' });
      // Refit canvas after state settles
      setTimeout(() => paneRef.current.fitView?.(), 50);
    } catch (err) {
      setStatus({ message: `Laden fehlgeschlagen: ${err.message}`, tone: 'err' });
    }
  }, []);

  const handleSave = useCallback(async () => {
    const { wf, errs, warnings } = buildWorkflowDef(state, catalogIds, catalog);
    if (errs.length > 0) {
      setStatus({ message: `Validierung: ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1})` : ''}`, tone: 'err' });
      return false;
    }
    setIsSaving(true);
    try {
      const r = await fetch(`/api/workflows-user/${encodeURIComponent(wf.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ workflow: wf, layout: state.layout }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${txt ? `: ${txt.slice(0, 120)}` : ''}`);
      }
      const okMsg = warnings && warnings.length > 0
        ? `Gespeichert: ${wf.id} (${warnings.length} Auto-Wire${warnings.length > 1 ? 's' : ''})`
        : `Gespeichert: ${wf.id}`;
      setStatus({ message: okMsg, tone: 'ok' });
      return true;
    } catch (err) {
      setStatus({ message: `Speichern fehlgeschlagen: ${err.message}`, tone: 'err' });
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [state, catalogIds, catalog]);

  const handleAutoLayout = useCallback(() => {
    const layout = computeAutoLayout(state.stages, state.edges, state.containers);
    if (Object.keys(layout).length === 0) return;
    dispatch({ type: 'apply_layout', layout });
    setStatus({ message: 'Auto-Layout angewandt.', tone: 'ok' });
    setTimeout(() => paneRef.current.fitView?.(), 50);
  }, [state.stages, state.edges, state.containers]);

  const handleNew = useCallback(() => {
    const hasContent = Object.keys(state.stages).length > 0 || state.meta.name !== INITIAL_STATE.meta.name;
    if (hasContent && !window.confirm('Aktuelle Eingaben verwerfen?')) return;
    dispatch({ type: 'reset' });
    setStatus({ message: 'Neuer Workflow.', tone: 'neutral' });
  }, [state]);

  const handleDeleteNode = useCallback((stageId, hasEdges) => {
    if (hasEdges && !window.confirm(`Knoten "${stageId}" hat Kanten. Trotzdem löschen?`)) return;
    dispatch({ type: 'delete_stage', stageId });
  }, []);

  // Delete-key handling on canvas (RF's built-in deleteKeyCode is disabled so
  // we can route through reducer with confirm).
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      if (state.selectedEdge) {
        e.preventDefault();
        dispatch({ type: 'delete_edge', from: state.selectedEdge[0], to: state.selectedEdge[1] });
        return;
      }
      if (state.selectedId) {
        if (state.selectedId === SOURCE_ID) { e.preventDefault(); return; }
        e.preventDefault();
        const hasEdges = state.edges.some(([a, b]) => a === state.selectedId || b === state.selectedId);
        handleDeleteNode(state.selectedId, hasEdges);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state.selectedId, state.selectedEdge, state.edges, handleDeleteNode]);

  return (
    <div className="dsg-shell">
      <Toolbar
        state={state}
        dispatch={dispatch}
        onSave={handleSave}
        onNew={handleNew}
        onLoad={handleLoad}
        onAutoLayout={handleAutoLayout}
        onTest={async () => {
          // Validate first → save (server is the source of truth for executable
          // workflows) → open modal only on save success. handleSave already
          // sets a tone-coded status message in all branches.
          const { errs } = buildWorkflowDef(state, catalogIds, catalog);
          if (errs.length > 0) {
            setStatus({ message: `Validierung: ${errs[0]}`, tone: 'err' });
            return;
          }
          const ok = await handleSave();
          if (ok) setTestOpen(true);
        }}
        savedList={savedList}
        status={catalogErr ? { message: `Katalog: ${catalogErr}`, tone: 'err' } : status}
        isSaving={isSaving}
        reloadList={reloadList}
        canTest={Object.keys(state.stages).length > 0 && /^[a-z][a-z0-9_-]{0,63}$/.test(state.meta.id)}
      />
      {testOpen && (
        <RunTestModal
          workflowId={state.meta.id}
          inputType={state.meta.inputType}
          onClose={() => setTestOpen(false)}
        />
      )}
      <Palette catalog={catalog} containerCatalog={containerCatalog} />
      <Canvas
        state={state}
        dispatch={dispatch}
        catalog={catalog}
        paneRef={paneRef}
        onInvalidConnect={(info) => {
          if (info.kind === 'container-mismatch') {
            const acceptsTxt = info.accepts?.length ? info.accepts.join(', ') : '(keine Container)';
            setStatus({
              message: `Container "${info.containerKind || '—'}" passt nicht zu Stage "${info.stageUses}" — akzeptiert: ${acceptsTxt}`,
              tone: 'err',
            });
          } else if (info.kind === 'port-mismatch') {
            setStatus({
              message: `Port-Typen passen nicht: ${info.srcStage}.${info.srcPort} (${info.srcType || 'any'}) → ${info.tgtStage}.${info.tgtPort} (${info.tgtType || 'any'})`,
              tone: 'err',
            });
          }
        }}
      />
      <Inspector state={state} dispatch={dispatch} onDelete={handleDeleteNode} catalog={catalog} />
      <Statusbar state={state} status={status} />
    </div>
  );
}

/* --------------------------------------------------------------------------
   Live workflow stats — sits across the bottom of the shell. Renders counts
   from current editor state so the user always sees workflow shape at a glance.
   -------------------------------------------------------------------------- */
function Statusbar({ state, status }) {
  const stageCount = Object.keys(state.stages || {}).length;
  const edgeCount = state.edges?.length || 0;
  const containerCount = Object.keys(state.containers || {}).length;
  const readByLinks = Object.values(state.containers || {})
    .reduce((n, c) => n + (c.readBy?.length || 0), 0);
  return (
    <div className="dsg-statusbar">
      <div className="dsg-statusbar-item"><strong>{stageCount}</strong>Stages</div>
      <div className="dsg-statusbar-item"><strong>{edgeCount}</strong>Edges</div>
      <div className="dsg-statusbar-item"><strong>{containerCount}</strong>Container{containerCount === 1 ? '' : ''}</div>
      <div className="dsg-statusbar-item"><strong>{readByLinks}</strong>read-by</div>
      <div className="dsg-statusbar-item">Input: <strong>{state.meta?.inputType}</strong></div>
      <div className="dsg-statusbar-spacer" />
      {status?.message && (
        <div className={`dsg-statusbar-item dsg-statusbar-tone-${status.tone || 'neutral'}`}>
          <strong>{status.message}</strong>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
