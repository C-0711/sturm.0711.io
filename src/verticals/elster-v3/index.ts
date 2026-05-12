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
