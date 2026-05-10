/**
 * elster-v3/page-split — Multi-Doc Splitter Stage
 *
 * Nimmt das OCR-Output und teilt es in logische Sub-Dokumente auf, basierend
 * auf den Markdown-Headern (`# ...`) der OCR-Pages. Ein VaSt-Bundle hat z.B.
 * 5 Seiten mit jeweils einem eigenen `#`-Header — das sind 5 separate Belege.
 *
 * Output: `subDocs[]` Array mit `{ id, title, text, pages, headerKind }` —
 * jeder sub-doc bekommt seine eigene Klassifizierung+Layer1+Layer2+Rules.
 *
 * Strategie:
 * 1. Pro OCR-Page: erkenne den ersten `# ...` Header.
 * 2. Page mit gleichem Header-Kind (= header-text mod stopwords) wird zur
 *    aktiven Section gruppiert. Wenn der Header sich ändert → neuer sub-doc.
 * 3. Pages ohne `#`-Header werden an den vorigen sub-doc angehängt
 *    (Folgeseiten ohne neuen Titel).
 * 4. Synthetische `headerKind` Mapping für Klassifizierer-Bias:
 *    - "religionszugehörigkeit" → religionszugehoerigkeit
 *    - "lohnsteuerbescheinigung" → lohnsteuerbescheinigung_kapital
 *    - "mitteilung über freigestellte kapitalerträge" → mitteilung_kapitalertraege
 *    - "steuerbescheinigung" → steuerbescheinigung_kapitalertraege
 *    - "hauptvordruck est" → personaldaten_hauptvordruck
 *    - "spende" / "spendenquittung" / "zuwendungsbestätigung" → spendenquittung
 *
 * Idempotent + deterministic. Kein LLM-Call.
 */
import { defineStage } from '../../../core/stage.ts';

export interface PageSplitInput {
  ocr: {
    pages: Array<{ index: number; markdown: string; chars?: number }>;
    text?: string;
  };
}

export interface SubDoc {
  id: string;                 // "subdoc-0", "subdoc-1", ...
  title: string;              // erstes `#` Header-Text
  headerKind: string;         // normalisiert: "religionszugehoerigkeit" etc.
  text: string;               // markdown der Pages
  pages: number[];            // welche Page-Indizes gehören dazu
  classifierHint: string | null; // doc_class hint für klassifizierung stage (kann null sein → fallback regex+LLM)
}

export interface PageSplitOutput {
  subDocs: SubDoc[];
  totalPages: number;
  splitStrategy: 'header-grouped' | 'single';
}

const HEADER_RX = /^#\s+(.+?)\s*$/m;

function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c] ?? c))
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Map header-text to a doc_class hint for the klassifizierung stage. */
function mapHeaderToDocClass(headerNorm: string): string | null {
  if (headerNorm.includes('religionszugehoerigkeit')) return 'religionszugehoerigkeit';
  if (headerNorm.includes('lohnsteuerbescheinigung')) return 'lohnsteuerbescheinigung_kapital';
  if (headerNorm.includes('mitteilung') && headerNorm.includes('kapitalertr')) return 'mitteilung_kapitalertraege';
  if (headerNorm.includes('mitteilung') && headerNorm.includes('freigestellt')) return 'mitteilung_kapitalertraege';
  if (headerNorm.includes('steuerbescheinigung') && headerNorm.includes('kapitalertr')) return 'steuerbescheinigung_kapitalertraege';
  if (headerNorm.includes('jahressteuerbescheinigung')) return 'steuerbescheinigung_kapitalertraege';
  if (headerNorm.includes('hauptvordruck')) return 'personaldaten_hauptvordruck';
  if (headerNorm.includes('einkommensteuererklaerung')) return 'personaldaten_hauptvordruck';
  if (headerNorm.includes('spendenquittung')) return 'spendenquittung';
  if (headerNorm.includes('zuwendungsbestaetigung')) return 'spendenquittung';
  if (headerNorm.includes('spende')) return 'spendenquittung';
  if (headerNorm.includes('rentenbezugsmitteilung')) return 'rentenbezug';
  return null;
}

export const pageSplitStage = defineStage<PageSplitInput, PageSplitOutput, Record<string, never>>({
  id: 'elster-v3/page-split',
  name: 'ELSTER-v3 Page Splitter — multi-doc bundle decomposition',
  description:
    'Teilt mehrseitige OCR-Bundles in logische Sub-Dokumente auf, basierend auf Markdown-' +
    'Headern. Output ist subDocs[]; nachgelagerte Stages iterieren über die Sub-Dokumente.',

  async run(input, ctx) {
    const pages = input.ocr?.pages ?? [];
    if (pages.length === 0) {
      return { subDocs: [], totalPages: 0, splitStrategy: 'single' };
    }

    // Single-page bundle → trivial single sub-doc
    if (pages.length === 1) {
      const md = pages[0].markdown ?? '';
      const m = md.match(HEADER_RX);
      const title = m ? m[1] : '(untitled)';
      const headerKind = normalizeHeader(title);
      const sd: SubDoc = {
        id: 'subdoc-0',
        title,
        headerKind,
        text: md,
        pages: [pages[0].index ?? 0],
        classifierHint: mapHeaderToDocClass(headerKind),
      };
      ctx.emit('split_done', { subDocCount: 1, strategy: 'single' });
      await ctx.artifacts.write('subdocs.json', { subDocs: [sd], totalPages: 1, splitStrategy: 'single' });
      return { subDocs: [sd], totalPages: 1, splitStrategy: 'single' };
    }

    // Multi-page: walk pages, start a new sub-doc when header changes
    const subDocs: SubDoc[] = [];
    let cur: SubDoc | null = null;

    for (const p of pages) {
      const md = p.markdown ?? '';
      const pageIdx = p.index ?? subDocs.length;
      const m = md.match(HEADER_RX);
      const newTitle = m ? m[1] : null;
      const newKind = newTitle ? normalizeHeader(newTitle) : null;

      const isNewSection =
        !cur ||                                                  // first page
        (newKind && newKind !== cur.headerKind) ||              // header changed
        (newKind && cur.pages.length > 0 && cur.headerKind === newKind && cur.pages.includes(pageIdx - 1) === false);

      if (isNewSection && newTitle && newKind) {
        cur = {
          id: `subdoc-${subDocs.length}`,
          title: newTitle,
          headerKind: newKind,
          text: md,
          pages: [pageIdx],
          classifierHint: mapHeaderToDocClass(newKind),
        };
        subDocs.push(cur);
      } else if (cur) {
        // Append to current sub-doc (continuation page or same header repeated)
        cur.text += '\n\n' + md;
        cur.pages.push(pageIdx);
      } else {
        // Page without header AND no current sub-doc → start an unnamed one
        cur = {
          id: `subdoc-${subDocs.length}`,
          title: '(untitled)',
          headerKind: 'unknown',
          text: md,
          pages: [pageIdx],
          classifierHint: null,
        };
        subDocs.push(cur);
      }
    }

    ctx.emit('split_done', {
      subDocCount: subDocs.length,
      strategy: 'header-grouped',
      titles: subDocs.map((s) => s.title.slice(0, 60)),
    });

    const out: PageSplitOutput = {
      subDocs,
      totalPages: pages.length,
      splitStrategy: 'header-grouped',
    };
    await ctx.artifacts.write('subdocs.json', out);
    return out;
  },
});
