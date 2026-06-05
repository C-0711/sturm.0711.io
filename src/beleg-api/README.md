# Beleg-API (ELSTER-Steuerbelege)

Eigenständiger **Hintergrund-Daemon**: Steuerbelege rein, perfekte **JSON + Markdown**
raus — pro Fall ein Ordner, ein `Beleg-Result` pro Datei, und ein aggregierter
**Master-Case** je Fall. Entkoppelt von der STURM-Engine (eigener Prozess, eigener
Port, eigene Ordner); liest nur die ELSTER-Kennzahlen-SSoT als Datei.

```
  posteingang/<Fall>/datei  ─┐
                             ├─▶ Wächter ─▶ Kurator (Opus 4.8) + Katalog-Resolver
  POST /beleg  (X-Fall)     ─┘            └─▶ ausgang/<Fall>/<id>.json   (Beleg-Result)
                                          └─▶ ausgang/<Fall>/<id>.md     (Transkription)
                                          └─▶ ausgang/<Fall>/mastercase_<Fall>.json
```

Die Firma **lauscht auf `ausgang/`** und sammelt JSON + Markdown + den Master-Case.

## Pipeline pro Beleg

1. **Kurator (Opus 4.8)** liest die Datei (PDF/Bild/Text nativ) → Markdown-Transkription
   + strukturierte Lesung `dokumente[] → positionen[]` (bezeichnung · anlage · zeile ·
   kennzahl · wert · person). Liest nur, was im Beleg steht — erfindet keine e_codes.
2. **Katalog-Resolver** löst jede Position gegen die ELSTER-SSoT
   (`elster_kennzahlen.json`) auf:
   - `(anlage, zeile)` oder `(anlage, kennzahl)` → `e_code` + `kennzahl` + Katalog-Bezeichnung (`aufgeloest: "zeile"`)
   - sonst Fuzzy-Match auf der Bezeichnung → `e_code` + `resolver_score` (`aufgeloest: "label"`)
3. **Datentyp-Coercion** bringt `wert` in die typgerechte Form
   (`decimal_eur_cent` → Zahl, `date` → ISO, `idnr`/`bool_jax`/`enum`/`string`).
4. **Beleg-Result** wird gebaut (inkl. flachem `positionen`-Spiegel + KPI).
5. **Master-Case** des Falls wird neu geschrieben (bei `BELEG_MASTERCASE_AUTO=1`).

**Duplikate / Cache:** Kommt derselbe Inhalt erneut (gleicher `sha256` — z. B.
dieselbe Datei in einem anderen Fall), wird Schritt 1 (der teure Opus-Call) aus
dem Cache bedient (`cache/kurator-v1/<sha>.json`) — die Schritte 2–5 laufen
trotzdem, sodass eine **volle Kopie** (JSON + MD) mit korrektem Fall/Dateinamen im
neuen Ordner landet. Cache-Treffer sind im Log mit `↺ cache` markiert und tragen
`verarbeitung.ausCache: true`. Abschaltbar via `BELEG_CACHE=0`; Cache-Invalidierung
durch Hochzählen der `VERSION` in `cache.ts` (bei Prompt-Änderungen).

## Start

```bash
export ANTHROPIC_API_KEY=sk-ant-…        # einziger Pflicht-Key
npm run beleg-api                        # einmalig
npm run beleg-api:dev                    # mit Auto-Reload
pm2 start ecosystem.config.cjs --only beleg-api
```

Beim Start: alle Ordner unter `beleg-api-data/` (gitignored) + ELSTER-SSoT geladen
(Anzahl im Banner).

## Benutzung

### A) Ordner-Drop (Auftrag = Unterordner)

```bash
mkdir -p "beleg-api-data/posteingang/Fall 1"
cp Lohnsteuer_2024.pdf "beleg-api-data/posteingang/Fall 1/"
# → ausgang/Fall_1/Lohnsteuer_2024__<sha8>.json + .md   (+ mastercase_Fall_1.json)
```
Dateien direkt in `posteingang/` (ohne Unterordner) → `BELEG_DEFAULT_FALL` ("Fall 1").

### B) HTTP-Intake

```bash
curl -F datei=@Beleg.pdf -H 'X-Fall: Fall 1' http://localhost:7810/beleg
curl --data-binary @Beleg.pdf -H 'X-Dateiname: Beleg.pdf' -H 'X-Fall: Fall 2' \
     http://localhost:7810/beleg/raw

curl http://localhost:7810/beleg/<id>          # Status + Beleg-Result
curl http://localhost:7810/beleg/<id>/json     # nur JSON
curl http://localhost:7810/beleg/<id>/md       # nur Markdown
curl "http://localhost:7810/mastercase?fall=Fall%201"   # baut+schreibt+liefert Master-Case
curl http://localhost:7810/faelle              # Übersicht aller Fälle
curl http://localhost:7810/health
```

## Beleg-Result (`ausgang/<Fall>/<id>.json`, `schema: "beleg-result/v1"`)

