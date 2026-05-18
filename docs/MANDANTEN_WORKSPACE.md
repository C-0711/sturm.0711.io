# Mandanten-Workspace — Branch `feat/mandanten-workspace`

Stripped-down Multi-User-Surface unter `/m/*`. Zielgruppe: bis zu 10 Mandanten, Logins von Christoph vergeben. Jeder Mandant sieht nur seine eigenen Cases.

Diese Datei ist der **verbindliche Vertrag** zwischen P1 (Backend), P2 (Dashboard-UI) und P3 (Case-Detail-UI). Änderungen hier nur in Absprache.

## Modell

```
User (E-Mail + Passwort-Hash)
  └─ Workspace (1:1, automatisch beim Anlegen)
       └─ Cases (1:N) = bestehende `steuerfall-est` Instances mit `ownerUserId` Tag
            └─ Belege (1:N) = Uploads über bestehende upload-bulk-Route
```

## Verzeichnisse

| Pfad | Inhalt |
|---|---|
| `runs/_users/{userId}.json` | User-Account: `{id, email, passwordHash, workspaceId, createdAt}` |
| `data/applications/steuerfall-est/instances/{caseId}/manifest.json` | bestehend, bekommt zusätzliches Feld `ownerUserId` |

User-IDs sind kurze base36-Strings (nicht E-Mail-basiert). E-Mail ist sekundärer Lookup.

## API-Endpoints — verbindliche Shapes

### POST /api/m/login
Request:
```json
{ "email": "user@example.com", "password": "..." }
```
Response 200:
```json
{ "userId": "u_ab12cd", "workspaceId": "ws_xyz789", "email": "user@example.com" }
```
Setzt zusätzlich HttpOnly-Cookie `sturm_session`. Bei 401: `{ "error": "invalid_credentials" }`. Rate-Limit: 5 Versuche pro IP pro 5 Minuten.

### POST /api/m/logout
Cookie-required. Response 200: `{ "ok": true }`. Revoked die Session, löscht das Cookie.

### GET /api/m/me
Cookie-required. Response 200:
```json
{ "userId": "u_ab12cd", "email": "...", "workspaceId": "ws_xyz789" }
```
Bei 401: `{ "error": "no_session" }`. P2/P3 nutzen das als „Bin ich eingeloggt?"-Probe.

### GET /api/m/cases
Cookie-required. Response 200:
```json
{
  "cases": [
    {
      "caseId": "stricker-2023-ab12cd",
      "displayName": "ESt 2023",
      "veranlagungsjahr": 2023,
      "createdAt": "2026-05-18T08:00:00Z",
      "documentCount": 3,
      "lastRunAt": "2026-05-18T08:05:00Z",
      "abrechnungSummary": { "zvE": 51445.02, "erstattung": 63.68 } // null wenn noch nicht berechnet
    }
  ]
}
```
Liefert nur Cases mit `ownerUserId === req.session.userId`.

### POST /api/m/cases
Cookie-required. Request:
```json
{ "displayName": "ESt 2023", "veranlagungsjahr": 2023 }
```
Response 201:
```json
{ "caseId": "...", "displayName": "...", "veranlagungsjahr": 2023 }
```
Intern: ruft bestehende `POST /api/applications/steuerfall-est/instances` auf, setzt `ownerUserId` im manifest.

### DELETE /api/m/cases/:caseId
Cookie-required + ownership-check. Response 200: `{ "ok": true }`. Löscht den Case komplett (rm der instance + runs).

### Bestehende Endpoints mit Ownership-Guard

Folgende Endpoints bleiben unverändert in Shape, bekommen aber zusätzlich einen Ownership-Check, wenn sie über Session-Cookie (nicht Bearer) aufgerufen werden:

- `GET /api/applications/steuerfall-est/instances/:caseId` (Manifest)
- `GET /api/applications/steuerfall-est/instances/:caseId/result` (Output)
- `GET /api/applications/steuerfall-est/instances/:caseId/aggregate` (Konsolidierung)
- `POST /api/applications/steuerfall-est/instances/:caseId/upload-bulk` (Multi-Datei-Upload)
- `POST /api/applications/steuerfall-est/instances/:caseId/seal` (Versiegelung)

Bearer-Token-Aufrufe (Admin) umgehen den Ownership-Check.

## HTML-Routen

| Route | Auth | Datei |
|---|---|---|
| `/m/login` | none | `src/ui/m-login.html` |
| `/m/dashboard` | session-cookie (sonst Redirect auf /m/login) | `src/ui/m-dashboard.html` |
| `/m/case/:caseId` | session-cookie + ownership | `src/ui/m-case.html` |
| `/abrechnung.html` | bestehend, bekommt Cookie-Auth zusätzlich zu Bearer | unverändert |

