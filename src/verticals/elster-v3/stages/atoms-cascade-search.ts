/**
 * elster-v3/atoms-cascade-search — pro Label/Wert-Chunk: cascade-retrieval gegen
 * 2287 ELSTER-Atome aus dem Container.
 *
 * Hot-Path-Stage des Light-Workflows:
 *   pdftotext → label-value-parser → atoms-cascade-search → format-regex-validate
 *                                    ^^^^^^^^^^^^^^^^^^^^
 *   Embed-Label ◦ Cascade (d=256 → d=768 → fp32) → Top-K eCode-Kandidaten
 *
 * Input:  belege[]  (von label-value-parser)
 * Output: belege[]  mit `chunks[*].candidates: AtomCandidate[]` annotiert
 *
 * Performance-Budget pro Beleg-Bundle (5 Belege × ~10 Chunks = ~50 Chunks):
 *   • embedQueries:   ~500ms (CPU, parallel)
 *   • cascade.topK:   ~0.5ms × 50 = ~25ms
 *   • Total:          ~600ms wall-time
 *
 * Reuse:
 *   • Cascade-Loading + Atom-Catalog: gecached über CASCADE_CACHE,
 *     identisch zu retrieval-verify.ts und quantum-ground.ts.
 *   • embedQueries aus gemma-embed.ts (EmbeddingGemma + task-Prefix).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineStage } from '../../../core/stage.ts';
import { embedQueries, type GemmaEmbedOptions } from '../../../lib/gemma-embed.ts';
import {
  QuantumCascade,
  type CascadeManifest,
} from '../../../lib/quantum-index.ts';
import { loadCatalog, type CatalogAtom } from '../../../lib/elster-catalog.ts';
import type { CatalogHandle, RagIndexHandle } from '../../../core/tools/handles.ts';

import type { BelegBlock, LabelValueChunk } from './label-value-parser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(HERE, '../data');
const DEFAULT_MANIFEST = 'embeddings.gemma4.cascade.json';
const DEFAULT_ATOMS = 'atoms.json';

// ─── Cached cascade + atoms ───────────────────────────────────────────────

interface CascadeWithAtoms {
  cascade: QuantumCascade;
  atoms: CatalogAtom[];
}
const CASCADE_CACHE = new Map<string, Promise<CascadeWithAtoms>>();

async function loadCascadeAndAtoms(
  dataDir: string,
  manifestFile: string,
  atomsFile: string,
  finalK: number,
): Promise<CascadeWithAtoms> {
  const key = `${dataDir}::${manifestFile}::${finalK}`;
  let p = CASCADE_CACHE.get(key);
  if (p) return p;
  p = (async () => {
    const manifest: CascadeManifest = JSON.parse(
      await readFile(join(dataDir, manifestFile), 'utf-8'),
    );
    const cascade = await QuantumCascade.loadFromManifest(dataDir, manifest, finalK);
    const handle = await loadCatalog(join(dataDir, atomsFile));
    return { cascade, atoms: handle.atoms };
  })();
  CASCADE_CACHE.set(key, p);
  return p;
}

// ─── Stage I/O ────────────────────────────────────────────────────────────

export interface AtomCandidate {
  rank: number;
  ecode: string;
  score: number;
  drucktext: string;
  anlage: string;
  datentyp: string;
  pflicht: boolean;
  vordruckzeile: string;
  formatRegex: string;
  /** Optional Einkunftsart-Prefix (z.B. "ArbL") aus kontextPaths[0]. */
  einkunftsart?: string;
  /**
   * BMF-XML Originalzitat des Atoms (atom.citation_excerpt) — gibt dem LLM
   * zusätzlichen Kontext jenseits des kurzen drucktext. Beispiel:
   *   drucktext         = "Identifikationsnummer"
   *   citation_excerpt  = "Identifikationsnummer des/der Steuerpflichtigen"
   * Bei drucktext-Kollisionen (1319 Atome teilen Drucktexte) ist das oft
   * der einzige Diskriminator.
   */
  citation_excerpt?: string;
  /**
   * BMF-Kompakt-Typ — granularer als `datentyp`. 25 distinct values im Catalog:
   *   N=number  C=currency  X=string  D=date  %=percentage  G=Gewerbe  J=Ja/Nein
   *   U=Unterhalt  H/B/Y/F/A/P/M/I/R/K/Z/T/O/L/V usw. (BMF-spezifische Codes)
   * Hilft Currency-vs-PLZ-Disambig wo `datentyp` allein nicht reicht.
   */
  formatkennzeichen?: string;
}

