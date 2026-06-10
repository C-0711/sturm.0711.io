# Inversion + Meta-Gedächtnis — Implementation Plan

**Branch:** `feat/elster-inverse-solver` · **Scope:** the deterministic field-mapper pipeline only.
`src/verticals/elster-v3/` (quantum-RAG) is OUT OF SCOPE except read-only data (`atoms.json`) and **types/values we can read from its prior-run artifacts**.

Two coupled deliverables, shippable independently behind flags:
- **Part A — the inversion** (`erst mergen, dann mappen`): replace per-Beleg map→aggregate with Master-Case→map-once.
- **Part B — Meta-Gedächtnis**: a cross-year memory dimension of the Master Case that proposes (never auto-files) recurring items + stable Stammdaten.

---

## Part A — `erst mergen, dann mappen`

### A.1 Seam
`runLane1()` (`src/workflows/elster/lib/lane1.ts:279`). The swap point is the single line **`lane1.ts:519`** `const aggregated = aggregate(mappingResults);`. Everything from `:523` on (`buildVorjahr → preValidate → buildE10XML → kennzahl → Lane1Result`) consumes `aggregated: MappedField[]` and must stay byte-identical.

**Strategy:** invert the **merge**, not the per-Beleg map. Keep `mapBeleg` per section (preserves the 4 post-processors: StKl-6, ESt1A-Person-B, KRV, RBM-bAV + anchors, so `valueType`/`rawValue`/`kontextSubpath` survive). At the seam: per-Beleg `MappedField[]` → `CtaxCase` → `buildMastercase()` (consolidate + map-once) → bridge `MasterFact[]` back to `MappedField[]` → re-run `aggregate()` for cross-Beleg summation.

### A.2 Data-contract bridges
- **Forward** `MappedField[] → CtaxCase` (`mastercase.ts:26`): reuse the join at `web/server.ts:240-247`, applied **pre-aggregate** (`mappingResults.flatMap(r => r.felder)`). Backfill `zeile`/`kontextPath` via `idx.byECode.get(f.eCode)` — without them map-once accuracy drops to ~67%.
- **Backward** `MasterFact[] → MappedField[]` (`types.ts:88`): **new code.** Carry the originating `MappedField` keyed `${person}|${eCodeParse}|${anlage}`; override only `eCode = eCodeMap ?? eCodeParse`. Use **source `anlage`** (mixed-case `ESt1A`, not `fact.anlage` uppercased — `e10-xml.ts:425` drops case mismatches). Null `eCodeMap` + no `eCodeParse` → drop (else `unknown-ecode` → `ready=false` → silent XML loss).

### A.3 Steps
- **A-0 (HARD blocker):** `mastercase.ts:177` calls `main()` at import (reads `/tmp/...json`). Guard it like `harmonize.ts:147`: `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();` + `import { pathToFileURL } from 'node:url'`.
- **A-1:** catalog candidates from `loadCandidates()`/`buildIndex()` (`harmonize.ts:43/60`), built **once per `runLane1` call** (atoms.json ≈ 2.7 MB / 2287 atoms). Postgres-backed index = follow-up.
- **A-2:** new `src/workflows/elster/lib/field-mapper/mastercase-bridge.ts` — `buildCtaxCaseFromMappingResults()`, `bridgeMasterFactsToMappedFields()`, `inversionAggregate()` (wraps bridged array as one `MappingResult` so existing `aggregate()` sum/PER_BELEG/conflict logic runs unchanged).
- **A-3:** splice `lane1.ts:515-519` behind `STURM_LANE1_INVERSION` (else-branch = legacy `aggregate()`, untouched).
- **A-4/5:** per-section loop, `mapper.ts`, `pre-validate.ts`, `e10-xml.ts`, `kennzahl-bridge.ts`, `aggregation.ts`/`case-master.ts`, all CLI consumers — untouched (verify only).
- **A-6:** suppress `quelle==='household'` facts for first-cut parity; enable later.

