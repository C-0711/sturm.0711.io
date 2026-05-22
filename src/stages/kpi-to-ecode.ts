/**
 * kpi-to-ecode-mapper — schnelle KPI→eCode-Zuordnung via EmbeddingGemma vLLM.
 *
 * Input:  Array von {key, value, belegtyp?} aus classifyDocument oder
 *         direkt aus Mistral-Small kpis.
 * Method: formatQuery(belegtyp: key) → EmbeddingGemma (vLLM :11436) → matmul
 *         gegen 2287 atoms → top-1 mit cos ≥ minScore (default 0.55).
 * Output: canonical-layer-Shape {<ecode>: {ecode, anlage, drucktext, values:[{value, …}]}}
 *
 * Latenz: ~80 ms für 30 KPIs (Embed-Batch 50ms + Rerank 30ms via fp32-exact).
 * Keine LLM-Roundtrips — deterministisch, container-merkleroot-konsistent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../core/stage.ts';
import { embedBatch, formatQuery, l2normalize } from '../lib/gemma-embed.ts';
import { ExactFp32Index, type CascadeManifest } from '../lib/quantum-index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../verticals/elster-v3/data');
const ECODE_RX = /^E\d{7}$/;

export interface Kpi {
  key: string;
  value: string | number;
  belegtyp?: string;
  doc?: string;
}

export interface KpiToEcodeInput {
  kpis: Kpi[];
  minScore?: number;
  defaultBelegtyp?: string;
  /** Whitelist anlage-codes (z.B. ['N','VOR','SA','KAP']) — filter atoms.
   *  Wenn leer/undefined: kein Filter. Aus classifyDocument.recommendedAnlagen. */
  allowedAnlagen?: string[];
}

export interface CanonicalEntry {
  ecode: string;
  anlage: string;
  drucktext: string;
  vordruckzeile?: string;
  values: Array<{
    value: string | number;
    source_doc?: string;
    source_kpi_key?: string;
    score: number;
    tier: 'tier1';
  }>;
}

export interface KpiToEcodeOutput {
  canonical_layer: Record<string, CanonicalEntry>;
  unmatched: Array<{ key: string; value: string | number; top_ecode?: string; top_score?: number }>;
  stats: {
    kpis_in: number;
    accepted: number;
    rejected: number;
    distinct_ecodes: number;
    embed_ms: number;
    rerank_ms: number;
    total_ms: number;
  };
}

// ─── Cached Catalog ─────────────────────────────────────────────────────────
interface Atom {
  field_name: string;
  value: string;
  metadata?: {
    anlage?: string;
    drucktext?: string;
    vordruckzeile?: string;
    datentyp?: string;
  };
}
interface CatalogCache {
  atomsRaw: Atom[];
  ecodeIndices: number[];
  exact: ExactFp32Index;
}
let _cached: CatalogCache | null = null;
async function loadCatalog(): Promise<CatalogCache> {
  if (_cached) return _cached;
  const atomsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'atoms.json'), 'utf-8')) as Atom[];
  const cm: CascadeManifest = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.cascade.json'), 'utf-8'),
  );
  if (!cm.exact) throw new Error('cascade manifest has no exact tier');
  const exact = await ExactFp32Index.load(path.join(DATA_DIR, cm.exact.file), cm.exact.d);
  const ecodeIndices: number[] = [];
  for (let i = 0; i < atomsRaw.length; i++) {
    if (ECODE_RX.test(atomsRaw[i].field_name)) ecodeIndices.push(i);
  }
  _cached = { atomsRaw, ecodeIndices, exact };
  return _cached;
}

export const kpiToEcodeStage = defineStage<KpiToEcodeInput, KpiToEcodeOutput>({
  id: 'kpi-to-ecode',
  name: 'KPI → eCode (Polar Tier-1)',
  description: 'EmbeddingGemma + Polar-fp32-rerank: jeden KPI-Key auf den nächsten eCode mappen',

  async run(input, _ctx) {
    const t0 = Date.now();
    const minScore = input.minScore ?? 0.55;
    const kpis = (input.kpis ?? []).filter(k => k?.key);
    if (kpis.length === 0) {
      return {
        canonical_layer: {}, unmatched: [],
        stats: { kpis_in: 0, accepted: 0, rejected: 0, distinct_ecodes: 0, embed_ms: 0, rerank_ms: 0, total_ms: 0 },
      };
    }

    const catalog = await loadCatalog();

    // anlage-whitelist: filter ecodeIndices auf erlaubte Anlagen
    let candidateIndices = catalog.ecodeIndices;
    const wl = (input.allowedAnlagen ?? []).filter(Boolean);
    if (wl.length > 0) {
      const wlSet = new Set(wl.map(a => a.toUpperCase()));
      candidateIndices = catalog.ecodeIndices.filter(i => {
        const a = catalog.atomsRaw[i].metadata?.anlage;
        return a ? wlSet.has(String(a).toUpperCase()) : false;
      });
      // Falls Filter leer macht → fallback auf alle
      if (candidateIndices.length === 0) candidateIndices = catalog.ecodeIndices;
    }

    // Embed
    const tE0 = Date.now();
    const queries = kpis.map(k => formatQuery(
      `${k.belegtyp ?? input.defaultBelegtyp ?? ''}: ${k.key}`.replace(/^:\s*/, ''),
    ));
    const vecs = await embedBatch(queries, { provider: 'vllm' });
    const vecsNorm = vecs.map(v => l2normalize(new Float32Array(v)));
    const embedMs = Date.now() - tE0;

    // Rerank
    const tR0 = Date.now();
    const canonical: Record<string, CanonicalEntry> = {};
    const unmatched: KpiToEcodeOutput['unmatched'] = [];
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < kpis.length; i++) {
      const kpi = kpis[i];
      const top = catalog.exact.rerank(vecsNorm[i], candidateIndices, 1);
      const t0Top = top[0];
      if (!t0Top || t0Top.score < minScore) {
        rejected++;
        unmatched.push({
          key: kpi.key, value: kpi.value,
          top_ecode: t0Top ? catalog.atomsRaw[t0Top.idx].field_name : undefined,
          top_score: t0Top?.score,
        });
        continue;
      }
      const atom = catalog.atomsRaw[t0Top.idx];
      const ec = atom.field_name;
      const meta = atom.metadata ?? {};
      if (!canonical[ec]) {
        canonical[ec] = {
          ecode: ec,
          anlage: meta.anlage ?? '?',
          drucktext: (meta.drucktext ?? atom.value)?.slice(0, 160) ?? '',
          vordruckzeile: meta.vordruckzeile,
          values: [],
        };
      }
      canonical[ec].values.push({
        value: kpi.value,
        source_doc: kpi.doc,
        source_kpi_key: kpi.key,
        score: t0Top.score,
        tier: 'tier1',
      });
      accepted++;
    }
    const rerankMs = Date.now() - tR0;

    return {
      canonical_layer: canonical,
      unmatched,
      stats: {
        kpis_in: kpis.length,
        accepted, rejected,
        distinct_ecodes: Object.keys(canonical).length,
        embed_ms: embedMs,
        rerank_ms: rerankMs,
        total_ms: Date.now() - t0,
      },
    };
  },
});
