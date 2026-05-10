# Versioning policy — Quantum Container, workflows, and stages

Phase F.2 / Task 7. This is the naming-and-versioning contract for every artifact produced by the Gitchain pipeline. It exists to end the drift between Q.rtf's vocabulary (`elster-v3-multi`, `gitchain-v3`), the codebase's German names (`belege-bundle-v1`, `steuerbelege-v1`), and stray build artifacts ("ELSTER v3 (dev)").

## TL;DR

| Axis | Format | Example | Bumps when |
|---|---|---|---|
| **Container schema** | `gitchain-schema-v{N}` | `gitchain-schema-v1` | manifest format changes (breaking) |
| **Workflow** | `<vertical>-<role>-v{N}` | `elster-v1`, `belege-bundle-v1` | stage graph or stage IDs change |
| **Stage** | `<vertical>/<short-id>` | `steuerbelege/layer4-aggregate` | input/output shape changes |
| **Container instance** | `0711:<vertical>:<source>:<doc-id>:v{N}` | `0711:elster:bmf:jahresdok-2024:v1` | source artifact changes |

Each axis bumps independently. A single `gitchain-schema-v1` container can hold the output of many workflow versions; a single `belege-bundle-v2` workflow can produce containers across multiple `gitchain-schema` versions during a migration.

## Three axes, decoupled

### 1. Container schema version (`gitchain-schema-v{N}`)

The manifest format of a Gitchain container — the shape of `manifest.json`, the layout of `signatures/`, `merkle.json`, the `ContainerProof` interface in `@0711/gitchain-types`.

- Bumped only on breaking format changes.
- Drives the `schemaVersion: number` field in `ContainerProof`.
- Currently: **v1** (only).

### 2. Workflow version (`<vertical>-<role>-v{N}`)

A workflow is a `defineWorkflow({ id, stages, edges })` definition. The id is the workflow's stable identity.

- `<vertical>` — what domain it serves: `elster`, `steuerbelege`, `bosch`, `etim`.
- `<role>` — what it does: a single-doc role is just the vertical (`elster-v1`); a bundle role is `<vertical>-bundle` (`belege-bundle-v1`).
- `v{N}` — bumped on graph topology changes or stage-id renames.

Today's workflows:

| ID | Role | Stages |
|---|---|---|
| `elster-v1` | single-doc | ocr → klassifizierung → extraktion → anreicherung → seitenChips → qualitaetsgate → fallSummary |
| `steuerbelege-v1` | single-doc beleg | ocr → dokument-typ → beleg-extraktion |
| `belege-bundle-v1` | multi-doc bundle | ocr → seiten-splitter → belege-multi → layer4-aggregate |
| `hello-ocr` | dev fixture | ocr |

#### Q.rtf reconciliation

Q.rtf's draft vocabulary maps to the canonical IDs as follows:

| Q.rtf name | Canonical workflow |
|---|---|
| `elster-v3` | `elster-v1` |
| `elster-v3-multi` | `belege-bundle-v1` (Phase F.2 / Task 2 added the layer4-aggregate stage that Q.rtf flagged missing) |
| `ELSTER v2 container` | a container instance produced by `elster-v1`, schema `gitchain-schema-v1` |
| `ELSTER v3 (dev)` | **not a real artifact** — stray build label, do not republish |

The `v3` numbering in Q.rtf was aspirational and never landed. We stay at `v1` for both workflows; the F.2 work added a stage and a `gitchain-types` package, neither of which is a workflow-graph change that warrants a version bump. The next workflow-version bump (`v2`) should happen the first time we change the stage graph in a way that breaks downstream consumers — most likely when Task 3 lands the deterministic-rules stage.

### 3. Stage IDs

`<vertical>/<short-id>`. Single namespace per vertical; stage IDs are stable.

| Vertical | Stage IDs (current) |
|---|---|
| _(generic)_ | `mistral-ocr`, `text-stats` |
| `elster/` | `klassifizierung`, `extraktion`, `anreicherung`, `seitenChips`, `qualitaetsgate`, `fallSummary` |
| `steuerbelege/` | `dokument-typ`, `beleg-extraktion`, `seiten-splitter`, `belege-multi`, `layer4-aggregate` |

Stage IDs are workflow-version-locked: changing a stage ID bumps the workflow version that uses it.

### 4. Container instance ID

`0711:<vertical>:<source>:<doc-id>:v{N}`. Identifies a specific signed artifact.

- Example: `0711:elster:bmf:jahresdok-2024:v1` — an ELSTER container, sourced from BMF, identifying the 2024 jahresdokument, instance 1.
- The instance `v{N}` bumps when the source artifact changes (e.g., BMF re-publishes the 2024 schema). The container schema version (`gitchain-schema-v1`) does NOT bump.

## Stray artifact policy

Names that don't match the formats above are **strays**. Do not publish them. Specifically:

- ❌ `ELSTER v3 (dev)` — has spaces, parens, no schema. Not a valid container instance.
- ❌ `belege-bundle@latest` — `@latest` is not a version; refer to `:v{N}` or the merkle root.
- ❌ `elster-multi` — missing `v{N}`.

The script at `scripts/rename-strays.ts` lists any local artifact directory or container manifest whose name fails the format check. Run as a dry-run by default; it never modifies state.

```sh
tsx scripts/rename-strays.ts            # dry-run; prints proposals
tsx scripts/rename-strays.ts --json     # machine-readable output
```

## Audit gate

A workflow run, container, or registry entry is *audit-clean* iff:

1. Workflow id matches `^[a-z][a-z0-9-]*-v[0-9]+$` (or is `hello-ocr` legacy).
2. Every stage id in the run matches `^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$`.
3. Container instance id matches `^0711:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z0-9-]+:v[0-9]+$`.
4. ContainerProof.schemaVersion ≥ 1.

Failures of (1)–(3) are surfaced by `scripts/rename-strays.ts`. Failures of (4) are caught by `verifyProvenance` in `@0711/gitchain-types`.
