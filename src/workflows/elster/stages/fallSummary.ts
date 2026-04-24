import { defineStage } from '../../../core/stage.ts';
import { chatJson } from '../lib/haiku-chat.ts';

type AnrWert = {
  eCode: string;
  anlage: string;
  wert: string;
  beschreibung?: string;
  drucktext?: string;
  vordruckzeile?: string;
};

export interface FallSummaryInput {
  alle_werte_merged: AnrWert[];
  anlagen: string[];
  pages: Array<{ index: number; markdown: string }>;
}

export interface FallSummaryOutput {
  befund: string;
  hinweise: string[];
  ms: number;
  error?: string;
}

export interface FallSummaryConfig {
  model?: string;
  temperature?: number;
}

function resolveConfig(c: FallSummaryConfig): Required<FallSummaryConfig> {
  return {
    model: c.model ?? 'claude-haiku-4-5',
    temperature: c.temperature ?? 0,
  };
}

function kompaktWerte(werte: AnrWert[], max = 80): AnrWert[] {
  // Priorität: Werte mit sinnvollem Drucktext zuerst
  return werte
    .filter((w) => w.wert && w.wert !== 'null')
    .slice(0, max);
}

function buildPrompt(werte: AnrWert[], anlagen: string[]): string {
  const kompakt = kompaktWerte(werte);
  const werteText = kompakt
    .map(
      (w) =>
        `  [${w.anlage}] ${w.drucktext || w.beschreibung || w.eCode}: ${w.wert}`,
    )
    .join('\n');

  return [
    'Du bist Steuerberater-Assistent. Du hast gerade ein Dokument gelesen.',
    '',
    `ERKANNTE ANLAGEN: ${anlagen.join(', ')}`,
    '',
    'EXTRAHIERTE WERTE:',
    werteText,
    '',
    'AUFGABE:',
    'Schreibe einen EINZIGEN Satz (max. 30 Wörter) für einen Mandanten-Chat, ',
    'der den Befund dieses Dokuments zusammenfasst. Neutraler Steuerberater-Ton.',
    '',
    'Stil: "Erkannt: <DokumentTyp> für <Person(en)> mit <wichtigste Werte/Kennzahlen>."',
    '',
    'Beispiele:',
    '- "Erkannt: ESt-Erklärung 2023 für Rainer und Ute Stricker (Zusammenveranlagung), Bruttoarbeitslohn 63.560 €, Kapitalerträge 117 €."',
    '- "Erkannt: Steuerbescheinigung Westerwald Bank für Maria Ute Stricker, 11,25 € Kapitalerträge / 2,75 € KapESt."',
    '- "Erkannt: Lohnsteuerbescheinigung 2024 Verbandsgemeindewerke, Steuerklasse 3, 63.559,90 € Brutto."',
    '',
    'ZUSÄTZLICH: Falls du auffällige Lücken oder plausible Weiterleitungen zu anderen Anlagen siehst, ',
    'liefere 0-3 kurze Hinweise (z.B. "Anlage VOR-Beiträge fehlen", "Ehefrau hat eigene KAP-Felder").',
    '',
    'Antwort STRIKT als JSON: {"befund": "...", "hinweise": ["...", "..."]}',
    'KEIN Vorspann, KEIN Markdown, nur JSON.',
  ].join('\n');
}

export const fallSummaryStage = defineStage<
  FallSummaryInput,
  FallSummaryOutput,
  FallSummaryConfig
>({
  id: 'elster/fall-summary',
  name: 'Fall-Zusammenfassung (1-Satz-Befund)',
  description:
    'Haiku bildet aus den merged Werten einen 1-Satz-Befund für den Mandanten-Chat. ' +
    'Letzter Schritt der elster-v1 Pipeline, emittiert event=fall_befund.',
  async run(input, ctx) {
    const config = resolveConfig(ctx.config ?? {});
    const t0 = Date.now();
    const werte = input.alle_werte_merged || [];
    const anlagen = input.anlagen || [];

    ctx.emit('befund_start', { werte: werte.length, anlagen: anlagen.length });

    if (werte.length === 0) {
      const out: FallSummaryOutput = {
        befund: 'Dokument gelesen, aber keine extrahierbaren Werte erkannt.',
        hinweise: [],
        ms: Date.now() - t0,
      };
      ctx.emit('fall_befund', out);
      return out;
    }

    try {
      const { parsed } = await chatJson<{
        befund?: string;
        hinweise?: string[];
      }>(buildPrompt(werte, anlagen), {
        model: config.model,
        temperature: config.temperature,
        signal: ctx.signal,
        maxTokens: 600,
      });

      const out: FallSummaryOutput = {
        befund:
          (parsed.befund || '').trim() ||
          `Dokument erkannt: ${werte.length} Werte aus ${anlagen.join(', ')}.`,
        hinweise: Array.isArray(parsed.hinweise)
          ? parsed.hinweise.filter((h) => typeof h === 'string').slice(0, 3)
          : [],
        ms: Date.now() - t0,
      };
      ctx.emit('fall_befund', {
        befund: out.befund,
        hinweise: out.hinweise,
        ms: out.ms,
      });
      await ctx.artifacts.write('fall_summary/befund.json', out);
      return out;
    } catch (e: any) {
      const out: FallSummaryOutput = {
        befund: `Dokument erkannt: ${werte.length} Werte aus ${anlagen.join(', ')}.`,
        hinweise: [],
        ms: Date.now() - t0,
        error: String(e?.message ?? e),
      };
      ctx.emit('fall_befund', { ...out, fallback: true });
      return out;
    }
  },
});
