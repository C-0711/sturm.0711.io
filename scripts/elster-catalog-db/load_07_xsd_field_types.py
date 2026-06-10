#!/usr/bin/env python3
"""
load_07_xsd_field_types.py — feld.format_id für E-Codes auf den echten
XSD-Typ (inklusive Regex) umlinken.

Hintergrund:
  Im XSD ist jedes E-Code-Element typisiert:
    <xs:element name="E0200204" type="DezimalzahlNichtNegOhneFuehrNull_MaxVK12_MinNK2_MaxNK2_CType_RABE"/>
  Das Suffix "_RABE" markiert die Variante mit RABE-Attribut (xs:attribute).
  In format_typ liegen die Typ-Definitionen unter dem Namen OHNE _RABE (aus
  load_01). load_06 hat die FK auf synthetische Klartext-Typen gesetzt; dieser
  Loader ersetzt das durch echte XSD-FKs für alle E-Codes.

Nicht-E-Code-Felder (Index-Helfer, Wiederholungszähler) bleiben unangetastet.
"""
from __future__ import annotations
import argparse, os, re, sys
from pathlib import Path

import lxml.etree as ET
import psycopg
from psycopg.rows import dict_row

XS = "http://www.w3.org/2001/XMLSchema"
E_CODE = re.compile(r"^E\d{7,8}$")
RABE_SUFFIX = "_RABE"


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--xsd", required=True)
    p.add_argument("--dsn", default=os.environ.get("PGURI", "postgresql:///elster_catalog"))
    p.add_argument("--vz", type=int, default=2024)
    p.add_argument("--cleanup-orphans", action="store_true",
                   help="Synthetische format_typ-Zeilen ohne feld-Verweis nach UPDATE löschen.")
    return p.parse_args()


def collect_ecode_types(root):
    """Walk all xs:element with name='E\\d{7,8}' and a type attribute.
    Strip namespace prefix and _RABE suffix. Return {ecode: xsd_type_name}."""
    mapping: dict[str, str] = {}
    conflicts = 0
    for el in root.iter(f"{{{XS}}}element"):
        name = el.get("name")
        if not name or not E_CODE.match(name):
            continue
        t = el.get("type")
        if not t:
            continue
        # Strip xs:-Präfix, falls vorhanden
        if ":" in t:
            t = t.split(":", 1)[1]
        # _RABE entfernen
        base = t[:-len(RABE_SUFFIX)] if t.endswith(RABE_SUFFIX) else t
        if name in mapping and mapping[name] != base:
            conflicts += 1
        mapping[name] = base
    return mapping, conflicts


