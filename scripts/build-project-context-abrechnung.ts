#!/usr/bin/env tsx
/**
 * build-project-context-abrechnung — erste konkrete Instanz eines
 * project-context-Containers. Wrappt die "Abrechnung"-Domäne (BMF-Rechner-
 * Stage + Umfeld in src/verticals/elster-v3/ + Libs) in ein adressierbares
 * Atom-Corpus + Quantum-Cascade-Index.
 *
 * Anders als scripts/encode-gemma-quantum-container.ts (das auf den
 * eCode-strukturierten ELSTER-Katalog zugeschnitten ist), atomisiert
 * dieses Skript echte Code- und Doku-Dateien — eine Sample-Anwendung
 * der project-context-Workflow-Stages.
 *
 * Schritte:
 *   1. Curated Abrechnung-Dateiliste abscannen
 *   2. In Atome splitten (Markdown ## /### Headings, TS top-level Symbole)
 *   3. atoms/code/<slug>.md mit Frontmatter schreiben
 *   4. atom-ids.json (idx → slug) emittieren
 *   5. Falls Ollama erreichbar:
 *        a. Embed-Vektoren via EmbeddingGemma berechnen
 *        b. fp32 + MRL×TurboQuant Tiers schreiben
 *        c. cascade.json Manifest
 *      Sonst: corpus-only manifest mit pending=true
 *   6. Summary nach stderr
 *
 * Output landet in runs/project-context/abrechnung/
 *
 * Run:
 *   tsx scripts/build-project-context-abrechnung.ts
 *
 * Optional:
 *   EMBED_CPU=1                     # für h200v vLLM-Koexistenz
 *   OLLAMA_URL=http://localhost:11434
 *   PCTX_OUT=runs/project-context/abrechnung
 */
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(REPO_ROOT, process.env.PCTX_OUT ?? 'runs/project-context/abrechnung');
const CONTAINER_ID = '0711:project:sturm:abrechnung:v1';
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

// Curated Abrechnung-Domäne. Aktive Pfade only — kein legacy/, keine Tests.
const CORPUS = [
  'docs/HANDOVER.md',
  'docs/ROADMAP.md',
  'src/lib/bmf-mcp-client.ts',
  'src/lib/canonical-layer.ts',
  'src/lib/elster-catalog.ts',
  'src/lib/elster-extract.ts',
  'src/lib/estg-citations.ts',
  'src/verticals/_vertical-contract.md',
  'src/verticals/elster-v3/data/CONTAINER_BRIEF.md',
  'src/verticals/elster-v3/index.ts',
  'src/verticals/elster-v3/stages/bmf-rechner-compute.ts',
  'src/verticals/elster-v3/stages/phase5-merge.ts',
  'src/verticals/elster-v3/stages/phase4-entity-disambig.ts',
  'src/verticals/elster-v3/stages/phase3-llm-fill.ts',
  'src/verticals/elster-v3/stages/llm-disambig.ts',
];

interface Atom {
  slug: string;
  path: string;
  symbol: string;
  kind: 'markdown-section' | 'ts-symbol' | 'file';
  span: { start: number; end: number };
  body: string;
  title: string;
}

function slugify(s: string): string {
  const safe = s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const hash = createHash('sha1').update(s).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}

function splitMarkdown(rel: string, text: string): Atom[] {
  const lines = text.split('\n');
  const atoms: Atom[] = [];
  let current: { symbol: string; buf: string[]; start: number } | null = null;
  let offset = 0;
  for (const line of lines) {
    const heading = /^#{2,3}\s+(.+)$/.exec(line);
    if (heading) {
      if (current) {
        atoms.push(mkAtom(rel, current.symbol, 'markdown-section', current.start, offset, current.buf.join('\n'), rel));
      }
      current = { symbol: heading[1].trim(), buf: [line], start: offset };
    } else if (current) {
      current.buf.push(line);
    }
    offset += line.length + 1;
  }
  if (current) {
    atoms.push(mkAtom(rel, current.symbol, 'markdown-section', current.start, offset, current.buf.join('\n'), rel));
  }
  if (atoms.length === 0) {
    atoms.push(mkAtom(rel, '__file__', 'file', 0, text.length, text, rel));
  }
  return atoms;
}

