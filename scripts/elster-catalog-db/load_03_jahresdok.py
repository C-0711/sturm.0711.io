#!/usr/bin/env python3
"""
load_03_jahresdok.py — Jahresdokumentation_10_2024 1.xml (MS Excel 2003 XML)
streamen und folgende Tabellen befüllen / anreichern:

  anlage                — upsert (vz, name)
  kontext               — upsert (anlage_id, pfad) aus Anlage X - Kontexte
  feld                  — UPSERT auf (anlage_id, kontext_id, name); überschreibt
                          die XSD-seeded Rows mit offiziellen Drucktexten / Vordruck-
                          zeilen / Format-Regex / Pflicht / Annotationen
  regel + regel_feld    — aus Anlage X - Regeln
  kennzahl              — aus Anlage X - Kennzahlen
  drucktext             — aus Anlage X - Texte (Vordruck-Layout)

Streaming: nutzt lxml.iterparse damit 13 MB nicht komplett in RAM landen.
"""
from __future__ import annotations
import argparse, os, re, sys
from pathlib import Path
from typing import Iterator

import lxml.etree as ET
import psycopg
from psycopg.rows import dict_row

SSNS = "urn:schemas-microsoft-com:office:spreadsheet"
def ssns(tag): return f"{{{SSNS}}}{tag}"
INDEX = ssns("Index")
DATA  = ssns("Data")

CODE_RE = re.compile(r"^E\d{7,8}$")

# ── Excel-XML Helpers ──────────────────────────────────────────────────────
# Hinweis: Streaming via iterparse() führte unter macOS/lxml zu Abort trap 6
# bei großen MS-Excel-XMLs mit komplexer Namespace-Struktur. Wir parsen den
# 13-MB-Workbook in einem Rutsch — RAM-Overhead ~200 MB, akzeptabel für CLI.
_CACHED_TREE: ET._ElementTree | None = None

def _tree(xml_path: Path) -> ET._ElementTree:
    global _CACHED_TREE
    if _CACHED_TREE is None:
        parser = ET.XMLParser(huge_tree=True)
        _CACHED_TREE = ET.parse(str(xml_path), parser=parser)
    return _CACHED_TREE

def iter_worksheets(xml_path: Path) -> Iterator[tuple[str, ET._Element]]:
    root = _tree(xml_path).getroot()
    for ws in root.iter(ssns("Worksheet")):
        name = ws.get(ssns("Name"))
        if name:
            yield name, ws

def list_worksheet_names(xml_path: Path) -> list[str]:
    root = _tree(xml_path).getroot()
    return [ws.get(ssns("Name")) for ws in root.iter(ssns("Worksheet")) if ws.get(ssns("Name"))]

def rows_of(ws: ET._Element) -> Iterator[list]:
    """Yield list of cell texts (column-aligned, respects ss:Index gaps)."""
    table = ws.find(ssns("Table"))
    if table is None: return
    for row in table.findall(ssns("Row")):
        cells = []
        cur = 0
        for c in row.findall(ssns("Cell")):
            idx = c.get(INDEX)
            if idx:
                idx = int(idx) - 1
                while cur < idx:
                    cells.append(None); cur += 1
            d = c.find(DATA)
            cells.append(d.text if d is not None else None)
            cur += 1
        yield cells

def boolish(v) -> bool | None:
    if v is None: return None
    s = str(v).strip().lower()
    if s in ("ja", "true", "1", "x"): return True
    if s in ("nein", "false", "0", ""): return False
    return None

def intish(v):
    try: return int(str(v).strip()) if v is not None and str(v).strip() != "" else None
    except: return None

# ── Main ───────────────────────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--jahresdok", required=True, help="Pfad zu Jahresdokumentation_10_2024 1.xml")
    p.add_argument("--dsn", default=os.environ.get("PGURI", "postgresql:///elster_catalog"))
    p.add_argument("--vz", type=int, default=2024)
    p.add_argument("--eric-version", default="42.4.4.0")
    return p.parse_args()

