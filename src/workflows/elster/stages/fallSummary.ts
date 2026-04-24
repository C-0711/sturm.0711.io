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

function renderMarkdownReport(
  befund: { befund: string; hinweise: string[] },
  werte: AnrWert[],
  anlagen: string[],
): string {
  const byAnlagePerson = new Map<string, AnrWert[]>();
  for (const w of werte) {
    const p = (w as any).person || 'A';
    const key = `${w.anlage}:${p}`;
    if (!byAnlagePerson.has(key)) byAnlagePerson.set(key, []);
    byAnlagePerson.get(key)!.push(w);
  }

  const lines: string[] = [];
  lines.push('# STURM ELSTER-Report');
  lines.push('');
  lines.push('## Befund');
  lines.push(befund.befund);
  lines.push('');
  if (befund.hinweise.length > 0) {
    lines.push('## Hinweise');
    for (const h of befund.hinweise) lines.push('- ⚠️ ' + h);
    lines.push('');
  }
  lines.push(`## Erkannte Anlagen (${anlagen.length})`);
  lines.push(anlagen.join(', '));
  lines.push('');
  lines.push(`## Extrahierte Werte (${werte.length})`);
  lines.push('');
  const sortedKeys = [...byAnlagePerson.keys()].sort();
  for (const key of sortedKeys) {
    const [anlage, person] = key.split(':');
    const ws = byAnlagePerson.get(key)!;
    lines.push(`### Anlage ${anlage} — Person ${person} (${ws.length} Werte)`);
    for (const w of ws) {
      const zeile = w.vordruckzeile ? `Z${w.vordruckzeile}` : '—';
      const dt = (w.drucktext || w.beschreibung || '').slice(0, 80);
      lines.push(`- **${w.eCode}** · ${zeile} · ${dt} = \`${w.wert}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildPrompt(werte: AnrWert[], anlagen: string[]): string {
  const kompakt = kompaktWerte(werte, 60);
  const werteText = kompakt
    .map(
      (w) =>
        `[${w.anlage}${(w as any).person && (w as any).person !== 'A' ? '/' + (w as any).person : ''}] ${(w.drucktext || w.beschreibung || w.eCode).slice(0, 60)}: ${w.wert}`,
    )
    .join('\n');

  return [
    'Steuerberater-Assistent: Erstelle 1 Satz (max. 30 Wörter) für Mandanten-Chat + 0-3 Hinweise auf Lücken/Auffälligkeiten.',
    '',
    'Stil: "Erkannt: <DokumentTyp> für <Person(en)>, <wichtigste 2-3 Werte>."',
    'Beispiele:',
    '- "Erkannt: ESt-Erklärung 2023 für Rainer und Ute Stricker (Zusammenveranlagung), Bruttoarbeitslohn 63.560 €, Kapitalerträge 117 €."',
    '- "Erkannt: Steuerbescheinigung für Maria Ute Stricker, 11,25 € Kapitalerträge / 2,75 € KapESt."',
    '',
    'JSON NUR: {"befund":"...","hinweise":["...","..."]}',
    '',
    `ANLAGEN: ${anlagen.join(', ')}`,
    'WERTE:',
    werteText,
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
        maxTokens: 400,
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

      // Zusätzlich ein User-lesbarer Markdown-Report
      const md = renderMarkdownReport(out, werte, anlagen);
      await ctx.artifacts.write('fall_summary/report.md', md);

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
