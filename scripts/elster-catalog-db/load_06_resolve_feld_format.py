#!/usr/bin/env python3
"""
load_06_resolve_feld_format.py — feld.format_id auflösen.

Problem: load_03 schreibt nur feld.format_label (Klartext aus Jahresdok), nicht
die FK zu format_typ. Resultat: 97% der Felder haben format_id IS NULL.

Strategie:
  1. "Benutzerdefinierte Typdefinition: X - N"  → format_typ.xsd_type_name = X
  2. Explizite Mapping-Tabelle für bekannte Klartext-Labels
     (Datum/DatumBereich/Ja/JaNein/Steuernummer im Elster-Format)
  3. Restliche distinkte Klartext-Labels: synthetische format_typ-Einträge
     anlegen (xsd_type_name = <Label>, kanonisch heuristisch erkannt)
  4. UPDATE feld SET format_id = ...
"""
from __future__ import annotations
import argparse, os, re, sys
from collections import Counter

import psycopg
from psycopg.rows import dict_row


# 1) Benutzerdef-Typ: extrahiert X aus "Benutzerdefinierte Typdefinition: X - N"
BENUTZERDEF = re.compile(r"^Benutzerdefinierte Typdefinition:\s*(\S+?)\s*-\s*\d*\s*$")

# 2) Explizite Mappings Jahresdok-Label → XSD-Typname
EXPLICIT_MAP = {
    "Steuernummer im Elster-Format":                  "Steuernummer",
    "Datum TT.MM.JJJJ mit Zusatzprüfung":             "DatumTTpMMpJJJJBekanntBaseCType",
    "Datum TT.MM.JJJJ":                               "DatumTTpMMpJJJJBekanntBaseCType",
    "Datum JJJJ mit Zusatzprüfung":                   "DatumJJJJBaseCType",
    "Datum MM":                                       "DatumMMBaseCType",
    "Datum TT.MM.":                                   "DatumTTpMMpBaseCType",
    "DatumBereich TT.MM-TT.MM mit Zusatzprüfung":     "DatumBereichTTpMMbTTpMMBaseCType",
    "DatumBereich TT.MM.JJJJ-TT.MM.JJJJ mit Zusatzprüfung":
                                                       "DatumBereichTTpMMpJJJJbTTpMMpJJJJBaseCType",
}

# 3) Kanonisierung für synthetische Einträge anhand des Labels
def kanonisch_for(label: str) -> str:
    L = label.lower()
    if L.startswith("geldbetragohnecent"):       return "decimal_eur_no_cent"
    if L.startswith("geldbetragmitcent"):        return "decimal_eur_cent"
    if L.startswith("zahl") and "nachkomma" in L: return "decimal"
    if L.startswith("zahl"):                     return "int"
    if L.startswith("ganzzahl"):                 return "int"
    if L.startswith("dezimal"):                  return "decimal"
    if L.startswith("string mit muster"):        return "string_pattern"
    if L.startswith("string"):                   return "string"
    if L.startswith("enumeration"):              return "enum_inline"
    if L.startswith("ja ("):                     return "bool_ja"
    if L.startswith("janein"):                   return "bool_ja_nein"
    if L.startswith("datum"):                    return "date"
    return "string"


VK_RE = re.compile(r"mit\s+(\d+)\s+Vorkommastellen", re.I)
NK_RE = re.compile(r"mit\s+(?:maximal|genau)?\s*(\d+)\s+Nachkommastellen", re.I)
MAXL_RE = re.compile(r"maximal\s+(\d+)\s+Stellen", re.I)


