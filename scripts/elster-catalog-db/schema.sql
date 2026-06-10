-- ============================================================================
-- ELSTER Katalog-DB — vollständiges Postgres-Schema
-- Quellen: E10-2024.xsd, E10-2024-Nutzdaten.xsd, elster11_E10_2024_extern.xsd,
--          Jahresdokumentation_10_2024 1.xml
-- Target: Postgres 15+
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Schema-Namespace ──────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS elster CASCADE;
CREATE SCHEMA elster;
SET search_path = elster, public;

-- ============================================================================
--  STAMM- / KATALOGTABELLEN (statisch pro Veranlagungszeitraum)
-- ============================================================================

-- ─── Veranlagungszeitraum ──────────────────────────────────────────────────
CREATE TABLE vz (
  vz                INT PRIMARY KEY,
  datenart          TEXT NOT NULL,
  eric_version      TEXT,
  schema_namespace  TEXT NOT NULL,
  jahresdok_quelle  TEXT,
  xsd_quelle        TEXT,
  generated_at      TIMESTAMPTZ,
  imported_at       TIMESTAMPTZ DEFAULT now()
);

-- ─── Anlagen (Mantelbogen + Anlagen N, KAP, VOR, …) ────────────────────────
CREATE TABLE anlage (
  anlage_id         BIGSERIAL PRIMARY KEY,
  vz                INT NOT NULL REFERENCES vz(vz),
  name              TEXT NOT NULL,
  ff_prefix         CHAR(2),
  pflicht           BOOLEAN,
  max_lfd_nr        INT,
  field_count       INT,
  UNIQUE (vz, name)
);

-- ─── Kontexte (XML-Pfade mit Wiederholbarkeit) ─────────────────────────────
CREATE TABLE kontext (
  kontext_id        BIGSERIAL PRIMARY KEY,
  anlage_id         BIGINT NOT NULL REFERENCES anlage ON DELETE CASCADE,
  pfad              TEXT NOT NULL,
  parent_pfad       TEXT,
  max_wiederhol     TEXT,
  annotationen      TEXT,
  aenderungsinfo    TEXT,
  aenderungsdetails TEXT,
  UNIQUE (anlage_id, pfad)
);
CREATE INDEX ix_kontext_pfad_trgm ON kontext USING gin (pfad gin_trgm_ops);

-- ─── Format-Typen (XSD simpleTypes, kanonisch dedupliziert) ────────────────
CREATE TABLE format_typ (
  format_id         BIGSERIAL PRIMARY KEY,
  vz                INT NOT NULL REFERENCES vz(vz),
  xsd_type_name     TEXT NOT NULL,
  kanonisch         TEXT NOT NULL,
  min_laenge        INT,
  max_laenge        INT,
  max_vorkomma      INT,
  max_nachkomma     INT,
  regex             TEXT,
  base_xsd          TEXT,
  beschreibung      TEXT,
  UNIQUE (vz, xsd_type_name)
);

-- ─── Enumerationen ─────────────────────────────────────────────────────────
CREATE TABLE enumeration_typ (
  enum_typ_id       BIGSERIAL PRIMARY KEY,
  format_id         BIGINT REFERENCES format_typ ON DELETE CASCADE,
  vz                INT NOT NULL REFERENCES vz(vz),
  name              TEXT NOT NULL,
  beschreibung      TEXT,
  UNIQUE (vz, name)
);
CREATE TABLE enumeration_wert (
  enum_wert_id      BIGSERIAL PRIMARY KEY,
  enum_typ_id       BIGINT NOT NULL REFERENCES enumeration_typ ON DELETE CASCADE,
  wert              TEXT NOT NULL,
  label_de          TEXT,
  sort_order        INT
);
CREATE INDEX ix_enum_wert ON enumeration_wert (enum_typ_id, wert);

