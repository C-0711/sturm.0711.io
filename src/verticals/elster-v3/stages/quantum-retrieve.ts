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
import { defineStage } from '../../../core/stage.ts';
import {
  embedQueries,
  type GemmaEmbedOptions,
} from '../../../lib/gemma-embed.ts';
import { type CatalogAtom } from '../../../lib/elster-catalog.ts';
import type { CatalogHandle, RagIndexHandle } from '../../../core/tools/handles.ts';

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
    // dataDir/manifestFile/atomsFile config-Felder bleiben für Rückwärtskompat
    // im Schema, werden aber seit P10 nicht mehr gelesen — Anwendung-Tools
    // `elster-rag` und `elster-catalog` liefern Index + Atome.
    const topK = cfg.topK ?? 10;
    const embedOpts: GemmaEmbedOptions = { ...(cfg.embed ?? {}), signal: ctx.signal };

    const queries =
      input.queries && input.queries.length > 0
        ? input.queries
        : [input.query];
    if (queries.some((q) => typeof q !== 'string' || q.length === 0)) {
      throw new Error('quantum-retrieve: all queries must be non-empty strings');
    }

    // P10: elster-rag + elster-catalog are required:true in the steuerfall-est
    // roster. NullToolContainer throws cleanly if the workflow runs standalone.
    const rag = ctx.tools.get<RagIndexHandle>('elster-rag');
    const cat = ctx.tools.get<CatalogHandle>('elster-catalog');

    const atoms: CatalogAtom[] = cat.get<CatalogAtom[]>('atoms');

    ctx.emit('cascade_load_done', {
      atoms: atoms.length,
      cascade: `rag-tool(${rag.meta?.containerId ?? 'unknown'})`,
    });

    const tEmb = Date.now();
    const queryVecs = await embedQueries(queries, embedOpts);
    const embedMs = Date.now() - tEmb;
    ctx.emit('queries_embedded', { count: queryVecs.length, ms: embedMs });

    const tRet = Date.now();
    const hits = await Promise.all(queryVecs.map(async (qv, i) => {
      const ragHits = await rag.retrieve(Array.from(qv), { topK, signal: ctx.signal });
      const scored: Array<{ idx: number; score: number }> = ragHits.map((h) => ({ idx: Number(h.id), score: h.score }));
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
        cascadeDescription: `rag-tool(${rag.meta?.containerId ?? 'unknown'})`,
        embedMs,
        retrieveMs,
      },
    };
  },
});
