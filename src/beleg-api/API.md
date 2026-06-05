# Beleg-API — API-Referenz

ELSTER-Steuerbeleg-Daemon. Belege rein (Ordner-Drop **oder** HTTP), pro Datei ein
`Beleg-Result` (JSON + Markdown) im Fall-Ordner, pro Fall ein aggregierter
`Master-Case`. Eigenständiger Prozess, Default-Port **7810**.

- **Engine:** „Kurator" = Opus 4.8 (liest die Datei: Transkription + strukturierte Lesung)
- **Auflösung:** ELSTER-Katalog-Resolver gegen die Kennzahlen-SSoT (`elster_kennzahlen.json`)
- **Persistenz:** Dateisystem (kein DB/Redis). Basis: `beleg-api-data/` (gitignored)
- **Content-Type aller JSON-Antworten:** `application/json; charset=utf-8`

> **Zwei gleichwertige Wege rein:** (1) Datei in `posteingang/<Fall>/` ablegen, oder
> (2) `POST /beleg`. Beide münden in denselben Verarbeitungspfad. Der **Ausgang-Ordner
> ist der eigentliche Vertrag** — wer nur Dateien einsammeln will, lauscht auf `ausgang/`
> und braucht das HTTP-API nicht.

---

## 0. IN / OUT (Überblick)

**System als Black-Box**

| | |
|---|---|
| **IN** | Eine Datei — PDF · PNG/JPG/WebP/GIF · Text. Optional: Fall + eigene ID. Zwei Wege: Drop in `posteingang/<Fall>/` **oder** `POST /beleg`. |
| **OUT** | `ausgang/<Fall>/<id>.json` (Beleg-Result) · `ausgang/<Fall>/<id>.md` (Transkription) · `ausgang/<Fall>/mastercase_<Fall>.json` (Aggregat). |

**Pro Endpunkt: IN → OUT**

| Endpunkt | IN | OUT |
|---|---|---|
| `POST /beleg` | multipart File + Header `X-Fall`/`X-Beleg-Id` (opt.) | **202** `{id, fall, ausgang:{json,md}, abfrage}` |
| `POST /beleg/raw` | roher Body + `X-Dateiname`/`X-Fall` | **202** `{id, …}` |
| `GET /beleg/:id` | `id` | **200** `{status:"fertig", result}` · **422** `{fehler,diagnose}` · **404** `{unbekannt}` |
| `GET /beleg/:id/json` | `id` | Beleg-Result-JSON (oder **404**) |
| `GET /beleg/:id/md` | `id` | Markdown (oder **404**) |
| `GET /mastercase?fall=` | `fall` | Master-Case-JSON (oder **404** `keine_belege`) |
| `GET /faelle` | — | `{faelle:[{ordner,belege,mastercase}]}` |
| `GET /health` | — | `{status, wartet, fertig, fehler}` |

**Daten-IN → Daten-OUT (eine Position)**

```
IN  (Beleg-Zeile)            OUT (Position)
─────────────────            ─────────────────────────────────────────────
"Bruttoarbeitslohn       →   { "bezeichnung":"Bruttoarbeitslohn",
 6.565,26 EUR"                 "wert":6565.26, "datentyp":"decimal_eur_cent",
                               "e_code":"E0200201", "kennzahl":["110"],
                               "anlage":"Anlage N", "zeile":"Zeile 1",
                               "aufgeloest":"label", "unsicher":false }
```

**Finaler OUT an die Rechen-Engine (`POST :12015/api/rechnen`)** — der `engineInput`
des Master-Case ist 1:1 der Engine-Input:

```json
{ "steuerjahr": 2024,
  "elsterWerte": { "E0200201": 6565.26, "E0200301": 980, "E0500406__B": "…" } }
```
`__B` = Person B (Zusammenveranlagung).

> **Kurz:** Datei rein → `Beleg-Result` (pro Datei) + `Master-Case` (pro Fall) raus →
> dessen `engineInput` geht direkt in die Rechen-Engine.

---

## 1. Authentifizierung

Optional. Ist `BELEG_TOKEN` gesetzt, verlangen **alle** Routen außer `GET /health`:

```
Authorization: Bearer <BELEG_TOKEN>
```

