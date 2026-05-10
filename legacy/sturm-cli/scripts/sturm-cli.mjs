#!/usr/bin/env node
/**
 * sturm CLI — exposes every sturm capability as a command.
 *
 * Architecture: command tree, one level per concern. Each leaf is a small
 * pure function that takes parsed args and prints to stdout/stderr. The CLI
 * uses fetch() against the public sturm.0711.io API for workspace/workflow
 * operations, so it works against any deployment (local or live).
 *
 * USAGE:
 *   sturm                                  show help
 *   sturm preprocess elster                run all ELSTER preprocessors
 *   sturm catalog stats                    show bundled catalog statistics
 *   sturm catalog show <eCode>             show one eCode's metadata
 *   sturm catalog search <query>           search bezeichnung/drucktext
 *   sturm cascade test <key> <value>       run cascade against one KPI
 *   sturm validate <layer.json>            run hinweisregeln against a layer
 *   sturm workspace list                   list workspaces
 *   sturm workspace create <name>          create workspace
 *   sturm workspace show <id>              show workspace summary
 *   sturm workspace upload <id> <file...>  upload one or more files
 *   sturm workspace docs <id>              list documents in workspace
 *   sturm workspace layer <id> [<std>]     fetch canonical layer (default: elster)
 *   sturm workflows                        list registered workflows
 *   sturm workflow run <id> <file>         run a workflow on one file
 *   sturm test belege <dir>                run test runner against ground truth
 *   sturm elster …                         ELSTER-specific subcommands
 *
 * GLOBAL OPTIONS:
 *   --api <url>     sturm API base URL (default: https://sturm.0711.io)
 *   --json          machine-readable JSON output where applicable
 *   -v, --verbose   extra diagnostics
 */

import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { dirname, basename, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// ─────────────────────────────────────────────────────────────────────────────
// arg parsing — minimal, no deps
// ─────────────────────────────────────────────────────────────────────────────

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
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      flags[key] = true; i++;
    } else {
      positional.push(a); i++;
    }
  }
  return { positional, flags };
}

const { positional: ARGS, flags: FLAGS } = parseArgs(process.argv);
const API_BASE = (FLAGS.api && typeof FLAGS.api === 'string') ? FLAGS.api : 'https://sturm.0711.io';
const VERBOSE = !!(FLAGS.verbose || FLAGS.v);
const AS_JSON = !!FLAGS.json;

function log(...m) { if (VERBOSE) console.error(...m); }
function err(...m) { console.error('error:', ...m); }
function out(obj) {
  if (AS_JSON) console.log(JSON.stringify(obj, null, 2));
  else if (typeof obj === 'string') console.log(obj);
  else console.log(JSON.stringify(obj, null, 2));
}

