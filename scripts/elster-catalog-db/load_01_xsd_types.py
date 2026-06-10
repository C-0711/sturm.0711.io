#!/usr/bin/env python3
"""
load_01_xsd_types.py — XSD parsen, format_typ + enumeration_typ + enumeration_wert befüllen.

Wichtig: in E10-2024.xsd sind fast alle "Typen" als <xs:complexType> mit
<xs:simpleContent><xs:restriction> definiert (nicht als <xs:simpleType>).
Wir behandeln beide.

Quelle: E10-2024.xsd
Befüllt: elster.vz, elster.format_typ, elster.enumeration_typ, elster.enumeration_wert
"""
from __future__ import annotations
import argparse, os, re, sys
from pathlib import Path

import lxml.etree as ET
import psycopg
from psycopg.rows import dict_row

XS = "http://www.w3.org/2001/XMLSchema"

# ── Canonical typing aus XSD-Type-Namen ────────────────────────────────────
PATTERNS = [
    (re.compile(r"^IDNr"),                      "idnr"),
    (re.compile(r"^Steuernummer"),              "steuernummer"),
    (re.compile(r"^BIC"),                       "bic"),
    (re.compile(r"^Datum.*JJJJ"),               "date"),
    (re.compile(r"^Datum.*MM"),                 "date_partial"),
    (re.compile(r"^DatumBereich"),              "daterange"),
    (re.compile(r"^Ja1"),                       "bool_ja1"),
    (re.compile(r"^JaX"),                       "bool_jax"),
    (re.compile(r"^Enum_"),                     "enum"),
    (re.compile(r"^Dezimal.*NK2"),              "decimal_eur_cent"),
    (re.compile(r"^Dezimal"),                   "decimal"),
    (re.compile(r"^Ganzzahl.*NichtNeg"),        "int_nn_euro"),
    (re.compile(r"^Ganzzahl"),                  "int_euro"),
    (re.compile(r"^String"),                    "string"),
]
def kanonisch(xsd_type: str) -> str:
    for rx, k in PATTERNS:
        if rx.match(xsd_type): return k
    return "string"

NUM_REX_VK = re.compile(r"MaxVK(\d+)")
NUM_REX_NK = re.compile(r"MaxNK(\d+)")
LEN_REX_MIN = re.compile(r"MinL(\d+)")
LEN_REX_MAX = re.compile(r"MaxL(\d+)")

def parse_lengths(xsd_type: str):
    vk = NUM_REX_VK.search(xsd_type); nk = NUM_REX_NK.search(xsd_type)
    mn = LEN_REX_MIN.search(xsd_type); mx = LEN_REX_MAX.search(xsd_type)
    return (
        int(mn.group(1)) if mn else None,
        int(mx.group(1)) if mx else None,
        int(vk.group(1)) if vk else None,
        int(nk.group(1)) if nk else None,
    )

# ── XSD-Walker ─────────────────────────────────────────────────────────────
def restriction_of(el):
    """Find the relevant xs:restriction inside a simpleType OR complexType/simpleContent."""
    # simpleType: direct child
    r = el.find(f"{{{XS}}}restriction")
    if r is not None: return r
    # complexType/simpleContent/restriction
    sc = el.find(f"{{{XS}}}simpleContent")
    if sc is not None:
        return sc.find(f"{{{XS}}}restriction")
    return None

def doc_of(el):
    d = el.find(f"{{{XS}}}annotation/{{{XS}}}documentation")
    return (d.text or "").strip() if d is not None else None

def iter_named_types(root):
    """Yield (name, element) for every named simpleType and complexType."""
    for tag in (f"{{{XS}}}simpleType", f"{{{XS}}}complexType"):
        for el in root.iter(tag):
            name = el.get("name")
            if name: yield name, el

# ── Main ───────────────────────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--xsd", required=True)
    p.add_argument("--dsn", default=os.environ.get("PGURI", "postgresql:///elster_catalog"))
    p.add_argument("--vz", type=int, default=2024)
    return p.parse_args()

