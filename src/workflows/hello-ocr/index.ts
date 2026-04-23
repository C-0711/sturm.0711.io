import { defineWorkflow } from '../../core/workflow.ts';

/**
 * Hello OCR — minimaler Workflow als Smoke-Test und Vorlage.
 * Input: Datei. Stages: Mistral OCR → Textstatistik.
 */
export const helloOcrWorkflow = defineWorkflow({
  id: 'hello-ocr',
  name: 'Hello OCR',
  description: 'Lädt Bild/PDF, macht Mistral OCR, gibt Plain-Text-Stats zurück.',
  input: {
    type: 'file',
    accept: ['pdf', 'png', 'jpg', 'jpeg', 'webp'],
    maxSizeMb: 20,
  },
  stages: {
    ocr: {
      uses: 'mistral-ocr',
      name: 'Mistral OCR',
      description: 'permissiv, ohne Schema',
      inputs: {
        filePath: '${input.filePath}',
        filename: '${input.filename}',
      },
    },
    stats: {
      uses: 'text-stats',
      name: 'Textstatistik',
      description: 'Zeichen, Wörter, Zeilen',
      inputs: {
        text: '${ocr.text}',
      },
    },
  },
  edges: [
    ['ocr', 'stats'],
  ],
});
