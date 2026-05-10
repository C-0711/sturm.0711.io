import { defineStage } from '../../../core/stage.ts';
import { chatJson } from '../lib/mistral-chat.ts';
import { loadFelder, type FelderSchema } from '../lib/anlagen-katalog.ts';

export interface ExtraktionInput {
  text: string;
  anlagen: string[];
}

export interface AnlageResult {
  anlage: string;
  fieldCount: number;
  filled: number;
  values: Record<string, string | null>;
  durationMs: number;
  error?: string;
}

export interface ExtraktionOutput {
  per_anlage: Record<string, AnlageResult>;
  totalFilled: number;
  ms: number;
}

export interface ExtraktionConfig {
  model?: string;
  concurrency?: number;
  maxFieldsPerAnlage?: number;
  maxTextChars?: number;
  temperature?: number;
}

type Feld = FelderSchema['felder'][number];

function extractableFelder(all: Feld[]): Feld[] {
  // Keep only fields with a real eCode (E + digits). Index/marker fields without
  // an eCode can't be extracted against.
  return all.filter((f) => /^E\d+$/.test(f.Name));
}

function selectFields(felder: Feld[], maxFields: number): Feld[] {
  if (felder.length <= maxFields) return felder;
  const scored = felder
    .map((f, i) => ({
      f,
      i,
      score:
        (f.pflicht ? 100 : 0) +
        (f.Vordruckzeile ? 50 : 0) +
        (f.Drucktext ? 10 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, maxFields)
    .sort((a, b) => a.i - b.i);
  return scored.map((s) => s.f);
}

interface FieldSpec {
  eCode: string;
  drucktext: string;
  vordruckzeile: string | null;
  format: string | null;
  pflicht: boolean;
}

function fieldSpec(f: Feld): FieldSpec {
  return {
    eCode: f.Name,
    drucktext: f.Drucktext || f.Beschreibung,
    vordruckzeile: f.Vordruckzeile || null,
    format: f.Formatkennzeichen || null,
    pflicht: f.pflicht,
  };
}

function buildPrompt(anlage: string, spec: FieldSpec[], text: string, maxChars: number): string {
  return [
    'Du bekommst den OCR-Text einer Einkommensteuererklärung und eine Liste',
    `von Feldern für die ELSTER-Anlage "${anlage}".`,
    'Für jedes Feld: wenn du im Text einen passenden Wert findest, gib ihn zurück;',
    'sonst null. Beträge als Zeichenkette mit Komma (z.B. "12345,67").',
    '"drucktext" ist der Label-Text auf dem Formular, "vordruckzeile" die Zeilennummer.',
    '',
    'Antworte ausschließlich mit JSON in dieser Form:',
    '{"values": {"E0200204": "12345,67", "E0200304": null}}',
    '',
    'Felder:',
    JSON.stringify(spec, null, 2),
    '',
    '--- OCR-Text ---',
    text.slice(0, maxChars),
  ].join('\n');
}

async function extractOne(
  anlage: string,
  text: string,
  config: Required<ExtraktionConfig>,
  signal?: AbortSignal,
): Promise<AnlageResult> {
  const t0 = Date.now();
  const raw = await loadFelder(anlage);
  const felder = selectFields(extractableFelder(raw.felder), config.maxFieldsPerAnlage);
  if (felder.length === 0) {
    return {
      anlage,
      fieldCount: 0,
      filled: 0,
      values: {},
      durationMs: Date.now() - t0,
    };
  }
  const spec = felder.map(fieldSpec);
  const prompt = buildPrompt(anlage, spec, text, config.maxTextChars);

  const { parsed } = await chatJson<{ values?: Record<string, unknown> }>(prompt, {
    model: config.model,
    temperature: config.temperature,
    signal,
  });

  const allowed = new Set(spec.map((s) => s.eCode));
  const values: Record<string, string | null> = {};
  let filled = 0;
  for (const [k, v] of Object.entries(parsed.values ?? {})) {
    if (!allowed.has(k)) continue;
    if (v === null || v === '' || v === undefined) {
      values[k] = null;
    } else {
      values[k] = String(v);
      filled += 1;
    }
  }
  return {
    anlage,
    fieldCount: spec.length,
    filled,
    values,
    durationMs: Date.now() - t0,
  };
}

function resolveConfig(c: ExtraktionConfig): Required<ExtraktionConfig> {
  return {
    model: c.model ?? 'mistral-small-latest',
    concurrency: c.concurrency ?? 3,
    maxFieldsPerAnlage: c.maxFieldsPerAnlage ?? 200,
    maxTextChars: c.maxTextChars ?? 60_000,
    temperature: c.temperature ?? 0,
  };
}

export const extraktionStage = defineStage<
  ExtraktionInput,
  ExtraktionOutput,
  ExtraktionConfig
>({
  id: 'elster/extraktion',
  name: 'Per-Anlage-Feldextraktion',
  description:
    'Ruft pro erkannter Anlage einen Mistral-Chat-Call mit der Feldliste (eCode + Drucktext + Vordruckzeile) und dem OCR-Text auf. Parallelisiert mit konfigurierbarer Concurrency; Output ist { per_anlage: { ANLAGE: { values: { eCode: wert } } } }.',

  async run(input, ctx) {
    const t0 = Date.now();
    const config = resolveConfig(ctx.config);
    const queue = [...input.anlagen];
    const results: Record<string, AnlageResult> = {};
    const total = input.anlagen.length;
    let done = 0;

    if (total === 0) {
      return { per_anlage: {}, totalFilled: 0, ms: Date.now() - t0 };
    }

    ctx.emit('extraktion_start', { total, concurrency: config.concurrency });

    const worker = async (): Promise<void> => {
      while (queue.length) {
        const anlage = queue.shift();
        if (!anlage) break;
        ctx.emit('anlage_start', { anlage });
        try {
          const r = await extractOne(anlage, input.text, config, ctx.signal);
          results[anlage] = r;
          await ctx.artifacts.write(`per_anlage/${anlage}.json`, r);
          done += 1;
          ctx.emit('anlage_done', {
            anlage,
            filled: r.filled,
            fieldCount: r.fieldCount,
            durationMs: r.durationMs,
            done,
            total,
          });
        } catch (err) {
          const msg = (err as Error).message;
          results[anlage] = {
            anlage,
            fieldCount: 0,
            filled: 0,
            values: {},
            durationMs: 0,
            error: msg,
          };
          done += 1;
          ctx.logger.warn(`Extraction failed for ${anlage}`, { error: msg });
          ctx.emit('anlage_error', { anlage, error: msg, done, total });
        }
      }
    };

    const nWorkers = Math.min(config.concurrency, total);
    await Promise.all(Array.from({ length: nWorkers }, () => worker()));

    const totalFilled = Object.values(results).reduce((s, r) => s + r.filled, 0);
    return {
      per_anlage: results,
      totalFilled,
      ms: Date.now() - t0,
    };
  },
});
