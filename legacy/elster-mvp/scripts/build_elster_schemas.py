#!/usr/bin/env python3
"""
Parst E10-2024.xsd und emittiert pro Anlage ein Pydantic- + JSON-Schema-Paar
fuer Mistral OCR document_annotation_format.

Input:  E10-2024.xsd  (Single Source of Truth vom BMF)
Output: public/elster_schemas.json
        {
          "year": 2024,
          "anlagen": {
            "N": {
              "label": "Anlage N — Einkuenfte aus nichtselbstaendiger Arbeit",
              "root_type": "N_67907_CType",
              "max_occurs": 2,
              "field_count": 180,
              "leaf_count": 150,
              "json_schema": {...},
              "pydantic_code": "..."
            },
            ...
          }
        }

Deterministisch. Kein LLM. Kein RAG.
"""

from __future__ import annotations
import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

XSD_PATH = Path("/home/christoph.bertsch/CTAX/lanes/lane5_elster_export/data/elster_specs/E10-2024.xsd")
OUT_PATH = Path(__file__).resolve().parent.parent / "public" / "elster_schemas.json"
NS = {"xs": "http://www.w3.org/2001/XMLSchema"}
TARGET_NS = "http://finkonsens.de/elster/elstererklaerung/est/e10/v2024"

# Friendly Labels pro top-level Anlage.
# Die XSD kennt die alle nur als Kuerzel — hier die Prosa dazu.
ANLAGEN_LABELS = {
    "ESt1A":    "Hauptvordruck — Persoenliche Daten, Bank, Ueberschuesse",
    "SA":       "Anlage SA — Sonderausgaben",
    "AgB":      "Anlage AgB — Aussergewoehnliche Belastungen",
    "HA_35a":   "Anlage HA — Haushaltsnahe Dienstleistungen § 35a EStG",
    "EM_35c":   "Anlage EM — Energetische Massnahmen § 35c EStG",
    "Sonst":    "Anlage Sonstiges — Steuerbegünstigungen, Verlustabzug, InvStG",
    "WA_ESt":   "Anlage WA-ESt — Weitere Angaben/Steuerermaessigungen",
    "ESt1A_U":  "Anlage Unterhalt — Unterhaltsleistungen § 33a EStG",
    "Kind":     "Anlage Kind — Angaben zu Kindern",
    "L":        "Anlage L — Einkuenfte aus Land-/Forstwirtschaft",
    "Anl_34b":  "Anlage 34b — Aussertarifliche Einkuenfte (§ 34b EStG)",
    "G":        "Anlage G — Einkuenfte aus Gewerbebetrieb",
    "Zins":     "Anlage Zinsschranke (§ 4h EStG)",
    "S":        "Anlage S — Einkuenfte aus selbstaendiger Arbeit",
    "Corona":   "Anlage Corona-Hilfen",
    "N_GRE":    "Anlage N-GRE — Grenzgaenger",
    "N":        "Anlage N — Einkuenfte aus nichtselbstaendiger Arbeit",
    "N_DHH":    "Anlage N-DHH — Doppelte Haushaltsfuehrung",
    "N_AUS":    "Anlage N-AUS — Auslaendische Einkuenfte aus nichtselbstaendiger Arbeit",
    "KAP":      "Anlage KAP — Einkuenfte aus Kapitalvermoegen",
    "KAP_BET":  "Anlage KAP-BET — Beteiligungserträge",
    "KAP_I":    "Anlage KAP-INV — Investmentertraege",
    "AUS":      "Anlage AUS — Auslaendische Einkuenfte",
    "R":        "Anlage R — Renten und andere Leistungen",
    "RAV_bAV":  "Anlage R-AV/bAV — Altersvorsorge/betriebl. Altersversorgung",
    "R_AUS":    "Anlage R-AUS — Auslaendische Renten",
    "SO":       "Anlage SO — Sonstige Einkuenfte",
    "V":        "Anlage V — Einkuenfte aus Vermietung und Verpachtung",
    "Vorsorge": "Anlage Vorsorgeaufwand — Vorsorgeaufwendungen",
    "Vorsorge_Brutto_Lohn":"Anlage Vorsorgeaufwand (Brutto-Lohn)",
    "U":        "Anlage U — Unterhaltsleistungen an geschiedenen Ehegatten",
    "AV":       "Anlage AV — Altersvorsorge (Riester)",
    "FW":       "Anlage FW — Foerdergebietsgesetz (Eigenheim)",
    "Forst":    "Anlage Forstwirtschaft",
    "Weinbau":  "Anlage Weinbau",
}

