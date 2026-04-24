import { defineStage } from '../../../core/stage.ts';
import { chatJson } from '../lib/haiku-chat.ts';
import { loadFelder, type FelderSchema } from '../lib/anlagen-katalog.ts';

export interface ExtraktionInput {
  text: string;
  anlagen: string[];
  vz?: number | string;
}

export interface AnlageResult {
  anlage: string;
  fieldCount: number;
  filled: number;
  /** Legacy: Werte für Person A / einzige Instanz. Bleibt für Backward-Compat. */
  values: Record<string, string | null>;
  /**
   * Multi-Instanz-Werte. Bei Ehegatten-Veranlagung kommen Anlagen wie KAP / N /
   * AV / VOR zweimal vor (Person A + Person B). Jede Instanz hat ihre eigenen
   * Werte. Wenn `instances` nur 1 Eintrag hat, ist das Dokument einzeln veranlagt
   * oder die Anlage kommt nur einmal vor.
   */
  instances: Array<{
    person: 'A' | 'B' | string;
    label?: string;
    values: Record<string, string | null>;
  }>;
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

function compactSpecLine(s: FieldSpec): string {
  // Eine Zeile pro Feld, ca. 40-60% Tokens gespart vs. JSON-Formatting.
  // Format: eCode | Z<zeile> | <drucktext>[ | PFLICHT]
  const parts = [s.eCode];
  if (s.vordruckzeile) parts.push('Z' + s.vordruckzeile);
  if (s.drucktext) parts.push(s.drucktext.slice(0, 80));
  if (s.pflicht) parts.push('PFLICHT');
  return parts.join(' | ');
}

function buildPrompt(anlage: string, spec: FieldSpec[], text: string, maxChars: number): string {
  const specText = spec.map(compactSpecLine).join('\n');
  return [
    `ELSTER-Anlage "${anlage}" aus deutschem Steuerdokument extrahieren.`,
    '',
    'EHEGATTEN: Bei Zusammenveranlagung kann die Anlage ZWEIMAL vorkommen (Person A = Ehemann / B = Ehefrau).',
    'Marker im Text: "(Ehefrau / Person B)", "(Person A)", "(Ehemann)", "Steuerpflichtige Person". Liefere beide Instanzen.',
    '',
    'REGELN: Beträge mit Komma ("12345,67"), fehlend=null, nur eCodes aus Liste.',
    '',
    'ANTWORT-JSON (keine Erklärung, kein Markdown):',
    '{"instances":[{"person":"A","label":"Ehemann","values":{"E...":"...","E...":null}},{"person":"B","label":"Ehefrau","values":{...}}]}',
    'Nur eine Person: {"instances":[{"person":"A","values":{...}}]}',
    '',
    `FELDER (eCode | Zeile | Drucktext | [PFLICHT]), ${spec.length} Stück:`,
    specText,
    '',
    '--- OCR-TEXT ---',
    text.slice(0, maxChars),
  ].join('\n');
}

async function extractOne(
  anlage: string,
  text: string,
  config: Required<ExtraktionConfig>,
  vz: number | string | undefined,
  signal?: AbortSignal,
): Promise<AnlageResult> {
  const t0 = Date.now();
  const raw = await loadFelder(anlage, vz);
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

  const { parsed } = await chatJson<{
    instances?: Array<{
      person?: string;
      label?: string;
      values?: Record<string, unknown>;
    }>;
    // Backward-compat: falls Haiku doch das alte Schema liefert
    values?: Record<string, unknown>;
  }>(prompt, {
    model: config.model,
    temperature: config.temperature,
    signal,
    maxTokens: 8000,
  });

  const allowed = new Set(spec.map((s) => s.eCode));

  // Normalisiere zu instances[] auch für Legacy-Responses
  let rawInstances: Array<{ person?: string; label?: string; values?: Record<string, unknown> }>;
  if (Array.isArray(parsed.instances) && parsed.instances.length > 0) {
    rawInstances = parsed.instances;
  } else if (parsed.values && typeof parsed.values === 'object') {
    rawInstances = [{ person: 'A', values: parsed.values }];
  } else {
    rawInstances = [{ person: 'A', values: {} }];
  }

  const instances: AnlageResult['instances'] = [];
  let totalFilled = 0;
  // Legacy: values aus Person A
  let legacyValues: Record<string, string | null> = {};

  for (let idx = 0; idx < rawInstances.length; idx += 1) {
    const ri = rawInstances[idx];
    const person = (ri.person || (idx === 0 ? 'A' : 'B')).toUpperCase();
    const values: Record<string, string | null> = {};
    let filledInst = 0;
    for (const [k, v] of Object.entries(ri.values ?? {})) {
      if (!allowed.has(k)) continue;
      if (v === null || v === '' || v === undefined) {
        values[k] = null;
      } else {
        values[k] = String(v);
        filledInst += 1;
      }
    }
    if (filledInst === 0 && idx > 0) continue; // leere B-Instanz skippen
    instances.push({ person, label: ri.label, values });
    totalFilled += filledInst;
    if (idx === 0) legacyValues = values;
  }

  if (instances.length === 0) {
    instances.push({ person: 'A', values: {} });
  }

  return {
    anlage,
    fieldCount: spec.length,
    filled: totalFilled,
    values: legacyValues,
    instances,
    durationMs: Date.now() - t0,
  };
}

function resolveConfig(c: ExtraktionConfig): Required<ExtraktionConfig> {
  return {
    model: c.model ?? 'claude-haiku-4-5',
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
          const r = await extractOne(anlage, input.text, config, input.vz, ctx.signal);
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
