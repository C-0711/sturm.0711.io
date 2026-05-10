#!/usr/bin/env node
/**
 * v2 cascade test against Hildburg's existing workspace.
 * For each document, walks classification.kpis[] through:
 *   Stage A: scope by recommendedAnlagen
 *   Stage B+C: embed query + cosine top-5
 *   Stage D: stub (BM25 not bundled yet)
 *   Stage E: Gemma-4 vLLM Reason on top-5 (only when cosine confidence ambiguous)
 * Compares result against tests/groundtruth/<docClass>.json — same metric.
 */
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DATA = resolve(REPO_ROOT, 'src/verticals/elster/data');

process.env.OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
process.env.VLLM_URL = process.env.VLLM_URL ?? 'http://localhost:11435';

// ── load runtime
const { loadCatalog } = await import(resolve(REPO_ROOT, 'src/verticals/elster/lib/elster-katalog.ts'));
const { loadBundledIndex, embed, cosineTopK } = await import(resolve(REPO_ROOT, 'src/lib/embedding-runtime.ts'));
const { chatJson } = await import(resolve(REPO_ROOT, 'src/lib/llm-chat.ts'));

const catalog = await loadCatalog();
const index = await loadBundledIndex(
  join(DATA, 'ecode_index_ollama_bge-m3.bin'),
  join(DATA, 'ecode_index_ollama_bge-m3.meta.json'),
);
console.error(`v2 cascade: ${index.entries.length} catalog embeddings (${index.dim}-dim)`);

// ── pull Hildburg workspace docs
const docsRes = spawnSync('/usr/bin/curl', [
  '-s', 'https://sturm.0711.io/api/workspaces/haubrich-koch-hildburg-2024/documents',
], { encoding: 'utf-8', maxBuffer: 50_000_000 });
const docs = JSON.parse(docsRes.stdout);
console.error(`Loaded ${docs.length} docs from Hildburg workspace`);

// ── load groundtruth files
const gtDir = join(REPO_ROOT, 'tests/groundtruth');
const { readdir } = await import('node:fs/promises');
const gtFiles = (await readdir(gtDir)).filter((f) => f.endsWith('.json'));
const gtByClass = new Map();
for (const f of gtFiles) {
  const data = JSON.parse(await readFile(join(gtDir, f), 'utf-8'));
  if (!gtByClass.has(data.docClass)) gtByClass.set(data.docClass, []);
  gtByClass.get(data.docClass).push(data);
}
console.error(`Loaded groundtruth for ${gtByClass.size} doc-classes`);

// ── per-doc cascade
async function resolveKpi(kpi, docClass, recommendedAnlagen) {
  const queryText = `Label: ${kpi.key}\nWert: ${kpi.value}\nAnlage: ${(recommendedAnlagen ?? []).join(',')}`;
  const v = await embed(queryText, { provider: 'ollama', model: 'bge-m3' });
  const allowed = new Set();
  for (const a of recommendedAnlagen ?? []) {
    const b = catalog.feldKatalog.anlagen[a];
    if (b) for (const f of b.codes) allowed.add(f.eCode);
  }
  const filtered = allowed.size ? index.entries.filter((e) => allowed.has(e.id)) : index.entries;
  const top = cosineTopK(v, filtered, 5);
  if (top.length === 0) return null;
  // Stage C: high-confidence cosine wins immediately
  if (top[0].score >= 0.78) {
    return { code: top[0].id, source: 'cosine', confidence: top[0].score };
  }
  // Stage E: Gemma-4 Reason
  const candidates = top.map((c) => ({
    eCode: c.id,
    cosine: Number(c.score.toFixed(3)),
    bezeichnung: catalog.byCode.get(c.id)?.bezeichnung?.slice(0, 100) ?? '',
    kontext: catalog.byCode.get(c.id)?.kontextPaths?.[0] ?? '',
  }));
  const prompt = `Wähle den korrekten ELSTER-eCode für diesen KPI aus einem ${docClass}-Dokument:\n` +
    `Label: ${kpi.key}  Wert: ${kpi.value}\n` +
    `Top-5 Kandidaten:\n` +
    candidates.map((c) => `  ${c.eCode} (kontext ${c.kontext}): ${c.bezeichnung}`).join('\n') +
    `\nJSON: {"eCode":"E0xxxxxx oder null","confidence":0.0..1.0,"begruendung":"kurz"}`;
  try {
    const r = await chatJson(prompt, { provider: 'vllm', model: 'gemma4-mm', temperature: 0, maxTokens: 150 });
    if (r.parsed.eCode && catalog.byCode.has(r.parsed.eCode)) {
      return { code: r.parsed.eCode, source: 'gemma-reason', confidence: r.parsed.confidence ?? 0.7 };
    }
  } catch (e) { /* fall through */ }
  // Fallback: best cosine even if low
  return { code: top[0].id, source: 'cosine-low', confidence: top[0].score };
}

// ── score per doc-class
const perClass = new Map();
for (const d of docs) {
  const cls = d.classification?.label;
  const gt = gtByClass.get(cls);
  if (!gt) continue;
  const kpis = d.classification?.kpis ?? [];
  const recommendedAnlagen = d.classification?.recommendedAnlagen ?? [];
  const codes = {};
  for (const k of kpis) {
    const r = await resolveKpi(k, cls, recommendedAnlagen);
    if (r && !(r.code in codes)) codes[r.code] = { value: k.value, source: r.source, conf: r.confidence };
  }
  // Compare against GT
  let bestStat = null;
  for (const gFile of gt) {
    const reqCodes = Object.entries(gFile.expected).filter(([, v]) => v.required).map(([k]) => k);
    let hit = 0;
    for (const c of reqCodes) if (c in codes) hit++;
    const cov = reqCodes.length ? hit / reqCodes.length : 1;
    if (!bestStat || cov > bestStat.cov) bestStat = { hit, total: reqCodes.length, cov };
  }
  if (!perClass.has(cls)) perClass.set(cls, { docs: 0, hit: 0, total: 0 });
  const s = perClass.get(cls);
  s.docs++;
  s.hit += bestStat.hit;
  s.total += bestStat.total;
  console.error(`  ${d.originalFilename.slice(0, 60).padEnd(60)}  cls=${cls}  ${bestStat.hit}/${bestStat.total}  (${Object.keys(codes).length} eCodes resolved)`);
}

console.log('\n=== v2 EMBED+REASON CASCADE RESULTS ===');
for (const [cls, s] of perClass) {
  const pct = s.total ? Math.round(100 * s.hit / s.total) : 100;
  console.log(`  ${cls.padEnd(40)}  ${pct.toString().padStart(3)}%  (${s.hit}/${s.total} required, ${s.docs} docs)`);
}