Fehlt/falsch → `401 {"fehler":"unauthorisiert"}`. Ist `BELEG_TOKEN` leer (Default),
ist das API offen (Playground-Modus).

**Rate-Limit:** 120 Anfragen / 60 s / IP (Header `RateLimit-*`); darüber `429`.
**Security-Header:** via `helmet`. **Max. Upload-Größe:** `BELEG_MAX_MB` (Default 32 MB)
→ Überschreitung `413`.

---

## 2. Endpunkte (Übersicht)

| Methode | Pfad | Zweck |
|---|---|---|
| `GET`  | `/health` | Liveness + Zähler |
| `POST` | `/beleg` | Datei einreichen (multipart) |
| `POST` | `/beleg/raw` | Datei einreichen (roher Body) |
| `GET`  | `/beleg/:id` | Status + Beleg-Result |
| `GET`  | `/beleg/:id/json` | nur das Beleg-Result-JSON |
| `GET`  | `/beleg/:id/md` | nur die Markdown-Transkription |
| `GET`  | `/mastercase?fall=…` | Master-Case bauen + schreiben + liefern |
| `GET`  | `/faelle` | Übersicht aller Fälle |

---

## 3. Endpunkte (Detail)

### `GET /health`
Immer offen (kein Token). Zähler sind rekursiv über Fall-Unterordner.

**200**
```json
{
  "status": "ok",
  "dienst": "beleg-api",
  "engine": "Kurator",
  "wartet": 2,     // Dateien in posteingang/ (inkl. Unterordner)
  "fertig": 17,    // *.json in ausgang/ (ohne mastercase_*)
  "fehler": 1      // *.fehler.json in fehler/
}
```

---

### `POST /beleg`
Datei als `multipart/form-data`. Es wird die **erste** hochgeladene Datei genommen
(beliebiger Feldname; `upload.any()`).

**Eingabe**

| Quelle | Name | Pflicht | Bedeutung |
|---|---|---|---|
| Form-File | beliebig | ja | die Belegdatei |
| Header | `X-Fall` | nein | Fall-Zuordnung (sonst `BELEG_DEFAULT_FALL`) |
| Form-Field | `fall` | nein | Alternative zu `X-Fall` |
| Header | `X-Beleg-Id` | nein | eigene Korrelations-ID (statt Basisname) |
| Form-Field | `id` | nein | Alternative zu `X-Beleg-Id` |

**202 Accepted**
```json
{
  "angenommen": true,
  "id": "Lohnsteuer_2024__a1b2c3d4",
  "originalname": "Lohnsteuer_2024.pdf",
  "fall": "Fall 1",
  "status": "wartet",
  "ausgang": { "json": "Fall_1/Lohnsteuer_2024__a1b2c3d4.json",
               "md":   "Fall_1/Lohnsteuer_2024__a1b2c3d4.md" },
  "abfrage": "/beleg/Lohnsteuer_2024__a1b2c3d4",
  "eingang": "posteingang/Fall 1/"
}
```
> Die Antwort kommt **sofort** (202 = angenommen, nicht fertig). Die ID ist
> vorhersehbar (content-adressiert, s. §6) — unter ihr erscheint später die Ausgabe.

**Fehler:** `400 {"fehler":"keine_datei"}` · `413` (zu groß) · `500 {"fehler":"intake_fehlgeschlagen","message":…}`

```bash
curl -F datei=@Lohnsteuer_2024.pdf -H 'X-Fall: Fall 1' http://localhost:7810/beleg
```

---

### `POST /beleg/raw`
Roher Request-Body (kein multipart) — für App-zu-App. `Content-Type` beliebig.

| Header | Pflicht | Bedeutung |
|---|---|---|
| `X-Dateiname` | nein | Originalname (Default `beleg.bin`) — bestimmt Endung/Modus |
| `X-Fall` | nein | Fall-Zuordnung |
| `X-Beleg-Id` | nein | eigene Korrelations-ID |

**202** identisch zu `POST /beleg`. **Fehler:** `400 {"fehler":"leerer_body"}` · `413` · `500`.

```bash
curl --data-binary @Beleg.pdf -H 'X-Dateiname: Beleg.pdf' -H 'X-Fall: Fall 2' \
     http://localhost:7810/beleg/raw
```

---

