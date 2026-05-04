/* eslint-disable no-unused-vars */
/* global React, ReactDOM */
//
// STURM Schema Builder — Visual + JSON tabs.
//
// Mounts inside #schema-builder-mount in studio-ocr.html.
// Mirrors the data model from src/lib/schema-builder/{types,emit}.ts
// (server-side TS lib is canonical; this is the browser twin).
//
// Bridge to vanilla studio-ocr.js:
//   window.__schemaBuilder = {
//     getSchema(): JsonSchema | null
//     setSchema(schema: JsonSchema | null): void
//     getError(): string | null
//   }
//
// Last-edited-tab wins. Switching tabs commits the source side.
// JSON parse failure → can't switch to Visual until fixed.
// JSON contains constructs the builder can't model (oneOf/anyOf/$ref) →
// switch is allowed but Visual tab shows a banner and is read-only.

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// ─── Data model (mirrors src/lib/schema-builder/types.ts) ───────────────────

const KINDS = [
  { value: 'text',         label: 'Text' },
  { value: 'number',       label: 'Zahl' },
  { value: 'integer',      label: 'Ganzzahl' },
  { value: 'boolean',      label: 'Boolean' },
  { value: 'checkbox',     label: 'Checkbox (☑/☐)' },
  { value: 'currency_eur', label: 'Betrag (EUR)' },
  { value: 'iban',         label: 'IBAN' },
  { value: 'date_iso',     label: 'Datum (ISO)' },
  { value: 'enum',         label: 'Auswahl (enum)' },
  { value: 'object',       label: 'Objekt' },
  { value: 'array',        label: 'Liste' },
];

const BINDINGS = [
  { value: 'none',          label: '— keine —' },
  { value: 'checkbox',      label: 'Checkbox-Symbole erkennen' },
  { value: 'amount',        label: 'Betrag (de-DE → number)' },
  { value: 'iban',          label: 'IBAN normalisieren' },
  { value: 'tax_id',        label: 'Steuer-IDNr (DE)' },
  { value: 'elster_anlage', label: 'ELSTER Anlage' },
];

let _idCounter = 0;
function newId() { return `f${Date.now().toString(36)}_${(++_idCounter).toString(36)}`; }

function defaultConfigFor(kind) {
  if (kind === 'enum')  return { kind: 'enum', values: [] };
  if (kind === 'array') return { kind: 'array', itemKind: 'text' };
  return { kind };
}

function defaultBindingFor(kind) {
  if (kind === 'checkbox')     return { type: 'checkbox' };
  if (kind === 'currency_eur') return { type: 'amount', locale: 'de-DE', currency: 'EUR' };
  if (kind === 'iban')         return { type: 'iban', country: 'DE' };
  return undefined;
}

function newField(kind = 'text') {
  return {
    id: newId(),
    name: '',
    kind,
    config: defaultConfigFor(kind),
    required: true,
    children: kind === 'object' ? [] : undefined,
    ocrBinding: defaultBindingFor(kind),
  };
}

// ─── Builder → JsonSchema (mirrors emit.ts) ─────────────────────────────────

function toJsonSchema(rootName, fields, opts = {}) {
  return {
    name: rootName || 'extraction',
    description: opts.description,
    schema: objectSchema(fields),
  };
}