export interface AnnotatedChunk extends LabelValueChunk {
  /** Top-K Atom-Kandidaten für diesen Label/Wert. Sortiert nach Score. */
  candidates: AtomCandidate[];
  /**
   * Trennsicherheit: Verhältnis Top-1 zu Top-2 Score.
   * Hohes Verhältnis (≥1.4) = klarer Sieger; niedrig (≤1.1) = mehrere
   * gleichwahrscheinliche Atome → Disambig-Bedarf.
   */
  separation?: number;
}

export interface AnnotatedBeleg extends Omit<BelegBlock, 'chunks'> {
  chunks: AnnotatedChunk[];
}

export interface AtomsCascadeSearchInput {
  belege: BelegBlock[];
  /** Optional: Anlagen-Whitelist (aus klassifizierung) — Kandidaten werden danach gefiltert. */
  anlagen?: string[];
}

export interface AtomsCascadeSearchConfig {
  /** Wie viele Atom-Kandidaten pro Chunk zurückgeben. Default 5. */
  topK?: number;
  /** Cascade-Manifest-Datei (relativ zu data/). */
  manifestFile?: string;
  /** Atoms-Datei (relativ zu data/). */
  atomsFile?: string;
  /** Wenn `anlagen` mitgegeben wird: Kandidaten auf diese Anlagen einschränken? Default true. */
  scopeToAnlagen?: boolean;
  /** Embed-Optionen (cpu-only forcen wenn GPU für vLLM reserviert ist). */
  embed?: GemmaEmbedOptions;
  /**
   * Query-String-Builder: nur Label, oder Label+Wert. Letzteres hilft bei
   * Mehrdeutigkeiten ("Identifikationsnummer" allein vs "Identifikationsnummer
   * 85236749007" → Atom-Match auf IDNr-Atome stärker).
   * Default 'label-only'.
   */
  queryStrategy?: 'label-only' | 'label-plus-value';
}