### `GET /beleg/:id`
Sucht `:id` über alle Fall-Unterordner. `:id` wird serverseitig bereinigt
(Schutz gegen Pfad-Traversal).

- **200** — fertig:
  ```json
  { "status": "fertig", "id": "…", "result": { /* Beleg-Result, s. §4 */ },
    "links": { "json": "/beleg/…/json", "md": "/beleg/…/md" } }
  ```
- **422** — fehlgeschlagen:
  ```json
  { "status": "fehler", "id": "…",
    "diagnose": { "id":"…","fall":"…","originalname":"…","code":"kurator_fehler",
                  "message":"…","zeitpunkt":"…" } }
  ```
- **404** — unbekannt (noch in Arbeit, in posteingang, oder existiert nicht):
  `{"status":"unbekannt","id":"…"}`

---

### `GET /beleg/:id/json`
Liefert die rohe Beleg-Result-JSON-Datei (`Content-Type: application/json`).
**404** `{"fehler":"nicht_fertig","id":"…"}` wenn noch nicht erzeugt.

### `GET /beleg/:id/md`
Liefert die Markdown-Transkription (`Content-Type: text/markdown`). **404** analog.

---

### `GET /mastercase?fall=<Fall>`
Baut den Master-Case des Falls **frisch** aus allen vorhandenen Beleg-Results,
**schreibt** ihn nach `ausgang/<Fall>/mastercase_<Fall>.json` (mode 0666) und
**liefert** ihn zurück. `fall` fehlt → `BELEG_DEFAULT_FALL`.

- **200** — der Master-Case (s. §5)
- **404** `{"fehler":"keine_belege","fall":"…"}` — kein Beleg im Fall
- **500** `{"fehler":"mastercase_fehlgeschlagen","message":…}`

```bash
curl "http://localhost:7810/mastercase?fall=Fall%201"
```

---

### `GET /faelle`
```json
{ "faelle": [ { "ordner": "Fall_1", "belege": 3, "mastercase": true } ] }
```

---

## 4. Datenmodell: Beleg-Result

`ausgang/<Fall>/<id>.json` — `schema: "beleg-result/v1"`. Ein Lauf = eine Datei.

| Feld | Typ | Bedeutung |
|---|---|---|
| `schema` | `"beleg-result/v1"` | Format-Version |
| `dateiname` | string | Originalname |
| `status` | `"ok"` \| `"fehler"` \| `"leer"` | im Erfolgsfall `"ok"` |
| `modus` | `"text-pdf"` \| `"scan-pdf"` \| `"bild"` \| `"text"` | aus Quellart abgeleitet |
| `fall` | string | Fall-Zuordnung (Anzeigename) |
| `id` | string | `<basis>__<sha8>` (s. §6) |
| `sha256` | string | SHA-256 des Datei-Inhalts |
| `dokumente` | `Dokument[]` | 1 Datei kann mehrere Dokumente enthalten |
| `positionen` | `Position[]` | **flacher Spiegel** ALLER Positionen (+ Herkunft) |
| `kpi` | `Kpi` | Kennzahlen des Laufs |
| `markdownDatei` | string | Dateiname der zugehörigen `.md` |
| `verarbeitung` | object | `{ engine:"Kurator", ms, usage?, erstellt, ausCache? }` |

**`Dokument`**

| Feld | Typ | Bedeutung |
|---|---|---|
| `dokument_typ` | string | z. B. `"Lohnsteuerbescheinigung"` |
| `aussteller` | string \| null | z. B. `"LBS Süd"` |
| `person` | string \| null | Person, auf die sich die Werte beziehen |
| `kalenderjahr` | number \| null | Steuerjahr der Werte |
| `finanzamt` | string \| null | falls genannt |
| `rolle` | `"A"` \| `"B"` \| ⌀ | A = steuerpflichtig, B = Ehepartner |
| `positionen` | `Position[]` | die Wert-Zeilen dieses Dokuments |

**`Position`** — der Kern (eine ELSTER-Wert-Zeile)

