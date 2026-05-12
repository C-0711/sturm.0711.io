import { defineWorkflow } from '../../core/workflow.ts';

/**
 * ocr-shootout — A/B benchmark workflow: fans out the same document to all
 * available OCR engines in parallel and emits a KPI report so a human can
 * decide which engine to wire into the production pipeline.
 *
 * Engines (each as a branch of compare/fanout):
 *   - extract/pdf-text-layer  (local, no LLM — for PDFs with text layer)
 *   - mistral-ocr             (cloud, today's production engine)
 *   - lighton-ocr             (local vLLM on H200V:11437)
 *   - paddleocr-vl            (local HTTP on H200V:11438)
 *
 * The KPI node references the fanout stage so cross-branch agreement is
 * computed across the engines, surfacing the *disputed* fields as
 * `kpi_report.json -> cross_branch.disputed_keys`. That list IS the work
 * the human reviewer needs to look at — every other field, the engines
 * already agreed on.
 */
export function buildOcrShootoutWorkflow() {
  return defineWorkflow({
    id: 'ocr-shootout',
    name: 'OCR Shootout (A/B-Benchmark)',
    description:
      'Fans out one document through all OCR engines in parallel, emits a KPI ' +
      'report with per-branch timing, field counts, format conformance, and ' +
      'cross-engine agreement. Use to decide which OCR engine to wire into ' +
      'production for a given document class.',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 50,
    },
    stages: {
      ocr_fanout: {
        uses: 'compare/fanout',
        name: 'OCR-Engines parallel',
        config: {
          continueOnError: true,
          branches: {
            text_layer: {
              uses: 'extract/pdf-text-layer',
              config: { layout: true },
            },
            mistral: {
              uses: 'mistral-ocr',
              config: {},
            },
            lighton: {
              uses: 'lighton-ocr',
              config: {
                // Defaults to http://localhost:11437 — change via config-overrides if needed.
                model: 'lighton-ocr',
                maxTokens: 4096,
                dpi: 200,
              },
            },
            paddle: {
              uses: 'paddleocr-vl',
              config: {
                // Defaults to http://localhost:11438.
                format: 'markdown',
              },
            },
          },
        },
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      ocr_merge: {
        uses: 'compare/merge',
        name: 'Merge (keep-all)',
        config: { policy: 'keep-all' },
        inputs: {
          // pass fanout output verbatim
          branches: '${ocr_fanout.branches}',
          perBranchMs: '${ocr_fanout.perBranchMs}',
          errors: '${ocr_fanout.errors}',
          ms: '${ocr_fanout.ms}',
        },
      },
      kpi: {
        uses: 'eval/kpi',
        name: 'KPI-Report',
        config: {
          fanoutStageId: 'ocr_fanout',
          // Steuer-typische Pflichtfelder, falls aus dem Volltext heuristisch
          // extrahierbar (eval/kpi flatten't den Input — der Volltext eines
          // OCR-Outputs hat keine k:v Struktur, daher matched diese requiredFields-
          // Liste i.d.R. wenig; sinnvoll wird's wenn man eine klassifizierung
          // dazwischenhaengt. Beispielhaft hier gesetzt fuer das Schema-Coverage-Demo:
          requiredFields: ['identifikationsnummer', 'bruttoarbeitslohn', 'lohnsteuer'],
          formatRegex: {
            identifikationsnummer: '^[0-9]{11}$',
            iban: '^DE[0-9 ]{20,40}$',
          },
          scoreWeights: {
            schema_coverage: 0.3,
            format_conformance: 0.2,
            cross_branch_agreement: 0.4, // dieses Workflow drueckt Agreement
            speed: 0.1,
          },
          passThreshold: 0.75,
        },
        inputs: {
          // We feed the chosen output as "input" — for keep-all policy this is
          // null, but eval/kpi reads `ctx.results['ocr_fanout']` via fanoutStageId
          // anyway, so this is harmless.
          chosen: '${ocr_merge.chosen}',
        },
      },
    },
    edges: [
      ['ocr_fanout', 'ocr_merge'],
      ['ocr_merge', 'kpi'],
    ],
  });
}
