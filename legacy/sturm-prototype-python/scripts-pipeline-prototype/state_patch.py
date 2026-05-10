"""
state_patch — RFC-6902-shaped event emitter fuer STURM-Pipeline.

Jeder StatePatch repraesentiert genau einen applyTool-Call gegen
case_state v1 (siehe frontend/public/doku/case_schema_v1.json,
Abschnitt #/$defs/AuditEintrag).

Kein Schreibzugriff auf irgendeine DB — die Patches gehen in v1 nur
nach stdout. Backend-Reducer wird sie spaeter konsumieren.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _audit_id() -> str:
    return f"a_{uuid.uuid4().hex[:12]}"


@dataclass
class StatePatch:
    """Ein RFC-6902-konformer Patch gegen case_state v1."""

    case_id: str
    revision: int
    actor: str  # "sturm" | "lane1" | ... siehe AuditEintrag.actor enum
    tool: str   # applyTool-Tool-Name (BELEG_HINZUFUEGEN, FELD_SETZEN, ...)
    ops: list[dict]
    ts: str = field(default_factory=_now_iso)
    audit_id: str = field(default_factory=_audit_id)
    actor_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    vorherige_revision: Optional[int] = None
    kommentar: Optional[str] = None
    ursache_audit_id: Optional[str] = None

    def to_event(self) -> dict:
        """Format fuer Eventbus-Stream (state.patch)."""
        d = asdict(self)
        # entferne None-Felder fuer schmaleren Stream
        return {k: v for k, v in d.items() if v is not None}

    def to_json(self) -> str:
        return json.dumps(self.to_event(), ensure_ascii=False)


# ──────────────────────────────────────────────────────────────────────
# Helper-Funktionen — bauen typische Patches
# ──────────────────────────────────────────────────────────────────────


def make_beleg_patch(
    case_id: str,
    revision: int,
    beleg: dict,
    actor: str = "sturm",
    actor_id: Optional[str] = None,
) -> StatePatch:
    """BELEG_HINZUFUEGEN — append /belege/-."""
    return StatePatch(
        case_id=case_id,
        revision=revision,
        actor=actor,
        actor_id=actor_id,
        tool="BELEG_HINZUFUEGEN",
        ops=[{"op": "add", "path": "/belege/-", "value": beleg}],
    )


def make_klassifikation_patch(
    case_id: str,
    revision: int,
    beleg_id: str,
    beleg_index: int,
    klassifikation: dict,
    actor: str = "sturm",
) -> StatePatch:
    """BELEG_KLASSIFIZIERT — Pass-1-Output (doc_type + anlagen_hints + ggf.
    sub_anlagen) als eigener Reducer-Call, damit der Backend-Reducer
    BELEG_KLASSIFIZIERT die Felder /belege/{idx}/typ, /doc_typ_konfidenz,
    /anlagen_hints, /steuerjahr_des_belegs, /primaere_anlage und
    /sub_anlagen sauber pflegt.

    Wird NACH BELEG_HINZUFUEGEN/-_ANGENOMMEN emittiert: erst gibt es den
    Beleg-Eintrag, dann die Klassifikation darauf.

    `klassifikation` enthält den vollen Backend-Payload — beleg_id,
    typ, doc_typ_konfidenz, anlagen_hints, sub_anlagen[], steuerjahr,
    primaere_anlage. Der backend_emitter mappt das 1:1 auf die
    Reducer-Signatur (siehe TOOL_MAPPING).
    """
    payload = {**klassifikation, "beleg_id": beleg_id}
    return StatePatch(
        case_id=case_id,
        revision=revision,
        actor=actor,
        tool="BELEG_KLASSIFIZIERT",
        ops=[
            {
                "op": "replace",
                "path": f"/belege/{beleg_index}/klassifikation",
                "value": payload,
            },
        ],
        kommentar=f"Pass-1-Klassifikation fuer beleg {beleg_id}",
    )


def make_sub_anlage_patch(
    case_id: str,
    revision: int,
    beleg_id: str,
    beleg_index: int,
    sub_anlage: dict,
    actor: str = "sturm",
) -> StatePatch:
    """SUB_ANLAGE_HINZUFUEGEN — append /belege/{idx}/sub_anlagen/-.

    Ab v1.2 nimmt der Backend-Reducer beleg_id+sub_anlagen-Bulk; wir packen
    deshalb beleg_id mit in den value-Dict, damit der Adapter im
    backend_emitter sie auslesen kann.
    """
    enriched = {**sub_anlage, "beleg_id": beleg_id}
    return StatePatch(
        case_id=case_id,
        revision=revision,
        actor=actor,
        tool="SUB_ANLAGE_HINZUFUEGEN",
        ops=[{"op": "add", "path": f"/belege/{beleg_index}/sub_anlagen/-", "value": enriched}],
        kommentar=f"sub_anlage fuer beleg {beleg_id}",
    )


def make_person_patch(
    case_id: str,
    revision: int,
    person: dict,
    actor: str = "sturm",
) -> StatePatch:
    """PERSON_HINZUFUEGEN — append /personen/-."""
    return StatePatch(
        case_id=case_id,
        revision=revision,
        actor=actor,
        tool="PERSON_HINZUFUEGEN",
        ops=[{"op": "add", "path": "/personen/-", "value": person}],
    )


def make_feld_patch(
    case_id: str,
    revision: int,
    pfad: str,
    feld: dict,
    elster_code: str,
    actor: str = "sturm",
) -> StatePatch:
    """FELD_SETZEN — write deterministisch[pfad] und nach_elster_code-Index."""
    # JSON-Pointer: '/' und '~' muessen escaped werden (~1, ~0)
    safe = pfad.replace("~", "~0").replace("/", "~1")
    return StatePatch(
        case_id=case_id,
        revision=revision,
        actor=actor,
        tool="FELD_SETZEN",
        ops=[
            {"op": "add", "path": f"/felder/deterministisch/{safe}", "value": feld},
            # Index pflegt der Reducer normalerweise; wir liefern Hinweis-Op zur Demo.
            {"op": "add", "path": f"/felder/nach_elster_code/{elster_code}/-", "value": pfad},
        ],
        kommentar=f"feld {pfad} = {feld.get('wert')!r} ({elster_code})",
    )


def make_warnung_patch(
    case_id: str,
    revision: int,
    warnung: dict,
    actor: str = "sturm",
) -> StatePatch:
    """WARNUNG_REGISTRIEREN — append /warnungen/-."""
    return StatePatch(
        case_id=case_id,
        revision=revision,
        actor=actor,
        tool="WARNUNG_REGISTRIEREN",
        ops=[{"op": "add", "path": "/warnungen/-", "value": warnung}],
    )


def make_flag_patch(
    case_id: str,
    revision: int,
    flag_name: str,
    flag_wert: Any,
    actor: str = "sturm",
    kommentar: Optional[str] = None,
) -> StatePatch:
    """FLAG_SETZEN — set /flags/{name}. v1.1 schema."""
    return StatePatch(
        case_id=case_id,
        revision=revision,
        actor=actor,
        tool="FLAG_SETZEN",
        ops=[{"op": "add", "path": f"/flags/{flag_name}", "value": flag_wert}],
        kommentar=kommentar or f"flag {flag_name} = {flag_wert!r}",
    )


def make_lane_status_patch(
    case_id: str,
    revision: int,
    lane: str,  # 'sturm' | 'lane1' | 'lane2' | 'lane5'
    status: str,
    aktueller_task: Optional[str] = None,
    actor: str = "sturm",
) -> StatePatch:
    """LANES_STATUS_AKTUALISIEREN — replace /lanes_status/{lane}."""
    body: dict[str, Any] = {"status": status, "last_seen": _now_iso()}
    if aktueller_task:
        body["aktueller_task"] = aktueller_task
    return StatePatch(
        case_id=case_id,
        revision=revision,
        actor=actor,
        tool="LANES_STATUS_AKTUALISIEREN",
        ops=[{"op": "replace", "path": f"/lanes_status/{lane}", "value": body}],
    )
