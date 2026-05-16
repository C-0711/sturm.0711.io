/**
 * elster-v3/quantum-retrieve — retrieval over the EmbeddingGemma+TurboQuant
 * cascade container `0711:elster:gemma4-tq:embeddings:v1`.
 *
 * Given a query string (typically OCR text or a Layer-1 nested-extract
 * field), this stage:
 *   1. Embeds the query via EmbeddingGemma with the **search-query** task
 *      prompt (`task: search result | query: …`), forced CPU per
 *      reference_h200v memory.
 *   2. Runs the MRL×TurboQuant cascade: coarse 256-d pre-filter →
 *      fine 768-d rerank → optional fp32 exact rerank.
 *   3. Returns top-K candidate atoms with eCode, anlage, drucktext, and
 *      a normalized similarity score.
 *
 * The stage is **side-effect-free** w.r.t. the workflow: it doesn't mutate
 * Layer-1's nested JSON. Downstream consumers can either:
 *   a) feed `candidates` as an extra input to Layer 2 (entity resolution
 *      uses them as a whitelist hint), or
 *   b) read them post-hoc for analytics/UI.
 *
 * Caching: the cascade is loaded once per process (module-scope). The
 * elster-v3 workflow runs many times against the same catalog, so amortizing
 * the 7 MB fp32 + 900 KB TQ load over runs is essential.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineStage } from '../../../core/stage.ts';
import {
  embedQueries,
  type GemmaEmbedOptions,
} from '../../../lib/gemma-embed.ts';
import {
  QuantumCascade,
  type CascadeManifest,
} from '../../../lib/quantum-index.ts';
import { loadCatalog, type CatalogAtom } from '../../../lib/elster-catalog.ts';
import type { CatalogHandle, RagIndexHandle } from '../../../core/tools/handles.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(HERE, '../data');
const DEFAULT_MANIFEST = 'embeddings.gemma4.cascade.json';
const DEFAULT_ATOMS = 'atoms.json';

interface CacheEntry {
  cascade: QuantumCascade;
  atoms: CatalogAtom[];
}

/** Module-scope cache keyed by `${dataDir}::${manifestFile}`. */
const CACHE = new Map<string, Promise<CacheEntry>>();

async function loadCascade(
  dataDir: string,
  manifestFile: string,
  atomsFile: string,
  finalK: number,
): Promise<CacheEntry> {
  const key = `${dataDir}::${manifestFile}`;
  let p = CACHE.get(key);
  if (p) return p;
  p = (async () => {
    const manifest: CascadeManifest = JSON.parse(
      await readFile(join(dataDir, manifestFile), 'utf-8'),
    );
    const cascade = await QuantumCascade.loadFromManifest(dataDir, manifest, finalK);
    const handle = await loadCatalog(join(dataDir, atomsFile));
    return { cascade, atoms: handle.atoms };
  })();
  CACHE.set(key, p);
  return p;
}

export interface QuantumRetrieveInput {
  /** The query string. Usually OCR text or a layer-1 field value. */
  query: string;
  /** Optional: multiple queries to batch. If both `query` and `queries` are
   *  supplied, `queries` is used. */
  queries?: string[];
}

export interface QuantumRetrieveConfig {
  /** Override the data directory (defaults to elster-v3/data). */
  dataDir?: string;
  /** Manifest filename inside dataDir. */
  manifestFile?: string;
  /** Atoms catalog filename inside dataDir. */
  atomsFile?: string;
  /** How many candidates to return per query. */
  topK?: number;
  /** Forward to gemma-embed (CPU mode, custom url, etc.). */
  embed?: Pick<GemmaEmbedOptions, 'url' | 'model' | 'cpuOnly'>;
}

export interface Kandidat {
  atom_id: string;
  field_name: string;
  anlage: string;
  datentyp: 'string' | 'date' | 'currency';
  pflicht: boolean;
  vordruckzeile: string;
  drucktext: string;
  bezeichnung: string;
  formatRegex: string;
  trustLevel: string;
  citationDocument: string;
  /** Unbiased Thm-2 inner-product estimate (= cosine since both unit-norm). */
  score: number;
}

export interface QuantumRetrieveOutput {
  /** Kandidaten pro Query, in der Reihenfolge der input.queries. */
  hits: Array<{ query: string; kandidaten: Kandidat[] }>;
  stats: {
    queries: number;
    catalogAtoms: number;
    cascadeDescription: string;
    embedMs: number;
    retrieveMs: number;
  };
}

export const quantumRetrieveStage = defineStage<
  QuantumRetrieveInput,
  QuantumRetrieveOutput,
  QuantumRetrieveConfig