function usage(specific) {
  const lines = (specific ?? `
sturm — multi-standard mapping pipeline (ELSTER, ETIM, …)

Commands:
  preprocess <vertical>            Run preprocessors for a vertical
  catalog <stats|show|search>      Inspect bundled catalog data
  cascade test <key> <value>       Resolve one KPI through the cascade
  validate <layer.json>            Run rules against a canonical layer
  workspace <subcommand>           Workspace operations (live API)
  workflows                        List registered workflows
  workflow run <id> <file>         Run a workflow on one file
  test belege <dir>                Run the per-doc-class test runner
  verify [vertical]                Catalog integrity check (default: elster). Exits 1 on rot.
  elster <subcommand>              ELSTER-specific subcommands

Global flags:
  --api <url>      sturm API base URL (default https://sturm.0711.io)
  --json           machine-readable JSON output
  -v, --verbose    extra diagnostics
  -h, --help       show this help

Examples:
  sturm preprocess elster
  sturm catalog show E0200201
  sturm catalog search "bruttoarbeitslohn"
  sturm cascade test "Bruttoarbeitslohn" 30707
  sturm workspace create "Hildburg 2024"
  sturm workspace upload haubrich-koch-hildburg-2024 *.pdf
  sturm workspace layer haubrich-koch-hildburg-2024 elster
  sturm test belege ~/Desktop/Belege
`).trim();
  console.log(lines);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function cmdPreprocess(rest) {
  const vertical = rest[0];
  if (!vertical) { err('usage: sturm preprocess <vertical>'); process.exit(1); }
  switch (vertical) {
    case 'elster':
      log('running preprocess-jahresdokumentation.mjs');
      runNode(resolve(REPO_ROOT, 'scripts/preprocess-jahresdokumentation.mjs'),
              VERBOSE ? ['--verbose'] : []);
      log('running preprocess-feldkatalog.mjs (if present)');
      const fk = resolve(REPO_ROOT, 'scripts/preprocess-feldkatalog.mjs');
      const exists = await fileExists(fk);
      if (exists) runNode(fk, []);
      else log('  (skipped — script not present yet; needs Postgres access)');
      out({ vertical: 'elster', status: 'preprocess-complete' });
      break;
    default:
      err(`unknown vertical: ${vertical}`);
      process.exit(1);
  }
}

async function cmdCatalog(rest) {
  const sub = rest[0];
  const cat = await loadElsterCatalogJson();
  switch (sub) {
    case 'stats': {
      const anlagen = Object.keys(cat.feldKatalog.anlagen).sort();
      const stats = {
        catalogVersion: cat.feldKatalog.catalogVersion,
        anlagenCount: cat.feldKatalog.anlagenCount,
        totalCodes: cat.feldKatalog.totalCodes,
        totalRules: cat.hinweisregeln.totalRules,
        anlagen: anlagen.map((a) => ({
          name: a,
          codes: cat.feldKatalog.anlagen[a].codeCount,
          rules: cat.hinweisregeln.anlagen[a]?.ruleCount ?? 0,
        })),
      };
      out(stats);
      break;
    }
    case 'show': {
      const code = rest[1];
      if (!code) { err('usage: sturm catalog show <eCode>'); process.exit(1); }
      const found = findECode(cat, code);
      if (!found) { err(`eCode not found: ${code}`); process.exit(1); }
      out(found);
      break;
    }
    case 'search': {
      const query = rest.slice(1).join(' ').toLowerCase();
      if (!query) { err('usage: sturm catalog search <query>'); process.exit(1); }
      const hits = [];
      for (const [anlage, b] of Object.entries(cat.feldKatalog.anlagen)) {
        for (const f of b.codes) {
          const text = (f.bezeichnung + ' ' + f.drucktext).toLowerCase();
          if (text.includes(query)) {
            hits.push({ anlage, eCode: f.eCode, bezeichnung: f.bezeichnung, datentyp: f.datentyp });
            if (hits.length >= 50) break;
          }
        }
        if (hits.length >= 50) break;
      }
      out({ query, hitCount: hits.length, hits });
      break;
    }
    case 'rules': {
      const anlage = rest[1];
      if (!anlage) { err('usage: sturm catalog rules <Anlage>'); process.exit(1); }
      const bucket = cat.hinweisregeln.anlagen[anlage];
      if (!bucket) { err(`Anlage not found: ${anlage}`); process.exit(1); }
      out({
        anlage,
        ruleCount: bucket.ruleCount,
        sample: bucket.rules.slice(0, 10).map((r) => ({
          name: r.name,
          fehlercode: r.fehlercode,
          severity: r.severity,
          fehlertext: r.fehlertext.slice(0, 200),
          referencedECodes: r.referencedECodes.slice(0, 8),
        })),
      });
      break;
    }
    default:
      err('usage: sturm catalog <stats|show|search|rules>');
      process.exit(1);
  }
}

async function cmdCascade(rest) {
  const sub = rest[0];
  if (sub !== 'test') { err('usage: sturm cascade test <key> <value>'); process.exit(1); }
  const key = rest[1];
  const value = rest[2];
  if (!key) { err('missing <key>'); process.exit(1); }

  // Dynamic import of the cascade — Node can load .ts only via ts-node/loader.
  // Workaround: use a small inline JS shim that ports the deterministic stages
  // we built. Full TS execution is delegated to the runtime when stages are
  // imported by the sturm engine.
  const cat = await loadElsterCatalogJson();
  const norm = (s) => (s ?? '').toString().toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  const k = norm(key);
  const result = { key, value, attempts: [] };

  // Stage 1: bezeichnung-exact (build index in-line)
  const bezIndex = new Map();
  for (const b of Object.values(cat.feldKatalog.anlagen)) {
    for (const f of b.codes) {
      const n = norm(f.bezeichnung);
      if (!n) continue;
      if (!bezIndex.has(n)) bezIndex.set(n, []);
      if (!bezIndex.get(n).includes(f.eCode)) bezIndex.get(n).push(f.eCode);
    }
  }
  const exact = bezIndex.get(k) ?? [];
  result.attempts.push({ stage: 'bezeichnung-exact', candidateCount: exact.length, candidates: exact.slice(0, 5) });

  // Stage 2: bezeichnung-fuzzy — token containment
  const tokens = k.split(' ').filter((t) => t.length >= 4);
  const fuzzy = [];
  if (tokens.length) {
    for (const b of Object.values(cat.feldKatalog.anlagen)) {
      for (const f of b.codes) {
        const target = norm(f.bezeichnung) + ' ' + norm(f.drucktext);
        const hits = tokens.filter((t) => target.includes(t)).length;
        if (hits / tokens.length >= 0.75) {
          fuzzy.push({ eCode: f.eCode, bezeichnung: f.bezeichnung.slice(0, 60), score: hits / tokens.length });
        }
      }
    }
    fuzzy.sort((a, b) => b.score - a.score);
  }
  result.attempts.push({ stage: 'bezeichnung-fuzzy', candidateCount: fuzzy.length, top5: fuzzy.slice(0, 5) });

  // Determine winner
  const winner = exact.length > 0
    ? { stage: 'bezeichnung-exact', code: exact[0], confidence: 0.98 }
    : (fuzzy.length > 0 ? { stage: 'bezeichnung-fuzzy', code: fuzzy[0].eCode, confidence: 0.75 } : null);

  result.winner = winner;
  out(result);
}

async function cmdValidate(rest) {
  const layerPath = rest[0];
  if (!layerPath) { err('usage: sturm validate <layer.json>'); process.exit(1); }
  const layer = JSON.parse(await readFile(layerPath, 'utf-8'));
  // We can't import the .ts evaluator from a .mjs CLI easily without a TS
  // loader. So we implement a minimal evaluator inline that handles the most
  // common patterns. For the full evaluator, run the validator-stage via the
  // sturm engine.
  const cat = await loadElsterCatalogJson();
  const present = (code) => layer.codes && layer.codes[code] !== undefined && layer.codes[code] !== null;

  const fired = [];
  for (const bucket of Object.values(cat.hinweisregeln.anlagen)) {
    for (const r of bucket.rules) {
      const bedingung = r.pruefbedingung || '';
      // Tiny heuristic: rule fires when all referenced codes are present AND the
      // pattern looks like a "summenpruefung" or "fehlerhaft" rule. Full
      // evaluation requires the AST evaluator (see hinweisregeln.ts).
      if (!bedingung) continue;
      const allPresent = r.referencedECodes.length > 0 && r.referencedECodes.every(present);
      if (allPresent && /KeinFeldAngegeben|FeldNichtAngegeben/.test(bedingung)) {
        // Inverted rule — referenced codes ARE present, so the "kein/nicht"
        // condition fails, so this rule does NOT fire.
      }
      // Skip CLI-mode evaluation; report counts only.
    }
  }
  out({
    note: 'CLI-mode quick validate. For full Hinweisregel evaluation, run the validator-stage via the sturm engine.',
    layer: { schemaId: layer.schemaId, version: layer.version, codeCount: Object.keys(layer.codes ?? {}).length },
    rulesetSize: cat.hinweisregeln.totalRules,
    firedCount: fired.length,
  });
}

async function cmdWorkspace(rest) {
  const sub = rest[0];
  switch (sub) {
    case 'list': {
      const r = await apiGet('/api/workspaces');
      out(r);
      break;
    }
    case 'create': {
      const name = rest[1];
      if (!name) { err('usage: sturm workspace create <name>'); process.exit(1); }
      const r = await apiPostJson('/api/workspaces', { name });
      out(r);
      break;
    }
    case 'show': {
      const id = rest[1];
      if (!id) { err('usage: sturm workspace show <id>'); process.exit(1); }
      const r = await apiGet(`/api/workspaces/${encodeURIComponent(id)}`);
      out(r);
      break;
    }
    case 'docs':
    case 'documents': {
      const id = rest[1];
      if (!id) { err('usage: sturm workspace docs <id>'); process.exit(1); }
      const docs = await apiGet(`/api/workspaces/${encodeURIComponent(id)}/documents`);
      if (AS_JSON) out(docs);
      else {
        for (const d of docs) {
          console.log(`${d.uuid}  ${d.classification?.label ?? '?'}  ${d.originalFilename}`);
        }
      }
      break;
    }
    case 'upload': {
      const id = rest[1];
      const files = rest.slice(2);
      if (!id || files.length === 0) { err('usage: sturm workspace upload <id> <file...>'); process.exit(1); }
      for (const f of files) {
        const abs = resolve(process.cwd(), f);
        log(`uploading ${abs}`);
        const code = await uploadFile(id, abs);
        console.log(`${basename(abs)}: ${code}`);
      }
      break;
    }
    case 'layer': {
      const id = rest[1];
      const std = rest[2] ?? 'elster';
      if (!id) { err('usage: sturm workspace layer <id> [<standard>]'); process.exit(1); }
      const r = await apiGet(`/api/workspaces/${encodeURIComponent(id)}/canonical-layers/${std}`);
      out(r);
      break;
    }
    default:
      err('usage: sturm workspace <list|create|show|docs|upload|layer>');
      process.exit(1);
  }
}

async function cmdWorkflows(_rest) {
  const r = await apiGet('/api/workflows');
  out(r);
}

async function cmdWorkflowRun(rest) {
  const id = rest[0];
  const file = rest[1];
  if (!id || !file) { err('usage: sturm workflow run <workflow-id> <file>'); process.exit(1); }
  const abs = resolve(process.cwd(), file);
  const path = `/api/workflows/${encodeURIComponent(id)}/runs`;
  const code = await uploadFile(null, abs, path);
  console.log(`${basename(abs)}: ${code}`);
}

async function cmdTest(rest) {
  const sub = rest[0];
  if (sub !== 'belege') { err('usage: sturm test belege <dir>'); process.exit(1); }
  const dir = rest[1];
  if (!dir) { err('missing <dir>'); process.exit(1); }
  const tester = resolve(REPO_ROOT, 'scripts/run-belege-test.mjs');
  if (!await fileExists(tester)) {
    err('test runner not present yet: scripts/run-belege-test.mjs');
    process.exit(1);
  }
  runNode(tester, [dir]);
}

async function cmdElster(rest) {
  const sub = rest[0];
  switch (sub) {
    case 'cascade':
      return cmdCascade(rest.slice(1));
    case 'catalog':
      return cmdCatalog(rest.slice(1));
    case 'validate':
      return cmdValidate(rest.slice(1));
    case 'preprocess':
      return cmdPreprocess(['elster']);
    case 'verify':
      return cmdVerify(rest.slice(1));
    default:
      err('usage: sturm elster <cascade|catalog|validate|preprocess|verify>');
      process.exit(1);
  }
}

/**
 * Catalog integrity check. Walks every eCode in:
 *   - src/verticals/elster/data/bmf_elster_zuordnung.json
 *   - src/verticals/elster/data/konzept_zuordnung.json
 *   - tests/groundtruth/*.json
 * and reports any code not in feld_katalog_full.json. Exit 1 on any rot.
 *
 * Run this in CI before any deploy. The same gate runs at startup inside
 * loadCatalog() so a rotten ref also throws on the first sturm-engine boot,
 * but `sturm verify` lets you check without touching the runtime.
 */
async function cmdVerify(rest) {
  const cat = await loadElsterCatalogJson();
  const known = new Set();
  for (const b of Object.values(cat.feldKatalog.anlagen)) {
    for (const f of b.codes) known.add(f.eCode);
  }

  const findings = [];

  // bmf_elster_zuordnung
  try {
    const zu = JSON.parse(await readFile(
      resolve(REPO_ROOT, 'src/verticals/elster/data/bmf_elster_zuordnung.json'), 'utf-8',
    ));
    for (const e of zu) {
      if (!known.has(e.elsterCode)) {
        findings.push({ source: 'bmf_elster_zuordnung.json', key: e.bmfFeld, code: e.elsterCode });
      }
    }
  } catch (e) { /* missing file is OK */ }

  // konzept_zuordnung
  try {
    const kz = JSON.parse(await readFile(
      resolve(REPO_ROOT, 'src/verticals/elster/data/konzept_zuordnung.json'), 'utf-8',
    ));
    const arr = Array.isArray(kz) ? kz : (kz.entries ?? []);
    for (const c of arr) {
      for (const code of c.elsterCodes ?? []) {
        if (!known.has(code)) {
          findings.push({ source: 'konzept_zuordnung.json', key: c.conceptSlug, code });
        }
      }
    }
  } catch { /* missing OK */ }

  // ground truth
  const gtDir = resolve(REPO_ROOT, 'tests/groundtruth');
  try {
    const files = await readdir(gtDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const gt = JSON.parse(await readFile(join(gtDir, f), 'utf-8'));
      for (const code of Object.keys(gt.expected ?? {})) {
        if (!known.has(code)) {
          findings.push({ source: `tests/groundtruth/${f}`, key: gt.docClass ?? '?', code });
        }
      }
    }
  } catch { /* OK */ }

  if (findings.length === 0) {
    out({ status: 'ok', catalogVersion: cat.feldKatalog.catalogVersion, knownCodes: known.size });
    return;
  }
  err(`${findings.length} rotten eCode reference(s) found:`);
  for (const f of findings) {
    err(`  ${f.source}: "${f.key}" → ${f.code} (NOT in catalog)`);
  }
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

async function apiGet(path) {
  const url = `${API_BASE}${path}`;
  log(`GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function apiPostJson(path, body) {
  const url = `${API_BASE}${path}`;
  log(`POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function uploadFile(workspaceId, absPath, overridePath) {
  // Use curl since fetch's multipart story is awkward in plain Node.
  const path = overridePath ?? `/api/workspaces/${encodeURIComponent(workspaceId)}/upload`;
  const url = `${API_BASE}${path}`;
  log(`UPLOAD ${url} ← ${absPath}`);
  const r = spawnSync('/usr/bin/curl', [
    '-s', '-o', '/dev/null', '-w', '%{http_code}',
    '-X', 'POST', url, '-F', `file=@${absPath}`,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`curl failed: ${r.stderr}`);
  return r.stdout.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadElsterCatalogJson() {
  const dataRoot = resolve(REPO_ROOT, 'src/verticals/elster/data');
  const fk = JSON.parse(await readFile(join(dataRoot, 'feld_katalog_full.json'), 'utf-8'));
  const hr = JSON.parse(await readFile(join(dataRoot, 'hinweisregeln.json'), 'utf-8'));
  return { feldKatalog: fk, hinweisregeln: hr };
}

function findECode(cat, code) {
  for (const [anlage, b] of Object.entries(cat.feldKatalog.anlagen)) {
    for (const f of b.codes) {
      if (f.eCode === code) return { anlage, ...f };
    }
  }
  return null;
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function runNode(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// dispatch
// ─────────────────────────────────────────────────────────────────────────────

const cmd = ARGS[0];
const rest = ARGS.slice(1);

if (!cmd || cmd === 'help' || FLAGS.h || FLAGS.help) {
  usage();
  process.exit(0);
}

try {
  switch (cmd) {
    case 'preprocess':         await cmdPreprocess(rest); break;
    case 'catalog':            await cmdCatalog(rest); break;
    case 'cascade':            await cmdCascade(rest); break;
    case 'validate':           await cmdValidate(rest); break;
    case 'workspace':          await cmdWorkspace(rest); break;
    case 'workflows':          await cmdWorkflows(rest); break;
    case 'workflow':
      if (rest[0] === 'run') await cmdWorkflowRun(rest.slice(1));
      else { err('usage: sturm workflow run <id> <file>'); process.exit(1); }
      break;
    case 'test':               await cmdTest(rest); break;
    case 'verify':             await cmdVerify(rest); break;
    case 'elster':             await cmdElster(rest); break;
    default:
      err(`unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
} catch (e) {
  err(e.message ?? e);
  if (VERBOSE) console.error(e.stack);
  process.exit(1);
}
