import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

type CanonicalValue = {
  value?: string | null;
  normalized?: string | null;
  normalizedNumber?: number;
  datentyp?: string | null;
  origin?: string | null;
  trust?: string | null;
  confirmed_by?: Array<{ filename?: string; page?: number; snippet?: string }>;
};

type AppMaster = {
  appId?: string;
  displayName?: string;
  jahr?: number;
  merged_layer?: Record<string, CanonicalValue>;
};

const DEFAULT_INPUT = '/home/christoph.bertsch/0711/0711-STURM/applications/steuerfall-est/hildburg-e2e-v2-2023-mpb50mcg/master.json';
const DEFAULT_OUTPUT = '/tmp/hildburg-ctax-prod-bridge.json';

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : (fallback ?? '');
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function psqlRows(sql: string): string[][] {
  const out = execFileSync(
    'docker',
    ['exec', 'ctax-postgres', 'psql', '-U', 'ctax', '-d', 'ctax_production', '-t', '-A', '-F', '\t', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
  if (!out) return [];
  return out.split('\n').map((line) => line.split('\t'));
}

function trustRank(v?: string | null): number {
  switch ((v || '').toLowerCase()) {
    case 'high': return 4;
    case 'medium': return 3;
    case 'low': return 2;
    case 'suspicious': return 1;
    default: return 0;
  }
}

function shouldDrop(cv: CanonicalValue): boolean {
  const origin = cv.origin || '';
  return (cv.trust || '').toLowerCase() === 'suspicious' && /^llm/i.test(origin);
}

function coerceValue(cv: CanonicalValue): string | number | boolean | null {
  const dt = (cv.datentyp || '').toLowerCase();
  if (typeof cv.normalizedNumber === 'number' && Number.isFinite(cv.normalizedNumber)) return cv.normalizedNumber;
  const raw = String(cv.value ?? '').trim();
  if (!raw) return null;
  if (dt === 'currency' || dt === 'number' || dt === 'int' || dt === 'integer') {
    const n = Number(raw.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : raw;
  }
  if (dt === 'boolean' || dt === 'bool') {
    const s = raw.toLowerCase();
    if (['ja', 'true', '1', 'yes'].includes(s)) return true;
    if (['nein', 'false', '0', 'no'].includes(s)) return false;
  }
  return raw;
}


function isNumericValue(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function looksBadLiteral(v: unknown): boolean {
  return typeof v === 'string' && ['undefined', 'null', 'nan', ''].includes(v.trim().toLowerCase());
}

function validateCandidate(c: any): boolean {
  const field = String(c.canonical_field || '').toLowerCase();
  const val = c.value;
  if (looksBadLiteral(val)) return false;
  if (field.includes('name') && isNumericValue(val)) return false;
  if (field.includes('familienkasse') && typeof val === 'string' && ['undefined','0','0,00'].includes(val.trim().toLowerCase())) return false;
  if ((field.includes('gross_salary') || field === 'gross_salary') && val === 0) return false;
  return true;
}

function chooseBest(candidates: Array<any>) {
  return [...candidates].sort((a, b) => {
    const trust = trustRank(b.trust) - trustRank(a.trust);
    if (trust) return trust;
    const source = String(a.bridge_source).localeCompare(String(b.bridge_source));
    if (source) return source;
    const primary = Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
    if (primary) return primary;
    const prio = (a.priority ?? 9999) - (b.priority ?? 9999);
    if (prio) return prio;
    return String(a.eCode).localeCompare(String(b.eCode));
  })[0];
}

async function main() {
  const inputPath = arg('input', DEFAULT_INPUT);
  const outputPath = arg('output', DEFAULT_OUTPUT);
  const bridgeYear = Number(arg('bridgeYear', '2024'));

  const raw = JSON.parse(await readFile(inputPath, 'utf8')) as AppMaster | Record<string, CanonicalValue>;
  const mergedLayer = ('merged_layer' in raw ? raw.merged_layer : raw) as Record<string, CanonicalValue>;
  if (!mergedLayer || typeof mergedLayer !== 'object') throw new Error('No merged_layer/canonical object found');

  const declaredEntries = Object.entries(mergedLayer).filter(([, cv]) => (cv.origin || '') !== 'BMF_RECHNER');
  const filteredEntries = declaredEntries.filter(([, cv]) => !shouldDrop(cv));
  const ecodes = filteredEntries.map(([eCode]) => eCode);
  const inList = ecodes.map(sqlQuote).join(',');
  if (!inList) throw new Error('No input eCodes');

  const feldRows = psqlRows(`
    SELECT elster_kennzahl, coalesce(bmf_feld,''), coalesce(bezeichnung,''), coalesce(daten_typ,''), steuerjahr::text
    FROM shared.feld_katalog
    WHERE steuerjahr = ${bridgeYear} AND aktiv = true AND elster_kennzahl IN (${inList})
    ORDER BY elster_kennzahl;
  `).map(([elster_kennzahl, bmf_feld, bezeichnung, daten_typ, steuerjahr]) => ({ elster_kennzahl, bmf_feld, bezeichnung, daten_typ, steuerjahr }));

  const zuRows = psqlRows(`
    SELECT elster_code, coalesce(bmf_field,''), coalesce(priority::text,''), coalesce(is_primary::text,''), coalesce(mapping_source,''), coalesce(confidence::text,''), coalesce(reasoning,'')
    FROM shared.bmf_elster_zuordnung
    WHERE elster_code IN (${inList})
    ORDER BY elster_code, priority NULLS LAST, is_primary DESC;
  `).map(([elster_code, bmf_field, priority, is_primary, mapping_source, confidence, reasoning]) => ({
    elster_code, bmf_field, priority: priority ? Number(priority) : null, is_primary: is_primary === 't', mapping_source, confidence, reasoning,
  }));

  const candidateFields = Array.from(new Set([
    ...feldRows.map((r) => r.bmf_feld).filter(Boolean),
    ...zuRows.map((r) => r.bmf_field).filter(Boolean),
  ])).sort();

  const mods = candidateFields.length ? psqlRows(`
    SELECT mm.canonical_field, m.module_name, mm.is_required::text, mm.is_trigger::text, mm.priority::text
    FROM lane1_bmf_calculator.module_mappings mm
    JOIN lane1_bmf_calculator.modules m ON m.module_id = mm.module_id
    WHERE m.active = true AND mm.canonical_field IN (${candidateFields.map(sqlQuote).join(',')})
    ORDER BY mm.canonical_field, m.module_name;
  `).map(([canonical_field, module_name, is_required, is_trigger, priority]) => ({
    canonical_field, module_name, is_required: ['t','true'].includes((is_required || '').toLowerCase()), is_trigger: ['t','true'].includes((is_trigger || '').toLowerCase()), priority: Number(priority || '0'),
  })) : [];

  const feldByEcode = new Map(feldRows.map((r) => [r.elster_kennzahl, r]));
  const zuByEcode = new Map<string, typeof zuRows>();
  for (const row of zuRows) {
    const arr = zuByEcode.get(row.elster_code) || [];
    arr.push(row);
    zuByEcode.set(row.elster_code, arr);
  }
  const modsByField = new Map<string, typeof mods>();
  for (const row of mods) {
    const arr = modsByField.get(row.canonical_field) || [];
    arr.push(row);
    modsByField.set(row.canonical_field, arr);
  }

  const allCandidates: Array<any> = [];
  for (const [eCode, cv] of filteredEntries) {
    const fk = feldByEcode.get(eCode);
    const z = zuByEcode.get(eCode) || [];
    const base = {
      eCode,
      value: coerceValue(cv),
      raw_value: cv.value ?? null,
      normalized: cv.normalized ?? null,
      datentyp: cv.datentyp ?? null,
      origin: cv.origin ?? null,
      trust: cv.trust ?? null,
      evidence: cv.confirmed_by?.[0] ?? null,
    };
    if (fk?.bmf_feld) {
      allCandidates.push({ ...base, canonical_field: fk.bmf_feld, bridge_source: 'feld_katalog', priority: 0, is_primary: true, bezeichnung: fk.bezeichnung });
    }
    for (const row of z) {
      if (!row.bmf_field) continue;
      allCandidates.push({ ...base, canonical_field: row.bmf_field, bridge_source: 'bmf_elster_zuordnung', priority: row.priority, is_primary: row.is_primary, mapping_source: row.mapping_source, mapping_confidence: row.confidence, mapping_reasoning: row.reasoning, bezeichnung: fk?.bezeichnung ?? null });
    }
  }

  const grouped = new Map<string, Array<any>>();
  for (const c of allCandidates) {
    if (!validateCandidate(c)) continue;
    const arr = grouped.get(c.canonical_field) || [];
    arr.push(c);
    grouped.set(c.canonical_field, arr);
  }

  const canonical_fields: Record<string, string | number | boolean | null> = {};
  const field_details: Array<any> = [];
  for (const [field, candidates] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!candidates.length) continue;
    const chosen = chooseBest(candidates);
    canonical_fields[field] = chosen.value;
    field_details.push({ canonical_field: field, chosen, modules: modsByField.get(field) || [], candidates });
  }

  const moduleNames = Array.from(new Set(mods.map((m) => m.module_name))).sort();
  const module_coverage = moduleNames.map((module_name) => {
    const rows = mods.filter((m) => m.module_name === module_name);
    const present = rows.filter((m) => canonical_fields[m.canonical_field] !== undefined);
    return {
      module_name,
      required_total: rows.filter((m) => m.is_required).length,
      required_present: present.filter((m) => m.is_required).length,
      trigger_total: rows.filter((m) => m.is_trigger).length,
      trigger_present: present.filter((m) => m.is_trigger).length,
      present_fields: present.map((m) => m.canonical_field),
      mapped_fields: rows,
    };
  });

  const feldCount = Number(psqlRows(`SELECT count(DISTINCT elster_kennzahl)::text FROM shared.feld_katalog WHERE steuerjahr = ${bridgeYear} AND aktiv = true AND elster_kennzahl IN (${inList});`)[0]?.[0] || '0');
  const zuCount = Number(psqlRows(`SELECT count(DISTINCT elster_code)::text FROM shared.bmf_elster_zuordnung WHERE elster_code IN (${inList});`)[0]?.[0] || '0');

  const result = {
    generated_at: new Date().toISOString(),
    input_path: inputPath,
    source: {
      appId: 'appId' in raw ? raw.appId || null : null,
      displayName: 'displayName' in raw ? raw.displayName || null : null,
      jahr: 'jahr' in raw ? raw.jahr || null : null,
      bridge_year: bridgeYear,
    },
    stats: {
      total_layer_entries: Object.keys(mergedLayer).length,
      computed_skipped: Object.keys(mergedLayer).length - declaredEntries.length,
      declared_inputs_used: filteredEntries.length,
      bridged_via_feld_katalog_ecodes: feldCount,
      bridged_via_zuordnung_ecodes: zuCount,
      projected_canonical_fields: Object.keys(canonical_fields).length,
      direct_lane1_module_fields: new Set(mods.map((m) => m.canonical_field)).size,
      direct_lane1_modules: moduleNames.length,
    },
    canonical_fields,
    field_details,
    module_coverage,
    unbridged_ecodes: ecodes.filter((e) => !feldByEcode.has(e) && !zuByEcode.has(e)),
    notes: [
      'BMF_RECHNER outputs were excluded from the projector input.',
      'feld_katalog is the broad production field catalog; bmf_elster_zuordnung is the narrower explicit bridge table.',
      'module_mappings shows only the direct lane1 inputs currently wired in ctax_production.',
    ],
  };

  await writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(`Input eCodes: ${filteredEntries.length}`);
  console.log(`feld_katalog bridged: ${result.stats.bridged_via_feld_katalog_ecodes}`);
  console.log(`bmf_elster_zuordnung bridged: ${result.stats.bridged_via_zuordnung_ecodes}`);
  console.log(`Projected canonical fields: ${result.stats.projected_canonical_fields}`);
  console.log(`Direct lane1 module fields: ${result.stats.direct_lane1_module_fields}`);
  console.log(`Direct lane1 modules: ${result.stats.direct_lane1_modules}`);
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