-- ─── Felder (zentrale Tabelle — E-Codes + Index-/Hilfsfelder) ──────────────
CREATE TABLE feld (
  feld_id           BIGSERIAL PRIMARY KEY,
  anlage_id         BIGINT NOT NULL REFERENCES anlage ON DELETE CASCADE,
  kontext_id        BIGINT REFERENCES kontext,
  name              TEXT NOT NULL,
  ist_ecode         BOOLEAN NOT NULL,
  beschreibung      TEXT,
  format_id         BIGINT REFERENCES format_typ,
  format_label      TEXT,
  format_regex      TEXT,
  formatkennzeichen CHAR(1),
  min_laenge        INT,
  max_laenge        INT,
  max_zeilen        INT,
  pflichtfeld       BOOLEAN,
  pflicht_fehlertext TEXT,
  indexfeld         BOOLEAN,
  vordruckzeile     TEXT,
  drucktext         TEXT,
  internes_eric     BOOLEAN,
  zusatz_info       TEXT,
  annotationen      TEXT,
  aenderungsinfo    TEXT,
  aenderungsdetails TEXT,
  UNIQUE (anlage_id, kontext_id, name)
);
CREATE INDEX ix_feld_name           ON feld (name);
CREATE INDEX ix_feld_vz_anlage_zeile ON feld (anlage_id, vordruckzeile);
CREATE INDEX ix_feld_drucktext_trgm ON feld USING gin (drucktext gin_trgm_ops);
CREATE INDEX ix_feld_drucktext_fts  ON feld USING gin (to_tsvector('german', coalesce(drucktext,'')));

-- ─── Plausi-Regeln ─────────────────────────────────────────────────────────
CREATE TABLE regel (
  regel_id          BIGSERIAL PRIMARY KEY,
  anlage_id         BIGINT NOT NULL REFERENCES anlage ON DELETE CASCADE,
  kontext_id        BIGINT REFERENCES kontext,
  name              TEXT,
  fehlercode        TEXT,
  beschreibung      TEXT,
  pruefbedingung    TEXT,
  fehlertext        TEXT,
  vordruck_bereich  TEXT,
  zeilen_bereich    TEXT,
  geprueft_usb      TEXT,
  regelart          TEXT,
  annotationen      TEXT,
  aenderungsinfo    TEXT,
  aenderungsdetails TEXT
);
CREATE INDEX ix_regel_fehlercode ON regel (fehlercode);

-- Many-to-many: Regel ↔ geprüfte Felder
CREATE TABLE regel_feld (
  regel_id          BIGINT NOT NULL REFERENCES regel ON DELETE CASCADE,
  feld_id           BIGINT NOT NULL REFERENCES feld  ON DELETE CASCADE,
  PRIMARY KEY (regel_id, feld_id)
);

-- ─── Kennzahlen (Sachbereich / MZI / klassische 3-4-stellige Kennzahl) ────
CREATE TABLE kennzahl (
  kennzahl_id       BIGSERIAL PRIMARY KEY,
  anlage_id         BIGINT NOT NULL REFERENCES anlage ON DELETE CASCADE,
  feld_id           BIGINT REFERENCES feld,
  feldname          TEXT,
  lfd_nr_vordruck   INT,
  mzi               TEXT,
  sachbereich       TEXT,
  kennzahl          TEXT,
  aenderungsinfo    TEXT,
  aenderungsdetails TEXT
);
CREATE INDEX ix_kennzahl_lookup ON kennzahl (sachbereich, kennzahl);

-- ─── Drucktexte (Vordruck-Layout-Strings) ──────────────────────────────────
CREATE TABLE drucktext (
  drucktext_id      BIGSERIAL PRIMARY KEY,
  anlage_id         BIGINT NOT NULL REFERENCES anlage ON DELETE CASCADE,
  feld_id           BIGINT REFERENCES feld,
  vordruck_seite    TEXT,
  position          TEXT,
  text              TEXT NOT NULL
);

-- ============================================================================
--  RUNTIME — Steuerfälle, Belege, Extraktionen, ERiC-Validierung
-- ============================================================================

