# STURM Pipeline Prototype — Pass 1+2+3

Lauffähiger Python-Prototyp der STURM Smart-Extraktions-Pipeline.

Pass 1 (kleines Mistral-Modell) → Strukturerkennung
Pass 2 (parallel Mistral Large pro sub_anlage) → tiefe ELSTER-Extraktion
Pass 3 (kein LLM) → Reconciliation, IdNr-Kanonisierung, Master-Merge

Streamt RFC-6902-shaped `state.patch`-Events gegen Case-State v1
(`frontend/public/doku/case_schema_v1.json`).

## Komponenten

| Datei | Zweck | LOC |
|---|---|---|
| `state_patch.py` | RFC-6902-Patch-Emitter, Helper-Funktionen | ~160 |
| `mistral_client.py` | Async Wrapper (OCR, JSON-Mode, Function-Call) | ~210 |
| `pass1_klassifikation.py` | Strukturerkennung + Heuristik-Fallback | ~210 |
| `pass2_extraktion.py` | Smart-Schema-Service-Call + Mistral-Large-Extraktion | ~270 |
| `pass3_reconciliation.py` | Personen-Merge, Master-Merge, Profil | ~290 |
| `pipeline.py` | Orchestrator, Streaming-API | ~290 |
| `demo_stricker.py` | End-to-End-Demo gegen Stricker ESt 2023 | ~150 |

Total: ~1.580 LOC Python.

## Voraussetzungen

- Python 3.11+
- Smart-Schema-Service (Agent E) auf `http://localhost:7820/` (`/health` muss `200` liefern)
- Mistral API Key in ENV (`MISTRAL_API_KEY`)

## Setup + Run

```bash
cd /home/christoph.bertsch/dev-cb-ctax/scripts/sturm_pipeline_prototype/
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export MISTRAL_API_KEY=$(grep '^MISTRAL_API_KEY=' ~/dev-cb-ctax/backend/.env | cut -d= -f2)
# Optional zweiter Key fuer Rate-Limit-Rotation:
export MISTRAL_API_KEY_2=$(grep '^MISTRAL_API_KEY_2=' ~/dev-cb-ctax/backend/.env | cut -d= -f2)

python demo_stricker.py
```

## Erwartetes Timing pro Stage

| Stage | Ziel | Realistisch (1 PDF, 6 Seiten, 6 Sub-Anlagen) |
|---|---|---|
| OCR (Mistral OCR API) | — | 3-7 s |
| Pass 1 (Mistral Small) | < 3 s | 1-3 s |
| Pass 2 (parallel × 6 Mistral Large) | < 12 s | 5-12 s |
| Pass 3 (kein LLM) | < 1 s | < 200 ms |
| **Time-to-First-Chip** | **< 3 s** | abhängig davon, welcher Pass-2-Worker zuerst fertig wird |
| **Time-to-Vollständig** | **< 17 s** | meist 10-15 s |

## Was NICHT implementiert ist

- **Keine SSE-Emission ans Backend** — Patches gehen auf stdout. Integration mit
  `cb-ctax-backend` (`opusOrchestrator`, `eventEmitter.ts`, `applyTool`) folgt.
- **Kein Git-Commit pro Patch** — case_state-Repo wird nicht angelegt.
- **Keine Token-Streaming** — Pass 2 wartet auf vollständige Mistral-Antwort
  pro sub_anlage, bevor Felder gepatched werden. Mistral-Tool-Calling streamed
  Tool-Args als Block — echte progressive Felder-Streaming bräuchte
  custom-Parser.
- **Kein /smart-schema/validate-feld-Aufruf** — Smart-Schema-Service bietet
  diesen Endpoint noch nicht an. Pass 3 macht stattdessen lokale Format-Checks
  (`E\d{6,8}`, IdNr-Pattern).
- **Kein Schema-Caching** — Pass 2 holt pro sub_anlage frisch das Schema.
  Ein In-Memory-Cache + Redis-Cache wäre für Production sinnvoll.
- **Steuerjahr 2023 → 2024 Schema** — Smart-Schema-Service hat aktuell nur
  2024-XSD-Daten (`/health` zeigt `steuerjahre: [2024]`). Demo nutzt 2024-Schema
  für die Stricker-2023-Erklärung. Schemas sind für die hier extrahierten
  Felder ausreichend ähnlich.
- **Keine Adress-/Anschrift-Strukturierung** — Pass 1/2 extrahieren rohe Werte,
  aber Pass 3 baut keine `personen[].anschrift{}` aus mehreren Adress-Feldern.
- **Keine VAST-Verarbeitung** — VAST hat `sub_dokumente[]` (LStB, KapErtrag,
  Religionsabruf) statt `sub_anlagen[]`. Pipeline behandelt aktuell nur
  Container mit Anlagen.

## Offene Fragen

1. **Pass-2-Schema pro Person.** Bei Anlage N muss eigentlich pro Person je
   ein Mistral-Call laufen, weil Person A und Person B verschiedene
   ELSTER-Code-Suffixe haben (E0200204 vs E0200205). Aktuell nutzen wir
   `person_idnrs=[..]` im Smart-Schema-Request, aber das Service-Antwort-Schema
   liefert nur einen flachen Properties-Dict — Personen-Disambiguation muss
   im Description-Text passieren oder das Schema muss `_a` / `_b`-Suffixe haben.

2. **Token-Streaming.** Mistral chat.complete liefert ein vollständiges
   Tool-Call-Argument. Für echte Progressive Disclosure müsste man entweder
   den Stream parsen (JSON-Stream-Parser) oder pro Anlage in mehrere kleinere
   Calls splitten (z.B. „nur Felder mit `E0200*`").

3. **Reducer-Idempotenz.** Patch-Stream ist aktuell append-only. Wenn die
   Pipeline neu läuft, würde sie alle Felder doppelt schreiben. Backend-Reducer
   braucht IDs (`audit_id` ist da, aber dedup-Logik im Reducer fehlt noch).

4. **VAST-Verarbeitung.** Stricker hat *zwei* Dokumente: ESt-Erklärung +
   VAST-PDF. Zweites PDF müsste mit `sub_dokumente[]` statt `sub_anlagen[]`
   arbeiten. Pass 1 unterscheidet das aktuell nicht.