| Feld | Typ | Bedeutung |
|---|---|---|
| `bezeichnung` | string | wie im Beleg gelesen (Kurator) |
| `anlage` | string \| null | aufgelöst, z. B. `"Anlage KAP"` |
| `zeile` | string \| null | z. B. `"Zeile 7"` |
| `wert` | number \| string \| boolean \| null | typgerecht (datentyp-coerced) |
| `e_code` | string \| null | ELSTER-Code (SSoT), z. B. `"E0200201"` |
| `kennzahl` | string[] | z. B. `["210","410"]` (Person A/B) |
| `datentyp` | `Datentyp` | s. u. |
| `elster_kennziffer` | string \| null | `"Anlage KAP Zeile 7 · Kz 210/410"` |
| `aufgeloest` | `"zeile"` \| `"label"` | wie der e_code gefunden wurde |
| `resolver_score` | number? | nur bei `"label"` (0–1) |
| `unsicher` | boolean | true = e_code unsicher/fehlend |
| `wert_code` | string? | Enum-Code, falls `datentyp==="enum"` |
| `dokument_typ`,`aussteller`,`quelle` | — | **nur im flachen Spiegel** (Herkunft) |
| `person`,`rolle` | — | Person/Rolle der Zeile |

**`Datentyp`** = `idnr` \| `date` \| `bool_jax` \| `int_euro` \| `int_nn_euro` \| `decimal_eur_cent` \| `enum` \| `string`

**`Kpi`**

| Feld | Typ | Bedeutung |
|---|---|---|
| `anzahl_werte` | number | Anzahl Positionen gesamt |
| `mit_kennziffer` | number | Positionen mit `kennzahl` oder `e_code` |
| `unsicher` | number | Positionen mit `unsicher: true` |
| `tokens_pro_sek` | number? | Durchsatz (entfällt bei Cache-Treffer) |
| `total_ms` | number | Kurator-Dauer |
| `warnung` | boolean | true bei Modell-Warnung oder `unsicher > 0` |

**Beispiel (gekürzt)**
```json
{
  "schema": "beleg-result/v1",
  "dateiname": "Lohnsteuer_2024.pdf", "status": "ok", "modus": "scan-pdf",
  "fall": "Fall 1", "id": "Lohnsteuer_2024__a1b2c3d4", "sha256": "…",
  "dokumente": [{
    "dokument_typ": "Lohnsteuerbescheinigung", "aussteller": "Beispiel GmbH",
    "person": "Max Mustermann", "kalenderjahr": 2024, "finanzamt": null, "rolle": "A",
    "positionen": [{
      "bezeichnung": "Bruttoarbeitslohn", "anlage": "Anlage N", "zeile": "Zeile 1",
      "wert": 6565.26, "e_code": "E0200201", "kennzahl": ["110"],
      "datentyp": "decimal_eur_cent", "elster_kennziffer": "Anlage N Zeile 1 · Kz 110",
      "aufgeloest": "label", "resolver_score": 1, "unsicher": false
    }]
  }],
  "positionen": [ { "…": "flacher Spiegel + dokument_typ/aussteller/quelle" } ],
  "kpi": { "anzahl_werte": 3, "mit_kennziffer": 2, "unsicher": 1,
           "tokens_pro_sek": 103, "total_ms": 6209, "warnung": true },
  "markdownDatei": "Lohnsteuer_2024__a1b2c3d4.md",
  "verarbeitung": { "engine": "Kurator", "ms": 6209,
                    "usage": { "input": 1258, "output": 714 }, "erstellt": "…" }
}
```

Die zugehörige **`.md`** trägt YAML-Frontmatter (`id, fall, dateiname, modus,
dokumenttypen, anzahl_werte, sha256, engine, erstellt`) + die vollständige
Transkription.

---

## 5. Datenmodell: Master-Case

`ausgang/<Fall>/mastercase_<Fall>.json`. Aggregiert alle Beleg-Results des Falls.

| Feld | Typ | Bedeutung |
|---|---|---|
| `fall` | string | Anzeigename |
| `erzeugt` | string (ISO) | Zeitpunkt des Builds |
| `jahre` | `{ [jahr]: MasterJahr }` | pro Steuerjahr |
| `vergleich` | `VergleichZeile[]` | erstes vs. letztes Jahr je e_code, sortiert nach \|Δ\| |
| `fehlende_belege` | `FehlenderBeleg[]` | Dokumenttyp-Diff über Jahre |
| `_datei` | string | absoluter Pfad der Master-Datei |

**`MasterJahr`**

