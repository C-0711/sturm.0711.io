#!/usr/bin/env python3
"""
Parst die BMF-Jahresdokumentation (Excel-XML) und emittiert pro ELSTER-Anlage
eine Liste der E-Code-Feldeintraege mit: pflicht, format, format_regex,
min_len, max_len, vordruckzeile, drucktext, beschreibung, kontext.

Das ist die autoritative BMF-Quelle fuer Validierungsregeln — die XSD kennt
nur strukturelle Constraints, die Jahresdokumentation kennt die fachlichen.

Input:  /home/christoph.bertsch/CTAX/lanes/lane5_elster_export/data/elster_specs/Jahresdokumentation_10_2024 1.xml
Output: mistral-playground/public/elster_felder_2024.json

Output-Struktur:
  {
    "year": 2024,
    "anlagen_count": 35,
    "fields_count": 2275,
    "anlagen": {
      "ESt1A": {
        "felder": {
          "E0100001": {
            "kontext": "Art_Erkl",
            "name": "E0100001",
            "beschreibung": "Einkommensteuererklaerung",
            "max_zeilen": 1,
            "format": "Ja (X)",
            "format_regex": "X",
            "formatkennzeichen": "X",
            "min_laenge": null,
            "max_laenge": null,
            "pflicht": false,
            "pflicht_fehlertext": "",
            "indexfeld": "",
            "vordruckzeile": "1",
            "drucktext": "Einkommensteuererklaerung"
          },
          ...
        },
        "felder_count": 112
      },
      ...
    }
  }

Deterministisch. Kein LLM.
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

XML_PATH = Path("/home/christoph.bertsch/CTAX/lanes/lane5_elster_export/data/elster_specs/Jahresdokumentation_10_2024 1.xml")
OUT_PATH = Path(__file__).resolve().parent.parent / "public" / "elster_felder_2024.json"

NS = {
    "ss": "urn:schemas-microsoft-com:office:spreadsheet",
}

# Spaltennamen (aus dem Header-Row, 1-basiert)
COLUMNS = [
    "kontext",                # 1
    "name",                   # 2
    "beschreibung",           # 3
    "max_zeilen",             # 4
    "format",                 # 5
    "format_regex",           # 6
    "formatkennzeichen",      # 7
    "min_laenge",             # 8
    "max_laenge",             # 9
    "pflicht_raw",            # 10 — wird zu pflicht:bool
    "pflicht_fehlertext",     # 11
    "indexfeld",              # 12
    "vordruckzeile",          # 13
    "drucktext",              # 14
    "internes_eric",          # 15
    "zusatz_info",            # 16
    "annotationen",           # 17
    "aenderungsinfo",         # 18
    "aenderungsdetails",      # 19
]


def zell_text(cell) -> str:
    """Liest Daten-Text aus einer Cell. Gibt leeren String wenn keine Daten."""
    data = cell.find("ss:Data", NS)
    if data is None:
        return ""
    return (data.text or "").strip()


def parse_row(row) -> list[str]:
    """
    Excel-XML: Cells koennen via ss:Index leere Zellen ueberspringen.
    Wir normalisieren auf eine 19-Spalten-Liste mit leeren Strings fuer fehlende.
    """
    result = [""] * len(COLUMNS)
    pos = 0  # 0-basiert
    for cell in row.findall("ss:Cell", NS):
        idx_attr = cell.get(f"{{{NS['ss']}}}Index")
        if idx_attr:
            pos = int(idx_attr) - 1  # ss:Index ist 1-basiert
        if pos < len(result):
            result[pos] = zell_text(cell)
        pos += 1
    return result


def parse_anlage_felder(worksheet) -> dict:
    """Parst ein '<Anlage> - Felder' Worksheet. Gibt {e_code: eintrag} zurueck."""
    table = worksheet.find("ss:Table", NS)
    if table is None:
        return {}

    rows = table.findall("ss:Row", NS)
    if len(rows) < 2:
        return {}

    # Erste Row ist Header — wir haben oben eh hartkodiert, nur Sanity-Check.
    header = parse_row(rows[0])
    expected_first = ["Kontext", "Name", "Beschreibung"]
    for i, want in enumerate(expected_first):
        if not header[i].startswith(want[:6]):
            print(f"  ⚠ Unerwarteter Header: col{i+1}='{header[i]}' erwartet '{want}'", file=sys.stderr)

    felder = {}
    for row in rows[1:]:
        cells = parse_row(row)
        name = cells[1].strip()
        if not re.match(r"^E\d{7}$", name):
            # Leere Zeile oder anderer Content (selten)
            continue

        eintrag = {
            "kontext": cells[0],
            "name": name,
            "beschreibung": cells[2],
            "max_zeilen": _int_or_none(cells[3]),
            "format": cells[4],
            "format_regex": cells[5],
            "formatkennzeichen": cells[6],
            "min_laenge": _int_or_none(cells[7]),
            "max_laenge": _int_or_none(cells[8]),
            "pflicht": _parse_pflicht(cells[9]),
            "pflicht_fehlertext": cells[10],
            "indexfeld": cells[11],
            "vordruckzeile": cells[12],
            "drucktext": cells[13],
        }
        # Duplikate: wenn der gleiche E-Code mehrfach auftaucht (z.B. verschiedene
        # Kontexte in derselben Anlage), mergen wir konservativ: pflicht = ODER,
        # weil der Code dann irgendwo pflicht sein kann.
        if name in felder:
            bestehend = felder[name]
            if eintrag["pflicht"] and not bestehend["pflicht"]:
                bestehend["pflicht"] = True
                bestehend["pflicht_fehlertext"] = eintrag["pflicht_fehlertext"]
            # Kontexte sammeln (kommagetrennt fuer Debug)
            if eintrag["kontext"] and eintrag["kontext"] not in bestehend["kontext"]:
                bestehend["kontext"] = f"{bestehend['kontext']},{eintrag['kontext']}"
        else:
            felder[name] = eintrag

    return felder


def _int_or_none(s: str):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _parse_pflicht(s: str) -> bool:
    """
    Interpretiert die Pflichtfeld-Spalte. Leere Zelle = kein Pflicht.
    Sonst: alles was "Ja", "1", "X", "true" ist → Pflicht.
    """
    v = (s or "").strip().lower()
    if not v:
        return False
    return v in ("ja", "1", "x", "true", "yes")


def main():
    if not XML_PATH.exists():
        print(f"FATAL: {XML_PATH} nicht gefunden", file=sys.stderr)
        sys.exit(1)

    print(f"[1/3] Lade {XML_PATH} ({XML_PATH.stat().st_size / (1024*1024):.1f} MB) ...", file=sys.stderr)
    tree = ET.parse(XML_PATH)
    root = tree.getroot()

    anlagen = {}
    gesamt_felder = 0
    gesamt_pflicht = 0

    print("[2/3] Parse Anlagen-Felder-Sheets ...", file=sys.stderr)
    for ws in root.findall("ss:Worksheet", NS):
        name = ws.get(f"{{{NS['ss']}}}Name", "")
        m = re.match(r"^([A-Za-z0-9_]+) - Felder$", name)
        if not m:
            continue
        anlage_code = m.group(1)
        felder = parse_anlage_felder(ws)
        if not felder:
            print(f"  {anlage_code}: 0 Felder (skipped)", file=sys.stderr)
            continue
        pflicht_count = sum(1 for f in felder.values() if f["pflicht"])
        print(f"  {anlage_code:12s}  {len(felder):4d} Felder · {pflicht_count:3d} Pflicht", file=sys.stderr)
        anlagen[anlage_code] = {
            "felder": felder,
            "felder_count": len(felder),
            "pflicht_count": pflicht_count,
        }
        gesamt_felder += len(felder)
        gesamt_pflicht += pflicht_count

    out = {
        "year": 2024,
        "source": str(XML_PATH),
        "anlagen_count": len(anlagen),
        "fields_count": gesamt_felder,
        "pflicht_count": gesamt_pflicht,
        "anlagen": anlagen,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n[3/3] Geschrieben: {OUT_PATH}", file=sys.stderr)
    print(f"      Groesse: {OUT_PATH.stat().st_size / 1024:.1f} KB", file=sys.stderr)
    print(f"      {len(anlagen)} Anlagen · {gesamt_felder} E-Codes · {gesamt_pflicht} Pflichtfelder", file=sys.stderr)


if __name__ == "__main__":
    main()
