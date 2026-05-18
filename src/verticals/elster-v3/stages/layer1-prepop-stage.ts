/**
 * elster-v3/layer1-prepop — Belegtyp-spezifische Vor-Extraktion zur
 * Bestückung von prePopulatedLayer für phase3LlmFill + phase5Merge.
 *
 * Pipeline pro OCR-Seite:
 *   1) Mistral-Small Klassifikation → doc_class via `resolveDocClass`
 *   2) Falls match: Gemma-4 vLLM mit nested_schema (strict json_schema)
 *   3) nested → flacher ECodeEntry[]-Layer via `nestedToECodes`
 *
 * Aggregation über alle Seiten:
 *   - Same eCode aus mehreren Seiten → erster Wert gewinnt (Trust='high')
 *     (Aufruf-Seiten sind eh disjunkt, weil per-page doc_class).
 *   - Person-Cluster (IdNr Hauptperson + Ehegatte) wird mit gemerged.
 *
 * Output landet in:
 *   - prePopulatedLayer: Record<eCode, MergedFieldShape>
 *   - personCluster: {A?, B?}
 *
 * Diese Werte werden in phase3LlmFill aus der `required[]`/`properties{}`-
 * Liste GEFILTERT, sodass der Layer-3-LLM die schon-bekannten eCodes nicht
 * nochmal generieren muss. phase5-merge übernimmt die Layer-1-Werte mit
 * höchster Priorität in den canonical_layer.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../../../core/stage.ts';
import { chatJson, type ChatProvider } from '../../../lib/llm-chat.ts';
import { resolveDocClass, type DocClass } from '../data/belegtyp-doc-class.ts';
import { nestedToECodes, clusterPersonen, type ECodeEntry, type PersonCluster } from './nested-to-ecode-mapper.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(HERE, '..', 'data', 'nested_schemas');

export interface Layer1PrepopInput {
  /** Eine Seite pro Entry, vom upstream OCR-Stage (gemma-vision-ocr o.ä.) */
  pages: Array<{ index: number; markdown: string; chars?: number }>;
  /** Volltext (für Logging / Fallback wenn keine pages[]). */
  text?: string;
  /** Filename des Belegs — wird in confirmed_by.filename eingetragen. */
  filename?: string;
  /** Optional: Indikations-Belegtyp (aus eager beleg-indikation). Wenn
   *  gesetzt, wird die Klassifikation pro Seite GESKIPPT und stattdessen
   *  der resolveDocClass()-Hint benutzt. Spart ~3s pro Beleg. */
  indikationBelegtyp?: string | null;
}

export interface Layer1PrepopOutput {
  /** Flacher eCode → MergedField-Record für phase3-llm-fill + phase5-merge. */
  prePopulatedLayer: Record<string, ECodeEntry>;
  /** Person-Cluster — IdNr Hauptperson + Ehegatte für Person-A/B-Routing. */
  personCluster: PersonCluster;
  /** Debug: pro Seite was klassifiziert + extrahiert wurde. */
  perPage: Array<{
    pageIndex: number;
    docClass: DocClass | null;
    ecodesCount: number;
    ms: number;
    error?: string;
  }>;
  /** Gesamtzeit der Stage. */
  ms: number;
}

export interface Layer1PrepopConfig {
  /** LLM-Provider für nested_schema-Extraktion. Default 'vllm' (Gemma-4). */
  provider?: ChatProvider;
  /** Override vLLM-URL. */
  vllmUrl?: string;
  /** Override Modell. Default 'gemma4-mm' für vllm. */
  model?: string;
  /** Timeout pro Seite. Default 60_000 ms. */
  timeoutMsPerPage?: number;
  /** maxTokens für nested-schema-Output. Default 2000. */
  maxTokens?: number;
  /** Parallelität (max gleichzeitige Page-Calls). Default 5. */
  concurrency?: number;
  /** Wenn keine indikationBelegtyp gesetzt: per-page Klassifikation via
   *  Mistral Small als Fallback. Default true. */
  enablePageClassification?: boolean;
}

interface PageResult {
  pageIndex: number;
  docClass: DocClass | null;
  ecodes: ECodeEntry[];
  ms: number;
  error?: string;
}

