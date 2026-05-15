# Iteration 4 — Bulk-Upload + Case-Level-Aggregation

## Problem & Zielbild

**Heute:** ein Fall = N einzelne Workflow-Runs. Jeder Run hat seinen
eigenen `canonical_layer`. Das Result-Panel zeigt nur den **letzten** Run.
Folge: nicht alle Felder einer Steuererklärung sind extrahiert (weil jedes
Dokument nur seinen Teil enthält), und der Anwender muss N Mal hochladen.

**Ziel:**

1. **Multi-Upload in einem Schritt** — alle Belege per Drag-and-Drop oder
   File-Picker auf einmal.
2. **Case-Level-Layer** — die `canonical_layer` aller Dokumente werden zu
   einem Fall-Layer zusammengeführt.
3. **Eine BMF-Steuerberechnung über den merged Layer** — zvE, ESt, Soli,
   festzusetzende Steuer aus der Vereinigung aller Belege.
4. **Drill-Down pro Dokument** — Klick auf einen Beleg zeigt seinen
   einzelnen Run, seine Felder, seine OCR-Zeilen — der "stückweise"
   Workflow-Untersuch.
5. **Pflicht-Coverage sichtbar** — was fehlt noch, welcher Belegtyp könnte
   den fehlenden Wert liefern.

## Architektur-Entscheidungen

**Wo lebt die Aggregation?**
*Auf Application-Layer, nicht in einem Workflow.* Ein Workflow ist
single-input (ein Dokument). Die Fall-Aggregation gehört zur Lifecycle-
Logik (analog zu Seal). Stored derivable from `instance.runs[]` on demand.

**Wo werden die Dateien gespeichert?**
*Im Workspace des Falls* — `applications/<appId>/<caseId>/inbox/<filename>`.
Das ist schon der vorhandene Pfad aus `instance.workspacePath` (war bisher
leer). Vorteile:

- **Audit-Trail:** alle hochgeladenen Originalbelege bleiben im Fall.
- **Re-Runs:** wir können einen Run wiederholen, ohne den User nochmal die
  Datei picken zu lassen.
- **Seal liest aus:** `master.json` kann ein File-Manifest (sha256 + Name +
  Größe) der inbox referenzieren — sauberer Forensik-Trail.
- **Konsistenz mit Seal/Anchor:** die schreiben schon nach
  `applications/<appId>/<caseId>/seal/` und `/anchors/`. Inbox wohnt im
  gleichen Workspace.

Inbox-Layout nach v1:
```
applications/<appId>/<caseId>/
├── inbox/
│   ├── 2026-05-15T08-22-13_lohnsteuer-mustermann.pdf
│   ├── 2026-05-15T08-22-13_spendenquittung.pdf
│   └── _manifest.json    { files: [{ name, sha256, size, runId, anlagen }] }
├── seal/
│   └── master.json
└── anchors/
    └── …
```

`_manifest.json` ist die kanonische Liste — die Instance speichert nur
`documents: [{ runId, filename, ... }]`-Pointers auf dieses Manifest. Wenn
sturm-Postgres irgendwann doch aktiviert wird, lässt sich das Manifest 1:1
in `registry.documents` migrieren.

**Konflikte beim Merge.**
Zwei Dokumente liefern denselben eCode mit verschiedenen Werten. Drei
Klassen:
- **Bestätigt** — gleicher Wert in ≥2 Belegen → Confidence ↑
- **Konflikt** — verschiedene Werte → behalten alle, flag für Review
- **Eindeutig** — nur ein Beleg, ein Wert → übernehmen wie heute

**Konflikt-Resolution-Regel (v1):** der Beleg mit höherer Trust-Stufe
gewinnt (`REGEX_100%` > `REGEX_3F` > `LLM_FSM`). Bei gleicher Trust-Stufe
und unterschiedlichem Wert → flag manuell.

**BMF-Re-Compute.** Lane-1 BMF braucht eine eCode-Map als Input. Die
hat sie schon — wir füttern jetzt die *merged* Map statt der per-doc Map.
Kostet 1 zusätzlichen MCP-Call pro Aggregation (cache-fähig).

