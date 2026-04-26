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

---

## Phase 2 — Promote, Citations, Anchor (implementiert 2026-04-26)

### Was funktioniert

- **`GitChainClient.setMandantId(workspaceId, mandantId, tenantId)`**: Setzt `mandant_id` und `tenant_id` auf einem bestehenden Container-Eintrag in der DB.

- **`GitChainClient.promoteWorkspaceToTaxCase(input)`**: Promoted einen Workspace-Container zu einem `tax_case`-Container.
  - Legt `tax_case`-Container in DB an (idempotent: bei re-use wird bestehender Container genutzt).
  - Initialisiert (oder nutzt) das bare repo unter `GITCHAIN_REPO_ROOT/tax_case/ctax/<identifier>.git`.
  - Clont das Workspace-bare-repo in ein temp-Verzeichnis und kopiert `artifacts_to_merge` (default: `data/extraktion.json` + `data/elster.json`) in das tax_case-Arbeitsverzeichnis.
  - Commit-Message: `[promote] from workspace <workspace_id>`.
  - Citation `tax_case → derived_from → workspace` wird in DB eingetragen.
  - Atomizität: falls Promote fehlschlägt und der Container neu angelegt wurde, wird der DB-Eintrag und das bare repo zurückgerollt.

- **`GitChainClient.recordAnchor(input)`**: Schreibt einen Blockchain-Anker in `registry.anchors`.
  - Erwartet `container_id`, `tag`, `commit_hash` (required) sowie optionale `network`, `tx_hash`, `block_number`.
  - Konflikt-Strategie: `ON CONFLICT (container_id, tag) DO NOTHING`.
  - Kein echter Blockchain-Call — nur die DB-Schreibung, wenn ein Anchor von außen reinkommt.

- **`GitChainArtifactStore.bindMandant(mandantId, tenantId)`**: Verbindet den Workspace mit einem Mandanten.
  - Setzt `mandant_id` und `tenant_id` via `setMandantId`.
  - Fügt Citation `workspace → uses → mandant` ein, falls der Mandant-Container existiert.

- **Runner-Hook**: Wenn `opts.input.mandant_id` vorhanden, wird `bindMandant` automatisch nach dem gitChainStore-Init aufgerufen. Fehler werden als `log_warn` emittiert und blocken den Run nicht.

- **`POST /api/gitchain/promote`** (nur wenn `STURM_ARTIFACT_BACKEND=gitchain`):
  - Body: `{ run_id, tax_case_identifier, mandant_id, veranlagungsjahr, steuerart, display_name, finanzamt? }`
  - `workspace_id` wird abgeleitet: `0711:workspace:ctax:sturm-<run_id>`
  - Response: `{ ok, tax_case_id, created, commit_sha }`
  - Ohne `STURM_ARTIFACT_BACKEND=gitchain` → 503

- **Smoke-Test erweitert** (`src/lib/gitchain-client.test.ts`): Testet Phase 1 + Phase 2 komplett.
  - Workspace anlegen, Artifact-Dateien committen, bindMandant, promoteWorkspaceToTaxCase, Repo-Inhalt + Citations prüfen, vollständiges Cleanup.

### Schritt-für-Schritt testen (Phase 2)

```bash
cd ~/0711/0711-STURM
GITCHAIN_DATABASE_URL="postgresql://gitchain:gitchain_password_2026@localhost:5433/gitchain" \
GITCHAIN_REPO_ROOT="/home/christoph.bertsch/gitchain-repos" \
npm test
```

Promote manuell testen (Server muss laufen mit `STURM_ARTIFACT_BACKEND=gitchain`):
```bash
curl -s -X POST http://localhost:7800/api/gitchain/promote \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"<runId>","tax_case_identifier":"stricker-est-2024","mandant_id":"stricker-rainer-ute","veranlagungsjahr":2024,"steuerart":"ESt","display_name":"Stricker ESt 2024"}' | jq
```

Tax-Case-Repo prüfen:
```bash
git -C /home/christoph.bertsch/gitchain-repos/tax_case/ctax/stricker-est-2024.git log --oneline
```

DB prüfen:
```sql
SELECT id, type, mandant_id, latest_commit FROM registry.containers
WHERE namespace='ctax' AND type='tax_case'
ORDER BY created_at DESC LIMIT 5;

SELECT * FROM registry.citations WHERE relationship='derived_from' ORDER BY source_id;
```

### Bekannte Limitierungen (Phase 2)

1. **`artifacts_to_merge` sind Pfade im git-Repo** (relativ zum Workspace-Root). STURM schreibt Stage-Outputs unter `data/` — Stages müssen daher in dieses Verzeichnis schreiben, damit Promote sie findet.
2. **Mandant-Namespace ist `ctax` hardcoded** in `bindMandant` und `promoteWorkspaceToTaxCase`. Bei Multi-Namespace-Betrieb müsste der Namespace als Parameter mitgegeben werden.
3. **`recordAnchor`-Tabelle-Schema** weicht von der ursprünglichen Spezifikation ab: PK ist `(container_id, tag)`, und `tag` + `commit_hash` sind NOT NULL (Anpassung an das reale Schema in `registry.anchors`).
4. **Promote ist nicht idempotent für Artifacts**: Bei erneutem Promote wird der bestehende tax_case-Stand überschrieben (letzter Stand gewinnt). Das ist Absicht.
5. **Kein Promote-Lock**: Parallele Promotes auf denselben tax_case könnten zu race conditions führen. Für den Single-User-Betrieb auf REACTOR kein Problem.

## Architektur-Entscheidungen

- **Filesystem als primäre Wahrheit**: Artefakte landen weiterhin unter `runs/`. Git ist additiv.
- **Filesystem-Zugriff statt Smart-HTTP**: Da STURM auf REACTOR läuft, schreibt der Client direkt ins bare repo. Kein extra HTTP-Layer nötig.
- **Fehler-Toleranz**: Git-Fehler brechen den Workflow nicht ab. Das ist bewusst: OCR/LLM-Logik hat Vorrang vor Git-Persistenz.
