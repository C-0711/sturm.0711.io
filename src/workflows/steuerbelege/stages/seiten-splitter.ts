import { defineStage } from '../../../core/stage.ts';

export interface OcrPage {
  index: number;
  markdown: string;
  chars: number;
}

export interface SeitenSplitterInput {
  pages: OcrPage[];
  text: string;
}

export interface SubBeleg {
  index: number;
  header: string;
  seiten: number[];
  text: string;
  chars: number;
}

export interface SeitenSplitterOutput {
  subBelege: SubBeleg[];
  methode: 'headings' | 'single';
  anzahlSeiten: number;
  ms: number;
}

export interface SeitenSplitterConfig {
  /**
   * Minimale Länge eines Sub-Belegs in Zeichen; kürzere Fragmente werden
   * dem vorigen Beleg angehängt (Filter gegen Boilerplate-Seiten).
   */
  minChars?: number;
}

const HEADING_RE = /^#\s+(.+)$/m;

function findHeading(markdown: string): string | null {
  const m = markdown.match(HEADING_RE);
  return m ? m[1].trim() : null;
}

export const seitenSplitterStage = defineStage<
  SeitenSplitterInput,
  SeitenSplitterOutput,
  SeitenSplitterConfig
>({
  id: 'steuerbelege/seiten-splitter',
  name: 'Seiten-Splitter',
  description:
    'Zerlegt ein Multi-Beleg-PDF nach Markdown-Headings (# …). Jeder Heading startet einen neuen Sub-Beleg; Folge-Seiten ohne Heading werden angehängt.',

  async run(input, ctx) {
    const t0 = Date.now();
    const minChars = ctx.config.minChars ?? 80;
    const pages = input.pages ?? [];

    if (pages.length === 0) {
      const out: SeitenSplitterOutput = {
        subBelege: [],
        methode: 'single',
        anzahlSeiten: 0,
        ms: Date.now() - t0,
      };
      await ctx.artifacts.write('seiten_splitter.json', out);
      return out;
    }

    type Builder = { header: string; seiten: number[]; parts: string[] };
    const groups: Builder[] = [];
    let current: Builder | null = null;

    for (const page of pages) {
      const header = findHeading(page.markdown);
      if (header) {
        current = { header, seiten: [page.index], parts: [page.markdown] };
        groups.push(current);
      } else if (current) {
        current.seiten.push(page.index);
        current.parts.push(page.markdown);
      } else {
        // Seiten vor dem ersten Heading — als eigenen „Kopf"-Block sammeln
        current = {
          header: 'Dokument-Kopf',
          seiten: [page.index],
          parts: [page.markdown],
        };
        groups.push(current);
      }
    }

    // Zu kurze Fragmente (z. B. Cover-Seiten) an Vorgänger anhängen
    const cleaned: Builder[] = [];
    for (const g of groups) {
      const text = g.parts.join('\n\n');
      if (text.length < minChars && cleaned.length > 0) {
        const prev = cleaned[cleaned.length - 1];
        prev.seiten.push(...g.seiten);
        prev.parts.push(...g.parts);
      } else {
        cleaned.push(g);
      }
    }

    const subBelege: SubBeleg[] = cleaned.map((g, i) => {
      const text = g.parts.join('\n\n');
      return {
        index: i,
        header: g.header,
        seiten: g.seiten,
        text,
        chars: text.length,
      };
    });

    const methode: SeitenSplitterOutput['methode'] =
      subBelege.length <= 1 ? 'single' : 'headings';

    ctx.emit('split_ergebnis', {
      anzahl: subBelege.length,
      methode,
      headers: subBelege.map((s) => s.header),
    });

    const out: SeitenSplitterOutput = {
      subBelege,
      methode,
      anzahlSeiten: pages.length,
      ms: Date.now() - t0,
    };
    await ctx.artifacts.write('seiten_splitter.json', out);
    return out;
  },
});
