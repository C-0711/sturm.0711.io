/**
 * gemma-vision-ocr-zoning — EIN combined Gemma-4 vLLM Vision-Call der
 * gleichzeitig OCR macht UND in logische Dokument-Blöcke aufteilt.
 *
 * Statt zweistufig (OCR → Zoning) emittiert das strict json_schema die
 * Dokument-Blöcke DIREKT mit ihren zugehörigen OCR-Zeilen:
 *
 *   erkannte_dokumente: [
 *     {
 *       dokumenten_typ: 'Lohnsteuerbescheinigung',
 *       gehoert_zu_person: 'A',
 *       ocr_zeilen: [{zeilen_nr: 0, text: "..."}, {zeilen_nr: 1, ...}, ...]
 *     },
 *     ...
 *   ]
 *
 * Vorteile:
 *   - 1 Call statt 2 → ~5-10s schneller
 *   - Pro-Block-Zeilen sind bereits isoliert (Solver iteriert nicht über
 *     globalen Stream + Range-Filter — direkt erkannte_dokumente[i].ocr_zeilen)
 *   - Person-A/B-Suffix steht unverrückbar fest ab Frame 1
 *
 * Ersetzt `gemma-vision-ocr` in elster-v5_4 (klassifizierung-driven Hybrid).
 *
 * vLLM image-Limit: 10 Bilder pro Call (Gemma-4 hard limit). PDFs mit
 * >10 Seiten werden auf 10 truncated (mit warning). Multi-Batch-Modus für
 * längere Beleg-Stacks kommt als separater Folge-Workstream.
 *
 * Output-Shape ist SUPERSET von gemma-vision-ocr:
 *   - pages[], text, chars, model, ms (reconstructed aus erkannte_dokumente
 *     für Downstream-Kompatibilität)
 *   - erkannte_dokumente[] (NEU — primärer Output)
 */
import { extname } from 'node:path';
import { defineStage } from '../core/stage.ts';
import { renderPdfToPng } from '../lib/pdf-render.ts';
import { callVllmVision } from '../lib/vllm-vision.ts';

export interface GemmaVisionOcrZoningInput {
  filePath: string;
  filename: string;
}

export interface GemmaVisionOcrZoningConfig {
  vllmUrl?: string;
  model?: string;
  /** PDF render DPI. Default 200. */
  dpi?: number;
  /** max_tokens für den einzelnen kombinierten Call. Default 8192 — kritisch
   *  weil das Modell das KOMPLETTE OCR-Transkript inkl. JSON-Overhead für
   *  alle Seiten in einem Pass generieren muss. */
  maxTokens?: number;
  /** Timeout für den Call. Default 180s. */
  timeoutMs?: number;
  /** Hard cap auf gerenderten PDF-Seiten. Default 10 (Gemma-4 image-Limit).
   *  Bei mehr Seiten wird auf die ersten 10 truncated. */
  maxPages?: number;
}

export type DokumentenTyp =
  | 'Hauptvordruck_ESt1A'
  | 'Anlage_N'
  | 'Anlage_KAP'
  | 'Anlage_Vorsorgeaufwand'
  | 'Anlage_Sonderausgaben'
  | 'Lohnsteuerbescheinigung'
  | 'Steuerbescheinigung_Bank'
  | 'VAST_Bescheinigung'
  | 'Religionszugehoerigkeit'
  | 'Mitteilung_Kapitalertraege'
  | 'Spendenquittung'
  | 'Rentenbezugsmitteilung'
  // Erweiterung: vollständige 11-Datenarten-Abdeckung der VaSt (ERiC §9.9)
  | 'Beitragsmitteilung_KV'             // VaSt_KRV — KV/PV-Beiträge vom Versicherer
  | 'Riester_Bescheinigung'             // VaSt_RIE — § 10a EStG
  | 'Basisrenten_Bescheinigung'         // VaSt_RUE — Rürup
  | 'Lohnersatzleistungen_Mitteilung'   // VaSt_LErsL — ALG/KUG/Krankengeld
  | 'VWL_Bescheinigung'                 // VaSt_VWL — Vermögenswirksame Leistungen
  | 'Behindertenmerkmale_Mitteilung'    // VaSt_GDB — Grad der Behinderung
  | 'Unbekanntes_Dokument';

export interface OcrZeile {
  zeilen_nr: number;
  text: string;
}

export interface ErkanntesDocument {
  dokumenten_typ: DokumentenTyp;
  gehoert_zu_person: 'A' | 'B' | 'Gemeinsam' | 'Unbekannt';
  /** Exakt abgelesener Text dieses Dokuments, Zeile für Zeile. */
  ocr_zeilen: OcrZeile[];
}

