# v1-Vertrag — fall/v1 & mastercase/v1 in sturm

> Kanonische Datenstrukturen aller 0711-Steuer-Apps. Quelle/SSoT:
> `~/0711-services/schemas/v1/` auf REACTOR (Maintenance: Bombas), hierher
> übernommen aus dem engine-bundle-Drop vom 2026-06-10. Verbindlich —
> Breaking Changes laufen als v2, additive Felder bleiben in v1.
> Master-Doku der Schemas: [`src/schemas/v1/SCHEMAS-README.md`](../src/schemas/v1/SCHEMAS-README.md).

## Datenmodell in einem Bild

```
                  Fall  (fall/v1 — fachliche Klammer)
                    │
        ┌───────────┼────────────┬──────────────────┐
        ▼           ▼            ▼                  ▼
     Profil    jahre["2024"]   belege[]      rechen_ergebnis["2024"]
        │           │            │                  ▲
        ▼           ▼            ▼                  │
    personen[] JahresPerson[] Positionen[]          │
                    │                               │
                    ▼  (abgeleitet, R2/R3/R4)       │
              engineInput ──► bmf-api :12015 /api/rechnen
```

`MasterCase` (mastercase/v1) ist der schlanke Producer-Snapshot davon:
`{ schema, fall, jahre, vergleich?, fehlende_belege? }` — das, was die Engine
direkt braucht.

## Die fünf Vertragsregeln

| # | Regel |
|---|---|
| R1 | Stammdaten → `profil`; jahresvariable Werte → `jahre.YYYY.personen[].elsterWerte` |
| R2 | `engineInput` ist **abgeleitet**, nie authoritativ — bei Werte-Änderung neu bauen |
| R3 | `__B`-Suffix **nur** im `engineInput`; `jahresperson.elsterWerte` strikt `^E\d{7}$` (Schema erzwingt beides via patternProperties) |
| R4 | `bundesland` immer im `engineInput` (Kirchensteuer); Default `rheinland-pfalz` |
| R5 | Schema-Tag zur Laufzeit-Disambiguierung: `"fall/v1"` bzw. `"mastercase/v1"` |

## Was liegt wo in diesem Repo

| Pfad | Inhalt |
|---|---|
| `src/schemas/v1/*.schema.json` | Die 10 kanonischen JSON-Schemas (draft 2020-12), 1:1-Kopie der SSoT |
| `src/schemas/v1/types.ts` | Faithful TS-Typen (identisch zum sturm-gateway/contract auf polar) |
| `src/schemas/v1/adapter.ts` | Harmonisierung der lokalen Mastercase-Formen → v1 (s.u.) |
| `scripts/fall-v1-smoke.mts` | Smoke: Echtdaten → v1, Vertrags-Invarianten hart geprüft |

## Adapter: beide lokalen Formen → v1

Sturm hat zwei Mastercase-Formen; beide werden harmonisiert:

1. **Evidenz-Form** (`web/mastercase-harmonize.ts` — entitaeten/fakten mit
   `e_code`/`value`/`confidence`/`sources`):
   `envelopeZuV1({ fallId, vz, mastercase, household, veranlagungsart, belege?, calc? })`
   → `{ fall, mastercase, uebersprungen }`. Läuft automatisch in
   `kickMastercase` (web/server.ts); der Envelope trägt additiv
   `fallV1` / `mastercaseV1` / `v1Uebersprungen`.
   Abruf: **`GET /api/v1/fall?id=<caseId>`** (Polling wie `/api/mastercase`).

2. **Jahres-Form** (`src/server/mastercase.ts buildMastercase` — fakten mit
   `eCodeParse`/`eCodeMap`): `jahresFormZuV1(mc, opt?)`.
   CLI: `npx tsx src/server/mastercase.ts --v1 [pfad]` → `{mastercase, fall, uebersprungen}` als JSON.

Was der Adapter dabei erzwingt:

- **Wert-Typisierung**: deutsche Beträge → `number` (`"13.440,00"` → `13440`),
  `"09.07.1965"` → ISO-Datum; Kennungen (≥9 reine Ziffern wie IdNr, führende
  Nullen wie PLZ `01067`) bleiben bewusst String.
- **person_key**: lowercase-Vollname (beleg-api-Konvention), sonst `p_a`/`p_b`.
- **Kein silent drop**: Werte ohne 7-stelligen eCode, leere Werte und
  Wert-Kollisionen (erster gewinnt) landen in `uebersprungen[]` — der Aufrufer
  entscheidet über Log/Anzeige/Eskalation.

## Validierung (CI/manuell)

```bash
npx tsx scripts/fall-v1-smoke.mts        # Invarianten + schreibt var/fall-v1/*.json

S=src/schemas/v1
npx --yes ajv-cli@5 validate --spec=draft2020 --strict=false \
  -s $S/fall.schema.json \
  -r "$S/profil.schema.json" -r "$S/person.schema.json" \
  -r "$S/jahresblock.schema.json" -r "$S/jahresperson.schema.json" \
  -r "$S/beleg.schema.json" -r "$S/position.schema.json" \
  -r "$S/vergleichzeile.schema.json" -r "$S/rechenergebnis.schema.json" \
  -d var/fall-v1/fall.json
```

(`--strict=false` nötig: die Schemas tragen ein Custom-Keyword `version`.)

## Grenzen / bewusste Entscheidungen

- `rechen_ergebnis` ist **pro Jahr**, nicht pro Person — bei Einzelbescheiden
  je Person trägt v1 nur den ersten Bescheid (`calcs[0]`).
- Lokale Pre-Calc-Ergebnisse sind als `engine: "sturm-precalc"` markiert —
  nie mit echten bmf-api-Resultaten (`quelle: lane1_v2_truth`) verwechseln.
- `vergleich`/`fehlende_belege` (Mehrjahres-Features) bleiben leer, bis hier
  ein zweites Veranlagungsjahr durchläuft; Typen/Schemas sind bereit.
- `var/` ist gitignored: Smoke-Artefakte enthalten echte Case-Daten.

## Kontext außerhalb dieses Repos

- **Engine**: bmf-api `POST :12015/api/rechnen` (Rechenwerk auf reactor);
  Request = `engineInput` (+ optional `aktiverProfilTyp`, `module`),
  Response = `endwerte` + `module[].spur` + `lane1`-Rechenschritte.
- **Gateway**: sturm-gateway auf polar (pm2, :7802) front-et beleg/ocr/bmf als
  `/api/v1/*`; nginx-Exposure auf sturm.0711.io stand 2026-06-10 noch aus (sudo).
- **Bundle-Drop**: `~/Desktop/engine-bundle` (Schemas + Live-Engine-Beispiele
  + Stricker-Beispiel-MasterCase).