# ───────────────────────────────────────────────────────────────
# 1. XSD einlesen und alle complexTypes indizieren
# ───────────────────────────────────────────────────────────────

def load_xsd(path: Path):
    print(f"[1/5] Lade XSD: {path}", file=sys.stderr)
    tree = ET.parse(path)
    root = tree.getroot()
    complex_types = {}
    for ct in root.findall("xs:complexType", NS):
        name = ct.attrib.get("name")
        if name:
            complex_types[name] = ct
    print(f"      {len(complex_types)} complexType Definitionen gefunden", file=sys.stderr)
    return root, complex_types


# ───────────────────────────────────────────────────────────────
# 2. Type-Resolution — welche Basis hat ein benannter Typ?
# ───────────────────────────────────────────────────────────────

def resolve_base_kind(type_name: str, complex_types: dict, seen=None) -> tuple[str, dict]:
    """
    Liefert ('leaf'|'object', meta) fuer einen named type.
    leaf: primitiver Wert mit JSON-Schema-Hints.
    object: hat eine <xs:sequence> mit Unter-Elementen.
    """
    if seen is None:
        seen = set()
    if type_name in seen:
        return ("leaf", {"type": "string"})
    seen.add(type_name)

    # Wenn der type unbekannt ist, als string annehmen
    ct = complex_types.get(type_name)
    if ct is None:
        return ("leaf", {"type": "string", "note": f"unknown type {type_name}"})

    seq = ct.find("xs:sequence", NS)
    if seq is not None and seq.findall("xs:element", NS):
        return ("object", {})

    # Einfacher Wert, via simpleContent -> restriction
    sc = ct.find("xs:simpleContent", NS)
    if sc is not None:
        ext = sc.find("xs:extension", NS)
        restr = sc.find("xs:restriction", NS)
        if ext is not None:
            return resolve_base_kind(ext.attrib.get("base", ""), complex_types, seen)
        if restr is not None:
            return _restriction_to_json_schema(restr)

    return ("leaf", {"type": "string"})


def _restriction_to_json_schema(restr) -> tuple[str, dict]:
    base = restr.attrib.get("base", "")
    meta: dict = {"type": "string"}

    # Explicit enumerations -> enum
    enums = [e.attrib.get("value") for e in restr.findall("xs:enumeration", NS) if e.attrib.get("value")]
    if enums:
        meta = {"type": "string", "enum": enums}

    # maxLength (nur wenn explizit gesetzt, und > 0)
    ml = restr.find("xs:maxLength", NS)
    if ml is not None:
        v = int(ml.attrib.get("value", "0"))
        if v > 0:
            meta["maxLength"] = v

    # pattern — nehmen den ersten (JSON-Schema kennt nur einen)
    patt = restr.find("xs:pattern", NS)
    if patt is not None:
        meta["pattern"] = patt.attrib.get("value")

    # Typ erkennen aus base-Name / pattern
    b = base.lower()
    if ("ganzzahl" in b or "integer" in b) or ("nonneg" in b and "dezimal" not in b):
        meta["type"] = "integer"
    elif "dezimal" in b or "eurocent" in b:
        meta["type"] = "number"
    elif "datum" in b:
        meta["type"] = "string"
        meta.setdefault("format", "date")

    # Bei Integer/Number sind pattern und maxLength irrefuehrend - entfernen
    if meta["type"] in ("integer", "number"):
        meta.pop("pattern", None)
        meta.pop("maxLength", None)

    return ("leaf", meta)


# ───────────────────────────────────────────────────────────────
# 3. Walk fuer einen complexType -> nested Schema + field list
# ───────────────────────────────────────────────────────────────