| Feld | Typ | Bedeutung |
|---|---|---|
| `veranlagung` | `"einzel"` \| `"zusammen"` | `zusammen`, wenn >1 Person |
| `personen` | `MasterPerson[]` | sortiert nach Rolle (A, B) |
| `engineInput` | object | abgeleiteter Stufe-4-Input (s. u.) |

**`MasterPerson`**

| Feld | Typ | Bedeutung |
|---|---|---|
| `rolle` | `"A"` \| `"B"` | |
| `person_key` | string | normalisierter Name (Gruppierungs-Key) |
| `idnr` | string \| null | Identifikationsnummer |
| `name` | string \| null | |
| `anlagen` | string[] | distinkte Anlagen der Person |
| `belege` | string[] | distinkte Dokumenttypen |
| `elsterWerte` | `{ [e_code]: wert }` | aggregiert (Beträge summiert, sonst Identität) |

**`engineInput`** — direkt für `POST :12015/api/rechnen`:
```json
{ "steuerjahr": 2024,
  "elsterWerte": { "E0200201": 6565.26, "E0200301": 980, "E0500406__B": "54129386608" } }
```
Person A direkt, **Person B mit `__B`-Suffix** bei Zusammenveranlagung.

**`VergleichZeile`** = `{ e_code, label, anlage, zeile, delta, status, "<jahr>": wert, … }`
mit `status ∈ {geändert, neu, entfallen, gleich}`. **`FehlenderBeleg`** =
`{ beleg, fehlt_in, vorhanden_in }`.

> **Aggregation:** Nur monetäre Datentypen (`int_euro`/`int_nn_euro`/`decimal_eur_cent`)
> werden summiert; Identifikatoren/Daten/Enums nehmen den Identitätswert. `vergleich`
> berücksichtigt nur Beträge.

---

## 6. Ordnervertrag, Fall-Routing & ID

```
beleg-api-data/
  posteingang/<Fall>/<datei>      Drop-Zone (Unterordner = Fall/Auftrag)
  verarbeitung/<token>/<datei>    in Bearbeitung (atomar geclaimt, .fall-Sidecar)
  ausgang/<Fall>/<id>.json|.md    Ergebnis + mastercase_<Fall>.json   ← lauschen
  fehler/<Fall>/<id>.fehler.json  Original + Diagnose
  archiv/<id>.<ext>               erfolgreiche Originale (BELEG_ARCHIVIEREN=0 → löschen)
  cache/kurator-v1/<sha256>.json  Kurator-Cache (s. §8)
```

- **Fall-Routing:** Datei in `posteingang/<Fall>/` → `fall = <Fall>`. Direkt in
  `posteingang/` → `fall = BELEG_DEFAULT_FALL`. HTTP: `X-Fall` / `fall`. Der
  Ausgang-Ordnername ist ein FS-sicherer Slug (`"Fall 1"` → `Fall_1`), das `fall`-Feld
  im JSON bleibt der Anzeigename.
- **ID:** `<bereinigter-basisname>__<sha8>` (sha8 = erste 8 Hex des Inhalts-SHA-256).
  Gleicher Inhalt + gleicher Name → gleiche ID → **idempotent**. Eigene ID via
  `X-Beleg-Id`/`id`.
- **Sicheres Ablegen:** Der Wächter greift nur Dateien mit über 2 Polls **stabiler
  Größe**; Endungen `.tmp/.part/.partial/.crdownload/.download` und Dotfiles werden
  ignoriert → erst `.tmp` schreiben, dann umbenennen.
- **Atomarer Output:** `.md` zuerst, dann `.json` (beide tmp+rename) — ein Konsument,
  der auf `*.json` lauscht, findet die `.md` garantiert vor.
- **Crash-Recovery:** Beim Start liegengebliebene Claims in `verarbeitung/` werden
  erneut eingereiht.

---

## 7. Eingangsformate

| Quellart | Endungen | Verarbeitung |
|---|---|---|
| `pdf` | `.pdf` | nativ als Document-Block an den Kurator |
| `bild` | `.png .jpg .jpeg .webp .gif` | nativ als Image-Block |
| `text` | `.txt .md .markdown .csv .tsv .json .xml .html .htm .log .yaml .yml .ini .rtf` | inline |

