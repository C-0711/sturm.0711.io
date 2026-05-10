# Phase F.2 / Task 1 — `@0711/gitchain-types` ELSTER contract — Audit verdict

- **Branch:** `feat/gitchain-types-elster-contract`
- **Commit under audit:** `ac6d2ef` — `feat(gitchain-types): lock ELSTER layer4-aggregate data contract`
- **Author:** Bombas `<bombas@0711.io>` · 2026-05-09 08:06:31 +0200
- **Files:** `packages/gitchain-types/{README.md,package.json,tsconfig.json,src/index.ts,src/elster.ts}` (5 files, 281 lines of contract in `elster.ts`)
- **Verdict:** **APPROVED**

## Q.rtf criteria

| Criterion | Result |
|---|---|
| Determinismus — closed unions, no `any`, frozen tables | ✅ `ECode` branded; `ElsterDocClass`, `EntityResolutionSource`, `AggregateStrategy` are closed unions; `DEFAULT_STRATEGY` is `Object.freeze`d |
| Provenienz — every output value traceable | ✅ `ECodeContribution` carries `subDocId`, `docClass`, `ruleDescription`, `ruleRechtsgrundlage?`, `inputCount`, `filteredCount`, `value`, `ceilingApplied`, `entity?` |
| Wiederverwendbarkeit — abstract enough for ETIM etc. | ✅ Package boundary clean; `ContainerProof` is vertical-agnostic; ELSTER-specific shapes namespaced inside `elster.ts` |
| `tsconfig.json` strict flags | ✅ `strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess + verbatimModuleSyntax` (also `noImplicitOverride`, `isolatedModules`, `skipLibCheck`) |
| `DEFAULT_STRATEGY` matches Q.rtf table | ✅ E1900701/702, E1901401/501/702, E1904701/801, E0108405/508 → `'sum'`; E0200201 → `'first'`; E1900601 → `'count'` |
| `ECodeContribution.confidence` omitted | ✅ Deterministic rules are 1.0 fixed; intentional omission |
| `readonly` durchgängig | ✅ Every field readonly; arrays are `ReadonlyArray<…>`; record types are `Readonly<Record<…>>` |

## Architectural strengthenings (over Q.rtf literal spec)

These are deviations that improve the design rather than violate Q.rtf:

1. `contributions[]` is nested in `AggregatedECode` and `AggregateConflict` instead of a flat top-level `contributions` array on `BundleAggregateOutput`. Better-typed access and prevents accidental cross-code mixing.
2. `BundleAggregateOutput.container: ContainerProof` is included in the output (Q.rtf only required it on the input). Cites the container authority on the output as well — required for downstream signing.
3. `AggregateStrategy` adds `'max'`, `'replace-on-conflict'`, `'reject-on-conflict'` to Q.rtf's base set (`sum`, `first`, `count`). Pure additions; rule authors can pick more carefully.
4. Contract is descriptive of existing modules (Layer1Output, Layer2Output, ProjectionResult, CanonicalTrace) per the file's own header comment — no API was invented.

## Forward references that imply Task 2+ structure

The contract's header comment cites:

```
src/verticals/elster-v3/stages/layer1-extract.ts → Layer1Output
src/verticals/elster-v3/stages/layer2-resolve.ts → Layer2Output
src/verticals/elster/lib/deterministic-rules.ts  → ProjectionRule, ProjectionResult
src/lib/canonical-layer.ts                       → CanonicalTrace, CanonicalValue
```

These paths do not yet exist on the branch. They are forward references for the Task 2 / Task 3 implementation. The actual current pipeline lives at:

- `src/workflows/elster/` — single-doc workflow (`elster-v1`): `klassifizierung → extraktion → anreicherung → seitenChips → qualitaetsgate → fallSummary`
- `src/workflows/steuerbelege/` — bundle workflow (`belege-bundle-v1`): `ocr → seiten-splitter → belege-multi`. The `belege-multi` stage stops after extraction and never produces a `BundleAggregateOutput` — this is the Q.rtf "stops at Layer A" bug.

The renaming policy task (Task 7) needs to reconcile these names: today's `belege-bundle-v1` ≡ Q.rtf's `elster-v3-multi`, today's `elster-v1` ≡ Q.rtf's `elster-v3`. Recommend keeping the German names (`belege-bundle-v1` is more accurate — these are *Belege*, not just ELSTER docs) and updating Q.rtf-style references in docs.

## Pre-merge guidance

The branch contains the contract package PLUS a working-state snapshot of in-flight elster + steuerbelege stages (~92k LOC across 168 files, commits `41998c8`, `5d3c9eb`, `2892280`, `a50e2eb`, `ac6d2ef`). Two reasonable merge strategies:

1. **Squash to a single contract commit + cherry-pick the WIP snapshot to a separate branch.** Cleanest history. Risk: rewriting Bombas's commit chain. Per the COMMS-SOP "Cite, don't fabricate" rule, do not rewrite without his ack.
2. **Merge the branch as-is with a merge commit.** Preserves authorship. Less clean history but truthful to the work.

Recommended: **(2) merge as-is.** Subsequent task PRs (Task 2 onward) branch off the merge commit on `main` and stay scoped to one task each.

## Sign-off

- Audit performed by: Architect (Claude Code session, 2026-05-10)
- Approved for merge: yes, with the merge-strategy guidance above
- Implementation can proceed to Task 2 (`feat/phase-f2-task2-bundle-aggregation`)
