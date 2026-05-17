/**
 * v2 cascade — Group, Embed, and Reason architecture
 *
 * Replaces (or augments) the v1 deterministic cascade. Stages:
 *
 *   A. Group     — narrow candidates by recommended Anlage (cluster)
 *   B. Embed     — embed query (KPI label + context) via bge-m3 / mistral-embed
 *   C. Cosine    — top-K against bundled catalog embeddings
 *   D. (BM25)    — optional lexical rerank — TODO when bm25_corpus is bundled
 *   E. Reason    — LLM zero-shot disambiguation on top-3 (Gemma-4 / Mistral-large)
 *                  with mandatory chain-of-thought; LLM may also reject all top-K
 *   F. (Graph)   — Apache AGE 1-hop neighbor expansion if confidence < .85
 *                  TODO: graph data on H200V is skeletal, deferred
 *   G. v1 fallback — runs the existing deterministic cascade-config
 *
 * Each stage is a CascadeStage<ElsterCatalog> consumed by the generic
 * src/lib/cascade-runtime.ts. The whole config is built lazily so the
 * bundled-index loader runs once at startup, not per-KPI.
 */
import type { CascadeConfig, CascadeStage, KPI, Match } from '../../../lib/cascade-runtime.ts';
import { loadCatalog, type ElsterCatalog, type ElsterFieldEntry } from './elster-katalog.ts';
import { loadBundledIndex, embed, cosineTopK, type BundledIndex } from '../../../lib/embedding-runtime.ts';
import { chatJson } from '../../../lib/llm-chat.ts';
import { coerceValue } from './validation.ts';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '..', 'data');

// ─────────────────────────────────────────────────────────────────────────────
// Lazy-loaded shared resources (load once per process)
// ─────────────────────────────────────────────────────────────────────────────

let catalogP: Promise<ElsterCatalog> | null = null;
let indexP: Promise<BundledIndex> | null = null;

async function getCatalog(): Promise<ElsterCatalog> {
  if (!catalogP) catalogP = loadCatalog();
  return catalogP;
}