export interface AtomsCascadeSearchOutput {
  belege: AnnotatedBeleg[];
  /** Statistik für SSE / Audit. */
  stats: {
    chunksTotal: number;
    chunksWithCandidates: number;
    avgTopScore: number;
    avgSeparation: number;
    cascadeDescribe: string;
    embedMs: number;
    cascadeMs: number;
    totalMs: number;
  };
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────

function einkunftsartPrefix(atom: CatalogAtom): string | undefined {
  const paths = atom.metadata.kontextPaths;
  if (!paths || paths.length === 0) return undefined;
  const first = paths[0];
  return first.split('/')[0] || undefined;
}

function buildQuery(chunk: LabelValueChunk, strategy: 'label-only' | 'label-plus-value'): string {
  if (strategy === 'label-plus-value') return `${chunk.label}: ${chunk.value}`;
  return chunk.label;
}

// ─── Stage ────────────────────────────────────────────────────────────────

export const atomsCascadeSearchStage = defineStage<
  AtomsCascadeSearchInput,
  AtomsCascadeSearchOutput,
  AtomsCascadeSearchConfig
>({
  id: 'elster-v3/atoms-cascade-search',
  name: 'Atoms-Cascade-Search (EmbeddingGemma × TurboQuant)',
  description:
    'Pro Label/Wert-Chunk: query-embed via EmbeddingGemma → 3-stufige TurboQuant-Cascade ' +
    '(d=256 b=3 → d=768 b=3 → fp32 exakt) gegen 2287 ELSTER-Atome aus dem Container. ' +
    'Liefert Top-K eCode-Kandidaten mit voller Atom-Metadata (drucktext, anlage, formatRegex, ' +
    'pflicht). Optional auf eine Anlagen-Whitelist gescoped. Sub-millisekunden pro Query.',
  hints: {
    inputs:
      'belege[] (von label-value-parser) · optional: anlagen[] (Whitelist)',
    outputs:
      'belege[] mit annotierten chunks[].candidates[] + separation; stats für Audit',
    configExample:
      '{"topK": 5, "scopeToAnlagen": true, "queryStrategy": "label-only", "embed": {"cpuOnly": true}}',
    inputPorts: [
      { name: 'belege', type: 'belege', description: 'Klassifizierte Belege mit Chunks' },
      { name: 'anlagen', type: 'string[]', description: 'Optionale Anlagen-Whitelist' },
    ],
    outputPorts: [
      { name: 'belege', type: 'belege', description: 'Belege mit Kandidaten-Annotation' },
      { name: 'stats', type: 'json', description: 'Statistik für Audit/SSE' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    if (!input?.belege || input.belege.length === 0) {
      return {
        belege: [],
        stats: {
          chunksTotal: 0,
          chunksWithCandidates: 0,
          avgTopScore: 0,
          avgSeparation: 0,
          cascadeDescribe: '(no data)',
          embedMs: 0,
          cascadeMs: 0,
          totalMs: 0,
        },
      };
    }

    const topK = ctx.config?.topK ?? 5;
    const manifestFile = ctx.config?.manifestFile ?? DEFAULT_MANIFEST;
    const atomsFile = ctx.config?.atomsFile ?? DEFAULT_ATOMS;
    const scopeToAnlagen = ctx.config?.scopeToAnlagen ?? true;
    const queryStrategy = ctx.config?.queryStrategy ?? 'label-only';
    const anlagenWhitelist =
      scopeToAnlagen && input.anlagen && input.anlagen.length > 0
        ? new Set(input.anlagen)
        : null;

    // P7: bevorzuge ctx.tools.get('elster-rag') / 'elster-catalog' wenn die
    // Anwendung sie gebunden hat. Fallback auf modul-scope Cache.
    const rag = ctx.tools.has('elster-rag')
      ? ctx.tools.get<RagIndexHandle>('elster-rag')
      : null;
    const cat = ctx.tools.has('elster-catalog')
      ? ctx.tools.get<CatalogHandle>('elster-catalog')
      : null;
    // finalK = max(topK*4, 20) — der Cascade-Layer rerankt am Ende auf so
    // viele Kandidaten, dass anlagen-Whitelist-Filterung noch genug übrig lässt.
    const cascadeKLoad = Math.max(topK * 4, 20);
    const fallback = (!rag || !cat)
      ? await loadCascadeAndAtoms(DEFAULT_DATA_DIR, manifestFile, atomsFile, cascadeKLoad)
      : null;
    const atoms: CatalogAtom[] = cat ? cat.get<CatalogAtom[]>('atoms') : fallback!.atoms;
    const cascadeDescribe = fallback ? fallback.cascade.describe() : `rag-tool(${rag?.meta.containerId ?? 'unknown'})`;

    // Flatten alle Chunks über alle Belege, behalte Mapping zurück.
    type Loc = { belegIdx: number; chunkIdx: number };
    const queries: string[] = [];
    const locs: Loc[] = [];
    for (let bi = 0; bi < input.belege.length; bi++) {
      const b = input.belege[bi];
      for (let ci = 0; ci < b.chunks.length; ci++) {
        queries.push(buildQuery(b.chunks[ci], queryStrategy));
        locs.push({ belegIdx: bi, chunkIdx: ci });
      }
    }

    if (queries.length === 0) {
      return {
        belege: input.belege.map((b) => ({ ...b, chunks: [] })) as AnnotatedBeleg[],
        stats: {
          chunksTotal: 0,
          chunksWithCandidates: 0,
          avgTopScore: 0,
          avgSeparation: 0,
          cascadeDescribe,
          embedMs: 0,
          cascadeMs: 0,
          totalMs: Date.now() - t0,
        },
      };
    }

    // Batch-Embed.
    const tEmbedStart = Date.now();
    const vectors = await embedQueries(queries, ctx.config?.embed);
    const embedMs = Date.now() - tEmbedStart;

    if (vectors.length !== queries.length) {
      throw new Error(
        `atoms-cascade-search: embedQueries returned ${vectors.length} ≠ expected ${queries.length}`,
      );
    }

    // Cascade pro Query — innere Cosine-Loop ist sub-ms pro Query.
    const tCascadeStart = Date.now();
    const annotated: AnnotatedBeleg[] = input.belege.map((b) => ({
      ...b,
      chunks: b.chunks.map((c) => ({ ...c, candidates: [] }) as AnnotatedChunk),
    }));

    // Vorab größeres K aus der Cascade ziehen, damit wir nach Anlage-Filter
    // noch genug Kandidaten haben.
    const cascadeK = Math.max(topK * 4, 20);
    let scoreSum = 0;
    let separationSum = 0;
    let withCands = 0;

    for (let qi = 0; qi < queries.length; qi++) {
      const loc = locs[qi];
      let scored: Array<{ idx: number; score: number }>;
      if (rag) {
        const ragHits = await rag.retrieve(Array.from(vectors[qi]), { topK: cascadeK, signal: ctx.signal });
        scored = ragHits.map((h) => ({ idx: Number(h.id), score: h.score }));
      } else {
        scored = fallback!.cascade.topK(vectors[qi], cascadeK);
      }
      let cands = scored.map((s, i) => {
        const a = atoms[s.idx];
        const c: AtomCandidate = {
          rank: i,
          ecode: a.field_name,
          score: s.score,
          drucktext: a.metadata.drucktext,
          anlage: a.metadata.anlage,
          datentyp: a.metadata.datentyp,
          pflicht: a.metadata.pflicht,
          vordruckzeile: a.metadata.vordruckzeile,
          formatRegex: a.metadata.formatRegex,
          einkunftsart: einkunftsartPrefix(a),
          citation_excerpt: a.citation_excerpt,
          formatkennzeichen: a.metadata.formatkennzeichen,
        };
        return c;
      });
      if (anlagenWhitelist) {
        cands = cands.filter((c) => anlagenWhitelist.has(c.anlage));
      }
      cands = cands.slice(0, topK).map((c, i) => ({ ...c, rank: i }));

      annotated[loc.belegIdx].chunks[loc.chunkIdx].candidates = cands;
      if (cands.length >= 2) {
        const sep = cands[1].score !== 0 ? cands[0].score / cands[1].score : Infinity;
        annotated[loc.belegIdx].chunks[loc.chunkIdx].separation =
          Number.isFinite(sep) ? Number(sep.toFixed(3)) : undefined;
        separationSum += Number.isFinite(sep) ? sep : 1;
      }
      if (cands.length > 0) {
        scoreSum += cands[0].score;
        withCands++;
      }
    }
    const cascadeMs = Date.now() - tCascadeStart;
    const totalMs = Date.now() - t0;

    const stats = {
      chunksTotal: queries.length,
      chunksWithCandidates: withCands,
      avgTopScore: withCands > 0 ? Number((scoreSum / withCands).toFixed(4)) : 0,
      avgSeparation: withCands > 0 ? Number((separationSum / withCands).toFixed(3)) : 0,
      cascadeDescribe,
      embedMs,
      cascadeMs,
      totalMs,
    };

    ctx.emit('cascade_done', stats);
    return { belege: annotated, stats };
  },
});
