/**
 * elster-v3-multi — Multi-Doc Variant
 *
 * Wie elster-v3, aber mit page-split davor: ein VaSt-Bundle (z.B. 5 Pages,
 * 5 Belege) wird in sub-Dokumente zerlegt. Pro sub-Doc läuft ein eigener
 * mini-Pipeline (klassifizierung → layer1 → layer2 → rules) und am Ende
 * wird alles zu einem CanonicalLayer zusammengeführt.
 *
 * Die Ausführung pro sub-Doc passiert HEUTE einmal sequenziell als
 * stage `multi-extract`. Parallelisierung kommt in Phase D.2.
 */
import { defineStage } from '../../core/stage.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { registerStage } from '../../core/registry.ts';
import { ELSTER_V3_VERTICAL_META } from './index.ts';
import type { PageSplitOutput, SubDoc } from './stages/page-split.ts';

interface MultiExtractInput {
  subDocs: SubDoc[];
}

interface SubDocResult {
  id: string;
  title: string;
  headerKind: string;
  pages: number[];
  classifierHint: string | null;
  /** What the schema-resolver actually picked. */
  schemaResolved: string | null;
  /** OCR text that was fed to layer1 (per sub-doc slice). */
  textChars: number;
  /** strict layer1 nested output. */
  nested: unknown | null;
  /** error if extraction failed for this sub-doc. */
  error: string | null;
}

interface MultiExtractOutput {
  subDocResults: SubDocResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    byHeaderKind: Record<string, number>;
  };
}

/**
 * Helper-stage that takes the page-split output and, for each sub-doc,
 * delegates to the elster-v3/layer1-extract stage by calling chatJson directly.
 * (We don't re-run klassifizierung per sub-doc when we have a strong header
 * hint — the splitter already mapped the header to a doc_class.)
 */
export const multiExtractStage = defineStage<
  MultiExtractInput,
  MultiExtractOutput,
  { fallbackToFullDoc?: boolean }
