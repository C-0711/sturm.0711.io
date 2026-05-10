/**
 * v3 three-lane retrieve+answer — modeled on apps/hub/src/app/api/bosch/answer.
 *
 * Lane A (text): atom-RAG via cosine over container embeddings → vLLM Gemma-4 → cited eCode answer
 * Lane B (vision): bge-m3 query embed → pgvector cosine in enriched.visual_atoms → page PNG → Gemma-4 MM (NOT WIRED YET — needs visual_atoms for ELSTER docs)
 * Lane C (trap): regex out-of-scope check → structural refusal (e.g. KPIs that don't belong to this container)
 *
 * For a Hildburg Spendenquittung KPI like "Spendenbetrag Person A":
 *   Lane A: top-5 atoms via cosine → Gemma-4 picks E0108405, cites it → signed answer
 *   Lane C: if KPI is "WLAN" or "Bluetooth" → out-of-scope refusal (these aren't tax codes)
 */
import { embed, cosineTopK, type IndexEntry } from '../../../lib/embedding-runtime.ts';
import { chatJson } from '../../../lib/llm-chat.ts';
import { loadV3Bundle, type ElsterV3Bundle, type ElsterAtom } from './container-reader.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Lane C — trap detection (out-of-scope keywords for tax)
// ─────────────────────────────────────────────────────────────────────────────

const OUT_OF_SCOPE = [
  /\bwlan\b/i, /\bbluetooth\b/i, /\bwifi\b/i, /\bzigbee\b/i, /\bsmart\s*home\b/i,
  /\busb[\s-]?[abc]\b/i, /\bhdmi\b/i,
  /\bgewicht\s+\d+\s*kg\b/i, /\babmessungen\b/i,  // product-spec terms, not tax
];

export interface TrapResult {
  triggered: boolean;
  matchedPattern?: string;
  refusal?: string;
}

