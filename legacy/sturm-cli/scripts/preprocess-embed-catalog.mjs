#!/usr/bin/env node
/**
 * Embed the ELSTER catalog so the v2 embed-cascade has a query-compatible
 * index. The lane3_vector_store.embeddings on H200V are 384-dim (likely
 * all-MiniLM); we re-embed with bge-m3 (1024-dim, modern multilingual) so
 * runtime queries from Ollama match.
 *
 * Sources combined:
 *   - lane3_rich_text.json (4,389 rich-text "ELSTER-Code: ... Anlage: ...
 *     Bezeichnung: ... Steuereffekt: ... Rechtliche Grundlage: ...")
 *   - elster_kennzahlen.json (2,058 canonical bezeichnungen) — short form
 *
 * Output:
 *   data/ecode_index.bin       — Float32Array concat (count * 1024 * 4)
 *   data/ecode_index.meta.json — { dim, count, model, provider, entries[{id, meta}] }
 *
 * Usage:
 *   node scripts/preprocess-embed-catalog.mjs              # uses Ollama bge-m3
 *   node scripts/preprocess-embed-catalog.mjs --provider mistral
 *   node scripts/preprocess-embed-catalog.mjs --limit 50   # smoke test
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DATA = resolve(REPO_ROOT, 'src/verticals/elster/data');
const DUMPS = resolve(DATA, 'postgres-dumps');

function parseArgs(argv) {
  const flags = { provider: 'ollama', model: null, limit: Infinity, batch: 1, ollamaUrl: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--provider') flags.provider = argv[++i];
    else if (argv[i] === '--model') flags.model = argv[++i];
    else if (argv[i] === '--limit') flags.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--batch') flags.batch = parseInt(argv[++i], 10);
    else if (argv[i] === '--ollama-url') flags.ollamaUrl = argv[++i];
  }
  if (!flags.model) {
    flags.model = flags.provider === 'mistral' ? 'mistral-embed' : 'bge-m3';
  }
  if (!flags.ollamaUrl) {
    // Default to H200V if running from dev machine; localhost if env points here
    flags.ollamaUrl = process.env.OLLAMA_URL ?? 'http://h200v:11434';
  }
  return flags;
}

async function embedOllama(text, model, baseUrl) {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const d = await res.json();
  if (!d.embedding) throw new Error('no embedding in response');
  return new Float32Array(d.embedding);
}

async function embedMistralBatch(texts, model) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set');
  const res = await fetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`Mistral ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return (d.data ?? []).map((x) => new Float32Array(x.embedding ?? []));
}

async function main() {
  const flags = parseArgs(process.argv);
  console.error(`provider=${flags.provider} model=${flags.model} limit=${flags.limit}`);
  if (flags.provider === 'ollama') console.error(`ollama=${flags.ollamaUrl}`);

  // Load source texts
  const richText = JSON.parse(await readFile(join(DUMPS, 'lane3_rich_text.json'), 'utf-8'));
  const kennzahlen = JSON.parse(await readFile(join(DUMPS, 'elster_kennzahlen.json'), 'utf-8'));

  // Build the unified entry list. Prefer rich-text per eCode; fall back to
  // short bezeichnung from elster_kennzahlen for codes that lane3 missed.
  const seen = new Set();
  const entries = [];
  for (const r of richText) {
    const m = /ELSTER-Code:\s*(E\d{7})/.exec(r.text);
    if (!m) continue;
    const code = m[1];
    if (seen.has(code)) continue; // dedupe (lane3 has variants per code)
    seen.add(code);
    entries.push({
      id: code,
      text: r.text,
      meta: { source: 'lane3_rich_text', doc_type: r.doc_type },
    });
  }
  for (const k of kennzahlen) {
    if (!k.elster_code || seen.has(k.elster_code)) continue;
    seen.add(k.elster_code);
    const text = [
      `ELSTER-Code: ${k.elster_code}`,
      `Anlage: ${k.anlage ?? ''}`,
      `Bezeichnung: ${k.bezeichnung ?? ''}`,
      k.zeile ? `Zeile: ${k.zeile}` : null,
      k.sachbereich ? `Sachbereich: ${k.sachbereich}` : null,
    ].filter(Boolean).join('\n');
    entries.push({
      id: k.elster_code,
      text,
      meta: { source: 'elster_kennzahlen', anlage: k.anlage, zeile: k.zeile },
    });
  }
  console.error(`Catalog entries to embed: ${entries.length}`);

  const work = entries.slice(0, flags.limit);
  console.error(`Embedding ${work.length} entries via ${flags.provider}/${flags.model}...`);

  const t0 = Date.now();
  const vectors = [];
  let dim = null;

  if (flags.provider === 'mistral') {
    const batchSize = Math.min(flags.batch || 32, 64);
    for (let i = 0; i < work.length; i += batchSize) {
      const slice = work.slice(i, i + batchSize);
      const got = await embedMistralBatch(slice.map((e) => e.text), flags.model);
      vectors.push(...got);
      if (dim === null && got[0]) dim = got[0].length;
      if (i % 200 === 0) {
        const pct = ((i / work.length) * 100).toFixed(1);
        const ms = Date.now() - t0;
        console.error(`  ${i}/${work.length}  ${pct}%  (${ms}ms)`);
      }
    }
  } else {
    // Ollama — sequential (no batch endpoint)
    for (let i = 0; i < work.length; i++) {
      const v = await embedOllama(work[i].text, flags.model, flags.ollamaUrl);
      vectors.push(v);
      if (dim === null) dim = v.length;
      if (i % 100 === 0) {
        const pct = ((i / work.length) * 100).toFixed(1);
        const ms = Date.now() - t0;
        const eta = work.length > 0 ? Math.round((ms / Math.max(1, i)) * (work.length - i) / 1000) : 0;
        console.error(`  ${i}/${work.length}  ${pct}%  ${ms}ms elapsed  ~${eta}s ETA`);
      }
    }
  }

  console.error(`\nEmbedded ${vectors.length} vectors in ${Date.now() - t0}ms`);
  console.error(`Dimension: ${dim}`);

  // Write binary blob
  const blob = new Float32Array(vectors.length * dim);
  for (let i = 0; i < vectors.length; i++) {
    blob.set(vectors[i], i * dim);
  }
  await mkdir(DATA, { recursive: true });
  const binPath = join(DATA, `ecode_index_${flags.provider}_${flags.model.replace(/[:/]/g, '-')}.bin`);
  const metaPath = binPath.replace(/\.bin$/, '.meta.json');
  await writeFile(binPath, Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength));
  await writeFile(metaPath, JSON.stringify({
    dim,
    count: vectors.length,
    model: flags.model,
    provider: flags.provider,
    generatedAt: new Date().toISOString(),
    entries: work.map((e) => ({ id: e.id, meta: e.meta })),
  }, null, 2) + '\n', 'utf-8');

  console.error(`\nWrote: ${binPath} (${blob.byteLength} bytes)`);
  console.error(`Wrote: ${metaPath}`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
