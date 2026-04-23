import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { regelEngineStage } from './stages/regel-engine.ts';
import { schemaBauStage } from './stages/schema-bau.ts';
import { baselineMergeStage } from './stages/baseline-merge.ts';
import { bewertungStage } from './stages/bewertung.ts';
import { crossCheckStage } from './stages/cross-check.ts';
import { anlagenFilterStage, anlagenDetectorSchema } from './stages/anlagen-filter.ts';

export function registerElsterStages(): void {
  registerStage(regelEngineStage);
  registerStage(schemaBauStage);
  registerStage(baselineMergeStage);
  registerStage(bewertungStage);
  registerStage(crossCheckStage);
  registerStage(anlagenFilterStage);
}

/**
 * ELSTER-Feldextraktion — sechsphasige Pipeline nach BMF-Katalog.
 *
 * Haupt-Pfad:
 *   ocr-permissiv → regel-engine → schema-bau → ocr-kuratiert
 *                                            → baseline-merge → bewertung → cross-check
 *
 * Anlagen-Pfad (parallel ab upload):
 *   ocr-enum → anlagen-filter ──────────────────────────────↓
 *                                              (in regel-engine als gewaehlteAnlagen)
 */
export function buildElsterWorkflow() {
  return defineWorkflow({
    id: 'elster-v1',
    name: 'ELSTER Feldextraktion',
    description: 'Steuer-Dokumente auf ELSTER-Felder mappen, validieren, bewerten.',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg', 'webp'],
      maxSizeMb: 20,
    },
    stages: {
      // Haupt-Pfad
      'ocr-permissiv': {
        uses: 'mistral-ocr',
        name: 'Mistral OCR · permissiv',
        description: 'Markdown + freie JSON-Annotation in einem Call',
        config: { model: 'mistral-ocr-latest' },
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      'regel-engine': {
        uses: 'elster-regel-engine',
        name: 'Regel-Engine',
        description: 'Deterministisches Label-Matching gegen BMF-Katalog',
        inputs: {
          mistralText: '${ocr-permissiv.text}',
          visionAnnotation: '${ocr-permissiv.annotation}',
          gewaehlteAnlagen: '${anlagen-filter.erkannte_anlagen}',
        },
      },
      'schema-bau': {
        uses: 'elster-schema-bau',
        name: 'Schema-Bau',
        description: 'Tight JSON-Schema aus belegten ELSTER-Codes',
        inputs: {
          finalCodes: '${regel-engine.eindeutig}',
        },
      },
      'ocr-kuratiert': {
        uses: 'mistral-ocr',
        name: 'Mistral kuratiert',
        description: 'Zweiter OCR-Pass mit tight Schema',
        config: { schemaName: 'ElsterTight' },
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
          schema: '${schema-bau.basisSchema}',
        },
      },
      'baseline-merge': {
        uses: 'elster-baseline-merge',
        name: 'Baseline-Merge',
        description: 'Mistral-kuratiert + Regel-Engine → finale Annotation',
        inputs: {
          mistralKuratiertAnno: '${ocr-kuratiert.annotation}',
          regelEindeutig: '${regel-engine.eindeutig}',
        },
      },
      'bewertung': {
        uses: 'elster-bewertung',
        name: 'Bewertung',
        description: 'Pflichtfelder, Dichte, Konsistenz, Opus-Vision',
        config: { ohneOpus: false },
        inputs: {
          annotation: '${baseline-merge.finalAnnotation}',
          jsonSchema: '${schema-bau.basisSchema}',
          filePath: '${input.filePath}',
          filename: '${input.filename}',
          gewaehlteAnlagen: '${anlagen-filter.erkannte_anlagen}',
        },
      },
      'cross-check': {
        uses: 'elster-cross-check',
        name: 'Cross-Check',
        description: 'Anlagen-Abgleich gegen gefundene Codes',
        inputs: {
          annotation: '${baseline-merge.finalAnnotation}',
          gewaehlteAnlagen: '${anlagen-filter.erkannte_anlagen}',
          erkannteAnlagen: '${anlagen-filter.erkannte_anlagen}',
        },
      },

      // Anlagen-Pfad (parallel)
      'ocr-enum': {
        uses: 'mistral-ocr',
        name: 'Mistral OCR · Enum',
        description: 'Minimal-Schema, nur Anlagen-Klassifizierung',
        config: {
          schemaName: 'AnlagenDetector',
          // schema wird zur Laufzeit aus Katalog gebaut — wir nutzen eine Stage-Funktion
          // als Initializer beim Registrieren (siehe registerElsterWorkflow unten).
        },
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      'anlagen-filter': {
        uses: 'elster-anlagen-filter',
        name: 'Katalog-Filter',
        description: 'Gefundene Codes gegen ELSTER-Katalog validieren',
        inputs: {
          rawAnnotation: '${ocr-enum.annotation}',
        },
      },
    },
    edges: [
      // Haupt-Pfad
      ['ocr-permissiv', 'regel-engine'],
      ['regel-engine', 'schema-bau'],
      ['schema-bau', 'ocr-kuratiert'],
      ['ocr-kuratiert', 'baseline-merge'],
      ['regel-engine', 'baseline-merge'],
      ['baseline-merge', 'bewertung'],
      ['schema-bau', 'bewertung'],
      ['baseline-merge', 'cross-check'],
      // Anlagen-Pfad
      ['ocr-enum', 'anlagen-filter'],
      // Querverbindung: anlagen-filter → regel-engine (gewählte Anlagen)
      ['anlagen-filter', 'regel-engine'],
      // ... und → bewertung, cross-check
      ['anlagen-filter', 'bewertung'],
      ['anlagen-filter', 'cross-check'],
    ],
  });
}

/**
 * Separate Register-Funktion, die den Workflow baut UND das Enum-Schema
 * für ocr-enum zur Laufzeit nachträgt — weil das Enum die Anlagen-Codes
 * aus dem Katalog braucht, der erst bei erstem `getIndices()`-Zugriff lädt.
 */
export function buildElsterWorkflowWithSchema() {
  const wf = buildElsterWorkflow();
  // Enum-Schema erst hier bauen (Katalog wird geladen)
  const schema = anlagenDetectorSchema();
  (wf.stages['ocr-enum'].config as Record<string, unknown>).schema = schema;
  return wf;
}