def walk_type(type_name: str, complex_types: dict, depth=0, max_depth=8) -> dict:
    """
    Rekursiv: liefert ein JSON-Schema-Fragment (nested object) fuer den Typ.
    Zyklen werden via depth-cap abgefangen.
    """
    if depth > max_depth:
        return {"type": "string", "description": f"(truncated at depth {max_depth}: {type_name})"}

    ct = complex_types.get(type_name)
    if ct is None:
        return {"type": "string", "description": f"(unknown type {type_name})"}

    seq = ct.find("xs:sequence", NS)
    if seq is None or not seq.findall("xs:element", NS):
        # leaf
        kind, meta = resolve_base_kind(type_name, complex_types)
        return meta

    props: dict = {}
    required: list = []
    for elem in seq.findall("xs:element", NS):
        name = elem.attrib.get("name") or elem.attrib.get("ref", "").split(":")[-1]
        if not name:
            continue
        elem_type = elem.attrib.get("type", "")
        min_occurs = int(elem.attrib.get("minOccurs", "1"))
        max_occurs_raw = elem.attrib.get("maxOccurs", "1")
        max_occurs = 999999 if max_occurs_raw == "unbounded" else int(max_occurs_raw)
        doc = _extract_doc(elem)

        inner = walk_type(elem_type, complex_types, depth=depth + 1, max_depth=max_depth) if elem_type else {"type": "string"}

        # Beschreibung anreichern
        desc_parts = []
        if doc:
            desc_parts.append(doc)
        if re.match(r"^E\d{7}$", name):
            desc_parts.append(f"ELSTER-Code: {name}")
        if desc_parts:
            inner["description"] = " · ".join(desc_parts)

        if max_occurs > 1:
            inner = {"type": "array", "items": inner, "maxItems": max_occurs if max_occurs < 999999 else None}
            if inner.get("maxItems") is None:
                inner.pop("maxItems", None)

        props[name] = inner
        if min_occurs >= 1:
            required.append(name)

    schema = {
        "type": "object",
        "properties": props,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


def _extract_doc(elem) -> str | None:
    ann = elem.find("xs:annotation", NS)
    if ann is None:
        return None
    doc = ann.find("xs:documentation", NS)
    if doc is None or not doc.text:
        return None
    return " ".join(doc.text.split())


# ───────────────────────────────────────────────────────────────
# 4. Flatten fuer Feldtabelle + Leaf-Count
# ───────────────────────────────────────────────────────────────

def collect_fields(schema: dict, path=(), out=None) -> list[dict]:
    if out is None:
        out = []
    if not isinstance(schema, dict):
        return out
    t = schema.get("type")
    if t == "object":
        for k, v in (schema.get("properties") or {}).items():
            collect_fields(v, path + (k,), out)
    elif t == "array":
        collect_fields(schema.get("items") or {}, path + ("[]",), out)
    else:
        out.append({
            "path": ".".join(path),
            "type": t or "string",
            "description": schema.get("description", ""),
            "is_elster_code": bool(path and re.match(r"^E\d{7}$", path[-1])),
        })
    return out


# ───────────────────────────────────────────────────────────────
# 5. Pydantic-Code aus JSON-Schema (einfacher Generator)
# ───────────────────────────────────────────────────────────────

def schema_to_pydantic(schema: dict, class_name: str) -> str:
    """
    Einfacher Pydantic v2 Generator. Nested Models bekommen eigene Classes.
    Liefert ein str mit mehreren class-Definitionen, die unterste zuerst,
    die Top-Level-Class am Ende.
    """
    classes: list[str] = []
    seen_names: set[str] = set()

    def emit(subschema: dict, name: str) -> str:
        """Returns the type-annotation string for a subschema, emitting classes as side effect."""
        t = subschema.get("type")
        if t == "object":
            # Generate a class
            cls_name = _unique_class_name(name, seen_names)
            lines = [f"class {cls_name}(BaseModel):"]
            props = subschema.get("properties") or {}
            req = set(subschema.get("required") or [])
            body_lines = []
            for field_name, field_schema in props.items():
                annot = emit(field_schema, f"{cls_name}_{_safe(field_name)}")
                desc = field_schema.get("description", "").replace('"', "'")
                py_name = _snake(field_name)
                field_kwargs = [f'alias="{field_name}"']
                if desc:
                    field_kwargs.append(f'description="{desc}"')
                default = "..." if field_name in req else "None"
                if default == "None":
                    annot = f"Optional[{annot}]"
                body_lines.append(
                    f"    {py_name}: {annot} = Field({default}, {', '.join(field_kwargs)})"
                )
            if not body_lines:
                body_lines = ["    pass"]
            lines.extend(body_lines)
            lines.append("    model_config = {'populate_by_name': True, 'extra': 'forbid'}")
            classes.append("\n".join(lines))
            return cls_name
        if t == "array":
            item_annot = emit(subschema.get("items") or {}, name + "_Item")
            return f"List[{item_annot}]"
        if t == "integer":
            return "int"
        if t == "number":
            return "float"
        if subschema.get("enum"):
            vals = ", ".join(repr(v) for v in subschema["enum"])
            return f"Literal[{vals}]"
        return "str"

    root_name = emit(schema, class_name)
    header = (
        "from __future__ import annotations\n"
        "from typing import List, Literal, Optional\n"
        "from pydantic import BaseModel, Field\n\n"
    )
    return header + "\n\n".join(classes) + f"\n\n# Root: {root_name}\n"


def _snake(name: str) -> str:
    # ELSTER-Codes wie E0100601 bleiben als-ist, aber klein geschrieben ist haesslich — wir uebersetzen:
    if re.match(r"^E\d{7}$", name):
        return name.lower()  # e0100601
    # CamelCase / PascalCase -> snake_case
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower().replace("__", "_").strip("_")


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", name)


def _unique_class_name(base: str, seen: set) -> str:
    cand = _safe(base).strip("_") or "Obj"
    # CamelCase
    parts = [p for p in cand.split("_") if p]
    cand = "".join(p[:1].upper() + p[1:] for p in parts) or "Obj"
    n = cand
    i = 2
    while n in seen:
        n = f"{cand}{i}"
        i += 1
    seen.add(n)
    return n


# ───────────────────────────────────────────────────────────────
# 6. Main: E10_CType durchlaufen, pro Kind ein Schema bauen
# ───────────────────────────────────────────────────────────────

def main():
    root, complex_types = load_xsd(XSD_PATH)

    e10 = complex_types.get("E10_CType")
    if e10 is None:
        print("FATAL: E10_CType nicht gefunden", file=sys.stderr)
        sys.exit(1)

    seq = e10.find("xs:sequence", NS)
    if seq is None:
        print("FATAL: E10_CType hat keine xs:sequence", file=sys.stderr)
        sys.exit(1)

    anlagen: dict = {}
    print("[2/5] Iteriere Top-Level Anlagen in E10_CType", file=sys.stderr)
    for child in seq.findall("xs:element", NS):
        code = child.attrib.get("name")
        type_ref = child.attrib.get("type")
        max_occurs_raw = child.attrib.get("maxOccurs", "1")
        max_occurs = int(max_occurs_raw) if max_occurs_raw.isdigit() else 999
        if not code or not type_ref:
            continue
        label = ANLAGEN_LABELS.get(code, f"Anlage {code}")

        schema = walk_type(type_ref, complex_types, depth=0, max_depth=10)
        schema["title"] = code
        schema["description"] = label

        fields = collect_fields(schema)
        leaf_count = len(fields)
        elster_codes = sum(1 for f in fields if f["is_elster_code"])

        pyd = schema_to_pydantic(schema, f"Anlage_{_safe(code)}")

        anlagen[code] = {
            "code": code,
            "label": label,
            "root_type": type_ref,
            "max_occurs": max_occurs,
            "leaf_count": leaf_count,
            "elster_code_count": elster_codes,
            "json_schema": schema,
            "pydantic_code": pyd,
            "fields_preview": fields[:15],
        }
        print(f"      {code:15s} · {leaf_count:4d} Felder ({elster_codes} ELSTER-Codes) · Type {type_ref}", file=sys.stderr)

    out = {
        "year": 2024,
        "xsd_path": str(XSD_PATH),
        "root_complex_type": "E10_CType",
        "anlagen_count": len(anlagen),
        "anlagen": anlagen,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n[3/5] Geschrieben: {OUT_PATH}", file=sys.stderr)
    print(f"      Groesse: {OUT_PATH.stat().st_size / 1024:.1f} KB", file=sys.stderr)
    print(f"      {len(anlagen)} Anlagen indiziert", file=sys.stderr)


if __name__ == "__main__":
    main()
