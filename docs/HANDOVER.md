# STURM — Übergabe (Stand 2026-04-24)

Dieses Dokument fasst den aktuellen Stand des Projekts zusammen, damit ein anderer Entwickler (oder eine neue Claude-Session) ohne Rückfragen weiterarbeiten kann. Es ist **selbsttragend** — für Phasen-Details siehe zusätzlich `docs/ROADMAP.md`.

## Kurzüberblick

**STURM** ist eine daten-getriebene Workflow-Engine in TypeScript (`tsx`, kein Build-Step). Stages bilden einen gerichteten Graph, der Runner sortiert topologisch, führt Layer parallel aus, streamt SSE-Events und persistiert Artefakte pro Run.

Drei registrierte Workflows:

| ID | Zweck | Status |
|---|---|---|
| `hello-ocr` | OCR-Demo (Bild/PDF → Mistral OCR → Text-Stats) | Lauffähig |
| `elster-v1` | Ausgefülltes ELSTER-Formular (pdf/scan) → Anlagen-Klassifizierung → Feldextraktion pro Anlage | Lauffähig, aber nicht primärer Fokus |
| `steuerbelege-v1` | **Einzelner privater Steuerbeleg** → Dokumenttyp-Klassifizierung → ELSTER-eCode-Extraktion | **Aktiver Entwicklungsstrang** |

Runtime: Node.js + tsx, Port **7800**, läuft unter PM2 als Prozess `sturm` (Script `start.sh`, mehrfach restart-fest).

## Aktueller Stand

- **P0** Grund-Workflow `steuerbelege-v1` mit 12 Typen — erledigt
- **P1** Katalog auf **55 Typen** erweitert, 47 davon mit gepflegten eCode-Hints (273 Codes), 6 als reine Dokumentation (`anlage: null`) — erledigt
- **P1.5** VZ-Refactor: Kataloge in `data/<VZ>/` strukturiert, Loader mit optionalem VZ-Parameter — erledigt
- **P1.6** S-Scope-Erweiterung: 8 Belegtypen für kleine Nebentätigkeit (2 auf Anlage S mit eCodes, 6 als `anlage: null` Dokumentation) — erledigt
- **P1.7** Multi-Beleg-PDF-Splitting — **offen, neu identifiziert** (siehe Strukturprobleme)
- **P1.8** Multi-Anlage pro Beleg — **offen, neu identifiziert**
- **P2**–**P10** — siehe `docs/ROADMAP.md`

## Architektur

### Engine (`src/core/`)

- **`types.ts`** — Typen: `WorkflowDef`, `StageDef`, `StageContext`, `EventEnvelope`, `RunResult`
- **`workflow.ts`** — `defineWorkflow()`, `topoLayers()` (Zyklus-Erkennung)
- **`runner.ts:84`** — `runWorkflow()` startet Run, liefert `{ runId, bus, result }`. Input-Resolver versteht `${stage.field.path}` und `${input.X}`. Pro Layer parallel; bei Fehler überspringt der Runner Folge-Layer (`state: 'partial'|'error'`). Log-Sanitizer kappt Strings >2000 chars, ersetzt Buffers.
- **`events.ts`** — Pub/Sub + SSE-Formatter
- **`artifacts.ts`** — Datei-Store unter `runs/<workflow>/<runId>/`, Path-Escape-Schutz
- **`registry.ts`** — globale Maps für Stages und Workflows

Kein Postgres, kein Redis, keine Queue. Alles Dateibasiert.

### Server (`src/server.ts`)

- `GET /api/workflows` — Liste registrierter Workflows
- `GET /api/workflows/:id` — Definition einer Workflow-Instanz
- `POST /api/upload` — Multipart-Upload, liefert Meta
- `POST /api/workflows/:id/run` — Run starten, SSE-Frames live (initial `run_meta`, dann `stage_start`/`stage_done`/…) — Run läuft weiter wenn Client disconnected
- `GET /api/runs/:workflowId/:runId` — finales `_result.json`
- Static UI unter `src/ui/` (ReactFlow via CDN, Babel inline)