export interface GemmaVisionOcrZoningOutput {
  model: string;
  /** Reconstructed pro-Seite Markdown (für Backward-Compat mit
   *  Konsumenten die `pages[].markdown` erwarten). Aus erkannte_dokumente
   *  zusammengebaut — Mapping Block→Seite ist heuristisch (alle Zeilen eines
   *  Blocks gelten als zur "Block-Seite" gehörig, sequenziell numeriert). */
  pages: Array<{ index: number; markdown: string; chars: number }>;
  /** Flat OCR-Text — alle erkannte_dokumente[*].ocr_zeilen joined. */
  text: string;
  chars: number;
  /** Primärer Output: pro logisches Dokument ein Block mit isolierten Zeilen. */
  erkannte_dokumente: ErkanntesDocument[];
  ms: number;
  /** Wie viele PDF-Seiten beim Render entstanden + an vLLM gegangen. */
  pageCount: number;
  /** True wenn maxPages-Cap getriggert wurde (Eingabe war länger). */
  truncated: boolean;
}

const SYSTEM_PROMPT =
  'Du bist ein hochpräziser Document-Layout-Analyzer und OCR-Extraktor für ' +
  'deutsche Steuerdokumente.\n' +
  'Lies den Text auf den übergebenen Bildern präzise von oben links nach ' +
  'unten rechts.\n\n' +
  'AUFGABE:\n' +
  '1. Gruppiere die Seiten in logische Dokumente (z.B. Hauptvordruck, ' +
  'Anlage N, Lohnsteuerbescheinigung, einzelne Bankbescheinigungen).\n' +
  '2. Ordne jedes Dokument der korrekten Person zu (Steuerpflichtiger/' +
  'Ehemann = Person A, Ehefrau = Person B, Gemeinsam). Achte auf Namen oder ' +
  'Labels wie "(Ehefrau / Person B)".\n' +
  '3. Extrahiere den GESAMTEN Text des Dokuments absolut lückenlos, Zeile ' +
  'für Zeile.\n' +
  '4. Gib jeder Zeile eine fortlaufende `zeilen_nr`, beginnend bei 1 für ' +
  'die allererste Zeile auf dem ersten Bild. Zähle dokumentenübergreifend ' +
  'logisch weiter.\n' +
  '5. LASS KEINE ZAHLEN, BETRÄGE ODER CENT-WERTE AUS! Das ist für die ' +
  'nachfolgende mathematische Auditierung kritisch.';

