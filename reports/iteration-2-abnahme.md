# Iteration 2 — Abnahme

Ziel: "Self-Service ohne Backstage-Tricks — ein Außenstehender kann den Lifecycle ohne SSH oder Logs durchgehen."

## Ergebnis: ✅ alle 6 Tickets done

| # | Ticket | Mangel | Beleg |
|---|---|---|---|
| I2.1 | Fall löschen / archivieren | C1 | `DELETE /api/applications/.../instances/:caseId` mit Status-aware Verhalten (löschen bei `in_bearbeitung`, archivieren bei versiegelt/eingereicht). UI-Button im Case-Row. |
| I2.2 | Run-Historie mit Timestamps + Detail-Modal | C4/C5 | `GET /api/applications/.../runs/:runId/summary` (token-frei, whitelist-scoped); UI lädt asynchron pro Run die Daten und zeigt Datum, Dauer, Felder, State-Badge. Modal mit Stage-Liste. |
| I2.3 | Live-Stage-Indikator | C8 | Drop-Zone zeigt "Phase 5/11 · phase4Disambig läuft…" + reale Progress-Bar während des Upload-Runs. |
| I2.4 | Filter + Suche in /anwendungen.html | C9 | Chip-Filter mit Live-Counts pro Status + Suche (name/mandant/caseId), clientseitig. |
| I2.5 | MCP-Health-Dots | C11/E5 | `GET /api/applications/:appId/mcps/health` pingt jedes MCP via tools/list (3s-Timeout); Header-Dots grün/rot/grau mit Latenz + Tooltip. |
| I2.6 | Format-Varianten-Toggle | A7-Folge | Checkbox in der Layer-Tabelle, default dedup ein; Toggle blendet alle E0200201..04 einzeln ein ohne Reload. |

## Production-Validierung

| Endpoint | Antwort (h200v) |
|---|---|
| `GET /api/applications/steuerfall-est/mcps/health` | `bmf-lane1: alive=true, latencyMs=6` · `bmf-lane5: configured=false` |
| `DELETE /api/applications/steuerfall-est/instances/<x>` | `{deleted:true, workspaceRemoved: "..."}` für in_bearbeitung, `{archived:true}` für versiegelt |
| `GET /api/applications/.../runs/:runId/summary` | startedAt, totalMs, stages[], fields counter |

## E2E (final)

[`reports/anwendungen-e2e-iteration-2-final/`](./anwendungen-e2e-iteration-2-final/) — **8/8 grün**.

Alle 8 Schritte des Lifecycle-Tests laufen weiterhin durch. Die UI-Erweiterungen sind additiv und brechen die Run-Pipeline nicht.

## Abnahme-Kriterien (vom Plan)

| Kriterium | Beleg |
|---|---|
| ✅ Ein Außenstehender kann den Lifecycle ohne SSH/Logs durchgehen | Alle 6 Punkte direkt im UI sichtbar/bedienbar |
| ✅ Live-Stage-Anzeige | Phase X/Y + aktiver Stage-Name + Progress-Bar |
| ✅ Run-Detail-Sicht ohne Pipeline-Runner | Modal in /steuerfall.html |
| ✅ MCP-Status sofort sichtbar | Grüner/roter Dot im Header, Lane-1 = 6ms, Lane-5 = unconfigured |
| ✅ Filter + Suche skalieren bei vielen Fällen | Client-seitig, kein API-Roundtrip |
| ✅ Dedup-Toggle für Audit-Zwecke | Sichtbar in der Layer-Tabelle, Cache-frei |

## Commits in Iteration 2

| Commit | Was |
|---|---|
| `c3f151c` | Iteration-2-Bundle (alle 6 Tickets) |

## Was bleibt für Iteration 3

| Ticket | Mangel | Effort |
|---|---|---|
| I3.1 | 4-LLM-Ensemble wiring in `elster-v5_2-rag` (B5) | L |
| I3.2 | Recall-Delta-Eval gegen v5_2 (B1 + F2) | M |
| I3.3 | Lane-5 ELSTER-MCP Service stubben (B6) | L |
| I3.4 | Echter Base-Anchor (B7, optional) | L |
| I3.5 | Archive-Branch-Entscheidung 2026-06-13 (B8) | S |
| I3.6 | gitchain Postgres aktivieren oder dekommissionieren (B9) | M |
| I3.7 | Migration auf `tax_case` Container (B10) | L |

## Nicht-triviale Implementierungs-Details

1. **Filter neu zeichnet nur die Sections-Body, nicht die Eingabe:** Beim Tippen in das Suchfeld
   wird das Feld bei jedem Tastendruck neu generiert. Wir setzen den Fokus + Selection nach jedem
   Repaint explizit zurück, sonst springt der Cursor weg.

2. **Run-Detail-Cache:** Pro Modal-Öffnung wird einmal das Summary geladen, danach cached
   bis zum Page-Reload. Spart Requests bei wiederholtem Auf/Zumachen.

3. **MCP-Health Probe ist tools/list:** Standard-MCP-JSON-RPC. Wenn der Server kein MCP ist
   aber trotzdem antwortet (z.B. ein anderer Service auf demselben Port), liefert das ein `404`
   oder Invalid-JSON-Schema, und der Health-Dot wird rot — gewollt.

4. **Delete vs Archive:** Default-Verhalten basiert auf Status. `?force=1` ist die Bypass-Tür
   für Aufräum-Aktionen, sollte aber im UI nicht standardmäßig angeboten werden.

5. **`run_meta` SSE-Event nutzt der Live-Indikator zum Stage-Count:** Der Server-Runner schickt
   bei jedem Run-Start ein `run_meta` mit `{ stages: [...] }`. Wir nutzen die Länge als
   Nenner für den Progress-Bar.
