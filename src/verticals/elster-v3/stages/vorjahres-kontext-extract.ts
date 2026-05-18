/**
 * elster-v3/vorjahres-kontext-extract — extrahiert aus der OCR-Ausgabe einer
 * Vorjahres-Einkommensteuererklärung (PDF) den Mandanten-Kontext:
 *
 *   • erwartete Anlagen für das Folgejahr
 *   • Veranlagungsart (für Splittingtarif im BMF-Rechner)
 *   • Anzahl Kinder
 *   • Daueranschnitte (Pendlerpauschale, Werbungskosten, KV/RV-Beiträge)
 *   • fehlende Belege die für das Folgejahr erwartet werden
 *
 * Pipeline-Einsatz: läuft IM Workflow `vorjahres-kontext-extract` nach dem
 * gemma-vision-ocr-Stage. Das Schema (einkommensteuererklaerung_vorjahr.json)
 * deckt alle relevanten Anlagen ab. Bei >4 OCR-Seiten wird pro-Seite parallel
 * extrahiert (vLLM image-limit 10) und die nested-Outputs deep-merged (spätere
 * Seiten ergänzen nur fehlende Felder, überschreiben nichts).
 *
 * Output: { context: CaseContext, nested: <merged-JSON>, ms }.
 * Side-effect: artifact `vorjahres_kontext.json`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../../../core/stage.ts';
import { chatJson, type ChatProvider } from '../../../lib/llm-chat.ts';
import type { CaseContext } from '../../../server/applications.ts';
import { nestedToVorjahresKontext } from './vorjahres-kontext-mapper.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', 'data', 'nested_schemas', 'einkommensteuererklaerung_vorjahr.json');

export interface VorjahresKontextExtractInput {
  /** Per-Page OCR-Markdown vom gemma-vision-ocr-Stage. */
  pages?: Array<{ index: number; markdown: string; chars?: number }>;
  /** Volltext als Fallback wenn pages[] fehlt. */
  text?: string;
  /** Originalfilename — für Logging + artifact-Header. */
  filename?: string;
  /** Vorjahr (z.B. 2023) — wird in CaseContext.vorjahr abgelegt. Wenn nicht
   *  übergeben, wird es aus hauptvordruck.steuerjahr im nested-Output gelesen. */
  vorjahr?: number;
}

export interface VorjahresKontextExtractOutput {
  context: CaseContext;
  nested: Record<string, unknown>;
  ms: number;
  /** Diagnose: pro Seite was extrahiert wurde + Fehler. */
  perPage: Array<{ pageIndex: number; ms: number; ecodes?: number; error?: string }>;
}

export interface VorjahresKontextExtractConfig {
  /** LLM-Provider. Default 'vllm'. */
  provider?: ChatProvider;
  /** Override vLLM-URL. */
  vllmUrl?: string;
  /** Override Modell. Default 'gemma4-mm'. */
  model?: string;
  /** maxTokens pro Call. Default 4000 (größeres Schema als single-Beleg). */
  maxTokens?: number;
  /** Parallelität (max gleichzeitige Page-Calls). Default 5 — vLLM-image-limit 10. */
  concurrency?: number;
  /** Pro-Page-Timeout. Default 90s. */
  perPageTimeoutMs?: number;
  /** Schwellwert: wenn pages.length <= dies → single-call mit aggregated text.
   *  Default 4 (kürzere Erklärungen passen problemlos in einen Call). */
  singleCallPageThreshold?: number;
}

type NestedVorjahr = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Mergt zwei nested-Outputs: später (b) ergänzt nur Felder, die in a noch
 * leer/undefined sind. Arrays werden konkateniert (Anlage Kind über mehrere
 * Seiten, Anlage V Objekte, etc.).
 */
