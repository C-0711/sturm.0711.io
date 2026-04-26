# GITCHAIN-INTEGRATION-NOTES

Phase 1b — implementiert 2026-04-26

## Was funktioniert

- **GitChain-Client** (`src/lib/gitchain-client.ts`): Postgres-Zugriff via `pg`, Git-Ops via `simple-git`.
  - Container anlegen/lesen, `latest_commit` updaten, Citations anlegen, Mandant-Suche.
  - Bare repo auto-initialisieren unter `GITCHAIN_REPO_ROOT/workspace/<namespace>/<id>.git`.
  - Arbeitsverzeichnis per `git init + remote add origin` mit dem Bare repo verbinden.
  - `commitAndPush`: erkennt "nothing to commit" und gibt aktuellen HEAD-SHA zurück.

- **GitChain-ArtifaktStore** (`src/core/artifacts-gitchain.ts`): Drop-in für den Filesystem-Store.
  - Legt `workspace`-Container in DB an.
  - Initialisiert git repo im Artefakt-Verzeichnis (`runs/<workflowId>/<runId>/`).
  - `commitStage(stageId, summary)` → Git-Commit nach jeder Stage.
  - `finalCommit(state)` → abschließender Commit mit Run-Status.

- **Runner-Hook** (`src/core/runner.ts`): Minimal-invasiv.
  - Wenn `STURM_ARTIFACT_BACKEND=gitchain` → GitChain-Store, sonst Filesystem (unverändert).
  - Commit nach jedem Stage-Erfolg: `[<stageId>] <name> OK (<ms>ms)`.
  - Abschluss-Commit: `run/ok|error|partial: <workflowId> <runId>`.
  - Git-Fehler werden als `log_warn` emittiert, blocken den Run **nicht**.

- **Smoke-Test** (`src/lib/gitchain-client.test.ts`): Lauffähig via `npm test`.
  - Legt Container an, macht zwei Commits, verifiziert SHA in DB, räumt auf.

## Bekannte Limitierungen

1. **Kein Phase-2-Promote**: Workspace-Container bleibt `workspace`. Upgrade zu `tax_case` (Phase 2) ist noch nicht implementiert.
2. **Keine Citations bei Run-Start**: Der workspace-Container verknüpft sich nicht automatisch mit dem Mandanten-Container. Muss in Phase 2 ergänzt werden wenn Mandant-ID aus dem Run-Input bekannt ist.
3. **Kein Retry bei Netz-/DB-Ausfall**: Git-Push-Fehler werden nur geloggt. Bei temporärem Ausfall geht der Commit verloren.
4. **Singleton-Client**: `getGitChainClient()` gibt eine einzige Pool-Instanz zurück. Kein graceful shutdown (kein `SIGTERM`-Handler). Für PM2-Betrieb kein Problem.
5. **Branch immer `main`**: Kein Branch-per-Run. Alle Commits gehen auf `main` des bare repos.
6. **`--initial-branch=main`**: Erfordert git ≥ 2.28. Auf REACTOR (Ubuntu 22.04) ist das erfüllt.

## Schritt-für-Schritt testen

### Voraussetzungen

```
gitchain-service-gitchain-postgres-1  läuft (Port 5433)
/home/christoph.bertsch/gitchain-repos/  existiert und ist beschreibbar
```

### 1. Smoke-Test (nur Client + DB + Git)

```bash
cd ~/0711/0711-STURM
GITCHAIN_DATABASE_URL="postgresql://gitchain:gitchain_password_2026@localhost:5433/gitchain" \
GITCHAIN_REPO_ROOT="/home/christoph.bertsch/gitchain-repos" \
npm test
```

Erwartete Ausgabe: `[test] ALL CHECKS PASSED`

### 2. End-to-End mit hello-ocr

`.env` (oder Prozessumgebung) setzen:
```
STURM_ARTIFACT_BACKEND=gitchain
GITCHAIN_DATABASE_URL=postgresql://gitchain:gitchain_password_2026@localhost:5433/gitchain
GITCHAIN_REPO_ROOT=/home/christoph.bertsch/gitchain-repos
GITCHAIN_API_URL=http://localhost:3361
GITCHAIN_DEFAULT_NAMESPACE=ctax
GITCHAIN_DEFAULT_TENANT=ctax-0711
```

Server starten und Run anstoßen (z.B. via Pipeline-UI auf Port 7800).

Nach dem Run prüfen:

```sql
-- In Postgres
SELECT id, type, mandant_id, latest_commit FROM registry.containers
WHERE namespace='ctax' AND type='workspace'
ORDER BY created_at DESC LIMIT 5;
```

Repo prüfen:
```bash
git -C /home/christoph.bertsch/gitchain-repos/workspace/ctax/sturm-<runId>.git log --oneline
```

### 3. Fallback prüfen

```bash
STURM_ARTIFACT_BACKEND=filesystem npm start
```

Verhalten identisch zu vor dieser Integration — keine GitChain-Aktivität.

## Architektur-Entscheidungen

- **Filesystem als primäre Wahrheit**: Artefakte landen weiterhin unter `runs/`. Git ist additiv.
- **Filesystem-Zugriff statt Smart-HTTP**: Da STURM auf REACTOR läuft, schreibt der Client direkt ins bare repo. Kein extra HTTP-Layer nötig.
- **Fehler-Toleranz**: Git-Fehler brechen den Workflow nicht ab. Das ist bewusst: OCR/LLM-Logik hat Vorrang vor Git-Persistenz.