def main():
    args = parse_args()
    xsd_path = Path(args.xsd).expanduser().resolve()
    print(f"[01] XSD: {xsd_path}", file=sys.stderr)
    tree = ET.parse(str(xsd_path))
    root = tree.getroot()
    target_ns = root.get("targetNamespace", "")

    conn = psycopg.connect(args.dsn, autocommit=False, row_factory=dict_row)
    cur = conn.cursor()
    cur.execute("SET search_path = elster, public")

    # ── 1. vz row ──────────────────────────────────────────────────────────
    cur.execute("""
        INSERT INTO vz (vz, datenart, schema_namespace, xsd_quelle)
        VALUES (%s, 'E10', %s, %s)
        ON CONFLICT (vz) DO UPDATE
          SET schema_namespace = EXCLUDED.schema_namespace,
              xsd_quelle       = EXCLUDED.xsd_quelle,
              imported_at      = now()
    """, (args.vz, target_ns, str(xsd_path)))

    # ── 2. format_typ: alle named simple/complex Types mit Restriction ────
    format_rows = []
    enum_buffer = []  # (type_name, value, label, order)
    seen = set()
    for name, el in iter_named_types(root):
        if name in seen: continue
        seen.add(name)
        r = restriction_of(el)
        if r is None: continue
        base = r.get("base")
        pat = r.find(f"{{{XS}}}pattern")
        regex = pat.get("value") if pat is not None else None
        mn, mx, vk, nk = parse_lengths(name)
        format_rows.append((args.vz, name, kanonisch(name), mn, mx, vk, nk, regex, base, doc_of(el)))

        # Enums (auch innerhalb complexType/simpleContent/restriction)
        if name.startswith("Enum_") or r.find(f"{{{XS}}}enumeration") is not None:
            for i, e in enumerate(r.findall(f"{{{XS}}}enumeration")):
                wert = e.get("value")
                label = doc_of(e)
                enum_buffer.append((name, wert, label, i))

    cur.executemany("""
        INSERT INTO format_typ (vz, xsd_type_name, kanonisch, min_laenge, max_laenge,
                                max_vorkomma, max_nachkomma, regex, base_xsd, beschreibung)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (vz, xsd_type_name) DO UPDATE
          SET kanonisch=EXCLUDED.kanonisch, regex=EXCLUDED.regex,
              base_xsd=EXCLUDED.base_xsd, beschreibung=EXCLUDED.beschreibung
    """, format_rows)
    print(f"[01] format_typ:        {len(format_rows)} Zeilen", file=sys.stderr)

    # ── 3. enumeration_typ + enumeration_wert ─────────────────────────────
    cur.execute("SELECT format_id, xsd_type_name FROM format_typ WHERE vz=%s", (args.vz,))
    fid_by_name = {r["xsd_type_name"]: r["format_id"] for r in cur.fetchall()}

    # Enum-Typ-Rows ableiten aus den im Buffer auftretenden Typnamen
    enum_typ_seen = {n for (n, _, _, _) in enum_buffer}
    enum_typ_rows = [(fid_by_name.get(n), args.vz, n, None) for n in sorted(enum_typ_seen)]
    cur.executemany("""
        INSERT INTO enumeration_typ (format_id, vz, name, beschreibung)
        VALUES (%s,%s,%s,%s)
        ON CONFLICT (vz, name) DO UPDATE
          SET format_id=EXCLUDED.format_id
    """, enum_typ_rows)
    print(f"[01] enumeration_typ:   {len(enum_typ_rows)} Zeilen", file=sys.stderr)

    cur.execute("SELECT enum_typ_id, name FROM enumeration_typ WHERE vz=%s", (args.vz,))
    eid_by_name = {r["name"]: r["enum_typ_id"] for r in cur.fetchall()}
    cur.execute("""
        DELETE FROM enumeration_wert
         WHERE enum_typ_id IN (SELECT enum_typ_id FROM enumeration_typ WHERE vz=%s)
    """, (args.vz,))
    wert_rows = [(eid_by_name[n], w, l, i) for (n, w, l, i) in enum_buffer if n in eid_by_name]
    cur.executemany(
        "INSERT INTO enumeration_wert (enum_typ_id, wert, label_de, sort_order) VALUES (%s,%s,%s,%s)",
        wert_rows,
    )
    print(f"[01] enumeration_wert:  {len(wert_rows)} Zeilen", file=sys.stderr)

    conn.commit()
    conn.close()
    print(f"[01] OK", file=sys.stderr)

if __name__ == "__main__":
    main()
