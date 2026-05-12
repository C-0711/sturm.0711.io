#!/usr/bin/env node
/**
 * v3 end-to-end on a single Hildburg document.
 *
 * Demonstrates ALL H200V capabilities in one run:
 *   Layer 1 — vLLM Gemma-4 31B Dense @ :11435 with strict json_schema
 *   Layer 2 — legal-entity-registry whitelist + Gemma-4 disambig fallback
 *   Layer 3 — bge-m3 (Ollama @ :11434) cosine over v3 anchored container
 *   Layer 4 — deterministic rules engine (filter, aggregate, project to eCode)
 *
 * Usage: node scripts/run-v3-e2e.mjs [<doc-class>]
 */
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
process.env.OLLAMA_URL ??= 'http://localhost:11434';
process.env.VLLM_URL ??= 'http://localhost:11435';

const dokumenttyp_id = process.argv[2] ?? 'spendenquittung';
const fileFilter = process.argv[3] ?? null;  // optional substring match on originalFilename

// ── load runtime
const { chatJson } = await import(resolve(REPO_ROOT, 'src/lib/llm-chat.ts'));
const { embed, cosineTopK } = await import(resolve(REPO_ROOT, 'src/lib/embedding-runtime.ts'));
const { loadV3Bundle } = await import(resolve(REPO_ROOT, 'src/verticals/elster-v3/lib/container-reader.ts'));
const { resolveEntity } = await import(resolve(REPO_ROOT, 'src/verticals/elster/lib/legal-entity-registry.ts'));
const { applyProjections } = await import(resolve(REPO_ROOT, 'src/verticals/elster/lib/deterministic-rules.ts'));
const { makeLayer } = await import(resolve(REPO_ROOT, 'src/lib/canonical-layer.ts'));

// ── pull Hildburg workspace + GT
const r = spawnSync('/usr/bin/curl', ['-s',
  'https://sturm.0711.io/api/workspaces/haubrich-koch-hildburg-2024/documents'],
  { encoding: 'utf-8', maxBuffer: 50_000_000 });
const docs = JSON.parse(r.stdout);
const candidates = docs.filter((d) => d.classification?.label === dokumenttyp_id);
let doc = fileFilter
  ? candidates.find((d) => (d.originalFilename ?? '').toLowerCase().includes(fileFilter.toLowerCase()))
  : candidates[0];
if (!doc) {
  console.error(`No doc matching class=${dokumenttyp_id} fileFilter=${fileFilter}`);
  if (candidates.length) {
    console.error('Candidates:');
    for (const c of candidates) console.error(`  - ${c.originalFilename}`);
  }
  process.exit(1);
}
const gt = JSON.parse(await readFile(resolve(REPO_ROOT, `tests/groundtruth/${dokumenttyp_id}.json`), 'utf-8'));

// ── load v3 container
const v3 = await loadV3Bundle();

// ── load doc-class schema
const schemaJson = JSON.parse(await readFile(
  resolve(REPO_ROOT, `src/verticals/elster-v3/data/nested_schemas/${dokumenttyp_id}.json`), 'utf-8'));

