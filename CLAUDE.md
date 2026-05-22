# 0711-STURM — Claude Code Notes

> ## ⚠️ STOP — READ THIS FIRST (any LLM / agent / human)
>
> ### 🚨 PRIMARY ORIGIN = GITLAB, **NOT** GITHUB 🚨
>
> The canonical, deployed-from origin for this repo is:
>
> **`ssh://git@gitlab.mediacockpit.dev:2222/0711/sturm.git`**
> (web: <https://gitlab.mediacockpit.dev/0711/sturm>)
>
> The previous `github.com/C-0711/sturm.0711.io` location is a **historical mirror only**.
> It is read-only from our side and **may be retired without notice**.
>
> **Do not** push to GitHub. **Do not** open PRs on GitHub. **Do not** treat any
> GitHub branch as authoritative. Any branch / tag / image referenced by the
> Kubernetes manifests in `ctax-manifests` resolves against **GitLab only**.
>
> The CI image `registry.gitlab.mediacockpit.dev/0711/sturm:dev` is built from
> the `feat/polar-turbo-gemma` branch on GitLab. That is what the dev cluster
> pulls. Drift between GitHub and GitLab = drift between H200 and the cluster.
>
> ---
>
> ### Mandatory workflow rules (apply here, same as `ctax/ctax-architecture#1`)
>
> 1. **Always pull `origin/main` before starting a new branch.** Understand it, then branch.
> 2. **Never reuse old / existing branches.** One feature = one branch. No `fix/p0-quickwins` collector branches.
> 3. **Branch name must reflect actual content.** No piggybacking unrelated changes.
> 4. **Before flipping MR Draft → Ready:** rebase or merge `origin/main` into your branch and confirm green.
> 5. **Data sources must be declared explicitly.** When a change reads or writes data, name the source (H200 path, DB table, MCP endpoint, env var) and the schema. See `ctax/ctaxv1:/docs/DB_OWNERSHIP_CONTRACT.md` + `DB_HARMONIZATION_ROADMAP.md` (validate — docs are not yet fully reliable; correct + concretize as needed).
> 6. **`ctax-manifests` is the single source of truth for Kubernetes.** STURM runs in the cluster via [`ctax-manifests/base/sturm.yaml`](https://gitlab.mediacockpit.dev/ctax/ctax-manifests/-/blob/main/base/sturm.yaml). If you change a runtime contract here (port, env, healthcheck, PVC layout), update the manifests in the same MR set.
> 7. **No state survives without a PVC.** The cluster mounts `sturm-state` (5 Gi, RWO) at `/app/{workspaces,runs,uploads,schemas,logs}`. Anything written outside those paths dies on pod restart.
> 8. **GitLab MCP exists** (`https://gitlab-mcp.mediacockpit.dev/mcp`) — use it for repo analysis, MR handling, structured queries. Don't scrape the web UI.
>
> ### What "deployed" means for STURM
>
> H200 dev-server runs STURM via `docker-compose.yml` against bind-mounted host
> data (`STURM_DATA_ROOT=/home/christoph.bertsch/0711/0711-STURM`). The k3s
> `dev-01` cluster runs the same code from the GitLab-built image against the
> `sturm-state` PVC. **Both must point at the GitLab origin.** Any commit that
> lands on GitHub but not GitLab = invisible to the cluster.
>
> ---

## Was ist das

Workflow-Engine für LLM/OCR-Pipelines. Stages bilden einen gerichteten Graph; die Engine übernimmt Runner, SSE-Streaming, ReactFlow-UI, Artefakt-Persistenz pro Run.

Erster Workflow ist die ELSTER-Feldextraktion (portiert aus `dev-cb-ctax/mistral-playground`). Weitere Workflows können ohne Änderungen an der Engine hinzugefügt werden.

## Kernprinzipien

- **Workflows sind Daten, nicht Code-Varianten**: Ein Workflow ist eine Definition (`defineWorkflow({ stages, edges, … })`). Pro-Workflow-Code lebt nur in Stages.
- **Stages sind pur bezüglich Seiten-Effekte**: Nur `ctx.emit`, `ctx.artifacts`, `ctx.logger`. Kein direktes `fs.writeFileSync` oder DB-Write.
- **Generische Bausteine zuerst**: Neue Stages in `src/stages/` wenn wiederverwendbar. Workflow-spezifisches in `src/workflows/<id>/stages/`.
- **UI ist generisch**: `pipeline.html` rendert jeden registrierten Workflow aus der Definition. Keine Workflow-spezifische UI-Logik ohne expliziten Grund.
- **JSON-Persistenz im MVP**: Kein Postgres, kein Redis. `runs/<workflow>/<run-id>/` als Artefakt-Ordner. DB erst bei Bedarf.
- **Kein Auth**: Playground-Level. Wenn Multi-User nötig, separater Auth-Layer vor der Engine.

## Verzeichnisstruktur

```
src/
  core/              Runner, Stage-Contract, Event-Bus, Artefakt-Store
  stages/            Generische Bausteine (workflow-agnostisch)
  workflows/         Konkrete Workflows
    elster/
      index.ts       defineWorkflow({ … })
      stages/        elster-spezifische Stages
      data/          Kataloge, Aliase
  ui/                pipeline.html + Assets
  server.ts          Express + SSE
docs/
  WORKFLOW_TEMPLATE.md   Prompt-Spec für neue Workflows (via Claude Code)
legacy/
  elster-mvp/        Ursprünglicher Playground (.mjs), eingefroren als Referenz
runs/                Artefakte pro Run (gitignored — enthält echte Case-Daten)
```

## Runtime

- Node.js + TypeScript via `tsx` (kein Build-Step)
- Express + SSE
- Port **7800** (default)
- Env-Keys: `MISTRAL_API_KEY`, `ANTHROPIC_API_KEY`, optional `OLLAMA_URL`
- PM2-Eintrag: `sturm` (ecosystem.config.cjs, folgt)

## Regeln

1. **Keine Case-Daten hartcodieren**: Namen, Adressen, IDNr, Beträge niemals in Code/Prompts. Nur zur Laufzeit aus Dokument/Session.
2. **Keine Modellnamen in User-facing Strings**: Im UI/Log erscheint "Mistral OCR" oder "Kurator", nicht "claude-opus-4-7".
3. **Deutsche Benennung** (siehe cb-ctax KODIERRICHTLINIE).
4. **Uploads sind sensibel**: `uploads/` und `runs/` sind gitignored. Legacy-Uploads aus cb-ctax wurden NICHT mitkopiert.
5. **Stages nie andere Stages aufrufen**: Orchestrierung macht der Runner. Wenn ein Stage Unter-Schritte braucht, sind das entweder interne Hilfsfunktionen oder es sollten zwei Stages sein.

## Vor Code-Änderungen lesen

- `src/core/workflow.ts` — Workflow-Definition-Shape
- `src/core/stage.ts` — Stage-Interface, Context
- `docs/WORKFLOW_TEMPLATE.md` — wenn es um das Bauen neuer Workflows geht

## Legacy verweis

Der Elster-Workflow portiert Logik aus `legacy/elster-mvp/server.mjs`:
- Pipeline-Endpoint: Zeile 2498
- Regel-Engine: Zeile 1348
- Schema-Bau: Zeile 1640
- Bewertung: Zeile 2005
- Cross-Check: Zeile 2105

Legacy bleibt als Referenz liegen, wird aber nicht weiterentwickelt. Wenn du dort Bugs siehst: im portierten Code fixen, nicht im Legacy.
