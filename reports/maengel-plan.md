# Mängelbehebungs-Plan

Stand: 2026-05-15. Bezugsdokument: konsolidierte Mängelliste aus dieser Session.

Strategie: **drei nutzungsorientierte Iterationen** + ein Maintenance-Track.
Iteration 1 macht die Anwendung "produktionsreif für einen ersten echten Fall",
Iteration 2 polert die UX bis zum Selbstbedienungs-Niveau, Iteration 3 schließt
die Spec-Lücken und externe Integrationen. Maintenance bleibt parallel.

Effort-Skala: S = ≤ 2 h · M = ½–1 Tag · L = > 1 Tag.

---

## Iteration 1 — "ein Fall geht durch, ohne Tricks" (Must)

| ID | Mangel | Effort | Akzeptanz |
|---|---|---|---|
| I1.1 | **C10 + D4** Pre-Seal-Validierung | M | Beim Klick auf "Versiegeln" prüft die Route, ob die Pflicht-eCodes der erkannten Anlagen alle einen Wert haben. Fehlende → 409 + Liste der fehlenden eCodes. UI zeigt sie inline. |
| I1.2 | **C12** Seal/Run-Fehler in der UI sichtbar | S | Bei `stage_error` oder `run_error` in der Seal-SSE → Drop-Result rote Box mit Stage + Message. `status` bleibt `in_bearbeitung` und wird im Header so dargestellt. |
| I1.3 | **C2** Download sealed master.json + eric_xml | S | Im versiegelten Status erscheint im Header neben "An ELSTER" ein Download-Menu (master.json, eric_xml). Endpoint: `GET /api/applications/.../instances/.../seal/{master.json,eric_xml}` (token-frei, weil der Inhalt ohnehin im Workspace liegt). |
| I1.4 | **C6** Klassifizierung-False-Positives für Meta-Dokumente | M | `elster/klassifizierung` bekommt eine "Meta-Dokument-Heuristik": OCR-Text enthält *Transferticket / Steuer-Abruf / Quittung / Bestätigung* + < 1.000 Zeichen mit Beträgen → `erkannte_anlagen=[]` + `kpi_warning='meta-doc'`. Run kürzt sich ab vor felderKatalog. |
| I1.5 | **F5** Tests für `/api/applications/...` Endpoints | M | Tests in `src/server/applications.test.ts`: CRUD, Validierung, 404/409/201. Wird ans bestehende `npm test` gehängt. |
| I1.6 | **F4** Unit-Tests für `seal/*` Stages | S | `src/stages/seal/*.test.ts` — Snapshot-Deterministik, Merkle-Reproduzierbarkeit, Sign-Verify-Roundtrip. |

**Abnahme Iteration 1:** Die E2E-Suite ([`scripts/e2e-anwendungen.mjs`](../scripts/e2e-anwendungen.mjs)) bleibt grün; zusätzlich:
- Ein 2-Felder-Fall lässt sich *nicht* versiegeln (409 + Liste).
- Ein Transferticket-Upload produziert keinen LLM-Call mehr.
- Aus dem UI lässt sich master.json + eric_xml herunterladen.
- `npm test` deckt jetzt auch Application-API + Seal-Stages.

Geschätzt: **3–4 Tage**.

---

## Iteration 2 — "Self-Service ohne Backstage-Tricks" (Should)

