import { defineStage } from '../../../core/stage.ts';
import { loadDokumenttypen } from '../lib/typen-katalog.ts';
import { classifyText, type ClassificationResult } from '../lib/klassifizierung.ts';

export interface DokumentTypInput {
  text: string;
}

export type DokumentTypOutput = ClassificationResult;

export interface DokumentTypConfig {
  model?: string;
  regexStrongThreshold?: number;
  regexDominanceFactor?: number;
  useLlmFallback?: boolean;
  temperature?: number;
}

export const dokumentTypStage = defineStage<
  DokumentTypInput,
  DokumentTypOutput,
  DokumentTypConfig
>({
  id: 'steuerbelege/dokument-typ',
  name: 'Dokumenttyp-Klassifizierung',
  description:
    'Ordnet einen Beleg einem von N privaten Steuer-Dokumenttypen zu. Regex-first gegen den Typen-Katalog; LLM-Fallback bei keinem oder mehrdeutigem Regex-Ergebnis.',

  async run(input, ctx) {
    const { typen } = await loadDokumenttypen();

    const result = await classifyText(input.text, typen, {
      model: ctx.config.model ?? 'mistral-small-latest',
      regexStrongThreshold: ctx.config.regexStrongThreshold,
      regexDominanceFactor: ctx.config.regexDominanceFactor,
      useLlmFallback: ctx.config.useLlmFallback,
      temperature: ctx.config.temperature,
      signal: ctx.signal,
      onLlmVote: (typ_id) => ctx.emit('llm_vote', { typ_id }),
    });

    ctx.emit('regex_scores', { scores: result.regex_scores });
    await ctx.artifacts.write('dokument_typ.json', result);
    return result;
  },
});