>({
  id: 'elster-v3/quantum-retrieve',
  name: 'Quantum-retrieve (EmbeddingGemma + TurboQuant cascade)',
  description:
    'Retrieves the top-K candidate ELSTER eCodes for a query string from the gemma-quantum container via MRL×TurboQuant cascade (coarse 256-d → fine 768-d → fp32 rerank).',
  hints: {
    inputs:
      'query: string  (or queries: string[]). Free-form text — usually OCR or a Layer-1 field value.',
    outputs:
      'hits: [{ query, kandidaten: [{ atom_id, field_name, anlage, drucktext, bezeichnung, score }] }]',
    configExample: JSON.stringify(
      {
        topK: 10,
        embed: { cpuOnly: true },
      },
      null,
      2,
    ),
    acceptsContainers: ['embedding-index'],
    inputPorts: [
      { name: 'query', type: 'text', description: 'String or string[]' },
    ],
    outputPorts: [
      { name: 'kandidaten', type: 'candidates', description: 'Top-K per query' },
    ],
  },

  async run(input, ctx) {
    const cfg = ctx.config ?? {};
    const dataDir = cfg.dataDir ?? DEFAULT_DATA_DIR;
    const manifestFile = cfg.manifestFile ?? DEFAULT_MANIFEST;
    const atomsFile = cfg.atomsFile ?? DEFAULT_ATOMS;
    const topK = cfg.topK ?? 10;
    const embedOpts: GemmaEmbedOptions = { ...(cfg.embed ?? {}), signal: ctx.signal };

    const queries =
      input.queries && input.queries.length > 0
        ? input.queries
        : [input.query];
    if (queries.some((q) => typeof q !== 'string' || q.length === 0)) {
      throw new Error('quantum-retrieve: all queries must be non-empty strings');
    }

    // P7: bevorzuge ctx.tools.get('elster-rag') + 'elster-catalog' wenn die
    // Anwendung sie gebunden hat. Fallback auf modul-scope Cache wenn standalone
    // (Designer / Test / NullToolContainer).
    const rag = ctx.tools.has('elster-rag')
      ? ctx.tools.get<RagIndexHandle>('elster-rag')
      : null;
    const cat = ctx.tools.has('elster-catalog')
      ? ctx.tools.get<CatalogHandle>('elster-catalog')
      : null;

    ctx.emit('cascade_load_start', { dataDir, manifestFile });

    // Fallback-Cascade nur laden wenn ein Pfad das Modul-scope braucht
    // (kein RAG-Tool oder kein Catalog-Tool gebunden).
    const fallback = (!rag || !cat)
      ? await loadCascade(dataDir, manifestFile, atomsFile, topK)
      : null;
    // Atoms holen — entweder vom Catalog-Tool (bevorzugt) oder via Fallback.
    const atoms: CatalogAtom[] = cat
      ? cat.get<CatalogAtom[]>('atoms')
      : fallback!.atoms;
    const cascadeDescribe = fallback ? fallback.cascade.describe() : '';

    ctx.emit('cascade_load_done', {
      atoms: atoms.length,
      cascade: cascadeDescribe || 'rag-tool',
    });

    const tEmb = Date.now();
    const queryVecs = await embedQueries(queries, embedOpts);
    const embedMs = Date.now() - tEmb;
    ctx.emit('queries_embedded', { count: queryVecs.length, ms: embedMs });

    const tRet = Date.now();
    const hits = await Promise.all(queryVecs.map(async (qv, i) => {
      let scored: Array<{ idx: number; score: number }>;
      if (rag) {
        // P7-Pfad: RAG-Handle. Wir geben den vorberechneten Vektor weiter
        // (RagIndexHandle.retrieve akzeptiert number[]).
        const ragHits = await rag.retrieve(Array.from(qv), { topK, signal: ctx.signal });
        scored = ragHits.map((h) => ({ idx: Number(h.id), score: h.score }));
      } else {
        scored = fallback!.cascade.topK(qv, topK);
      }
      return {
        query: queries[i],
        kandidaten: scored.map<Kandidat>((s) => {
          const a = atoms[s.idx];
          return {
            atom_id: a.atom_id,
            field_name: a.field_name,
            anlage: a.metadata.anlage,
            datentyp: a.metadata.datentyp,
            pflicht: a.metadata.pflicht,
            vordruckzeile: a.metadata.vordruckzeile,
            drucktext: a.metadata.drucktext,
            bezeichnung: a.value,
            formatRegex: a.metadata.formatRegex,
            trustLevel: a.trust_level,
            citationDocument: a.citation_document,
            score: s.score,
          };
        }),
      };
    }));
    const retrieveMs = Date.now() - tRet;
    ctx.emit('quantum_retrieve_done', { queries: queries.length, retrieveMs });

    return {
      hits,
      stats: {
        queries: queries.length,
        catalogAtoms: atoms.length,
        cascadeDescription: cascadeDescribe || `rag-tool(${rag?.meta.containerId ?? 'unknown'})`,
        embedMs,
        retrieveMs,
      },
    };
  },
});