| ID | Mangel | Effort | Akzeptanz |
|---|---|---|---|
| I2.1 | **C1** Fall löschen / archivieren | M | Endpoint `DELETE /api/applications/:appId/instances/:caseId` (löscht JSON + Workspace), UI-Button mit Bestätigungs-Modal. Versiegelte Fälle nur "archivieren" (Statuswechsel + readonly). |
| I2.2 | **C4 + C5** Run-Historie mit Timestamps, Stages, Dauer | M | Run-History-Block in `/steuerfall.html` zeigt: Datum, Workflow-ID, Dauer, ✓/✗, Anzahl Felder. Klick öffnet Detail-Modal mit Stage-Liste + Output-JSON (token-frei via neuen `GET /api/applications/.../runs/:runId/summary`). |
| I2.3 | **C8** Live-Stage-Indikator in der Upload-Zone | S | Während der Run läuft: aktive Stage + Fortschrittsbalken (z.B. "Phase 3 von 11 · LLM-Lückenfüller"). SSE-Events liefern es schon. |
| I2.4 | **C9** Filter in `/anwendungen.html` | S | Chip-Filter über der Liste: alle / in_bearbeitung / versiegelt / eingereicht. Mandant-Suche im Suchfeld. |
| I2.5 | **C11 + E5** MCP-Health in der UI | S | Beim Laden von `/steuerfall.html` Health-Ping an BMF-MCP + ELSTER-MCP. Status-Dots im Header: BMF ●, ELSTER ●. Hover-Tooltip: URL + Latenz. |
| I2.6 | **A7-Folgearbeit**: Dedup-Toggle | S | "Format-Varianten anzeigen" Toggle in der Result-Table, expand die zusammengefassten eCodes wieder einzeln. Nützlich beim Audit. |

**Abnahme Iteration 2:** Ein Außenstehender (nicht Owner) kann den Lifecycle ohne SSH/Logs durchgehen.

Geschätzt: **3 Tage**.

---

## Iteration 3 — "Spec einlösen" (Could / strategisch)

| ID | Mangel | Effort | Akzeptanz |
|---|---|---|---|
| I3.1 | **B5** 4-LLM-Ensemble in `elster-v5_2-rag` wiring | L | Neuer Wrapper-Stage `elster-v5_2-rag/phase3-llm-ensemble` ruft Gemma + Mistral-S + Mistral-L + Claude-Haiku parallel, votes per eCode. Workflow-Definition optional einbaubar als Override. |
| I3.2 | **B1 + F2** Recall-Delta gegen v5_2 messen | M | [`scripts/eval-v52-rag-recall.mjs`](../scripts/eval-v52-rag-recall.mjs) gegen ≥ 10 Test-Fixtures (Lohnsteuer, Spenden, Pentacam, etc.) auf h200v. Ergebnis als `reports/v52-rag-recall.md` festgehalten. Ersetzt die "99,9 %" Behauptung mit echten Zahlen. |
| I3.3 | **B6** Lane-5 ELSTER-MCP Service stubben | L | Separater Service oder MCP-Adapter: nimmt eric_xml + Mandant-Metadata, mockt zunächst eine Einreichungs-ID. Sobald die echte ELSTER-Schnittstelle anschließbar ist, ist die Stelle klar. |
| I3.4 | **B7** Echter Base-Anchor (optional) | L | Anchor-Service mit Wallet (siehe `0711-ALLES.rtf`-Wallet), sendet 32-Byte-Commit-Hash per OP_RETURN-Pattern. `recordAnchor()` ruft den Service per HTTP. |
| I3.5 | **B8** Archive-Branch-Entscheidung 2026-06-13 | S | Spätestens am 2026-06-13: `archive/h200v-divergence-20260514` (Quantum-Workflow) entweder cherrypicken oder löschen. Memory-Reminder existiert. |
| I3.6 | **B9** gitchain Postgres aktivieren *oder* dekommissionieren | M | Wenn die DB nicht binnen 30 Tagen benutzt wird → aus `docker-compose.yml` entfernen, Doku updaten. Wenn doch: env-Var-Mismatch fixen + Migration `applications-data/` → `registry.containers` mit `type=tax_case`. |
| I3.7 | **B10** Migration auf `tax_case` Container | L | Erfordert I3.6. Dann lassen sich die Vorteile der gitchain-Workspace-Tax-Case-Promotion live nutzen. |

**Abnahme Iteration 3:** Honest accuracy-Zahl im Repo. Lane-5 hat einen klaren Adapter. Anchor-Pfad ist entweder aktiv oder offiziell deferred.

Geschätzt: **2 Wochen** (vor allem I3.3 + I3.4 ziehen).

---

## Maintenance-Track (laufend, parallel)

