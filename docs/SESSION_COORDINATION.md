# Session-Koordination

**Status**: 2 parallele Claude-Code-Sessions in diesem Repo. Diese Datei dokumentiert wer woran arbeitet, damit es keine Doppel-Edits gibt.

## Aktive Sessions (Stand 2026-05-18 09:00)

### Session A — v6-Vision Quality (auf `main`)
**Fokus**: elster-v6-vision Qualität auf Stricker und Hildburg von 30 saubere Felder Richtung 64+ heben. Per-anlage-grouped vision calls, page-Zeile-strict-filter.

**Aktive Dateien** (NICHT ohne Absprache anfassen):
- `src/lib/page-anlage-detect.ts` + `.test.ts`
- `src/verticals/elster-v3/stages/phase3-vision-fill.ts` (oder Varianten davon)
- `src/lib/ocr-mistral-small.ts` + Tests/Fixtures
- `src/server.ts` Aggregate-Handler (lines ~860-925) — laufend Debug-Marker
- alles unter `src/verticals/elster-v3/`

**Branch**: `main` direkt (Push-fest)

**Container**: `sturm` auf H200V Port 7800. Build aus `~/0711-STURM-canonical` checkout von main.

### Session B — Mandanten-Workspace (auf `feat/mandanten-workspace`)
**Fokus**: Stripped-down Multi-User-Surface unter `/m/*` für bis zu 10 Steuerberatungs-Mandanten. P0 done, P1-P3 in Subagent-Worktrees.

**Aktive Dateien**:
- `docs/MANDANTEN_WORKSPACE.md` (API-Contract)
- `src/server.ts` Routing-Block (lines ~1721-1789) — Admin-Gate + /m/* HTML-Routen
- `src/ui/m-login.html`, `m-dashboard.html`, `m-case.html` (P0 stubs, werden von P2/P3 ersetzt)
- Geplant von Subagents: `src/lib/m-users.ts`, `src/server/m-auth.ts`, `src/server/m-cases.ts`, `scripts/mandant-add.ts`

**Branch**: `feat/mandanten-workspace`

**Container**: `sturm-mandanten` auf H200V Port **7801** (NICHT 7800 — Session A nutzt 7800). Build aus `~/0711-STURM-mandanten` worktree von feat/mandanten-workspace.

## Konflikt-Vermeidung

- Session B berührt `src/server.ts` nur im Routing-Block (lines ~1721-1789). Session A berührt darin den Aggregate-Handler (lines ~860-925). Saubere Trennung.
- Session B berührt nichts unter `src/verticals/elster-v3/` oder `src/lib/page-anlage-detect*`.
- Wenn Session A Änderungen an `src/server.ts` braucht, die in den Routing-Block reinreichen: bitte hier vermerken.

## Wenn jemand main verändert während feat/mandanten-workspace lebt

Session B rebased regelmässig auf main, um den Branch frisch zu halten. Konflikte werden im Branch gelöst, nicht in main.

## Notiz an Session A

Falls Dateien plötzlich „leer" oder „reverted" aussehen: prüf ob ein anderer Editor / eine andere Session sie modifiziert hat, bevor du committest. Ich (Session B) habe heute morgen versehentlich `page-anlage-detect.ts/.test.ts` gestashed, weil ich sie für fremdes WIP hielt. Du hast es korrekt mit Commit `a4a293f` wieder eingefangen — Danke. Stash wurde dropped, deine Version ist authoritative.
