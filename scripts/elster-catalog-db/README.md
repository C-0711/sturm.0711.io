# elster-catalog-db

Postgres-Katalog aus allen 5 Quelldateien in `Falldaten/test_suite/Taxcatalog_Elster/`:

- `E10-2024.xsd` (Inhalts-Schema mit 2.275 E-Codes)
- `E10-2024-Nutzdaten.xsd` (Brücke)
- `elster11_E10_2024_extern.xsd` (Envelope)
- `Jahresdokumentation_10_2024 1.xml` (35 Anlagen × 5 Worksheets)
- `est_e10_2024.xml` (Beispiel — wird hier nicht geladen, dient als Fixture)

## Quick start

```bash
brew install postgresql@15 && brew services start postgresql@15
createdb elster_catalog
pip install -r requirements.txt
bash run_all.sh
```

Default-DSN: `postgresql:///elster_catalog`. Andere DB via `PGURI=… bash run_all.sh`.

## Pipeline

| Schritt | Befüllt | Quelle |
|---|---|---|
| `schema.sql` | DDL für Schema `elster.*` | — |
| `load_01_xsd_types.py` | `vz`, `format_typ`, `enumeration_typ`, `enumeration_wert` | E10-2024.xsd |
| `load_02_xsd_codes.py` | `anlage` (seed), `kontext` (seed), `feld` (E-Code seed) | E10-2024.xsd |
| `load_03_jahresdok.py` | `anlage`, `kontext`, `feld` (UPSERT mit offiziellen Daten), `regel`, `regel_feld`, `kennzahl`, `drucktext` | Jahresdokumentation |
| `load_04_views.py` | MatViews: `vw_zeile_to_code`, `vw_lstb_nr_to_code`, `vw_sb_kz_to_code` | — |

## Beispiel-Abfragen

```sql
-- VaSt-LStB Nr. 25 → E-Code
SELECT code, drucktext FROM elster.vw_lstb_nr_to_code WHERE vz=2024 AND lstb_nr='25';

-- Anlage N, Vordruck-Zeile 18 → E-Code
SELECT code, drucktext FROM elster.vw_zeile_to_code
 WHERE vz=2024 AND anlage='N' AND vordruckzeile='18';

-- Klassische Bescheid-Kennzahl im Sachbereich 17
SELECT code, anlage, drucktext FROM elster.vw_sb_kz_to_code
 WHERE vz=2024 AND sachbereich='17' AND kennzahl='0210';

-- Fuzzy Drucktext-Suche (pg_trgm)
SELECT name, drucktext FROM elster.feld
 WHERE drucktext % 'Arbeitnehmerbeiträge Krankenversicherung'
 ORDER BY similarity(drucktext,'Arbeitnehmerbeiträge Krankenversicherung') DESC LIMIT 5;

-- Welche Plausi-Regeln betreffen E0200201?
SELECT r.fehlercode, r.regelart, r.fehlertext
  FROM elster.regel r JOIN elster.regel_feld rf USING (regel_id)
  JOIN elster.feld f USING (feld_id)
 WHERE f.name='E0200201';
```

## Re-Run / Updates

Jeder Loader ist idempotent (`ON CONFLICT … DO UPDATE`). Bei neuer
Jahresdokumentation einfach `load_03_jahresdok.py` erneut ausführen.
`schema.sql` enthält `DROP SCHEMA elster CASCADE` — **also nicht in Produktion blind ausführen**.

## Runtime-Tabellen (für VAST-Extraktion)

`fall`, `beleg`, `extraktion`, `validierung_lauf`, `validierung_meldung`
werden vom Schema bereitgestellt aber nicht von den Loadern berührt.
Die VAST-Pipeline (sturm.0711.io) schreibt da hinein.