| ID | Mangel | Effort | Periodik |
|---|---|---|---|
| M1 | **E1** Image-Tags bereinigen | S | Monatlich. Skript: alle `sturm:*` außer `latest / current / -1 / -2` löschen. |
| M2 | **E2 + E3** Docker-Build-Cache prune | S | Wöchentlich `docker builder prune -f` auf h200v. |
| M3 | **E4** CI-Pipeline minimal | M | GitHub Action: `npm run typecheck && npm test` auf jeden PR. Reicht für jetzt, kein Deploy nötig. |
| M4 | **E6** Backup `applications/` Workspaces | S | Daily `rsync` von `~/0711/0711-STURM/applications/` zu einem Sicherungsort (extern oder Bucket). |
| M5 | **F1** E2E breiter | M | E2E-Suite ergänzen pro Workflow-Family (Belege, Medizin, OCR-Shootout) — eine Test-Fixture pro Familie. |
| M6 | **F3** Validator-Coverage hochziehen | M | Restliche 20 % BMF-Hinweisregeln (Set-/Listen-/Datums-Funktionen) implementieren wenn Real-Cases es brauchen. |
| M7 | **D1** BMF-Pflicht-Flags reviewen | M | Anlage N hat 0 Pflicht-Atome — wahrscheinlich Katalog-Bug. Quelle (BMF-Jahresdokumentation) querchecken und nachpatchen. |
| M8 | **D2** Doku zu Format-Duplikaten im Katalog | S | Eintrag in `src/verticals/elster-v3/data/CONTAINER_BRIEF.md`: was die E020020X-Varianten formal bedeuten, damit Layer-1 sie nicht alle blind füllt. |

---

## Explicit Deferrals (nichts geplant, dokumentiert)

| ID | Mangel | Begründung |
|---|---|---|
| D-B2 | "Pora Quantum" | Spec-Begriff ohne Substanz. Real: TurboQuant. Keine Aktion. |
| D-B3 | "Face and Pickle graph" | Spec-Begriff ohne Substanz. Real: catalog merkle. Keine Aktion. |
| D-B4 | Per-eCode `seal-quantum-container` Merkle | Heutige sha256-Merkle über sortierte eCode-Leaves erfüllt den Audit-Zweck. Reaktivierung aus `archive/h200v-divergence-20260514` nur wenn ein Audit-Anforderer es explizit verlangt. |
| D-C7 | Bearer-Token-UI für Pipeline-Runner | Owner-Tool, Bootstrap via `?token=` reicht. Studio-Pattern ist konsistent. |

---

## Reihenfolge / Abhängigkeiten

```
I1.1 ─┐
I1.2 ─┤
I1.3 ─┼→ Abnahme I1 (echte Fälle möglich)
I1.4 ─┤
I1.5 ─┤
I1.6 ─┘
       └─→ I2.1 ─┐
            I2.2 ─┤
            I2.3 ─┼→ Abnahme I2 (Self-Service)
            I2.4 ─┤
            I2.5 ─┤
            I2.6 ─┘
                  └─→ I3.2 (Recall-Eval)
                  └─→ I3.3 (Lane-5 Adapter)
                  └─→ I3.6 (Postgres-Entscheidung)
                          └─→ I3.7 (Migration)

I3.1, I3.4, I3.5: unabhängig, parallelisierbar.
M1–M8: parallel zur jeweils laufenden Iteration.
```

---

## Erwartetes Ergebnis nach Iteration 1

Ein Steuerberater könnte gefahrlos
- einen Mandanten als Fall anlegen,
- 5 Lohnsteuerbescheinigungen hochladen,
- Pre-Seal-Errors lesen + korrigieren (Pflicht-Felder fehlen),
- versiegeln,
- master.json + eric_xml herunterladen,
- den Fall (im Office) auf einer anderen Maschine weiterverarbeiten.

Lane-5 ELSTER-Einreichung bleibt vorerst manuell — der signierte eric_xml-
Download ist die saubere Schnittstelle dazu.

---

## Reaktion auf Spec-Aussagen

Der ursprüngliche Spec-Text ("99,9 % certainty", "Face and Pickle graph",
"Pora Quantum", on-chain anchor) wird *nicht* eingeholt — Spec-Behauptungen
werden in der Doku durch reale Zahlen + reale Bezeichner ersetzt. Das ist Teil
der Iteration 3 / Maintenance-Doku, kein Bug.

Wenn Stakeholder darauf bestehen, muss das als separate Roadmap-Diskussion
geführt werden, nicht als "Fehlerbehebung".