### A.4 Rollout & tests
Flag default **off** → every test/CLI green. A/B harness runs Stricker twice, diffs `aggregated`/`xml` bytes/`ready`. Parity bar: `E1900701` A=11 / B=369, `E1901402`=324, brutto=60000. New `mastercase-bridge.test.ts` asserts both-path parity on Stricker + Hildburg (household suppressed). Must stay green: `mapper.test.ts`, `lane1.test.ts` (needs Postgres :11111), `kennzahl-bridge.test.ts`, `pre-validate.test.ts`.

### A.5 Top risks
1. **map-once vs mapBeleg eCode disagreement** — mitigated by feeding `eCodeParse` + fallback; during A/B log every `eCodeMap !== eCodeParse` and confirm each is an improvement.
2. **household-fact injection shifts XML** — suppress for parity, enable deliberately.
3. **`PER_BELEG_NICHT_AGGREGIEREN` collapse** — keep facts 1:1 through the bridge; let `aggregate()` handle it.

---

## Part B — Meta-Gedächtnis (cross-year memory)

> **Idea:** the Master Case holds a `meta` dimension for facts that are *super important but don't belong in the current case as ELSTER fields* — stable Stammdaten (employer address, IBAN, Konfession) and recurring `Daueranschnitte` (Pendlerpauschale with km × Arbeitstage, Werbungskosten, KV/RV). It **proposes** these to the user ("Arbeitsplatz unverändert + letztes Jahr Pendlerpauschale 38 km × 220 Tage — übernehmen?") and **never auto-files** them.

### B.0 Already built (reuse, do NOT rebuild)
| Piece | Where | What it gives |
|---|---|---|
| prefill/frage/vorhanden classifier | `buildVorjahr()` `lane1.ts:151`; `VorjahrFeld` `:187`; `Lane1Vorjahr` *"NIE Teil der Berechnung"* `:208` | stable Stammdatum → `prefill` (offer), Betrag → `frage` (ask), already present → `vorhanden` |
| Pendlerpauschale basis + compute | `vorjahres-kontext-mapper.ts:29` `{arbeitstage,entfernung_km,verkehrsmittel}`; `computePendlerpauschaleEUR(km,tage,0.30/0.38)` `:54`; eCodes `E0203301/401/504` `:98-103` | the km × Tage inputs **and** the € result |
| recurring-items list + suggestion UI | `CaseContext.daueranschnitte` `applications.ts:121` (+ comment `:95` "UI: schlägt daueranschnitte zur Übernahme vor") | the list and a UI that already offers adoption |
| question carrier | `AuditFinding` `audit.ts:35` (`status:'missing'|'partial'`, `message`, `evidence`) | how a suggestion reaches the user table |

### B.1 The gap (what's genuinely new)
1. **Consolidation** — meta is split across the field-mapper (`buildVorjahr`) and the v3 vertical (`vorjahres-kontext-mapper`/`CaseContext`). Unify into ONE `Mastercase.meta`.
2. **Persistence + carry-forward** — `master.json` is per `(appId, mandantId, jahr)`; nothing carries a Mandant's facts *across years*. Persist `meta` in `master.json` and seed year N from year N-1.
3. **Stability-diff** — detect "unchanged vs. prior year" (employer/address/IBAN) → confidence to prefill vs. ask. Does not exist.
4. **E-code-less facts** — a home for the employer address (HANDOVER: *"Name des Arbeitgebers → kein E-Code; ERiC zieht das aus dem Übermittler"*). Today dropped after extraction.
5. **Bundled, reasoned suggestion** — one question combining stability + recurrence, instead of per-field flags.

### B.2 Data model — extend `Mastercase` (`mastercase.ts:42`)
```ts
interface Mastercase { /* …existing… */ meta?: MetaFact[]; }

interface MetaFact {
  kind: 'stammdatum' | 'daueranschnitt';
  label: string;                 // "Pendlerpauschale", "Arbeitgeber-Adresse"
  wert: string;                  // display value
  basis?: { km?: number; tage?: number; verkehrsmittel?: string }; // inputs behind an amount
  eCodes?: string[] | null;      // null = kein ELSTER-Feld (z.B. AG-Adresse)
  quelleJahr: number;            // which VZ it came from
  status: 'prefill' | 'frage' | 'vorhanden';   // from buildVorjahr semantics
  stabilitaet?: 'stabil' | 'geändert' | 'neu'; // from the stability-diff
  vorschlag?: string;            // the bundled, reasoned user question
}
```

