import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { myopiaExtractStage } from './stages/extract.ts';
import { myopiaClassifyStage } from './stages/classify.ts';
import { myopiaRegisterStage } from './stages/register.ts';

export function registerMyopiaStages(): void {
  registerStage(myopiaExtractStage);
  registerStage(myopiaClassifyStage);
  registerStage(myopiaRegisterStage);
}

export function buildMyopiaWorkflow() {
  return defineWorkflow({
    id: 'myopia-progression',
    name: 'Myopia Master — Progressions-Risk',
    description:
      'OCR des Myopia-Master-Berichts → Extraktion von Achslänge (aktuell + vorherig), SE, Km, Alter → Klassifikation nach IMI/Brien-Holden Δ-AL-Schwellen mit Alters- und High-Myopia-Modifikatoren → Atlas-Registrierung.',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 25,
    },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        name: 'Myopia-Master-OCR',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      extract: {
        uses: 'myopia/extract',
        name: 'Feldextraktion',
        inputs: { text: '${ocr.text}' },
      },
      classify: {
        uses: 'myopia/classify',
        name: 'Progressions-Klassifikation',
        inputs: { extracted: '${extract}' },
      },
      register: {
        uses: 'myopia/register',
        name: 'Atlas-Registrierung',
        config: {
          atlasApiUrl: process.env.ATLAS_API_URL ?? '',
          deviceKind: 'myopia_master',
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
