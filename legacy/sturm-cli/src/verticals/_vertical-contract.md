# Vertical Contract

A **vertical** in sturm is one **standard's** end-to-end mapping pipeline:
classifier → extractor → cascade → validator → canonical-layer output.

The vertical name is the **standard name** (`elster`, `etim`, `eclass`,
`gobd`), not the domain (`tax`, `products`, `records`). The standard is the
canonical thing; the domain is just description.

## Required directory layout

```
src/verticals/<standard-id>/
├── index.ts                  ← register*Stages, build*WorkflowWithSchema, *_VERTICAL_META
├── stages/                   ← sturm Stages (defineStage)
│   ├── klassifizierung.ts    ← document → which sub-categories of the standard apply
│   ├── extraktion.ts         ← extract values per sub-category (free-form or LLM-driven)
│   ├── funnel-stage.ts       ← cascade: free-form labels → canonical IDs
│   └── validator-stage.ts    ← run rules from the standard's catalog
├── lib/
│   ├── <standard>-katalog.ts ← loadCatalog() / loadFelder() etc.
│   ├── cascade-config.ts     ← exports a CascadeConfig consumed by src/lib/cascade-runtime.ts
│   ├── validation.ts         ← per-value validation helpers (datentyp, regex, range)
│   └── <rule-evaluator>.ts   ← evaluator for the standard's rule expression syntax
├── data/                     ← bundled, version-pinned JSON catalogs (no runtime DB)
│   ├── …per-standard files…
│   └── README.md             ← what each catalog file is, how it was generated, source URL
└── tests/
    └── groundtruth/<doc-class>.json
```

## Required exports from `index.ts`

```ts
import type { StageRegistry } from '../../core/registry';
import type { WorkflowDef }   from '../../core/workflow';

export function register<Standard>Stages(registry: StageRegistry): void;
export function build<Standard>WorkflowWithSchema(): WorkflowDef;

export const <STANDARD>_VERTICAL_META: {
  standardId: string;          // 'elster', 'etim', 'eclass', 'gobd'
  standardFullName: string;    // 'ELSTER (German Tax Authority)', 'ETIM 9.0', …
  domain: string;              // 'tax', 'product-classification', 'records-retention'
  canonicalSchemaName: string; // 'ELSTER eCodes', 'ETIM EC/EF/EV', …
  catalogVersion: string;      // 'Jahresdokumentation_10_2024', 'ETIM 9.0 2024-Q3'
  primaryEntityKind: 'document' | 'record';
};
```

## Required output: a Canonical Layer

Every workflow that this vertical defines MUST end its pipeline by emitting a
`CanonicalLayer` (see `src/lib/canonical-layer.ts`):

```ts
{
  schemaId: '<standard-id>',
  version:  '<catalog-version>',
  codes:    Record<string, CanonicalValue>,        // canonical-id → value
  traces:   Array<{ code, value, sourceDoc, ocrSpan, cascadeStage, confidence, reasoning }>,
  unmapped: Array<{ key, value, reason }>,         // KPIs that didn't resolve (audit-kept)
  validator: { passes, warnings: Issue[], errors: Issue[] },
}
```

This is what downstream consumers (BMF-Rechner for ELSTER, PIM for ETIM, …)
consume. Sturm does not generate the standard's wire format (XML, EDI, BMEcat
export, …) — that lives in the consumer.

## Reused shared code (don't reimplement)

- `src/lib/llm-chat.ts` — `chatJson<T>(prompt, opts)` wrapper, Mistral default
- `src/lib/cascade-runtime.ts` — `resolveAll(kpis, config, catalog, layer)`
  generic N-stage cascade engine
- `src/lib/canonical-layer.ts` — `makeLayer`, `setCode`, `addUnmapped`,
  `mergeLayers` — the uniform output type + helpers
- `src/lib/citation.ts` / `audit.ts` — provenance tracking helpers
- `src/stages/mistral-ocr.ts` — generic OCR stage (declared in main repo)
- `src/core/{stage,workflow,registry}.ts` — runtime (main repo)

## "Add a new standard" recipe (4 steps)

1. **Pre-process the standard's catalog** into bundled JSON. Write a script
   under `scripts/preprocess-<standard>-<format>.mjs` that reads the
   authoritative source (XML, XSD, BMEcat, Excel, CSV) and emits one or more
   JSON files under `src/verticals/<standard-id>/data/`.

2. **Write the cascade-config**. Implement the deterministic match stages
   appropriate to your catalog (bezeichnung-exact, synonyms, regex, slug,
   concept, …) plus an LLM-fallback as the last stage. Each stage is a small
   function `(kpi, catalog) => Match | null` with a confidence threshold.

3. **Wire the four sturm Stages** (classifier, extractor, funnel-stage,
   validator-stage). The funnel-stage just calls `resolveAll(...)` with the
   cascade-config you wrote. The validator-stage applies the standard's rule
   evaluator against the canonical layer.

4. **Register**. Add `import { register<Standard>Stages } from './<standard-id>'`
   to `src/verticals/index.ts` and call it from `registerAllVerticals`.

That's it. No framework code changes. The same workspace API
(`/api/workspaces/<id>/canonical-layers/<standardId>`) automatically exposes
the new vertical's output once it's registered.

## Naming conventions

- Vertical directory: lowercase standard-id (`elster`, `etim`, `eclass`)
- Exports: PascalCase standard-id (`registerElsterStages`, `buildEtimWorkflowWithSchema`)
- Stage IDs: `<standardId>/<stage-name>` (`elster/klassifizierung`, `etim/funnel`)
- Workflow IDs: `<standardId>-v<n>` (`elster-v1`, `etim-v1`)
- Data files: `<artifact>.json` inside `data/`, named after what they contain (`feld_katalog_full.json`, not `vertical-data-1.json`)
