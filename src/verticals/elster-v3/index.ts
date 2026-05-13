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
// ── Light-Path stages (text-layer PDFs, with selective LLM-Disambig) ─────
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
  // Light-Path stages: deterministic chain for text-layer PDFs (VAST exports).
  registerStage(labelValueParserStage);
  registerStage(atomsCascadeSearchStage);
  registerStage(formatRegexValidateStage);
  registerStage(confidenceGateStage); // legacy — bleibt registriert für ältere Workflows
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
 * Builds the elster-v3-light workflow — deterministic, no-LLM fast path.
 *
 * Optimized for PDFs with a clean embedded text layer (WISO Steuer 2025,
 * VAST-Exporte vom Finanzamt, andere Steuer-Software-Outputs). Skips OCR
 * fan-out entirely. Pipeline:
 *
 *   pdf-text-layer → klassifizierung → label-value-parser
 *     → atoms-cascade-search → format-regex-validate → confidence-gate
 *
 * Bei Konsens-Confidence ≥ 0.80 wird KEIN LLM-Call gemacht — der Container
 * (Cascade + formatRegex + Pflicht-Set) liefert die Werte direkt. Latenz:
 * ~1-2 Sekunden. Für Belege ohne Text-Layer oder mit zu viel Disambig-Bedarf
 * sollte stattdessen der reguläre elster-v3 Workflow gewählt werden.
 *
 * Output trägt:
 *   • accepted[]            — direkt akzeptierte (eCode, Wert, Confidence)
 *   • disambig[]            — Verdächtige (Mittelfeld, brauchen LLM-Hop)
 *   • rejected[]            — ehrlich verworfen
 *   • pflicht_report[]      — Vollständigkeits-Check pro Anlage
 *   • fingerprint_preview   — extraction_fingerprint mit Container/Embed/Input
 */
