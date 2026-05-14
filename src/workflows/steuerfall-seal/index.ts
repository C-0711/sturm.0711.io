/**
 * Workflow `steuerfall-seal` — versiegelt einen Fall.
 *
 * Input (type: json):
 *   { appId, caseId, mandantId?, displayName?, veranlagungsjahr?,
 *     runId, workspacePath?, canonical_layer, eric_xml?, validator_result? }
 *
 * Wird von POST /api/applications/:appId/instances/:caseId/seal getriggert.
 * Die Route liest die Instance + den letzten extraction-Run und reicht den
 * canonical_layer + eric_xml direkt rein — der Workflow ist deshalb pure
 * Transformation (kein Datei-Crawling), gut testbar, gut SSE-streambar.
 */
import { defineWorkflow } from '../../core/workflow.ts';
import { registerStage } from '../../core/registry.ts';
import { collectSnapshotStage } from '../../stages/seal/collect-snapshot.ts';
import { computeMerkleStage } from '../../stages/seal/compute-merkle.ts';
import { signMasterStage } from '../../stages/seal/sign-master.ts';
import { commitAndAnchorStage } from '../../stages/seal/commit-and-anchor.ts';

export function registerSealStages(): void {
  registerStage(collectSnapshotStage);
  registerStage(computeMerkleStage);
  registerStage(signMasterStage);
  registerStage(commitAndAnchorStage);
}

export function buildSteuerfallSealWorkflow() {
  return defineWorkflow({
    id: 'steuerfall-seal',
    name: 'Steuerfall · Versiegelung',
    description:
      'HMAC-signiertes master.json + sha256-Merkle über canonical_layer + ' +
      'Anchor-Record. Kein on-chain-Emit in v1 (DB/file-Stub).',
    input: { type: 'json' },
    stages: {
      snapshot: {
        uses: 'seal/collect-snapshot',
        inputs: {
          appId: '${input.appId}',
          caseId: '${input.caseId}',
          mandantId: '${input.mandantId}',
          displayName: '${input.displayName}',
          veranlagungsjahr: '${input.veranlagungsjahr}',
          runId: '${input.runId}',
          workspacePath: '${input.workspacePath}',
          canonical_layer: '${input.canonical_layer}',
          eric_xml: '${input.eric_xml}',
          validator_result: '${input.validator_result}',
        },
      },
      merkle: {
        uses: 'seal/compute-merkle',
        inputs: { master: '${snapshot.master}' },
      },
      sign: {
        uses: 'seal/sign-master',
        inputs: { master: '${merkle.master}' },
      },
      anchor: {
        uses: 'seal/commit-and-anchor',
        config: { tag: 'seal-v1', network: 'base-mainnet' },
        inputs: {
          master: '${sign.master}',
          workspacePath: '${input.workspacePath}',
        },
      },
    },
    edges: [
      ['snapshot', 'merkle'],
      ['merkle', 'sign'],
      ['sign', 'anchor'],
    ],
  });
}