def main():
    args = parse_args()
    xsd_path = Path(args.xsd).expanduser().resolve()
    print(f"[07] XSD: {xsd_path}", file=sys.stderr)

    tree = ET.parse(str(xsd_path), parser=ET.XMLParser(huge_tree=True))
    ecode_to_type, conflicts = collect_ecode_types(tree.getroot())
    print(f"[07] E-Code → XSD-Typ Mapping: {len(ecode_to_type)} (Konflikte: {conflicts})", file=sys.stderr)

    conn = psycopg.connect(args.dsn, autocommit=False, row_factory=dict_row)
    cur = conn.cursor()
    cur.execute("SET search_path = elster, public")

    cur.execute("SELECT format_id, xsd_type_name FROM format_typ WHERE vz=%s", (args.vz,))
    fid_by_name = {r["xsd_type_name"]: r["format_id"] for r in cur.fetchall()}

    # Gruppieren: pro Ziel-format_id sammeln wir die E-Codes
    by_target: dict[int, list[str]] = {}
    missing_types: dict[str, int] = {}
    for ecode, xt in ecode_to_type.items():
        fid = fid_by_name.get(xt)
        if fid is None:
            missing_types[xt] = missing_types.get(xt, 0) + 1
            continue
        by_target.setdefault(fid, []).append(ecode)

    print(f"[07] Typen mit FK-Match: {len(by_target)} → {sum(len(v) for v in by_target.values())} E-Codes", file=sys.stderr)
    if missing_types:
        print(f"[07] Typen ohne FK-Match: {len(missing_types)} ({sum(missing_types.values())} E-Codes)", file=sys.stderr)
        for t, n in sorted(missing_types.items(), key=lambda x: -x[1])[:5]:
            print(f"[07]   - {t}: {n} E-Codes", file=sys.stderr)

    # Vor-Stand
    cur.execute("""
        SELECT count(*) FILTER (WHERE ist_ecode) AS ecodes,
               count(DISTINCT format_id) FILTER (WHERE ist_ecode) AS distinkte_typen_vorher
          FROM feld
    """)
    before = cur.fetchone()
    print(f"[07] vor: {before['ecodes']} E-Codes, "
          f"{before['distinkte_typen_vorher']} distinkte Typen referenziert", file=sys.stderr)

    total_updated = 0
    for fid, ecodes in by_target.items():
        cur.execute(
            "UPDATE feld SET format_id=%s WHERE ist_ecode AND name = ANY(%s)",
            (fid, ecodes),
        )
        total_updated += cur.rowcount
    print(f"[07] feld-Rows aktualisiert: {total_updated}", file=sys.stderr)

    # Nach-Stand
    cur.execute("""
        SELECT count(DISTINCT format_id) FILTER (WHERE ist_ecode) AS distinkte_typen_nachher,
               count(*) FILTER (WHERE ist_ecode AND format_id IS NULL) AS ecodes_ohne_fk
          FROM feld
    """)
    after = cur.fetchone()
    print(f"[07] nach: {after['distinkte_typen_nachher']} distinkte Typen, "
          f"{after['ecodes_ohne_fk']} E-Codes ohne FK", file=sys.stderr)

    # Regex-Vererbung: format_typ.base_xsd → parent.regex
    cur.execute("""
        UPDATE format_typ child
           SET regex = parent.regex
          FROM format_typ parent
         WHERE child.regex IS NULL
           AND parent.regex IS NOT NULL
           AND child.base_xsd = parent.xsd_type_name
           AND child.vz = parent.vz
           AND child.vz = %s
    """, (args.vz,))
    print(f"[07] Regex von base_xsd geerbt: {cur.rowcount} format_typ-Zeilen", file=sys.stderr)

    # Coverage über Regex
    cur.execute("""
        SELECT count(*) FILTER (WHERE ist_ecode AND ft.regex IS NOT NULL) AS mit_regex,
               count(*) FILTER (WHERE ist_ecode)                          AS gesamt_ecodes
          FROM feld f LEFT JOIN format_typ ft USING (format_id)
    """)
    rx = cur.fetchone()
    print(f"[07] E-Codes mit Regex via FK: {rx['mit_regex']}/{rx['gesamt_ecodes']}", file=sys.stderr)

    # Coverage über Enum (für Felder ohne Regex aber mit Werteliste)
    cur.execute("""
        SELECT count(DISTINCT f.feld_id)
          FROM feld f JOIN format_typ ft USING (format_id)
          JOIN enumeration_typ et ON et.format_id = ft.format_id
         WHERE f.ist_ecode AND ft.regex IS NULL
    """)
    enum_cov = cur.fetchone()["count"]
    print(f"[07] E-Codes ohne Regex aber mit Enum-Werteliste: {enum_cov}", file=sys.stderr)
    print(f"[07] Validierbare E-Codes gesamt: {rx['mit_regex'] + enum_cov}/{rx['gesamt_ecodes']}", file=sys.stderr)

    if args.cleanup_orphans:
        cur.execute("""
            DELETE FROM format_typ
             WHERE vz = %s
               AND format_id NOT IN (SELECT DISTINCT format_id FROM feld WHERE format_id IS NOT NULL)
               AND xsd_type_name NOT LIKE '%%CType'
               AND xsd_type_name NOT LIKE '%%BaseCType'
               AND xsd_type_name NOT IN (SELECT name FROM enumeration_typ WHERE vz = %s)
        """, (args.vz, args.vz))
        print(f"[07] verwaiste synthetische Typen gelöscht: {cur.rowcount}", file=sys.stderr)

    conn.commit()
    conn.close()
    print("[07] OK", file=sys.stderr)


if __name__ == "__main__":
    main()
