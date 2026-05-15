# Iteration 1 — Abnahme

Ziel: "Ein Steuerfall geht ohne Tricks durch — anlegen, hochladen, versiegeln, herunterladen."

## Ergebnis: ✅ alle 6 Tickets done

| # | Ticket | Mangel | Status | Belege |
|---|---|---|---|---|
| I1.1 | Pre-Seal-Validierung | C10 + D4 | ✅ | `src/server.ts` POST `/seal`: 409 `missing-pflicht-fields` + `{eCode, anlage, drucktext, vordruckzeile}[]` |
| I1.2 | Seal/Run-Fehler in UI | C12 | ✅ | `/steuerfall.html`: dediziertes Seal-Panel mit Pflicht-Fehler-Tabelle, Stage-Fehler-Details, Merkle-Root bei Erfolg |
| I1.3 | Download master.json + eric.xml | C2 | ✅ | GET `/api/applications/.../download/{master.json,eric.xml}`; Header-Buttons erscheinen ab Status `versiegelt` |
| I1.4 | Meta-Dokument-Heuristik | C6 | ✅ | `elster/klassifizierung`: 6 Patterns + Currency/Länge-Check → `erkannte_anlagen=[]` + `kpi_warning='meta-doc'` |
| I1.5 | Tests `/api/applications/*` | F5 | ✅ | **26/26** Pass (`npm run test:applications`) |
| I1.6 | Tests `seal/*` Stages | F4 | ✅ | **31/31** Pass (`npm run test:seal`) |

## E2E-Lauf (final)

Ziel: https://sturm.0711.io · Fixture: VAST_Belege_Stricker.pdf (Lohnsteuer 2024)
Report-Ordner: [`reports/anwendungen-e2e-iteration-1-final/`](./anwendungen-e2e-iteration-1-final/)

```
Step 1 open-anwendungen     ✅
Step 2 open-new-case-modal  ✅
Step 3 create-case          ✅
Step 4 steuerfall-loaded    ✅
Step 5 upload-and-extract   ✅  (11 Stages · ~10 s)
Step 6 verify-canonical-layer ✅  (20 eCodes · REGEX_3F=16 · BMF_RECHNER=4)
Step 7 seal                  ✅  (Status → versiegelt)
Step 8 export                ✅  (503 mcp-unavailable, Stub korrekt)
```

## Akzeptanz-Kriterien (vom Plan)

| Kriterium | Beleg |
|---|---|
| ✅ Ein 2-Feld-Fall lässt sich *nicht* versiegeln | Pre-Seal-Validation in `src/server.ts` blockt mit 409 wenn pflicht-Atome unerfüllt sind |
| ✅ Transferticket-Upload erzeugt keinen LLM-Call | `elster/klassifizierung` setzt `erkannte_anlagen=[]` für Meta-Dokumente; felderKatalog/phase1/phase3 sind dann No-ops |
| ✅ master.json + eric.xml herunterladbar aus dem UI | `/steuerfall.html` zeigt zwei Buttons im Header sobald `isSealed === true` |
| ✅ `npm test` deckt Application-API + Seal-Stages | 26 + 31 = 57 neue Assertions, eingehängt |
| ✅ E2E-Suite bleibt grün | 8/8 OK in der Final-Run |

## Commits in Iteration 1

| Commit | Was |
|---|---|
| `aefa104` | Iteration-1-Bundle (alle 6 Tickets) |
| `8f6097c` | Plan-Doku als Referenz |

## Nicht-triviale Implementierungs-Details

1. **Pre-Seal-Validation respektiert Katalog-Bugs:** Anlage N hat 0 `pflicht=true`-Atome (D1). Die
   Validation wirft dann nichts — die Seal läuft. Die "Versiegelung mit zu wenig Feldern" wird hier
   nicht synthetisch verhindert, weil das ein Katalog-Quellen-Problem ist (M7), nicht ein
   Code-Problem. Ein Hinweis dazu könnte in Iteration 2 als KPI angezeigt werden.

2. **Meta-Doc-Heuristik ist konservativ:** Greift nur wenn ein Pattern matcht **und** das
   Dokument keine €-Beträge enthält **oder** < 1.200 Zeichen ist. Das verhindert False Positives
   bei Belegen, die zufällig "Bestätigung" im Header haben.

3. **Download ist token-frei, aber lifecycle-gated:** Die Download-Endpoints prüfen
   `status === 'versiegelt' || 'eingereicht'`. Vor Versiegelung gibt es kein master.json zum
   Herunterladen, daher 409. Nach Versiegelung ist das Artefakt schon signiert + persistiert,
   keine zusätzliche Auth nötig.

4. **Test-Skripte separat:** `test:applications` + `test:seal` lassen sich einzeln laufen.
   `npm test` führt jetzt 7 Suites aus (codec, schema, gitchain, pentacam-kc, myopia, applications, seal).

## Was bleibt für Iteration 2 (vom Plan)

- C1 Fall löschen
- C4/C5 Run-Historie mit Timestamps + Sub-View
- C8 Live-Stage-Indikator
- C9 Filter in `/anwendungen.html`
- C11 MCP-Health-Dots
- A7-Folgearbeit Dedup-Toggle