>({
  id: 'elster-v3/multi-extract',
  name: 'ELSTER-v3 Multi-Doc Iterator',
  description:
    'Iteriert über page-split sub-Dokumente und ruft pro sub-Doc Layer 1 auf. ' +
    'Wenn ein header-hint vorhanden ist, wird der direkt als docClass benutzt; ' +
    'ansonsten würde man auf Klassifizierung zurückfallen (TODO Phase D.2).',

  async run(input, ctx) {
    const subDocs = input.subDocs ?? [];
    const results: SubDocResult[] = [];
    const byHeaderKind: Record<string, number> = {};

    // Use the same chatJson + schema-loader path as layer1-extract, but
    // inline (we don't have a stage-from-stage call API yet).
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { chatJson } = await import('../../lib/llm-chat.ts');

    const HERE = dirname(fileURLToPath(import.meta.url));
    const SCHEMAS_DIR = join(HERE, 'data', 'nested_schemas');

    function resolveSchemaName(docClass: string): string {
      // Mirror of stages/layer1-extract.ts resolveSchemaName.
      const m: Record<string, string> = {
        pension_versorgung: 'lohnsteuerbescheinigung',
        lohnsteuerbescheinigung_kapital: 'lohnsteuerbescheinigung',
        lohnsteuerbescheinigung_aktiv: 'lohnsteuerbescheinigung',
        rentenbezug: 'rentenbezugsmitteilung',
        rentenbezugsmitteilung: 'rentenbezugsmitteilung',
        spendenquittung: 'spendenquittung',
        spende: 'spendenquittung',
        mitgliedsbeitrag: 'spendenquittung',
        religionszugehoerigkeit: 'religionszugehoerigkeit',
        religion: 'religionszugehoerigkeit',
        kirchensteuermerkmal: 'religionszugehoerigkeit',
        mitteilung_kapitalertraege: 'mitteilung_kapitalertraege',
        kapitalertragsbescheinigung: 'mitteilung_kapitalertraege',
        freistellungsauftrag: 'mitteilung_kapitalertraege',
        mitteilung_freigestellte_kapitalertraege: 'mitteilung_kapitalertraege',
        steuerbescheinigung_kapitalertraege: 'steuerbescheinigung_kapitalertraege',
        steuerbescheinigung_kapitalertr: 'steuerbescheinigung_kapitalertraege',
        jahressteuerbescheinigung: 'steuerbescheinigung_kapitalertraege',
        kapitalertrag_jahressteuerbescheinigung: 'steuerbescheinigung_kapitalertraege',
        personaldaten_hauptvordruck: 'personaldaten_hauptvordruck',
        elster_einkommensteuererkl_2023: 'personaldaten_hauptvordruck',
        elster_einkommensteuererkl: 'personaldaten_hauptvordruck',
        est1a_hauptvordruck: 'personaldaten_hauptvordruck',
        hauptvordruck: 'personaldaten_hauptvordruck',
      };
      return m[docClass] ?? docClass;
    }

    for (const sd of subDocs) {
      byHeaderKind[sd.headerKind] = (byHeaderKind[sd.headerKind] ?? 0) + 1;

      const docClass = sd.classifierHint;
      if (!docClass) {
        results.push({
          id: sd.id, title: sd.title, headerKind: sd.headerKind, pages: sd.pages,
          classifierHint: null, schemaResolved: null,
          textChars: sd.text.length, nested: null,
          error: 'no classifier hint for this sub-doc (header did not map); skipping (Phase D.2 will route to klassifizierung)',
        });
        ctx.emit('subdoc_skipped', { id: sd.id, headerKind: sd.headerKind });
        continue;
      }

      const schemaName = resolveSchemaName(docClass);
      const schemaPath = join(SCHEMAS_DIR, `${schemaName}.json`);

      let schemaJson: { schema: unknown; description?: string; name?: string } | null = null;
      try {
        const raw = await readFile(schemaPath, 'utf8');
        schemaJson = JSON.parse(raw) as typeof schemaJson;
      } catch (err) {
        results.push({
          id: sd.id, title: sd.title, headerKind: sd.headerKind, pages: sd.pages,
          classifierHint: docClass, schemaResolved: null,
          textChars: sd.text.length, nested: null,
          error: `schema not found: ${schemaName}.json (${(err as Error).message})`,
        });
        ctx.emit('subdoc_schema_missing', { id: sd.id, schemaName });
        continue;
      }

      const systemPrompt =
        `Du bekommst einen deutschen Steuer-Beleg (Klasse: ${docClass}). ` +
        `Extrahiere die relevanten Felder strikt nach dem JSON-Schema. ` +
        `Verwende ausschließlich Werte, die wörtlich im Beleg vorkommen. Erfinde nichts. ` +
        `Datumsangaben in ISO-8601 (YYYY-MM-DD), Beträge in EUR als Dezimal mit Punkt. ` +
        `Wenn ein Feld nicht im Beleg steht, lass es weg.`;
      const userPrompt = [
        `Beleg-Titel: ${sd.title}`,
        `Doc-Klasse: ${docClass}`,
        ``,
        `--- OCR-Text ---`,
        sd.text.slice(0, 6000),
      ].join('\n');

      try {
        ctx.emit('subdoc_extract_start', { id: sd.id, docClass, schemaName });
        const t0 = Date.now();
        const result = await chatJson(userPrompt, {
          system: systemPrompt,
          jsonSchema: {
            name: schemaJson?.name ?? `${schemaName}_extract`,
            schema: schemaJson?.schema,
            strict: true,
          },
          temperature: 0,
          maxTokens: 2000,
          provider: 'vllm',
          model: 'gemma4-mm',
          signal: ctx.signal,
        });
        const nested = result.parsed;
        const ms = Date.now() - t0;
        ctx.emit('subdoc_extract_done', { id: sd.id, ms });

        results.push({
          id: sd.id, title: sd.title, headerKind: sd.headerKind, pages: sd.pages,
          classifierHint: docClass, schemaResolved: schemaName,
          textChars: sd.text.length, nested,
          error: null,
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        results.push({
          id: sd.id, title: sd.title, headerKind: sd.headerKind, pages: sd.pages,
          classifierHint: docClass, schemaResolved: schemaName,
          textChars: sd.text.length, nested: null,
          error: msg.slice(0, 300),
        });
        ctx.emit('subdoc_extract_error', { id: sd.id, message: msg.slice(0, 200) });
      }
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.error === null).length,
      failed: results.filter((r) => r.error !== null).length,
      byHeaderKind,
    };

    await ctx.artifacts.write('multi_extract.json', { subDocResults: results, summary });
    return { subDocResults: results, summary };
  },
});


/* ============================================================================
 * Phase F.2 — Layer 4 Aggregate Stage for Multi-Doc Bundles
 * Takes multi-extract output, applies PROJECTION_RULES per sub-doc, aggregates
 * canonical eCodes across all sub-docs of the bundle.
 * ========================================================================== */
interface AggregateInput {
  subDocResults: SubDocResult[];
}

interface AggregateOutput {
  codes: Record<string, unknown>;
  perSubDoc: Array<{
    id: string;
    docClass: string | null;
    appliedRules: number;
    codesEmitted: string[];
  }>;
  summary: {
    totalSubDocs: number;
    subDocsWithCodes: number;
    totalCodes: number;
    uniqueCodes: number;
  };
}

export const multiAggregateStage = defineStage<
  AggregateInput,
  AggregateOutput,
  Record<string, never>
>({
  id: 'elster-v3/multi-aggregate',
  name: 'ELSTER-v3 Multi-Doc Aggregate (Layer 4)',
  description:
    'Wendet PROJECTION_RULES auf jede sub-doc an, summiert eCodes über das ' +
    'Bundle (z.B. Sparer-Pauschbetrag = sum aller Kapitalertrag-Belege).',

  async run(input, ctx) {
    const { applyProjections } = await import('../elster/lib/deterministic-rules.ts');

    const aggregateCodes: Record<string, unknown> = {};
    const perSubDoc: AggregateOutput['perSubDoc'] = [];

    for (const sd of input.subDocResults) {
      if (!sd.nested || sd.error) {
        perSubDoc.push({
          id: sd.id,
          docClass: sd.classifierHint,
          appliedRules: 0,
          codesEmitted: [],
        });
        continue;
      }

      const layer: any = { codes: {}, citations: {}, sources: [], traces: [] };
      const result = applyProjections(sd.nested as any, layer, sd.classifierHint ?? undefined);

      const emittedCodes = Object.keys(layer.codes);
      perSubDoc.push({
        id: sd.id,
        docClass: sd.classifierHint,
        appliedRules: result.appliedRules.length,
        codesEmitted: emittedCodes,
      });

      // Aggregate: numeric codes get summed, non-numeric just take last value
      for (const [code, val] of Object.entries(layer.codes)) {
        const cur = aggregateCodes[code];
        if (typeof val === 'number' && typeof cur === 'number') {
          aggregateCodes[code] = cur + val;
        } else if (cur === undefined) {
          aggregateCodes[code] = val;
        }
        // For numeric codes that are flags (E1900601 = kirchensteuer), summing makes sense (=count)
      }
    }

    const summary = {
      totalSubDocs: input.subDocResults.length,
      subDocsWithCodes: perSubDoc.filter((p) => p.codesEmitted.length > 0).length,
      totalCodes: perSubDoc.reduce((s, p) => s + p.codesEmitted.length, 0),
      uniqueCodes: Object.keys(aggregateCodes).length,
    };

    ctx.emit('aggregate_done', summary);
    await ctx.artifacts.write('multi_aggregate.json', { codes: aggregateCodes, perSubDoc, summary });

    return { codes: aggregateCodes, perSubDoc, summary };
  },
});

export function registerElsterV3MultiStages(): void {
  registerStage(multiExtractStage);
  registerStage(multiAggregateStage);
}

export function buildElsterV3MultiWorkflowWithSchema() {
  return defineWorkflow({
    id: 'elster-v3-multi',
    name: 'ELSTER v3 multi — gitchain three-lane für Multi-Doc-Bundles',
    description:
      'Wie elster-v3, aber mit page-split davor. Ein VaSt-Bundle wird in ' +
      'sub-Dokumente zerlegt; pro sub-Doc läuft layer1 mit dem header-' +
      'gehinteten doc_class. Output: subDocResults[]. ' +
      `Container: ${ELSTER_V3_VERTICAL_META.catalogVersion}.`,
    input: {
      type: 'file',
      accept: ['pdf', 'png', 'jpg', 'jpeg'],
      maxSizeMb: 50,
    },
    stages: {
      ocr: {
        uses: 'mistral-ocr',
        inputs: {
          filePath: '${input.filePath}',
          filename: '${input.filename}',
        },
      },
      split: {
        uses: 'elster-v3/page-split',
        inputs: {
          ocr: '${ocr}',
        },
      },
      multi: {
        uses: 'elster-v3/multi-extract',
        config: {},
        inputs: {
          subDocs: '${split.subDocs}',
        },
      },
      aggregate: {
        uses: 'elster-v3/multi-aggregate',
        config: {},
        inputs: {
          subDocResults: '${multi.subDocResults}',
        },
      },
    },
    edges: [
      ['ocr', 'split'],
      ['split', 'multi'],
      ['multi', 'aggregate'],
    ],
    containers: [
      {
        id: '0711:elster:bmf:jahresdok-2024:v1',
        displayName: 'ELSTER eCode Catalog',
        description: 'BMF Jahresdokumentation 10/2024 — 2287 eCodes, 35 Anlagen.',
        readBy: ['multi'],
        schemaVersion: 5,
        atomsCount: 2287,
        anlagenCount: 35,
        embeddingDim: 1024,
        embeddingModel: 'bge-m3',
        merkleRoot: '66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd',
        containerSha256: 'de938e468a7d85488906bf88af067160edeb08dc52d4399e2416df6760652bcc',
        issuerFingerprint: 'sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea',
        lockState: 'sealed',
      },
    ],
  });
}
