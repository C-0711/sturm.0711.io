# 0711 Schemas v1 — kanonische Datenstrukturen

**Letzte Aktualisierung:** 2026-06-05 (Bombas, im Auftrag von Mastermind C)
**Status:** Verbindlich. Alle Steuer-Apps richten sich nach diesen Schemas aus.

---

## Die 3 zentralen Objekte

```
                  Fall
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
     Profil    jahre[2024]   belege[]
        │           │            │
        ▼           ▼            ▼
    personen[] jahresperson[] positionen[]
                    │
                    ▼
              engineInput  → bmf-api :12015 /api/rechnen
```

### `Fall` (fall.schema.json)
Die **fachliche Klammer**. Ein Fall = ein Steuerpflichtiger (oder ein Ehegatten-Paar) über ein oder mehrere Veranlagungsjahre. Enthält Profil + Jahresblöcke + Belege.

### `MasterCase` (mastercase.schema.json)
**Output-Snapshot** eines Daten-Producers (z.B. `beleg-api`). Schlanker als der full `Fall` — fokussiert auf das was die Engine direkt braucht. Subset des Falls.

### `Profil` (profil.schema.json)
**Stammdaten** eines Falls: Haushalt, Personen, Religionszugehörigkeit, Bankverbindung. Zeitlich konstant — jahresvariable Werte gehören in den Jahresblock.

## Schema-Hierarchie

| Schema | $ref-uses |
|---|---|
| `fall.schema.json` | → `profil`, `jahresblock`, `beleg`, `vergleichzeile`, `rechenergebnis` |
| `profil.schema.json` | → `person` |
| `mastercase.schema.json` | → `jahresblock`, `vergleichzeile` |
| `jahresblock.schema.json` | → `jahresperson` |
| `beleg.schema.json` | → `position` |
| `vergleichzeile.schema.json` | (atomar) |
| `rechenergebnis.schema.json` | (atomar) |
| `person.schema.json` | (atomar) |
| `position.schema.json` | (atomar) |
| `jahresperson.schema.json` | (atomar) |

## Beispiel: Minimal-Fall

```json
{
  "schema": "fall/v1",
  "fall_id": "demo-001",
  "erzeugt": "2026-06-05T08:50:00Z",
  "tenant": "b2c",
  "profil": {
    "haushalt": {
      "veranlagung": "einzel",
      "bundesland": "rheinland-pfalz",
      "finanzamt": "Mainz"
    },
    "personen": [
      { "rolle": "A", "person_key": "p_a", "name": "Max Mustermann" }
    ]
  },
  "jahre": {
    "2024": {
      "veranlagung": "einzel",
      "personen": [
        {
          "person_key": "p_a",
          "rolle": "A",
          "anlagen": ["Anlage N"],
          "elsterWerte": {
            "E0200201": 50000,
            "E0200301": 7000,
            "E0200401": 380
          }
        }
      ],
      "engineInput": {
        "steuerjahr": 2024,
        "elsterWerte": {
          "E0200201": 50000,
          "E0200301": 7000,
          "E0200401": 380,
          "bundesland": "rheinland-pfalz"
        }
      }
    }
  }
}
```

## Verträge — wie Apps mit den Schemas umgehen müssen

### Regel 1 — Stammdaten in Profil, jahresvariable Werte in jahresblock
Religion-Wechsel? → Profil aktualisieren. Bruttoarbeitslohn 2024? → `jahre.2024.personen[].elsterWerte.E0200201`.

### Regel 2 — `engineInput` ist abgeleitet, nicht authoritativ
`jahre.YYYY.engineInput.elsterWerte` ist die **Aggregation** aus den Personen-elsterWerten (inkl. `__B`-Suffix für Person B) + `bundesland` aus Profil. Wenn sich `personen[].elsterWerte` ändert, muss `engineInput` neu gebaut werden.

### Regel 3 — `__B`-Suffix-Konvention
- In `jahresperson.elsterWerte` stehen Codes **ohne** Suffix (z.B. `E0200201`).
- In `engineInput.elsterWerte` werden Person-B-Codes **mit** Suffix gespeichert (z.B. `E0200201__B`).
- Die Pipeline (oder `eCodeBridge.baueElsterFelderAusFelder`) ist verantwortlich für die Anwendung.

### Regel 4 — `bundesland` immer im engineInput
`bmf-api` braucht es für Kirchensteuer-Berechnung. Default-Fallback: `"rheinland-pfalz"` (siehe eCodeBridge).

### Regel 5 — `schema`-Feld zur Disambiguierung
Jeder Top-Level-Container trägt sein Schema-Tag:
- `"schema": "fall/v1"` für `Fall`
- `"schema": "mastercase/v1"` für `MasterCase`

So können Apps zur Laufzeit prüfen welche Form sie bekommen.

## Migrationspfad pro App

| App | Heute (Schema) | Soll | Aktion |
|---|---|---|---|
| `beleg-api` (STURM-polar) | `MasterCase` (bereits 1:1 dieses Format) | `mastercase/v1` | nur `"schema": "mastercase/v1"` als Feld setzen + neue ref-IDs verlinken |
| `quantum-ctax5` (`PROFILE`) | eigene Profil-Form | `profil/v1` | Mapper `_profil_zu_canonical(PROFILE) → Profil` |
| `cb-ctax-backend` (`CaseState`) | `case_schema_v1` (custom, mit JSON-Patches + Reducer) | `fall/v1` als **Spiegel-Export** | Reducer produziert zusätzlich einen `Fall`-Export für externe Konsumenten (engine, andere apps) |
| `ctax4-sturm` | pipeline/types.ts (custom) | `fall/v1` + `mastercase/v1` | refactor auf gemeinsame Importe |
| `tax-quantum-svc` | unbekannt | `fall/v1` | check + ggf. Adapter |

## Wo die Schemas liegen

- **Kanonisch:** `~/0711-services/schemas/v1/*.json` auf REACTOR
- **Mirror:** `/Users/m1/.openclaw/workspace/0711-services/schemas/v1/*.json`
- **In Apps verlinken:** Symlink oder Build-Step der die JSONs ins App-eigene `public/schemas/` oder `src/schemas/` kopiert

## Validierung

JSON-Schema 2020-12. Tools:
- TypeScript: `ajv-cli` für CI-Validierung
- Python: `jsonschema` Library
- Live: `bmf-api`-Smoketests sollten Beispiel-Fall-Dateien validieren

```bash
# Beispiel: Stricker MasterCase validieren
npx ajv -s ~/0711-services/schemas/v1/mastercase.schema.json \
        -r ~/0711-services/schemas/v1/jahresblock.schema.json \
        -r ~/0711-services/schemas/v1/jahresperson.schema.json \
        -r ~/0711-services/schemas/v1/vergleichzeile.schema.json \
        -d ~/0711-STURM-polar/.claude/worktrees/gallant-dewdney-9f87f5/beleg-api-data/ausgang/quantum/mastercase_quantum.json
```

## Versionierung

- **Pfad-Konvention:** `/schemas/v1/*.json`, `/schemas/v2/*.json`
- **Breaking Change** = neuer Major (z.B. v2)
- **Additive Felder** = im selben v1 möglich, mit `additionalProperties: true` an passender Stelle

## Verantwortlich

- **Maintenance:** Fleet Admiral Bombas
- **Genehmigung:** Mastermind C
- **Änderungen:** PR-style ankündigen, dann mergen
