#!/usr/bin/env -S npx tsx
/**
 * encode-corpus — generalisierter Quantum-Encoder: macht aus einem beliebigen
 * Text-Korpus (JSONL: {id,text,source,...}) eine MRL×TurboQuant-Cascade im
 * GLEICHEN Wire-Format wie scripts/encode-gemma-quantum-container.ts (lädt mit
 * src/lib/quantum-index.ts). Lange Texte werden re-gechunkt (embeddinggemma-
 * Fenster). Schreibt zusätzlich chunks.json (Index→Chunk-Mapping) für den
 * quantum-rag-Dienst.
 *
 *   CORPUS_JSONL=var/quantum/corpus/lane3.jsonl OUT_DIR=var/quantum/corpus \
 *   CONTAINER_ID=0711:ctax:gemma4-tq:corpus:v1 npx tsx scripts/encode-corpus.ts
 *
 * Optional: LIMIT=2000 (nur erste N Eingabezeilen — Pipeline-Test),
 *           CHUNK_CHARS=4000 CHUNK_OVERLAP=400 GEMMA_EMBED_BATCH=32.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { TurboQuantizer } from '../src/lib/qjl/index.ts';
import { embedDocuments, embedQueries, mrlTruncate, GEMMA_EMBED_DEFAULTS, formatDocument, formatQuery, l2normalize } from '../src/lib/gemma-embed.ts';

// ── Embed-Backend: vLLM (GPU, gebatcht, ~20–100× schneller als ollama-auf-CPU)
//    oder ollama. embeddinggemma ist beidseits dasselbe Modell → gleicher Raum.
const EMBED_BACKEND = process.env.EMBED_BACKEND ?? 'vllm';
const EMBED_VLLM_URL = process.env.EMBED_VLLM_URL ?? 'http://127.0.0.1:11436';
const EMBED_VLLM_MODEL = process.env.EMBED_VLLM_MODEL ?? 'embeddinggemma';

async function vllmEmbed(inputsRaw: string[], cap = 2600): Promise<Float32Array[]> {
  // Harte Zeichen-Kappung (embeddinggemma-Fenster = 2048 Tokens). Bei Context-
  // Length-400 wird cap rekursiv verkleinert → garantiert passend, egal wie
  // dicht der Text tokenisiert.
  const inputs = inputsRaw.map((s) => (s.length > cap ? s.slice(0, cap) : s));
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${EMBED_VLLM_URL}/v1/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ model: EMBED_VLLM_MODEL, input: inputs }),
      });
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 400 && /context length|maximum context/i.test(body) && cap > 500)
          return vllmEmbed(inputsRaw, Math.floor(cap * 0.6)); // zu lang → härter kappen + neu
        throw new Error(`vLLM /v1/embeddings ${res.status}: ${body.slice(0, 160)}`);
      }
      const j = await res.json() as { data: Array<{ embedding: number[]; index: number }> };
      const out: Float32Array[] = new Array(inputs.length);
      for (const d of j.data) out[d.index] = l2normalize(new Float32Array(d.embedding)); // embeddinggemma-Raum: L2-normiert
      return out;
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); }
  }
  throw lastErr;
}
/** Dokumente embedden (Backend-agnostisch, mit Task-Prompt). */
async function embedDocs(texts: string[], titles: (string | undefined)[]): Promise<Float32Array[]> {
  if (EMBED_BACKEND === 'vllm') return vllmEmbed(texts.map((t, i) => formatDocument(t, titles[i])));
  return embedDocuments(texts, titles);
}
/** Queries embedden (Backend-agnostisch). */
async function embedQ(texts: string[]): Promise<Float32Array[]> {
  if (EMBED_BACKEND === 'vllm') return vllmEmbed(texts.map(formatQuery));
  return embedQueries(texts);
}

const SEED = 42;
const CONTAINER_ID = process.env.CONTAINER_ID ?? '0711:ctax:gemma4-tq:corpus:v1';
const CORPUS_JSONL = resolve(process.cwd(), process.env.CORPUS_JSONL ?? 'var/quantum/corpus/lane3.jsonl');
const OUT_DIR = resolve(process.cwd(), process.env.OUT_DIR ?? 'var/quantum/corpus');
const BATCH = Number(process.env.GEMMA_EMBED_BATCH ?? (EMBED_BACKEND === 'vllm' ? 128 : 32));
const LIMIT = Number(process.env.LIMIT ?? 0);
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS ?? 2600); // ~<2048 Tokens auch bei dichtem Text
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? 400);

const TIERS = [
  { d: 256, b: 3, keepTopK: 256, file: 'corpus.tq-d256-b3.bin' },
  { d: 768, b: 3, keepTopK: 48, file: 'corpus.tq-d768-b3.bin' },
];

interface Chunk { id: string; text: string; title: string; source?: string; doc_type?: string; legal_area?: string; year?: number; parent: string; ci: number; }

