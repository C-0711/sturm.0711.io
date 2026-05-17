/**
 * ctx-shared — gemeinsame Bausteine für project-context-Container.
 *
 * Wiederverwendet die Embed + MRL×TurboQuant Encoding-Logik aus
 * scripts/build-project-context-abrechnung.ts, damit der `ctx`-CLI und
 * andere Builder denselben Wire-Format-Output erzeugen.
 *
 * Wichtig: kein gitchain/PG-Dependency hier — diese Helpers arbeiten
 * direkt auf lokalen Run-Verzeichnissen. Promotion zu echten gitchain-
 * Containern ist Sache von GitChainClient.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { embedDocuments, embedQueries, mrlTruncate, l2normalize } from './gemma-embed.ts';
import { TurboQuantizer } from './qjl/index.ts';
import { QuantumCascade, type CascadeManifest } from './quantum-index.ts';

const SEED = 42;
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export interface Atom {
  /** Stable identifier — used as the file name in atoms/code/<slug>.md. */
  slug: string;
  /** Free-form source path or origin tag (e.g. 'turn:3', 'src/foo.ts'). */
  path: string;
  /** Symbol or section label within the source. */
  symbol: string;
  /** Atom kind — drives how the body is interpreted/displayed. */
  kind: string;
  /** Byte span in the source, when meaningful. */
  span?: { start: number; end: number };
  /** Raw text body. */
  body: string;
  /** Title for the document-side embedding prompt. */
  title: string;
  /** Optional extra frontmatter — written verbatim into the atom file. */
  frontmatter?: Record<string, string>;
}

export interface BuildIndexOptions {
  containerId: string;
  outDir: string;          // absolute path; atoms/code/ + index/ created under it
  atoms: Atom[];
  ollamaUrl?: string;
  embedCpu?: boolean;
  batchSize?: number;
  /** Override the embed text for an atom — defaults to "${symbol} — ${body[:600]}". */
  atomText?: (a: Atom) => string;
}

export interface BuildIndexResult {
  containerId: string;
  atomCount: number;
  nativeDim: number;
  manifestPath: string;
  embedMs: number;
  encodeMs: number;
}

export async function ollamaReachable(url = DEFAULT_OLLAMA_URL): Promise<boolean> {
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`${url}/api/tags`, { signal: ac.signal });
    clearTimeout(tid);
    return res.ok;
  } catch {
    return false;
  }
}

export function slugify(s: string, maxLen = 80): string {
  const safe = s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, maxLen);
  const hash = createHash('sha1').update(s).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}

/** Write atom files + atom-ids.json. Idempotent over the same input. */
export async function writeAtoms(outDir: string, atoms: Atom[], containerId: string): Promise<string> {
  const atomsDir = join(outDir, 'atoms', 'code');
  await mkdir(atomsDir, { recursive: true });
  for (const a of atoms) {
    const fm: Record<string, string> = {
      path: a.path,
      kind: a.kind,
      symbol: a.symbol,
      container: containerId,
      ...(a.frontmatter ?? {}),
    };
    if (a.span) fm.span = `${a.span.start}-${a.span.end}`;
    const front = ['---', ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), '---', '', a.body].join('\n');
    await writeFile(join(atomsDir, `${a.slug}.md`), front);
  }
  const indexDir = join(outDir, 'index');
  await mkdir(indexDir, { recursive: true });
  await writeFile(join(indexDir, 'atom-ids.json'), JSON.stringify(atoms.map((a) => a.slug), null, 2));
  return atomsDir;
}

/**
 * Embed all atoms via EmbeddingGemma, write fp32 + 2 TQ tiers + cascade
 * manifest under `${outDir}/index/`. Caller must already have written
 * the atom files via writeAtoms() (this only produces the index).
 */