### B.3 Steps (slot into Part A; gate behind `STURM_MASTERCASE_META`, default off)
- **B-1 Lift the classifier to a shared pure fn.** Extract `buildVorjahr`'s prefill/frage logic (`lane1.ts:140-177`) into a pure helper the Master Case can call (e.g. `field-mapper/vorjahr-classify.ts`), so both `lane1` and `buildMastercase` share it without coupling to the v3 vertical.
- **B-2 Emit `meta` in `buildMastercase`** (`mastercase.ts:92`): from this year's facts + the prior `master.json` (see B-4). Reuse `computePendlerpauschaleEUR` and the Pendler eCode map — **move them out of the v3 vertical** into `src/lib/pendler.ts` (shared) to avoid importing `elster-v3`.
- **B-3 Stability-diff** — `diffStammdaten(prevMaster, curFacts) → 'stabil'|'geändert'|'neu'` per durable field; drives `MetaFact.stabilitaet` and whether a `daueranschnitt` is auto-suggested.
- **B-4 Persist + carry-forward** — add `meta` to the `master.json` schema (`case-master.ts` `writeCaseMaster`). On new-case creation for VZ N, **load VZ N-1's `master.json`** by `(mandantId, jahr-1)` and seed `meta` as the prior context. (Reuse existing files — no new store.)
- **B-5 Surface to the user** — map each `MetaFact` with `status∈{frage,prefill}` to an `AuditFinding` (`status:'missing'|'partial'`, `message = vorschlag`, `evidence = quelleJahr + basis`), so the existing auditor table renders it. Acceptance is a user action that injects the value into the current case (then it becomes a normal E-code via the bridge).
- **B-6 Diagram already reflects this** — `meta` node in `steuerfall-flow.html` (Master-Case branch).

### B.4 Cross-year nuance (the key architectural point)
True carry-forward is **mandant-level**, but `master.json` is per-year. Recommended: when building VZ N, read the prior `master.json` at `(mandantId, N-1)` and use its persisted `meta` (+ `merged_layer`) as the seed. This needs no new database — it reuses the artifacts `case-master.ts` already writes.

### B.5 Safety invariant (must hold)
`Lane1Vorjahr` is `NIE Teil der Berechnung` (`lane1.ts:208`). Therefore **with Meta enabled but no user acceptance, the generated E10-XML must be byte-identical to Meta-disabled.** Meta only adds *proposals*; amounts are always `frage` (explicit confirm), stable Stammdaten are `prefill` (still user-offered). Test asserts this byte-identity.

### B.6 Tests
- Persist: Stricker VZ 2023 run writes `master.json` with a `meta` array (employer-address `stammdatum`, any `daueranschnitt`).
- Carry-forward: synthetic VZ 2024 case for the same `mandantId`, seeded from 2023 `master.json`, surfaces Pendlerpauschale as a **`frage`** MetaFact with the prior `basis` (km × Tage) — and the 2024 XML is unchanged until the suggestion is accepted.
- Compute: `computePendlerpauschaleEUR` unit test (20 km @0.30 + rest @0.38).

### B.7 Risks
1. **Cross-pipeline coupling** — `daueranschnitte`/`computePendlerpauschaleEUR` live in the v3 vertical (out of scope). Mitigation: **move the Pendler types + compute into a shared `src/lib/pendler.ts`** and have the Master Case read **prior `master.json`** (already-extracted values) rather than re-running the v3 mapper. No `elster-v3` import from the field-mapper.
2. **VZ vs schema mismatch** — Stricker data is VZ 2023 while the e10 schema is E10-2024; confirm the `jahr` keys before seeding so carry-forward joins the right years.
3. **Stale Stammdaten auto-prefill** — never prefill an address silently; `prefill` still requires user confirm in the auditor table (B-5).

---

## Build order
A-0 → A-2 → A-3 (inversion behind flag, prove parity) → B-1 → B-2 → B-4 → B-5 (Meta behind its own flag). A and B share `buildMastercase` as the seam, so doing A first means B is a pure extension of the same call.
