/**
 * seal/collect-snapshot — baut das master.json-Snapshot aus dem
 * Workflow-Input zusammen. Die Endpoint-Route liest die Instance + den
 * letzten Run und reicht alles als Workflow-Input rein; diese Stage
 * normalisiert die Felder und ergänzt deterministische Metadaten.
 */
import { defineStage } from '../../core/stage.ts';

export interface CollectSnapshotInput {
  appId: string;
  caseId: string;
  mandantId?: string;
  displayName?: string;
  veranlagungsjahr?: number;
  runId: string;
  workspacePath?: string;
  canonical_layer: Record<string, unknown>;
  eric_xml?: string;
  validator_result?: unknown;
}

export interface MasterSnapshot {
  schemaVersion: 1;
  appId: string;
  caseId: string;
  mandantId: string;
  displayName: string;
  veranlagungsjahr: number | null;
  basedOnRunId: string;
  generatedAt: string;
  canonical_layer: Record<string, unknown>;
  eric_xml: string;
  validator_result: unknown;
}

export interface CollectSnapshotOutput {
  master: MasterSnapshot;
  stats: { eCodes: number; ericXmlLen: number };
}

export const collectSnapshotStage = defineStage<
  CollectSnapshotInput,
  CollectSnapshotOutput,
  Record<string, never>
>({
  id: 'seal/collect-snapshot',
  name: 'Seal · Collect Snapshot',
  description:
    'Baut master.json (schemaVersion 1) aus den Bestandteilen eines beendeten ' +
    'extraction-Runs zusammen: canonical_layer + eric_xml + validator_result + ' +
    'Fall-Metadaten. Deterministisch (sortierte Schlüssel).',
  hints: {
    inputs: 'canonical_layer, eric_xml, validator_result, appId/caseId/runId',
    outputs: 'master (signed-ready snapshot), stats',
  },
  async run(input, ctx) {
    if (!input || !input.canonical_layer || typeof input.canonical_layer !== 'object') {
      throw new Error('seal/collect-snapshot: input.canonical_layer required');
    }
    const master: MasterSnapshot = {
      schemaVersion: 1,
      appId: input.appId,
      caseId: input.caseId,
      mandantId: input.mandantId ?? '',
      displayName: input.displayName ?? '',
      veranlagungsjahr: input.veranlagungsjahr ?? null,
      basedOnRunId: input.runId,
      generatedAt: new Date().toISOString(),
      canonical_layer: input.canonical_layer,
      eric_xml: input.eric_xml ?? '',
      validator_result: input.validator_result ?? null,
    };
    const eCodes = Object.keys(master.canonical_layer).length;
    await ctx.artifacts.write('master.snapshot.json', master);
    ctx.emit('snapshot_collected', { eCodes, basedOnRunId: master.basedOnRunId });
    return { master, stats: { eCodes, ericXmlLen: master.eric_xml.length } };
  },
});