async function getIndex(): Promise<BundledIndex> {
  if (!indexP) {
    // Default to the Ollama bge-m3 index produced by preprocess-embed-catalog.mjs
    const bin = process.env.ELSTER_INDEX_BIN ?? join(DATA, 'ecode_index_ollama_bge-m3.bin'); // lint-no-env: allow — bundled index location, pre-P10 lib module
    const meta = process.env.ELSTER_INDEX_META ?? join(DATA, 'ecode_index_ollama_bge-m3.meta.json'); // lint-no-env: allow — bundled index meta path, pre-P10 lib module
    indexP = loadBundledIndex(bin, meta);
  }
  return indexP;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildQueryText(kpi: KPI): string {
  const parts: string[] = [`Label: ${kpi.key}`];
  if (kpi.value !== undefined && kpi.value !== null && kpi.value !== '') {
    const v = String(kpi.value).slice(0, 100);
    parts.push(`Wert: ${v}`);
  }
  if (kpi.docType) parts.push(`Dokumenttyp: ${kpi.docType}`);
  if (kpi.recommendedAnlagen?.length) {
    parts.push(`Anlage: ${kpi.recommendedAnlagen.join(', ')}`);
  }
  return parts.join('\n');
}

function scopeByAnlagen(
  catalog: ElsterCatalog,
  anlagen: string[] | undefined,
): Set<string> | null {
  if (!anlagen || anlagen.length === 0) return null;
  const allowed = new Set<string>();
  for (const a of anlagen) {
    const bucket = catalog.feldKatalog.anlagen[a];
    if (bucket) for (const f of bucket.codes) allowed.add(f.eCode);
  }
  return allowed.size > 0 ? allowed : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stages
// ─────────────────────────────────────────────────────────────────────────────

/** Stage C: cosine top-K against bundled embeddings, scoped by Anlage. */
const stageEmbed: CascadeStage<ElsterCatalog> = {
  id: 'embed-cosine',
  minConfidence: 0.78,  // bge-m3 cosine on German tax labels typically 0.7-0.95
  async: true,
  async match(kpi, catalog) {
    let index: BundledIndex;
    try {
      index = await getIndex();
    } catch (e) {
      // Index not bundled yet — silently decline
      return null;
    }
    const queryText = buildQueryText(kpi);
    let queryVec;
    try {
      queryVec = await embed(queryText, { provider: 'ollama', model: index.model });
    } catch {
      return null;
    }
    if (queryVec.length !== index.dim) {
      console.warn(`embed dim mismatch q=${queryVec.length} idx=${index.dim}`);
      return null;
    }
    // Scope to recommended anlagen if available
    const allowed = scopeByAnlagen(catalog, kpi.recommendedAnlagen);
    const filtered = allowed
      ? index.entries.filter((e) => allowed.has(e.id))
      : index.entries;
    if (filtered.length === 0) return null;
    const top = cosineTopK(queryVec, filtered, 3);
    const winner = top[0];
    if (!winner) return null;
    const f = catalog.byCode.get(winner.id);
    if (!f) return null;
    // Map cosine [0..1] → confidence [0.6..0.95] (cosine 0.85 → conf 0.86)
    const confidence = Math.max(0.6, Math.min(0.95, winner.score));
    return {
      code: winner.id,
      value: coerceValue(kpi.value, f.datentyp),
      confidence,
      reasoning: `embed-cosine: top1=${winner.id} score=${winner.score.toFixed(3)} ` +
                 `(top3: ${top.map((t) => `${t.id}:${t.score.toFixed(2)}`).join(', ')})`,
    };
  },
};

/**
 * Stage E: LLM Reason. Takes the top-3 from cosine and asks Gemma-4 (or
 * Mistral-large) to pick the best one with chain-of-thought justification.
 *
 * Triggers only when stageEmbed found candidates but they're below stageEmbed's
 * threshold (i.e. ambiguous). We re-run cosine inside this stage to get the
 * top-3 candidates, then ask the LLM.
 *
 * Concretely: this stage runs when stageEmbed's confidence was 0.6-0.78 (the
 * "ambiguous" zone). When confidence ≥ 0.78 stageEmbed already wins; when
 * < 0.6 the cosine result is too weak to even disambiguate.
 */
const stageReason: CascadeStage<ElsterCatalog> = {
  id: 'embed-llm-reason',
  minConfidence: 0.80,
  async: true,
  async match(kpi, catalog) {
    let index: BundledIndex;
    try {
      index = await getIndex();
    } catch {
      return null;
    }
    const queryText = buildQueryText(kpi);
    let queryVec;
    try {
      queryVec = await embed(queryText, { provider: 'ollama', model: index.model });
    } catch {
      return null;
    }
    if (queryVec.length !== index.dim) return null;
    const allowed = scopeByAnlagen(catalog, kpi.recommendedAnlagen);
    const filtered = allowed
      ? index.entries.filter((e) => allowed.has(e.id))
      : index.entries;
    if (filtered.length === 0) return null;
    const top = cosineTopK(queryVec, filtered, 5);
    if (top.length === 0) return null;
    // Build candidate list with enriched catalog info for LLM
    const candidates = top.map((t, i) => {
      const f = catalog.byCode.get(t.id);
      return {
        rank: i + 1,
        eCode: t.id,
        cosine: Number(t.score.toFixed(3)),
        bezeichnung: f?.bezeichnung ?? '',
        datentyp: f?.datentyp ?? '',
        anlagen_kontext: f?.kontextPaths?.[0] ?? '',
      };
    });
    const provider = (process.env.CHAT_PROVIDER as 'mistral' | 'ollama' | undefined) ?? 'ollama'; // lint-no-env: allow — pre-P10 elster-v1 lib, not yet migrated to ctx.tools
    const model = process.env.CHAT_MODEL ?? // lint-no-env: allow — pre-P10 elster-v1 lib, not yet migrated to ctx.tools
      (provider === 'mistral' ? 'mistral-large-latest' : 'gemma4:31b-128k');
    const prompt = [
      `Du bist Steuerberater-Experte und mappst frei extrahierte KPIs aus deutschen Steuerdokumenten`,
      `auf den ELSTER-eCode-Katalog. Wähle aus den ${candidates.length} Kandidaten den am besten passenden.`,
      ``,
      `KPI:`,
      queryText,
      ``,
      `Kandidaten (sortiert nach Cosine-Similarity):`,
      JSON.stringify(candidates, null, 2),
      ``,
      `Antworte NUR als JSON: {"eCode":"E0xxxxxx" oder null, "confidence":0.0..1.0, "begruendung":"..."}`,
      `Wenn KEIN Kandidat passt, setze eCode=null und erkläre warum.`,
      `confidence > 0.85 = sehr sicher; 0.7-0.85 = wahrscheinlich; < 0.7 = unsicher.`,
    ].join('\n');
    let parsed;
    try {
      const r = await chatJson<{ eCode?: string | null; confidence?: number; begruendung?: string }>(
        prompt, { provider, model, temperature: 0 },
      );
      parsed = r.parsed;
    } catch (e) {
      return null;
    }
    if (!parsed.eCode) return null;
    if (!catalog.byCode.has(parsed.eCode)) return null;
    const f = catalog.byCode.get(parsed.eCode)!;
    const confidence = Math.max(0.6, Math.min(0.95, parsed.confidence ?? 0.8));
    return {
      code: parsed.eCode,
      value: coerceValue(kpi.value, f.datentyp),
      confidence,
      reasoning: `llm-reason (${model}): ${parsed.begruendung ?? '-'} ` +
                 `[top3: ${candidates.slice(0, 3).map((c) => `${c.eCode}:${c.cosine}`).join(',')}]`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public CascadeConfig
// ─────────────────────────────────────────────────────────────────────────────

export async function getElsterEmbedCascadeConfig(): Promise<CascadeConfig<ElsterCatalog>> {
  const catalog = await getCatalog();
  return {
    schemaId: 'elster',
    version: catalog.feldKatalog.catalogVersion,
    stages: [stageEmbed, stageReason],
  };
}

export const ELSTER_EMBED_CASCADE_STAGES = ['embed-cosine', 'embed-llm-reason'] as const;
