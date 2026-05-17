/**
 * ELSTER vertical (v3) — gitchain-anchored container, three-lane retrieval.
 *
 * Standard: ELSTER (Bundeszentralamt für Steuern, Germany)
 * Domain: tax
 * Canonical schema: ELSTER eCodes (E0123456 format)
 * Catalog container: 0711:elster:bmf:jahresdok-2024:v1
 *
 * Pipeline (workflow elster-v3):
 *   ocr → klassifizierung → layer1-extract → layer2-resolve → deterministic-rules → done
 *
 * Layer 1 — Gemma-4 strict json_schema nested extraction (vLLM at :11435).
 * Layer 2 — Entity resolution against curated whitelist + Gemma fallback.
 * Layer 4 — Deterministic projection: filter, aggregate, project to eCode map.
 *
 * `klassifizierung` is reused from prod's legacy src/workflows/elster/ stage.
 * Only the v3-specific stages (layer1, layer2) are registered here; the
 * shared deterministic-rules + validator are owned by the elster v2 vertical.
 */
import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { layer1ExtractStage } from './stages/layer1-extract.ts';
import { layer2ResolveStage } from './stages/layer2-resolve.ts';
import { pageSplitStage } from './stages/page-split.ts';
import { quantumRetrieveStage } from './stages/quantum-retrieve.ts';
import { quantumGroundStage } from './stages/quantum-ground.ts';
import { retrievalVerifyStage } from './stages/retrieval-verify.ts';
import { layer1OrFanoutStage } from './stages/layer1-or-fanout.ts';
import { anlagenErmittlungStage } from './stages/anlagen-ermittlung.ts';
import { felderKatalogStage } from './stages/felder-katalog.ts';
import { containerExtractStage } from './stages/container-extract.ts';
import { phase1RegexStage } from './stages/phase1-regex.ts';
import { phase3LlmFillStage } from './stages/phase3-llm-fill.ts';
import { phase4EntityDisambigStage } from './stages/phase4-entity-disambig.ts';
import { phase5MergeStage } from './stages/phase5-merge.ts';
import { bmfRechnerComputeStage } from './stages/bmf-rechner-compute.ts';
import { felderNarrowStage } from './stages/felder-narrow.ts';
import { phase3EnsembleMergeStage } from './stages/phase3-ensemble-merge.ts';
import { mistralOcrClassifyStage } from './stages/mistral-ocr-classify.ts';
// elster-v4-stricker: Light-Path Stages (citation-curated, slot-norm, 4-Tier MRL)
import { labelValueParserStage } from './stages/label-value-parser.ts';
import { atomsCascadeSearchStage } from './stages/atoms-cascade-search.ts';
import { formatRegexValidateStage } from './stages/format-regex-validate.ts';
import { confidenceGateStage } from './stages/confidence-gate.ts';
import { llmDisambigStage } from './stages/llm-disambig.ts';
import { finalizeExtractionStage } from './stages/finalize-extraction.ts';

export const ELSTER_V3_VERTICAL_META = {
  standardId: 'elster-v3',
  standardFullName: 'ELSTER (gitchain-anchored container, 2024)',
  domain: 'tax',
  canonicalSchemaName: 'ELSTER eCodes',
  catalogVersion: 'jahresdok-2024:v1 (anchored)',
  primaryEntityKind: 'document' as const,
};

/**
 * Registers v3-specific stages:
 *   - elster-v3/layer1-extract
 *   - elster-v3/layer2-resolve
 *
 * NOT registered here:
 *   - elster/klassifizierung    (prod's src/workflows/elster/)
 *   - elster/deterministic-rules (registered by elster v2 vertical)
 *   - elster/validator           (registered by elster v2 vertical)
 */
export function registerElsterV3Stages(): void {
  registerStage(layer1ExtractStage);
  registerStage(layer2ResolveStage);
  registerStage(pageSplitStage);
  registerStage(quantumRetrieveStage);
  registerStage(quantumGroundStage);
  registerStage(retrievalVerifyStage);
  registerStage(layer1OrFanoutStage);
  registerStage(anlagenErmittlungStage);
  // elster-v4: schlanke Container-Direct-Extract-Pipeline
  registerStage(felderKatalogStage);
  registerStage(containerExtractStage);
  // elster-v5: Regex-First + LLM-Lückenfüller + Canonical Merge
  registerStage(phase1RegexStage);
  registerStage(phase3LlmFillStage);
  registerStage(phase5MergeStage);
  // elster-v5.1: Layer-2-Disambig zusätzlich, plus typedSchema-Modus von phase3
  registerStage(phase4EntityDisambigStage);
  // elster-v5.2: Lane-1 BMF Steuerberechnung via MCP-Bridge
  registerStage(bmfRechnerComputeStage);
  // elster-v5_2-rag: RAG-gestützte Engführung des Felder-Katalogs
  registerStage(felderNarrowStage);
  // elster-v5_2-rag-ensemble: N-Branch Consensus Merge über phase3-Outputs
  registerStage(phase3EnsembleMergeStage);
  registerStage(mistralOcrClassifyStage);
  // elster-v4-stricker: Light-Path deterministic chain for text-layer PDFs (VAST exports)
  registerStage(labelValueParserStage);
  registerStage(atomsCascadeSearchStage);
  registerStage(formatRegexValidateStage);
  registerStage(confidenceGateStage); // legacy, bleibt für ältere Workflows
  registerStage(llmDisambigStage);
  registerStage(finalizeExtractionStage);
}

/**
 * Builds the elster-v3 workflow.
 *
 * Workflow id: `elster-v3` (parallel to elster-v1 and elster-v2).
 *
 * Input: PDF/PNG/JPG of a German tax document (Spendenquittung, Lohnsteuer-
 * bescheinigung, Rentenbezugsmitteilung, …).
 *
 * Output: a CanonicalLayer with `codes` (flat eCode map), `nested` (rich
 * nested JSON), `traces` (per-eCode provenance), and `container_proof`
 * (merkle root + container sha for tamper-evident audit trail).
 */