function mergeNested(a: NestedVorjahr, b: NestedVorjahr): NestedVorjahr {
  if (!isPlainObject(a)) return b;
  if (!isPlainObject(b)) return a;
  const out: Record<string, unknown> = { ...a };
  for (const [k, vb] of Object.entries(b)) {
    const va = out[k];
    if (va == null) { out[k] = vb; continue; }
    if (Array.isArray(va) && Array.isArray(vb)) {
      out[k] = [...va, ...vb];
      continue;
    }
    if (isPlainObject(va) && isPlainObject(vb)) {
      out[k] = mergeNested(va, vb);
      continue;
    }
    // Skalar bereits gefüllt → a gewinnt (first-write-wins).
  }
  return out;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.max(1, concurrency); w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

function basePrompt(jahr: number | undefined, scope: string): string {
  const jahrText = jahr ? ` ${jahr}` : '';
  return [
    `Du siehst ${scope} einer kompletten deutschen Einkommensteuererklärung${jahrText}.`,
    'Extrahiere ALLE Felder strict nach JSON-Schema. Wichtigste Sektionen:',
    '  • ESt1A Hauptvordruck: Stammdaten Person A + B, Adresse, IdNr, Bankverbindung.',
    '  • Veranlagungsart Z.19 → "zusammenveranlagung" bei Ehegatten-Splittingtarif,',
    '    "einzelveranlagung" bei getrennter Veranlagung, "ledig" sonst.',
    '  • Anlage SA: KirchSt gezahlt/erstattet, Spenden, Mitgliedsbeiträge.',
    '  • Anlage N: Bruttoarbeitslohn, LSt, SolZ, KiSt, Steuerklasse, Pendlerpauschale',
    '    (PLZ/Ort/Straße Arbeitsstätte, Arbeitstage, einfache Entfernung km),',
    '    Arbeitsmittel-Pauschale, weitere Werbungskosten (Kontoführung, Berufsverband,',
    '    Rechtsschutz, Fortbildung, Bewerbungen).',
    '  • Anlage KAP getrennt für Person A und Person B: Antrag Günstigerprüfung,',
    '    Kapitalerträge brutto, Sparerpauschbetrag, KESt + SolZ + KiSt.',
    '  • Anlage VOR: RV-AN + RV-AG, berufsständische, KV, PV, AV, Zusatzversorgung.',
    '  • Anlagen AV (Riester), Kind, V (Vermietung), R (Renten), AgB (außergewöhnliche',
    '    Belastungen) NUR befüllen wenn klar im Beleg sichtbar.',
    '',
    'WICHTIG: Beträge als Number (Deutsche Notation 1.234,56 → 1234.56). Daten',
    'als String DD.MM.YYYY. IdNr 11-stellig. PLZ 5-stellig. Bei mehreren Personen',
    'IMMER beide Personen separat erfassen.',
  ].join('\n');
}

export const vorjahresKontextExtractStage = defineStage<
  VorjahresKontextExtractInput,
  VorjahresKontextExtractOutput,
  VorjahresKontextExtractConfig
>({
  id: 'elster-v3/vorjahres-kontext-extract',
  name: 'Vorjahres-Erklärung → Mandanten-Kontext (CaseContext)',
  description:
    'Liest die OCR-Markdown-Seiten einer Vorjahres-Einkommensteuererklärung und ' +
    'extrahiert via Gemma-4 (strict json_schema) den kompletten Mandanten-Kontext: ' +
    'erwartete Anlagen, Veranlagungsart (Splittingtarif!), Anzahl Kinder, ' +
    'Daueranschnitte (Pendlerpauschale, Werbungskosten, KV/RV-Beiträge), ' +
    'erwartete Belege fürs Folgejahr. Output wird als artifact ' +
    '`vorjahres_kontext.json` persistiert + als CaseContext zurückgegeben für die ' +
    'Folge-Pipeline-Engführung (felderNarrow + phase3LlmFill).',
  hints: {
    inputs: 'pages[{index,markdown}] | text, filename, vorjahr',
    outputs: 'context: CaseContext, nested: full-merged-JSON, perPage[], ms',
    configExample: '{"provider":"vllm","model":"gemma4-mm","maxTokens":4000,"concurrency":5,"perPageTimeoutMs":90000}',
    llm: { providers: ['vllm', 'mistral'], default: 'vllm' },
    inputPorts: [
      { name: 'pages', type: 'json', description: 'OCR-Seiten' },
      { name: 'text', type: 'text', description: 'Fallback: Volltext' },
      { name: 'filename', type: 'string' },
      { name: 'vorjahr', type: 'integer' },
    ],
    outputPorts: [
      { name: 'context', type: 'json', description: 'CaseContext für Folge-Pipeline-Engführung' },
      { name: 'nested', type: 'json', description: 'Komplette nested Vorjahres-JSON' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const schemaJson = JSON.parse(await readFile(SCHEMA_PATH, 'utf-8')) as {
      name: string;
      schema: Record<string, unknown>;
    };

    const provider: ChatProvider = ctx.config.provider ?? 'vllm';
    const model = ctx.config.model ?? (provider === 'vllm' ? 'gemma4-mm' : 'mistral-large-latest');
    const maxTokens = ctx.config.maxTokens ?? 4000;
    const concurrency = ctx.config.concurrency ?? 5;
    const threshold = ctx.config.singleCallPageThreshold ?? 4;

    const pages = input.pages ?? [];
    const useSingleCall = pages.length === 0 || pages.length <= threshold;

    ctx.emit('vorjahres_kontext_started', {
      filename: input.filename,
      vorjahr: input.vorjahr,
      pages: pages.length,
      mode: useSingleCall ? 'single-call' : 'per-page',
      provider, model,
    });

    let nested: NestedVorjahr = {};
    const perPage: VorjahresKontextExtractOutput['perPage'] = [];

    if (useSingleCall) {
      // ── Single-Call: gesamten OCR-Text als ein Prompt ──────────────
      const aggregated = pages.length > 0
        ? pages.map((p) => `--- SEITE ${p.index + 1} ---\n${p.markdown}`).join('\n\n')
        : (input.text ?? '');
      const tCall = Date.now();
      try {
        const result = await chatJson(
          [
            basePrompt(input.vorjahr, 'die komplette Vorjahres-Erklärung (alle Seiten zusammen)'),
            '',
            '--- OCR-VOLLTEXT ---',
            aggregated,
          ].join('\n'),
          {
            provider, model, vllmUrl: ctx.config.vllmUrl,
            temperature: 0, maxTokens,
            jsonSchema: { name: schemaJson.name, schema: schemaJson.schema, strict: true },
            signal: ctx.signal,
          },
        );
        nested = (result.parsed as NestedVorjahr) ?? {};
        perPage.push({ pageIndex: -1, ms: Date.now() - tCall, ecodes: Object.keys(nested).length });
      } catch (err) {
        perPage.push({ pageIndex: -1, ms: Date.now() - tCall, error: (err as Error).message });
        ctx.emit('vorjahres_kontext_call_failed', { error: (err as Error).message });
      }
    } else {
      // ── Per-Page-Parallel: jede Seite einzeln extrahieren, dann mergen ─
      const tasks = pages;
      const pageResults = await runWithConcurrency(tasks, concurrency, async (p, _i) => {
        const tCall = Date.now();
        try {
          const result = await chatJson(
            [
              basePrompt(input.vorjahr, `Seite ${p.index + 1} der Vorjahres-Erklärung`),
              '',
              `--- OCR-TEXT SEITE ${p.index + 1} ---`,
              p.markdown,
            ].join('\n'),
            {
              provider, model, vllmUrl: ctx.config.vllmUrl,
              temperature: 0, maxTokens,
              jsonSchema: { name: schemaJson.name, schema: schemaJson.schema, strict: true },
              signal: ctx.signal,
            },
          );
          const parsed = (result.parsed as NestedVorjahr) ?? {};
          return {
            pageIndex: p.index,
            ms: Date.now() - tCall,
            ecodes: Object.keys(parsed).length,
            parsed,
          };
        } catch (err) {
          return {
            pageIndex: p.index,
            ms: Date.now() - tCall,
            error: (err as Error).message,
            parsed: {} as NestedVorjahr,
          };
        }
      });
      for (const pr of pageResults) {
        perPage.push({
          pageIndex: pr.pageIndex,
          ms: pr.ms,
          ecodes: pr.ecodes,
          ...(pr.error ? { error: pr.error } : {}),
        });
        if (!pr.error) nested = mergeNested(nested, pr.parsed);
      }
    }

    // Vorjahr ermitteln: input.vorjahr > nested.hauptvordruck.steuerjahr.
    const hv = (nested.hauptvordruck as Record<string, unknown> | undefined) ?? {};
    const jahr = input.vorjahr
      ?? (typeof hv.steuerjahr === 'number' ? (hv.steuerjahr as number) : new Date().getFullYear() - 1);

    const context = nestedToVorjahresKontext(nested as Parameters<typeof nestedToVorjahresKontext>[0], jahr);

    await ctx.artifacts.write('vorjahres_kontext.json', {
      filename: input.filename,
      vorjahr: jahr,
      context,
      nested,
      perPage,
      generatedAt: new Date().toISOString(),
    });

    ctx.emit('vorjahres_kontext_done', {
      vorjahr: jahr,
      veranlagungsart: context.veranlagungsart,
      expected_anlagen: context.expected_anlagen,
      daueranschnitte_n: context.daueranschnitte?.length ?? 0,
      missing_belege_n: context.missing_belege_erwartet?.length ?? 0,
      anzahl_kinder: context.anzahl_kinder,
    });

    return {
      context,
      nested,
      perPage,
      ms: Date.now() - t0,
    };
  },
});