function splitTypescript(rel: string, text: string): Atom[] {
  const re = /^(export\s+(?:async\s+)?(?:function|class|interface|type|const|enum)\s+(\w+)|(?:async\s+)?function\s+(\w+)|class\s+(\w+))/gm;
  const matches = Array.from(text.matchAll(re));
  if (matches.length === 0) {
    return [mkAtom(rel, '__file__', 'file', 0, text.length, text, rel)];
  }
  const atoms: Atom[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const next = matches[i + 1];
    const start = m.index ?? 0;
    const end = next?.index ?? text.length;
    const symbol = m[2] ?? m[3] ?? m[4] ?? `anon-${i}`;
    atoms.push(mkAtom(rel, symbol, 'ts-symbol', start, end, text.slice(start, end), rel));
  }
  return atoms;
}

function mkAtom(
  path: string, symbol: string, kind: Atom['kind'],
  start: number, end: number, body: string, title: string,
): Atom {
  return { slug: slugify(`${path}#${symbol}`), path, symbol, kind, span: { start, end }, body, title };
}

function splitFile(rel: string, text: string): Atom[] {
  if (rel.endsWith('.md')) return splitMarkdown(rel, text);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) return splitTypescript(rel, text);
  return [mkAtom(rel, '__file__', 'file', 0, text.length, text, rel)];
}