export function buildElsterV3WorkflowWithSchema() {
  return defineWorkflow({
    id: 'elster-v3',
    name: 'ELSTER v3 — gitchain three-lane (Gemma-4 + bge-m3 + container-anchored)',
    description:
      'OCR → Hybrid-Klassifizierung → Layer 1 strict json_schema nested-extract via Gemma-4 (vLLM) → Layer 2 entity-resolution gegen kuratierten legal-entity-Whitelist → Layer 4 deterministic-rules Projektion auf flache eCode-Map. Output: CanonicalLayer mit nested JSON + flat codes + container_proof (merkle).',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 50,
    },
    stages: {
      // ── OCR fan-out across three engines ────────────────────────────
      ocrFanout: {
        uses: 'compare/fanout',
        config: {
          continueOnError: true,
          branches: {
            mistral: {
              uses: 'mistral-ocr',
              config: { confidenceScoresGranularity: 'page' },
            },
            lighton: {
              uses: 'lighton-ocr',
              config: {},
            },
            paddle: {
              uses: 'paddleocr-vl',
              config: {},
            },
          },
        },
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      // ── Semantic merge across the three OCR variants ────────────────
      ocr: {
        uses: 'compare/ocr-consensus-merge',
        config: {
          joinThreshold: 0.85,
          minLineChars: 3,
          disagreementCharThreshold: 6,
          embed: { cpuOnly: true },
        },
        // The merger checks `'branches' in input`, so we pass the
        // FanoutOutput shape through individual keys.
        inputs: {
          branches: '${ocrFanout.branches}',
          perBranchMs: '${ocrFanout.perBranchMs}',
          errors: '${ocrFanout.errors}',
          ms: '${ocrFanout.ms}',
        },
      },
      klassifizierung: {
        uses: 'steuerbelege/dokument-typ',
        config: {
          model: 'mistral-small-latest',
          useLlmFallback: true,
        },
        inputs: {
          text: '${ocr.text}',
        },
      },
      // ── Retrieval grounding before Layer-1 ──────────────────────────
      quantumGround: {
        uses: 'elster-v3/quantum-ground',
        config: {
          maxPhrasen: 30,
          proPhraseK: 10,
          finalK: 50,
          pflichtScaffold: true,
          outOfAnlageTail: 5,
          embed: { cpuOnly: true },
        },
        inputs: {
          text: '${ocr.text}',
          dokumenttyp_id: '${klassifizierung.typ_id}',
          // Anlagen-Whitelist von der Klassifizierungs-Stage: scoped Cascade
          // + Pflicht-Scaffold der relevanten Anlagen IMMER dabei.
          anlagen: '${klassifizierung.anlagen}',
        },
      },
      // ── Pass 2: Container-grounded Anlagen-Ermittlung (Gemma-4) ────
      // Bestätigt/verwirft/ergänzt die Pass-1-Anlagen, identifiziert
      // konkrete eCodes mit Belegstellen aus dem OCR-Text.
      anlagenErmittlung: {
        uses: 'elster-v3/anlagen-ermittlung',
        config: {
          provider: 'vllm',
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 2000,
          maxKandidatenECodes: 80,
        },
        inputs: {
          text: '${ocr.text}',
          dokumenttyp_id: '${klassifizierung.typ_id}',
          anlagen: '${klassifizierung.anlagen}',
          kandidatenECodes: '${quantumGround.kandidatenECodes}',
          einkunftsarten: '${quantumGround.einkunftsarten}',
        },
      },
      // ── Layer-1 consensus: Gemma-4 + Mistral-large, vote per field ──
      layer1Fanout: {
        uses: 'compare/fanout',
        config: {
          continueOnError: true,
          branches: {
            gemma: {
              uses: 'elster-v3/layer1-extract',
              config: {
                provider: 'vllm',
                model: 'gemma4-mm',
                temperature: 0,
                maxTokens: 2000,
                maxKandidatenECodes: 50,
              },
            },
            mistral: {
              uses: 'elster-v3/layer1-extract',
              config: {
                provider: 'mistral',
                model: 'mistral-large-latest',
                temperature: 0,
                maxTokens: 2000,
                maxKandidatenECodes: 50,
              },
            },
          },
        },
        inputs: {
          text: '${ocr.text}',
          dokumenttyp_id: '${klassifizierung.typ_id}',
          kandidatenECodes: '${quantumGround.kandidatenECodes}',
          // §EStG-Rahmen für den Layer-1-Prompt (aus dem Container abgeleitet).
          einkunftsarten: '${quantumGround.einkunftsarten}',
          anlagen: '${klassifizierung.anlagen}',
          // Pass-2: Container-grounded eCode-Bestätigungen mit Belegstellen.
          pass2Result: '${anlagenErmittlung}',
        },
      },
      layer1: {
        uses: 'compare/merge',
        config: { policy: 'vote' },
        inputs: {
          branches: '${layer1Fanout.branches}',
          perBranchMs: '${layer1Fanout.perBranchMs}',
          errors: '${layer1Fanout.errors}',
          ms: '${layer1Fanout.ms}',
        },
      },
      // ── Retrieval-verify after the consensus output ────────────────
      verify: {
        uses: 'elster-v3/retrieval-verify',
        config: {
          topK: 20,
          // Calibrated 2026-05-12 from tests/groundtruth/calibration_report.json
          // (8 fixtures, 24 known-good eCodes; thresholds = p5×0.8 and p25 of
          // top-1 cosine distribution).
          unbekanntGrenze: 0.274,
          konfidenzGrenze: 0.400,
          embed: { cpuOnly: true },
        },
        inputs: {
          nested: '${layer1.chosen.nested}',
          dokumenttyp_id: '${klassifizierung.typ_id}',
          // Anlagen-Whitelist für Pflicht-Vollständigkeits-Check
          anlagen: '${klassifizierung.anlagen}',
          // Pass-2-Output: gating gegen erfundene eCodes / verworfene Anlagen.
          pass2Result: '${anlagenErmittlung}',
        },
      },
      layer2: {
        uses: 'elster-v3/layer2-resolve',
        config: {
          chatProvider: 'vllm',
          chatModel: 'gemma4-mm',
        },
        inputs: {
          nested: '${verify.nested}',
          dokumenttyp_id: '${klassifizierung.typ_id}',
        },
      },
      rules: {
        uses: 'elster/deterministic-rules',
        config: {},
        inputs: {
          nested: '${layer2.nested}',
          dokumenttyp_id: '${klassifizierung.typ_id}',
        },
      },
    },
    edges: [
      ['ocrFanout', 'ocr'],
      ['ocr', 'klassifizierung'],
      ['ocr', 'quantumGround'],
      ['klassifizierung', 'quantumGround'],
      ['ocr', 'layer1Fanout'],
      ['klassifizierung', 'layer1Fanout'],
      ['quantumGround', 'anlagenErmittlung'],
      ['klassifizierung', 'anlagenErmittlung'],
      ['ocr', 'anlagenErmittlung'],
      ['anlagenErmittlung', 'layer1Fanout'],
      ['quantumGround', 'layer1Fanout'],
      ['layer1Fanout', 'layer1'],
      ['layer1', 'verify'],
      ['klassifizierung', 'verify'],
      ['anlagenErmittlung', 'verify'],
      ['verify', 'layer2'],
      ['klassifizierung', 'layer2'],
      ['layer2', 'rules'],
      ['klassifizierung', 'rules'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog',
        description: 'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen.',
        kind: 'elster-catalog',
        readBy: ['layer1', 'layer2', 'rules'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'de938e468a7d85488906bf88af067160edeb08dc52d4399e2416df6760652bcc',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
      {
        id: '0711:elster:bge-m3:embeddings:v1',
        displayName: 'bge-m3 eCode Embeddings',
        description: '1024-dim dense embeddings über die 2287 ELSTER-eCodes. Wird vom Embed-Cascade-Pfad als kNN-Index gelesen.',
        kind: 'embedding-index',
        readBy: ['layer2'],
        atomsCount: 2287,
        embeddingDim: 1024,
        embeddingModel: 'bge-m3',
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        lockState: 'sealed',
      },
      {
        id: '0711:elster:gemma4-tq:embeddings:v1',
        displayName: 'Gemma-quantum eCode Cascade',
        description: 'EmbeddingGemma-300m (Ollama :11434, multilingual, 768-d native) over the 2287-atom catalog, compressed via MRL×TurboQuant cascade: d=256/b=3 coarse → d=768/b=3 fine → fp32 exact rerank. Built by scripts/encode-gemma-quantum-container.ts. Consumed by stage elster-v3/quantum-retrieve. Manifest: data/embeddings.gemma4.cascade.json.',
        kind: 'embedding-index',
        readBy: ['layer2'],
        atomsCount: 2287,
        embeddingDim: 768,
        embeddingModel: 'embeddinggemma',
        lockState: 'loading',
      },
    ],
  });
}

/**
 * Baut den schlanken elster-v4-Workflow: 6 Stages, Container-Direct-Extract.
 *
 *   ocr → klassifizierung (v2-regex, multi-Anlage)
 *       → felderKatalog (Container-Lookup, kein LLM)
 *       → containerExtract (vLLM Gemma-4 strict-json, sequenziell pro Anlage)
 *       → funnel (Cascade → CanonicalLayer)
 *       → validator (Hinweisregeln)
 *
 * Robust gegen Multi-Doc-Bundles weil v2's regex-klassifizierung alle Anlagen
 * erkennt (kein typ_id-Engpass). Determinstisch in der Klassifizierung; nur
 * EIN LLM-Hop pro Anlage statt 2-3 in v3. Output-Shape kompatibel zu
 * elster-v2's funnel/validator → CanonicalLayer.
 */
export function buildElsterV4Workflow() {
  return defineWorkflow({
    id: 'elster-v4',
    name: 'ELSTER v4 — Container Direct-Extract',
    description:
      'Schlanke Pipeline für ELSTER-Belege: klassifizierung (v2-regex, 5ms, multi-Anlage) ' +
      '→ felder-katalog (Container-Lookup auf atoms.json) → container-extract (vLLM Gemma-4 ' +
      'strict-json-schema pro Anlage, sequenziell) → funnel (reuse elster/funnel) → validator ' +
      '(reuse elster/validator). Robust gegen Multi-Doc-Bundles; deterministische Klassifizierung; ' +
      'single-source-of-truth aus atoms.json + CONTAINER_BRIEF.md. Kein Embedding-Cascade-Detour.',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 50,
    },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      klassifizierung: {
        uses: 'elster/klassifizierung',
        config: {
          llmFallbackWhen: 'zero',
        },
        inputs: {
          text: '${ocr.text}',
        },
      },
      felderKatalog: {
        uses: 'elster-v4/felder-katalog',
        config: {},
        inputs: {
          erkannte_anlagen: '${klassifizierung.erkannte_anlagen}',
        },
      },
      containerExtract: {
        uses: 'elster-v4/container-extract',
        config: {
          provider: 'vllm',
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 2000,
          maxFelderProAnlage: 250,
          // vLLM Continuous-Batching: 7 parallele Anlagen-Calls werden
          // auf der GPU effizient batched (PagedAttention), Wallclock
          // fällt auf max(individual) statt sum.
          concurrency: 7,
          // Token-Level SSE-Stream: pro fertig generiertem eCode-Wert
          // ein container_extract_field-Event in den UI-Stream.
          stream: true,
        },
        inputs: {
          text: '${ocr.text}',
          per_anlage: '${felderKatalog.per_anlage}',
        },
      },
      funnel: {
        uses: 'elster/funnel',
        config: {},
        inputs: {
          per_anlage: '${containerExtract.per_anlage}',
          text: '${ocr.text}',
        },
      },
      validator: {
        uses: 'elster/validator',
        config: {},
        inputs: {
          canonicalLayer: '${funnel.canonicalLayer}',
        },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['klassifizierung', 'felderKatalog'],
      ['felderKatalog', 'containerExtract'],
      ['ocr', 'containerExtract'],
      ['containerExtract', 'funnel'],
      ['ocr', 'funnel'],
      ['funnel', 'validator'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog (atoms.json + CONTAINER_BRIEF)',
        description:
          'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen. ' +
          'felder-katalog und container-extract lesen daraus.',
        kind: 'elster-catalog',
        readBy: ['felderKatalog', 'containerExtract'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'de938e468a7d85488906bf88af067160edeb08dc52d4399e2416df6760652bcc',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
    ],
  });
}

/**
 * Baut elster-v5 — Regex-First + LLM-Lückenfüller + Canonical Merge.
 *
 *   ocr → klassifizierung → felderKatalog → phase1Regex (deterministisch)
 *       → phase3LlmFill (vLLM nur für Lücken, mit Layout-Hints)
 *       → phase5Merge (canonical layer + ERiC-XML)
 *
 * Architektur-Vorteile gegenüber v4:
 *   • Phase 1 deckt 30-50% der Felder in <100ms ohne LLM-Call ab
 *   • Phase 3's strict-json-schema enthält nur die Restmenge → kleineres
 *     Vokabular → vLLM schneller und präziser
 *   • Phase 3 prompt kriegt Phase-1-Hits als räumliche Layout-Anker
 *   • Phase 5 generiert ERiC-XML deterministisch aus dem canonical layer
 *   • Volle Provenance: jedes Feld weiß ob es von REGEX_100% oder LLM_FSM kommt
 */
export function buildElsterV5Workflow() {
  return defineWorkflow({
    id: 'elster-v5',
    name: 'ELSTER v5 — Regex-First + LLM-Lückenfüller + Canonical Merge',
    description:
      'Regex-First-Pipeline: phase1-regex extrahiert deterministisch alle BMF-Zeilen-' +
      'Anker-Felder in <100ms (4-Faktor-Auth: vordruckzeile + drucktext + value + ' +
      'formatRegex). phase3-llm-fill (vLLM Gemma-4 strict-json) füllt nur die Lücken, ' +
      'mit dynamic schema und Layout-Hints aus phase 1. phase5-merge produziert die ' +
      'canonical layer + ERiC-kompatibles XML. Container ist single-source-of-truth ' +
      '(atoms.json + CONTAINER_BRIEF.md + paragraph_estg.json).',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 50,
    },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      klassifizierung: {
        uses: 'elster/klassifizierung',
        config: { llmFallbackWhen: 'zero' },
        inputs: { text: '${ocr.text}' },
      },
      felderKatalog: {
        uses: 'elster-v4/felder-katalog',
        config: {},
        inputs: { erkannte_anlagen: '${klassifizierung.erkannte_anlagen}' },
      },
      phase1Regex: {
        uses: 'elster-v5/phase1-regex',
        config: { minDrucktextLength: 5 },
        inputs: {
          text: '${ocr.text}',
          per_anlage: '${felderKatalog.per_anlage}',
        },
      },
      phase3LlmFill: {
        uses: 'elster-v5/phase3-llm-fill',
        config: {
          provider: 'vllm',
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 2000,
          // 3 statt 7 — kein Bottleneck im vLLM continuous batching auf TP=2.
          // Bei sauberer Last + warm prefix-cache kann man später hochziehen.
          concurrency: 3,
          stream: true,
          perAnlageTimeoutMs: 60_000,
        },
        inputs: {
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          felder_per_anlage: '${felderKatalog.per_anlage}',
        },
      },
      phase5Merge: {
        uses: 'elster-v5/phase5-merge',
        config: {},
        inputs: {
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase3LlmFill.per_anlage}',
        },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['klassifizierung', 'felderKatalog'],
      ['felderKatalog', 'phase1Regex'],
      ['ocr', 'phase1Regex'],
      ['phase1Regex', 'phase3LlmFill'],
      ['felderKatalog', 'phase3LlmFill'],
      ['ocr', 'phase3LlmFill'],
      ['phase1Regex', 'phase5Merge'],
      ['phase3LlmFill', 'phase5Merge'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog (atoms.json + CONTAINER_BRIEF)',
        description:
          'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen. ' +
          'phase1-regex, phase3-llm-fill und felder-katalog lesen daraus.',
        kind: 'elster-catalog',
        readBy: ['felderKatalog', 'phase1Regex', 'phase3LlmFill'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'de938e468a7d85488906bf88af067160edeb08dc52d4399e2416df6760652bcc',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
    ],
  });
}

/**
 * Baut elster-v5.1 — type-aware Schema + Layer-2 Entity-Disambig.
 *
 *   ocr → klassifizierung → felderKatalog → phase1Regex
 *       → phase3LlmFill (typedSchema=true: currency→number, date→ISO, enums)
 *       → phase4EntityDisambig (Mini-vLLM-Calls für PFLICHT-Restmenge)
 *       → phase5Merge
 *
 * Unterschiede zu v5:
 *   • FSM macht Type-Coercion (deutsche Beträge → number, Religion → enum)
 *   • Layer 2 fängt PFLICHT-Felder die Layer 1 als null gelassen hat
 *   • Phase 5 reused unverändert — Layer 2 mergt in den Phase-3-Output
 */
export function buildElsterV51Workflow() {
  return defineWorkflow({
    id: 'elster-v5_1',
    name: 'ELSTER v5.1 — Typed Schema + Layer-2 Disambig',
    description:
      'v5.1 erweitert v5 um den Sturm-v3-Architektur-Sprung: (1) phase3-llm-fill ' +
      'läuft im typedSchema-Modus, FSM coerced deutsche Beträge "30.707,00" → 30707, ' +
      'Religion-Felder werden auf BMF-Enum "ev"|"rk"|… constrained. (2) Neue Stage ' +
      'phase4-entity-disambig macht pro PFLICHT-eCode der nach Phase 3 noch null ist ' +
      'einen Mini-vLLM-Call mit Keyword-Kandidatensuche + strict 1-aus-K-Picker-Schema. ' +
      'Phase 5 unverändert — Layer-2-Hits werden in den Phase-3-Output gemergt.',
    input: { type: 'file', accept: ['pdf', 'png', 'jpg', 'jpeg'], maxSizeMb: 50 },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: { filePath: '${input.filePath}', filename: '${input.filename}' },
      },
      klassifizierung: {
        uses: 'elster/klassifizierung',
        config: { llmFallbackWhen: 'zero' },
        inputs: { text: '${ocr.text}' },
      },
      felderKatalog: {
        uses: 'elster-v4/felder-katalog',
        config: {},
        inputs: { erkannte_anlagen: '${klassifizierung.erkannte_anlagen}' },
      },
      phase1Regex: {
        uses: 'elster-v5/phase1-regex',
        config: { minDrucktextLength: 5 },
        inputs: { text: '${ocr.text}', per_anlage: '${felderKatalog.per_anlage}' },
      },
      phase3LlmFill: {
        uses: 'elster-v5/phase3-llm-fill',
        config: {
          provider: 'vllm',
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 2000,
          concurrency: 3,
          stream: true,
          perAnlageTimeoutMs: 60_000,
          typedSchema: true,
        },
        inputs: {
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          felder_per_anlage: '${felderKatalog.per_anlage}',
        },
      },
      phase4Disambig: {
        uses: 'elster-v5_1/phase4-entity-disambig',
        config: {
          provider: 'vllm',
          vllmUrl: 'http://localhost:11435',
          model: 'gemma4-mm',
          temperature: 0,
          confidenceThreshold: 0.7,
          topK: 5,
          concurrency: 5,
          perCallTimeoutMs: 20_000,
        },
        inputs: {
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase3LlmFill.per_anlage}',
          felder_per_anlage: '${felderKatalog.per_anlage}',
        },
      },
      phase5Merge: {
        uses: 'elster-v5/phase5-merge',
        config: {},
        inputs: {
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase4Disambig.per_anlage}',
        },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['klassifizierung', 'felderKatalog'],
      ['felderKatalog', 'phase1Regex'],
      ['ocr', 'phase1Regex'],
      ['phase1Regex', 'phase3LlmFill'],
      ['felderKatalog', 'phase3LlmFill'],
      ['ocr', 'phase3LlmFill'],
      ['phase1Regex', 'phase4Disambig'],
      ['phase3LlmFill', 'phase4Disambig'],
      ['felderKatalog', 'phase4Disambig'],
      ['ocr', 'phase4Disambig'],
      ['phase1Regex', 'phase5Merge'],
      ['phase4Disambig', 'phase5Merge'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog (atoms.json + CONTAINER_BRIEF)',
        description:
          'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen. v5.1 liest ' +
          'zusätzlich disambiguation_hints.json + paragraph_estg.json.',
        kind: 'elster-catalog',
        readBy: ['felderKatalog', 'phase1Regex', 'phase3LlmFill', 'phase4Disambig'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'de938e468a7d85488906bf88af067160edeb08dc52d4399e2416df6760652bcc',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
    ],
  });
}

/**
 * elster-v4-stricker — Light-Path: pdftotext + 4-Engine OCR Fanout +
 * Cascade-Search (4-Tier MRL TurboQuant) + LLM-Disambig (Gemma-4-31B).
 * Production-verified auf Stricker VAST-Bundle.
 */
export function buildElsterV4StrickerWorkflow() {
  return defineWorkflow({
    id: 'elster-v4-stricker',
    name: 'ELSTER v4 — Stricker-proven (citation-curated + slot-norm + 4-Tier MRL)',
    description:
      'Production-verified ELSTER-Extraktion. Pipeline: pdftotext → 4-Engine OCR-Fanout → ' +
      'consensus-merge → klassifizierung → label-value-parser → atoms-cascade-search (EmbeddingGemma × ' +
      '4-Tier-MRL-TurboQuant) → format-regex-validate → llm-disambig (Gemma-4-31B + TurboQuant KV b=4, ' +
      'strict-JSON, citation-aware + Slot-Normalize) → finalize-extraction. ' +
      'Container v5.8 mit curated atoms.json (32 Person-A/B + LStB-Modi citations) + ' +
      'v5.5-stable Embeddings + deterministic 4-Tier-Cascade. ' +
      'Verifiziert auf Stricker VAST-Bundle: 36/51 chunks accepted, alle 6 Lohnsteuer + ' +
      'alle 6 VOR-Pflichtfelder korrekt, Replay-fingerprint deterministisch.',
    input: { type: 'file', accept: ['pdf', 'png', 'jpg', 'jpeg'], maxSizeMb: 50 },
    stages: {
      pdfTextLayer: {
        uses: 'extract/pdf-text-layer',
        config: { layout: true, minCharsPerPageHeuristic: 50 },
        inputs: { filePath: '${input.filePath}', filename: '${input.filename}' },
      },
      ocrFanout: {
        uses: 'compare/fanout',
        config: {
          continueOnError: true,
          branches: {
            mistralMd:    { uses: 'mistral-small-ocr', config: { mode: 'md',    maxTokens: 4096, dpi: 200 } },
            mistralTable: { uses: 'mistral-small-ocr', config: { mode: 'table', maxTokens: 4096, dpi: 200 } },
            lighton:      { uses: 'lighton-ocr',       config: {} },
            paddle:       { uses: 'paddleocr-vl',      config: {} },
          },
        },
        inputs: { filePath: '${input.filePath}', filename: '${input.filename}' },
      },
      ocrMerge: {
        uses: 'compare/ocr-consensus-merge',
        config: {
          joinThreshold: 0.85,
          minLineChars: 3,
          disagreementCharThreshold: 6,
          embed: { cpuOnly: true },
        },
        inputs: {
          branches: '${ocrFanout.branches}',
          perBranchMs: '${ocrFanout.perBranchMs}',
          errors: '${ocrFanout.errors}',
          ms: '${ocrFanout.ms}',
        },
      },
      klassifizierung: {
        uses: 'steuerbelege/dokument-typ',
        config: { model: 'mistral-small-latest', useLlmFallback: true },
        inputs: { text: '${pdfTextLayer.text}' },
      },
      labelValueParser: {
        uses: 'elster-v3/label-value-parser',
        config: { minLabelChars: 4, gapWhitespace: 2 },
        inputs: { text: '${pdfTextLayer.text}' },
      },
      atomsCascadeSearch: {
        uses: 'elster-v3/atoms-cascade-search',
        config: { topK: 5, scopeToAnlagen: true, queryStrategy: 'label-only', embed: { cpuOnly: true } },
        inputs: { belege: '${labelValueParser.belege}', anlagen: '${klassifizierung.anlagen}' },
      },
      formatRegexValidate: {
        uses: 'elster-v3/format-regex-validate',
        config: { minCosine: 0.20 },
        inputs: { belege: '${atomsCascadeSearch.belege}' },
      },
      llmDisambig: {
        uses: 'elster-v3/llm-disambig',
        config: {
          acceptCosine: 0.65,
          disambigLo: 0.30,
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 300,
          maxConcurrency: 16,
        },
        inputs: {
          belege: '${formatRegexValidate.enrichedBelege}',
          dokumenttyp_id: '${klassifizierung.typ_id}',
        },
      },
      finalizeExtraction: {
        uses: 'elster-v3/finalize-extraction',
        config: {
          pflichtFailHard: false,
          llmInfo: {
            model_pin: 'google/gemma-4-31b-it',
            kv_quant_b: 4,
            temperature: 0,
            max_tokens: 300,
          },
        },
        inputs: {
          accepted: '${llmDisambig.accepted}',
          rejected: '${llmDisambig.rejected}',
          disambig_errors: '${llmDisambig.disambig_errors}',
          anlagen: '${klassifizierung.anlagen}',
        },
      },
    },
    edges: [
      ['pdfTextLayer', 'klassifizierung'],
      ['pdfTextLayer', 'labelValueParser'],
      ['ocrFanout', 'ocrMerge'],
      ['labelValueParser', 'atomsCascadeSearch'],
      ['klassifizierung', 'atomsCascadeSearch'],
      ['atomsCascadeSearch', 'formatRegexValidate'],
      ['formatRegexValidate', 'llmDisambig'],
      ['klassifizierung', 'llmDisambig'],
      ['llmDisambig', 'finalizeExtraction'],
      ['klassifizierung', 'finalizeExtraction'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog (citation-curated)',
        description:
          'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen. ' +
          '32 Atome haben curated citation_excerpts für Person-A/B-Disambig (Stammdaten) ' +
          'und LStB-Bescheinigungs-Modi (Sum/Einz × 1-5/6+).',
        kind: 'elster-catalog',
        readBy: ['atomsCascadeSearch', 'formatRegexValidate', 'llmDisambig', 'finalizeExtraction'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'a742aa348fea8b9f00f4a5f8',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
      {
        id: '0711:elster:gemma4-tq:embeddings:v1',
        displayName: 'Gemma-quantum eCode Cascade v5.8 (4-tier MRL)',
        description:
          'EmbeddingGemma-300m × full Matryoshka × TurboQuant cascade: ' +
          'd=128/b=2 (40B coarse) → d=256/b=3 (136B) → d=512/b=3 (264B) → d=768/b=3 (392B) → fp32 (3072B). ' +
          'v5.8 = v5.5 fp32 from backup + deterministic re-quantize of all 4 TQ tiers (seed=42).',
        kind: 'embedding-index',
        readBy: ['atomsCascadeSearch'],
        atomsCount: 2287,
        embeddingDim: 768,
        embeddingModel: 'embeddinggemma-300m',
        lockState: 'sealed',
      },
    ],
  });
}

/**
 * elster-v5.2 — v5.1 + Lane-1 BMF Steuerberechnung.
 *
 *   ocr → klassifizierung → felderKatalog → phase1Regex
 *       → phase3LlmFill → phase4Disambig → phase5Merge (DEKLARIERT)
 *       → phase6BmfRechner (BERECHNET via Lane-1 MCP)
 *
 * Connectivity: SSH-Tunnel `-L 12010:localhost:12010 192.168.145.10`
 * MCP: `ctaxv1-lane1-bmf` Container, 40 Tools, eCode-nativer Input.
 */
export function buildElsterV52Workflow() {
  return defineWorkflow({
    id: 'elster-v5_2',
    name: 'ELSTER v5.2 — v5.1 + Lane-1 BMF Steuerberechnung',
    description:
      'v5.2 erweitert v5.1 um die finale Phase: deklarierter canonical_layer ' +
      '(aus phase5-merge) wird an die Lane-1 BMF-MCP geschickt ' +
      '(`berechne_vollstaendige_steuer_v2`, eCode-nativer Input). MCP berechnet ' +
      'zvE, tarifliche ESt, Soli, festzusetzende Steuer mit Formel-Trace + ' +
      '§EStG-Bezug. Berechnete Werte werden als origin=BMF_RECHNER in den Layer ' +
      'gemerged. Graceful Degradation bei MCP-Down (kpi_warning, kein Hard-Fail).',
    input: { type: 'file', accept: ['pdf', 'png', 'jpg', 'jpeg'], maxSizeMb: 50 },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: { filePath: '${input.filePath}', filename: '${input.filename}' },
      },
      klassifizierung: {
        uses: 'elster/klassifizierung',
        config: { llmFallbackWhen: 'zero' },
        inputs: { text: '${ocr.text}' },
      },
      felderKatalog: {
        uses: 'elster-v4/felder-katalog',
        config: {},
        inputs: { erkannte_anlagen: '${klassifizierung.erkannte_anlagen}' },
      },
      phase1Regex: {
        uses: 'elster-v5/phase1-regex',
        config: { minDrucktextLength: 5 },
        inputs: { text: '${ocr.text}', per_anlage: '${felderKatalog.per_anlage}' },
      },
      phase3LlmFill: {
        uses: 'elster-v5/phase3-llm-fill',
        config: {
          provider: 'vllm',
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 2000,
          concurrency: 3,
          stream: true,
          perAnlageTimeoutMs: 60_000,
          typedSchema: true,
        },
        inputs: {
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          felder_per_anlage: '${felderKatalog.per_anlage}',
        },
      },
      phase4Disambig: {
        uses: 'elster-v5_1/phase4-entity-disambig',
        config: {
          provider: 'vllm',
          vllmUrl: 'http://localhost:11435',
          model: 'gemma4-mm',
          temperature: 0,
          confidenceThreshold: 0.7,
          topK: 5,
          concurrency: 5,
          perCallTimeoutMs: 20_000,
        },
        inputs: {
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase3LlmFill.per_anlage}',
          felder_per_anlage: '${felderKatalog.per_anlage}',
        },
      },
      phase5Merge: {
        uses: 'elster-v5/phase5-merge',
        config: {},
        inputs: {
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase4Disambig.per_anlage}',
        },
      },
      phase6BmfRechner: {
        uses: 'elster-v5_2/bmf-rechner-compute',
        config: {
          // mcpUrl bewusst NICHT hardcoded: lass env BMF_MCP_URL bestimmen.
          // Lokal (Mac dev): http://localhost:12010/mcp (via SSH-Tunnel)
          // Prod (Docker):  http://host.docker.internal:12010/mcp (via add-host)
          veranlagungsjahr: 2024,
          timeoutMs: 15_000,
          failHard: false,
        },
        inputs: { canonical_layer: '${phase5Merge.canonical_layer}' },
      },
      phase7Validator: {
        uses: 'elster/validator',
        config: { skipUnsupported: true },
        inputs: { canonicalLayer: '${phase6BmfRechner.canonicalLayer}' },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['klassifizierung', 'felderKatalog'],
      ['felderKatalog', 'phase1Regex'],
      ['ocr', 'phase1Regex'],
      ['phase1Regex', 'phase3LlmFill'],
      ['felderKatalog', 'phase3LlmFill'],
      ['ocr', 'phase3LlmFill'],
      ['phase1Regex', 'phase4Disambig'],
      ['phase3LlmFill', 'phase4Disambig'],
      ['felderKatalog', 'phase4Disambig'],
      ['ocr', 'phase4Disambig'],
      ['phase1Regex', 'phase5Merge'],
      ['phase4Disambig', 'phase5Merge'],
      ['phase5Merge', 'phase6BmfRechner'],
      ['phase6BmfRechner', 'phase7Validator'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog (citation-curated)',
        description: 'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen.',
        kind: 'elster-catalog',
        readBy: ['felderKatalog', 'phase1Regex', 'phase3LlmFill', 'phase4Disambig'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'a742aa348fea8b9f00f4a5f8',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
      {
        id: 'lane1:bmf:rechner:2024:v1',
        displayName: 'Lane-1 BMF Steuerrechner (MCP v1.27.0)',
        description:
          '199 Formeln + 309 Parameter + 163 Thresholds in PostgreSQL ' +
          '(`ctaxv1-postgres / ctax / lane1_bmf_calculator`). 40 MCP-Tools, ' +
          'eCode-nativer Input via `berechne_vollstaendige_steuer_v2`. ' +
          '§EStG-konform für Veranlagung 2024.',
        kind: 'bmf-calculator',
        readBy: ['phase6BmfRechner'],
        lockState: 'sealed',
      },
    ],
  });
}

/**
 * Builds the elster-v5_2-rag workflow — RAG-augmented variant of v5_2.
 *
 * Differs from v5_2 by inserting two stages between `felderKatalog` and
 * `phase3LlmFill`:
 *   • `quantumGround` — EmbeddingGemma + TurboQuant cascade against atoms.json
 *     to retrieve a per-document candidate-eCode shortlist.
 *   • `felderNarrow`  — combines the full felder catalog with the RAG hits
 *     into a narrowed per-Anlage felder map (Pflicht-Atome bleiben dabei
 *     pflichtgemäß erhalten).
 *
 * Downstream stages are unchanged — they consume the *narrowed* felder map
 * instead of the full one, which shrinks the prompt vocabulary and lifts
 * mapping accuracy on the relevant fields.
 *
 * Used by the `steuerfall-est` Application as the extraction trigger on
 * document upload.
 */
export function buildElsterV52RagWorkflow() {
  return defineWorkflow({
    id: 'elster-v5_2-rag',
    name: 'ELSTER v5.2-RAG — v5.2 + Retrieval-Augmented Felder-Narrow',
    description:
      'v5.2 erweitert um TurboQuant-Cascade-Retrieval: quantumGround zieht aus ' +
      'OCR-Text + Anlagen-Whitelist eine Kandidaten-eCode-Liste aus dem ELSTER-' +
      'Container; felderNarrow schneidet den Felder-Katalog auf die Vereinigung ' +
      'aus Pflicht-Atomen + RAG-Treffern zurück. Layer-1/2 + BMF + Validator + ' +
      'ERiC-XML laufen unverändert. Lebt unter der Anwendung `steuerfall-est`.',
    input: { type: 'file', accept: ['pdf', 'png', 'jpg', 'jpeg'], maxSizeMb: 50 },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: { filePath: '${input.filePath}', filename: '${input.filename}' },
      },
      klassifizierung: {
        uses: 'elster/klassifizierung',
        config: { llmFallbackWhen: 'zero' },
        inputs: { text: '${ocr.text}' },
      },
      felderKatalog: {
        uses: 'elster-v4/felder-katalog',
        config: {},
        inputs: { erkannte_anlagen: '${klassifizierung.erkannte_anlagen}' },
      },
      quantumGround: {
        uses: 'elster-v3/quantum-ground',
        // embed.cpuOnly is REQUIRED on h200v: gemma4-mm holds 99.5% of card 1's
        // VRAM, so Ollama embedding requests get stalled by 100+s under GPU
        // contention. cpuOnly forces num_gpu=0 → embeddinggemma runs on the
        // host's CPU (80 ms / batch of 30 phrasen, vs 107 s on contested GPU).
        config: { maxPhrasen: 30, proPhraseK: 10, finalK: 50, pflichtScaffold: true, embed: { cpuOnly: true } },
        inputs: {
          text: '${ocr.text}',
          anlagen: '${klassifizierung.erkannte_anlagen}',
        },
      },
      felderNarrow: {
        uses: 'elster-v5_2-rag/felder-narrow',
        // 2026-05-16: Test — minPerAnlage 30 → 250 (= effektiv kein Cap).
        // Historisch hatte elster-v4 mit `maxFelderProAnlage: 250` 56 eCodes
        // auf Stricker est_2023.pdf — heute v5_2-rag nur 39-40 wegen 30-Cap.
        // Mit ngram-speculative-decoding + optional-pflicht-schema sollte
        // die zusätzliche Felder-Last absorbierbar sein.
        config: { pflichtAlwaysKeep: true, passthroughOnEmptyRag: true, minPerAnlage: 250 },
        inputs: {
          felder_per_anlage: '${felderKatalog.per_anlage}',
          kandidatenECodes: '${quantumGround.kandidatenECodes}',
        },
      },
      phase1Regex: {
        uses: 'elster-v5/phase1-regex',
        config: { minDrucktextLength: 5 },
        inputs: { text: '${ocr.text}', per_anlage: '${felderNarrow.felder_per_anlage}' },
      },
      phase3LlmFill: {
        uses: 'elster-v5/phase3-llm-fill',
        config: {
          provider: 'vllm',
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 1500,
          // 2026-05-17: per-anlage outer-loop concurrency. Stricker has 7
          // anlagen; with anlageConcurrency=7 they all process in parallel.
          // Combined with sliceConcurrency=4 → up to 28 concurrent vLLM
          // requests, well within vLLM continuous-batching limits.
          anlageConcurrency: 7,
          stream: true,
          // 2026-05-16: timeout 90→180s, weil felderNarrow jetzt bis 250
          // Felder/Anlage durchlässt (Anlage N hat 134, KAP 81) und vLLM-
          // Decode bei einem einzelnen Call sonst über 90s rausläuft.
          perAnlageTimeoutMs: 180_000,
          typedSchema: true,
          // Sub-Slicing JETZT aktiv: mit felderNarrow.minPerAnlage=250 haben
          // große Anlagen (N=134, KAP=81) zu viele Felder für einen Call.
          // 25er-Slices + 4 parallel = jede Anlage in ~2-3s erledigt.
          maxFieldsPerSlice: 25,
          sliceConcurrency: 4,
        },
        inputs: {
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          felder_per_anlage: '${felderNarrow.felder_per_anlage}',
        },
      },
      phase4Disambig: {
        uses: 'elster-v5_1/phase4-entity-disambig',
        config: {
          provider: 'vllm',
          vllmUrl: 'http://localhost:11435',
          model: 'gemma4-mm',
          temperature: 0,
          confidenceThreshold: 0.7,
          topK: 5,
          concurrency: 5,
          perCallTimeoutMs: 20_000,
        },
        inputs: {
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase3LlmFill.per_anlage}',
          felder_per_anlage: '${felderNarrow.felder_per_anlage}',
        },
      },
      phase5Merge: {
        uses: 'elster-v5/phase5-merge',
        config: {},
        inputs: {
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase4Disambig.per_anlage}',
        },
      },
      phase6BmfRechner: {
        uses: 'elster-v5_2/bmf-rechner-compute',
        config: {
          veranlagungsjahr: 2024,
          timeoutMs: 15_000,
          failHard: false,
        },
        inputs: { canonical_layer: '${phase5Merge.canonical_layer}' },
      },
      phase7Validator: {
        uses: 'elster/validator',
        config: { skipUnsupported: true },
        inputs: { canonicalLayer: '${phase6BmfRechner.canonicalLayer}' },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['klassifizierung', 'felderKatalog'],
      ['klassifizierung', 'quantumGround'],
      ['ocr', 'quantumGround'],
      ['felderKatalog', 'felderNarrow'],
      ['quantumGround', 'felderNarrow'],
      ['felderNarrow', 'phase1Regex'],
      ['ocr', 'phase1Regex'],
      ['phase1Regex', 'phase3LlmFill'],
      ['felderNarrow', 'phase3LlmFill'],
      ['ocr', 'phase3LlmFill'],
      ['phase1Regex', 'phase4Disambig'],
      ['phase3LlmFill', 'phase4Disambig'],
      ['felderNarrow', 'phase4Disambig'],
      ['ocr', 'phase4Disambig'],
      ['phase1Regex', 'phase5Merge'],
      ['phase4Disambig', 'phase5Merge'],
      ['phase5Merge', 'phase6BmfRechner'],
      ['phase6BmfRechner', 'phase7Validator'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog (citation-curated)',
        description: 'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen.',
        kind: 'elster-catalog',
        readBy: ['felderKatalog', 'quantumGround', 'felderNarrow', 'phase1Regex', 'phase3LlmFill', 'phase4Disambig'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'a742aa348fea8b9f00f4a5f8',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
      {
        id: '0711:elster:gemma4-tq:embeddings:v1',
        displayName: 'EmbeddingGemma TurboQuant Cascade',
        description:
          '4-Tier cascade (d128/d256/d768 + fp32) über die 2287 BMF-Atome — ' +
          'gespeist von EmbeddingGemma-300m (MRL 768→512→256→128). Tier-0 ' +
          'pre-filter, Tier-3 exact rerank.',
        kind: 'embedding-index',
        readBy: ['quantumGround'],
        embeddingDim: 768,
        embeddingModel: 'embeddinggemma',
        lockState: 'sealed',
      },
      {
        id: 'lane1:bmf:rechner:2024:v1',
        displayName: 'Lane-1 BMF Steuerrechner (MCP v1.27.0)',
        description:
          '199 Formeln + 309 Parameter + 163 Thresholds in PostgreSQL ' +
          '(`ctaxv1-postgres / ctax / lane1_bmf_calculator`). 40 MCP-Tools, ' +
          'eCode-nativer Input via `berechne_vollstaendige_steuer_v2`. ' +
          '§EStG-konform für Veranlagung 2024.',
        kind: 'bmf-calculator',
        readBy: ['phase6BmfRechner'],
        lockState: 'sealed',
      },
    ],
  });
}

/**
 * elster-v6-vision — drop-in for v5_2-rag with phase3LlmFill replaced by
 * phase3VisionFill (gemma4-mm vision over rendered PDF pages).
 *
 * SAME 11 stages, SAME edges, SAME containers as v5_2-rag. Only stage 7 swaps:
 *   phase3LlmFill (text-only Gemma-4, ~52s, 28 calls, ~140k tokens)
 *        →  phase3VisionFill (vision Gemma-4, ~20-30s, 2-3 calls, ~3-5k tokens)
 *
 * phase3VisionFill is CONTRACT-IDENTICAL to phase3LlmFill (same Phase3LlmFillOutput
 * shape), so phases 4-7 (Disambig, Merge, BmfRechner, Validator) run unchanged.
 *
 * v6 spike measured on Stricker:
 *   - 6 pages × 44 fields in 31s wallclock (2 vLLM calls × ~10-27s each)
 *   - 42/44 non-NULL extraction; 24 fields v5.2-rag MISSED entirely
 *     (5 Entfernungspauschale inputs, 4 Vorsorge inputs, Person A/B KAP split)
 *   - WISO-456 placeholder correctly rejected (was poisoning v5.2-rag pre-fix)
 *   - 5 fields where v5.2-rag picked WRONG line (Lohnsteuer 0,00 vs real 6.720,00,
 *     Soli/KiSt swapped, Arbeitsmittel = WISO 456 vs real 103, KAP Person A's 109
 *     vs Person B's 8) — v6 got them all correct
 *
 * On vision call failure (timeout, parse error, all batches failed), phase3VisionFill
 * transparently falls back to phase3LlmFillStage — pipeline always completes.
 *
 * Activated for `steuerfall-est` via env `STURM_EXTRACTION_WORKFLOW=elster-v6-vision`.
 */
export function buildElsterV6VisionWorkflow() {
  return defineWorkflow({
    id: 'elster-v6-vision',
    name: 'ELSTER v6 — Vision-First Extraction (gemma4-mm)',
    description:
      'v5.2-rag mit phase3LlmFill ersetzt durch phase3VisionFill (gemma4-mm Vision). ' +
      'Alle anderen 10 Stages unverändert. Renderet PDF-Seiten via pdftoppm und sendet ' +
      'sie in 4-Seiten-Batches an vLLM gemma4-mm mit JSON-Schema-constrained Decoding. ' +
      'Fallback auf v5_2-rag phase3LlmFill bei Call-Fehler.',
    input: { type: 'file', accept: ['pdf', 'png', 'jpg', 'jpeg'], maxSizeMb: 50 },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: { filePath: '${input.filePath}', filename: '${input.filename}' },
      },
      klassifizierung: {
        uses: 'elster/klassifizierung',
        config: { llmFallbackWhen: 'zero' },
        inputs: { text: '${ocr.text}' },
      },
      felderKatalog: {
        uses: 'elster-v4/felder-katalog',
        config: {},
        inputs: { erkannte_anlagen: '${klassifizierung.erkannte_anlagen}' },
      },
      quantumGround: {
        uses: 'elster-v3/quantum-ground',
        config: { maxPhrasen: 30, proPhraseK: 10, finalK: 50, pflichtScaffold: true, embed: { cpuOnly: true } },
        inputs: { text: '${ocr.text}', anlagen: '${klassifizierung.erkannte_anlagen}' },
      },
      felderNarrow: {
        uses: 'elster-v5_2-rag/felder-narrow',
        config: { pflichtAlwaysKeep: true, passthroughOnEmptyRag: true, minPerAnlage: 250 },
        inputs: {
          felder_per_anlage: '${felderKatalog.per_anlage}',
          kandidatenECodes: '${quantumGround.kandidatenECodes}',
        },
      },
      phase1Regex: {
        uses: 'elster-v5/phase1-regex',
        config: { minDrucktextLength: 5 },
        inputs: { text: '${ocr.text}', per_anlage: '${felderNarrow.felder_per_anlage}' },
      },
      // THE ONLY CHANGE vs v5_2-rag
      phase3VisionFill: {
        uses: 'elster-v6/phase3-vision-fill',
        config: {
          // 2026-05-17 v3 tuning after Stricker retry:
          // Vision inference dominated wallclock (125s for 2 pages @ 200dpi).
          // Lower DPI → smaller image tokens → faster inference.
          // Also: missing-only field-map now keeps per-call payload small.
          pagesPerCall: 3,               // 6-page Stricker → 2 calls
          callConcurrency: 3,            // both batches parallel (+ headroom)
          rejectWisoPlaceholders: true,
          fallbackToV5: true,
          maxTokensPerCall: 3500,
          perCallTimeoutMs: 240_000,     // 240s — vision can be slow on dense forms
          renderDpi: 150,                // 200→150 cuts image-token count ~44%
          maxFieldsPerCall: 250,
          schemaName: 'elster_v6_extract',
        },
        inputs: {
          filePath: '${input.filePath}',
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          felder_per_anlage: '${felderNarrow.felder_per_anlage}',
        },
      },
      phase4Disambig: {
        uses: 'elster-v5_1/phase4-entity-disambig',
        config: {
          provider: 'vllm', vllmUrl: 'http://localhost:11435', model: 'gemma4-mm',
          temperature: 0, confidenceThreshold: 0.7, topK: 5, concurrency: 5, perCallTimeoutMs: 20_000,
        },
        inputs: {
          text: '${ocr.text}',
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase3VisionFill.per_anlage}',
          felder_per_anlage: '${felderNarrow.felder_per_anlage}',
        },
      },
      phase5Merge: {
        uses: 'elster-v5/phase5-merge',
        config: {},
        inputs: {
          phase1_per_anlage: '${phase1Regex.per_anlage}',
          phase3_per_anlage: '${phase4Disambig.per_anlage}',
        },
      },
      phase6BmfRechner: {
        uses: 'elster-v5_2/bmf-rechner-compute',
        config: { veranlagungsjahr: 2024, timeoutMs: 15_000, failHard: false },
        inputs: { canonical_layer: '${phase5Merge.canonical_layer}' },
      },
      phase7Validator: {
        uses: 'elster/validator',
        config: { skipUnsupported: true },
        inputs: { canonicalLayer: '${phase6BmfRechner.canonicalLayer}' },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['klassifizierung', 'felderKatalog'],
      ['klassifizierung', 'quantumGround'],
      ['ocr', 'quantumGround'],
      ['felderKatalog', 'felderNarrow'],
      ['quantumGround', 'felderNarrow'],
      ['felderNarrow', 'phase1Regex'],
      ['ocr', 'phase1Regex'],
      ['phase1Regex', 'phase3VisionFill'],
      ['felderNarrow', 'phase3VisionFill'],
      ['ocr', 'phase3VisionFill'],
      ['phase1Regex', 'phase4Disambig'],
      ['phase3VisionFill', 'phase4Disambig'],
      ['felderNarrow', 'phase4Disambig'],
      ['ocr', 'phase4Disambig'],
      ['phase1Regex', 'phase5Merge'],
      ['phase4Disambig', 'phase5Merge'],
      ['phase5Merge', 'phase6BmfRechner'],
      ['phase6BmfRechner', 'phase7Validator'],
    ],
  });
}

