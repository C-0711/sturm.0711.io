#!/usr/bin/env node
/**
 * Belege test runner. For each document in the test set:
 *   1. upload to a sturm workspace (or reuse an existing workspace if specified)
 *   2. fetch its post-cascade canonical ELSTER layer (per-document)
 *   3. compare against ground-truth annotation file
 *   4. compute per-doc-class hit rate
 *
 * USAGE:
 *   node scripts/run-belege-test.mjs <belege-dir>
 *      [--workspace <id>]              reuse this workspace instead of creating
 *      [--api <url>]                    sturm API base (default https://sturm.0711.io)
 *      [--groundtruth <dir>]            ground-truth dir (default tests/groundtruth)
 *      [--report <path>]                where to write JSON report (default tests/_report.json)
 *      [--limit N]                      process only first N files
 *      [--dry-run]                      don't upload, just match ground-truth files to docs
 *
 * GROUND-TRUTH FORMAT (tests/groundtruth/<doc-class>.json):
 *   {
 *     "docClass": "lohnsteuerbescheinigung",
 *     "expected": {
 *       "E0200201": { "value": 30707.00, "required": true },
 *       "E0200301": { "value": 2960.00,  "required": true }
 *     },
 *     "anchors": ["LBV NRW", "Bruttoarbeitslohn"]
 *   }
 *
 * Test runner picks the right ground-truth file by matching the document's
 * sturm-classification label to docClass. If multiple ground-truth files
 * exist for the same docClass, all are evaluated and the BEST hit-rate
 * counts (lets us bootstrap with one anchor case).
 */
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { dirname, basename, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next; i += 2;
      } else { flags[key] = true; i++; }
    } else { positional.push(a); i++; }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv);
const belegeDir = positional[0];
const apiBase = flags.api ?? 'https://sturm.0711.io';
const gtDir = flags.groundtruth ?? resolve(REPO_ROOT, 'tests/groundtruth');
const reportPath = flags.report ?? resolve(REPO_ROOT, 'tests/_report.json');
const limit = flags.limit ? parseInt(flags.limit, 10) : Infinity;
const dryRun = !!flags['dry-run'];
let workspaceId = flags.workspace ?? null;

if (!belegeDir) {
  console.error('usage: run-belege-test.mjs <belege-dir> [--workspace <id>] [--api <url>]');
  process.exit(1);
}

async function listFiles(dir) {
  try {
    const ents = await readdir(dir);
    const out = [];
    for (const e of ents) {
      const full = join(dir, e);
      try {
        const st = await stat(full);
        if (st.isFile() && /\.(pdf|png|jpe?g)$/i.test(e)) out.push(full);
      } catch {}
    }
    return out;
  } catch (e) {
    console.error(`cannot read ${dir}: ${e.message}`);
    return [];
  }
}

async function loadGroundTruth() {
  const map = new Map(); // docClass → array of expected entries
  let files;
  try { files = await readdir(gtDir); } catch { return map; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(await readFile(join(gtDir, f), 'utf-8'));
      const cls = data.docClass ?? f.replace('.json', '');
      const arr = map.get(cls) ?? [];
      arr.push({ file: f, ...data });
      map.set(cls, arr);
    } catch (e) {
      console.error(`bad ground-truth file ${f}: ${e.message}`);
    }
  }
  return map;
}

async function apiGet(path) {
  const url = `${apiBase}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function apiPostJson(path, body) {
  const url = `${apiBase}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return res.json();
}

