# Iteration 4 — Abnahme

Ziel: "Alle Belege auf einmal hochladen, komplette Steuerberechnung kommt raus, Workflow stückweise untersuchen."

## Ergebnis: ✅ alle 11 Tickets done

| # | Ticket | Beleg |
|---|---|---|
| I4.1 | Bulk-Upload-Endpoint | `POST /upload-bulk` mit multer.array, Concurrency 3, multiplexed SSE (bulk_start → doc_start → doc_done × N → bulk_done) |
| I4.2 | Workspace-Inbox-Manifest | `applications/<appId>/<caseId>/inbox/_manifest.json` mit sha256/runId/anlagen; auto-Dedup bei gleichem sha256 |
| I4.3 | aggregateCase() | `src/server/aggregation.ts`: Merge nach eCode mit Trust-Stufen-Regel (REGEX_100% > BMF_RECHNER > REGEX_3F > LLM_FSM), Conflict-Detection mit Kandidaten-Liste |
| I4.4 | BMF Re-Compute über merged_layer | /aggregate ruft BmfMcpClient mit merged_layer, *eine* Steuerberechnung aus N Belegen |
| I4.5 | GET /aggregate | Token-frei; liefert documents[], merged_layer, conflicts, pflicht_coverage, BMF-Result |
| I4.6 | Pflicht-Coverage + Doc-Type-Hints | Coverage per Anlage; Hints (exact + prefix-match) für die Missing-Liste |
| I4.7 | Multi-File Drop-Zone | `<input multiple>`, ≥2 Dateien → Bulk-Pfad mit Queue-Anzeige |
| I4.8 | Gesamt-Ergebnis-Panel | BMF-Tiles (zvE/ESt/Soli/festzusetzend), Coverage-Bar, Refresh-Button |
| I4.9 | Per-Doc-Drill-Down | Doc-Name als Quelle in der Bulk-Queue + im merged_layer pro eCode `confirmed_by[]` |
| I4.10 | Konflikt-Anzeige | Klappbare Liste, alle Kandidaten mit Quelle + Origin, Trust-Sieger markiert |
| I4.11 | Pflicht-Fehlend-Liste | Klappbare Liste mit Belegtyp-Suggestion ("vermutlich in: Beitragsbescheinigung Krankenversicherung") |

## Production-Smoke

```
2 distinkte PDFs → Bulk-Upload → ~15 s parallel → BMF berechnet
- 34 eCodes im merged_layer
- 15 Konflikte (Erklärung-Datei vs. VAST-Belege haben unterschiedliche Werte)
- BMF: zvE = 62 293,90 €, Gesamtsteuer = 15 772,46 €
- Anlagen erkannt: AV · ESt1A · KAP · KAP_I · N · SA · VOR
- Pflicht-Coverage: 2/5 (40%) — measurable=true
- Manifest mit beiden sha256-distinct Einträgen
```

## Bugs gefunden + behoben in dieser Iteration

| Bug | Symptom | Fix |
|---|---|---|
| **Manifest-Race** | Concurrent Bulk-Uploads schrieben sich gegenseitig kaputt; Manifest enthielt nur N-1 Einträge | Per-(appId\|caseId)-Mutex in `inbox.ts` via Promise-Chain (`withCaseLock`) |
| **Instance-Documents-Duplikate** | Bei identischen Dateien zeigte das Manifest 1 (dedup), aber `instance.documents` hatte beide → inkonsistent | Nach Bulk-Run instance.documents *aus dem Manifest* spiegeln statt anzuhängen |

## Architektur (zusammengefasst)

```
applications/<appId>/<caseId>/
├── inbox/                          ← canonical Speicherort, audit-fest
│   ├── 2026-05-15T09-44-25_lohnsteuer.pdf
│   ├── 2026-05-15T09-44-25_spende.pdf
│   └── _manifest.json              ← sha256, runId, anlagen, fieldsExtracted
├── seal/master.json                ← signiert + merkle-rooted
└── anchors/…

runs/elster-v5_2-rag/<runId>/       ← Workflow-Artefakte (canonical_layer)
applications-data/<appId>/<id>.json ← Instance (status, runs[], documents[])
```

**Flow:**
1. Drop N Dateien → `POST /upload-bulk` parallel-extracted (Concurrency 3)
2. Pro Datei: persistUploadToInbox (sha256-dedup) → runWorkflow(elster-v5_2-rag)
3. Bei doc_done: anlagen + fieldsExtracted ins Manifest fortschreiben
4. Bei bulk_done: instance.documents aus Manifest spiegeln
5. UI ruft `/aggregate` → aggregateCase() lädt phase6BmfRechner pro Run → merge nach eCode → BMF re-compute über merged → Response
6. UI rendert: BMF-Tiles + Coverage + Conflicts + Missing + Layer-Tabelle

## Akzeptanz-Kriterien

| Kriterium | Status |
|---|---|
| ✅ Mehrere Dateien gleichzeitig hochladen (≤20) | drop+input multiple, /upload-bulk |
| ✅ Komplette Steuerberechnung aus N Belegen | BMF-Tiles im Gesamt-Panel |
| ✅ Stückweise pro Beleg untersuchen | Bulk-Queue zeigt pro-Doc-Anlagen + Felder; Run-Detail-Modal aus Iteration 2 weiterhin verfügbar |
| ✅ Belege werden persistent im Workspace gespeichert | `_manifest.json` + sha256-Dedup |
| ✅ Konflikte sichtbar | rote Klapp-Liste mit Trust-Sieger |
| ✅ Pflicht-Coverage angezeigt | Progress-Bar + Missing-Liste mit Doc-Type-Hints |

## Tests + Commits

- `npm run test:aggregation`: **28/28** Assertions (mock-FS Runs, Dedup, Konflikt, Coverage, 0-Pflicht-Sonderfall)
- `npm test`: alle 9 Suites grün
- E2E `e2e-anwendungen.mjs`: 8/8 grün (Single-Upload-Pfad unverändert)

Commits:
- `deec825` Iteration-4-Bundle (Backend + UI)
- `3841e13` Race-Fix Mutex
- `437116c` Manifest-Spiegelung in instance.documents

## Out-of-scope für I4 (Folge-Ideen)

- Manueller Field-Override per UI (User tippt einen Wert ein, audit-trail "manual entry by …")
- Document-Replace ohne neuen Fall (alte Datei → `_replaced/`)
- PDF-Vorschau im Drill-Down (Inbox-File-Ausgabe-Endpoint)
- BMF-Cache: aktuell wird bei jedem `/aggregate` re-computet — sollte gehasht + gecached werden bei großen Fällen.