Statische Assets (CSS, JS, Logo) liegen weiterhin in `src/ui/` und `src/ui/design-system/`.

## Admin-Gate für Sturm-Dev-Surface

Diese HTML-Routen erfordern weiterhin Bearer-Token (NICHT Session-Cookie):

- `/anwendungen.html`
- `/pipeline.html`
- `/designer.html`
- `/studio-ocr.html`
- `/workspaces.html`
- `/steuerfall.html`
- `/orchestrator.html`
- `/document.html`
- `/0711-fleet.html`

Implementierung: `requireBearerToken` Middleware vor den `app.get('/foo.html', ...)`-Routen. (Wird in P0 von Christoph gemacht.)

## Admin-CLI

```
npx tsx scripts/mandant-add.ts <email>
  → Generiert zufälliges Passwort (16 Zeichen)
  → Hasht mit argon2id (default Parameter aus node-argon2 / hash-wasm)
  → Legt User + Workspace an
  → Druckt Passwort EINMAL auf stdout
  → Exit-Code 1 bei E-Mail bereits vergeben

npx tsx scripts/mandant-add.ts list
  → Listet alle User: ID, E-Mail, Workspace-ID, createdAt

npx tsx scripts/mandant-add.ts revoke <email>
  → Löscht User + Sessions (nicht die Cases — die bleiben als Waisen)
```

## UI-Design — verbindlich für P2 und P3

**Stil-Vorlage**: `src/ui/ctx-demo.html` (864 Zeilen, design-system tokens, minimal).

- Schriften: `var(--font-inter)` für Text, `ui-monospace, "JetBrains Mono", monospace` für Codes/IDs
- Farben: `var(--color-bg)`, `var(--color-bg-tertiary)`, `var(--color-text-primary)`, `var(--color-text-secondary)`, `var(--color-text-tertiary)`, `var(--color-border)`, `var(--color-accent)`
- Header: schlicht, kein Sturm-Logo prominent, kein „STURM"-Schriftzug im Titel — stattdessen „Steuerfall" oder die Mandanten-E-Mail
- Body: `max-width: 980px; margin: 0 auto; padding: 36px 24px 96px;`
- KEIN Theme-Toggle (Light/Dark wird vom OS übernommen via design-system)
- KEINE Tool-Health-Dots, KEINE Workflow-Stage-Indikatoren, KEINE Run-IDs
- KEINE Wörter im UI: „v6-vision", „Stage", „phase3VisionFill", „MCP", „Tool", „Pipeline", „Workflow"
- Statt „phase3VisionFill" steht da „Feldextraktion läuft…"
- Statt „Run mp9ubr80" steht da nichts oder „letzter Lauf vor 3 Minuten"
- Fehler werden vereinfacht: keine Stack-Traces, kein vLLM-Body — stattdessen „Datei konnte nicht verarbeitet werden. [Erneut versuchen]"

**Strings sind komplett auf Deutsch** (siehe CLAUDE.md Regel 3).

## Aufgabentrennung Subagents

- **P1 (Backend, Worktree A)** — owns: `src/lib/m-users.ts`, `src/server/m-auth.ts`, `src/server/m-cases.ts`, `scripts/mandant-add.ts`, server.ts-Wiring nur für `/api/m/*` und Ownership-Guards. Schreibt `runs/_users/.gitkeep`.
- **P2 (Dashboard UI, Worktree B)** — owns: `src/ui/m-login.html`, `src/ui/m-dashboard.html`, ggf. `src/ui/m-dashboard.js`. Fetch nur gegen Endpoints aus diesem Dokument, kein direkter Sturm-API-Aufruf außer den hier definierten.
- **P3 (Case-Detail UI, Worktree C)** — owns: `src/ui/m-case.html`, ggf. `src/ui/m-case.js`. Lädt Daten via `/api/applications/steuerfall-est/instances/:caseId/aggregate` + `/result`. Für Belege-Upload nutzt `/api/applications/steuerfall-est/instances/:caseId/upload-bulk`.

**Beide UI-Subagents (P2, P3) müssen nicht warten auf P1** — sie können gegen mock-fetch oder gegen einen lokal laufenden Server (wenn P1 bereits fertig ist) entwickeln.

Christoph (P0) baut: Branch, dieses Dokument, Admin-Gate auf Dev-Surfaces, generische `/m/:page.html`-Static-Route. Nach Subagent-Return: Integration + Test.

## Was NICHT in MVP geht

- Mehrsprachigkeit (nur Deutsch)
- Mandanten-Self-Signup
- E-Mail-Versand (Passwort persönlich)
- Self-Service Passwort-Reset
- Rechnung / Bezahlung
- Mandant-zu-Mandant Sichtbarkeit
- Audit-Log über Mandanten-Aktionen
- Multi-Faktor-Auth