function objectSchema(fields) {
  const properties = {};
  const required = [];
  for (const f of fields) {
    if (!f.name) continue;
    properties[f.name] = fieldToJsonSchema(f);
    if (f.required) required.push(f.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function fieldToJsonSchema(f) {
  switch (f.kind) {
    case 'text': {
      const out = { type: 'string' };
      if (f.description) out.description = f.description;
      const c = f.config.kind === 'text' ? f.config : null;
      if (c?.minLength != null) out.minLength = c.minLength;
      if (c?.maxLength != null) out.maxLength = c.maxLength;
      if (c?.pattern)           out.pattern = c.pattern;
      return out;
    }
    case 'number':
    case 'integer': {
      const out = { type: f.kind };
      if (f.description) out.description = f.description;
      const c = (f.config.kind === f.kind) ? f.config : null;
      if (c?.minimum != null) out.minimum = c.minimum;
      if (c?.maximum != null) out.maximum = c.maximum;
      return out;
    }
    case 'boolean':
    case 'checkbox':
      return f.description ? { type: 'boolean', description: f.description } : { type: 'boolean' };
    case 'currency_eur':
      return {
        type: 'number',
        description: enrichDescription(f.description,
          'Decimal amount in EUR. Source format: German notation with comma decimal separator (e.g. "1.234,56").'),
      };
    case 'iban':
      return {
        type: 'string',
        format: 'iban',
        description: enrichDescription(f.description,
          'IBAN. Strip spaces. Validate against country-specific length and mod-97 checksum.'),
      };
    case 'date_iso':
      return f.description
        ? { type: 'string', format: 'date', description: f.description }
        : { type: 'string', format: 'date' };
    case 'enum': {
      if (f.config.kind !== 'enum') throw new Error('enum config mismatch');
      const out = { type: 'string', enum: f.config.values };
      if (f.description) out.description = f.description;
      return out;
    }
    case 'object': {
      const obj = objectSchema(f.children || []);
      if (f.description) obj.description = f.description;
      return obj;
    }
    case 'array': {
      if (f.config.kind !== 'array') throw new Error('array config mismatch');
      const itemKind = f.config.itemKind;
      const itemField = {
        id: f.id + '-item',
        name: 'item',
        required: true,
        kind: itemKind,
        config: defaultConfigFor(itemKind),
        children: itemKind === 'object' ? f.children : undefined,
      };
      const out = { type: 'array', items: fieldToJsonSchema(itemField) };
      if (f.description) out.description = f.description;
      return out;
    }
    default:
      return { type: 'string' };
  }
}

function enrichDescription(user, suffix) {
  return user ? `${user}\n\n${suffix}` : suffix;
}

// ─── JsonSchema → Builder (reverse mapper) ─────────────────────────────────
//
// Returns { fields, unsupported }. unsupported=true when the schema uses
// constructs the builder can't model (oneOf/anyOf/$ref). The caller should
// disable Visual editing in that case but still allow viewing.

const UNSUPPORTED_KEYS = ['oneOf', 'anyOf', 'allOf', '$ref'];

function jsonSchemaToBuilder(schema) {
  if (!schema || typeof schema !== 'object') return { fields: [], unsupported: false };
  if (schema.type !== 'object' || !schema.properties) {
    return { fields: [], unsupported: true };
  }
  const out = { fields: [], unsupported: false };
  for (const [name, sub] of Object.entries(schema.properties)) {
    const r = propertyToField(name, sub, schema.required || []);
    if (r.unsupported) out.unsupported = true;
    out.fields.push(r.field);
  }
  return out;
}

function propertyToField(name, sub, requiredList) {
  const required = requiredList.includes(name);
  // Detect unsupported constructs early
  for (const k of UNSUPPORTED_KEYS) {
    if (sub && Object.prototype.hasOwnProperty.call(sub, k)) {
      return { field: stringFallbackField(name, sub.description, required), unsupported: true };
    }
  }
  // Inferred STURM kinds based on type + format + description heuristics
  const description = stripStandardSuffix(sub.description);
  if (sub.type === 'string' && sub.format === 'iban') {
    return { field: { id: newId(), name, kind: 'iban', config: { kind: 'iban' }, required, description, ocrBinding: defaultBindingFor('iban') }, unsupported: false };
  }
  if (sub.type === 'string' && sub.format === 'date') {
    return { field: { id: newId(), name, kind: 'date_iso', config: { kind: 'date_iso' }, required, description }, unsupported: false };
  }
  if (sub.type === 'string' && Array.isArray(sub.enum)) {
    return { field: { id: newId(), name, kind: 'enum', config: { kind: 'enum', values: sub.enum.slice() }, required, description }, unsupported: false };
  }
  if (sub.type === 'string') {
    const cfg = { kind: 'text' };
    if (sub.minLength != null) cfg.minLength = sub.minLength;
    if (sub.maxLength != null) cfg.maxLength = sub.maxLength;
    if (sub.pattern)            cfg.pattern = sub.pattern;
    return { field: { id: newId(), name, kind: 'text', config: cfg, required, description }, unsupported: false };
  }
  if (sub.type === 'number' && /German notation|EUR|de-DE/i.test(sub.description || '')) {
    return { field: { id: newId(), name, kind: 'currency_eur', config: { kind: 'currency_eur' }, required, description, ocrBinding: defaultBindingFor('currency_eur') }, unsupported: false };
  }
  if (sub.type === 'number' || sub.type === 'integer') {
    const cfg = { kind: sub.type };
    if (sub.minimum != null) cfg.minimum = sub.minimum;
    if (sub.maximum != null) cfg.maximum = sub.maximum;
    return { field: { id: newId(), name, kind: sub.type, config: cfg, required, description }, unsupported: false };
  }
  if (sub.type === 'boolean') {
    return { field: { id: newId(), name, kind: 'boolean', config: { kind: 'boolean' }, required, description }, unsupported: false };
  }
  if (sub.type === 'object' && sub.properties) {
    const inner = jsonSchemaToBuilder(sub);
    return {
      field: { id: newId(), name, kind: 'object', config: { kind: 'object' }, required, description, children: inner.fields },
      unsupported: inner.unsupported,
    };
  }
  if (sub.type === 'array' && sub.items) {
    const items = sub.items;
    if (items.type === 'object' && items.properties) {
      const inner = jsonSchemaToBuilder(items);
      return {
        field: { id: newId(), name, kind: 'array', config: { kind: 'array', itemKind: 'object' }, required, description, children: inner.fields },
        unsupported: inner.unsupported,
      };
    }
    const itemKind = ['string','number','integer','boolean'].includes(items.type) ? (items.type === 'string' ? 'text' : items.type) : 'text';
    return {
      field: { id: newId(), name, kind: 'array', config: { kind: 'array', itemKind }, required, description },
      unsupported: false,
    };
  }
  return { field: stringFallbackField(name, sub.description, required), unsupported: true };
}

function stringFallbackField(name, description, required) {
  return { id: newId(), name, kind: 'text', config: { kind: 'text' }, required, description };
}

// Strip the standard suffixes we add in fieldToJsonSchema so round-trips don't accumulate.
function stripStandardSuffix(desc) {
  if (!desc) return undefined;
  const cleaned = desc
    .replace(/\n*Decimal amount in EUR\..*$/s, '')
    .replace(/\n*IBAN\. Strip spaces\..*$/s, '')
    .trim();
  return cleaned || undefined;
}

// ─── Components ────────────────────────────────────────────────────────────

function SchemaBuilder() {
  const [tab, setTab] = useState('visual');
  const [fields, setFields] = useState([]);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState(null);
  const [unsupported, setUnsupported] = useState(false);

  // Drain queued setSchema calls from studio-ocr.js (race protection)
  useEffect(() => {
    if (window.__schemaBuilderQueue && window.__schemaBuilderQueue.length > 0) {
      const last = window.__schemaBuilderQueue[window.__schemaBuilderQueue.length - 1];
      window.__schemaBuilderQueue = [];
      applySchema(last);
    }
    // Tell vanilla code we're ready
    window.dispatchEvent(new CustomEvent('schema-builder-ready'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applySchema(schema) {
    if (!schema) {
      setFields([]); setJsonText(''); setUnsupported(false); setJsonError(null);
      return;
    }
    const text = JSON.stringify(schema, null, 2);
    setJsonText(text);
    try {
      const r = jsonSchemaToBuilder(schema);
      setFields(r.fields);
      setUnsupported(r.unsupported);
      if (r.unsupported) setTab('json');
      setJsonError(null);
    } catch (e) {
      setUnsupported(true);
      setTab('json');
    }
  }

  function commitVisualToJson() {
    if (fields.length === 0) {
      setJsonText('');
    } else {
      const wrapped = toJsonSchema('builder', fields);
      setJsonText(JSON.stringify(wrapped.schema, null, 2));
    }
    setJsonError(null);
  }

  function commitJsonToVisual() {
    const text = jsonText.trim();
    if (!text) { setFields([]); setUnsupported(false); setJsonError(null); return true; }
    try {
      const parsed = JSON.parse(text);
      const r = jsonSchemaToBuilder(parsed);
      setFields(r.fields);
      setUnsupported(r.unsupported);
      setJsonError(null);
      return true;
    } catch (e) {
      setJsonError(`Invalides JSON: ${e.message}`);
      return false;
    }
  }

  function switchToTab(target) {
    if (target === tab) return;
    if (tab === 'visual' && target === 'json') {
      commitVisualToJson();
      setTab('json');
    } else if (tab === 'json' && target === 'visual') {
      if (commitJsonToVisual()) setTab('visual');
    }
  }

  // Bridge: expose API to studio-ocr.js
  useEffect(() => {
    window.__schemaBuilder = {
      getSchema() {
        if (tab === 'json') {
          const text = jsonText.trim();
          if (!text) return null;
          if (jsonError) return null;
          try { return JSON.parse(text); } catch { return null; }
        }
        if (fields.length === 0) return null;
        return toJsonSchema('builder', fields).schema;
      },
      setSchema(schema) { applySchema(schema); },
      getError() { return jsonError; },
    };
  }, [tab, fields, jsonText, jsonError]);

  return (
    <div className="schema-builder">
      <div className="sb-tabs" role="tablist">
        <button type="button" className={'sb-tab' + (tab === 'visual' ? ' active' : '')} onClick={() => switchToTab('visual')}>Visual</button>
        <button type="button" className={'sb-tab' + (tab === 'json' ? ' active' : '')} onClick={() => switchToTab('json')}>JSON</button>
        <span className="sb-tabs-hint">Letzte Bearbeitung gewinnt beim Tab-Wechsel.</span>
      </div>
      {unsupported && tab === 'visual' && (
        <div className="sb-banner sb-banner-warn">
          Schema enthält Konstrukte, die der Visual-Builder nicht abbildet (oneOf/anyOf/$ref/…) — bitte JSON-Tab nutzen.
        </div>
      )}
      {tab === 'visual'
        ? <VisualTab fields={fields} setFields={setFields} disabled={unsupported} />
        : <JsonTab text={jsonText} setText={setJsonText} error={jsonError} setError={setJsonError} />}
    </div>
  );
}

function JsonTab({ text, setText, error, setError }) {
  function onChange(e) {
    const v = e.target.value;
    setText(v);
    if (!v.trim()) { setError(null); return; }
    try { JSON.parse(v); setError(null); }
    catch (err) { setError(`Invalides JSON: ${err.message}`); }
  }
  return (
    <div>
      <textarea
        className="sb-json mono"
        rows={14}
        value={text}
        onChange={onChange}
        placeholder='{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}'
      />
      {error && <small className="error-text">{error}</small>}
    </div>
  );
}

function VisualTab({ fields, setFields, disabled }) {
  function addField() {
    setFields([...fields, newField('text')]);
  }
  function updateAt(index, patch) {
    const next = fields.slice();
    next[index] = { ...next[index], ...patch };
    setFields(next);
  }
  function removeAt(index) {
    setFields(fields.filter((_, i) => i !== index));
  }
  function moveTo(fromId, toIndex) {
    const fromIdx = fields.findIndex((f) => f.id === fromId);
    if (fromIdx < 0 || fromIdx === toIndex) return;
    const next = fields.slice();
    const [moved] = next.splice(fromIdx, 1);
    const adjusted = fromIdx < toIndex ? toIndex - 1 : toIndex;
    next.splice(adjusted, 0, moved);
    setFields(next);
  }

  if (disabled) {
    return (
      <div className="sb-disabled">
        <div className="muted">Nur lesend — JSON-Tab nutzen, um dieses Schema zu bearbeiten.</div>
        <ReadOnlyTree fields={fields} />
      </div>
    );
  }

  return (
    <div className="sb-tree">
      {fields.length === 0 && <div className="muted sb-empty">Noch keine Felder. „+ Feld hinzufügen" klicken.</div>}
      {fields.map((f, i) => (
        <FieldRow
          key={f.id}
          field={f}
          index={i}
          onChange={(patch) => updateAt(i, patch)}
          onRemove={() => removeAt(i)}
          onDropAt={(fromId) => moveTo(fromId, i)}
          onDropAtEnd={(fromId) => moveTo(fromId, fields.length)}
          isLast={i === fields.length - 1}
        />
      ))}
      <button type="button" className="sb-add" onClick={addField}>+ Feld hinzufügen</button>
    </div>
  );
}

function FieldRow({ field, index, onChange, onRemove, onDropAt, onDropAtEnd, isLast }) {
  const [over, setOver] = useState(false);
  const onDragStart = (e) => {
    e.dataTransfer.setData('text/plain', field.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); };
  const onDragLeave = () => setOver(false);
  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const id = e.dataTransfer.getData('text/plain');
    if (id && id !== field.id) onDropAt(id);
  };

  const onKindChange = (newKind) => {
    const patch = {
      kind: newKind,
      config: defaultConfigFor(newKind),
      ocrBinding: defaultBindingFor(newKind),
    };
    if (newKind === 'object' && !field.children) patch.children = [];
    if (newKind !== 'object' && newKind !== 'array') patch.children = undefined;
    onChange(patch);
  };

  return (
    <div className={'sb-row' + (over ? ' over' : '')}
         draggable
         onDragStart={onDragStart}
         onDragOver={onDragOver}
         onDragLeave={onDragLeave}
         onDrop={onDrop}>
      <div className="sb-row-head">
        <span className="sb-handle" title="ziehen zum Sortieren">⋮⋮</span>
        <input
          className="sb-name"
          type="text"
          placeholder="feldname"
          value={field.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <select
          className="sb-kind"
          value={field.kind}
          onChange={(e) => onKindChange(e.target.value)}
        >
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <label className="sb-required">
          <input
            type="checkbox"
            checked={!!field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          required
        </label>
        <button type="button" className="sb-remove" onClick={onRemove} title="Feld entfernen">✕</button>
      </div>
      <div className="sb-row-body">
        <input
          className="sb-desc"
          type="text"
          placeholder="Beschreibung (optional, hilft dem Modell)"
          value={field.description || ''}
          onChange={(e) => onChange({ description: e.target.value || undefined })}
        />
        <KindConfig field={field} onChange={onChange} />
        <BindingPicker field={field} onChange={onChange} />
      </div>
      {(field.kind === 'object' || (field.kind === 'array' && field.config.kind === 'array' && field.config.itemKind === 'object')) && (
        <NestedTree
          parent={field}
          children={field.children || []}
          onChildrenChange={(c) => onChange({ children: c })}
        />
      )}
    </div>
  );
}

function KindConfig({ field, onChange }) {
  const c = field.config;
  if (c.kind === 'enum') {
    const text = c.values.join(', ');
    return (
      <input
        className="sb-config"
        type="text"
        placeholder="Werte, kommasepariert (z.B. ja, nein, unbekannt)"
        value={text}
        onChange={(e) => {
          const values = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
          onChange({ config: { kind: 'enum', values } });
        }}
      />
    );
  }
  if (c.kind === 'array') {
    return (
      <select
        className="sb-config"
        value={c.itemKind}
        onChange={(e) => onChange({ config: { kind: 'array', itemKind: e.target.value }, children: e.target.value === 'object' ? (field.children || []) : undefined })}
      >
        {KINDS.filter((k) => k.value !== 'array').map((k) => <option key={k.value} value={k.value}>Items: {k.label}</option>)}
      </select>
    );
  }
  if (c.kind === 'text') {
    return (
      <div className="sb-config-row">
        <input type="number" placeholder="minLength" value={c.minLength ?? ''} onChange={(e) => onChange({ config: { ...c, minLength: e.target.value === '' ? undefined : Number(e.target.value) } })} />
        <input type="number" placeholder="maxLength" value={c.maxLength ?? ''} onChange={(e) => onChange({ config: { ...c, maxLength: e.target.value === '' ? undefined : Number(e.target.value) } })} />
        <input type="text"   placeholder="pattern (regex)" value={c.pattern ?? ''} onChange={(e) => onChange({ config: { ...c, pattern: e.target.value || undefined } })} />
      </div>
    );
  }
  if (c.kind === 'number' || c.kind === 'integer') {
    return (
      <div className="sb-config-row">
        <input type="number" placeholder="minimum" value={c.minimum ?? ''} onChange={(e) => onChange({ config: { ...c, minimum: e.target.value === '' ? undefined : Number(e.target.value) } })} />
        <input type="number" placeholder="maximum" value={c.maximum ?? ''} onChange={(e) => onChange({ config: { ...c, maximum: e.target.value === '' ? undefined : Number(e.target.value) } })} />
      </div>
    );
  }
  return null;
}

function BindingPicker({ field, onChange }) {
  const current = field.ocrBinding?.type ?? 'none';
  function onPick(e) {
    const v = e.target.value;
    if (v === 'none')         onChange({ ocrBinding: undefined });
    else if (v === 'checkbox')     onChange({ ocrBinding: { type: 'checkbox' } });
    else if (v === 'amount')       onChange({ ocrBinding: { type: 'amount', locale: 'de-DE', currency: 'EUR' } });
    else if (v === 'iban')         onChange({ ocrBinding: { type: 'iban', country: 'DE' } });
    else if (v === 'tax_id')       onChange({ ocrBinding: { type: 'tax_id', country: 'DE' } });
    else if (v === 'elster_anlage') onChange({ ocrBinding: { type: 'elster_anlage' } });
  }
  return (
    <select className="sb-binding" value={current} onChange={onPick} title="OCR-Coercion-Bindung">
      {BINDINGS.map((b) => <option key={b.value} value={b.value}>OCR: {b.label}</option>)}
    </select>
  );
}

function NestedTree({ parent, children, onChildrenChange }) {
  function addChild() {
    onChildrenChange([...children, newField('text')]);
  }
  function updateAt(index, patch) {
    const next = children.slice();
    next[index] = { ...next[index], ...patch };
    onChildrenChange(next);
  }
  function removeAt(index) {
    onChildrenChange(children.filter((_, i) => i !== index));
  }
  function moveTo(fromId, toIndex) {
    const fromIdx = children.findIndex((c) => c.id === fromId);
    if (fromIdx < 0 || fromIdx === toIndex) return;
    const next = children.slice();
    const [moved] = next.splice(fromIdx, 1);
    const adjusted = fromIdx < toIndex ? toIndex - 1 : toIndex;
    next.splice(adjusted, 0, moved);
    onChildrenChange(next);
  }
  return (
    <div className="sb-nested">
      {children.map((c, i) => (
        <FieldRow
          key={c.id}
          field={c}
          index={i}
          onChange={(patch) => updateAt(i, patch)}
          onRemove={() => removeAt(i)}
          onDropAt={(fromId) => moveTo(fromId, i)}
          onDropAtEnd={(fromId) => moveTo(fromId, children.length)}
          isLast={i === children.length - 1}
        />
      ))}
      <button type="button" className="sb-add sb-add-nested" onClick={addChild}>+ Sub-Feld</button>
    </div>
  );
}

function ReadOnlyTree({ fields }) {
  if (!fields || fields.length === 0) return null;
  return (
    <ul className="sb-readonly">
      {fields.map((f) => (
        <li key={f.id}>
          <code>{f.name || '?'}</code> · <em>{f.kind}</em>{f.required ? ' · required' : ''}
          {f.children && f.children.length > 0 && <ReadOnlyTree fields={f.children} />}
        </li>
      ))}
    </ul>
  );
}

// ─── Mount ─────────────────────────────────────────────────────────────────

const mount = document.getElementById('schema-builder-mount');
if (mount) {
  ReactDOM.createRoot(mount).render(<SchemaBuilder />);
}