async function classifyPage(markdown: string): Promise<DocClass | null> {
  // Erst harte Heuristik: Header-Pattern matcht — billiger als LLM.
  const head = markdown.slice(0, 600).toLowerCase();
  if (/lohnsteuerbescheinigung|verbandsgemeinde|nr\.?\s*22\s*a/.test(head)) return 'lohnsteuerbescheinigung';
  if (/religionszugeh|religionsbescheinigung|kirchensteuermerkmal.*konfession/.test(head)) return 'religionszugehoerigkeit';
  if (/mitteilung.*freigestellt.*kapitalertr|freistellungsauftrag/.test(head)) return 'mitteilung_kapitalertraege';
  if (/steuerbescheinigung.*kapitalertr|jahressteuerbescheinigung/.test(head)) return 'steuerbescheinigung_kapitalertraege';
  if (/rentenbezugsmitteilung|renten-bezugs/.test(head)) return 'rentenbezugsmitteilung';
  if (/spendenbescheinigung|zuwendungsbestätigung|mitgliedsbeitrag/.test(head)) return 'spendenquittung';
  if (/personaldaten|hauptvordruck|est1a|einkommensteuererklärung/.test(head)) return 'personaldaten_hauptvordruck';
  // Kein Header-Match → null (Page wird gesckipt).
  return null;
}

async function extractPage(
  pageIndex: number,
  markdown: string,
  docClass: DocClass,
  filename: string | undefined,
  cfg: Layer1PrepopConfig,
  signal: AbortSignal | undefined,
): Promise<PageResult> {
  const t0 = Date.now();
  let schema: { name: string; schema: Record<string, unknown> };
  try {
    schema = JSON.parse(await readFile(join(SCHEMAS_DIR, `${docClass}.json`), 'utf-8'));
  } catch (err) {
    return { pageIndex, docClass, ecodes: [], ms: Date.now() - t0, error: `schema-load: ${(err as Error).message}` };
  }
  const prompt = [
    `Du siehst Seite ${pageIndex + 1} eines deutschen Steuer-Belegs (${docClass}).`,
    'Extrahiere ALLE Werte strict nach JSON-Schema.',
    docClass === 'lohnsteuerbescheinigung'
      ? 'KRITISCH: Alle LStB-Zeilen 3-7 + Sozialvers Z.22-27 (RV/KV/PV/AV) sind in jeder normalen Beschäftigung vorhanden. Befülle auch 0,00 €-Felder, niemals weglassen.'
      : '',
    docClass === 'religionszugehoerigkeit'
      ? 'Konfession-Mapping: Evangelisch → "ev", Römisch-katholisch → "rk", Altkatholisch → "ak", Israelitisch → "is", Freireligiös → "fr".'
      : '',
    docClass === 'mitteilung_kapitalertraege'
      ? 'Person UND Ehepartner separat erfassen (Vorname + Nachname + IdNr beider). Bank pro Mitteilung als freigestellte_kapitalertraege[].'
      : '',
    '',
    '--- OCR-TEXT (Seite ' + (pageIndex + 1) + ') ---',
    markdown,
  ].filter(Boolean).join('\n');
  try {
    const result = await chatJson(prompt, {
      provider: cfg.provider ?? 'vllm',
      model: cfg.model ?? (cfg.provider === 'mistral' ? 'mistral-small-latest' : 'gemma4-mm'),
      vllmUrl: cfg.vllmUrl,
      temperature: 0,
      maxTokens: cfg.maxTokens ?? 2000,
      jsonSchema: { name: schema.name, schema: schema.schema, strict: true },
      signal,
    });
    const ecodes = nestedToECodes(docClass, result.parsed, { filename, page: pageIndex + 1 });
    return { pageIndex, docClass, ecodes, ms: Date.now() - t0 };
  } catch (err) {
    return { pageIndex, docClass, ecodes: [], ms: Date.now() - t0, error: (err as Error).message };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.max(1, concurrency); w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i]);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

