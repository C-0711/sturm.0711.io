# STURM Smart-Schema-Builder — Prototype

Ein eigenstaendiger Prototyp der STURM-Komponente, die zur Laufzeit ein
Pydantic-v2-Modell aus den ELSTER-Metadaten zusammenbaut und es Mistral
Large als Function-Tool zur strukturierten Extraktion uebergibt. Damit
ersetzt STURM die zwoelf hartcodierten Pydantic-Schemas in
`CTAXV1/services/lane4_master/services/document_schemas.py` und die
`SCHEMA_TO_ELSTER`-Tabelle in `elster_mapper.py`.

## Was der Prototyp macht

`smart_schema.py` liefert genau zwei oeffentliche Symbole:

- `SmartExtraction` / `ExtrahiertesFeld` — das Wrapper-Format, das wir
  vom LLM zurueckbekommen (siehe `frontend/public/doku/index.html`,
  Abschnitt _STURM Smart-Extraktion_).
- `build_smart_schema(doc_type, anlagen, person_idnrs, steuerjahr,
  db_pool)` — baut zur Laufzeit eine `pydantic.BaseModel`-Subklasse und
  ein passendes Mistral-Function-Schema.

Pro Feld setzen wir eine `Field(description=...)`, in die wir
Bezeichnung, ELSTER-Code, Anlage + Zeile, Datentyp, erlaubte
Enum-Werte und ein eventuelles Regex-Pattern packen. Mistral nutzt
diese Description direkt als Extraktions-Hint und liefert in einem
Pass Wert + ELSTER-Code zurueck — der bisherige zweite
Mapping-Schritt entfaellt.

## Installation

```bash
cd ~/dev-cb-ctax/scripts/sturm_prototype
pip install -r requirements.txt
```

## Demo ausfuehren

```bash
python demo_lohnsteuer.py
```

Erwartete Ausgabe (gekuerzt):

```
==============================================================================
STURM Smart-Schema-Builder — Prototype Demo
Quelle: fallback :9432 ag_catalog.elster_fields (2222 Felder)
==============================================================================

Felder im Schema: 776

Erste 5 Felder mit ihren Mistral-Descriptions:
------------------------------------------------------------------------------
  bruttoarbeitslohn
      Bruttoarbeitslohn. ELSTER-Code: E0200204. Anlage: N. Type: float.
      Primaere Anlage: N.

  ...

Mistral-Function-Schema (gekuerzt):
{
  "type": "function",
  "function": {
    "name": "extrahiere_lohnsteuerbescheinigung",
    "description": "...",
    "parameters": { ... }
  }
}

Fake-Mistral-Call (kein echter API-Hit):
...
Fertig. (Kein echter Mistral-Call abgesetzt.)
```

## DB-Quelle

Die Demo versucht zuerst die Phase-0-Zielquelle:

| Server | Schema/Tabelle |
|--------|----------------|
| `:12432 ctax` | `lane5_elster_export.elster_kennzahlen` + `field_definitions` + `enumerations` + `patterns` |

Faellt auf die alte Quelle zurueck, wenn die ETL noch nicht gelaufen
ist:

| Server | Schema/Tabelle |
|--------|----------------|
| `:9432 ctax_cb_chat` | `ag_catalog.elster_fields` |

Im Fallback-Modus liefern wir keine Enum-Werte und keine Regex-Pattern
in die Descriptions — die liegen erst im neuen Schema vor. Das
Schema-Skelett bleibt aber identisch, deshalb kann der Demo-Code im
Fallback laufen.

## Was NICHT enthalten ist

- Keine echte Mistral-API-Call. Der Fake-Call zeigt nur, wie das
  Payload aussehen wuerde.
- Kein Pass-1-Klassifizierer (Doc-Type-Erkennung). Wir erwarten den
  doc_type vom Aufrufer; ist er `None`, baut der Schema-Builder
  trotzdem ein generisches Schema ueber alle uebergebenen Anlagen.
- Kein Token-Streaming, kein Quellzitat-Layer (`bbox`-Mapping).
- Keine Konfidenz-Berechnung — die liefert das Modell.
- Keine Persistenz nach `taxCase.elster_felder` — das macht der
  bestehende Backend-Code (heute via `narrationsLoop.ts` →
  `extrahiereMitSturm` → `ctax_documents.haiku_befunde`).
- Keine Behandlung von Multi-Person-Anlagen (KAP A vs. KAP B): die
  `person_idnrs` werden nur durchgereicht und im `__sturm_meta__` des
  Modells abgelegt.
- Keine Lane-1-Param-Konvertierung — das uebernimmt weiterhin der
  Backend-Tool-Executor (toolExecutor.ts).

## Offene Designfragen fuer das Team

1. **Anlage-Filter:** wir filtern aktuell ueber
   `elster_kennzahlen.anlage` plus eine Praefix-Heuristik
   (`ANLAGE_KENNZAHL_PRAEFIX`). Sobald `field_definitions` eine
   `anlage`-Spalte bekommt, sollten wir direkt darueber filtern.
2. **Feld-Limit:** der alte `field_registry.hole_felder_fuer_dokumenttyp`
   limitiert auf 300 Felder fuer das Mistral-Prompt-Fenster. Brauchen
   wir das hier auch? Mistral Large vertraegt Function-Schemas mit
   ein paar tausend Properties, aber der Prompt-Roundtrip wird teurer.
3. **Multi-Person:** soll das Schema fuer KAP/N pro Person eine eigene
   Sub-Property bekommen (`person_a.kapitalertraege`,
   `person_b.kapitalertraege`) oder bleiben die Felder flach und der
   `person_idnr`-Hint steht in der Description? Aktueller Stand:
   flach + Hint.
4. **Enum-Strenge:** sollen wir bei `enumerations` einen Python-`Enum`
   erzeugen (Pydantic-Validierung erzwingt dann den Wertebereich) oder
   bleiben wir bei `str` und vertrauen auf das Mistral-Hint? Streng
   wuerde Halluzinationen vermeiden, aber bei OCR-Tippfehlern
   verlieren wir Werte.
5. **Type-Mapping:** `_DATENTYP_TO_PY` ist eine Heuristik. Sobald die
   ETL einen `daten_typ`-Spalte (string-codiert) anbietet, koennen wir
   ein vollstaendiges Mapping einsetzen.
6. **Cache:** das fertige Schema haengt nur an
   `(doc_type, tuple(anlagen), steuerjahr)`. Ein In-Memory-LRU-Cache
   im Backend reicht — DB-Roundtrip ist sonst pro Upload.
7. **Pass-1-Hand-Off:** wer entscheidet die `anlagen`-Liste? Bisher
   plant STURM, dass Pass 1 Doc-Type + Anlagen-Hints liefert. Das
   Pydantic-Wrapper-Modell `SmartExtraction.anlagen_hints` kommt aus
   Pass 2 zurueck — wir brauchen auch ein Pass-1-Output-Format.

## Datei-Layout

```
sturm_prototype/
  smart_schema.py        # build_smart_schema + Wrapper-Modelle
  demo_lohnsteuer.py     # End-to-End-Demo gegen :12432 oder :9432
  requirements.txt       # psycopg[binary] + pydantic
  README.md              # diese Datei
```