const calls = { gemma_chat: 0, ollama_embed: 0, llm_total_ms: 0, embed_total_ms: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: nested-extract via Gemma-4 + strict json_schema
// ─────────────────────────────────────────────────────────────────────────────
async function layer1NestedExtract() {
  const ocr = doc.ocr?.markdown ?? '';
  const kpis = doc.classification?.kpis ?? [];
  const fieldHints = kpis
    .filter((k) => k.key && k.value)
    .map((k) => `  ${k.key}: ${k.value}`)
    .join('\n');

  // Doc-class-aware guidance — what to look for, what enums to use
  const docClassGuidance = {
    spendenquittung: [
      `WICHTIG für donations[].kind (German tax law distinguishes these):`,
      `  - "Spende" = freiwillige Zuwendung ohne Gegenleistung (default)`,
      `  - "Mitgliedsbeitrag" = wenn das Dokument explizit "Mitgliedsbeitrag" angibt (separate Behandlung § 10b Abs. 1 Satz 8)`,
      `  - "Sachspende" = Naturalspende`,
      `  - "Aufwandsspende" = Verzicht auf Aufwandserstattung`,
    ],
    lohnsteuerbescheinigung: [
      `WICHTIG für employer.kind:`,
      `  - "versorgungstraeger" = Beamtenversorgung (LBV, Versorgungswerk), Witwenpension, Pensionskasse, Betriebsrente`,
      `  - "arbeitgeber" = aktive Beschäftigung (z.B. Philips GmbH, Bosch, etc.)`,
      `  - "rentenversicherer" = gesetzliche/private Rentenkasse (DRV)`,
      `  - "unbekannt" = NUR wenn Dokument keinen Hinweis liefert (selten)`,
      `Hinweis: "LBV NRW" = Landesamt für Besoldung und Versorgung NRW = Versorgungsträger.`,
      ``,
      `WICHTIG für versorgungsbezug.*:`,
      `  - IMMER ausfüllen wenn der Beleg "Versorgungsbezüge", "Bemessungsgrundlage Versorgungsfreibetrag",`,
      `    oder "Versorgungsbeginn" erwähnt (auch wenn employer.kind unsicher).`,
      `  - versorgungsbezug_brutto = Wert aus "steuerbegünstigte Versorgungsbezüge (im Bruttoarbeitslohn enthalten)"`,
      `  - bemessungsgrundlage_freibetrag = Wert aus "Bemessungsgrundlage für Versorgungsfreibetrag"`,
      ``,
      `WICHTIG für income:`,
      `  - kirchensteuer_arbeitnehmer_einbehalten = aus "einbehaltene Kirchensteuer des Arbeitnehmers"`,
      `    (NICHT verwechseln mit Ehegatten-KiSt, die ein eigenes Feld hat).`,
      ``,
      `WICHTIG für employee.religion_code:`,
      `  - Aus "Kirchensteuermerkmal (Konfession)": "Evangelisch"→ev, "Katholisch"/"römisch-katholisch"→rk, "altkatholisch"→ak.`,
    ],
    rentenbezugsmitteilung: [
      `WICHTIG für rente:`,
      `  - rentenbetrag = aus "Renten-/Leistungsbetrag" oder "Rentenbetrag"`,
      `  - anpassungsbetrag = "Rentenanpassungsbetrag" (in Rentenbetrag enthalten — getrennt ausweisen)`,
    ],
  };
  const guidance = docClassGuidance[dokumenttyp_id] ?? [];

  const t0 = Date.now();
  const prompt = [
    `Du bekommst einen deutschen Steuer-Beleg (Klasse: ${dokumenttyp_id}).`,
    `Extrahiere alle relevanten Daten EXAKT nach dem JSON-Schema. Bewahre Originalnamen (auch bei OCR-Fehlern).`,
    ``,
    ...guidance,
    ``,
    `--- VORANALYSIERTE FORM-FIELD-HINTS (sturm-Extraktion) ---`,
    `(Diese sind bereits korrekt aus dem Dokument extrahiert — nutze sie als Primärquelle!)`,
    fieldHints,
    ``,
    `--- OCR-VOLLTEXT (zur Querprüfung) ---`,
    ocr.slice(0, 5000),
  ].join('\n');
  const result = await chatJson(prompt, {
    provider: 'vllm', model: 'gemma4-mm', temperature: 0, maxTokens: 2000,
    jsonSchema: { name: schemaJson.name, schema: schemaJson.schema, strict: true },
  });
  calls.gemma_chat++;
  calls.llm_total_ms += Date.now() - t0;
  return result.parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: entity-resolve any string field whose name suggests an entity.
// Generic walk over the nested JSON; resolves donations[].recipient,
// employer.name, donor.name, institute, etc.
// ─────────────────────────────────────────────────────────────────────────────
const ENTITY_FIELD_HINTS = [
  'empfaenger', 'empfänger',
  'spender',
  'arbeitgeber',
  'institut', 'bank',
  'rentenerbringer', 'leistungserbringer',
  'versicherer',
];

function isEntityField(path, name) {
  const full = (path + '.' + name).toLowerCase();
  return ENTITY_FIELD_HINTS.some((h) => full.includes(h));
}

async function resolveAtPath(obj, path) {
  if (Array.isArray(obj)) {
    const out = [];
    for (let i = 0; i < obj.length; i++) {
      out.push(await resolveAtPath(obj[i], `${path}[${i}]`));
    }
    return out;
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && isEntityField(path, k) && v.trim().length > 1) {
        const t0 = Date.now();
        const r = await resolveEntity(v, {
          allowLlm: true, chatProvider: 'vllm', chatModel: 'gemma4-mm',
        });
        if (r.source.startsWith('llm')) calls.gemma_chat++;
        calls.llm_total_ms += Date.now() - t0;
        out[k] = r.canonical ?? v;
        if (r.canonical && r.canonical !== v) out[`${k}_original`] = v;
        out[`${k}_resolution`] = r;
        // Also place a top-level _resolution if this was the canonical entity
        if (k === 'empfaenger' || k === 'name') {
          out._resolution = r;
        }
      } else {
        out[k] = await resolveAtPath(v, `${path}.${k}`);
      }
    }
    return out;
  }
  return obj;
}

