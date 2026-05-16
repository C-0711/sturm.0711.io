# Tool-Wiring (P0)

STURM ist eine Workflow-Engine; die einzelnen Stages rufen externe Tools
auf (vLLM, Ollama, MCP-Server, Gitchain). Damit der Container die Tools
erreicht, müssen die folgenden Env-Vars gesetzt sein. P0 wired sie auf
das H200V-Setup; lokal können einzelne Tools fehlen — der Smoke-Test
zeigt das übersichtlich an.

## Env-Vars

| Variable | Zweck |
| -------- | ----- |
| `VLLM_URL` | vLLM-Endpoint für `gemma4-mm` (Gemma-4 31B IT, 65K ctx, TP2). Wird von Phase-3-LLM-Fill und Anlagen-Ermittlung benutzt. |
| `OLLAMA_URL` | Ollama-Endpoint für `embeddinggemma` (Quantum-Ground, Retrieval-Verify). |
| `BMF_MCP_URL` | Lane-1 BMF-MCP — Steuerschemata + Tabellen. |
| `ELSTER_MCP_URL` | Lane-5 ELSTER-MCP — ERiC-XML-Einreichung. Leer = Stub-Antwort. |
| `GITCHAIN_API_URL` | Container-Registry + git-Anker (read/write). |
| `GITCHAIN_DATABASE_URL` | Postgres-Connection für Gitchain-Metadaten. |
| `GITCHAIN_REPO_ROOT` | Pfad zu den bare-Repos auf dem Host (read-only mount im Container). |

Defaults in `docker-compose.yml` zeigen auf `host.docker.internal` mit
`extra_hosts: host.docker.internal:host-gateway` (Linux-kompatibel).

## Smoke-Test

```bash
npm run verify:tools
```

Druckt einen Roster mit `●` (OK), `○` (nicht konfiguriert / Key fehlt)
und `✕` (Fehler). Exit-Code 0 ohne `✕`, sonst 1. API-Keys werden
ausschließlich auf Vorhandensein geprüft — niemals geloggt.

## Tools im Detail (Was-tun-wenn-rot)

- **gemma4-mm (vLLM)** — Generations-Backend für Pflicht-Workflows.
  Fail-Diagnose: H200V-Container `vllm-gemma4-mm` (Port 11435) prüfen,
  SSH-Tunnel `-L 11435:localhost:11435` falls remote.
- **embeddinggemma (Ollama)** — Embeddings für Quantum-Ground.
  Fail-Diagnose: `ollama list` auf dem Host, ggf. `ollama pull embeddinggemma`.
- **bmf-lane1 (MCP)** — Steuerschema-Lookup. Lokaler MCP-Stub auf Port 12010.
  Fail-Diagnose: PM2-Eintrag `bmf-lane1`, Logs unter `~/0711/bmf-lane1/logs/`.
- **elster-lane5 (MCP)** — ERiC-Einreichung. Auf H200V Port 12014.
  Fail-Diagnose: `~/0711/elster-lane5/` Service-Status, SSH-Tunnel bei Remote-Dev.
- **gitchain (HTTP)** — Container-Registry. Healthz auf `:3361/healthz`.
  Fail-Diagnose: `docker ps | grep gitchain`, Postgres-Connection auf Port 5440.
- **ANTHROPIC_API_KEY / MISTRAL_API_KEY** — Provider-Keys.
  Fail-Diagnose: `.env` prüfen, niemals committen.
