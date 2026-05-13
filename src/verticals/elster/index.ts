/**
 * ELSTER vertical (v2) — funnel-cascade + Hinweisregeln validator.
 *
 * Standard: ELSTER (Bundeszentralamt für Steuern, Germany)
 * Domain: tax
 * Canonical schema: ELSTER eCodes (E0123456 format), 35 Anlagen, 2287 codes
 * Catalog: Jahresdokumentation_10_2024
 *
 * Pipeline (workflow elster-v2):
 *   ocr → klassifizierung → extraktion → funnel → validator
 *
 * `klassifizierung` and `extraktion` stage IDs are provided by the legacy
 * src/workflows/elster/ registrar already running on prod (registerElsterStages()
 * there registers `elster/klassifizierung` and `elster/extraktion`). This
 * vertical only registers the NEW stages (funnel, validator, plus the v3-shared
 * embed-cascade / entity-resolve / deterministic-rules) so there is no
 * duplicate-registration collision with prod's existing setup.
 */
import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { funnelStage } from './stages/funnel-stage.ts';
import { validatorStage } from './stages/validator-stage.ts';
import { embedCascadeStage } from './stages/embed-cascade-stage.ts';
import { entityResolveStage } from './stages/entity-resolve-stage.ts';
import { deterministicRulesStage } from './stages/deterministic-rules-stage.ts';

export const ELSTER_VERTICAL_META = {
  standardId: 'elster',
  standardFullName: 'ELSTER (Bundeszentralamt für Steuern)',
  domain: 'tax',
  canonicalSchemaName: 'ELSTER eCodes',
  catalogVersion: 'Jahresdokumentation_10_2024',
  primaryEntityKind: 'document' as const,
};

/**
 * Registers ELSTER stages NOT already provided by prod's
 * src/workflows/elster/registerElsterStages():
 *   - elster/funnel              (v2)
 *   - elster/validator           (v2 + v3)
 *   - elster/embed-cascade       (v3 layer 3, optional)
 *   - elster/entity-resolve      (v3 layer 2 — flat-KPI form)
 *   - elster/deterministic-rules (v3 layer 4)
 *
 * NOT registered here (prod already has them):
 *   - elster/klassifizierung, elster/extraktion
 */
export function registerElsterStages(): void {
  registerStage(funnelStage);
  registerStage(validatorStage);
  registerStage(embedCascadeStage);
  registerStage(entityResolveStage);
  registerStage(deterministicRulesStage);
}

/**
 * Builds the elster-v2 workflow: 7-stage funnel cascade + Hinweisregeln validator.
 *
 * Workflow id: `elster-v2` (parallel to legacy `elster-v1`, no breakage).
 */
export function buildElsterV2WorkflowWithSchema() {
  return defineWorkflow({
    id: 'elster-v2',
    name: 'ELSTER v2 — Funnel-Cascade & Hinweisregeln-Validator',
    description:
      'OCR → Hybrid-Klassifizierung der ELSTER-Anlagen → parallele Feldextraktion gegen den gepflegten Feld-Katalog → Funnel-Cascade auf den Canonical-ELSTER-Layer → Hinweisregeln-Validator. Output: ein CanonicalLayer mit allen ELSTER-eCodes, Traces und Validierungs-Ergebnissen.',
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
          llmFallbackWhen: 'zero-or-one',
          model: 'mistral-small-latest',
        },
        inputs: {
          text: '${ocr.text}',
        },
      },
      extraktion: {
        uses: 'elster/extraktion',
        config: {
          concurrency: 3,
          model: 'mistral-small-latest',
          maxFieldsPerAnlage: 200,
          maxTextChars: 60_000,
        },
        inputs: {
          text: '${ocr.text}',
          anlagen: '${klassifizierung.erkannte_anlagen}',
        },
      },
      funnel: {
        uses: 'elster/funnel',
        config: {
          shortCircuit: true,
        },
        inputs: {
          per_anlage: '${extraktion.per_anlage}',
          docType: '${klassifizierung.erkannte_anlagen}',
          recommendedAnlagen: '${klassifizierung.erkannte_anlagen}',
        },
      },
      validator: {
        uses: 'elster/validator',
        config: {
          skipUnsupported: true,
        },
        inputs: {
          canonicalLayer: '${funnel.canonicalLayer}',
        },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['ocr', 'extraktion'],
      ['klassifizierung', 'extraktion'],
      ['extraktion', 'funnel'],
      ['klassifizierung', 'funnel'],
      ['funnel', 'validator'],
    ],
  });
}