```jsonc
{
  "dateiname": "Lohnsteuer-2024.txt", "status": "ok", "modus": "scan-pdf",
  "fall": "Fall 1", "id": "…__<sha8>", "sha256": "…",
  "dokumente": [{
    "dokument_typ": "Lohnsteuerbescheinigung", "aussteller": "Beispiel GmbH",
    "person": "Max Mustermann", "kalenderjahr": 2024, "finanzamt": null,
    "positionen": [{
      "bezeichnung": "Bruttoarbeitslohn", "anlage": "Anlage N", "zeile": "Zeile 1",
      "wert": 6565.26, "e_code": "E0200201", "kennzahl": ["110"],
      "datentyp": "decimal_eur_cent", "elster_kennziffer": "Anlage N Zeile 1 · Kz 110",
      "aufgeloest": "label", "resolver_score": 1, "unsicher": false
    }]
  }],
  "positionen": [ /* flacher Spiegel ALLER Positionen + Herkunft (dokument_typ/aussteller/quelle) */ ],
  "kpi": { "anzahl_werte": 3, "mit_kennziffer": 2, "unsicher": 1, "tokens_pro_sek": 103, "total_ms": 6209, "warnung": true },
  "markdownDatei": "…__<sha8>.md",
  "verarbeitung": { "engine": "Kurator", "ms": 6209, "erstellt": "…" }
}
```

## Master-Case (`ausgang/<Fall>/mastercase_<Fall>.json`)

```jsonc
{
  "fall": "Fall 1", "erzeugt": "…",
  "jahre": {
    "2024": {
      "veranlagung": "einzel",
      "personen": [{ "rolle": "A", "person_key": "max mustermann", "idnr": "…", "name": "…",
                     "anlagen": ["Anlage KAP","Anlage N"], "belege": ["Lohnsteuerbescheinigung","Steuerbescheinigung"],
                     "elsterWerte": { "E0200201": 6565.26, "E0200301": 980, "E1904701": 375 } }],
      "engineInput": { "steuerjahr": 2024, "elsterWerte": { "E0200201": 6565.26, … } }   // __B = Person B
    }
  },
  "vergleich": [                  // erstes vs letztes Jahr je e_code, sortiert nach |Δ|
    { "e_code": "E0200201", "label": "Bruttoarbeitslohn", "anlage": "Anlage N", "zeile": "Zeile 1",
      "2023": 71047.0, "2024": 6565.26, "delta": -64481.74, "status": "geändert" }
  ],
  "fehlende_belege": [ { "beleg": "Steuerbescheinigung", "fehlt_in": "2023", "vorhanden_in": "2024" } ],
  "_datei": "/…/ausgang/Fall_1/mastercase_Fall_1.json"
}
```

`engineInput` ist der abgeleitete Stufe-4-Input für `POST :12015/api/rechnen`
(pro Person/Jahr; Person B mit `__B`-Suffix bei Zusammenveranlagung).

## Ordner

| Ordner            | Inhalt                                                          |
|-------------------|-----------------------------------------------------------------|
| `posteingang/<Fall>/` | Drop-Zone je Fall (oder direkt = Default-Fall)              |
| `verarbeitung/`   | in Bearbeitung (atomar geclaimt, `.fall`-Sidecar)              |
| `ausgang/<Fall>/` | **`<id>.json` + `<id>.md` + `mastercase_<Fall>.json`** ← lauschen |
| `fehler/<Fall>/`  | Original + `<id>.fehler.json` mit Diagnose                      |
| `archiv/`         | erfolgreiche Originale (`BELEG_ARCHIVIEREN=0` → löschen)        |

## ELSTER-SSoT

`e_code`/`kennzahl`/Bezeichnung kommen aus `src/verticals/elster/data/postgres-dumps/elster_kennzahlen.json`
(`BELEG_KENNZAHLEN_PATH`). Das ist die EINZIGE Wahrheit für e_codes. Fehlt die
Datei, läuft der Daemon weiter (e_codes bleiben `null`, `unsicher: true`).

## Konfiguration (`BELEG_*`, siehe `.env.example`)

Pflicht: `ANTHROPIC_API_KEY`. Wichtige Optionen: `BELEG_PORT` (7810),
`BELEG_DEFAULT_FALL` ("Fall 1"), `BELEG_MASTERCASE_AUTO` (1), `BELEG_PARALLEL` (3),
`BELEG_KENNZAHLEN_PATH`, `BELEG_TOKEN` (Bearer-Schutz).

## Grenzen (v1)

- **Label-Resolver** nutzt String-Ähnlichkeit (Jaccard), kein Embedding-Modell —
  `resolver_score` ist daher ein Token-Overlap, kein Vektor-Score. Upgrade-Pfad:
  Embedding-Index aus `src/verticals/elster/data/` einhängen.
- **datentyp** wird heuristisch bestimmt (Bezeichnung + Wertformat), nicht aus
  einem Atom-Katalog.
- **Aggregation** im Master-Case: numerische Mehrfach-Beiträge desselben e_codes
  werden summiert; Auditor-Marker (`korrigiert`/`konflikt`/`zeile_modell`) werden
  nicht automatisch gesetzt (kommen aus einem menschlichen Review-Schritt).
- Ein Opus-Call pro Beleg (sehr große PDFs können das Markdown-Token-Budget sprengen).
- Kein Postgres/Redis — das Dateisystem ist der Store.