### Verzeichnisstruktur

```
src/
  core/                         Engine-Kernel
  stages/                       Generische, wiederverwendbare Stages
    mistral-ocr.ts              OCR via Mistral /v1/document-analysis
    text-stats.ts               Text-Statistik (für hello-ocr)
  workflows/
    hello-ocr/                  Demo-Workflow
    elster/                     Workflow für ausgefüllte ELSTER-Formulare
      index.ts                  defineWorkflow
      stages/
        klassifizierung.ts      Anlagen-Erkennung (Regex + LLM-Fallback)
        extraktion.ts           Per-Anlage-Feldextraktion (parallel)
      lib/
        mistral-chat.ts         Wrapper für /v1/chat/completions json_object
        anlagen-katalog.ts      loadKatalog(vz?), loadFelder(anlage, vz?), listVZ(), currentVZ()
      data/
        2024/                   ERiC-Kataloge VZ 2024 (vom Refactor P1.5)
          anlagen.json          35 ELSTER-Anlagen (Meta)
          felder/*.json         35 Einzel-Kataloge mit Feldern (eCode, Drucktext, Vordruckzeile, Format, Pflicht)
    steuerbelege/               Workflow für einzelne private Belege (primär)
      index.ts                  defineWorkflow
      stages/
        dokument-typ.ts         Beleg-Klassifizierung gegen 55-Typen-Katalog (Regex + LLM)
        beleg-extraktion.ts     Feld-Extraktion gegen Ziel-Anlage (eCode-Hints oder Ranking-Fallback)
      lib/
        typen-katalog.ts        loadDokumenttypen()
      data/
        dokumenttypen.json      55 Beleg-Typen (id, label, anlage|null, patterns, ecodeHints)
  ui/
    pipeline.html               ReactFlow-UI (rendert dynamisch jeden registrierten Workflow)
    …Design-Assets
  server.ts                     Express + SSE
docs/
  ROADMAP.md                    Phasen-Plan (P0..P10), Entscheidungen, Risiken
  HANDOVER.md                   DIESES Dokument
  WORKFLOW_TEMPLATE.md          Prompt-Spec für neue Workflows
uploads/                        Multipart-Uploads (gitignored)
runs/                           Artefakte pro Run (gitignored — sensible Daten)
legacy/
  elster-mvp/server.mjs         Ursprünglicher Playground-Code (3081 Zeilen, eingefroren)
```

### Workflow `steuerbelege-v1` — DAG

```
ocr (mistral-ocr) ──▶ dokument-typ ──▶ beleg-extraktion
```

- **ocr** — Mistral Document-Analysis, liefert `{ pages, text, chars, ms }`
- **dokument-typ** — Regex-first gegen 55 Typen; LLM-Fallback (Mistral small, JSON-Mode) bei schwachem/mehrdeutigem Regex-Ergebnis. Output: `{ typ_id, label, anlage, ecodeHints, konfidenz, regex_scores, llm_vote, used_llm, ms }`
- **beleg-extraktion** — Wenn `anlage == null` → Skip (Beleg als reine Dokumentation). Sonst: Felder aus `data/<VZ>/felder/<anlage>.json` laden, nach `ecodeHints`-Whitelist filtern (Fallback: Ranking auf Top-60 nach Pflicht+Vordruckzeile+Drucktext), Mistral chat mit strengem JSON-Output, Werte auf erlaubte eCodes mappen. Output: `{ typ_id, anlage, values, filled, fieldCount, skipped, reason?, ms }`

## Datenmodell

### `dokumenttypen.json` (55 Typen)

Verteilung:

