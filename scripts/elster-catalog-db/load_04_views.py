#!/usr/bin/env python3
"""
load_04_views.py — Materialized Views nach dem Laden refreshen.

REFRESH MATERIALIZED VIEW (non-CONCURRENTLY beim Erstbefüllen, da UNIQUE-Indizes
für CONCURRENTLY nicht garantiert sind).
"""
from __future__ import annotations
import argparse, os, sys
import psycopg

VIEWS = ["vw_zeile_to_code", "vw_lstb_nr_to_code", "vw_sb_kz_to_code"]

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", default=os.environ.get("PGURI", "postgresql:///elster_catalog"))
    args = p.parse_args()

    with psycopg.connect(args.dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("SET search_path = elster, public")
        for v in VIEWS:
            print(f"[04] REFRESH MATERIALIZED VIEW elster.{v} ...", file=sys.stderr)
            cur.execute(f"REFRESH MATERIALIZED VIEW elster.{v}")
            cur.execute(f"SELECT COUNT(*) FROM elster.{v}")
            cnt = cur.fetchone()[0]
            print(f"       {v}: {cnt} Zeilen", file=sys.stderr)
    print("[04] OK", file=sys.stderr)

if __name__ == "__main__":
    main()