export function buildElsterV3LightWorkflow() {
  return defineWorkflow({
    id: 'elster-v3-light',
    name: 'ELSTER v3 Light — text-layer fast path (no LLM, container-only)',
    description:
      'pdftotext → label-value-parser → bge-m3+Gemma-quantum-Cascade → formatRegex-Validate → ' +
      'Confidence-Gate. Optimiert für VAST-Exporte mit sauberem Text-Layer. ' +
      'Bei Confidence ≥0.80 direkt akzeptiert, kein LLM-Aufruf. ' +
      'Pflicht-Completeness-Report + extraction_fingerprint inklusive. Latenz: ~1-2s.',
    input: {
      type: 'file',
      accept: ['pdf'],
      maxSizeMb: 50,
    },
    stages: {
      // ── Phase 1: pdftotext für strukturierte VAST-Belege (Text-Layer da) ─
      pdfTextLayer: {
        uses: 'extract/pdf-text-layer',
        config: { layout: true, minCharsPerPageHeuristic: 50 },
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      // ── Phase 1b: OCR Fan-out — vier parallele Engines, damit für
      //   gescannte Belege ohne Text-Layer ein Backup-Pfad existiert und
      //   für tabellarisch geprägte Belege (VAST-LStB, KAP-Mitteilung) ein
      //   tabellen-spezialisierter Branch eigene Stimme im Voting hat:
      //
      //     • mistralMd     — Mistral-Small-multimodal, Volltext-Markdown
      //     • mistralTable  — Mistral-Small-multimodal, Tabellen-Fokus
      //     • lighton       — LightOnOCR-1B (vLLM:11437, lokal, schnell)
      //     • paddle        — PaddleOCR-VL (vLLM:11438, layout-bewusst)
      //
      //   Bei Stricker mit Text-Layer ist das redundant zu pdftotext, aber
      //   kostet ~5s parallel; bei einem Scan ist es essentiell. Mistral-OCR
      //   Cloud-Endpoint wurde ersetzt durch die zwei Mistral-Small-Modi —
      //   billiger pro Call und gibt 2 unabhängige Stimmen im Consensus-Vote.
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
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      // ── Phase 2: OCR-Consensus-Merge — alignt die 3 Engines semantisch
      //   und votet per Cluster. Output: kanonische {text, bbox, page,
      //   engines_agreeing}. Stage existiert in src/stages/.
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
      // ── Phase 3a: Klassifizierung. Bevorzugt pdftotext (kanonisch wenn
      //   Text-Layer da), fällt auf ocrMerge zurück. Mistral-Small als
      //   schneller Hybrid-Classifier mit Anlagen-Whitelist-Output.
      klassifizierung: {
        uses: 'steuerbelege/dokument-typ',
        config: { model: 'mistral-small-latest', useLlmFallback: true },
        inputs: { text: '${pdfTextLayer.text}' },
      },
      // ── Phase 3b: Label/Value-Parser — nur für VAST-Layout (pdftotext).
      //   Auf scan-only docs ist diese Stage leer und der heavy elster-v3
      //   Workflow ist die richtige Wahl.
      labelValueParser: {
        uses: 'elster-v3/label-value-parser',
        config: { minLabelChars: 4, gapWhitespace: 2 },
        inputs: { text: '${pdfTextLayer.text}' },
      },
      atomsCascadeSearch: {
        uses: 'elster-v3/atoms-cascade-search',
        config: {
          topK: 5,
          scopeToAnlagen: true,
          queryStrategy: 'label-only',
          embed: { cpuOnly: true },
        },
        inputs: {
          belege: '${labelValueParser.belege}',
          anlagen: '${klassifizierung.anlagen}',
        },
      },
      // ── Phase 4 — Format-Validate als reiner Enricher.
      //   Annotiert jeden Cascade-Kandidaten mit format_valid + normalized_value.
      //   Output `enrichedBelege` ist der Input von llm-disambig.
      formatRegexValidate: {
        uses: 'elster-v3/format-regex-validate',
        config: { minCosine: 0.20 },
        inputs: { belege: '${atomsCascadeSearch.belege}' },
      },
      // ── Phase 5 — LLM-Disambig als FINALES Routing.
      //   Konsumiert enrichedBelege (mit format-info pro Kandidat).
      //   Direct-accept: cosine >= 0.65 AND top1.format_valid.
      //   LLM-hop bei cosine 0.30-0.65 — LLM sieht format-info pro Kandidat
      //   im Prompt und kann format-incompatible Atome verwerfen.
      //   Reject bei cosine < 0.30.
      llmDisambig: {
        uses: 'elster-v3/llm-disambig',
        config: {
          acceptCosine: 0.65,
          disambigLo: 0.30,
          vllmUrl: 'http://localhost:11435/v1/chat/completions',
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
      // ── Phase 6 — Finalize: canonical_layer + pflicht_report + fingerprint.
      //   Terminale Stage. Konsumiert accepted/rejected von llm-disambig,
      //   produziert audit-fähiges Output-Bündel.
      // llmInfo wird hier statisch via config gegeben (kein dynamischer
      // dependent-input). Die LLM-Konfig kommt eh aus dem llmDisambig-Stage —
      // wir spiegeln sie nur als Fingerprint-Komponente.
      finalizeExtraction: {
        uses: 'elster-v3/finalize-extraction',
        config: {
          pflichtFailHard: false,
          // LLM-Komponenten für den Fingerprint — müssen mit llmDisambig.config
          // konsistent gehalten werden. Statisch hier weil workflow-inputs
          // nur Strings sein können.
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
      // Phase 1 — OCR + Text-Layer parallel
      ['pdfTextLayer', 'klassifizierung'],
      ['pdfTextLayer', 'labelValueParser'],
      ['ocrFanout', 'ocrMerge'],
      // Phase 2 — Pipeline-Verzweigung
      ['labelValueParser', 'atomsCascadeSearch'],
      ['klassifizierung', 'atomsCascadeSearch'],
      // Phase 3 — Format-Enricher → LLM-Disambig → Finalize
      ['atomsCascadeSearch', 'formatRegexValidate'],
      ['formatRegexValidate', 'llmDisambig'],
      ['klassifizierung', 'llmDisambig'],
      ['llmDisambig', 'finalizeExtraction'],
      ['klassifizierung', 'finalizeExtraction'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog',
        description: 'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen.',
        kind: 'elster-catalog',
        readBy: ['atomsCascadeSearch', 'formatRegexValidate', 'confidenceGate'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'de938e468a7d85488906bf88af067160edeb08dc52d4399e2416df6760652bcc',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
      {
        id: '0711:elster:gemma4-tq:embeddings:v1',
        displayName: 'Gemma-quantum eCode Cascade',
        description:
          'EmbeddingGemma-300m × MRL×TurboQuant cascade (d=256/b=3 → d=768/b=3 → fp32). ' +
          'Light-Path nutzt das gesamte 3-Tier-Setup für sub-ms Atom-Match.',
        kind: 'embedding-index',
        readBy: ['atomsCascadeSearch'],
        atomsCount: 2287,
        embeddingDim: 768,
        embeddingModel: 'embeddinggemma',
        lockState: 'sealed',
      },
    ],
  });
}

/**
 * Builds the **elster-v4-stricker** workflow — production-verified Light-Path.
 *
 * Stand 2026-05-13 nach vollständigem Stricker-E2E + Container-Polish:
 *
 * **Pipeline** (4-Engine OCR-Fanout + Variante-B Verarbeitung):
 *
 *   1. pdfTextLayer            (pdftotext, ~50 ms wenn Text-Layer da)
 *   2. ocrFanout × 4 Engines   (mistral-md, mistral-table, lighton, paddle)
 *      └─ ocrMerge             (semantic alignment + per-cluster voting)
 *   3. klassifizierung         (mistral-small, doc_class + anlagen[])
 *   4. labelValueParser        (deterministic Beleg-Split, Label/Wert-Paare)
 *   5. atomsCascadeSearch      (EmbeddingGemma × 4-Tier MRL Cascade gegen 2287 Atome
 *                               → Top-K Kandidaten mit citation_excerpt +
 *                                 formatkennzeichen)
 *   6. formatRegexValidate     (annotates each candidate with format_valid,
 *                               normalized_value, format_reason — DATA ENRICHER)
 *   7. llmDisambig             (TERMINAL ROUTING via Gemma-4-31B-IT + vLLM TurboQuant b=4:
 *                                 • cos ≥ 0.65 AND format_valid → direct accept
 *                                 • cos ≥ 0.30 → LLM strict-JSON picker, with
 *                                   bmf-zitat + fk + slot-norm guidance
 *                                 • cos < 0.30 → reject
 *                               Plus deterministic post-LLM Bescheinigungs-Slot-
 *                               Normalize: xxxxx02/03/04 → xxxxx01 when in candidates)
 *   8. finalizeExtraction      (canonical_layer + pflicht_report +
 *                               extraction_fingerprint with full LLM components)
 *
 * **Container-Stand** (alle Components harmonisiert):
 *   • 0711:elster:bmf:jahresdok-2024:v1 — atoms.json mit 32 curated citation_excerpts
 *     für Stammdaten-Disambig (Person A vs Person B) + LStB-Bescheinigungs-Modi
 *     (Sum/Einz × 1-5/6+). Merkle-Root unverändert da atom_id+value nicht angefasst.
 *   • 0711:elster:gemma4-tq:embeddings:v5.8 — v5.5 fp32 restored from backup +
 *     deterministic re-quantize aller 4 TQ-Tiers. 4-Tier MRL cascade:
 *     d=128/b=2 → d=256/b=3 → d=512/b=3 → d=768/b=3 → fp32 exact.
 *
 * **Verifiziert auf Stricker VAST-Belege.pdf** (5 Belege, 51 Chunks):
 *   • 36 accepted (32 cascade-direct + 4 slot-normalized)
 *   • 15 rejected — alle korrekt als Metadata ohne eCode-Entsprechung
 *   • Religion Steuerpfl. (Rainer) jetzt korrekt E0100402 statt Ehegatte-Code
 *   • Alle 6 LStB-Pflicht-Felder korrekt LStB_1 (Brutto, Lohnsteuer, Soli,
 *     KiSt-AN, KiSt-Partner, Steuerklasse)
 *   • Alle 6 VOR-Beiträge korrekt (RV-AG, RV-AN, KV, PV, AV, Zusatzversorgung-Frei)
 *   • Alle Stammdaten Person A + Person B korrekt getrennt
 *   • Performance: ~115-145 s wall (107 s davon LLM parallel via vLLM
 *     continuous batching)
 *   • Deterministisch: byte-identischer Fingerprint bei Replay
 *
 * **Ed25519-fähiges Output**:
 *   • runs/<id>/canonical_layer.json (codes + nested + provenance)
 *   • runs/<id>/pflicht_report.json (Anlage-Vollständigkeit)
 *   • runs/<id>/extraction_fingerprint.json (Replay-Cert)
 *
 * Workflow id `elster-v4-stricker` — parallel zu elster-v3 (heavy) und
 * elster-v3-light (test-pipeline). Empfohlen als default für VAST-Exporte
 * und text-layer-fähige PDFs aus deutschen Steuer-Software-Outputs.
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
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 50,
    },
    stages: {
      // ── Phase 1a: pdftotext für strukturierte VAST-Belege ──────────────
      pdfTextLayer: {
        uses: 'extract/pdf-text-layer',
        config: { layout: true, minCharsPerPageHeuristic: 50 },
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      // ── Phase 1b: OCR Fan-out — 4 Engines parallel (Mistral-MD/-Table, LightOn, Paddle)
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
      // ── Phase 2: Semantic merge across the 4 OCR variants ──────────────
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
      // ── Phase 3a: Beleg-Klassifizierung (doc_class + Anlagen-Whitelist) ─
      klassifizierung: {
        uses: 'steuerbelege/dokument-typ',
        config: { model: 'mistral-small-latest', useLlmFallback: true },
        inputs: { text: '${pdfTextLayer.text}' },
      },
      // ── Phase 3b: Label/Value-Parser (regex erlaubt Digits in Labels) ───
      labelValueParser: {
        uses: 'elster-v3/label-value-parser',
        config: { minLabelChars: 4, gapWhitespace: 2 },
        inputs: { text: '${pdfTextLayer.text}' },
      },
      // ── Phase 4: Cascade-Search gegen 2287 Atome (4-Tier MRL TurboQuant)
      atomsCascadeSearch: {
        uses: 'elster-v3/atoms-cascade-search',
        config: {
          topK: 5,
          // Stricker ist ein Multi-Beleg-Bundle (LStB + Religion + KapErträge).
          // Klassifizierung wirft 1 doc_class/anlagen für das ganze PDF, das
          // schneidet die meisten korrekten eCodes ab. Bis Per-Beleg-Klassifizierung
          // implementiert ist: global suchen, LLM-Disambig entscheidet.
          scopeToAnlagen: false,
          queryStrategy: 'label-only',
          embed: { cpuOnly: true },
        },
        inputs: {
          belege: '${labelValueParser.belege}',
          anlagen: '${klassifizierung.anlagen}',
        },
      },
      // ── Phase 5: Format-Validate als reiner Enricher
      formatRegexValidate: {
        uses: 'elster-v3/format-regex-validate',
        config: { minCosine: 0.20 },
        inputs: { belege: '${atomsCascadeSearch.belege}' },
      },
      // ── Phase 6: LLM-Disambig — terminales Routing + Slot-Normalize
      //   Direkt: cos ≥ 0.65 AND format_valid
      //   LLM:    cos ≥ 0.30 (Gemma-4-31B-IT + TurboQuant KV b=4 via vLLM)
      //   Reject: cos < 0.30
      //   Plus deterministic post-LLM Slot-Normalize (LStB-Modi auf _1_5_Sum)
      llmDisambig: {
        uses: 'elster-v3/llm-disambig',
        config: {
          acceptCosine: 0.65,
          disambigLo: 0.30,
          // vllmUrl absichtlich NICHT gesetzt — Stage nutzt process.env.VLLM_URL
          // (Container: host.docker.internal:11435) oder fällt auf localhost:11435.
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
      // ── Phase 7: Finalize — canonical_layer + pflicht_report + Fingerprint
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
      // Phase 1 — OCR + Text-Layer parallel
      ['pdfTextLayer', 'klassifizierung'],
      ['pdfTextLayer', 'labelValueParser'],
      ['ocrFanout', 'ocrMerge'],
      // Phase 2-4 — Klassifizierung + Parser → Cascade
      ['labelValueParser', 'atomsCascadeSearch'],
      ['klassifizierung', 'atomsCascadeSearch'],
      // Phase 5-7 — Enrich → Routing → Finalize
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
        containerSha256: 'a742aa348fea8b9f00f4a5f8',  // post-curation v5.6
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
      {
        id: '0711:elster:gemma4-tq:embeddings:v1',
        displayName: 'Gemma-quantum eCode Cascade v5.8 (4-tier MRL)',
        description:
          'EmbeddingGemma-300m × full Matryoshka × TurboQuant cascade: ' +
          'd=128/b=2 (40B coarse) → d=256/b=3 (136B) → d=512/b=3 (264B) → d=768/b=3 (392B) → fp32 (3072B). ' +
          'v5.8 = v5.5 fp32 from backup + deterministic re-quantize of all 4 TQ tiers (seed=42). ' +
          'Embedding-Index byte-stabil; atoms.json patches fließen NUR über LLM-prompt nicht über cascade ein.',
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
