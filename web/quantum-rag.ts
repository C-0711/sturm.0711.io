#!/usr/bin/env -S npx tsx
/**
 * quantum-rag — eigenständiger Turbo-Quantum-RAG-Dienst (on-prem).
 *
 * EINE semantische Retrieval-Substanz für mehrere Konsumenten (Chat, Auditor,
 * Resolver, …): lädt N TurboQuant-Cascades NACH NAMESPACE und liefert top-k
 * Chunks über `POST /retrieve`. Query wird mit embeddinggemma (on-prem, :11434)
 * eingebettet → Cascade-Suche (256d→768d→fp32-Rerank) → Index→Chunk-Mapping.
 *
 * Reuse: src/core/tools/resolvers/rag-index.ts (Cascade-Reader) +
 *        src/lib/gemma-embed.ts (Query-Embedding). Kein pgvector, kein Cloud-
 *        Embedder, kein DB-Hop.
 *
 *   QRAG_PORT=12013 npx tsx web/quantum-rag.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { resolveRagIndex, type RagIndexHandle } from '../src/core/tools/resolvers/rag-index.ts';
import { embedQueries } from '../src/lib/gemma-embed.ts';
import type { RagIndexToolRef } from '../src/core/tools/types.ts';

const PORT = Number(process.env.QRAG_PORT ?? 12013);
const CPU_ONLY = process.env.QRAG_EMBED_CPU !== '0';

interface NamespaceDef {
  ref: RagIndexToolRef;
  atomsPath: string;
  map: (atom: Record<string, any>, score: number, idx: number) => Record<string, unknown>;
}

/** Katalog-Cascade (existiert bereits, vom Resolver gebaut). */
const catalogRef = {
  name: 'qrag-catalog', kind: 'rag-index', required: true, alwaysOn: true, roles: ['retrieve'],
  config: {
    containerId: '0711:elster:gemma4-tq:embeddings:v1',
    manifest: 'src/verticals/elster-v3/data/embeddings.gemma4.cascade.json',
    strategy: 'turboquant-cascade',
    tiers: ['d128', 'd256', 'd768', 'fp32'],
    topK: { d128: 512, d256: 128, d768: 32, fp32: 8 },
  },
} as unknown as RagIndexToolRef;

const NAMESPACES: Record<string, NamespaceDef> = {
  catalog: {
    ref: catalogRef,
    atomsPath: 'src/verticals/elster-v3/data/atoms.json',
    map: (a, score) => ({
      id: a.atom_id, score, text: a.value ?? a.metadata?.drucktext ?? '',
      source: a.citation_document ?? null,
      meta: { field: a.field_name, anlage: a.metadata?.anlage, vordruckzeile: a.metadata?.vordruckzeile, drucktext: a.metadata?.drucktext, trust: a.trust_level },
    }),
  },
  // corpus: { ref: corpusRef, atomsPath: 'var/quantum/corpus/chunks.json', map: (c, score) => ({ id:c.id, score, text:c.text, source:c.source, meta:{page:c.page} }) },
};

const handleCache = new Map<string, Promise<RagIndexHandle>>();
const atomsCache = new Map<string, Record<string, any>[]>();

function loadAtoms(ns: string): Record<string, any>[] {
  if (atomsCache.has(ns)) return atomsCache.get(ns)!;
  const p = pathResolve(process.cwd(), NAMESPACES[ns].atomsPath);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const atoms: Record<string, any>[] = Array.isArray(raw) ? raw : (raw.atoms ?? []);
  atomsCache.set(ns, atoms);
  return atoms;
}
function getHandle(ns: string): Promise<RagIndexHandle> {
  if (!handleCache.has(ns)) handleCache.set(ns, resolveRagIndex(NAMESPACES[ns].ref));
  return handleCache.get(ns)!;
}

async function retrieve(query: string, k: number, ns: string): Promise<unknown[]> {
  const def = NAMESPACES[ns];
  if (!def) throw new Error(`unbekannter Namespace: ${ns}`);
  const atoms = loadAtoms(ns);
  const handle = await getHandle(ns);
  const [qv] = await embedQueries([query], { cpuOnly: CPU_ONLY });
  const hits = await handle.retrieve(Array.from(qv), { topK: k });
  return hits.map((h) => {
    const idx = Number(h.id);
    const atom = atoms[idx] ?? {};
    return def.map(atom, h.score, idx);
  });
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => { const c: Buffer[] = []; req.on('data', (b) => c.push(b as Buffer)); req.on('end', () => res(Buffer.concat(c).toString('utf8'))); req.on('error', rej); });
}
function json(res: ServerResponse, code: number, obj: unknown) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, service: 'quantum-rag', namespaces: Object.keys(NAMESPACES), port: PORT });
    if (req.method === 'GET' && url === '/namespaces') {
      const out: Record<string, unknown> = {};
      for (const [ns, d] of Object.entries(NAMESPACES)) out[ns] = { containerId: d.ref.config.containerId, manifest: d.ref.config.manifest, ready: existsSync(pathResolve(process.cwd(), d.ref.config.manifest)) };
      return json(res, 200, out);
    }
    if (req.method === 'POST' && url === '/retrieve') {
      const { query, k, namespace } = JSON.parse(await body(req) || '{}');
      if (typeof query !== 'string' || !query.trim()) return json(res, 400, { error: 'query fehlt' });
      const ns = String(namespace ?? 'catalog');
      const t0 = Date.now();
      const hits = await retrieve(query, Math.min(Math.max(Number(k) || 8, 1), 50), ns);
      return json(res, 200, { ok: true, namespace: ns, ms: Date.now() - t0, hits });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('QRAG', (e as Error).stack);
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`quantum-rag :${PORT} — namespaces: ${Object.keys(NAMESPACES).join(', ')}`));
