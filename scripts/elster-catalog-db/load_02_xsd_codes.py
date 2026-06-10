#!/usr/bin/env python3
"""
load_02_xsd_codes.py — E-Codes aus E10-2024.xsd extrahieren und in `feld` seeden.

Strategie:
- Walk durch <xs:element name="E\\d{7,8}">.
- Anlage aus FF-Prefix ableiten (E02 = N, E01 = ESt1A, …).
- Kontextpfad aus complexType-Verschachtelung (best-effort).
- format_id über simpleType-Lookup verknüpfen.

WICHTIG: Diese Datei seed't Felder rein aus XSD-Sicht. load_03_jahresdok.py
reichert sie anschließend mit den offiziellen Drucktext/Vordruckzeile/Regel-
Daten an (UPSERT auf (anlage_id, kontext_id, name)).
"""
from __future__ import annotations
import argparse, os, re, sys
from collections import defaultdict
from pathlib import Path

import lxml.etree as ET
import psycopg
from psycopg.rows import dict_row

XS = "http://www.w3.org/2001/XMLSchema"
NS = {"xs": XS}
CODE_RE = re.compile(r"^E\d{7,8}$")

# FF-Prefix → Anlage-Name (gemäß Schema-Analyse)
FF_TO_ANLAGE = {
    "01": "ESt1A", "02": "N",     "03": "N",       "04": "AgB",
    "05": "Kind",  "06": "SA",    "07": "VOR",     "08": "AV",
    "09": "L",     "18": "AUS",   "19": "KAP",     "20": "R",
    "21": "ESt1A_U", "26": "AgB",
}

def fid_for_type(fid_by_name, t: str | None):
    if not t: return None
    # XSD type names sometimes have inline prefix; strip "xs:" or ns prefix
    if ":" in t: t = t.split(":", 1)[1]
    # Strip "_RABE" alias suffix
    base = t[:-5] if t.endswith("_RABE") else t
    return fid_by_name.get(base) or fid_by_name.get(t)

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--xsd", required=True)
    p.add_argument("--dsn", default=os.environ.get("PGURI", "postgresql:///elster_catalog"))
    p.add_argument("--vz", type=int, default=2024)
    return p.parse_args()

def main():
    args = parse_args()
    xsd_path = Path(args.xsd).expanduser().resolve()
    tree = ET.parse(str(xsd_path))
    root = tree.getroot()

    conn = psycopg.connect(args.dsn, autocommit=False, row_factory=dict_row)
    cur = conn.cursor()
    cur.execute("SET search_path = elster, public")

    cur.execute("SELECT format_id, xsd_type_name FROM format_typ WHERE vz=%s", (args.vz,))
    fid_by_name = {r["xsd_type_name"]: r["format_id"] for r in cur.fetchall()}

    # ── Anlagen aus FF-Prefix seeden (werden in 03 überschrieben/ergänzt) ─
    cur.execute("SELECT anlage_id, name FROM anlage WHERE vz=%s", (args.vz,))
    anlage_id_by_name = {r["name"]: r["anlage_id"] for r in cur.fetchall()}

    needed = set(FF_TO_ANLAGE.values())
    missing = needed - set(anlage_id_by_name)
    for nm in missing:
        # FF-Prefix für diese Anlage finden (erste in der Reihenfolge)
        ff = next((k for k, v in FF_TO_ANLAGE.items() if v == nm), None)
        cur.execute("""
            INSERT INTO anlage (vz, name, ff_prefix)
            VALUES (%s,%s,%s)
            ON CONFLICT (vz, name) DO NOTHING
            RETURNING anlage_id
        """, (args.vz, nm, ff))
        row = cur.fetchone()
        if row: anlage_id_by_name[nm] = row["anlage_id"]
    cur.execute("SELECT anlage_id, name FROM anlage WHERE vz=%s", (args.vz,))
    anlage_id_by_name = {r["name"]: r["anlage_id"] for r in cur.fetchall()}

    # ── Walk: für jeden <xs:element name="E..."> Kontextpfad aus Vorfahren-
    #   complexType-Namen ableiten. Wir bauen das via parent map.
    parent_map = {c: p for p in root.iter() for c in p}

    def ancestor_ctype_chain(el):
        chain = []
        cur_el = parent_map.get(el)
        while cur_el is not None:
            tag = ET.QName(cur_el).localname
            if tag == "complexType":
                cname = cur_el.get("name")
                if cname:
                    # Strip "_CType" / "_67907_CType" suffixes for path
                    short = re.sub(r"(_\d+)?_CType$", "", cname)
                    chain.append(short)
            elif tag == "element":
                n = cur_el.get("name")
                if n: chain.append(n)
            cur_el = parent_map.get(cur_el)
        return list(reversed(chain))

    feld_rows = []
    for el in root.iter(f"{{{XS}}}element"):
        name = el.get("name") or ""
        if not CODE_RE.match(name): continue
        ff = name[1:3]
        anlage = FF_TO_ANLAGE.get(ff)
        if not anlage: continue
        anlage_id = anlage_id_by_name.get(anlage)
        if not anlage_id: continue

        chain = ancestor_ctype_chain(el)
        # Drop the root chain entry (likely "E10" or schema-root) — keep what's
        # below the anlage.
        try:
            i = chain.index(anlage)
            inner = chain[i+1:]
        except ValueError:
            inner = chain
        pfad = "/" + anlage + ("/" + "/".join(inner) if inner else "")

        # Kontext upsert
        cur.execute("""
            INSERT INTO kontext (anlage_id, pfad)
            VALUES (%s,%s)
            ON CONFLICT (anlage_id, pfad) DO UPDATE SET pfad = EXCLUDED.pfad
            RETURNING kontext_id
        """, (anlage_id, pfad))
        kontext_id = cur.fetchone()["kontext_id"]

        doc_el = el.find(f"{{{XS}}}annotation/{{{XS}}}documentation")
        drucktext = (doc_el.text or "").strip() if doc_el is not None else None

        feld_rows.append((
            anlage_id, kontext_id, name, True,
            drucktext,                                # beschreibung (XSD-Doc als Fallback)
            fid_for_type(fid_by_name, el.get("type")),
            el.get("type"),                           # format_label (roher type)
            None,                                     # format_regex — kommt aus Jahresdok
        ))

    cur.executemany("""
        INSERT INTO feld (anlage_id, kontext_id, name, ist_ecode,
                          beschreibung, format_id, format_label, format_regex)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (anlage_id, kontext_id, name) DO UPDATE
          SET ist_ecode=EXCLUDED.ist_ecode,
              beschreibung=COALESCE(EXCLUDED.beschreibung, feld.beschreibung),
              format_id=COALESCE(EXCLUDED.format_id, feld.format_id),
              format_label=COALESCE(EXCLUDED.format_label, feld.format_label)
    """, feld_rows)
    print(f"[02] feld (XSD-seed):   {len(feld_rows)} Zeilen", file=sys.stderr)

    conn.commit()
    conn.close()
    print(f"[02] OK", file=sys.stderr)

if __name__ == "__main__":
    main()