| Anlage | Typen |
|---|---:|
| N | 9 (Lohn, Werbungskosten-Varianten, Versorgungsbezüge) |
| SA | 6 |
| AgB | 6 |
| `null` | 6 (Betriebsausgaben ohne EÜR — reine Doku) |
| Kind | 5 |
| VOR | 5 |
| KAP | 4 |
| HA_35a | 3 |
| V | 3 |
| S | 2 (Honorar, Übungsleiter) |
| N_DHH, AUS, R, AV, EM_35c, ESt1A | je 1 |

Typ-Struktur:

```json
{
  "id": "lohnsteuerbescheinigung",
  "label": "Lohnsteuerbescheinigung",
  "anlage": "N",
  "patterns": ["Lohnsteuerbescheinigung", "eTIN", …],
  "ecodeHints": ["E0200204", "E0200304", "E0200404", …]
}
```

`anlage: null` heißt: Beleg wird klassifiziert und in der Beleg-Liste geführt, aber nicht in eCodes extrahiert (Beispiel: `betriebsausgabe_material`, `geschaeftskonto_auszug`).

### ERiC-Feld-Kataloge

Unter `src/workflows/elster/data/2024/` liegen 36 JSON-Dateien (1 Meta + 35 Anlagen), zusammen ~56.700 Zeilen, aus der offiziellen ERiC-XML abgeleitet. Pro Feld: `Name` (eCode `E0200204`), `Drucktext`, `Vordruckzeile`, `Format`, `FormatRegex`, `MinLaenge`, `MaxLaenge`, `Pflichtfeld`, `pflicht` (bool). Das sind die Autoritätsdaten — nicht manuell pflegen, sondern aus ERiC regenerieren.

## Fixierte Entscheidungen (2026-04-24)

1. **LLM-Hosting**: Mistral überall (API-Key `MISTRAL_API_KEY`). Datenschutz-Note: Belege mit IDNr, Kontodaten, Gesundheitsdaten gehen nach Paris. Logs sanitisiert, `runs/` + `uploads/` gitignored.
2. **Mandat-Auth**: Single-User, kein Auth-Layer. Das „Veranlagungs"-Konzept in P4 ist reiner Ordnungsbegriff.
3. **ERiC-Abgabe**: P10 ist **fest** — echte Abgabe via BMF-ERiC-Binary. Separater Service, braucht persönliches ELSTER-Zertifikat.
4. **Scope**: privat + kleine Nebentätigkeit (Anlage S minimal). Kein G, kein EÜR, keine Umsatzsteuer.
5. **VZ-Versionierung**: `data/felder/<VZ>/` aktiv (derzeit nur `2024`). Loader `loadFelder(anlage, vz?)`, Default = höchster Ordner.

Details und Begründung: `docs/ROADMAP.md` Abschnitt „Konsequenzen für die Roadmap".

## Offene strukturelle Probleme

Beide beim Test mit einem echten Beleg (Lohnsteuerbescheinigung + 2 Freistellungs-Mitteilungen + 2 Religion-Seiten in **einem** PDF) aufgedeckt. Unsere aktuelle Pipeline verliert ~75 % der Werte.

### Problem A — Multi-Beleg-PDF

Ein einzelnes PDF kann N logische Belege enthalten (Beispiel real: 5 Seiten = 5 verschiedene Belegtypen, Ziel-Anlagen ESt1A + N + VOR + KAP). Die Pipeline behandelt das als **einen** Beleg und klassifiziert genau einen Typ.

**Lösung (P1.7)**: neue Stage `seiten-splitter` zwischen `ocr` und `dokument-typ`. Zerlegt nach Markdown-Headings (`# Lohnsteuerbescheinigung …`) oder LLM-Entscheidung in `subBelege: [{pages, text}, …]`. Der Runner muss **Fan-out** unterstützen — das kann er heute nicht. Zwei Varianten:

