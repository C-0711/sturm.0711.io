# 0711-STURM — Claude Code Notes

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