/** Lange Texte in überlappende Zeichen-Fenster splitten; kurze bleiben ganz. */
function rechunk(text: string, parent: string): Array<{ text: string; ci: number }> {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= CHUNK_CHARS) return [{ text: t, ci: 0 }];
  const out: Array<{ text: string; ci: number }> = [];
  const step = Math.max(CHUNK_CHARS - CHUNK_OVERLAP, 1000);
  for (let i = 0, ci = 0; i < t.length; i += step, ci++) out.push({ text: t.slice(i, i + CHUNK_CHARS), ci });
  return out;
}

function packIndicesBE(indices: Uint8Array, b: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((indices.length * b) / 8));
  let bitPos = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] & ((1 << b) - 1);
    for (let bi = b - 1; bi >= 0; bi--) { out[bitPos >> 3] |= ((v >> bi) & 1) << (7 - (bitPos & 7)); bitPos++; }
  }
  return out;
}

function encodeTier(vectors: Float32Array[], d: number, b: number, seed: number) {
  const turbo = new TurboQuantizer(d, b, seed);
  const POLAR = (d * b) / 8, QJL = d / 8, REC = POLAR + QJL + 8;
  const seedSha = createHash('sha256').update(`tq-seed-${seed}-d${d}-b${b}`, 'utf-8').digest();
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x5451454d, 0); header.writeUInt16LE(1, 4); header.writeUInt16LE(d, 6);
  header.writeUInt8(b, 8); header.writeUInt32LE(vectors.length, 9); header.writeUInt32LE(seed, 13);
  seedSha.subarray(0, 15).copy(header, 17);
  const body = Buffer.alloc(vectors.length * REC);
  let off = 0, zero = 0;
  for (const x of vectors) {
    if (x.length !== d) throw new Error(`encodeTier(d=${d}): vec len ${x.length}`);
    let n2 = 0; for (let j = 0; j < d; j++) n2 += x[j] * x[j];
    if (n2 === 0) { off += REC; zero++; continue; }
    const enc = turbo.encode(x);
    body.set(packIndicesBE(enc.polar.quantizedBits, b), off); off += POLAR;
    body.set(enc.qjlSigns, off); off += QJL;
    body.writeFloatLE(enc.polar.norm, off); off += 4;
    body.writeFloatLE(enc.residualNorm, off); off += 4;
  }
  const buffer = Buffer.concat([header, body]);
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex'), recordBytes: REC, compressionRatio: (d * 4) / REC, zeroCount: zero };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  console.error(`=== encode-corpus → ${CONTAINER_ID} ===`);
  console.error(`  in:  ${CORPUS_JSONL}`);
  console.error(`  out: ${OUT_DIR}`);
  console.error(`  embedder: ${GEMMA_EMBED_DEFAULTS.model} @ ${GEMMA_EMBED_DEFAULTS.url}  cpu=${process.env.EMBED_CPU === '1' ? 'YES' : 'no'}`);

  // 1. JSONL lesen + re-chunken
  const raw = await readFile(CORPUS_JSONL, 'utf-8');
  let lines = raw.split('\n').filter((l) => l.trim());
  if (LIMIT > 0) lines = lines.slice(0, LIMIT);
  const chunks: Chunk[] = [];
  for (const line of lines) {
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (!r.text || typeof r.text !== 'string') continue;
    const title = [r.source, r.legal_area].filter(Boolean).join(' ').trim() || 'Dokument';
    for (const part of rechunk(r.text, String(r.id))) {
      chunks.push({ id: `${r.id}#${part.ci}`, text: part.text, title, source: r.source, doc_type: r.doc_type, legal_area: r.legal_area, year: r.year, parent: String(r.id), ci: part.ci });
    }
  }
  console.error(`  ${lines.length} Dokumente → ${chunks.length} Sub-Chunks (chunk=${CHUNK_CHARS}/overlap=${CHUNK_OVERLAP})`);

  // 2. Embedden (Dokument-Seite, batched + NEBENLÄUFIG — ollama/embeddinggemma
  //    macht ~200ms/Chunk auch gebatcht (GPU von vLLM gesättigt); CONCURRENCY
  //    parallele Requests heben den Durchsatz ~Nx.
  const CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? 8);
  console.error(`\n[1/4] Embedding ${chunks.length} Chunks (concurrency=${CONCURRENCY}, batch=${BATCH}) …`);
  const t0 = Date.now();
  const vectors: Float32Array[] = new Array(chunks.length);
  let D = 0, done = 0;
  const starts: number[] = [];
  for (let i = 0; i < chunks.length; i += BATCH) starts.push(i);
  const lanes: number[][] = Array.from({ length: CONCURRENCY }, () => []);
  starts.forEach((s, idx) => lanes[idx % CONCURRENCY].push(s));
  await Promise.all(lanes.map(async (lane) => {
    for (const i of lane) {
      const slice = chunks.slice(i, i + BATCH);
      const batch = await embedDocs(slice.map((c) => c.text), slice.map((c) => c.title));
      for (let k = 0; k < batch.length; k++) vectors[i + k] = batch[k];
      if (!D) D = batch[0].length;
      done += slice.length;
      if (done % (BATCH * 20) < BATCH) console.error(`  ${done}/${chunks.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s, ${(done / ((Date.now() - t0) / 1000)).toFixed(0)}/s)`);
    }
  }));
  console.error(`  native dim ${D} · ${chunks.length} Chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s (${(chunks.length / ((Date.now() - t0) / 1000)).toFixed(0)}/s)`);

  // 3. fp32 + Tiers + Manifest schreiben
  console.error(`\n[2/4] fp32 …`);
  const fp32 = Buffer.alloc(chunks.length * D * 4);
  for (let i = 0; i < chunks.length; i++) for (let j = 0; j < D; j++) fp32.writeFloatLE(vectors[i][j], (i * D + j) * 4);
  await writeFile(resolve(OUT_DIR, 'corpus.fp32.bin'), fp32);
  const fp32Sha = createHash('sha256').update(fp32).digest('hex');

  console.error(`[3/4] Cascade-Tiers …`);
  const tierBlobs = [];
  for (const t of TIERS) {
    const vecs = t.d === D ? vectors : vectors.map((v) => mrlTruncate(new Float32Array(v), t.d));
    const blob = encodeTier(vecs, t.d, t.b, SEED);
    await writeFile(resolve(OUT_DIR, t.file), blob.buffer);
    console.error(`  ${t.file}  d=${t.d} b=${t.b} → ${(blob.buffer.byteLength / 1e6).toFixed(1)}MB (${blob.recordBytes}B/vec)`);
    tierBlobs.push({ ...blob, spec: t });
  }
  const manifest = {
    containerId: CONTAINER_ID, nativeDim: D, seed: SEED,
    embedder: { provider: 'ollama', model: process.env.EMBED_MODEL ?? GEMMA_EMBED_DEFAULTS.model, base_url: process.env.OLLAMA_URL ?? GEMMA_EMBED_DEFAULTS.url, family: 'google/embeddinggemma-300m', matryoshka: [768, 512, 256, 128], document_prompt: 'title: {title|none} | text: {content}', query_prompt: 'task: search result | query: {content}' },
    tiers: tierBlobs.map((t) => ({ file: t.spec.file, d: t.spec.d, b: t.spec.b, n: chunks.length, keepTopK: t.spec.keepTopK, bytesPerVector: t.recordBytes, compressionRatio: t.compressionRatio, sha256: t.sha256 })),
    exact: { file: 'corpus.fp32.bin', d: D, n: chunks.length, bytesPerVector: D * 4, sha256: fp32Sha },
    quantizer: { kind: 'TurboQuant', reference: 'arxiv:2504.19874', stage_1: 'PolarQuant', stage_2: 'QJL', seed_tag_format: 'tq-seed-{seed}-d{d}-b{b}' },
  };
  await writeFile(resolve(OUT_DIR, 'corpus.cascade.json'), JSON.stringify(manifest, null, 2) + '\n');
  // chunks.json: Index→Chunk-Mapping (Text + Metadaten) für den Dienst.
  await writeFile(resolve(OUT_DIR, 'chunks.json'), JSON.stringify(chunks.map((c) => ({ id: c.id, text: c.text, source: c.source, doc_type: c.doc_type, legal_area: c.legal_area, year: c.year, parent: c.parent }))));
  console.error(`  corpus.cascade.json + chunks.json (${chunks.length} Chunks)`);

  // 4. Recall-Check (Cascade vs fp32-Truth)
  console.error(`\n[4/4] Recall-Check …`);
  const { QuantumIndex } = await import('../src/lib/quantum-index.ts');
  const idx768 = QuantumIndex.fromBuffer(encodeTier(vectors, 768, 3, SEED).buffer);
  const probes = ['Sparer-Pauschbetrag Kapitalerträge', 'Werbungskosten Arbeitnehmer', 'Kirchensteuer Konfession'];
  const qvs = await embedQ(probes);
  const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  for (let qi = 0; qi < probes.length; qi++) {
    const truth = vectors.map((v, i) => ({ i, s: dot(v, qvs[qi]) })).sort((a, b) => b.s - a.s).slice(0, 10).map((r) => r.i);
    const got = idx768.topK(qvs[qi], 10).map((s) => s.idx);
    const hit = got.filter((i) => truth.includes(i)).length;
    console.error(`  "${probes[qi]}" recall@10=${hit}/10  top: ${chunks[got[0]]?.parent}#${chunks[got[0]]?.ci} (${chunks[got[0]]?.source})`);
  }
  console.error(`\n✓ fertig.`);
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