export async function buildIndex(opts: BuildIndexOptions): Promise<BuildIndexResult> {
  const indexDir = join(opts.outDir, 'index');
  await mkdir(indexDir, { recursive: true });
  const batch = opts.batchSize ?? 16;
  const atomTextFn = opts.atomText ?? defaultAtomText;

  const texts = opts.atoms.map(atomTextFn);
  const titles = opts.atoms.map((a) => a.title);

  const tEmb0 = Date.now();
  const [probe] = await embedDocuments([texts[0]], [titles[0]], {
    url: opts.ollamaUrl,
    cpuOnly: opts.embedCpu,
  });
  const D = probe.length;
  const vectors: Float32Array[] = new Array(opts.atoms.length);
  vectors[0] = probe;
  for (let i = 1; i < opts.atoms.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const tslice = titles.slice(i, i + batch);
    const out = await embedDocuments(slice, tslice, { url: opts.ollamaUrl, cpuOnly: opts.embedCpu });
    for (let k = 0; k < out.length; k++) vectors[i + k] = out[k];
  }
  const embedMs = Date.now() - tEmb0;

  const tEnc0 = Date.now();
  const fp32Buf = Buffer.alloc(opts.atoms.length * D * 4);
  for (let i = 0; i < opts.atoms.length; i++) {
    for (let j = 0; j < D; j++) fp32Buf.writeFloatLE(vectors[i][j], (i * D + j) * 4);
  }
  await writeFile(join(indexDir, 'embeddings.fp32.bin'), fp32Buf);
  const fp32Sha = createHash('sha256').update(fp32Buf).digest('hex');

  const tiers = [
    { d: 256, b: 3, keepTopK: Math.min(200, opts.atoms.length), file: 'embeddings.tq-d256-b3.bin' },
    { d: 768, b: 3, keepTopK: Math.min(50, opts.atoms.length),  file: 'embeddings.tq-d768-b3.bin' },
  ];
  const tierInfo: Array<{ spec: typeof tiers[number]; sha256: string; bytes: number; recordBytes: number }> = [];
  for (const t of tiers) {
    if (t.d > D) continue; // skip tiers exceeding native dim
    const vecs = t.d === D ? vectors : vectors.map((v) => mrlTruncate(new Float32Array(v), t.d));
    const blob = encodeTier(vecs, t.d, t.b, SEED);
    await writeFile(join(indexDir, t.file), blob);
    tierInfo.push({
      spec: t,
      sha256: createHash('sha256').update(blob).digest('hex'),
      bytes: blob.byteLength,
      recordBytes: (t.d * t.b) / 8 + t.d / 8 + 8,
    });
  }
  const encodeMs = Date.now() - tEnc0;

  const manifest: CascadeManifest & {
    containerId: string;
    embedder: Record<string, unknown>;
    seed: number;
  } = {
    containerId: opts.containerId,
    nativeDim: D,
    embedder: {
      provider: 'ollama',
      model: process.env.EMBED_MODEL ?? 'embeddinggemma',
      base_url: opts.ollamaUrl ?? DEFAULT_OLLAMA_URL,
      family: 'google/embeddinggemma-300m',
      document_prompt: 'title: {title} | text: {content}',
      query_prompt: 'task: search result | query: {content}',
    },
    seed: SEED,
    tiers: tierInfo.map((t) => ({
      file: t.spec.file,
      d: t.spec.d,
      b: t.spec.b,
      n: opts.atoms.length,
      keepTopK: t.spec.keepTopK,
      bytesPerVector: t.recordBytes,
    })),
    exact: { file: 'embeddings.fp32.bin', d: D, n: opts.atoms.length },
  };
  const manifestPath = join(indexDir, 'cascade.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    containerId: opts.containerId,
    atomCount: opts.atoms.length,
    nativeDim: D,
    manifestPath,
    embedMs,
    encodeMs,
  };
}

/**
 * Run a top-K retrieval against a built container directory.
 * Returns hits with body previews already resolved from atom files.
 */
export async function retrieveFromContainer(
  outDir: string,
  query: string,
  k: number,
  opts: { ollamaUrl?: string; embedCpu?: boolean } = {},
): Promise<Array<{ slug: string; score: number; preview: string; path?: string; symbol?: string }>> {
  const indexDir = join(outDir, 'index');
  const manifest = JSON.parse(await readFile(join(indexDir, 'cascade.json'), 'utf8')) as CascadeManifest;
  const cascade = await QuantumCascade.loadFromManifest(indexDir, manifest, k);
  const atomIds = JSON.parse(await readFile(join(indexDir, 'atom-ids.json'), 'utf8')) as string[];

  const [rawVec] = await embedQueries([query], { url: opts.ollamaUrl, cpuOnly: opts.embedCpu });
  const q = l2normalize(Float32Array.from(rawVec));
  const hits = cascade.topK(q, k);

  const out: Array<{ slug: string; score: number; preview: string; path?: string; symbol?: string }> = [];
  for (const hit of hits) {
    const slug = atomIds[hit.idx] ?? `idx-${hit.idx}`;
    const atomPath = join(outDir, 'atoms', 'code', `${slug}.md`);
    const text = await readFile(atomPath, 'utf8').catch(() => '');
    const fmMatch = /^---\n([\s\S]*?)\n---\n\n?/.exec(text);
    const meta: Record<string, string> = {};
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const idx = line.indexOf(': ');
        if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 2);
      }
    }
    const body = text.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
    out.push({
      slug,
      score: hit.score,
      preview: body.slice(0, 240).replace(/\n/g, ' '),
      path: meta.path,
      symbol: meta.symbol,
    });
  }
  return out;
}

function defaultAtomText(a: Atom): string {
  const head = a.body.slice(0, 600).replace(/\s+/g, ' ').trim();
  return `${a.symbol} — ${head}`;
}

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

function encodeTier(vectors: Float32Array[], d: number, b: number, seed: number): Buffer {
  const turbo = new TurboQuantizer(d, b, seed);
  const POLAR_BYTES = (d * b) / 8;
  const QJL_BYTES = d / 8;
  const REC = POLAR_BYTES + QJL_BYTES + 8;
  const seedSha = createHash('sha256').update(`tq-seed-${seed}-d${d}-b${b}`).digest();

  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x5451454d, 0);
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