async function layer2EntityResolve(nested) {
  return resolveAtPath(nested, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: cosine cascade — for non-Spende KPIs the catalog has codes for
// (e.g. Datum, Freistellungsbescheid). Skipped here since Layer 4 alone
// produces the GT for Spendenquittung. Could enrich later.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4: deterministic rules projection
// ─────────────────────────────────────────────────────────────────────────────
function layer4Projections(nested) {
  const layer = makeLayer('elster', v3.container.catalog_version);
  // Augment layer.codes with anchor metadata in trace reasoning
  const result = applyProjections(nested, layer, dokumenttyp_id);
  // Stamp container provenance on the layer
  layer.traces.forEach((t) => {
    t.reasoning += ` [container=${v3.container.id} merkle=${v3.container.merkle_root.slice(0, 12)}…]`;
  });
  return { layer, applied: result.appliedRules };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
console.log('═'.repeat(100));
console.log(`v3 END-TO-END  —  doc: ${doc.originalFilename}`);
console.log(`Container: ${v3.container.id}  merkle: ${v3.container.merkle_root.slice(0, 32)}…`);
console.log(`Anchored: ${!!v3.container.anchor_tx_hash}`);
console.log('═'.repeat(100));
console.log();

console.log('▶ Layer 1: Gemma-4 strict json_schema nested extraction');
const t1 = Date.now();
const nested = await layer1NestedExtract();
console.log(`  ${Date.now() - t1}ms`);
console.log(JSON.stringify(nested, null, 2));
console.log();

console.log('▶ Layer 2: Entity resolution (whitelist + Gemma-4 disambig)');
const t2 = Date.now();
const resolved = await layer2EntityResolve(nested);
console.log(`  ${Date.now() - t2}ms`);
// Print per-spende resolution if this is a Spendenquittung
if (resolved.spenden?.length) {
  console.log('  Per-Spende resolution:');
  for (const d of resolved.spenden) {
    const r = d._resolution;
    const orig = d.empfaenger_original ?? d.empfaenger;
    const corr = orig !== d.empfaenger ? `→ ${d.empfaenger}` : '';
    console.log(`    ${(orig || '?').slice(0, 45).padEnd(46)} ${corr.padEnd(40)} certified=${r?.isCharitableCertified}  ${r?.source}`);
  }
}
// Print Arbeitgeber resolution for LStB
if (resolved.arbeitgeber?.name) {
  const r = resolved.arbeitgeber.name_resolution ?? resolved.arbeitgeber._resolution;
  const orig = resolved.arbeitgeber.name_original ?? resolved.arbeitgeber.name;
  const corr = orig !== resolved.arbeitgeber.name ? `→ ${resolved.arbeitgeber.name}` : '';
  console.log(`  Arbeitgeber: ${(orig || '?').padEnd(46)} ${corr} art=${resolved.arbeitgeber.art} ${r ? `(${r.source})` : ''}`);
}
console.log();

console.log('▶ Layer 4: Deterministic rules projection');
const t4 = Date.now();
const { layer, applied } = layer4Projections(resolved);
console.log(`  ${Date.now() - t4}ms`);
for (const a of applied) {
  console.log(`  ${a.targetCode}  ${a.aggregatedValue} EUR  (filtered ${a.filteredCount}/${a.inputCount}, ceiling=${a.ceilingApplied})`);
  console.log(`    rule: ${a.rule}`);
}
console.log();

console.log('═'.repeat(100));
console.log('CANONICAL LAYER (final v3 output)');
console.log('═'.repeat(100));
console.log(JSON.stringify({
  schemaId: layer.schemaId,
  version: layer.version,
  codes: layer.codes,
  producedAgainst: {
    container_id: v3.container.id,
    merkle_root: v3.container.merkle_root,
    container_sha256: v3.container.container_sha256,
    anchored: !!v3.container.anchor_tx_hash,
    anchor_tx: v3.container.anchor_tx_hash,
  },
  traces: layer.traces.map((t) => ({ code: t.code, value: t.value, source: t.cascadeStage, reasoning: t.reasoning })),
}, null, 2));

console.log();
console.log('═'.repeat(100));
console.log('GROUND-TRUTH MATCH');
console.log('═'.repeat(100));
let req = 0, hit = 0;
for (const [code, info] of Object.entries(gt.expected ?? {})) {
  if (!info.required) continue;
  req++;
  const got = layer.codes[code];
  const match = got !== undefined && Math.abs(Number(got) - Number(info.value)) < 0.01 ? '✓' : (got !== undefined ? '~' : '✗');
  if (match === '✓') hit++;
  console.log(`  ${match}  ${code}  expected ${info.value}  got ${got ?? 'MISSING'}    (${info.label})`);
}
console.log();
console.log(`Required-eCode coverage: ${hit}/${req}`);
console.log();
console.log('═'.repeat(100));
console.log('H200V SUPERPOWER USAGE');
console.log('═'.repeat(100));
console.log(`  Gemma-4 31B Dense (vLLM @ :11435):   ${calls.gemma_chat} chat calls, ${calls.llm_total_ms}ms total`);
console.log(`  bge-m3 (Ollama @ :11434):             ${calls.ollama_embed} embed calls, ${calls.embed_total_ms}ms total`);
console.log(`  json_schema strict decoding:          ✓ (Layer 1 — guarantees no schema drift)`);
console.log(`  Apache AGE / pgvector:                read-only inventory complete (not yet wired in this layer set)`);
console.log(`  Container merkle proof:               ${v3.container.merkle_root}`);
console.log(`  Container SHA-256:                    ${v3.container.container_sha256}`);
console.log(`  Base mainnet anchor:                  ${v3.container.anchor_tx_hash ?? 'not yet anchored — promote-worker step pending'}`);
