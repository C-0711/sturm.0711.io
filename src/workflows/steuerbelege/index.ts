import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { dokumentTypStage } from './stages/dokument-typ.ts';
import { belegExtraktionStage } from './stages/beleg-extraktion.ts';
import { seitenSplitterStage } from './stages/seiten-splitter.ts';
import { belegeMultiStage } from './stages/belege-multi.ts';

export function registerSteuerbelegeStages(): void {
  registerStage(dokumentTypStage);
  registerStage(belegExtraktionStage);
  registerStage(seitenSplitterStage);
  registerStage(belegeMultiStage);
}

/**
 * Workflow für einen einzelnen privaten Steuerbeleg (bereits isoliert — z. B. eine
 * Spendenquittung, Lohnsteuerbescheinigung). Ein Run = ein Beleg.
 */
export function buildSteuerbelegeWorkflow() {
  return defineWorkflow({
    id: 'steuerbelege-v1',
    name: 'Einzelbeleg — Klassifizierung & Feldextraktion',
    description:
      'OCR auf einem einzelnen Beleg → Hybrid-Klassifizierung gegen Typen-Katalog (Regex + LLM-Fallback) → Feldextraktion gegen alle Ziel-ELSTER-Anlagen (eCode-Hints oder gerankter Ausschnitt).',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 25,
    },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      'dokument-typ': {
        uses: 'steuerbelege/dokument-typ',
        config: {
          model: 'mistral-small-latest',
          regexStrongThreshold: 2,
          regexDominanceFactor: 2,
          useLlmFallback: true,
        },
        inputs: {
          text: '${ocr.text}',
        },
      },
      'beleg-extraktion': {
        uses: 'steuerbelege/beleg-extraktion',
        config: {
          model: 'mistral-small-latest',
          maxFieldsFallback: 60,
          maxTextChars: 40_000,
        },
        inputs: {
          text: '${ocr.text}',
          typ_id: '${dokument-typ.typ_id}',
          label: '${dokument-typ.label}',
          anlagen: '${dokument-typ.anlagen}',
          ecodeHintsProAnlage: '${dokument-typ.ecodeHintsProAnlage}',
          vz: '${input.vz}',
        },
      },
    },
    edges: [
      ['ocr', 'dokument-typ'],
      ['dokument-typ', 'beleg-extraktion'],
    ],
  });
}

/**
 * Workflow für ein Multi-Beleg-PDF (z. B. VAST-Auszug mit Religion + Lohnsteuer +
 * Freistellungsaufträgen in einem PDF). Splitter zerlegt nach Markdown-Headings,
 * dann wird pro Sub-Beleg klassifiziert und extrahiert.
 */
export function buildBelegeBundleWorkflow() {
  return defineWorkflow({
    id: 'belege-bundle-v1',
    name: 'Beleg-Bündel — Splitting, Klassifizierung & Feldextraktion',
    description:
      'Multi-Beleg-PDF → OCR → Seiten-Splitter (nach # Headings) → pro Sub-Beleg Klassifizierung + Per-Anlage-Feldextraktion. Für VAST-Auszüge und gemischte Belegsammlungen.',
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 25,
    },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      'seiten-splitter': {
        uses: 'steuerbelege/seiten-splitter',
        config: { minChars: 80 },
        inputs: {
          pages: '${ocr.pages}',
          text: '${ocr.text}',
        },
      },
      'belege-multi': {
        uses: 'steuerbelege/belege-multi',
        config: {
          classifyModel: 'mistral-small-latest',
          extractModel: 'mistral-small-latest',
          regexStrongThreshold: 2,
          regexDominanceFactor: 2,
          useLlmFallback: true,
          maxFieldsFallback: 60,
          maxTextChars: 40_000,
        },
        inputs: {
          subBelege: '${seiten-splitter.subBelege}',
          vz: '${input.vz}',
        },
      },
    },
    edges: [
      ['ocr', 'seiten-splitter'],
      ['seiten-splitter', 'belege-multi'],
    ],
  });
}
