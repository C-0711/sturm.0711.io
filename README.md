# 0711-STURM

Workflow-Engine für LLM/OCR-Pipelines. Ein Workflow ist ein gerichteter Graph aus Stages; die Engine liefert Runner, SSE-Streaming, ReactFlow-UI und Artefakt-Persistenz pro Run.

## Status

**Phase 0 — Extraktion**: Legacy-MVP (`mistral-playground` aus cb-ctax) als `legacy/elster-mvp/` eingefroren. Engine-Scaffold folgt.

## Struktur

```
0711-STURM/
  src/
    core/        Runner, Stage-Contract, Event-Bus, Artefakt-Store
    stages/      Wiederverwendbare Bausteine (mistral-ocr, claude-chat, …)
    workflows/   Konkrete Workflows (elster, hello-ocr, …)
    ui/          pipeline.html (generisch aus Workflow-Definition gerendert)
  docs/
    WORKFLOW_TEMPLATE.md   Spec-Vorlage für neue Workflows
  legacy/
    elster-mvp/  Referenz-Implementierung (Playground, .mjs)
  runs/          Pro-Run-Artefakte (gitignored, echte Case-Daten)
```

## Quick Start

Engine-Scaffold noch nicht da. Bis dahin läuft der Legacy-MVP:

```bash
cd legacy/elster-mvp
npm install
./start.sh   # Port 7800
```

## Dokumentation

- `docs/WORKFLOW_TEMPLATE.md` — Vorlage, um neue Workflows durch Claude Code bauen zu lassen
- `CLAUDE.md` — Architektur-Notizen für Claude Code
