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
      ocr: {
        uses: 'mistral-ocr',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
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
      layer1: {
        uses: 'elster-v3/layer1-extract',
        config: {
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 2000,
        },
        inputs: {
          text: '${ocr.text}',
          docClass: '${klassifizierung.typ_id}',
        },
      },
      layer2: {
        uses: 'elster-v3/layer2-resolve',
        config: {
          chatProvider: 'vllm',
          chatModel: 'gemma4-mm',
        },
        inputs: {
          nested: '${layer1.nested}',
          docClass: '${klassifizierung.typ_id}',
        },
      },
      rules: {
        uses: 'elster/deterministic-rules',
        config: {},
        inputs: {
          nested: '${layer2.nested}',
          docClass: '${klassifizierung.typ_id}',
        },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['klassifizierung', 'layer1'],
      ['layer1', 'layer2'],
      ['layer2', 'rules'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog',
        description: 'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen, bge-m3 1024-dim embeddings.',
        readBy: ['layer1', 'layer2', 'rules'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        embeddingDim: 1024,
        embeddingModel: 'bge-m3',
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'de938e468a7d85488906bf88af067160edeb08dc52d4399e2416df6760652bcc',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
    ],
  });
}
