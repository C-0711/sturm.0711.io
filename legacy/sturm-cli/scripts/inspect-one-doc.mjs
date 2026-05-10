#!/usr/bin/env node
/**
 * Single-doc inspection: print every extracted KPI side-by-side with v2 + v3 results.
 * Usage: node scripts/inspect-one-doc.mjs [<doc-class>]
 *   default doc-class: spendenquittung (the richest test case)
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
process.env.OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
process.env.VLLM_URL = process.env.VLLM_URL ?? 'http://localhost:11435';

const targetClass = process.argv[2] ?? 'spendenquittung';

const { loadCatalog } = await import(resolve(REPO_ROOT, 'src/verticals/elster/lib/elster-katalog.ts'));
const { loadBundledIndex, embed, cosineTopK } = await import(resolve(REPO_ROOT, 'src/lib/embedding-runtime.ts'));
const { chatJson } = await import(resolve(REPO_ROOT, 'src/lib/llm-chat.ts'));
const { loadV3Bundle } = await import(resolve(REPO_ROOT, 'src/verticals/elster-v3/lib/container-reader.ts'));
const { answer: v3Answer } = await import(resolve(REPO_ROOT, 'src/verticals/elster-v3/lib/three-lane.ts'));

const catalog = await loadCatalog();
const v2Index = await loadBundledIndex(
  resolve(REPO_ROOT, 'src/verticals/elster/data/ecode_index_ollama_bge-m3.bin'),
  resolve(REPO_ROOT, 'src/verticals/elster/data/ecode_index_ollama_bge-m3.meta.json'),
);
const v3Bundle = await loadV3Bundle();

// Load groundtruth for this class
const gt = JSON.parse(await readFile(
  resolve(REPO_ROOT, `tests/groundtruth/${targetClass}.json`), 'utf-8'));

// Pull docs
const r = spawnSync('/usr/bin/curl', ['-s',
  'https://sturm.0711.io/api/workspaces/haubrich-koch-hildburg-2024/documents'],
  { encoding: 'utf-8', maxBuffer: 50_000_000 });
const docs = JSON.parse(r.stdout);

// Pick the first doc of this class
const doc = docs.find((d) => d.classification?.label === targetClass);
if (!doc) {
  console.error(`No doc with class ${targetClass}`);
  process.exit(1);
}

console.log('═'.repeat(120));
console.log(`Document: ${doc.originalFilename}`);
console.log(`Classification: ${doc.classification.label}  (confidence ${doc.classification.confidence})`);
console.log(`Recommended Anlagen: ${(doc.classification.recommendedAnlagen ?? []).join(', ') || '-'}`);
console.log(`Total KPIs: ${(doc.classification.kpis ?? []).length}`);
console.log(`Doc UUID: ${doc.uuid}`);
console.log(`v3 container: ${v3Bundle.container.id}`);
console.log(`  merkle:    ${v3Bundle.container.merkle_root.slice(0, 32)}…`);
console.log(`  anchored:  ${!!v3Bundle.container.anchor_tx_hash}`);
console.log();
console.log('Ground truth (required eCodes):');
for (const [code, info] of Object.entries(gt.expected ?? {})) {
  if (info.required) console.log(`  ${code} = ${JSON.stringify(info.value)}  ← ${info.label ?? ''}`);
}
console.log();
console.log('═'.repeat(120));

const sanitize = (s) => String(s ?? '').replace(/[ --]/g, ' ').trim();

const recommendedAnlagen = doc.classification.recommendedAnlagen ?? [];

// Pre-build allow-set
const allowed = new Set();
for (const a of recommendedAnlagen) {
  const b = catalog.feldKatalog.anlagen[a];
  if (b) for (const f of b.codes) allowed.add(f.eCode);
}

async function v2Resolve(kpi) {
  const t0 = Date.now();
  const queryText = `Label: ${sanitize(kpi.key)}\nWert: ${sanitize(kpi.value)}\nAnlage: ${recommendedAnlagen.join(',')}`;
  let v;
  try { v = await embed(queryText, { provider: 'ollama', model: 'bge-m3' }); }
  catch (e) { return { code: null, source: 'embed-err', ms: Date.now() - t0 }; }
  const filtered = allowed.size ? v2Index.entries.filter((e) => allowed.has(e.id)) : v2Index.entries;
  if (filtered.length === 0) return { code: null, source: 'no-cands', ms: Date.now() - t0 };
  const top = cosineTopK(v, filtered, 5);
  if (top[0].score >= 0.78) {
    return { code: top[0].id, source: 'cosine', score: top[0].score.toFixed(3), ms: Date.now() - t0 };
  }
  // Reason
  const cand = top.map((c) => ({
    eCode: c.id, cosine: Number(c.score.toFixed(3)),
    bezeichnung: catalog.byCode.get(c.id)?.bezeichnung?.slice(0, 80) ?? '',
  }));
  const prompt = `KPI: ${sanitize(kpi.key)} = ${sanitize(kpi.value)} (Anlage ${recommendedAnlagen[0] ?? '?'})\n` +
    `Kandidaten:\n${cand.map((c) => `  ${c.eCode}: ${c.bezeichnung}`).join('\n')}\n` +
    `JSON: {"eCode":"E0xxxxxx","begruendung":"kurz"}`;
  try {
    const rr = await chatJson(prompt, { provider: 'vllm', model: 'gemma4-mm', temperature: 0, maxTokens: 150 });
    if (rr.parsed.eCode && catalog.byCode.has(rr.parsed.eCode)) {
      return { code: rr.parsed.eCode, source: 'reason', ms: Date.now() - t0 };
    }
  } catch {}
  return { code: top[0].id, source: 'cosine-fallback', score: top[0].score.toFixed(3), ms: Date.now() - t0 };
}

async function v3Resolve(kpi) {
  const t0 = Date.now();
  const query = `${sanitize(kpi.key)}: ${sanitize(kpi.value)}`;
  try {
    const r = await v3Answer(query, {
      recommendedAnlagen, topK: 5,
      chatProvider: 'vllm', chatModel: 'gemma4-mm',
      embedProvider: 'ollama', embedModel: 'bge-m3',
    });
    return { code: r.best_eCode, source: r.trap.triggered ? 'trap' : 'laneA', ms: Date.now() - t0 };
  } catch (e) {
    return { code: null, source: 'err: ' + e.message.slice(0, 30), ms: Date.now() - t0 };
  }
}

const reqCodes = new Set(Object.entries(gt.expected ?? {}).filter(([, v]) => v.required).map(([k]) => k));

console.log(`#  KPI                                              Value                       v2-eCode   v2-src    v3-eCode   v3-src    GT?`);
console.log('-'.repeat(120));

let v2Hits = new Set(), v3Hits = new Set();
const allKpis = doc.classification.kpis ?? [];
for (let i = 0; i < allKpis.length; i++) {
  const k = allKpis[i];
  const r2 = await v2Resolve(k);
  const r3 = await v3Resolve(k);
  if (r2.code) v2Hits.add(r2.code);
  if (r3.code) v3Hits.add(r3.code);
  const isGT = r2.code && reqCodes.has(r2.code) ? 'v2' :
               r3.code && reqCodes.has(r3.code) ? 'v3' : '-';
  const gtMark = (r2.code && reqCodes.has(r2.code)) || (r3.code && reqCodes.has(r3.code))
    ? ((r2.code && reqCodes.has(r2.code)) && (r3.code && reqCodes.has(r3.code)) ? 'BOTH'
       : (r2.code && reqCodes.has(r2.code)) ? 'v2  ' : ' v3 ')
    : '    ';
  const idx = String(i + 1).padStart(2);
  const key = (k.key ?? '').slice(0, 47).padEnd(48);
  const val = String(k.value ?? '').slice(0, 26).padEnd(27);
  const v2c = (r2.code ?? 'null').padEnd(10);
  const v2s = r2.source.slice(0, 9).padEnd(10);
  const v3c = (r3.code ?? 'null').padEnd(10);
  const v3s = r3.source.slice(0, 9).padEnd(10);
  console.log(`${idx} ${key} ${val} ${v2c} ${v2s} ${v3c} ${v3s} ${gtMark}`);
}

console.log('-'.repeat(120));
console.log(`Required (GT): ${[...reqCodes].join(', ') || '-'}`);
console.log(`v2 hits: ${[...v2Hits].filter((c) => reqCodes.has(c)).join(', ') || 'NONE'}  (covered ${[...reqCodes].filter((c) => v2Hits.has(c)).length}/${reqCodes.size})`);
console.log(`v3 hits: ${[...v3Hits].filter((c) => reqCodes.has(c)).join(', ') || 'NONE'}  (covered ${[...reqCodes].filter((c) => v3Hits.has(c)).length}/${reqCodes.size})`);
console.log();
console.log(`v2 distinct codes resolved: ${v2Hits.size}`);
console.log(`v3 distinct codes resolved: ${v3Hits.size}`);
console.log(`Disagreements (v2 ≠ v3 per KPI): visible above as "v2-eCode ≠ v3-eCode"`);