async function uploadFile(wsId, absPath) {
  const url = `${apiBase}/api/workspaces/${encodeURIComponent(wsId)}/upload`;
  const r = spawnSync('/usr/bin/curl', [
    '-s', '-X', 'POST', url, '-F', `file=@${absPath}`,
  ], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`curl: ${r.stderr}`);
  // Auto-pipeline returns SSE; pull the final 'done' line for the meta
  const lines = r.stdout.split('\n').filter(Boolean);
  for (const line of lines.reverse()) {
    if (line.startsWith('data: ') && line.includes('"meta"')) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
    if (line.startsWith('data: ') && line.includes('"uuid"')) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  return null;
}

function compareToGroundTruth(layerCodes, expected) {
  const requiredCodes = Object.entries(expected).filter(([, v]) => v.required).map(([k]) => k);
  const optionalCodes = Object.entries(expected).filter(([, v]) => !v.required).map(([k]) => k);

  const required = { hit: 0, miss: 0, missing: [] };
  for (const c of requiredCodes) {
    if (c in layerCodes) required.hit++;
    else { required.miss++; required.missing.push(c); }
  }
  const optional = { hit: 0, miss: 0 };
  for (const c of optionalCodes) {
    if (c in layerCodes) optional.hit++;
    else optional.miss++;
  }

  const valueMatches = [];
  const valueMismatches = [];
  for (const [code, exp] of Object.entries(expected)) {
    if (!(code in layerCodes)) continue;
    const actual = layerCodes[code];
    const expVal = exp.value;
    if (looseEqual(actual, expVal)) valueMatches.push(code);
    else valueMismatches.push({ code, expected: expVal, actual });
  }

  return {
    required,
    optional,
    valueMatches: valueMatches.length,
    valueMismatches: valueMismatches.slice(0, 20),
    requiredCoverage: requiredCodes.length === 0 ? 1
      : required.hit / requiredCodes.length,
  };
}

function looseEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  return String(a).trim() === String(b).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

console.error(`belege dir: ${belegeDir}`);
console.error(`api: ${apiBase}`);
console.error(`groundtruth dir: ${gtDir}`);
console.error(`report: ${reportPath}`);

const files = (await listFiles(belegeDir)).slice(0, limit);
console.error(`found ${files.length} files`);

const groundTruth = await loadGroundTruth();
console.error(`ground-truth doc-classes: ${[...groundTruth.keys()].length}`);

if (dryRun) {
  console.error('DRY RUN — skipping upload, just listing what would happen');
  for (const f of files) {
    console.log(`would upload: ${basename(f)}`);
  }
  process.exit(0);
}

if (!workspaceId) {
  const slug = `belege-test-${Date.now()}`;
  console.error(`creating workspace ${slug}`);
  const ws = await apiPostJson('/api/workspaces', { name: slug });
  workspaceId = ws.id;
  console.error(`workspace id: ${workspaceId}`);
}

// Upload all files
const uploadedDocs = [];
for (const f of files) {
  console.error(`upload ${basename(f)}`);
  try {
    const meta = await uploadFile(workspaceId, f);
    uploadedDocs.push({ file: f, uuid: meta?.uuid ?? meta?.meta?.uuid, meta });
  } catch (e) {
    console.error(`  failed: ${e.message}`);
  }
}

// Fetch all docs (auto-pipeline already extracted KPIs)
const allDocs = await apiGet(`/api/workspaces/${encodeURIComponent(workspaceId)}/documents`);

// For each upload, compute the canonical layer by re-running the cascade
// LOCALLY against the bundled catalog. This avoids needing a server-side
// canonical-layer endpoint that may not exist yet.
//
// CLI-mode local cascade is in scripts/sturm-cli.mjs's cmdCascade — we inline
// a simpler version here so the test runner is self-contained.
const cat = await loadElsterCatalogJson();
const norm = (s) => (s ?? '').toString().toLowerCase()
  .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const bezIndex = new Map();
const drucktextIndex = new Map();
for (const b of Object.values(cat.feldKatalog.anlagen)) {
  for (const f of b.codes) {
    const n = norm(f.bezeichnung);
    if (n) {
      if (!bezIndex.has(n)) bezIndex.set(n, []);
      bezIndex.get(n).push(f.eCode);
    }
    const d = norm(f.drucktext);
    if (d && d !== n) {
      if (!drucktextIndex.has(d)) drucktextIndex.set(d, []);
      drucktextIndex.get(d).push(f.eCode);
    }
  }
}

// Build slug index from bmf_elster_zuordnung.json (the seed-mapping table).
// Priority-aware: never overwrite an existing entry with a lower priority
// (lower priority NUMBER = higher importance; manual_seed=1 always wins).
let slugIndex = new Map();
let slugPriority = new Map(); // key → best priority seen so far (lower = better)
try {
  const zuPath = resolve(REPO_ROOT, 'src/verticals/elster/data/bmf_elster_zuordnung.json');
  const zu = JSON.parse(await readFile(zuPath, 'utf-8'));
  for (const e of zu) {
    if (!e.isPrimary) continue;
    const key = norm(e.bmfFeld);
    const pri = e.priority ?? 99;
    const seen = slugPriority.get(key);
    if (seen === undefined || pri < seen) {
      slugIndex.set(key, e.elsterCode);
      slugPriority.set(key, pri);
    }
  }
} catch {}

function coerceValue(raw, datentyp) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  switch (datentyp) {
    case 'integer': {
      const n = parseGermanNumber(s);
      return n === null ? s : Math.round(n);
    }
    case 'currency': {
      const n = parseGermanNumber(s);
      return n === null ? s : n;
    }
    case 'date': {
      // Accept "DD.MM.YYYY" → "YYYY-MM-DD"
      const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
      if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      return s;
    }
    default: return s;
  }
}
function parseGermanNumber(s) {
  const t = s.replace(/[€$\s]/g, '').trim();
  if (!t) return null;
  // Strip thousands-dots, replace decimal comma with dot
  const norm = t.replace(/\./g, '').replace(',', '.');
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

function localCascade(kpis, recommendedAnlagen) {
  const codes = {};
  const traces = [];
  const unmapped = [];
  const allowed = recommendedAnlagen?.length
    ? new Set(recommendedAnlagen.flatMap((a) =>
        (cat.feldKatalog.anlagen[a]?.codes ?? []).map((f) => f.eCode)))
    : null;
  for (const k of kpis) {
    const norm_k = norm(k.key);
    // Stage 1+2: bezeichnung-exact / drucktext-exact
    let cands = bezIndex.get(norm_k) ?? drucktextIndex.get(norm_k) ?? [];
    let winnerStage = 'bezeichnung-exact';
    if (allowed && cands.length) {
      const inAnlage = cands.filter((c) => allowed.has(c));
      if (inAnlage.length) cands = inAnlage;
    }
    // Stage 3: bmf-slug alias (exact)
    if (cands.length === 0 && slugIndex.has(norm_k)) {
      cands = [slugIndex.get(norm_k)];
      winnerStage = 'bmf-slug';
    }
    // Stage 3b: bmf-slug alias on TAIL words (drop prefix). Sturm often emits
    // "Steuerkontoinhaber Vorname" while the catalog has just "Vorname".
    if (cands.length === 0) {
      const words = norm_k.split(' ').filter(Boolean);
      for (let start = 1; start < words.length; start++) {
        const tail = words.slice(start).join(' ');
        if (slugIndex.has(tail)) {
          cands = [slugIndex.get(tail)];
          winnerStage = 'bmf-slug-tail';
          break;
        }
      }
    }
    // Stage 3c: bmf-slug alias on HEAD words (drop suffix)
    if (cands.length === 0) {
      const words = norm_k.split(' ').filter(Boolean);
      for (let end = words.length - 1; end >= 1; end--) {
        const head = words.slice(0, end).join(' ');
        if (slugIndex.has(head)) {
          cands = [slugIndex.get(head)];
          winnerStage = 'bmf-slug-head';
          break;
        }
      }
    }
    // Stage 4: bezeichnung-fuzzy (token containment)
    if (cands.length === 0) {
      const tokens = norm_k.split(' ').filter((t) => t.length >= 4);
      if (tokens.length) {
        for (const b of Object.values(cat.feldKatalog.anlagen)) {
          for (const f of b.codes) {
            const target = norm(f.bezeichnung) + ' ' + norm(f.drucktext);
            const hits = tokens.filter((t) => target.includes(t)).length;
            if (hits / tokens.length >= 0.75) {
              cands.push(f.eCode);
              if (cands.length >= 3) break;
            }
          }
          if (cands.length >= 3) break;
        }
        if (cands.length) winnerStage = 'bezeichnung-fuzzy';
      }
    }
    if (cands.length === 0) {
      unmapped.push({ key: k.key, value: k.value });
      continue;
    }
    const winner = cands[0];
    const f = (() => {
      for (const b of Object.values(cat.feldKatalog.anlagen)) {
        for (const x of b.codes) if (x.eCode === winner) return x;
      }
      return null;
    })();
    const datentyp = f?.datentyp ?? 'string';
    const coerced = coerceValue(k.value, datentyp);
    if (!(winner in codes)) {
      codes[winner] = coerced;
      traces.push({ code: winner, value: coerced, source: winnerStage });
    }
  }
  return { codes, traces, unmapped };
}

// Per-document evaluation
const docResults = [];
const perClassStats = new Map();
for (const d of allDocs) {
  const cls = d.classification?.label ?? 'unknown';
  const kpis = d.classification?.kpis ?? [];
  const layer = localCascade(kpis, d.classification?.recommendedAnlagen ?? []);

  const matchAgainst = (groundTruth.get(cls) ?? []);
  let bestComparison = null;
  for (const gt of matchAgainst) {
    const cmp = compareToGroundTruth(layer.codes, gt.expected);
    if (!bestComparison || cmp.requiredCoverage > bestComparison.requiredCoverage) {
      bestComparison = { gtFile: gt.file, ...cmp };
    }
  }

  const docResult = {
    filename: d.originalFilename,
    docClass: cls,
    kpiCount: kpis.length,
    extractedCodes: Object.keys(layer.codes).length,
    unmapped: layer.unmapped.length,
    comparison: bestComparison,
  };
  docResults.push(docResult);

  if (matchAgainst.length === 0) continue;
  const stat = perClassStats.get(cls) ?? { docs: 0, requiredHit: 0, requiredTotal: 0, valueMatches: 0 };
  stat.docs++;
  stat.requiredHit += bestComparison.required.hit;
  stat.requiredTotal += bestComparison.required.hit + bestComparison.required.miss;
  stat.valueMatches += bestComparison.valueMatches;
  perClassStats.set(cls, stat);
}

// Summary
const summary = {
  workspaceId,
  filesUploaded: uploadedDocs.length,
  documentsProcessed: allDocs.length,
  docClassesWithGroundTruth: [...perClassStats.keys()],
  docClassesWithoutGroundTruth: [...new Set(docResults.map((r) => r.docClass))]
    .filter((c) => !perClassStats.has(c)),
  perClass: Object.fromEntries(
    [...perClassStats.entries()].map(([cls, s]) => [
      cls,
      {
        docs: s.docs,
        requiredCoverage: s.requiredTotal === 0 ? 1 : s.requiredHit / s.requiredTotal,
        requiredHit: s.requiredHit,
        requiredTotal: s.requiredTotal,
        valueMatches: s.valueMatches,
      },
    ]),
  ),
};

await mkdir(dirname(reportPath), { recursive: true });
const report = { generatedAt: new Date().toISOString(), summary, documents: docResults };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');

// Pretty print
console.log('\n=== TEST RESULT ===');
console.log(`workspace:     ${workspaceId}`);
console.log(`files:         ${uploadedDocs.length} uploaded, ${allDocs.length} in workspace`);
console.log(`with-gt:       ${[...perClassStats.keys()].length} doc-classes`);
console.log(`without-gt:    ${summary.docClassesWithoutGroundTruth.length} doc-classes (no annotation file)`);
console.log('');
console.log('per-class required-eCode coverage:');
for (const [cls, s] of perClassStats) {
  const pct = s.requiredTotal === 0 ? '—' : `${Math.round((s.requiredHit / s.requiredTotal) * 100)}%`;
  console.log(`  ${cls.padEnd(40)}  ${pct.padStart(5)}  (${s.requiredHit}/${s.requiredTotal} required, ${s.valueMatches} value-matches)`);
}
console.log(`\nfull report: ${reportPath}`);

async function loadElsterCatalogJson() {
  const dataRoot = resolve(REPO_ROOT, 'src/verticals/elster/data');
  const fk = JSON.parse(await readFile(join(dataRoot, 'feld_katalog_full.json'), 'utf-8'));
  const hr = JSON.parse(await readFile(join(dataRoot, 'hinweisregeln.json'), 'utf-8'));
  return { feldKatalog: fk, hinweisregeln: hr };
}
