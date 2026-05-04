import { defineStage } from '../../../core/stage.ts';
import { loadDokumenttypen } from '../lib/typen-katalog.ts';
import { classifyText, type ClassificationResult } from '../lib/klassifizierung.ts';
import { extractForAnlagen, type AnlageExtraktion } from '../lib/extraktion.ts';
import type { SubBeleg } from './seiten-splitter.ts';

export interface BelegeMultiInput {
  subBelege: SubBeleg[];
  vz?: number | string;
}

export interface BelegErgebnis {
  index: number;
  header: string;
  seiten: number[];
  klassifikation: ClassificationResult;
  extraktion: {
    values: Record<string, Record<string, string | null>>;
    perAnlage: AnlageExtraktion[];
    filled: number;
    fieldCount: number;
    skipped: boolean;
    reason?: string;
    ms: number;
  };
}

export interface BelegeMultiOutput {
  belege: BelegErgebnis[];
  anzahlBelege: number;
  anzahlKlassifiziert: number;
  anzahlMitAnlage: number;
  anzahlDokumentation: number;
  filledSumme: number;
  fieldCountSumme: number;
  ms: number;
}

export interface BelegeMultiConfig {
  classifyModel?: string;
  extractModel?: string;
  regexStrongThreshold?: number;
  regexDominanceFactor?: number;
  useLlmFallback?: boolean;
  maxFieldsFallback?: number;
  maxTextChars?: number;
  temperature?: number;
}

export const belegeMultiStage = defineStage<
  BelegeMultiInput,
  BelegeMultiOutput,
  BelegeMultiConfig
>({
  id: 'steuerbelege/belege-multi',
  name: 'Belege klassifizieren & extrahieren',
  description:
    'Verarbeitet alle Sub-Belege aus dem Splitter: pro Beleg Klassifizierung gegen Typen-Katalog + parallele Per-Anlage-Extraktion. Streamt Progress-Events je Beleg.',

  async run(input, ctx) {
    const t0 = Date.now();
    const subBelege = input.subBelege ?? [];
    const { typen } = await loadDokumenttypen();

    const classifyModel = ctx.config.classifyModel ?? 'mistral-small-latest';
    const extractModel = ctx.config.extractModel ?? 'mistral-small-latest';
    const temperature = ctx.config.temperature ?? 0;

    const belege: BelegErgebnis[] = [];

    for (const sub of subBelege) {
      ctx.emit('beleg_start', { index: sub.index, header: sub.header });

      const klass = await classifyText(sub.text, typen, {
        model: classifyModel,
        regexStrongThreshold: ctx.config.regexStrongThreshold,
        regexDominanceFactor: ctx.config.regexDominanceFactor,
        useLlmFallback: ctx.config.useLlmFallback,
        temperature,
        signal: ctx.signal,
      });

      ctx.emit('beleg_klassifiziert', {
        index: sub.index,
        header: sub.header,
        typ_id: klass.typ_id,
        label: klass.label,
        anlagen: klass.anlagen,
        konfidenz: klass.konfidenz,
        used_llm: klass.used_llm,
      });

      if (!klass.typ_id) {
        ctx.emit('beleg_uebersprungen', {
          index: sub.index,
          reason: 'Kein Dokumenttyp erkannt',
        });
        belege.push({
          index: sub.index,
          header: sub.header,
          seiten: sub.seiten,
          klassifikation: klass,
          extraktion: {
            values: {},
            perAnlage: [],
            filled: 0,
            fieldCount: 0,
            skipped: true,
            reason: 'Kein Dokumenttyp erkannt',
            ms: 0,
          },
        });
        continue;
      }

      if (klass.anlagen.length === 0) {
        ctx.emit('beleg_uebersprungen', {
          index: sub.index,
          reason: 'Nur Dokumentation — keine Ziel-Anlage',
        });
        belege.push({
          index: sub.index,
          header: sub.header,
          seiten: sub.seiten,
          klassifikation: klass,
          extraktion: {
            values: {},
            perAnlage: [],
            filled: 0,
            fieldCount: 0,
            skipped: true,
            reason: `Typ "${klass.label}" ist reine Dokumentation`,
            ms: 0,
          },
        });
        continue;
      }

      const tExtract = Date.now();
      const label = klass.label ?? klass.typ_id;
      const { values, perAnlage, filled, fieldCount } = await extractForAnlagen(
        label,
        klass.anlagen,
        klass.ecodeHintsProAnlage,
        sub.text,
        {
          vz: input.vz,
          model: extractModel,
          maxFieldsFallback: ctx.config.maxFieldsFallback ?? 60,
          maxTextChars: ctx.config.maxTextChars ?? 40_000,
          temperature,
          signal: ctx.signal,
          onAnlageDone: (r) =>
            ctx.emit('beleg_anlage_extrahiert', {
              index: sub.index,
              anlage: r.anlage,
              filled: r.filled,
              fieldCount: r.fieldCount,
              quelle: r.quelle,
            }),
        },
      );

      ctx.emit('beleg_extrahiert', {
        index: sub.index,
        header: sub.header,
        filled,
        fieldCount,
      });

      belege.push({
        index: sub.index,
        header: sub.header,
        seiten: sub.seiten,
        klassifikation: klass,
        extraktion: {
          values,
          perAnlage,
          filled,
          fieldCount,
          skipped: false,
          ms: Date.now() - tExtract,
        },
      });
    }

    const anzahlKlassifiziert = belege.filter((b) => b.klassifikation.typ_id).length;
    const anzahlMitAnlage = belege.filter((b) => !b.extraktion.skipped).length;
    const anzahlDokumentation =
      belege.filter(
        (b) => b.klassifikation.typ_id && b.klassifikation.anlagen.length === 0,
      ).length;
    const filledSumme = belege.reduce((s, b) => s + b.extraktion.filled, 0);
    const fieldCountSumme = belege.reduce((s, b) => s + b.extraktion.fieldCount, 0);

    const out: BelegeMultiOutput = {
      belege,
      anzahlBelege: belege.length,
      anzahlKlassifiziert,
      anzahlMitAnlage,
      anzahlDokumentation,
      filledSumme,
      fieldCountSumme,
      ms: Date.now() - t0,
    };
    await ctx.artifacts.write('belege_multi.json', out);
    return out;
  },
});