## Iteration 4 — Tickets

| ID | Mangel/Feature | Effort | Akzeptanz |
|---|---|---|---|
| I4.1 | Bulk-Upload-Endpoint | M | `POST /api/applications/:appId/instances/:caseId/upload-bulk` nimmt N Dateien (`multer.array('files', 20)`). **Persistiert jedes File in `applications/<appId>/<caseId>/inbox/<ts>_<filename>`** (Workspace-Inbox), schreibt `_manifest.json` fort. Startet pro Datei einen `elster-v5_2-rag`-Run parallel (Concurrency 2-3, aus Cloud-Cost-Sicht). Multiplexed SSE: pro Datei `{ name: 'doc_start', idx, filename, runId }` und `{ name: 'doc_done', idx, runId, fields }`. Am Ende ein `bulk_done`-Event mit Liste aller runIds. Instance.runs[] wird inkrementell befüllt. |
| I4.2 | Per-Doc-Metadaten in Instance + Workspace-Manifest | S | Erweitere `ApplicationInstance` um `documents: [{ runId, filename, inboxPath, sha256, size, uploadedAt, anlagen, fieldsExtracted }]`. Befüllt bei `upload` + `upload-bulk`. Zusätzlich `_manifest.json` im Workspace-Inbox als kanonische Liste (Migrations-Pfad zu gitchain/Postgres falls jemals aktiviert). Bestehende Einzel-Upload-Route wird auf das gleiche Storage-Pattern umgestellt. |
| I4.3 | Case-Level-Layer-Aggregation | M | Neue Funktion `aggregateCase(inst)` in `src/server/aggregation.ts`. Lädt für jeden runId in `inst.runs` das `phase6BmfRechner/output.json` (canonical_layer). Merge nach eCode mit Conflict-Detection. Output: `{ merged_layer, conflicts, sources_per_ecode, by_anlage }`. Cache-Key: hash(runIds) — Recompute nur wenn neue Runs dazukommen. |
| I4.4 | Case-Level-BMF-Compute | S | Wenn `merged_layer.E0200201` (Bruttoarbeitslohn) und andere Hauptfelder belegt sind: `BmfMcpClient.berechneVollstaendigeSteuerV2(merged_layer, jahr)` aufrufen und Ergebnis cachen. Falls MCP unreachable: graceful (kein hard fail, kpi_warning). |
| I4.5 | `GET /aggregate` Endpoint | S | `GET /api/applications/:appId/instances/:caseId/aggregate` liefert: documents[], merged_layer, conflicts, pflicht_missing[], bmf-result, stats. Token-frei (analog zu /result). |
| I4.6 | Pflicht-Coverage-Berechnung | S | In `aggregateCase`: lade `felderFuerAnlage()` für jede in `inst.documents` erkannte Anlage. Diff gegen `merged_layer`-Keys → liefere `pflicht_missing: [{ eCode, anlage, drucktext, suggestedDocs: ['Lohnsteuerbescheinigung', ...] }]`. Suggestion via Lookup-Table je Anlage. |
| I4.7 | UI: Multi-File Drop-Zone | M | `<input type="file" multiple>` + Drop-Handler nimmt FileList. Pre-Upload-Liste: für jede Datei eine Mini-Card mit Filename, Größe, X-zum-Entfernen. Submit-Button "Alle hochladen (N)". Während Upload: pro Card State-Badge (queued / läuft / ✓ / ✗). |
| I4.8 | UI: Gesamt-Ergebnis-Panel | M | Neues Panel über Layer-Tabelle: "Gesamterklärung" mit BMF-Tile (zvE, ESt, Soli, festzusetzende Steuer als groß-formatige Werte). Daneben Pflicht-Coverage als Donut/Progress (z.B. "12 von 17 Pflicht-Felder belegt"). |
| I4.9 | UI: Per-Doc-Drill-Down | M | Im Layer eine zusätzliche Spalte "Quelle" mit Doc-Names. Klick auf eine Source → öffnet Run-Detail-Modal (existiert schon) mit dem spezifischen Run. Filter im Layer-Panel: "nur eCodes von Doc X". |
| I4.10 | UI: Konflikt-Anzeige | S | Im Layer-Panel: bei `merged_layer[eCode].conflicts`, rote Markierung in der Zeile. Click → Aufklapp mit allen kandidierenden Werten + ihrer Source. Manual-Resolve-Button schreibt den User-Pick in eine Override-Map. |
| I4.11 | UI: Pflicht-Fehlend-Liste | S | Unter "Gesamterklärung": Klappbare Liste "Pflicht-Felder fehlend (N)" mit `eCode · drucktext · "vermutlich in: [Lohnsteuerbescheinigung]"`. Klick auf einen Eintrag → fokussiert die Upload-Zone, optional Pre-Selection des Dokumenttyps für den Klassifizierer. |

