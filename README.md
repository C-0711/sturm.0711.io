# 0711-STURM

> **⚠️ Primary origin: GitLab — not GitHub.**
> Canonical repo: <https://gitlab.mediacockpit.dev/0711/sturm>
> (`ssh://git@gitlab.mediacockpit.dev:2222/0711/sturm.git`)
> The `github.com/C-0711/sturm.0711.io` location is a historical mirror only.
> Do not push to GitHub. Do not treat GitHub branches as authoritative.
> The k3s `dev-01` cluster pulls `registry.gitlab.mediacockpit.dev/0711/sturm:dev`,
> built by CI from this repo's `feat/polar-turbo-gemma` branch.
> Full rules → see [`CLAUDE.md`](CLAUDE.md).

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

```bash
npm install
cp .env.example .env   # MISTRAL_API_KEY + ANTHROPIC_API_KEY eintragen
./start.sh              # Port 7800

# Oder via PM2 (Produktion):
pm2 start ecosystem.config.cjs
pm2 logs sturm
```

UI erreichbar unter `http://localhost:7800` (bzw. `https://sturm.0711.io` hinter nginx).

## Workflows

- **hello-ocr** — Minimal-Referenz: Mistral OCR → Textstatistik. Dient als Vorlage für neue Workflows.
- **elster-v1** — ELSTER Feldextraktion: OCR-permissiv → Regel-Engine → Schema-Bau → OCR-kuratiert → Baseline-Merge → Bewertung → Cross-Check, parallel Anlagen-Detektor.

## Tool-Wiring (P0)

Die Stages rufen externe Tools auf (vLLM, Ollama, BMF-/ELSTER-MCP, Gitchain).
Die zugehörigen Env-Vars (`VLLM_URL`, `OLLAMA_URL`, `BMF_MCP_URL`,
`ELSTER_MCP_URL`, `GITCHAIN_*`) sind in `.env.example` und
`docker-compose.yml` dokumentiert; Defaults zeigen auf `host.docker.internal`.

Smoke-Test:

```bash
npm run verify:tools
```

Druckt einen Roster mit `●/○/✕` pro Tool. Details und Fehler-Diagnose siehe
`docs/TOOL-WIRING.md`.

## Dokumentation

- `docs/WORKFLOW_TEMPLATE.md` — Vorlage, um neue Workflows durch Claude Code bauen zu lassen
- `docs/TOOL-WIRING.md` — Env-Vars + Smoke-Test für externe Tool-Bindings
- `CLAUDE.md` — Architektur-Notizen für Claude Code
