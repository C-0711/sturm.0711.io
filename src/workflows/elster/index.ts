import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { klassifizierungStage } from './stages/klassifizierung.ts';
import { extraktionStage } from './stages/extraktion.ts';
import { anreicherungStage } from './stages/anreicherung.ts';
import { seitenChipsStage } from './stages/seitenChips.ts';
import { qualitaetsgateStage } from './stages/qualitaetsgate.ts';
import { fallSummaryStage } from './stages/fallSummary.ts';

/**
 * Registriert die workflow-lokalen Stages. Die generische Stage `mistral-ocr`
 * liegt in src/stages/ und wird zentral beim Engine-Start registriert.
 *
 * Export-Name bleibt identisch zum Vorgänger, damit src/workflows/index.ts
 * nicht angepasst werden muss.
 */
export function registerElsterStages(): void {
  registerStage(klassifizierungStage);
  registerStage(extraktionStage);
  registerStage(anreicherungStage);
  registerStage(seitenChipsStage);
  registerStage(qualitaetsgateStage);
  registerStage(fallSummaryStage);
}

/**
 * Baut den ELSTER-Workflow. Heißt historisch `buildElsterWorkflowWithSchema`
 * (der Vorgänger hat dynamisch ein Schema gegen die Mistral-OCR-Annotation
 * gebaut). Wir brauchen das hier nicht mehr — Klassifizierung läuft über
 * Regex+LLM-Fallback gegen den OCR-Volltext, Extraktion pro Anlage gegen die
 * lokal gepflegten Feld-Kataloge unter data/felder/.
 *
 * Export-Name erhalten, damit src/workflows/index.ts unverändert bleibt.
 */
export function buildElsterWorkflowWithSchema() {
  return defineWorkflow({
    id: 'elster-v1',
    name: 'ELSTER — Anlagen-Erkennung & Feldextraktion',
    description:
      'OCR auf hochgeladenem Steuerdokument → Hybrid-Klassifizierung der ELSTER-Anlagen (Regex + LLM-Fallback gegen 35-Anlagen-Enum) → parallele Feldextraktion pro erkannter Anlage gegen den gepflegten Feld-Katalog (eCode, Drucktext, Vordruckzeile).',
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
          vz: '${input.vz}',
        },
      },
      extraktion: {
        uses: 'elster/extraktion',
        config: {
          concurrency: 3,
          model: 'claude-haiku-4-5',
          maxFieldsPerAnlage: 200,
          maxTextChars: 60_000,
        },
        inputs: {
          text: '${ocr.text}',
          anlagen: '${klassifizierung.erkannte_anlagen}',
          vz: '${input.vz}',
        },
      },
      anreicherung: {
        uses: 'elster/anreicherung',
        inputs: {
          per_anlage: '${extraktion.per_anlage}',
          vz: '${input.vz}',
        },
      },
      seitenChips: {
        uses: 'elster/seiten-chips',
        config: {
          model: 'claude-haiku-4-5',
          concurrency: 4,
          maxCharsPerPage: 8000,
        },
        inputs: {
          pages: '${ocr.pages}',
        },
      },
      qualitaetsgate: {
        uses: 'elster/qualitaetsgate',
        config: {
          model: 'claude-haiku-4-5',
          maxCharsProSeite: 5000,
          maxAnlagen: 7,
          vz: '${input.vz}',
        },
        inputs: {
          pages: '${ocr.pages}',
          anreicherung: '${anreicherung}',
          klassifizierung: '${klassifizierung}',
        },
      },
      fallSummary: {
        uses: 'elster/fall-summary',
        config: {
          model: 'claude-haiku-4-5',
        },
        inputs: {
          alle_werte_merged: '${qualitaetsgate.alle_werte_merged}',
          anlagen: '${klassifizierung.erkannte_anlagen}',
          pages: '${ocr.pages}',
        },
      },
    },
    edges: [
      ['ocr', 'klassifizierung'],
      ['ocr', 'seitenChips'],
      ['klassifizierung', 'extraktion'],
      ['extraktion', 'anreicherung'],
      ['anreicherung', 'qualitaetsgate'],
      ['seitenChips', 'qualitaetsgate'],
      ['qualitaetsgate', 'fallSummary'],
    ],
  });
}