CREATE TABLE fall (
  fall_id           BIGSERIAL PRIMARY KEY,
  mandant_extern_id BIGINT,
  vz                INT NOT NULL REFERENCES vz(vz),
  veranlagung_art   TEXT,
  status            TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE beleg (
  beleg_id          BIGSERIAL PRIMARY KEY,
  fall_id           BIGINT NOT NULL REFERENCES fall ON DELETE CASCADE,
  beleg_typ         TEXT NOT NULL,
  quelle            TEXT,
  pdf_pfad          TEXT,
  pdf_sha256        BYTEA,
  abgerufen_am      TIMESTAMPTZ,
  uebermittelt_am   TIMESTAMPTZ,
  uebernommen       BOOLEAN,
  raw_text          TEXT,
  raw_tables_json   JSONB,
  UNIQUE (fall_id, pdf_sha256)
);

CREATE TABLE extraktion (
  extraktion_id     BIGSERIAL PRIMARY KEY,
  fall_id           BIGINT NOT NULL REFERENCES fall ON DELETE CASCADE,
  beleg_id          BIGINT REFERENCES beleg,
  feld_id           BIGINT REFERENCES feld,
  code              TEXT NOT NULL,
  person            TEXT,
  lfd_nr            INT,
  wert_raw          TEXT NOT NULL,
  wert_normalisiert TEXT,
  match_methode     TEXT,
  konfidenz         NUMERIC(4,3),
  src_page          INT,
  src_bbox          NUMERIC[],
  ocr_konfidenz     NUMERIC(4,3),
  validiert         BOOLEAN DEFAULT FALSE,
  validiert_durch   TEXT,
  bemerkung         TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (beleg_id, code, person, lfd_nr)
);
CREATE INDEX ix_extraktion_fall ON extraktion (fall_id, code);

CREATE TABLE validierung_lauf (
  lauf_id           BIGSERIAL PRIMARY KEY,
  fall_id           BIGINT NOT NULL REFERENCES fall ON DELETE CASCADE,
  eric_version      TEXT,
  modus             TEXT,
  ok                BOOLEAN,
  protokoll_xml     TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE validierung_meldung (
  meldung_id        BIGSERIAL PRIMARY KEY,
  lauf_id           BIGINT NOT NULL REFERENCES validierung_lauf ON DELETE CASCADE,
  regel_id          BIGINT REFERENCES regel,
  fehlercode        TEXT,
  schweregrad       TEXT,
  text              TEXT,
  feld_code         TEXT
);

-- ============================================================================
--  MATERIALIZED VIEWS — Lookup-Beschleuniger
-- ============================================================================

CREATE MATERIALIZED VIEW vw_zeile_to_code AS
SELECT a.vz, a.name AS anlage, k.pfad AS kontext_pfad,
       f.vordruckzeile, f.name AS code, f.drucktext,
       f.format_id, f.feld_id
  FROM feld f
  JOIN anlage a  ON a.anlage_id  = f.anlage_id
  LEFT JOIN kontext k ON k.kontext_id = f.kontext_id
 WHERE f.ist_ecode AND f.vordruckzeile IS NOT NULL AND f.vordruckzeile <> '';
CREATE INDEX ix_vw_zeile ON vw_zeile_to_code (vz, anlage, vordruckzeile);

CREATE MATERIALIZED VIEW vw_lstb_nr_to_code AS
SELECT a.vz, a.name AS anlage,
       (regexp_matches(f.drucktext,
        'laut\s+Nr\.\s*(\d+\s*[ab]?)\s*der\s+Lohnsteuerbescheinigung'))[1] AS lstb_nr,
       f.name AS code, f.drucktext, f.feld_id
  FROM feld f
  JOIN anlage a ON a.anlage_id = f.anlage_id
 WHERE f.ist_ecode AND f.drucktext ~ 'Lohnsteuerbescheinigung';
CREATE INDEX ix_vw_lstb ON vw_lstb_nr_to_code (vz, lstb_nr);

CREATE MATERIALIZED VIEW vw_sb_kz_to_code AS
SELECT a.vz, k.sachbereich, k.kennzahl, k.lfd_nr_vordruck,
       f.name AS code, f.drucktext, a.name AS anlage, f.feld_id
  FROM kennzahl k
  JOIN feld f   ON f.feld_id   = k.feld_id
  JOIN anlage a ON a.anlage_id = f.anlage_id;
CREATE INDEX ix_vw_sb_kz ON vw_sb_kz_to_code (vz, sachbereich, kennzahl);
