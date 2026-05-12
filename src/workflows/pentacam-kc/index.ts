/**
 * Workflow: pentacam-kc-score
 *
 * Pentacam-Bericht (PDF/Bild) → OCR → Belin/Ambrósio-Indizes extrahieren →
 * KC-Risk klassifizieren → im Atlas registrieren.
 *
 * Erster echter MedTech-Workflow auf Sturm. Folgt strikt dem elster-Pattern:
 * generische `mistral-ocr` aus src/stages/, drei workflow-spezifische Stages
 * unter `stages/`, Datenkataloge unter `data/`.
 */

import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { pentacamExtractStage } from './stages/extract.ts';
import { pentacamClassifyStage } from './stages/classify.ts';
import { pentacamRegisterStage } from './stages/register.ts';

export function registerPentacamKcStages(): void {
  registerStage(pentacamExtractStage);
  registerStage(pentacamClassifyStage);
  registerStage(pentacamRegisterStage);
}

export function buildPentacamKcWorkflow() {
  return defineWorkflow({
    id: 'pentacam-kc-score',
    name: 'Pentacam — Keratokonus-Risk-Score',
    description:
      'OCR auf hochgeladenem Pentacam-Bericht (PDF/Bild) → Extraktion der Belin/Ambrósio-Indizes (BAD-D, Df/Db/Dp/Dt/Da), Pachymetrie und posterioren Elevation → KC-Risk-Klassifikation nach publizierten Schwellenwerten → Atlas-Registrierung mit GitChain-Provenance.',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 25,
    },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        name: 'Pentacam-OCR',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      extract: {
        uses: 'pentacam/extract',
        name: 'Pentacam-Feldextraktion',
        inputs: {
          text: '${ocr.text}',
        },
      },
      classify: {
        uses: 'pentacam/classify',
        name: 'KC-Risk Klassifikation',
        inputs: {
          extracted: '${extract}',
        },
      },
      register: {
        uses: 'pentacam/register',
        name: 'Atlas-Registrierung',
        config: {
          // In the universe compose this resolves at runtime. Outside, the
          // stage falls back to artifact-only mode.
          atlasApiUrl: process.env.ATLAS_API_URL ?? '',
          deviceKind: 'pentacam_hr',
        },
        inputs: {
          extracted: '${extract}',
          classified: '${classify}',
          filename: '${input.filename}',
        },
      },
    },
    edges: [
      ['ocr', 'extract'],
      ['extract', 'classify'],
      ['classify', 'register'],
    ],
  });
}
