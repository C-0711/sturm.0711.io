#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run_all.sh — Komplette Katalog-Pipeline: Schema → XSD → Jahresdok → Views
#
# Voraussetzungen:
#   - Postgres 15+ läuft
#   - Datenbank "elster_catalog" existiert oder wird angelegt
#   - Python 3.10+, psycopg[binary], lxml installiert (siehe requirements.txt)
#   - ENV vars CTAX_XSD und CTAX_JAHRESDOK gesetzt (oder Defaults darunter)
#
# Aufruf:
#   bash run_all.sh                      # mit Defaults
#   PGURI=... bash run_all.sh            # eigene DB
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

: "${PGURI:=postgresql:///elster_catalog}"
: "${VZ:=2024}"
: "${CTAX_XSD:=$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/0711-CTAXpro/Falldaten/test_suite/Taxcatalog_Elster/E10-2024.xsd}"
: "${CTAX_JAHRESDOK:=$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/0711-CTAXpro/Falldaten/test_suite/Taxcatalog_Elster/Jahresdokumentation_10_2024 1.xml}"

echo "DSN:           $PGURI"
echo "VZ:            $VZ"
echo "XSD:           $CTAX_XSD"
echo "Jahresdok:     $CTAX_JAHRESDOK"
echo ""

# 0. Datenbank anlegen (idempotent)
DB_NAME="${PGURI##*/}"
if ! psql -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
  echo "[00] CREATE DATABASE $DB_NAME"
  createdb "$DB_NAME"
fi

# 1. Schema einspielen (DROP SCHEMA elster CASCADE im DDL — vorsicht!)
echo "[00] Schema applizieren"
psql "$PGURI" -v ON_ERROR_STOP=1 -f schema.sql

# 2. XSD Typen + Enumerationen
python3 load_01_xsd_types.py --xsd "$CTAX_XSD" --dsn "$PGURI" --vz "$VZ"

# 3. XSD E-Codes seed
python3 load_02_xsd_codes.py --xsd "$CTAX_XSD" --dsn "$PGURI" --vz "$VZ"

# 4. Jahresdokumentation (anreichern)
python3 load_03_jahresdok.py --jahresdok "$CTAX_JAHRESDOK" --dsn "$PGURI" --vz "$VZ"

# 5. Materialized Views
python3 load_04_views.py --dsn "$PGURI"

echo ""
echo "Done. Sanity-Check:"
psql "$PGURI" -c "
SELECT 'anlage'        AS t, COUNT(*) FROM elster.anlage UNION ALL
SELECT 'kontext',          COUNT(*) FROM elster.kontext UNION ALL
SELECT 'format_typ',       COUNT(*) FROM elster.format_typ UNION ALL
SELECT 'enumeration_typ',  COUNT(*) FROM elster.enumeration_typ UNION ALL
SELECT 'enumeration_wert', COUNT(*) FROM elster.enumeration_wert UNION ALL
SELECT 'feld',             COUNT(*) FROM elster.feld UNION ALL
SELECT 'feld (E-Codes)',   COUNT(*) FROM elster.feld WHERE ist_ecode UNION ALL
SELECT 'regel',            COUNT(*) FROM elster.regel UNION ALL
SELECT 'regel_feld',       COUNT(*) FROM elster.regel_feld UNION ALL
SELECT 'kennzahl',         COUNT(*) FROM elster.kennzahl UNION ALL
SELECT 'drucktext',        COUNT(*) FROM elster.drucktext UNION ALL
SELECT 'vw_zeile_to_code', COUNT(*) FROM elster.vw_zeile_to_code UNION ALL
SELECT 'vw_lstb_nr_to_code',  COUNT(*) FROM elster.vw_lstb_nr_to_code UNION ALL
SELECT 'vw_sb_kz_to_code', COUNT(*) FROM elster.vw_sb_kz_to_code;
"