export const layer1PrepopStage = defineStage<Layer1PrepopInput, Layer1PrepopOutput, Layer1PrepopConfig>({
  id: 'elster-v3/layer1-prepop',
  name: 'Layer-1 Belegtyp-Vorextraktion (nested-schema Pre-Population)',
  description:
    'Pro OCR-Seite: klassifiziere Belegtyp (Heuristik aus OCR-Header), bei Match lade ' +
    'das Belegtyp-spezifische nested_schema und rufe Gemma-4 vLLM mit strict json_schema. ' +
    'Mappe das nested-Output via nested-to-ecode-mapper auf flache ELSTER-eCodes. ' +
    'Aggregiere über alle Seiten zu prePopulatedLayer + personCluster — wird von ' +
    'phase3LlmFill (eCode-Skip) und phase5Merge (LAYER1-Priorität) konsumiert.',
  hints: {
    inputs: 'pages[{index, markdown}], filename, indikationBelegtyp?',
    outputs: 'prePopulatedLayer: Record<eCode, ECodeEntry>, personCluster: {A?, B?}, perPage[], ms',
    configExample: '{"provider":"vllm","model":"gemma4-mm","timeoutMsPerPage":60000,"maxTokens":2000,"concurrency":5}',
    llm: { providers: ['vllm', 'mistral'], default: 'vllm' },
    inputPorts: [
      { name: 'pages', type: 'json', description: 'OCR-Seiten mit markdown' },
      { name: 'filename', type: 'string', description: 'Beleg-Filename für confirmed_by' },
      { name: 'indikationBelegtyp', type: 'string', description: 'Optional: belegtyp-Hint aus eager indikation' },
    ],
    outputPorts: [
      { name: 'prePopulatedLayer', type: 'json', description: 'eCode → MergedField, trust=high, origin=LAYER1_NESTED' },
      { name: 'personCluster', type: 'json', description: 'Person-A/B-IdNr-Map' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const pages = input.pages ?? [];
    if (pages.length === 0) {
      return { prePopulatedLayer: {}, personCluster: {}, perPage: [], ms: Date.now() - t0 };
    }
    const concurrency = ctx.config.concurrency ?? 5;

    // Indikations-Hint: wenn alle Seiten denselben Belegtyp haben (single-doc),
    // setzen wir alle pages auf dieselbe docClass; sonst pro-page klassifizieren.
    const indikDocClass = resolveDocClass(input.indikationBelegtyp ?? '');
    const singleDocHint = indikDocClass && pages.length === 1 ? indikDocClass : null;

    ctx.emit('layer1_prepop_started', {
      pages: pages.length, filename: input.filename, indikationBelegtyp: input.indikationBelegtyp,
      singleDocHint, provider: ctx.config.provider ?? 'vllm',
    });

    // Phase 1: Klassifikation pro Page (Heuristik → ggf. Mistral-Fallback)
    const docClassPerPage: Array<DocClass | null> = await Promise.all(
      pages.map(async (p, _i) => {
        if (singleDocHint) return singleDocHint;
        return await classifyPage(p.markdown ?? '');
      }),
    );

    // Phase 2: Pro Page mit Match → Extraktion (parallel mit Concurrency-Limit)
    const tasks = pages.map((p, i) => ({ page: p, idx: i, docClass: docClassPerPage[i] }));
    const pageResults = await runWithConcurrency(tasks, concurrency, async (task) => {
      if (!task.docClass) {
        return { pageIndex: task.idx, docClass: null, ecodes: [], ms: 0 } as PageResult;
      }
      return await extractPage(
        task.idx, task.page.markdown ?? '', task.docClass,
        input.filename, ctx.config, ctx.signal,
      );
    });

    // Phase 3: Aggregation — alle eCodes einsammeln, Person-Cluster bauen
    const prePopulatedLayer: Record<string, ECodeEntry> = {};
    const allEcodes: ECodeEntry[] = [];
    for (const pr of pageResults) {
      for (const e of pr.ecodes) {
        allEcodes.push(e);
        // First-write-wins: bei doppeltem eCode (z.B. ESt1A.E0100081 in
        // mehreren Belegen) gewinnt der erste — alle Quellen sind trust=high.
        // Wenn Werte abweichen → wird im phase5-merge erkannt + als conflict
        // gelistet. Hier nicht handlen.
        if (!prePopulatedLayer[e.eCode]) prePopulatedLayer[e.eCode] = e;
      }
    }
    const personCluster = clusterPersonen(allEcodes);

    const perPage = pageResults.map((pr) => ({
      pageIndex: pr.pageIndex,
      docClass: pr.docClass,
      ecodesCount: pr.ecodes.length,
      ms: pr.ms,
      ...(pr.error ? { error: pr.error } : {}),
    }));

    await ctx.artifacts.write('layer1_prepop.json', {
      prePopulatedLayer, personCluster, perPage,
    });
    ctx.emit('layer1_prepop_done', {
      ecodes: Object.keys(prePopulatedLayer).length,
      personA: personCluster.A, personB: personCluster.B,
      pages: perPage.length, withMatch: perPage.filter((p) => p.docClass).length,
    });
    return {
      prePopulatedLayer, personCluster, perPage,
      ms: Date.now() - t0,
    };
  },
});
