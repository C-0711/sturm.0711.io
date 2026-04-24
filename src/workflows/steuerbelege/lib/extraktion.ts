import { chatJson } from '../../elster/lib/mistral-chat.ts';
import { claudeChatJson } from '../../elster/lib/claude-chat.ts';
import { loadFelder, type FelderSchema } from '../../elster/lib/anlagen-katalog.ts';

type Feld = FelderSchema['felder'][number];

export interface AnlageExtraktion {
  anlage: string;
  values: Record<string, string | null>;
  filled: number;
  fieldCount: number;
  quelle: 'hints' | 'ranking';
  ms: number;
  /** Claude-Rescue was invoked (Mistral result was incomplete vs. OCR evidence). */
  rescued?: boolean;
  rescueModel?: string;
  rescueMs?: number;
  rescueReason?: string;
}

export interface ExtractAnlageArgs {
  anlage: string;
  label: string;
  hints: string[];
  text: string;
  vz?: number | string;
  model?: string;
  maxFieldsFallback?: number;
  maxTextChars?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Rescue (Claude fallback) config. Default: enabled with haiku-4-5. */
  rescue?: {
    enabled?: boolean;
    model?: string;
    /** Re-extract if fewer than this fraction of hint-fields were filled. */
    minFilledRatio?: number;
  };
}

function extractable(all: Feld[]): Feld[] {
  return all.filter((f) => /^E\d+$/.test(f.Name));
}

function rankAndSlice(felder: Feld[], maxFields: number): Feld[] {
  if (felder.length <= maxFields) return felder;
  return felder
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
    .sort((a, b) => a.i - b.i)
    .map((s) => s.f);
}

interface FieldSpec {
  eCode: string;
  drucktext: string;
  vordruckzeile: string | null;
  format: string | null;
  pflicht: boolean;
}

function spec(f: Feld): FieldSpec {
  return {
    eCode: f.Name,
    drucktext: f.Drucktext || f.Beschreibung,
    vordruckzeile: f.Vordruckzeile || null,
    format: f.Formatkennzeichen || null,
    pflicht: f.pflicht,
  };
}

function buildPrompt(
  label: string,
  anlage: string,
  felder: FieldSpec[],
  text: string,
  maxChars: number,
): string {
  return [
    `Du bekommst den OCR-Text eines einzelnen Belegs vom Typ "${label}".`,
    `Der Beleg fliesst in die ELSTER-Anlage "${anlage}" ein.`,
    'Für jedes der unten gelisteten Felder: finde im Text den passenden Wert oder gib null zurück.',
    'Beträge als Zeichenkette mit Komma (z. B. "12345,67"). Text als Zeichenkette.',
    'Gib nur Werte zurück, die tatsächlich im Beleg stehen — rate nicht.',
    'Wenn der Beleg Zeilennummern erwähnt (z. B. "Zeile 7 Anlage KAP"), nutze das feld-Attribut "vordruckzeile" als Anker.',
    '',
    'Antworte ausschließlich als JSON in dieser Form:',
    '{"values": {"E0200204": "12345,67", "E0200304": null}}',
    '',
    'Felder:',
    JSON.stringify(felder, null, 2),
    '',
    '--- Beleg-Text ---',
    text.slice(0, maxChars),
  ].join('\n');
}

/**
 * Quality-Gate: entscheide ob ein Claude-Rescue-Pass nötig ist.
 * Trigger wenn:
 *  (a) weniger als `minFilledRatio` der Hint-Felder gefüllt, ODER
 *  (b) ein Hint-Feld ist null, aber sein Drucktext (oder eine signifikante Vordruckzeile)
 *      taucht im OCR-Text auf → starke Evidenz, dass der Wert da ist.
 */
function needsRescue(
  specs: FieldSpec[],
  values: Record<string, string | null>,
  filled: number,
  ocr: string,
  minFilledRatio: number,
): { rescue: boolean; reason: string } {
  if (specs.length === 0) return { rescue: false, reason: 'no-specs' };

  const ratio = filled / specs.length;
  if (ratio < minFilledRatio) {
    return { rescue: true, reason: `filled-ratio ${ratio.toFixed(2)} < ${minFilledRatio}` };
  }

  // Evidence check: for nulled fields, is there a strong OCR hit on the drucktext head?
  for (const s of specs) {
    if (values[s.eCode] != null) continue;
    const head = (s.drucktext || '').trim().split(/\s+/).slice(0, 3).join(' ');
    if (head.length < 6) continue; // too short to be meaningful
    if (ocr.toLowerCase().includes(head.toLowerCase())) {
      return {
        rescue: true,
        reason: `evidence: "${head}" present in OCR but ${s.eCode} is null`,
      };
    }
  }
  return { rescue: false, reason: 'complete' };
}