async function ollamaReachable(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ac.signal });
    clearTimeout(tid);
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.error(`=== Building project-context container: ${CONTAINER_ID} ===`);
  console.error(`  output dir:   ${relative(REPO_ROOT, OUT_DIR)}`);
  console.error(`  corpus files: ${CORPUS.length}`);

  const atomsDir = join(OUT_DIR, 'atoms', 'code');
  const indexDir = join(OUT_DIR, 'index');
  await rm(atomsDir, { recursive: true, force: true });
  await mkdir(atomsDir, { recursive: true });
  await mkdir(indexDir, { recursive: true });

  // ── 1. Atomize ───────────────────────────────────────────────────────
  console.error(`\n[1/4] Atomizing corpus …`);
  const atoms: Atom[] = [];
  const seen = new Set<string>();
  for (const rel of CORPUS) {
    const abs = resolve(REPO_ROOT, rel);
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        console.error(`  skip non-file: ${rel}`);
        continue;
      }
    } catch {
      console.error(`  skip missing:  ${rel}`);
      continue;
    }
    const text = await readFile(abs, 'utf8');
    const fileAtoms = splitFile(rel, text);
    for (const a of fileAtoms) {
      if (seen.has(a.slug)) {
        // Slug collision — extremely rare given the sha suffix; rename.
        a.slug = `${a.slug}-${atoms.length}`;
      }
      seen.add(a.slug);
      const fm = [
        '---',
        `path: ${a.path}`,
        `kind: ${a.kind}`,
        `symbol: ${a.symbol}`,
        `span: ${a.span.start}-${a.span.end}`,
        `container: ${CONTAINER_ID}`,
        '---',
        '',
        a.body,
      ].join('\n');
      await writeFile(join(atomsDir, `${a.slug}.md`), fm);
      atoms.push(a);
    }
    console.error(`  ${rel.padEnd(60)} → ${fileAtoms.length} atoms`);
  }
  console.error(`  total atoms: ${atoms.length}`);

  // ── 2. Idx → slug map ────────────────────────────────────────────────
  const atomIds = atoms.map((a) => a.slug);
  await writeFile(join(indexDir, 'atom-ids.json'), JSON.stringify(atomIds, null, 2));

  // ── 3. Corpus summary ────────────────────────────────────────────────
  const corpus = {
    container_id: CONTAINER_ID,
    built_at: new Date().toISOString(),
    repo: 'sturm.0711.io',
    corpus_files: CORPUS,
    atoms_count: atoms.length,
    atom_kinds: countBy(atoms, (a) => a.kind),
    file_breakdown: countBy(atoms, (a) => a.path),
  };
  await writeFile(join(OUT_DIR, 'corpus.json'), JSON.stringify(corpus, null, 2));

  // ── 4. Embed + encode (if Ollama reachable) ─────────────────────────
  console.error(`\n[2/4] Checking Ollama at ${OLLAMA_URL} …`);
  const canEmbed = await ollamaReachable();
  if (!canEmbed) {
    console.error(`  Ollama unreachable — writing pending manifest.`);
    const pending = {
      containerId: CONTAINER_ID,
      status: 'pending-embeddings',
      atoms_count: atoms.length,
      note: 'Run again with OLLAMA_URL pointing at a reachable embeddinggemma instance.',
      built_at: new Date().toISOString(),
    };
    await writeFile(join(indexDir, 'cascade.json'), JSON.stringify(pending, null, 2));
    summary(corpus, false);
    return;
  }

  // Lazy-import the encoder helpers — only when needed.
  console.error(`  Ollama reachable. Embedding ${atoms.length} atoms via EmbeddingGemma …`);
  const { embedDocuments, mrlTruncate } = await import('../src/lib/gemma-embed.ts');
  const { TurboQuantizer } = await import('../src/lib/qjl/index.ts');

  const texts = atoms.map((a) => atomEmbedText(a));
  const titles = atoms.map((a) => a.title);
  const t0 = Date.now();
  const BATCH = Number(process.env.GEMMA_EMBED_BATCH ?? 16);
  const [probe] = await embedDocuments([texts[0]], [titles[0]]);
  const D = probe.length;
  const vectors: Float32Array[] = new Array(atoms.length);
  vectors[0] = probe;
  for (let i = 1; i < atoms.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const tslice = titles.slice(i, i + BATCH);
    const batch = await embedDocuments(slice, tslice);
    for (let k = 0; k < batch.length; k++) vectors[i + k] = batch[k];
    if (((i / BATCH) | 0) % 5 === 0) {
      console.error(`  embedded ${Math.min(i + BATCH, atoms.length)}/${atoms.length}`);
    }
  }
  console.error(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s, native dim ${D}`);

  console.error(`\n[3/4] Writing fp32 + TurboQuant tiers …`);
  const fp32Buf = Buffer.alloc(atoms.length * D * 4);
  for (let i = 0; i < atoms.length; i++) {
    for (let j = 0; j < D; j++) fp32Buf.writeFloatLE(vectors[i][j], (i * D + j) * 4);
  }
  await writeFile(join(indexDir, 'embeddings.fp32.bin'), fp32Buf);
  const fp32Sha = createHash('sha256').update(fp32Buf).digest('hex');

  const tiers = [
    { d: 256, b: 3, keepTopK: Math.min(200, atoms.length), file: 'embeddings.tq-d256-b3.bin' },
    { d: 768, b: 3, keepTopK: Math.min(50, atoms.length),  file: 'embeddings.tq-d768-b3.bin' },
  ];
  const tierInfo: Array<{ spec: typeof tiers[number]; sha256: string; bytes: number; recordBytes: number }> = [];
  for (const t of tiers) {
    const vecs = t.d === D ? vectors : vectors.map((v) => mrlTruncate(new Float32Array(v), t.d));
    const blob = encodeTier(vecs, t.d, t.b, 42, TurboQuantizer);
    await writeFile(join(indexDir, t.file), blob);
    tierInfo.push({
      spec: t,
      sha256: createHash('sha256').update(blob).digest('hex'),
      bytes: blob.byteLength,
      recordBytes: (t.d * t.b) / 8 + t.d / 8 + 8,
    });
    console.error(`  ${t.file.padEnd(34)} d=${t.d} b=${t.b}  ${blob.byteLength} B`);
  }

  const manifest = {
    containerId: CONTAINER_ID,
    nativeDim: D,
    embedder: {
      provider: 'ollama',
      model: process.env.EMBED_MODEL ?? 'embeddinggemma',
      base_url: OLLAMA_URL,
      family: 'google/embeddinggemma-300m',
      matryoshka: [768, 512, 256, 128],
      document_prompt: 'title: {title} | text: {content}',
      query_prompt: 'task: search result | query: {content}',
    },
    seed: 42,
    tiers: tierInfo.map((t) => ({
      file: t.spec.file,
      d: t.spec.d,
      b: t.spec.b,
      n: atoms.length,
      keepTopK: t.spec.keepTopK,
      bytesPerVector: t.recordBytes,
      sha256: t.sha256,
    })),
    exact: { file: 'embeddings.fp32.bin', d: D, n: atoms.length, sha256: fp32Sha },
  };
  await writeFile(join(indexDir, 'cascade.json'), JSON.stringify(manifest, null, 2));

  console.error(`\n[4/4] Done.`);
  summary(corpus, true);
}

function atomEmbedText(a: Atom): string {
  // Pack symbol + a leading body fragment. We keep ~600 chars of body to
  // stay under EmbeddingGemma's typical input window comfortably while
  // capturing enough signal for retrieval.
  const head = a.body.slice(0, 600).replace(/\s+/g, ' ').trim();
  return `${a.symbol} — ${head}`;
}

function countBy<T>(arr: T[], k: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) {
    const key = k(x);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function summary(corpus: any, embedded: boolean): void {
  console.error(`\n──────────────────────────────────────────────────────`);
  console.error(`Container: ${corpus.container_id}`);
  console.error(`Atoms:     ${corpus.atoms_count}`);
  console.error(`Kinds:     ${Object.entries(corpus.atom_kinds).map(([k,v]) => `${k}=${v}`).join('  ')}`);
  console.error(`Output:    ${relative(REPO_ROOT, OUT_DIR)}/`);
  console.error(`Status:    ${embedded ? 'INDEXED — retrieval ready' : 'CORPUS-ONLY — re-run with Ollama reachable'}`);
  console.error(`──────────────────────────────────────────────────────`);
}

// ── TurboQuant tier encoder, inlined to keep this script self-contained ──

function packIndicesBigEndian(indices: Uint8Array, b: number): Uint8Array {
  const totalBits = indices.length * b;
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  let bitPos = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] & ((1 << b) - 1);
    for (let bi = b - 1; bi >= 0; bi--) {
      const bit = (v >> bi) & 1;
      const bytePos = bitPos >> 3;
      const bitInByte = 7 - (bitPos & 7);
      out[bytePos] |= bit << bitInByte;
      bitPos++;
    }
  }
  return out;
}

// Generic over the TurboQuantizer constructor type — we import it lazily.
function encodeTier(
  vectors: Float32Array[], d: number, b: number, seed: number,
  TurboQuantizerCtor: new (d: number, b: number, seed: number) => {
    encode(x: Float32Array): {
      polar: { quantizedBits: Uint8Array; norm: number };
      qjlSigns: Uint8Array;
      residualNorm: number;
    };
  },
): Buffer {
  const turbo = new TurboQuantizerCtor(d, b, seed);
  const POLAR_BYTES = (d * b) / 8;
  const QJL_BYTES = d / 8;
  const REC = POLAR_BYTES + QJL_BYTES + 8;
  const SEED_TAG = `tq-seed-${seed}-d${d}-b${b}`;
  const seedSha = createHash('sha256').update(SEED_TAG, 'utf-8').digest();

  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x5451454d, 0);   // "TQEM"
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(d, 6);
  header.writeUInt8(b, 8);
  header.writeUInt32LE(vectors.length, 9);
  header.writeUInt32LE(seed, 13);
  seedSha.subarray(0, 15).copy(header, 17);

  const body = Buffer.alloc(vectors.length * REC);
  let off = 0;
  for (let i = 0; i < vectors.length; i++) {
    const x = vectors[i];
    let norm2 = 0;
    for (let j = 0; j < d; j++) norm2 += x[j] * x[j];
    if (norm2 === 0) {
      off += REC;
      continue;
    }
    const enc = turbo.encode(x);
    const packed = packIndicesBigEndian(enc.polar.quantizedBits, b);
    body.set(packed, off); off += POLAR_BYTES;
    body.set(enc.qjlSigns, off); off += QJL_BYTES;
    body.writeFloatLE(enc.polar.norm, off); off += 4;
    body.writeFloatLE(enc.residualNorm, off); off += 4;
  }
  return Buffer.concat([header, body]);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
