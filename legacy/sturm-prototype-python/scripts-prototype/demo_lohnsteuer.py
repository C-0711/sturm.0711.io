"""
Demo-Runner: Wie sieht ein Smart-Schema fuer eine Lohnsteuerbescheinigung aus?

Versucht zuerst :12432 lane5_elster_export.* (Phase-0-Ziel).
Faellt sonst auf :9432 ag_catalog.elster_fields zurueck (Legacy).

Aufruf:
    python demo_lohnsteuer.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any

import psycopg

from smart_schema import build_smart_schema

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(name)s | %(message)s")
log = logging.getLogger("sturm.demo")


# ──────────────────────────────────────────────────────────────────────
# Mini-Pool-Wrapper: damit smart_schema.py sowohl asyncpg als auch
# unseren psycopg-Fallback transparent benutzen kann.
# ──────────────────────────────────────────────────────────────────────


class _PsycopgRow(dict):
    """asyncpg-Records sind dict-aehnlich; psycopg liefert Tupel."""


class _PsycopgConn:
    """Minimaler async-faehiger Wrapper um eine sync psycopg-Connection."""

    def __init__(self, conn: psycopg.Connection):
        self._conn = conn

    async def fetch(self, sql: str, *params) -> list[dict]:
        # asyncpg nutzt $1/$2, psycopg %s — wir uebersetzen.
        sql_pg = _to_psycopg_sql(sql)
        with self._conn.cursor() as cur:
            cur.execute(sql_pg, params)
            cols = [d.name for d in cur.description]
            return [_PsycopgRow(zip(cols, row)) for row in cur.fetchall()]


class _PsycopgPool:
    def __init__(self, dsn: str):
        self._dsn = dsn

    @asynccontextmanager
    async def acquire(self):
        with psycopg.connect(self._dsn) as conn:
            yield _PsycopgConn(conn)


def _to_psycopg_sql(sql: str) -> str:
    """Ersetzt asyncpg-Style $1,$2,... durch psycopg-Style %s."""
    out = sql
    for i in range(20, 0, -1):
        out = out.replace(f"${i}", "%s")
    return out


# ──────────────────────────────────────────────────────────────────────
# Fallback: ag_catalog.elster_fields (Legacy auf :9432)
# ──────────────────────────────────────────────────────────────────────


class _LegacyFallbackPool(_PsycopgPool):
    """Spiegelt :9432 ag_catalog.elster_fields auf das Lane-5-Interface."""

    @asynccontextmanager
    async def acquire(self):
        with psycopg.connect(self._dsn) as conn:
            yield _LegacyConn(conn)


class _LegacyConn(_PsycopgConn):
    async def fetch(self, sql: str, *params) -> list[dict]:
        # Wir erkennen die drei smart_schema-Queries an Schluesselwoertern.
        if "elster_kennzahlen" in sql:
            return await self._fetch_felder_legacy(*params)
        if "enumerations" in sql:
            return []  # Im Legacy-Schema noch nicht abgebildet.
        if "patterns" in sql:
            return []
        # Sonst: durchreichen.
        return await super().fetch(sql, *params)

    async def _fetch_felder_legacy(self, steuerjahr: int, anlagen: list[str]) -> list[dict]:
        sql = """
            SELECT
                elster_code   AS elster_code,
                bezeichnung,
                anlage,
                NULL::text    AS zeile,
                value_type    AS type_ref,
                NULL::text    AS annotation
            FROM ag_catalog.elster_fields
            WHERE is_active = true
              AND anlage = ANY(%s)
            ORDER BY anlage, elster_code
        """
        with self._conn.cursor() as cur:
            cur.execute(sql, (anlagen,))
            cols = [d.name for d in cur.description]
            return [_PsycopgRow(zip(cols, row)) for row in cur.fetchall()]


# ──────────────────────────────────────────────────────────────────────
# DB-Quelle waehlen
# ──────────────────────────────────────────────────────────────────────


async def _waehle_pool() -> tuple[Any, str]:
    # DSNs koennen ueber Env-Variablen ueberschrieben werden — dev-Setups
    # verlangen oft ein Passwort, prod-:12432 ist meist passwortlos.
    primaer_dsn = os.environ.get(
        "STURM_LANE5_DSN",
        "postgresql://ctax@localhost:12432/ctax",
    )
    fallback_dsn = os.environ.get(
        "STURM_LEGACY_DSN",
        os.environ.get(
            "DATABASE_URL",
            "postgresql://ctax@localhost:9432/ctax_cb_chat",
        ),
    )

    pool = _PsycopgPool(primaer_dsn)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT count(*) AS n FROM lane5_elster_export.elster_kennzahlen"
            )
            n = rows[0]["n"] if rows else 0
        if n > 0:
            return pool, f"primaer :12432 lane5_elster_export ({n} Kennzahlen)"
        log.warning("Primaer-Quelle hat 0 Kennzahlen — pruefe Fallback.")
    except Exception as e:
        log.warning("Primaer-Quelle :12432 nicht erreichbar (%s) — Fallback.", e)

    pool = _LegacyFallbackPool(fallback_dsn)
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT count(*) AS n FROM ag_catalog.elster_fields")
    n = rows[0]["n"] if rows else 0
    return pool, f"fallback :9432 ag_catalog.elster_fields ({n} Felder)"


# ──────────────────────────────────────────────────────────────────────
# Pretty-Printer
# ──────────────────────────────────────────────────────────────────────


def _print_kopf(quelle: str) -> None:
    print("=" * 78)
    print("STURM Smart-Schema-Builder — Prototype Demo")
    print(f"Quelle: {quelle}")
    print("=" * 78)


def _print_felder(model_cls: type, n: int = 5) -> None:
    fields = list(model_cls.model_fields.items())
    print(f"\nFelder im Schema: {len(fields)}")
    print(f"\nErste {min(n, len(fields))} Felder mit ihren Mistral-Descriptions:")
    print("-" * 78)
    for name, info in fields[:n]:
        desc = (info.description or "")[:300]
        print(f"  {name}")
        print(f"      {desc}")
        print()


def _print_function_schema(schema: dict) -> None:
    print("Mistral-Function-Schema (gekuerzt):")
    print("-" * 78)
    fn = schema["function"]
    truncated = {
        "type": schema["type"],
        "function": {
            "name": fn["name"],
            "description": fn["description"],
            "parameters": {
                "type": fn["parameters"].get("type"),
                "title": fn["parameters"].get("title"),
                "properties": dict(list(fn["parameters"].get("properties", {}).items())[:3]),
                "_rest_omitted": f"{len(fn['parameters'].get('properties', {})) - 3} weitere Properties",
            },
        },
    }
    print(json.dumps(truncated, indent=2, ensure_ascii=False))


def _print_fake_call(doc_type: str, schema: dict, anlagen: list[str]) -> None:
    print("\nFake-Mistral-Call (kein echter API-Hit):")
    print("-" * 78)
    sys_prompt = (
        "Du bist STURM, ein Steuerunterlagen-Extraktor. "
        "Lies das Dokument seitenweise, fuelle das Function-Tool ausschliesslich "
        "mit gefundenen Werten. Felder ohne Wert lass null. "
        "Beachte die ELSTER-Codes und die in der description hinterlegten "
        "Allowed values und Pattern."
    )
    user_msg = (
        f"Dokumenttyp (Pass-1-Hint): {doc_type}\n"
        f"Plausible Anlagen: {', '.join(anlagen)}\n"
        f"Hier sind die OCR-Seiten:\n[Seite 1 ...] [Seite 2 ...]"
    )
    fake = {
        "model": "mistral-large-latest",
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_msg},
        ],
        "tools": [schema],
        "tool_choice": {"type": "function", "function": {"name": schema["function"]["name"]}},
        "temperature": 0.0,
    }
    payload_kurz = {
        **fake,
        "tools": [{"_function": fake["tools"][0]["function"]["name"], "_omitted": True}],
    }
    print(json.dumps(payload_kurz, indent=2, ensure_ascii=False))


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────


async def main() -> int:
    pool, quelle = await _waehle_pool()
    _print_kopf(quelle)

    doc_type = "lohnsteuerbescheinigung"
    anlagen = ["N", "VOR", "SA"]
    person_idnrs = ["85236749007"]
    steuerjahr = 2024

    Modell, function_schema = await build_smart_schema(
        doc_type=doc_type,
        anlagen=anlagen,
        person_idnrs=person_idnrs,
        steuerjahr=steuerjahr,
        db_pool=pool,
    )

    _print_felder(Modell, n=5)
    _print_function_schema(function_schema)
    _print_fake_call(doc_type, function_schema, anlagen)

    print("\nFertig. (Kein echter Mistral-Call abgesetzt.)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