def derive_constraints(label: str):
    vk = VK_RE.search(label); nk = NK_RE.search(label); mxl = MAXL_RE.search(label)
    return (
        int(vk.group(1)) if vk else None,
        int(nk.group(1)) if nk else None,
        int(mxl.group(1)) if mxl else None,
    )


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", default=os.environ.get("PGURI", "postgresql:///elster_catalog"))
    p.add_argument("--vz", type=int, default=2024)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def main():
    args = parse_args()
    conn = psycopg.connect(args.dsn, autocommit=False, row_factory=dict_row)
    cur = conn.cursor()
    cur.execute("SET search_path = elster, public")

    # Aktueller Stand
    cur.execute("""
        SELECT count(*) AS total,
               count(*) FILTER (WHERE format_id IS NULL) AS ohne_fk
          FROM feld
    """)
    before = cur.fetchone()
    print(f"[06] vor Resolve: {before['total']} Felder, davon {before['ohne_fk']} ohne format_id", file=sys.stderr)

    # Existierende format_typ-Namen indexieren
    cur.execute("SELECT format_id, xsd_type_name FROM format_typ WHERE vz=%s", (args.vz,))
    fid_by_name = {r["xsd_type_name"]: r["format_id"] for r in cur.fetchall()}
    print(f"[06] format_typ aktuell: {len(fid_by_name)} Typen", file=sys.stderr)

    # Distinkte format_labels von Feldern ohne FK
    cur.execute("""
        SELECT format_label, count(*) AS n
          FROM feld
         WHERE format_id IS NULL AND format_label IS NOT NULL
         GROUP BY format_label
    """)
    distinct_labels = [(r["format_label"], r["n"]) for r in cur.fetchall()]
    print(f"[06] distinkte unmapped Labels: {len(distinct_labels)}", file=sys.stderr)

    # ── Schritt 1+2: Label → bestehender format_typ-Name auflösen ─────────
    resolved: dict[str, str] = {}   # label → xsd_type_name
    unresolved: list[tuple[str, int]] = []

    for label, n in distinct_labels:
        # 1) Benutzerdef
        m = BENUTZERDEF.match(label.strip())
        if m:
            tn = m.group(1).strip()
            if tn in fid_by_name:
                resolved[label] = tn; continue
        # 2) Explizit
        if label in EXPLICIT_MAP and EXPLICIT_MAP[label] in fid_by_name:
            resolved[label] = EXPLICIT_MAP[label]; continue
        # 3) Direkter Name-Match (z.B. label heißt zufällig schon ein xsd_type_name)
        if label in fid_by_name:
            resolved[label] = label; continue
        unresolved.append((label, n))

    n_resolved_existing = sum(n for lbl, n in distinct_labels if lbl in resolved)
    print(f"[06] direkt aufgelöst: {len(resolved)} Labels → {n_resolved_existing} Felder", file=sys.stderr)

    # ── Schritt 3: Synthetische format_typ-Einträge für den Rest ──────────
    synth_rows = []
    for label, n in unresolved:
        # Truncate sehr lange Labels (Enumeration-inline mit "Fehlertext:")
        # auf das Schlüsselsegment vor dem ersten "\nFehlertext:"
        name = label.split("\nFehlertext:")[0].strip()
        if len(name) > 200:
            name = name[:200].rstrip()
        if name in fid_by_name:
            resolved[label] = name; continue
        vk, nk, mxl = derive_constraints(label)
        synth_rows.append((args.vz, name, kanonisch_for(label), None, mxl, vk, nk,
                           None, None, label))
        resolved[label] = name
        fid_by_name[name] = None   # placeholder

    print(f"[06] synthetisch anzulegen: {len(synth_rows)} format_typ-Zeilen", file=sys.stderr)
    n_synth_felder = sum(n for lbl, n in unresolved)
    print(f"[06]   davon {n_synth_felder} Felder", file=sys.stderr)

    if args.dry_run:
        print("[06] dry-run — keine Schreibvorgänge", file=sys.stderr)
        return

    if synth_rows:
        cur.executemany("""
            INSERT INTO format_typ (vz, xsd_type_name, kanonisch, min_laenge, max_laenge,
                                    max_vorkomma, max_nachkomma, regex, base_xsd, beschreibung)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (vz, xsd_type_name) DO UPDATE
              SET kanonisch    = EXCLUDED.kanonisch,
                  beschreibung = COALESCE(EXCLUDED.beschreibung, format_typ.beschreibung),
                  max_vorkomma = COALESCE(EXCLUDED.max_vorkomma, format_typ.max_vorkomma),
                  max_nachkomma= COALESCE(EXCLUDED.max_nachkomma, format_typ.max_nachkomma),
                  max_laenge   = COALESCE(EXCLUDED.max_laenge,   format_typ.max_laenge)
        """, synth_rows)

    # Index neu aufbauen nach Synth-Insert
    cur.execute("SELECT format_id, xsd_type_name FROM format_typ WHERE vz=%s", (args.vz,))
    fid_by_name = {r["xsd_type_name"]: r["format_id"] for r in cur.fetchall()}

    # ── Schritt 4: UPDATE feld.format_id ──────────────────────────────────
    # Wir gruppieren nach Ziel-XSD-Name und feuern ein UPDATE pro Gruppe.
    grouped: dict[str, list[str]] = {}
    for label, target in resolved.items():
        grouped.setdefault(target, []).append(label)

    total_updated = 0
    for target, labels in grouped.items():
        fid = fid_by_name.get(target)
        if fid is None:
            continue
        cur.execute(
            "UPDATE feld SET format_id=%s WHERE format_id IS NULL AND format_label = ANY(%s)",
            (fid, labels),
        )
        total_updated += cur.rowcount
    print(f"[06] feld-Rows aktualisiert: {total_updated}", file=sys.stderr)

    cur.execute("""
        SELECT count(*) FILTER (WHERE format_id IS NULL)  AS ohne_fk,
               count(*) FILTER (WHERE format_id IS NULL AND format_label IS NULL) AS wirklich_leer
          FROM feld
    """)
    after = cur.fetchone()
    print(f"[06] nach Resolve: {after['ohne_fk']} Felder ohne FK "
          f"(davon {after['wirklich_leer']} ohne jeden Format-Hinweis)", file=sys.stderr)

    conn.commit()
    conn.close()
    print("[06] OK", file=sys.stderr)


if __name__ == "__main__":
    main()
