#!/usr/bin/env python3
"""
load_05_benutzerdef_typen.py — Worksheet "Benutzerdefinierte Typen" aus der
Jahresdokumentation in format_typ, enumeration_typ, enumeration_wert befüllen.

Quelle: Jahresdokumentation_10_2024 1.xml, Sheet "Benutzerdefinierte Typen"
Spalten: Name | Version | Beschreibung | Format | Min. Länge | Max. Länge |
         Wird verwendet von | Änderungsinformation | Änderungsdetails

Format-Spalte enthält entweder
  - einen Format-Bezeichner (z.B. "IBAN", "BIC", "IDNr") → nur format_typ
  - "NichtAbgeschlosseneEnumeration\\n - Wert1\\n - Wert2..." → format_typ
    + enumeration_typ + enumeration_wert
  - "AbgeschlosseneEnumeration\\n - Wert1..." → analog
"""
from __future__ import annotations
import argparse, os, sys
from pathlib import Path

import lxml.etree as ET
import psycopg
from psycopg.rows import dict_row

SSNS = "urn:schemas-microsoft-com:office:spreadsheet"
def ssns(tag): return f"{{{SSNS}}}{tag}"

SHEET_NAME = "Benutzerdefinierte Typen"
ENUM_PREFIXES = (
    "NichtAbgeschlosseneEnumeration",
    "AbgeschlosseneEnumeration",
    "Enumeration",
)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--jahresdok", required=True)
    p.add_argument("--dsn", default=os.environ.get("PGURI", "postgresql:///elster_catalog"))
    p.add_argument("--vz", type=int, default=2024)
    return p.parse_args()


def find_sheet(root, name):
    for ws in root.iter(ssns("Worksheet")):
        if ws.get(ssns("Name")) == name:
            return ws
    return None


def cells_of(row):
    out = []
    cur = 0
    for c in row.findall(ssns("Cell")):
        idx = c.get(ssns("Index"))
        if idx:
            idx = int(idx) - 1
            while cur < idx:
                out.append(None); cur += 1
        d = c.find(ssns("Data"))
        out.append(d.text if d is not None else None)
        cur += 1
    return out


def parse_format_cell(text: str):
    """Returns (is_enum, base_format, values).
    values is list[str] for enums, [] otherwise."""
    if not text:
        return False, None, []
    is_enum = text.startswith(ENUM_PREFIXES) or "\n - " in text
    if is_enum:
        lines = text.split("\n")
        head = lines[0].strip() or "Enumeration"
        values = []
        for ln in lines[1:]:
            ln = ln.strip()
            if ln.startswith("- "):
                # Wert kann sein "1" oder "1 [Label]" oder "PersonA [Label]"
                v = ln[2:].strip()
                values.append(v.split(" [", 1)[0].strip() if " [" in v else v)
            elif ln.startswith("-"):
                v = ln[1:].strip()
                values.append(v.split(" [", 1)[0].strip() if " [" in v else v)
        return True, head, values
    return False, text.strip(), []


def to_int(x):
    if x is None or x == "":
        return None
    try:
        return int(x)
    except (ValueError, TypeError):
        return None


