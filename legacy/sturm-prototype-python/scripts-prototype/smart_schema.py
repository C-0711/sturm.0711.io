"""
STURM Smart-Schema-Builder — Prototype.

Baut zur Laufzeit ein Pydantic-v2-Modell aus den ELSTER-Metadaten in
:12432 lane5_elster_export.* zusammen, statt 12 hartcodierte
Doku-Schemas zu pflegen.

Das fertige Modell hat pro Feld eine Field(description=...), in der
Bezeichnung, ELSTER-Code, Datentyp, Enum-Werte und Regex-Pattern
zusammengefasst sind. Mistral Large nutzt diese description als
Extraktions-Hint und mappt Wert + ELSTER-Code in einem Pass.

Owner: 0711 / cb-ctax / STURM. Single Source of Truth bleibt die DB.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional, Protocol

from pydantic import BaseModel, ConfigDict, Field, create_model

log = logging.getLogger("sturm.smart_schema")


# ──────────────────────────────────────────────────────────────────────
# Wrapper-Modelle (siehe doku/index.html, Abschnitt "STURM Smart-Extraktion")
# ──────────────────────────────────────────────────────────────────────


class ExtrahiertesFeld(BaseModel):
    """Ein einzelner extrahierter Wert mit ELSTER-Mapping und Provenienz."""

    model_config = ConfigDict(extra="forbid")

    feld_name: str = Field(description="Sprechender Feldname aus dem Smart-Schema")
    wert: str | float | int = Field(description="Extrahierter Rohwert")
    elster_code: str = Field(description="Offizielle ELSTER-Kennzahl")
    anlagen: list[str] = Field(default_factory=list, description="Alle Anlagen, in denen das Feld vorkommen kann")
    primaere_anlage: str = Field(description="Primaere Anlage fuer dieses Feld")
    person_idnr: Optional[str] = Field(default=None, description="IdNr der Person bei Multi-Person-Anlagen")
    konfidenz: float = Field(ge=0.0, le=1.0, description="Konfidenz 0..1")
    quellzitat: Optional[dict] = Field(default=None, description="{seite, bbox, text}")


class SmartExtraction(BaseModel):
    """Ergebnis eines Pass-2-Calls — vom LLM zurueckgelieferte Struktur."""

    model_config = ConfigDict(extra="forbid")

    doc_type: str = Field(description="Erkannter Dokumenttyp")
    doc_type_konfidenz: float = Field(ge=0.0, le=1.0)
    profil_hints: list[str] = Field(default_factory=list, description="z.B. ['ARBEITNEHMER','RENTNER']")
    anlagen_hints: dict[str, float] = Field(
        default_factory=dict,
        description="Anlage -> Konfidenz, z.B. {'N': 0.95, 'VOR': 0.8}",
    )
    felder: list[ExtrahiertesFeld] = Field(default_factory=list)


# ──────────────────────────────────────────────────────────────────────
# DB-Pool-Protokoll (asyncpg-kompatibel)
# ──────────────────────────────────────────────────────────────────────


class DBPool(Protocol):
    """Strukturelles Interface — passt auf asyncpg.Pool und psycopg-Wrapper."""

    def acquire(self) -> Any: ...


# ──────────────────────────────────────────────────────────────────────
# DB-Reader: alles was wir aus :12432 lesen, in einem Schritt
# ──────────────────────────────────────────────────────────────────────


# Anlage -> ELSTER-Praefix der Kennzahlen.
# Prototyp-Heuristik. Sobald lane5_elster_export.elster_kennzahlen
# vollstaendig migriert ist, ziehen wir die Filterung lieber direkt
# ueber die Kennzahlen-Tabelle.
ANLAGE_KENNZAHL_PRAEFIX = {
    "ESt1A": ("E0100", "E0101"),
    "N": ("E0200", "E0201", "E0202"),
    "VOR": ("E0202", "E0210", "E2100"),
    "SA": ("E0108", "E0109"),
    "Kind": ("E0107", "E0103"),
    "KAP": ("E2001",),
    "R": ("E2100",),
    "V": ("E2901", "E2902"),
    "AgB": ("E1810",),
    "SO": ("E2200",),
}


_DATENTYP_TO_PY: dict[str, type] = {
    "BetragMitNachkomma": float,
    "BetragGanzzahl": int,
    "Ganzzahl": int,
    "Datum": str,
    "Text": str,
    "IdNrType": str,
    "Steuernummer": str,
    "ELSTERIban": str,
}


def _datentyp_to_python(type_ref: Optional[str]) -> type:
    """Mappt einen XSD-type_ref auf einen Python-Typ. Fallback: str."""
    if not type_ref:
        return str
    base = type_ref.split(":")[-1]
    for key, py in _DATENTYP_TO_PY.items():
        if key.lower() in base.lower():
            return py
    return str


async def _fetch_felder(conn, steuerjahr: int, anlagen: list[str]) -> list[dict]:
    """Holt die fuer die Anlagen relevanten field_definitions.

    Solange die feld_definitions noch keine anlage-Spalte hat (Phase 0
    laeuft noch), filtern wir ueber elster_kennzahlen + Praefix-Heuristik.
    """
    praefixe: list[str] = []
    for anlage in anlagen:
        praefixe.extend(ANLAGE_KENNZAHL_PRAEFIX.get(anlage, ()))
    praefixe = list(dict.fromkeys(praefixe))  # de-duplizieren

    sql = """
        SELECT
            ek.kennzahl   AS elster_code,
            ek.bezeichnung,
            ek.anlage,
            ek.zeile,
            fd.type_ref,
            fd.annotation
        FROM lane5_elster_export.elster_kennzahlen ek
        LEFT JOIN lane5_elster_export.field_definitions fd
               ON fd.steuerjahr = ek.steuerjahr
              AND fd.feld_name  = ek.kennzahl
        WHERE ek.steuerjahr = $1
          AND ek.anlage     = ANY($2)
        ORDER BY ek.anlage, ek.kennzahl
    """
    rows = await conn.fetch(sql, steuerjahr, anlagen)
    return [dict(r) for r in rows]


async def _fetch_enum_map(conn, steuerjahr: int) -> dict[str, list[str]]:
    """type_name -> Liste erlaubter Werte."""
    rows = await conn.fetch(
        "SELECT type_name, wert FROM lane5_elster_export.enumerations "
        "WHERE steuerjahr = $1 ORDER BY type_name, wert",
        steuerjahr,
    )
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r["type_name"], []).append(r["wert"])
    return out


async def _fetch_pattern_map(conn, steuerjahr: int) -> dict[str, str]:
    """type_name -> Regex-Pattern."""
    rows = await conn.fetch(
        "SELECT type_name, pattern FROM lane5_elster_export.patterns "
        "WHERE steuerjahr = $1",
        steuerjahr,
    )
    return {r["type_name"]: r["pattern"] for r in rows}


# ──────────────────────────────────────────────────────────────────────
# Kern: Schema-Builder
# ──────────────────────────────────────────────────────────────────────


_SAFE_NAME_RE = re.compile(r"[^0-9a-zA-Z_]+")


def _safe_field_name(elster_code: str, bezeichnung: str | None) -> str:
    """Pydantic braucht valide Python-Identifier."""
    base = (bezeichnung or elster_code).lower()
    base = _SAFE_NAME_RE.sub("_", base).strip("_")
    if not base or base[0].isdigit():
        base = f"f_{elster_code.lower()}"
    return base[:60]


def _baue_description(
    bezeichnung: str | None,
    elster_code: str,
    anlage: str | None,
    zeile: str | None,
    py_type: type,
    enum_values: list[str] | None,
    regex: str | None,
    primaere_anlage: str,
    weitere_anlagen: list[str],
) -> str:
    """Baut den Description-String, den Mistral als Extraktions-Hint sieht."""
    teile: list[str] = []
    if bezeichnung:
        teile.append(bezeichnung)
    teile.append(f"ELSTER-Code: {elster_code}")
    if anlage:
        zeile_str = f", Zeile {zeile}" if zeile else ""
        teile.append(f"Anlage: {anlage}{zeile_str}")
    teile.append(f"Type: {py_type.__name__}")
    if enum_values:
        kurz = ", ".join(enum_values[:8])
        if len(enum_values) > 8:
            kurz += f", ... ({len(enum_values)} Werte)"
        teile.append(f"Allowed values: [{kurz}]")
    if regex:
        teile.append(f"Pattern: {regex}")
    teile.append(f"Primaere Anlage: {primaere_anlage}")
    if weitere_anlagen:
        teile.append(f"Weitere Anlagen: {', '.join(weitere_anlagen)}")
    return ". ".join(teile) + "."


async def build_smart_schema(
    doc_type: Optional[str],
    anlagen: list[str],
    person_idnrs: Optional[list[str]],
    steuerjahr: int,
    db_pool,
) -> tuple[type[BaseModel], dict]:
    """Baut zur Laufzeit ein Pydantic-Modell + Mistral-Function-Schema.

    Args:
        doc_type:      vom Pass-1-Erkenner geliefert (oder None).
        anlagen:       Liste plausibler Anlagen, z.B. ['N','VOR','SA'].
        person_idnrs:  bei Multi-Person-Anlagen wie KAP — sonst None.
        steuerjahr:    z.B. 2024.
        db_pool:       asyncpg.Pool oder kompatibler Wrapper auf :12432.

    Returns:
        (PydanticModelClass, mistral_function_schema_dict)
    """
    async with db_pool.acquire() as conn:
        felder_rows = await _fetch_felder(conn, steuerjahr, anlagen)
        enum_map    = await _fetch_enum_map(conn, steuerjahr)
        pattern_map = await _fetch_pattern_map(conn, steuerjahr)

    if not felder_rows:
        log.warning(
            "Keine Felder fuer steuerjahr=%d anlagen=%s gefunden — "
            "leeres Schema wird zurueckgegeben.",
            steuerjahr, anlagen,
        )

    # Ein Feld kann in mehreren Anlagen vorkommen — wir gruppieren auf elster_code.
    pro_code: dict[str, dict] = {}
    for row in felder_rows:
        code = row["elster_code"]
        if code not in pro_code:
            pro_code[code] = {
                "elster_code": code,
                "bezeichnung": row["bezeichnung"],
                "type_ref": row["type_ref"],
                "annotation": row["annotation"],
                "anlagen": [],
                "primaere_anlage": row["anlage"],
                "zeile": row["zeile"],
            }
        if row["anlage"] not in pro_code[code]["anlagen"]:
            pro_code[code]["anlagen"].append(row["anlage"])

    fields_def: dict[str, tuple[type, Any]] = {}
    feld_meta: dict[str, dict] = {}  # feld_name -> {elster_code, anlagen, ...}
    used_names: set[str] = set()

    for code, meta in pro_code.items():
        py_type = _datentyp_to_python(meta["type_ref"])
        enum_vals = enum_map.get((meta["type_ref"] or "").split(":")[-1])
        regex = pattern_map.get((meta["type_ref"] or "").split(":")[-1])

        primaer = meta["primaere_anlage"] or (meta["anlagen"][0] if meta["anlagen"] else "?")
        weitere = [a for a in meta["anlagen"] if a != primaer]

        description = _baue_description(
            bezeichnung=meta["bezeichnung"],
            elster_code=code,
            anlage=primaer,
            zeile=meta["zeile"],
            py_type=py_type,
            enum_values=enum_vals,
            regex=regex,
            primaere_anlage=primaer,
            weitere_anlagen=weitere,
        )

        feld_name = _safe_field_name(code, meta["bezeichnung"])
        # Kollisionen vermeiden
        suffix = 2
        original = feld_name
        while feld_name in used_names:
            feld_name = f"{original}_{suffix}"
            suffix += 1
        used_names.add(feld_name)

        fields_def[feld_name] = (
            Optional[py_type],
            Field(default=None, description=description),
        )
        feld_meta[feld_name] = {
            "elster_code": code,
            "primaere_anlage": primaer,
            "anlagen": meta["anlagen"],
            "type_ref": meta["type_ref"],
            "enum_values": enum_vals,
            "pattern": regex,
        }

    model_name = f"SmartSchema_{(doc_type or 'unknown').title()}_{steuerjahr}"
    DynamicModel = create_model(model_name, __base__=BaseModel, **fields_def)
    DynamicModel.model_config = ConfigDict(extra="forbid")
    DynamicModel.__sturm_meta__ = {  # type: ignore[attr-defined]
        "doc_type": doc_type,
        "anlagen": anlagen,
        "person_idnrs": person_idnrs or [],
        "steuerjahr": steuerjahr,
        "feld_meta": feld_meta,
    }

    function_schema = _zu_mistral_function_schema(
        DynamicModel,
        name=f"extrahiere_{(doc_type or 'dokument').lower()}",
        beschreibung=(
            f"Extrahiere alle Werte aus dem Steuerdokument vom Typ "
            f"'{doc_type or 'unbekannt'}' und mappe sie auf die ELSTER-Codes "
            f"der Anlagen {anlagen} fuer Steuerjahr {steuerjahr}. "
            f"Felder ohne Wert auf null lassen."
        ),
    )

    log.info(
        "Smart-Schema gebaut: %s — %d Felder ueber Anlagen %s",
        model_name, len(fields_def), anlagen,
    )
    return DynamicModel, function_schema


def _zu_mistral_function_schema(
    model_cls: type[BaseModel],
    name: str,
    beschreibung: str,
) -> dict:
    """Wickelt das JSON-Schema des Modells in das Mistral-Function-Format."""
    json_schema = model_cls.model_json_schema()
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": beschreibung,
            "parameters": json_schema,
        },
    }
