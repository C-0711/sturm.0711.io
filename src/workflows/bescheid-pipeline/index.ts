import { defineWorkflow } from '../../core/workflow.ts';
import { registerStage } from '../../core/registry.ts';
import { bescheidAggregateStage } from '../../stages/bescheid-aggregate.ts';
import { lane1BmfComputeStage } from '../../stages/lane1-bmf-compute.ts';
import { bescheidRenderStage } from '../../stages/bescheid-render.ts';

/**
 * Registriert die bescheid-pipeline-Stages. Wird einmal beim Engine-Start gerufen.
 */
export function registerBescheidStages(): void {
  registerStage(bescheidAggregateStage);
  registerStage(lane1BmfComputeStage);
  registerStage(bescheidRenderStage);
}

/**
 * Bescheid-Pipeline — Single-Arm Polar→Lane-1→ESt-Bescheid in ms.
 *
 * Input (JSON):
 *   { "mandant": "haubrich-koch-hildburg-2024", "year": 2024 }
 *
 * Voraussetzungen:
 *   - /app/workspaces/<mandant>/canonical-layer.json (Polar Tier-1+2 Cache)
 *   - /app/workspaces/<mandant>/meta/*.json         (Mandanten OCR+klassifiziert)
 *   - /app/profiles/<mandant>.json                  (Stammdaten + §-Trigger)
 *
 * Stages:
 *   aggregate → lane1 → render
 */
export function buildBescheidPipelineWorkflow() {
  return defineWorkflow({
    id: 'bescheid-pipeline',
    name: 'Bescheid-Pipeline (Polar → Lane-1)',
    description:
      'Aggregiert Polar canonical_layer + Mandanten elsterExtract + Profil-Stammdaten → ' +
      'Lane-1 BMF-Calculator MCP → vollständige Steuerbescheid-Vorschau (Markdown + JSON).',
    input: {
      type: 'json',
    },
    stages: {
      aggregate: {
        uses: 'bescheid-aggregate',
        name: 'eCode-Aggregation',
        description: 'Merge Polar + Mandanten + Profil mit numeric-filter',
        inputs: {
          mandant: '${input.mandant}',
          year: '${input.year}',
          profileMandant: '${input.profileMandant}',
        },
      },
      lane1: {
        uses: 'lane1-bmf-compute',
        name: 'Lane-1 BMF-Compute',
        description: 'MCP berechne_vollstaendige_steuer_v2',
        inputs: {
          elsterFelder: '${aggregate.elsterFelder}',
          erklaerungsjahr: '${input.year}',
        },
      },
      render: {
        uses: 'bescheid-render',
        name: 'Bescheid-Render',
        description: 'Markdown + strukturierte Zusammenfassung',
        inputs: {
          mandant: '${input.mandant}',
          year: '${input.year}',
          daten: '${lane1.daten}',
          audit: '${aggregate.audit}',
          ecodes_sent: '${lane1.ecodes_sent}',
          lane1_ms: '${lane1.ms}',
          ok: '${lane1.ok}',
          error: '${lane1.error}',
        },
      },
    },
    edges: [
      ['aggregate', 'lane1'],
      ['lane1', 'render'],
    ],
  });
}