def main():
    args = parse_args()
    xml_path = Path(args.jahresdok).expanduser().resolve()
    print(f"[03] Jahresdokumentation: {xml_path}", file=sys.stderr)

    conn = psycopg.connect(args.dsn, autocommit=False, row_factory=dict_row)
    cur = conn.cursor()
    cur.execute("SET search_path = elster, public")
    cur.execute("UPDATE vz SET eric_version=%s, jahresdok_quelle=%s WHERE vz=%s",
                (args.eric_version, str(xml_path), args.vz))

    # ── PASS 1: Anlagen-Namen ermitteln ───────────────────────────────────
    seen_anlagen: set[str] = set()
    for name in list_worksheet_names(xml_path):
        if " - " in name:
            seen_anlagen.add(name.split(" - ", 1)[0])
    print(f"[03] Anlagen gefunden: {len(seen_anlagen)}", file=sys.stderr)

    cur.executemany("""
        INSERT INTO anlage (vz, name)
        VALUES (%s, %s)
        ON CONFLICT (vz, name) DO NOTHING
    """, [(args.vz, n) for n in sorted(seen_anlagen)])

    cur.execute("SELECT anlage_id, name FROM anlage WHERE vz=%s", (args.vz,))
    anlage_id_by_name = {r["name"]: r["anlage_id"] for r in cur.fetchall()}

    cur.execute("SELECT format_id, xsd_type_name FROM format_typ WHERE vz=%s", (args.vz,))
    fid_by_xsdname = {r["xsd_type_name"]: r["format_id"] for r in cur.fetchall()}

    # ── PASS 2: Pro Worksheet die richtige Loader-Funktion dispatchen ─────
    counts = {"kontext": 0, "feld": 0, "regel": 0, "regel_feld": 0, "kennzahl": 0, "drucktext": 0}

    for ws_name, ws in iter_worksheets(xml_path):
        if not ws_name or " - " not in ws_name: continue
        anlage_name, kind = ws_name.split(" - ", 1)
        anlage_id = anlage_id_by_name.get(anlage_name)
        if not anlage_id: continue

        rows = list(rows_of(ws))
        if not rows: continue
        headers = [(c or "").strip() for c in rows[0]]
        data = rows[1:]
        idx = {h: i for i, h in enumerate(headers) if h}

        def get(row, key, default=None):
            i = idx.get(key)
            if i is None or i >= len(row): return default
            v = row[i]
            return v if v not in (None, "") else default

        # ── Kontexte ────────────────────────────────────────────────────
        if kind == "Kontexte":
            buf = []
            for r in data:
                pfad = get(r, "Kontext")
                if not pfad: continue
                parent = "/".join(pfad.split("/")[:-1]) or None
                buf.append((anlage_id, pfad, parent,
                            get(r, "max. Wiederholbarkeit"),
                            get(r, "Annotationen"),
                            get(r, "Änderungsinformation"),
                            get(r, "Änderungsdetails")))
            cur.executemany("""
                INSERT INTO kontext (anlage_id, pfad, parent_pfad, max_wiederhol,
                                     annotationen, aenderungsinfo, aenderungsdetails)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (anlage_id, pfad) DO UPDATE
                  SET parent_pfad=EXCLUDED.parent_pfad,
                      max_wiederhol=EXCLUDED.max_wiederhol,
                      annotationen=EXCLUDED.annotationen,
                      aenderungsinfo=EXCLUDED.aenderungsinfo,
                      aenderungsdetails=EXCLUDED.aenderungsdetails
            """, buf)
            counts["kontext"] += len(buf)
            continue

        # ── Felder ─────────────────────────────────────────────────────
        if kind == "Felder":
            # Kontext-IDs für diese Anlage cachen
            cur.execute("SELECT kontext_id, pfad FROM kontext WHERE anlage_id=%s", (anlage_id,))
            ctx_by_pfad = {r["pfad"]: r["kontext_id"] for r in cur.fetchall()}

            buf = []
            for r in data:
                name = get(r, "Name")
                if not name: continue
                ctx_short = get(r, "Kontext", "")        # z.B. "ArbL/LStB_1_5_Sum"
                # In Kontexte ist es '/N/ArbL/LStB_1_5_Sum' — bauen
                full_pfad = "/" + anlage_name + ("/" + ctx_short if ctx_short else "")
                # Treffer suchen — entweder full oder ohne führendes "/"
                kontext_id = ctx_by_pfad.get(full_pfad)
                if kontext_id is None:
                    # Anlegen falls nicht in Kontexte-Sheet (passiert bei Hilfsfeldern)
                    cur.execute("""
                        INSERT INTO kontext (anlage_id, pfad)
                        VALUES (%s,%s) ON CONFLICT (anlage_id, pfad) DO UPDATE SET pfad=EXCLUDED.pfad
                        RETURNING kontext_id
                    """, (anlage_id, full_pfad))
                    kontext_id = cur.fetchone()["kontext_id"]
                    ctx_by_pfad[full_pfad] = kontext_id

                fmt_label = get(r, "Format")
                # Format-Name aus Label extrahieren ("Benutzerdefinierte Typdefinition: IDNr - 1")
                fid = None
                if fmt_label:
                    m = re.search(r"Benutzerdefinierte Typdefinition:\s*([\w.]+)\s*-\s*\d+", fmt_label)
                    if m: fid = fid_by_xsdname.get(m.group(1)) or fid_by_xsdname.get(m.group(1) + "BaseCType")

                buf.append((
                    anlage_id, kontext_id, name,
                    bool(CODE_RE.match(name)),
                    get(r, "Beschreibung"),
                    fid,
                    fmt_label,
                    get(r, "Format als regulärer Ausdruck"),
                    (get(r, "Formatkennzeichen") or "")[:1] or None,
                    intish(get(r, "Min. Länge")),
                    intish(get(r, "Max. Länge")),
                    intish(get(r, "max. Zeilen")),
                    boolish(get(r, "Pflichtfeld")),
                    get(r, "Pflichtfeld Fehlertext"),
                    boolish(get(r, "Indexfeld")),
                    get(r, "Vordruckzeile"),
                    get(r, "Drucktext"),
                    boolish(get(r, "Internes ERiC Feld")),
                    get(r, "Zusatz-Informationen"),
                    get(r, "Annotationen"),
                    get(r, "Änderungsinformation"),
                    get(r, "Änderungsdetails"),
                ))
            cur.executemany("""
                INSERT INTO feld (anlage_id, kontext_id, name, ist_ecode, beschreibung,
                                  format_id, format_label, format_regex, formatkennzeichen,
                                  min_laenge, max_laenge, max_zeilen, pflichtfeld,
                                  pflicht_fehlertext, indexfeld, vordruckzeile, drucktext,
                                  internes_eric, zusatz_info, annotationen,
                                  aenderungsinfo, aenderungsdetails)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (anlage_id, kontext_id, name) DO UPDATE
                  SET beschreibung=EXCLUDED.beschreibung,
                      format_id=COALESCE(EXCLUDED.format_id, feld.format_id),
                      format_label=EXCLUDED.format_label,
                      format_regex=EXCLUDED.format_regex,
                      formatkennzeichen=EXCLUDED.formatkennzeichen,
                      min_laenge=EXCLUDED.min_laenge,
                      max_laenge=EXCLUDED.max_laenge,
                      max_zeilen=EXCLUDED.max_zeilen,
                      pflichtfeld=EXCLUDED.pflichtfeld,
                      pflicht_fehlertext=EXCLUDED.pflicht_fehlertext,
                      indexfeld=EXCLUDED.indexfeld,
                      vordruckzeile=EXCLUDED.vordruckzeile,
                      drucktext=EXCLUDED.drucktext,
                      internes_eric=EXCLUDED.internes_eric,
                      zusatz_info=EXCLUDED.zusatz_info,
                      annotationen=EXCLUDED.annotationen,
                      aenderungsinfo=EXCLUDED.aenderungsinfo,
                      aenderungsdetails=EXCLUDED.aenderungsdetails
            """, buf)
            counts["feld"] += len(buf)
            continue

        # ── Regeln ─────────────────────────────────────────────────────
        if kind == "Regeln":
            cur.execute("SELECT kontext_id, pfad FROM kontext WHERE anlage_id=%s", (anlage_id,))
            ctx_by_pfad = {r["pfad"]: r["kontext_id"] for r in cur.fetchall()}
            cur.execute("SELECT feld_id, name, kontext_id FROM feld WHERE anlage_id=%s", (anlage_id,))
            feld_by_key = {(r["name"], r["kontext_id"]): r["feld_id"] for r in cur.fetchall()}
            feld_by_name = {}
            for (nm, _), fid in feld_by_key.items():
                feld_by_name.setdefault(nm, []).append(fid)

            for r in data:
                ctx_short = get(r, "Kontext", "")
                full_pfad = "/" + anlage_name + ("/" + ctx_short if ctx_short else "")
                kontext_id = ctx_by_pfad.get(full_pfad)
                cur.execute("""
                    INSERT INTO regel (anlage_id, kontext_id, name, fehlercode, beschreibung,
                                       pruefbedingung, fehlertext, vordruck_bereich,
                                       zeilen_bereich, geprueft_usb, regelart,
                                       annotationen, aenderungsinfo, aenderungsdetails)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    RETURNING regel_id
                """, (
                    anlage_id, kontext_id, get(r, "Name"), get(r, "Fehlercode"),
                    get(r, "Beschreibung"), get(r, "Prüfbedingung"),
                    get(r, "Fehler- /Hinweistext"),
                    get(r, "Prüfung für mehrere Vordrucke (Vordruck von - bis)"),
                    get(r, "Prüfung für mehrere Zeilen (Zeile von - bis)"),
                    get(r, "Prüfung für mehrere USB"), get(r, "Regelart"),
                    get(r, "Annotationen"), get(r, "Änderungsinformation"),
                    get(r, "Änderungsdetails"),
                ))
                regel_id = cur.fetchone()["regel_id"]
                counts["regel"] += 1

                geprueft = get(r, "Geprüfte Felder", "") or ""
                # Format kann CSV / Whitespace / mit Kontext-Präfix sein — einfach splitten
                tokens = re.split(r"[,;\s]+", geprueft)
                for t in tokens:
                    t = t.strip().rstrip(",")
                    if not t: continue
                    # falls "Kontext/Feld" → letzten Teil nehmen
                    code = t.split("/")[-1]
                    fids = feld_by_name.get(code) or []
                    for fid in fids:
                        cur.execute("INSERT INTO regel_feld (regel_id, feld_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (regel_id, fid))
                        counts["regel_feld"] += 1
            continue

        # ── Kennzahlen ─────────────────────────────────────────────────
        if kind == "Kennzahlen":
            cur.execute("SELECT feld_id, name FROM feld WHERE anlage_id=%s", (anlage_id,))
            fid_by_name = {}
            for r in cur.fetchall(): fid_by_name.setdefault(r["name"], r["feld_id"])

            buf = []
            for r in data:
                feldname = get(r, "Feldname")
                # Jahresdok schreibt teils "Kontext/Feld" (z.B. "AN_Sp_Zul/E0109109").
                # Wir suchen den E-Code (letztes Segment) im fid-Index.
                lookup_key = (feldname.split("/")[-1] if feldname else None)
                fid = fid_by_name.get(lookup_key) if lookup_key else None
                buf.append((anlage_id, fid, feldname,
                            intish(get(r, "Lfd. Nr. Vordruck")),
                            get(r, "MZI"), get(r, "Sachbereich"),
                            get(r, "Kennzahl"),
                            get(r, "Änderungsinformation"),
                            get(r, "Änderungsdetails")))
            cur.executemany("""
                INSERT INTO kennzahl (anlage_id, feld_id, feldname, lfd_nr_vordruck,
                                      mzi, sachbereich, kennzahl,
                                      aenderungsinfo, aenderungsdetails)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, buf)
            counts["kennzahl"] += len(buf)
            continue

        # ── Texte (Vordruck-Layout) ───────────────────────────────────
        if kind == "Texte":
            buf = []
            for r in data:
                txt = next((c for c in r if c), None)
                if not txt: continue
                buf.append((anlage_id, None, None, None, str(txt)))
            cur.executemany("""
                INSERT INTO drucktext (anlage_id, feld_id, vordruck_seite, position, text)
                VALUES (%s,%s,%s,%s,%s)
            """, buf)
            counts["drucktext"] += len(buf)
            continue

    # ── Feld-Zähler pro Anlage aktualisieren ──────────────────────────
    cur.execute("""
        UPDATE anlage a SET field_count = sub.cnt
          FROM (SELECT anlage_id, COUNT(*) AS cnt FROM feld WHERE ist_ecode GROUP BY anlage_id) sub
         WHERE a.anlage_id = sub.anlage_id
    """)

    conn.commit()
    conn.close()
    print(f"[03] Befüllt:", file=sys.stderr)
    for k, v in counts.items():
        print(f"       {k:<12} {v:>6}", file=sys.stderr)
    print(f"[03] OK", file=sys.stderr)

if __name__ == "__main__":
    main()