## Architektur-Skizze

```
User dropt 5 Dateien
       │
       ▼
POST /upload-bulk (multipart, 5x file)
       │
       ├── parse, validate, save 5 uploads
       │
       ├── for each (mit max-Concurrency 3):
       │     ├── runWorkflow(elster-v5_2-rag, {file_i})  ─── parallel
       │     └── push runId, filename in inst.documents[]
       │
       ├── SSE stream:
       │     doc_start { idx, filename, runId }
       │     stage events (mit doc: prefix)
       │     doc_done { idx, runId, fields }
       │     ... (für alle 5 Dokumente verzahnt)
       │     bulk_done { runIds: [...] }
       │
       └── beim letzten doc_done: aggregateCase(inst)
                                  + BMF-Compute
                                  + write merged-layer cache file
       
User sieht in der UI:
   ─────────────────────────────────────────
   │ Gesamterklärung                     │
   │ ─ zvE         63 559 €               │
   │ ─ ESt         17 968 €               │
   │ ─ Soli         0 €                   │
   │ ─ Pflicht: 12/17 belegt              │
   ─────────────────────────────────────────
   │ Belege (5):                          │
   │ ▸ Lohnsteuer.pdf      ✓ 20 Felder    │
   │ ▸ Spendenquittung.pdf ✓ 3 Felder     │
   │ ▸ Rentenbezug.pdf     ✓ 4 Felder     │
   │ ▸ KapErtrag.pdf       ✓ 2 Felder     │
   │ ▸ Vorsorge.pdf        ✓ 5 Felder     │
   ─────────────────────────────────────────
   │ Canonical Layer (merged)            │
   │ eCode · Feld · Wert · Quelle · …    │
   │ E0200201 · Bruttoarbeitslohn  6929180 │ 📄 Lohnsteuer.pdf  REGEX_3F
   │ E0700101 · Spendenbetrag       30000 │ 📄 Spende.pdf      REGEX_100%
   │ ...                                  │
   ─────────────────────────────────────────
   │ Pflicht-Felder fehlend (5)          │
   │ ▸ E… Bezeichnung — z.B. in:         │
   │     "Beitragsbescheinigung Kranken" │
   ─────────────────────────────────────────
```

## Datenmodell-Änderungen

### `ApplicationInstance` (erweitern)
```ts
documents?: Array<{
  runId: string;
  filename: string;
  uploadedAt: string;
  anlagen: string[];           // klassifizierung.erkannte_anlagen
  fieldsExtracted: number;     // count of canonical_layer entries
  size: number;
}>;
```

### Neue Files
- `src/server/aggregation.ts` — `aggregateCase(inst, RUNS_DIR)` returns merged_layer + diagnostics
- `src/server/document-type-hints.ts` — Lookup-Tabelle eCode → wahrscheinliche Dokumenttypen

### Neue Endpoints
- `POST /api/applications/:appId/instances/:caseId/upload-bulk` (multipart, multi-file)
- `GET  /api/applications/:appId/instances/:caseId/aggregate`

### Geänderte UI-Files
- `src/ui/steuerfall.html` — Drop-Zone multi, neue Panels
- Optional: kleine CSS-Ergänzungen für die neuen Donut/Konflikt-Komponenten

