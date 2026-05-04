import { defineStage } from '../../../core/stage.ts';
import { extractForAnlagen, type AnlageExtraktion } from '../lib/extraktion.ts';

export interface BelegExtraktionInput {
  text: string;
  typ_id: string | null;
  label: string | null;
  anlagen: string[];
  ecodeHintsProAnlage: Record<string, string[]>;
  vz?: number | string;
}

export interface BelegExtraktionOutput {
  typ_id: string | null;
  label: string | null;
  anlagen: string[];
  values: Record<string, Record<string, string | null>>;
  perAnlage: AnlageExtraktion[];
  filled: number;
  fieldCount: number;
  skipped: boolean;
  reason?: string;
  ms: number;
}

export interface BelegExtraktionConfig {
  model?: string;
  maxFieldsFallback?: number;
  maxTextChars?: number;
  temperature?: number;
}

export const belegExtraktionStage = defineStage<
  BelegExtraktionInput,
  BelegExtraktionOutput,
  BelegExtraktionConfig
>({
  id: 'steuerbelege/beleg-extraktion',
  name: 'Beleg-Feldextraktion',
  description:
    'Extrahiert aus einem klassifizierten Beleg die ELSTER-eCodes pro Ziel-Anlage. Läuft pro Anlage einen LLM-Call parallel; nutzt ecodeHintsProAnlage als Whitelist, sonst einen gerankten Ausschnitt der Anlage.',

  async run(input, ctx) {
    const t0 = Date.now();

    const anlagen = input.anlagen ?? [];
    if (!input.typ_id || anlagen.length === 0) {
      const reason = !input.typ_id
        ? 'Kein Dokumenttyp erkannt — Extraktion übersprungen.'
        : `Typ "${input.label ?? input.typ_id}" wird nur als Dokumentation gesammelt (keine Ziel-Anlage).`;
      const out: BelegExtraktionOutput = {
        typ_id: input.typ_id,
        label: input.label,
        anlagen,
        values: {},
        perAnlage: [],
        filled: 0,
        fieldCount: 0,
        skipped: true,
        reason,
        ms: Date.now() - t0,
      };
      await ctx.artifacts.write('beleg_extraktion.json', out);
      return out;
    }

    const label = input.label ?? input.typ_id;
    ctx.emit('anlagen_ausgewählt', { anlagen });

    const { values, perAnlage, filled, fieldCount } = await extractForAnlagen(
      label,
      anlagen,
      input.ecodeHintsProAnlage ?? {},
      input.text,
      {
        vz: input.vz,
        model: ctx.config.model ?? 'mistral-small-latest',
        maxFieldsFallback: ctx.config.maxFieldsFallback ?? 60,
        maxTextChars: ctx.config.maxTextChars ?? 40_000,
        temperature: ctx.config.temperature ?? 0,
        signal: ctx.signal,
        onAnlageDone: (r) =>
          ctx.emit('felder_extrahiert', {
            anlage: r.anlage,
            filled: r.filled,
            fieldCount: r.fieldCount,
            quelle: r.quelle,
          }),
      },
    );

    const out: BelegExtraktionOutput = {
      typ_id: input.typ_id,
      label: input.label,
      anlagen,
      values,
      perAnlage,
      filled,
      fieldCount,
      skipped: false,
      ms: Date.now() - t0,
    };
    await ctx.artifacts.write('beleg_extraktion.json', out);
    return out;
  },
});
