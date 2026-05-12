/**
 * ELSTER Quality-Triad Demo
 * ──────────────────────────
 * Showcase-Workflow für die Quality-Trias Node-Familie:
 *   ocr → schema_guard → critic → span_linker → cross_validator → kpi
 *
 * Demonstriert SOTA-Pattern für audit-fähige Extraktion:
 *   1. Schema-Guard: vLLM strict-JSON-Schema decoded eine Lohnsteuerbescheinigung
 *      gegen das bestehende `lohnsteuerbescheinigung_extraction` Schema.
 *   2. Critic: zweiter LLM (Mistral cloud — independence!) bewertet das Ergebnis.
 *   3. Span-Linker: mappt jeden extrahierten Wert auf seine OCR-Position.
 *   4. Cross-Validator: prüft IBAN-Checksum + IDNr-Prüfziffer + Konfession-Enum.
 *   5. KPI: aggregiert Critic-Score + Span-Coverage + Validator-Pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkflow } from '../../core/workflow.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(
  HERE, '..', '..', 'verticals', 'elster-v3', 'data', 'nested_schemas',
  'lohnsteuerbescheinigung.json',
);

// Load schema at module-init so the workflow definition carries it inline.
// (Avoids runtime fs reads inside the stage.)
const LSTB_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

// Static instructions only — the OCR text is delivered via `inputs.source`,
// not embedded as `${ocr.text}` (the runner only substitutes whole-string refs).
//
// Numeric fields: the schema declares `type: "number"`. German source formatting
// uses "." as thousands separator and "," as decimal — we MUST instruct the
// model to convert to JSON-number form, otherwise strict-decoding produces
// junk (e.g. -69.291 from "69.291,80 €").
const EXTRACTION_PROMPT = [
  'Du bekommst eine deutsche Lohnsteuerbescheinigung als OCR-Text.',
  'Extrahiere alle Felder EXAKT nach dem JSON-Schema.',
  '',
  'WICHTIG bei Geldbeträgen und Zahlen:',
  '  - das Schema erwartet eine echte JSON-Zahl (z.B. 69291.80).',
  '  - der OCR-Text verwendet deutsches Format ("69.291,80 €") — du musst den',
  '    Tausenderpunkt entfernen und das Dezimalkomma in einen Punkt umwandeln.',
  '  - Beispiele:  "69.291,80 €" → 69291.80  ·  "7.532,00 €" → 7532.00',
  '  - keine negativen Zahlen, kein Vorzeichen.',
  '',
  'Wenn ein Feld nicht im Beleg steht, lass es komplett weg statt zu raten.',
].join('\n');

export function buildElsterQualityDemoWorkflow() {
  return defineWorkflow({
    id: 'elster-quality-demo',
    name: 'Quality-Trias Demo — Lohnsteuerbescheinigung',
    description:
      'OCR → Schema-Guard → Critic → Span-Linker → Cross-Validator → KPI. ' +
      'Demonstriert SOTA-Pattern für audit-fähige Extraktion mit Provider-Independence ' +
      '(vLLM für Extract, Mistral cloud für Critic).',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 50,
    },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        name: 'OCR',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      schema_guard: {
        uses: 'extract/schema-guarded-llm',
        name: 'Schema-Guard (vLLM/Gemma)',
        config: {
          provider: 'vllm',
          model: 'gemma4-mm',
          temperature: 0,
          maxTokens: 2000,
          strict: true,
          schemaName: LSTB_SCHEMA.name,
          schema: LSTB_SCHEMA.schema,
        },
        inputs: {
          prompt: EXTRACTION_PROMPT,
          source: '${ocr.text}',
        },
      },
      // Container-aware decorator: maps each leaf back to its canonical eCode
      // atom (ELSTER catalog) and attaches drucktext + anlage + vordruckzeile +
      // datentyp + formatRegex + pflicht + BMF-Anleitung-citation. Downstream
      // critic/span_linker/cross_validator read this to drive type-aware logic.
      field_mapper: {
        uses: 'quality/container-field-mapper',
        name: 'Container-Field-Mapper (eCode + Anleitung)',
        config: {
          dokumenttyp_id: 'lohnsteuerbescheinigung',
          anlageHint: 'N',
        },
        inputs: {
          extracted: '${schema_guard.extracted}',
        },
      },
      critic: {
        uses: 'eval/critic-llm',
        name: 'Critic (Mistral cloud, cites eCode + Anleitung)',
        config: {
          provider: 'mistral',
          model: 'mistral-small-latest',
          temperature: 0,
          passThreshold: 0.85,
        },
        inputs: {
          extracted: '${field_mapper.extracted}',
          source: '${ocr.text}',
          field_meta: '${field_mapper.field_meta}',
        },
      },
      span_linker: {
        uses: 'extract/span-linker',
        name: 'Span-Linker (datentyp-aware)',
        config: {
          caseSensitive: false,
          fuzziness: 0.85,
          includeSnippet: true,
        },
        inputs: {
          extracted: '${field_mapper.extracted_with_codes}',
          source: '${ocr.text}',
          pages: '${ocr.pages}',
          field_meta: '${field_mapper.field_meta}',
        },
      },
      cross_validator: {
        uses: 'extract/cross-validator',
        name: 'Cross-Validator (auto-rules from container)',
        // No explicit `rules` — autogenerated from container atoms.
        config: { autoRegexSeverity: 'warn' },
        inputs: {
          extracted: '${span_linker.extracted_with_spans}',
          field_meta: '${field_mapper.field_meta}',
        },
      },
      kpi: {
        uses: 'eval/kpi',
        name: 'KPI-Aggregation (Quality-Trias)',
        config: {
          // No fan-out; quality signals come from critic + span_linker + cross_validator.
          criticStageId: 'critic',
          spanLinkerStageId: 'span_linker',
          crossValidatorStageId: 'cross_validator',
          requiredFields: ['steuer_id', 'bruttoarbeitslohn', 'lohnsteuer_einbehalten'],
          formatRegex: { steuer_id: '^[0-9]{11}$' },
          // Quality-only composite. Speed weight is 0 — latency is a separate
          // SLA dimension and doesn't drag down the defensibility score.
          scoreWeights: {
            schema_coverage: 0.20,
            format_conformance: 0.15,
            cross_branch_agreement: 0,
            speed: 0,
            critic: 0.25,
            span_coverage: 0.15,
            validator: 0.25,
          },
          passThreshold: 0.85,
        },
        inputs: {
          // Feed the cross-validator output (richest — has spans + validation summary).
          validated: '${cross_validator.validated}',
        },
      },
    },
    edges: [
      ['ocr', 'schema_guard'],
      ['schema_guard', 'field_mapper'],
      ['field_mapper', 'critic'],
      ['field_mapper', 'span_linker'],
      ['span_linker', 'cross_validator'],
      ['cross_validator', 'kpi'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog',
        description: 'BMF Jahresdokumentation 10/2024 — Source-of-Truth für Field-Mapper.',
        kind: 'elster-catalog',
        readBy: ['field_mapper', 'critic', 'span_linker', 'cross_validator'],
        atomsCount: 2287,
        anlagenCount: 35,
        lockState: 'sealed',
      },
    ],
  });
}
