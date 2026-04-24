import { defineStage } from '../../../core/stage.ts';
import { chatJson } from '../lib/haiku-chat.ts';

export interface SeitenChipsInput {
  pages: Array<{ index: number; markdown: string; chars: number }>;
}

export interface SeitenChip {
  seite: number;
  text: string;
  chars: number;
  durationMs: number;
  error?: string;
}

export interface SeitenChipsOutput {
  chips: SeitenChip[];
  ms: number;
}

export interface SeitenChipsConfig {
  model?: string;
  concurrency?: number;
  maxCharsPerPage?: number;
  temperature?: number;
}

function resolveConfig(c: SeitenChipsConfig): Required<SeitenChipsConfig> {
  return {
    model: c.model ?? 'claude-haiku-4-5',
    concurrency: c.concurrency ?? 4,
    maxCharsPerPage: c.maxCharsPerPage ?? 8000,
    temperature: c.temperature ?? 0,
  };
}

function buildPrompt(seite: number, gesamt: number, markdown: string, maxChars: number): string {
  return [
    `Seite ${seite}/${gesamt} einer deutschen Steuerunterlage. EIN deutscher Satz (max. 25 Wörter) mit Formularname/Dokumenttyp + 2-3 konkrete Werte.`,
    'NIEMALS mit "Seite X..." / "Diese Seite..." beginnen. IMMER mit Formularname/Dokumenttyp.',
    '',
    'Beispiele:',
    '- "Hauptvordruck ESt 1 A · StNr 02/171/51864 · Rainer Stricker, Techniker"',
    '- "Anlage N Z6-9 · Arbeitslohn 52.431 € · Werbungskosten 2.102 €"',
    '- "Steuerbescheinigung LBS · Kapitalerträge 36 € · KapESt 8,80 €"',
    '',
    'JSON NUR: {"satz": "..."}',
    '',
    '=== SEITE ===',
    markdown.slice(0, maxChars),
  ].join('\n');
}

async function chipOnePage(
  seite: number,
  gesamt: number,
  markdown: string,
  config: Required<SeitenChipsConfig>,
  signal?: AbortSignal,
): Promise<SeitenChip> {
  const t0 = Date.now();
  const chars = markdown.length;
  try {
    const { parsed } = await chatJson<{ satz?: string }>(
      buildPrompt(seite, gesamt, markdown, config.maxCharsPerPage),
      { model: config.model, temperature: config.temperature, signal, maxTokens: 180 },
    );
    const satz = (parsed.satz || '').trim();
    return {
      seite,
      text: satz || '(kein Inhalt erkannt)',
      chars,
      durationMs: Date.now() - t0,
    };
  } catch (e: any) {
    return {
      seite,
      text: `(Fehler: ${e?.message ?? 'unbekannt'})`,
      chars,
      durationMs: Date.now() - t0,
      error: String(e?.message ?? e),
    };
  }
}

export const seitenChipsStage = defineStage<
  SeitenChipsInput,
  SeitenChipsOutput,
  SeitenChipsConfig
>({
  id: 'elster/seiten-chips',
  name: 'Seiten-Chips (Roh-Zusammenfassung)',
  description:
    'Haiku erzeugt pro PDF-Seite einen 1-Satz-Chip aus dem Roh-OCR-Text. ' +
    'Liefert sofort User-sichtbares Feedback parallel zur strukturierten ' +
    'Extraktion. Läuft parallel zu klassifizierung/extraktion.',
  async run(input, ctx) {
    const config = resolveConfig(ctx.config ?? {});
    const t0 = Date.now();
    const pages = input.pages || [];
    const gesamt = pages.length;

    ctx.emit('chips_start', { pages: gesamt });

    const chips: SeitenChip[] = new Array(gesamt);
    let idx = 0;

    async function worker() {
      while (true) {
        const my = idx++;
        if (my >= gesamt) break;
        const p = pages[my];
        const seite = (p.index ?? my) + 1;
        const chip = await chipOnePage(seite, gesamt, p.markdown || '', config, ctx.signal);
        chips[my] = chip;
        ctx.emit('seite_chip', {
          seite: chip.seite,
          text: chip.text,
          chars: chip.chars,
          ms: chip.durationMs,
        });
        await ctx.artifacts.write(`seiten_chips/seite_${chip.seite}.json`, chip);
      }
    }

    const workers = Array.from({ length: Math.min(config.concurrency, gesamt) }, () => worker());
    await Promise.all(workers);

    const out: SeitenChipsOutput = { chips, ms: Date.now() - t0 };
    ctx.emit('chips_done', { count: chips.length, ms: out.ms });
    return out;
  },
});