export async function extractOneAnlage(args: ExtractAnlageArgs): Promise<AnlageExtraktion> {
  const t0 = Date.now();
  const model = args.model ?? 'mistral-small-latest';
  const maxFieldsFallback = args.maxFieldsFallback ?? 60;
  const maxTextChars = args.maxTextChars ?? 40_000;
  const temperature = args.temperature ?? 0;

  const rescueCfg = {
    enabled: args.rescue?.enabled ?? true,
    model: args.rescue?.model ?? 'claude-haiku-4-5',
    minFilledRatio: args.rescue?.minFilledRatio ?? 0.6,
  };

  const raw = await loadFelder(args.anlage, args.vz);
  const alleExtrahierbar = extractable(raw.felder);

  let felder: Feld[];
  let quelle: 'hints' | 'ranking';
  if (args.hints.length > 0) {
    const hintSet = new Set(args.hints);
    felder = alleExtrahierbar.filter((f) => hintSet.has(f.Name));
    if (felder.length === 0) {
      felder = rankAndSlice(alleExtrahierbar, maxFieldsFallback);
      quelle = 'ranking';
    } else {
      quelle = 'hints';
    }
  } else {
    felder = rankAndSlice(alleExtrahierbar, maxFieldsFallback);
    quelle = 'ranking';
  }

  const specs = felder.map(spec);
  const prompt = buildPrompt(args.label, args.anlage, specs, args.text, maxTextChars);
  const allowed = new Set(specs.map((s) => s.eCode));

  // ── PASS 1: Mistral (fast + cheap) ──────────────────────────
  const { parsed } = await chatJson<{ values?: Record<string, unknown> }>(prompt, {
    model,
    temperature,
    signal: args.signal,
  });

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
  // Seed missing keys as null so the evidence-check can see them.
  for (const s of specs) {
    if (!(s.eCode in values)) values[s.eCode] = null;
  }

  // ── QUALITY GATE ────────────────────────────────────────────
  let rescued = false;
  let rescueModel: string | undefined;
  let rescueMs: number | undefined;
  let rescueReason: string | undefined;

  if (rescueCfg.enabled && quelle === 'hints') {
    const gate = needsRescue(specs, values, filled, args.text, rescueCfg.minFilledRatio);
    if (gate.rescue) {
      const rT0 = Date.now();
      try {
        const { parsed: rParsed, model: rModelReal } = await claudeChatJson<{
          values?: Record<string, unknown>;
        }>(prompt, {
          model: rescueCfg.model,
          temperature: 0,
          signal: args.signal,
        });
        rescueMs = Date.now() - rT0;
        rescueModel = rModelReal;
        rescueReason = gate.reason;

        // Merge: Claude values override Mistral-null.  Claude-null does NOT overwrite Mistral-value.
        let newFilled = filled;
        for (const [k, v] of Object.entries(rParsed.values ?? {})) {
          if (!allowed.has(k)) continue;
          if (v === null || v === '' || v === undefined) continue;
          if (values[k] == null) {
            values[k] = String(v);
            newFilled += 1;
          }
        }
        if (newFilled > filled) {
          rescued = true;
          filled = newFilled;
        }
      } catch (err) {
        // Rescue failed — log into reason and keep Mistral result.
        rescueReason = `${gate.reason} | rescue-error: ${(err as Error).message.slice(0, 120)}`;
        rescueMs = Date.now() - rT0;
      }
    }
  }

  return {
    anlage: args.anlage,
    values,
    filled,
    fieldCount: specs.length,
    quelle,
    ms: Date.now() - t0,
    ...(rescued && { rescued: true }),
    ...(rescueModel && { rescueModel }),
    ...(rescueMs !== undefined && { rescueMs }),
    ...(rescueReason && { rescueReason }),
  };
}

export interface BelegExtraktionResult {
  values: Record<string, Record<string, string | null>>;
  perAnlage: AnlageExtraktion[];
  filled: number;
  fieldCount: number;
}

/** Extrahiert parallel pro Anlage — für einen einzelnen (Sub-)Beleg. */
export async function extractForAnlagen(
  label: string,
  anlagen: string[],
  ecodeHintsProAnlage: Record<string, string[]>,
  text: string,
  opts: Omit<ExtractAnlageArgs, 'anlage' | 'label' | 'hints' | 'text'> & {
    onAnlageDone?: (r: AnlageExtraktion) => void;
  } = {},
): Promise<BelegExtraktionResult> {
  const results = await Promise.all(
    anlagen.map((anlage) =>
      extractOneAnlage({
        anlage,
        label,
        hints: ecodeHintsProAnlage[anlage] ?? [],
        text,
        vz: opts.vz,
        model: opts.model,
        maxFieldsFallback: opts.maxFieldsFallback,
        maxTextChars: opts.maxTextChars,
        temperature: opts.temperature,
        signal: opts.signal,
        rescue: opts.rescue,
      }).then((r) => {
        opts.onAnlageDone?.(r);
        return r;
      }),
    ),
  );

  const values: Record<string, Record<string, string | null>> = {};
  let filled = 0;
  let fieldCount = 0;
  for (const r of results) {
    values[r.anlage] = r.values;
    filled += r.filled;
    fieldCount += r.fieldCount;
  }
  return { values, perAnlage: results, filled, fieldCount };
}