/**
 * Builds the elster-v5_2-rag-ensemble workflow — Variant of v5_2-rag where
 * Phase 3 runs as a 4-model ensemble (vLLM Gemma + Mistral-S + Mistral-L +
 * Claude Haiku). Voting per (anlage, eCode); ≥3 of 4 → ENSEMBLE_OK. Audit
 * trail stored as `_ensemble_audit` on the merged output.
 *
 * Cloud-API costs: each run hits 3 cloud LLMs in addition to local vLLM.
 * Use sparingly for high-stakes cases or for the recall-delta eval.
 */
export function buildElsterV52RagEnsembleWorkflow() {
  return defineWorkflow({
    id: 'elster-v5_2-rag-ensemble',
    name: 'ELSTER v5.2-RAG + 4-LLM-Ensemble',
    description:
      'v5_2-rag mit 4-Modell-Konsens in Phase 3 (vLLM Gemma + Mistral-S + ' +
      'Mistral-L + Claude Haiku parallel). Voting pro eCode, >=3 von 4 -> ' +
      'ENSEMBLE_OK. ENSEMBLE_TIE/DISAGREE im Audit. ~3x Latenz vs v5_2-rag, ' +
      'dafuer hoehere Robustheit. Cloud-API-Kosten beachten.',
    input: { type: 'file', accept: ['pdf', 'png', 'jpg', 'jpeg'], maxSizeMb: 50 },
    stages: {
      ocr: { uses: 'mistral-ocr', inputs: { filePath: '${input.filePath}', filename: '${input.filename}' } },
      klassifizierung: { uses: 'elster/klassifizierung', config: { llmFallbackWhen: 'zero' }, inputs: { text: '${ocr.text}' } },
      felderKatalog: { uses: 'elster-v4/felder-katalog', config: {}, inputs: { erkannte_anlagen: '${klassifizierung.erkannte_anlagen}' } },
      quantumGround: {
        uses: 'elster-v3/quantum-ground',
        // embed.cpuOnly: see comment in buildElsterV52RagWorkflow — GPU
        // contention from gemma4-mm stalls Ollama embed by 100+s on h200v.
        config: { maxPhrasen: 30, proPhraseK: 10, finalK: 50, pflichtScaffold: true, embed: { cpuOnly: true } },
        inputs: { text: '${ocr.text}', anlagen: '${klassifizierung.erkannte_anlagen}' },
      },
      felderNarrow: {
        uses: 'elster-v5_2-rag/felder-narrow',
        config: { pflichtAlwaysKeep: true, passthroughOnEmptyRag: true },
        inputs: { felder_per_anlage: '${felderKatalog.per_anlage}', kandidatenECodes: '${quantumGround.kandidatenECodes}' },
      },
      phase1Regex: {
        uses: 'elster-v5/phase1-regex',
        config: { minDrucktextLength: 5 },
        inputs: { text: '${ocr.text}', per_anlage: '${felderNarrow.felder_per_anlage}' },
      },
      phase3Vllm: {
        uses: 'elster-v5/phase3-llm-fill',
        config: { provider: 'vllm', model: 'gemma4-mm', temperature: 0, maxTokens: 2000, anlageConcurrency: 7, perAnlageTimeoutMs: 60_000, typedSchema: true },
        inputs: { text: '${ocr.text}', phase1_per_anlage: '${phase1Regex.per_anlage}', felder_per_anlage: '${felderNarrow.felder_per_anlage}' },
      },
      phase3MistralS: {
        uses: 'elster-v5/phase3-llm-fill',
        config: { provider: 'mistral', model: 'mistral-small-latest', temperature: 0, maxTokens: 2000, anlageConcurrency: 7, perAnlageTimeoutMs: 60_000 },
        inputs: { text: '${ocr.text}', phase1_per_anlage: '${phase1Regex.per_anlage}', felder_per_anlage: '${felderNarrow.felder_per_anlage}' },
      },
      phase3MistralL: {
        uses: 'elster-v5/phase3-llm-fill',
        config: { provider: 'mistral', model: 'mistral-large-latest', temperature: 0, maxTokens: 2000, anlageConcurrency: 7, perAnlageTimeoutMs: 60_000 },
        inputs: { text: '${ocr.text}', phase1_per_anlage: '${phase1Regex.per_anlage}', felder_per_anlage: '${felderNarrow.felder_per_anlage}' },
      },
      phase3Claude: {
        uses: 'elster-v5/phase3-llm-fill',
        config: { provider: 'anthropic', model: 'claude-haiku-4-5', temperature: 0, maxTokens: 2000, anlageConcurrency: 7, perAnlageTimeoutMs: 60_000 },
        inputs: { text: '${ocr.text}', phase1_per_anlage: '${phase1Regex.per_anlage}', felder_per_anlage: '${felderNarrow.felder_per_anlage}' },
      },
      phase3Ensemble: {
        uses: 'elster-v5_2-rag-ensemble/phase3-ensemble-merge',
        config: { minAgreement: 3 },
        inputs: {
          vllm: '${phase3Vllm}',
          mistral_small: '${phase3MistralS}',
          mistral_large: '${phase3MistralL}',
          claude_haiku: '${phase3Claude}',
        },
      },
      phase4Disambig: {
        uses: 'elster-v5_1/phase4-entity-disambig',
        config: { provider: 'vllm', vllmUrl: 'http://localhost:11435', model: 'gemma4-mm', temperature: 0, confidenceThreshold: 0.7, topK: 5, concurrency: 5, perCallTimeoutMs: 20_000 },
        inputs: { text: '${ocr.text}', phase1_per_anlage: '${phase1Regex.per_anlage}', phase3_per_anlage: '${phase3Ensemble.per_anlage}', felder_per_anlage: '${felderNarrow.felder_per_anlage}' },
      },
      phase5Merge: {
        uses: 'elster-v5/phase5-merge',
        config: {},
        inputs: { phase1_per_anlage: '${phase1Regex.per_anlage}', phase3_per_anlage: '${phase4Disambig.per_anlage}' },
      },
      phase6BmfRechner: {
        uses: 'elster-v5_2/bmf-rechner-compute',
        config: { veranlagungsjahr: 2024, timeoutMs: 15_000, failHard: false },
        inputs: { canonical_layer: '${phase5Merge.canonical_layer}' },
      },
      phase7Validator: {
        uses: 'elster/validator',
        config: { skipUnsupported: true },
        inputs: { canonicalLayer: '${phase6BmfRechner.canonicalLayer}' },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['klassifizierung', 'felderKatalog'],
      ['klassifizierung', 'quantumGround'],
      ['ocr', 'quantumGround'],
      ['felderKatalog', 'felderNarrow'],
      ['quantumGround', 'felderNarrow'],
      ['felderNarrow', 'phase1Regex'],
      ['ocr', 'phase1Regex'],
      ['phase1Regex', 'phase3Vllm'], ['felderNarrow', 'phase3Vllm'], ['ocr', 'phase3Vllm'],
      ['phase1Regex', 'phase3MistralS'], ['felderNarrow', 'phase3MistralS'], ['ocr', 'phase3MistralS'],
      ['phase1Regex', 'phase3MistralL'], ['felderNarrow', 'phase3MistralL'], ['ocr', 'phase3MistralL'],
      ['phase1Regex', 'phase3Claude'], ['felderNarrow', 'phase3Claude'], ['ocr', 'phase3Claude'],
      ['phase3Vllm', 'phase3Ensemble'],
      ['phase3MistralS', 'phase3Ensemble'],
      ['phase3MistralL', 'phase3Ensemble'],
      ['phase3Claude', 'phase3Ensemble'],
      ['phase1Regex', 'phase4Disambig'],
      ['phase3Ensemble', 'phase4Disambig'],
      ['felderNarrow', 'phase4Disambig'],
      ['ocr', 'phase4Disambig'],
      ['phase1Regex', 'phase5Merge'],
      ['phase4Disambig', 'phase5Merge'],
      ['phase5Merge', 'phase6BmfRechner'],
      ['phase6BmfRechner', 'phase7Validator'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog (citation-curated)',
        description: 'BMF Jahresdokumentation 10/2024 - 2287 eCodes, 35 Anlagen.',
        kind: 'elster-catalog',
        readBy: ['felderKatalog', 'quantumGround', 'felderNarrow', 'phase1Regex', 'phase3Vllm', 'phase3MistralS', 'phase3MistralL', 'phase3Claude', 'phase4Disambig'],
        lockState: 'sealed',
      },
      {
        id: 'lane1:bmf:rechner:2024:v1',
        displayName: 'Lane-1 BMF Steuerrechner (MCP v1.27.0)',
        description: '199 Formeln, 309 Parameter, 163 Thresholds.',
        kind: 'bmf-calculator',
        readBy: ['phase6BmfRechner'],
        lockState: 'sealed',
      },
    ],
  });
}
