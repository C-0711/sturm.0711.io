import { defineStage } from '../core/stage.ts';

export interface TextStatsInput {
  text: string;
}

export interface TextStatsOutput {
  chars: number;
  words: number;
  lines: number;
  preview: string;
}

/**
 * Triviale Textstatistik — dient als End-Stage für Demo/Smoke-Tests.
 */
export const textStatsStage = defineStage<TextStatsInput, TextStatsOutput>({
  id: 'text-stats',
  name: 'Textstatistik',
  description: 'Zeichen, Wörter, Zeilen, Vorschau',

  async run(input, _ctx) {
    const text = input?.text ?? '';
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const lines = text.split(/\r?\n/).length;
    return {
      chars: text.length,
      words,
      lines,
      preview: text.slice(0, 240),
    };
  },
});