const SCHEMA = {
  name: 'vision_ocr_and_zoning',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['erkannte_dokumente'],
    properties: {
      erkannte_dokumente: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['dokumenten_typ', 'gehoert_zu_person', 'ocr_zeilen'],
          properties: {
            dokumenten_typ: {
              type: 'string',
              enum: [
                'Hauptvordruck_ESt1A',
                'Anlage_N',
                'Anlage_KAP',
                'Anlage_Vorsorgeaufwand',
                'Anlage_Sonderausgaben',
                'Lohnsteuerbescheinigung',
                'Steuerbescheinigung_Bank',
                'VAST_Bescheinigung',
                'Religionszugehoerigkeit',
                'Mitteilung_Kapitalertraege',
                'Spendenquittung',
                'Rentenbezugsmitteilung',
                // Vollständige VaSt-Abdeckung (ERiC §9.9):
                'Beitragsmitteilung_KV',
                'Riester_Bescheinigung',
                'Basisrenten_Bescheinigung',
                'Lohnersatzleistungen_Mitteilung',
                'VWL_Bescheinigung',
                'Behindertenmerkmale_Mitteilung',
                'Unbekanntes_Dokument',
              ],
            },
            gehoert_zu_person: {
              type: 'string',
              enum: ['A', 'B', 'Gemeinsam', 'Unbekannt'],
            },
            ocr_zeilen: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['zeilen_nr', 'text'],
                properties: {
                  zeilen_nr: { type: 'integer' },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

async function pagePathsForInput(
  filePath: string,
  filename: string,
  dpi: number,
  maxPages: number,
): Promise<{ paths: string[]; cleanup: () => Promise<void>; truncated: boolean }> {
  const ext = extname(filename).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    return { paths: [filePath], cleanup: async () => {}, truncated: false };
  }
  if (ext !== '.pdf') throw new Error(`gemma-vision-ocr-zoning: unsupported extension ${ext}`);
  // Render ALL pages first, then truncate if needed (logs the truncation)
  const rendered = await renderPdfToPng(filePath, { dpi, maxPages: 64 });
  const total = rendered.pngPaths.length;
  const truncated = total > maxPages;
  const paths = truncated ? rendered.pngPaths.slice(0, maxPages) : rendered.pngPaths;
  return { paths, cleanup: async () => {}, truncated };
}

/** Rebuilds backward-compatible `pages[]` shape from erkannte_dokumente.
 *  Each block becomes one "page" — downstream-Konsumenten die `pages[]`
 *  iterieren behalten ein konsistentes Interface, auch wenn die Block-
 *  Aufteilung nicht 1:1 mit PDF-Seiten korrespondiert. */
function reconstructPages(blocks: ErkanntesDocument[]): Array<{
  index: number; markdown: string; chars: number;
}> {
  return blocks.map((block, i) => {
    const md = block.ocr_zeilen.map((z) => z.text).join('\n');
    return { index: i, markdown: md, chars: md.length };
  });
}

export const gemmaVisionOcrZoningStage = defineStage<
  GemmaVisionOcrZoningInput,
  GemmaVisionOcrZoningOutput,
  GemmaVisionOcrZoningConfig
>({
  id: 'gemma-vision-ocr-zoning',
  name: 'Gemma-4 Vision OCR + Document Zoning (combined)',
  description:
    'EIN vLLM-Call: nimmt alle PDF-Seiten als Bilder + strict json_schema ' +
    'das den Output in Dokument-Blöcke mit pro-Block ocr_zeilen[] zwingt. ' +
    'Ersetzt gemma-vision-ocr in v5_4 — Solver bekommt direkt isolierte ' +
    'Anlagen-Blöcke mit Person-A/B-Zuordnung.',
  hints: {
    inputs: 'filePath, filename',
    outputs: 'model, pages, text, erkannte_dokumente[], pageCount, truncated, ms',
    configExample: '{"model":"gemma4-mm","dpi":200,"maxTokens":8000,"timeoutMs":180000,"maxPages":10}',
    inputPorts: [
      { name: 'filePath', type: 'file-path' },
      { name: 'filename', type: 'string' },
    ],
    outputPorts: [
      { name: 'text', type: 'text' },
      { name: 'pages', type: 'pages' },
      { name: 'erkannte_dokumente', type: 'json' },
    ],
  },

  async run(input, ctx) {
    if (!input?.filePath) throw new Error('gemma-vision-ocr-zoning: filePath fehlt');
    if (!input?.filename) throw new Error('gemma-vision-ocr-zoning: filename fehlt');

    const t0 = Date.now();
    const vllmUrl = ctx.config?.vllmUrl ?? process.env['VLLM_URL'] ?? 'http://localhost:11435';
    const model = ctx.config?.model ?? 'gemma4-mm';
    const dpi = ctx.config?.dpi ?? 200;
    const maxTokens = ctx.config?.maxTokens ?? 8192;
    const timeoutMs = ctx.config?.timeoutMs ?? 180_000;
    const maxPages = ctx.config?.maxPages ?? 10;

    const { paths, cleanup, truncated } = await pagePathsForInput(
      input.filePath, input.filename, dpi, maxPages,
    );

    try {
      ctx.emit('gemma_vision_ocr_zoning_started', {
        pages: paths.length, model, dpi, truncated, maxPages,
      });

      // EIN Call mit allen Bildern + kombiniertem Schema
      const result = await callVllmVision<{ erkannte_dokumente: ErkanntesDocument[] }>({
        vllmUrl, model,
        imagePaths: paths,
        textInstructions: SYSTEM_PROMPT,
        jsonSchema: SCHEMA,
        maxTokens, temperature: 0, timeoutMs,
        signal: ctx.signal,
      });

      const erkannte_dokumente = Array.isArray(result.parsed?.erkannte_dokumente)
        ? result.parsed.erkannte_dokumente
        : [];

      const pages = reconstructPages(erkannte_dokumente);
      const text = pages.map((p) => p.markdown).join('\n\n');
      const ms = Date.now() - t0;

      ctx.emit('gemma_vision_ocr_zoning_done', {
        pageCount: paths.length,
        blockCount: erkannte_dokumente.length,
        chars: text.length,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        finishReason: result.finishReason,
        ms,
        truncated,
      });
      return {
        model,
        pages,
        text,
        chars: text.length,
        erkannte_dokumente,
        ms,
        pageCount: paths.length,
        truncated,
      };
    } finally {
      await cleanup();
    }
  },
});