- **A1**: Splitter startet **Kind-Runs** (ein neuer Run pro Sub-Beleg, mit eigenem runId), gibt deren runIds zurück. Saubere Trennung, nutzt Engine wie sie ist.
- **A2**: Engine um Fan-out-Fähigkeit erweitern (Stage emittiert N Results, Folge-Stages werden N-fach ausgeführt). Invasiver, aber mehr in einem Run gebündelt.

Empfehlung: **A1**. Macht den Splitter zum Orchestrator-Dings, die Kind-Runs laufen normal.

### Problem B — Multi-Anlage pro Beleg

Selbst ein einzelner Beleg kann Werte für mehrere Anlagen enthalten (Beispiel: Lohnsteuerbescheinigung → **N** für Lohn/LSt/SolZ, **VOR** für SV-Beiträge Nr. 22–27; Rentenbezugsmitteilung → **R** für Rente, **VOR** für KV/PV des Rentners; Jahressteuerbescheinigung → **KAP** plus potenziell AUS für ausl. Quellensteuer).

Unser Modell ist heute `anlage: string | null` — **eine** Anlage pro Typ.

**Lösung (P1.8)**: Katalog-Schema ändern auf `anlagen: string[]` mit `ecodeHintsProAnlage: { [anlage]: string[] }`. Die `beleg-extraktion`-Stage läuft pro Anlage einen LLM-Call (parallel). Output: `values` wird `{ [anlage]: { [eCode]: value } }`. Das löst das Problem sauber und passt auch zu Belegen mit `anlage: null` (einfach leerer String-Array).

### Reihenfolge-Empfehlung

P1.8 **vor** P1.7 bauen — halb so komplex wie Splitting, bringt sofort Nutzen auch wenn das PDF nur einen logischen Beleg enthält. P1.7 danach.

## Betrieb

### Start/Stop

- **PM2**: `pm2 list | grep sturm` (Prozess-ID 20). Restart: `pm2 restart sturm`. Logs: `logs/sturm.out.log` + `logs/sturm.err.log`. Script: `start.sh` (sourced `.env`, startet `tsx src/server.ts`).
- **Manuell ohne PM2** (für Dev): `PORT=7801 npx tsx src/server.ts` — anderer Port, damit der PM2-Service weiterläuft.

### Env

- `MISTRAL_API_KEY` — pflicht für OCR und alle LLM-Stages
- `PORT` — Default 7800
- `ANTHROPIC_API_KEY`, `OLLAMA_URL` — nicht aktiv genutzt (vorbereitet für P1-Entscheidung C, die nicht gewählt wurde)

### Testlauf

```bash
curl -N -X POST http://localhost:7800/api/workflows/steuerbelege-v1/run \
  -F file=@/pfad/zu/beleg.pdf
```

Liefert SSE-Frames. Finales Ergebnis auch per `GET /api/runs/steuerbelege-v1/<runId>` nach `run_done`.

### Sensible Daten

`runs/<workflow>/<runId>/` enthält den OCR-Klartext und alle Extraktions-Ergebnisse — bei echten Belegen also IDNr, Kontodaten, Gehalt, Gesundheitsinfos. **Nicht committen**, beim Testen regelmäßig aufräumen. `uploads/` genauso.

## Wichtige Dateien (Quick-Reference)

| Datei | Was drin |
|---|---|
| `src/workflows/steuerbelege/data/dokumenttypen.json` | 55 Belegtypen — Hauptkatalog |
| `src/workflows/steuerbelege/index.ts` | Workflow-Definition |
| `src/workflows/steuerbelege/stages/dokument-typ.ts` | Klassifizierungs-Stage |
| `src/workflows/steuerbelege/stages/beleg-extraktion.ts` | Extraktions-Stage |
| `src/workflows/elster/lib/anlagen-katalog.ts` | Loader mit VZ-Parameter |
| `src/workflows/elster/lib/mistral-chat.ts` | Mistral API Wrapper |
| `src/workflows/elster/data/2024/felder/*.json` | 35 ERiC-Feld-Kataloge (shared zwischen elster-v1 und steuerbelege-v1) |
| `src/core/runner.ts` | Runner mit topo-Layer-Parallelität |
| `src/server.ts` | HTTP + SSE |
| `docs/ROADMAP.md` | Phasen P0..P10, Entscheidungen |
| `CLAUDE.md` | Projektregeln (Stages-Kontrakt, Benennung, keine Case-Daten hartcodieren) |