def main():
    args = parse_args()
    xml_path = Path(args.jahresdok).expanduser().resolve()
    print(f"[05] Jahresdok: {xml_path}", file=sys.stderr)

    parser = ET.XMLParser(huge_tree=True)
    tree = ET.parse(str(xml_path), parser=parser)
    sheet = find_sheet(tree.getroot(), SHEET_NAME)
    if sheet is None:
        print(f"[05] FEHLER: Sheet '{SHEET_NAME}' nicht gefunden", file=sys.stderr)
        sys.exit(1)

    table = sheet.find(ssns("Table"))
    rows = table.findall(ssns("Row"))
    print(f"[05] Zeilen im Sheet: {len(rows)} (inkl. Header)", file=sys.stderr)

    # Header bestimmt Spalten-Indizes; defensiv per Name suchen.
    header = [c or "" for c in cells_of(rows[0])]
    def col(name_substr):
        for i, h in enumerate(header):
            if h and name_substr.lower() in h.lower():
                return i
        return None
    i_name = col("Name")
    i_desc = col("Beschreibung")
    i_fmt  = col("Format")
    i_min  = col("Min")
    i_max  = col("Max")
    if None in (i_name, i_fmt):
        print(f"[05] FEHLER: Spalten Name/Format nicht gefunden in {header}", file=sys.stderr)
        sys.exit(2)

    format_rows = []        # (vz, name, kanonisch, min_l, max_l, vk, nk, regex, base_xsd, beschr)
    enum_typ_rows = []      # (vz, name, beschreibung)  → format_id via lookup
    enum_wert_rows = []     # (type_name, wert, label, sort_order)

    for r in rows[1:]:
        c = cells_of(r)
        if len(c) <= i_name or not c[i_name]:
            continue
        name = c[i_name].strip()
        beschr = (c[i_desc] or "").strip() if i_desc is not None else None
        fmt_text = c[i_fmt] if i_fmt is not None and i_fmt < len(c) else None
        min_l = to_int(c[i_min]) if i_min is not None and i_min < len(c) else None
        max_l = to_int(c[i_max]) if i_max is not None and i_max < len(c) else None

        is_enum, base_fmt, values = parse_format_cell(fmt_text or "")
        if is_enum:
            kanonisch = "enum"
        elif base_fmt and ("\n" in base_fmt or len(base_fmt) > 60):
            # Lange Klartext-Definitionen (z.B. "String mit Muster '...'") nicht
            # roh als kanonisch übernehmen — auf generische Klasse abbilden.
            kanonisch = "string_pattern" if "Muster" in base_fmt else "string"
        else:
            kanonisch = base_fmt or "string"

        format_rows.append((
            args.vz, name, kanonisch, min_l, max_l, None, None,
            None,                   # regex unbekannt aus Sheet
            base_fmt,               # base_xsd: hier wir nutzen base_fmt als Label
            beschr,
        ))
        if is_enum:
            enum_typ_rows.append((args.vz, name, beschr))
            for i, v in enumerate(values):
                enum_wert_rows.append((name, v, v, i))

    print(f"[05] format_typ:        +{len(format_rows)} Zeilen (UPSERT)", file=sys.stderr)
    print(f"[05] enumeration_typ:   +{len(enum_typ_rows)} Zeilen (UPSERT)", file=sys.stderr)
    print(f"[05] enumeration_wert:  +{len(enum_wert_rows)} Zeilen (replace)", file=sys.stderr)

    conn = psycopg.connect(args.dsn, autocommit=False, row_factory=dict_row)
    cur = conn.cursor()
    cur.execute("SET search_path = elster, public")

    cur.executemany("""
        INSERT INTO format_typ (vz, xsd_type_name, kanonisch, min_laenge, max_laenge,
                                max_vorkomma, max_nachkomma, regex, base_xsd, beschreibung)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (vz, xsd_type_name) DO UPDATE
          SET kanonisch    = EXCLUDED.kanonisch,
              min_laenge   = COALESCE(EXCLUDED.min_laenge,  format_typ.min_laenge),
              max_laenge   = COALESCE(EXCLUDED.max_laenge,  format_typ.max_laenge),
              base_xsd     = COALESCE(EXCLUDED.base_xsd,    format_typ.base_xsd),
              beschreibung = COALESCE(EXCLUDED.beschreibung,format_typ.beschreibung)
    """, format_rows)

    # FK von enumeration_typ.format_id auflösen
    cur.execute("SELECT format_id, xsd_type_name FROM format_typ WHERE vz=%s", (args.vz,))
    fid_by_name = {r["xsd_type_name"]: r["format_id"] for r in cur.fetchall()}

    enum_typ_payload = [
        (fid_by_name.get(n), vz, n, b)
        for (vz, n, b) in enum_typ_rows
    ]
    cur.executemany("""
        INSERT INTO enumeration_typ (format_id, vz, name, beschreibung)
        VALUES (%s,%s,%s,%s)
        ON CONFLICT (vz, name) DO UPDATE
          SET format_id    = COALESCE(EXCLUDED.format_id, enumeration_typ.format_id),
              beschreibung = COALESCE(EXCLUDED.beschreibung, enumeration_typ.beschreibung)
    """, enum_typ_payload)

    # Werte ersetzen, aber nur für die in diesem Loader neu angelegten Typen
    type_names = tuple({n for (_, n, _) in enum_typ_rows})
    if type_names:
        cur.execute(
            "SELECT enum_typ_id, name FROM enumeration_typ WHERE vz=%s AND name = ANY(%s)",
            (args.vz, list(type_names)),
        )
        eid_by_name = {r["name"]: r["enum_typ_id"] for r in cur.fetchall()}
        cur.execute(
            "DELETE FROM enumeration_wert WHERE enum_typ_id = ANY(%s)",
            (list(eid_by_name.values()),),
        )
        wert_payload = [
            (eid_by_name[n], w, lbl, so)
            for (n, w, lbl, so) in enum_wert_rows
            if n in eid_by_name
        ]
        cur.executemany(
            "INSERT INTO enumeration_wert (enum_typ_id, wert, label_de, sort_order) "
            "VALUES (%s,%s,%s,%s)",
            wert_payload,
        )

    conn.commit()
    conn.close()
    print("[05] OK", file=sys.stderr)


if __name__ == "__main__":
    main()