Unbekannte Endung → als Text versucht, sofern nicht binär (NUL-Bytes). Sonst
Fehler `nicht_unterstuetzt`.

---

## 8. Duplikat-Cache

Gleicher Inhalt (gleicher `sha256`) → der teure Kurator-Call wird aus
`cache/kurator-v1/<sha256>.json` bedient (kein erneuter Opus-Call). Auflösung +
Assemblierung laufen trotzdem → eine **volle Kopie** (JSON + MD) landet im neuen
Fall-Ordner. Cache-Treffer: `verarbeitung.ausCache: true`, Log-Marker `↺ cache`.
Abschaltbar via `BELEG_CACHE=0`. Invalidierung: `VERSION` in `cache.ts` hochzählen.

---

## 9. Fehlercodes (Verarbeitung)

Landen als `fehler/<Fall>/<id>.fehler.json` mit `{ code, message, … }`:

| `code` | Bedeutung |
|---|---|
| `leer` | Datei ist 0 Byte |
| `zu_gross` | größer als `BELEG_MAX_MB` |
| `nicht_unterstuetzt` | Dateityp nicht verarbeitbar |
| `kurator_fehler` | Opus-Call: HTTP-/Netz-/Parse-Fehler |
| `unbekannt` | sonstiger Fehler |

HTTP-Fehlerantworten: `400` (keine_datei / leerer_body), `401` (unauthorisiert),
`404` (nicht_fertig / unbekannt / keine_belege), `413` (zu groß), `422` (Beleg
fehlerhaft), `429` (Rate-Limit), `500` (intake/mastercase fehlgeschlagen).

---

## 10. Konfiguration (`BELEG_*`)

| Env | Default | Bedeutung |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Pflicht** (Kurator) |
| `BELEG_PORT` | `7810` | HTTP-Port |
| `BELEG_HTTP` | `1` | `0` → reiner Ordner-Betrieb |
| `BELEG_ROOT` | `<repo>/beleg-api-data` | Basis aller Ordner |
| `BELEG_DEFAULT_FALL` | `Fall 1` | Fall ohne Unterordner/`X-Fall` |
| `BELEG_MASTERCASE_AUTO` | `1` | Master-Case nach jedem Beleg neu schreiben |
| `BELEG_KENNZAHLEN_PATH` | `src/verticals/elster/data/postgres-dumps/elster_kennzahlen.json` | SSoT |
| `BELEG_CACHE` | `1` | Duplikat-Cache an/aus |
| `BELEG_CACHE_DIR` | `<root>/cache` | Cache-Ordner |
| `BELEG_MODELL` | `claude-opus-4-8` | Kurator-Modell (intern; UI/Log: „Kurator") |
| `BELEG_MAX_MB` | `32` | max. Dateigröße |
| `BELEG_PARALLEL` | `3` | gleichzeitige Belege |
| `BELEG_POLL_MS` | `1500` | Wächter-Poll-Intervall |
| `BELEG_ARCHIVIEREN` | `1` | `0` → Original nach Erfolg löschen |
| `BELEG_TOKEN` | — | gesetzt → Bearer-Pflicht |

---

## 11. e_code-Auflösung — Genauigkeit & Grenzen

`e_code/kennzahl/anlage/zeile` werden gegen die Kennzahlen-SSoT aufgelöst:
1. **deterministisch** `(anlage, zeile)` bzw. `(anlage, kennzahl)` → `aufgeloest: "zeile"`,
2. sonst **Label-Fuzzy** (Jaccard auf der Bezeichnung) → `aufgeloest: "label"` + `resolver_score`.

**Bekannte Grenze (v1):** Der Jaccard-Label-Matcher ist für reale ELSTER-Labels
(Nummern-Präfix, Klammerzusätze, Person-A/B-Varianten) zu spröde — wichtige Werte
können knapp unter der Schwelle hängenbleiben (`unsicher: true`, `e_code: null`).
**Empfohlener Upgrade-Pfad:** Embedding-Resolver (`bge-m3`-Index +
`golden_elster_mappings.json` aus `src/verticals/elster/data/`) statt Jaccard.
Konsumenten sollten `unsicher`/`aufgeloest`/`resolver_score` auswerten und niedrig
bewertete `label`-Treffer ggf. einer Prüfung zuführen.