## Was als Nächstes

Reihenfolge, wie ich es machen würde, wenn ich der Übernehmer wäre:

1. **Eigenen Test-Beleg durchjagen** (echtes PDF, das reproduzierbar ist). Ergebnis als anonymisiertes Fixture in `eval/gold/` ablegen — damit jede Folge-Änderung gegen dasselbe Dokument messbar wird.
2. **P1.8 (Multi-Anlage)**: Schema-Upgrade `anlage → anlagen[]`. Bestehende 55 Typen mit ein-elementigen Arrays migrieren (oder Kompat-Schicht im Loader). Dann für die Schwergewichte (`lohnsteuerbescheinigung`, `rentenbezug`, `kapitalertrag_jahressteuerbescheinigung`) die zweite Anlage + eCode-Hints nachtragen.
3. **P1.7 (Splitting)**: Kind-Runs-Ansatz (A1). Neue Stage `seiten-splitter`, neuer Endpoint oder Callback-Logik im Server, die Kind-Runs orchestriert. UI zeigt dann die Beleg-Familie statt einzelner Run.
4. **P2 (Kontext)**: Person A/B, VZ, Absender, Zeitraum — nachdem Splitting und Multi-Anlage sauber laufen.
5. **Irgendwann P10 (ERiC)**: separater Service, klar abgegrenzt, eigenes Projektverzeichnis.

## Offene Punkte für den Übernehmer

- **Eval-Set**: bisher keines vorhanden. Jede Änderung am Klassifizierer oder den eCode-Hints ist aktuell blind. Priorität nach dem ersten echten Durchlauf.
- **UI-Verbesserungen**: `pipeline.html` ist ein ReactFlow-Debug-Tool. Für Endbenutzer (auch wenn Single-User) braucht's später P8 — Haupt-UI mit Belegliste und Anlagen-Übersicht.
- **Error-Handling bei Mistral-Rate-Limits / 5xx**: die Stages haben keinen Retry. Bei Ausfall fällt der komplette Run. Einfache Retry-mit-Backoff-Schicht in `mistral-chat.ts` wäre schnell gemacht.
- **OCR-Qualität**: gescannte Belege mit schlechter Auflösung produzieren teils fragwürdigen Text. Einen zweiten OCR-Fallback (Tesseract lokal) als Vergleich einzubauen, würde helfen, aber nur wenn wirklich Bedarf besteht.
- **VZ-Drift**: wenn VZ 2025 ausgerollt wird, muss ERiC-XML entsprechend geparst und unter `data/2025/` abgelegt werden. Der Parser-Code dafür liegt nicht im Repo — wurde extern einmal ausgeführt. Das sollte beim nächsten VZ dokumentiert oder ins Repo genommen werden.

## Prinzipien (aus CLAUDE.md, gelten weiterhin)

- Workflows sind Daten, nicht Code-Varianten. Neue Typen = JSON-Erweiterung.
- Stages sind pur bezüglich Seiten-Effekte — nur `ctx.emit`, `ctx.artifacts`, `ctx.logger`.
- Keine Case-Daten hartcodieren. Beleg-spezifische Werte nie in Code oder Prompts.
- Keine Modell-Namen in User-facing Strings. „Mistral OCR" / „Kurator" statt API-IDs.
- Stages rufen keine anderen Stages auf — Orchestrierung macht der Runner.
- Deutsche Benennung (`klassifizierung`, `beleg-extraktion`, nicht `classification`).