export function detectTrap(query: string): TrapResult {
  for (const pat of OUT_OF_SCOPE) {
    const m = pat.exec(query);
    if (m) {
      return {
        triggered: true,
        matchedPattern: pat.source,
        refusal: `Diese Anfrage liegt außerhalb des ELSTER-Container-Scopes. Der Begriff "${m[0]}" ist Produkt-/Technik-Terminologie, kein steuerlicher KPI.`,
      };
    }
  }
  return { triggered: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lane A — atom-RAG (cosine over container atoms → Gemma-4 with cited eCodes)
// ─────────────────────────────────────────────────────────────────────────────

export interface LaneAResult {
  answer: string;
  cited_eCodes: string[];
  retrieved_atoms: Array<{ field_name: string; cosine: number; bezeichnung: string; anlage: string }>;
  retrieval_latency_ms: number;
  generation_latency_ms: number;
  model: string;
  citation_proof: {
    container_id: string;
    merkle_root: string;
    sha256: string;
    anchored: boolean;
    anchor_tx: string | null;
  };
}

export interface LaneAOptions {
  /** scope retrieve to these Anlagen (k-NN cluster) */
  recommendedAnlagen?: string[];
  /** top-K atoms to feed Gemma-4 */
  topK?: number;
  /** chat provider for Reason */
  chatProvider?: 'vllm' | 'mistral' | 'ollama';
  chatModel?: string;
  /** embed provider used for QUERY embedding — must match container's index model */
  embedProvider?: 'ollama' | 'mistral';
  embedModel?: string;
}

export async function laneA(
  query: string,
  bundle: ElsterV3Bundle,
  opts: LaneAOptions = {},
): Promise<LaneAResult> {
  const topK = opts.topK ?? 5;

  // Stage 1: retrieve
  const t0 = Date.now();
  const queryVec = await embed(query, {
    provider: opts.embedProvider ?? 'ollama',
    model: opts.embedModel ?? bundle.container.embeddings.model,
  });
  // Filter atoms by recommended Anlagen if any
  let candidates: IndexEntry[] = bundle.embeddings;
  if (opts.recommendedAnlagen?.length) {
    const allowed = new Set<string>();
    for (const a of opts.recommendedAnlagen) {
      const atoms = bundle.byAnlage.get(a) ?? [];
      for (const at of atoms) allowed.add(at.field_name);
    }
    if (allowed.size > 0) {
      candidates = bundle.embeddings.filter((e) => allowed.has(e.id));
    }
  }
  const top = cosineTopK(queryVec, candidates, topK);
  const retrievedAtoms = top.map((t) => {
    const a = bundle.byCode.get(t.id)!;
    return {
      field_name: t.id,
      cosine: t.score,
      bezeichnung: a.value,
      anlage: a.metadata.anlage,
    };
  });
  const retrievalMs = Date.now() - t0;

  // Stage 2: Gemma-4 reads top-K atoms, picks correct eCode with citations
  const t1 = Date.now();
  const provider = opts.chatProvider ?? 'vllm';
  const model = opts.chatModel ?? 'gemma4-mm';
  const atomBlock = retrievedAtoms.map((r) =>
    `  ${r.field_name} (Anlage ${r.anlage}, cos ${r.cosine.toFixed(3)}): ${r.bezeichnung}`
  ).join('\n');
  const prompt = [
    `Du bist ELSTER-Steuer-Experte. Eine KPI aus einem deutschen Steuerdokument soll auf den ELSTER-eCode-Katalog gemappt werden.`,
    ``,
    `KPI: ${query}`,
    ``,
    `Top-${topK} Kandidaten-Atome aus Container ${bundle.container.id} (merkle ${bundle.container.merkle_root.slice(0, 8)}…):`,
    atomBlock,
    ``,
    `Wähle den BESTEN eCode (oder null wenn keiner passt). Antworte als JSON:`,
    `{"eCode":"E0xxxxxx" oder null, "confidence":0.0..1.0, "begruendung":"max 1 Satz"}`,
  ].join('\n');
  const chatRes = await chatJson<{ eCode?: string | null; confidence?: number; begruendung?: string }>(
    prompt, { provider, model, temperature: 0, maxTokens: 200 },
  );
  const generationMs = Date.now() - t1;
  const eCode = chatRes.parsed.eCode ?? null;

  return {
    answer: chatRes.parsed.begruendung ?? '',
    cited_eCodes: eCode ? [eCode] : [],
    retrieved_atoms: retrievedAtoms,
    retrieval_latency_ms: retrievalMs,
    generation_latency_ms: generationMs,
    model,
    citation_proof: {
      container_id: bundle.container.id,
      merkle_root: bundle.container.merkle_root,
      sha256: bundle.container.container_sha256,
      anchored: !!bundle.container.anchor_tx_hash,
      anchor_tx: bundle.container.anchor_tx_hash,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined three-lane API — convenience for end-to-end calls
// ─────────────────────────────────────────────────────────────────────────────

export interface ThreeLaneAnswer {
  query: string;
  trap: TrapResult;
  laneA: LaneAResult | null;
  /** Best eCode across lanes (null if all rejected) */
  best_eCode: string | null;
  /** Total latency including all lanes */
  total_ms: number;
  /** Container provenance for the canonical-layer trace */
  container_proof: LaneAResult['citation_proof'];
}

export async function answer(
  query: string,
  opts: LaneAOptions = {},
): Promise<ThreeLaneAnswer> {
  const t0 = Date.now();
  const bundle = await loadV3Bundle();

  // Lane C first — fail fast on out-of-scope
  const trap = detectTrap(query);
  if (trap.triggered) {
    return {
      query,
      trap,
      laneA: null,
      best_eCode: null,
      total_ms: Date.now() - t0,
      container_proof: {
        container_id: bundle.container.id,
        merkle_root: bundle.container.merkle_root,
        sha256: bundle.container.container_sha256,
        anchored: !!bundle.container.anchor_tx_hash,
        anchor_tx: bundle.container.anchor_tx_hash,
      },
    };
  }

  // Lane A
  const laneAResult = await laneA(query, bundle, opts);
  return {
    query,
    trap,
    laneA: laneAResult,
    best_eCode: laneAResult.cited_eCodes[0] ?? null,
    total_ms: Date.now() - t0,
    container_proof: laneAResult.citation_proof,
  };
}