## Verifikation

### Unit-Tests (`npm test`)
- `aggregateCase` mit 3 mock-Runs:
  - identische eCodes mit gleichem Wert → bestätigt
  - verschiedene Werte → Konflikt
  - disjunkte eCodes → Union
- Pflicht-Coverage:
  - Anlage N mit allen Werten → coverage 100%
  - Anlage N ohne Bruttoarbeitslohn → coverage <100%, missing-Liste enthält E0200201

### E2E (Erweiterung `scripts/e2e-anwendungen.mjs`)
- Step neue Variante: lade 2 verschiedene Dokumente per Bulk-Upload
- Erwarte: `documents.length === 2`, `merged_layer` enthält eCodes von beiden, `aggregate` 200

### Production-Smoke
1. Bestehender Steuerfall, 1 Lohnsteuer + 1 Spendenquittung bulk-uploaden.
2. Check `/aggregate` → BMF-Computed-Felder + Pflicht-Coverage > 0.
3. Click pro-Doc-Source in der Layer-Tabelle → Run-Detail-Modal öffnet sich mit korrektem runId.

## Risiken & Mitigations

| Risiko | Mitigation |
|---|---|
| 5 parallele LLM-Calls überlasten vLLM auf h200v | Concurrency-Limit (default 3) auf Server-Seite, throttle bei `429`. |
| Cloud-API-Cost (wenn ensemble-Workflow gewählt) | Default bleibt `elster-v5_2-rag` (1 LLM). Bulk-Endpoint zeigt die geschätzten Kosten vor Submit (ggf. v2). |
| SSE-Stream-Wirr mit 5 verzahnten Runs | Strikte Event-IDs: `doc:idx:name` und nicht `name` alleine. UI parsed nach Prefix. |
| Konflikt-Resolution-Logik macht falsche Picks | "Bestätigt" und "Konflikt" markieren, nichts auto-auflösen außer bei Trust-Stufe-Sieg. Manual Override schreibt audit-trail. |
| Pflicht-Coverage wird falsch berechnet wenn Anlage N 0 Pflicht-Atome hat (D1) | Coverage-Indikator zeigt "nicht messbar" statt 100% wenn 0 Pflicht-Atome im Katalog. Im Long-Run: M7 BMF-Katalog reviewen. |

## Reihenfolge / Abhängigkeiten

```
I4.2 (Document-Meta)         ──┐
                               ├→ I4.1 (Bulk-Upload-Endpoint)
                               │
I4.3 (Aggregation)         ────┤
I4.4 (BMF-Compute)         ────┼→ I4.5 (Aggregate-Endpoint)
I4.6 (Pflicht-Coverage)    ────┘     │
                                     │
                                     ├→ I4.7 (Multi-Drop-UI)
                                     ├→ I4.8 (Gesamt-Panel)
                                     ├→ I4.9 (Drill-Down)
                                     ├→ I4.10 (Konflikt-UI)
                                     └→ I4.11 (Pflicht-Liste)
```

Backend-Bundle (I4.1–I4.6) kann zuerst landen. UI-Bundle (I4.7–I4.11)
darauf aufbauen. Insgesamt **2–3 Tage**.

## Folge-Ideen (out of scope für I4)

- **Manueller Field-Override**: User kann pro eCode einen Wert eintippen statt aus einem Beleg, mit Audit-Trail "manual entry by Christoph".
- **Document-Replace**: ein Beleg austauschen ohne den ganzen Fall neu zu uploaden. Dank Workspace-Inbox: alte Datei umbenennen in `_replaced/`, neue ablegen, Run wiederholen.
- **Multi-Year-Fälle**: ein Mandant über mehrere Jahre, Cross-Jahres-Vergleich.
- **Verlustvortrag** über Veranlagungsjahre hinweg, sobald die Fall-Lifecycle-Verkettung steht.
- **PDF-Vorschau im Drill-Down**: Inbox-Files via `/api/applications/.../files/:name` ausliefern, im Run-Detail-Modal einbetten — dann sieht man das Original-PDF neben dem extrahierten Layer.
