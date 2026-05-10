"""
Pass 2 — Tiefe strukturierte Extraktion pro sub_anlage (parallel).

Pro sub_anlage aus Pass 1:
  1. POST http://localhost:7820/smart-schema  (Smart-Schema-Service / Agent E)
     -> erhaelt Pydantic-JSON-Schema + Mistral-Function-Schema fuer diese Anlage.
  2. Mistral Large mit OCR-Text + Function-Schema aufrufen.
  3. Antwort parsen, ELSTER-Code-Annotation aus Schema-Description rueckgewinnen.
  4. ExtrahiertesFeld-Liste yielden.

Parallelisierung via asyncio.gather.
Bei Smart-Schema-Service-Ausfall: Smart-Schema lokal aus dem Heuristik-Cache.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional

import httpx

from mistral_client import MistralClient, LARGE_MODEL, StreamingChunk
from pass1_klassifikation import SubAnlageHint

log = logging.getLogger("sturm.pass2")

SMART_SCHEMA_URL = "http://localhost:7820"


@dataclass
class ExtrahiertesFeld:
    feld_name: str            # Sprechender Feldname aus dem Smart-Schema
    wert: Any                 # extrahierter Wert
    elster_code: str          # offizielle ELSTER-Kennzahl
    anlagen: list[str]        # n:m
    primaere_anlage: str
    person_idnr: Optional[str] = None
    person_id_lokal: Optional[str] = None
    konfidenz: float = 0.7
    quellzitat: Optional[dict] = None  # {seite, text_snippet, ...}
    sub_id: Optional[str] = None       # Quell-sub_anlage


@dataclass
class Pass2SubResult:
    sub_id: str
    anlage: str
    person_id_lokal: Optional[str]
    n_felder: int
    felder: list[ExtrahiertesFeld] = field(default_factory=list)
    dauer_ms: int = 0
    fehler: Optional[str] = None
    schema_n_felder: int = 0  # wieviel das Smart-Schema definiert hat
    # Streaming-Latenzen
    t_first_field_ms: Optional[int] = None
    t_last_field_ms: Optional[int] = None


@dataclass
class Pass2FeldEvent:
    """Streaming-Event: ein einzelnes Feld ist fertig extrahiert + ELSTER-mapped.

    Wird vom Streaming-Pfad emittiert, sobald der inkrementelle JSON-Parser
    ein Top-Level-Item geschlossen hat. Pipeline kann dann sofort einen
    StatePatch downstream senden.
    """

    sub_id: str
    anlage: str
    person_id_lokal: Optional[str]
    feld: ExtrahiertesFeld
    feld_index: int  # i-tes Feld dieser sub_anlage
    elapsed_ms: int  # ms seit Start dieser sub_anlage


# ──────────────────────────────────────────────────────────────────────
# Smart-Schema-Service Client
# ──────────────────────────────────────────────────────────────────────


async def _hole_smart_schema(
    httpc: httpx.AsyncClient,
    anlagen: list[str],
    steuerjahr: int,
    person_idnrs: Optional[list[str]] = None,
    doc_type: Optional[str] = None,
) -> dict:
    """POST /smart-schema und gibt das vollstaendige Response-Dict zurueck."""
    resp = await httpc.post(
        f"{SMART_SCHEMA_URL}/smart-schema",
        json={
            "anlagen": anlagen,
            "steuerjahr": steuerjahr,
            "person_idnrs": person_idnrs,
            "doc_type": doc_type,
        },
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


# ──────────────────────────────────────────────────────────────────────
# Prompt fuer Pass 2
# ──────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "Du bist ein praeziser deutscher Steuerfeld-Extraktor. "
    "Du erhaeltst OCR-Text einer Anlage einer Steuererklaerung und ein "
    "Funktionsschema mit ELSTER-Codes. Rufe das Tool genau einmal mit den "
    "extrahierten Werten auf. Felder ohne Wert lasse weg. Geldbetraege als "
    "Zahlen (Punkt als Dezimaltrenner). IdNr als 11-stelliger String. "
    "Datum YYYY-MM-DD. Steuerklasse als Ziffer 1-6."
)


def _baue_user_prompt(
    anlage: str,
    sub_id: str,
    person_hint: Optional[str],
    seiten: list[int],
    sub: Optional[SubAnlageHint] = None,
) -> str:
    person_hinweis = ""
    if person_hint:
        person_hinweis = (
            f"\nDiese Anlage gehoert vermutlich zu Person {person_hint} "
            "(steuerpflichtiger A=p_a, Ehegatte B=p_b)."
        )
    vast_hinweis = ""
    if sub and sub.vast_typ:
        idnr_txt = sub.vast_empfaenger_idnr or "?"
        ueber = sub.vast_uebermittler or "?"
        status = "ÜBERNOMMEN" if sub.vast_uebernommen else "NICHT übernommen"
        vast_hinweis = (
            f"\n--- VAST-Kontext ---"
            f"\nDies ist eine VAST-Bescheinigung vom Finanzamt (Steuer-Abruf)."
            f"\nTyp: {sub.vast_typ}"
            f"\nÜbermittler: {ueber}"
            f"\nEmpfänger-IdNr: {idnr_txt}"
            f"\nStatus: {status}"
            f"\nWichtig bei Lohnsteuerbescheinigungen: Achte besonders auf Zeile 19 "
            f"(Entschädigungen / Arbeitslohn für mehrere Kalenderjahre — §34 EStG-Trigger)."
        )
    seiten_str = f"Seiten {seiten}" if seiten else "alle Seiten"
    return (
        f"Extrahiere alle erkennbaren ELSTER-Felder aus Anlage '{anlage}' "
        f"({sub_id}, {seiten_str}). Rufe das Tool 'extrahiere_*' EINMAL mit "
        f"allen erkannten Feldern auf.{person_hinweis}{vast_hinweis}"
    )


# ──────────────────────────────────────────────────────────────────────
# Response-Parser
# ──────────────────────────────────────────────────────────────────────

# In smart_schema-Description steht u.a.:
#   "ELSTER-Code: E0200204. Anlage: N, Zeile 3. Type: float. ..."
# ODER bei der live Smart-Schema-Service-Variante:
#   "ELSTER-Code: 110. Anlage: N. Type: str. Primaere Anlage: N."
# Wir akzeptieren beides — alphanumerisch.
_ELSTER_CODE_RE = re.compile(r"ELSTER-Code:\s*([A-Za-z0-9._-]+)")
_ANLAGE_RE = re.compile(r"Anlage:\s*([A-Za-z0-9_]+)")
_PRIMAER_RE = re.compile(r"Prim[aä]ere Anlage:\s*([A-Za-z0-9_]+)")
_WEITERE_RE = re.compile(r"Weitere Anlagen:\s*([A-Za-z0-9_,\s]+?)(?:\.|$)")


def _meta_aus_description(desc: Optional[str]) -> dict:
    """Holt {elster_code, primaere_anlage, anlagen[]} aus dem Description-String."""
    if not desc:
        return {}
    out: dict = {}
    if m := _ELSTER_CODE_RE.search(desc):
        out["elster_code"] = m.group(1)
    if m := _PRIMAER_RE.search(desc):
        out["primaere_anlage"] = m.group(1)
    elif m := _ANLAGE_RE.search(desc):
        out["primaere_anlage"] = m.group(1)
    anlagen = []
    if "primaere_anlage" in out:
        anlagen.append(out["primaere_anlage"])
    if m := _WEITERE_RE.search(desc):
        for a in m.group(1).split(","):
            a = a.strip()
            if a and a not in anlagen:
                anlagen.append(a)
    out["anlagen"] = anlagen or ([out["primaere_anlage"]] if "primaere_anlage" in out else [])
    return out


def _parse_single_field_dict(
    feld_obj: dict,
    pydantic_json_schema: dict,
    sub: SubAnlageHint,
) -> Optional[ExtrahiertesFeld]:
    """Mappt EIN dict (so wie es aus dem inkrementellen Parser kommt) auf
    ein ExtrahiertesFeld.

    Erwartet die NEUE Streaming-Schema-Form:
        {"feld_name": "...", "wert": ..., "elster_code": "..."}

    Falls `elster_code` direkt im dict steht, nutze ihn. Falls nicht,
    versuche ihn aus pydantic_json_schema['properties'][feld_name]['description']
    zu rekonstruieren (Backward-Compat zum alten flachen Schema).
    """
    feld_name = feld_obj.get("feld_name")
    wert = feld_obj.get("wert")
    if not feld_name or wert is None or wert == "":
        return None

    elster_code = feld_obj.get("elster_code")
    primaer = feld_obj.get("primaere_anlage")
    anlagen = feld_obj.get("anlagen") or []

    # Fallback: aus description rekonstruieren (alte Schema-Form)
    if not elster_code:
        properties = (pydantic_json_schema.get("properties") or {})
        prop = properties.get(feld_name) or {}
        meta = _meta_aus_description(prop.get("description"))
        elster_code = meta.get("elster_code")
        primaer = primaer or meta.get("primaere_anlage")
        anlagen = anlagen or meta.get("anlagen") or []

    if not elster_code:
        log.warning("kein elster_code fuer feld '%s' (sub=%s) — geskippt",
                    feld_name, sub.sub_id)
        return None

    primaer = primaer or sub.anlage
    if not anlagen:
        anlagen = [primaer]

    return ExtrahiertesFeld(
        feld_name=feld_name,
        wert=wert,
        elster_code=elster_code,
        anlagen=anlagen,
        primaere_anlage=primaer,
        person_idnr=sub.vast_empfaenger_idnr,
        person_id_lokal=sub.person_hint,
        konfidenz=0.9 if sub.vast_typ else 0.85,
        sub_id=sub.sub_id,
    )


def _parse_extraction_response(
    response_args: dict,
    pydantic_json_schema: dict,
    sub: SubAnlageHint,
) -> list[ExtrahiertesFeld]:
    """Mappt Mistral-Antwort auf ExtrahiertesFeld[] mit ELSTER-Code-Annotation."""
    # Variante A (Streaming-Schema): {"felder": [{"feld_name": ..., "wert": ..., "elster_code": ...}, ...]}
    if isinstance(response_args.get("felder"), list):
        out_streaming: list[ExtrahiertesFeld] = []
        for item in response_args["felder"]:
            if not isinstance(item, dict):
                continue
            f = _parse_single_field_dict(item, pydantic_json_schema, sub)
            if f is not None:
                out_streaming.append(f)
        return out_streaming

    # Variante B (klassisches flaches Schema): {feld_name: wert, ...}
    properties = (pydantic_json_schema.get("properties") or {})
    out: list[ExtrahiertesFeld] = []
    for feld_name, wert in response_args.items():
        if wert is None or wert == "":
            continue
        prop = properties.get(feld_name) or {}
        meta = _meta_aus_description(prop.get("description"))
        ec = meta.get("elster_code")
        if not ec:
            log.warning("Kein ELSTER-Code in description fuer feld '%s' — geskippt.", feld_name)
            continue
        primaer = meta.get("primaere_anlage") or sub.anlage
        anlagen = meta.get("anlagen") or [primaer]
        out.append(
            ExtrahiertesFeld(
                feld_name=feld_name,
                wert=wert,
                elster_code=ec,
                anlagen=anlagen,
                primaere_anlage=primaer,
                # Bei VAST: IdNr direkt setzen (Pass 3 nutzt das primär).
                person_idnr=sub.vast_empfaenger_idnr,
                person_id_lokal=sub.person_hint,
                konfidenz=0.9 if sub.vast_typ else 0.85,
                sub_id=sub.sub_id,
            )
        )
    return out


# ──────────────────────────────────────────────────────────────────────
# VAST religionsabruf — synthese ohne Mistral-Call.
# Werte stehen schon strukturiert in sub.vast_inline_felder; wir bauen
# direkt zwei ExtrahiertesFeld-Objekte (IdNr + Religion).
# ──────────────────────────────────────────────────────────────────────


# Heuristische ELSTER-Codes für Religion+IdNr in Anlage ESt1A.
# Pass 3 validiert nur das Format (E\d+) — die genauen Codes pflegt
# meta_label-Tabelle in Production. Wir nutzen plausible Werte aus der
# offiziellen XSD: E0100201 = IdNr Stpfl., E0102501 = Religion (heuristisch).
_RELI_IDNR_CODE = "E0100201"
_RELI_RELIGION_CODE = "E0102501"


def _religionsabruf_synthese(sub: SubAnlageHint, start: float) -> Pass2SubResult:
    """Erzeugt 2 Felder direkt aus den Inline-Werten der Religionsabruf-Bescheinigung."""
    inline = sub.vast_inline_felder or {}
    felder: list[ExtrahiertesFeld] = []
    idnr = inline.get("idnr") or sub.vast_empfaenger_idnr
    religion = inline.get("religion")

    if idnr:
        felder.append(ExtrahiertesFeld(
            feld_name="identifikationsnummer",
            wert=idnr,
            elster_code=_RELI_IDNR_CODE,
            anlagen=["ESt1A"],
            primaere_anlage="ESt1A",
            person_idnr=idnr,
            konfidenz=0.99,
            sub_id=sub.sub_id,
            quellzitat={"sub_id": sub.sub_id, "uebermittler": sub.vast_uebermittler},
        ))
    if religion:
        felder.append(ExtrahiertesFeld(
            feld_name="religion",
            wert=religion,
            elster_code=_RELI_RELIGION_CODE,
            anlagen=["ESt1A"],
            primaere_anlage="ESt1A",
            person_idnr=idnr,
            konfidenz=0.99,
            sub_id=sub.sub_id,
            quellzitat={"sub_id": sub.sub_id, "uebermittler": sub.vast_uebermittler},
        ))

    return Pass2SubResult(
        sub_id=sub.sub_id,
        anlage=sub.anlage,
        person_id_lokal=sub.person_hint,
        n_felder=len(felder),
        felder=felder,
        dauer_ms=int((time.time() - start) * 1000),
        schema_n_felder=len(felder),  # Skip-Pfad; n_felder == "Schema-Felder"
    )


# ──────────────────────────────────────────────────────────────────────
# Pass-2-Worker (eine sub_anlage)
# ──────────────────────────────────────────────────────────────────────


def _baue_streaming_function_schema(
    flat_schema: dict,
    pydantic_schema: dict,
    anlage: str,
) -> dict:
    """Wrapt das flache Smart-Schema in eine Array-Form, damit Streaming-Parser
    pro Feld ein vollstaendiges Item bekommt.

    Eingabe (flat_schema):
        {"type":"function","function":{"name":"extrahiere_n",
         "parameters":{"type":"object","properties":{
           "bruttolohn": {"type":"number","description":"ELSTER-Code: E0200204..."},
           ...
         }}}}

    Ausgabe (Streaming-Schema):
        {"type":"function","function":{"name":"extrahiere_<anlage>_streaming",
         "parameters":{"type":"object","properties":{
           "felder": {"type":"array","items":{
             "type":"object",
             "properties":{
               "feld_name":{"type":"string","enum":[<alle keys>]},
               "wert":{},
               "elster_code":{"type":"string"},
               "primaere_anlage":{"type":"string"}
             },
             "required":["feld_name","wert","elster_code"]
           }}
         },"required":["felder"]}}}

    Damit emittiert Mistral pro Token-Chunk Tool-Call-Args wie:
        {"felder": [
            {"feld_name": "bruttolohn", "wert": 49500, "elster_code": "E0200204"},
            {"feld_name": "lohnsteuer", "wert": 7842, "elster_code": "E0200304"},
            ...
        ]}

    Und der inkrementelle Parser kann nach jedem '}' ein Item emittieren.
    """
    fn = flat_schema.get("function") if flat_schema.get("type") == "function" else flat_schema
    inner_props = (fn.get("parameters") or {}).get("properties") or {}
    feld_namen = list(inner_props.keys())

    # Description-Hilfe: pro feld_name knappe Hint-String fuer Mistral
    feld_desc_lines = []
    for fn_name in feld_namen[:80]:  # cap fuer Prompt-Laenge
        desc = (inner_props[fn_name].get("description") or "")[:120]
        feld_desc_lines.append(f"  - {fn_name}: {desc}")
    feld_hints = "\n".join(feld_desc_lines)

    return {
        "type": "function",
        "function": {
            "name": (fn.get("name") or f"extrahiere_{anlage}") + "_streaming",
            "description": (
                f"Extrahiere ELSTER-Felder aus Anlage '{anlage}'. "
                f"Erlaubte feld_name-Werte und ihre ELSTER-Codes:\n{feld_hints}"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "felder": {
                        "type": "array",
                        "description": (
                            "Liste aller extrahierten Felder. Pro Feld: "
                            "feld_name (aus erlaubter Liste), wert, elster_code "
                            "(z.B. E0200204)."
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "feld_name": {
                                    "type": "string",
                                    "enum": feld_namen,
                                    "description": "Name des Felds (aus erlaubter Liste)",
                                },
                                "wert": {
                                    "description": "Extrahierter Wert. Zahlen als Number, IdNr/Datum als String.",
                                },
                                "elster_code": {
                                    "type": "string",
                                    "description": "Offizielle ELSTER-Kennzahl (z.B. E0200204).",
                                },
                                "primaere_anlage": {
                                    "type": "string",
                                    "description": "Primaere Anlage, z.B. N, KAP, VOR, ESt1A.",
                                },
                            },
                            "required": ["feld_name", "wert", "elster_code"],
                        },
                    },
                },
                "required": ["felder"],
            },
        },
    }


async def _verarbeite_sub_anlage_streaming(
    sub: SubAnlageHint,
    ocr_text: str,
    seiten_text: list[str],
    steuerjahr: int,
    doc_type: Optional[str],
    httpc: httpx.AsyncClient,
    mistral: MistralClient,
    feld_callback,  # Callable[[Pass2FeldEvent], None] | async
) -> Pass2SubResult:
    """Streaming-Variante: ruft `feld_callback(event)` pro fertigem Feld auf."""
    start = time.time()
    sub_text = _seiten_text_fuer_sub(sub, seiten_text, ocr_text)

    # ── VAST religionsabruf — Skip Mistral ────────────────────────────
    if sub.vast_typ == "religionsabruf":
        sr = _religionsabruf_synthese(sub, start)
        # Auch synthetische Felder als Events emittieren
        for i, f in enumerate(sr.felder):
            elapsed = int((time.time() - start) * 1000)
            ev = Pass2FeldEvent(
                sub_id=sub.sub_id, anlage=sub.anlage,
                person_id_lokal=sub.person_hint, feld=f,
                feld_index=i, elapsed_ms=elapsed,
            )
            if i == 0:
                sr.t_first_field_ms = elapsed
            sr.t_last_field_ms = elapsed
            res = feld_callback(ev)
            if asyncio.iscoroutine(res):
                await res
        return sr

    # 1. Smart-Schema holen
    try:
        schema_resp = await _hole_smart_schema(
            httpc=httpc, anlagen=[sub.anlage],
            steuerjahr=steuerjahr, doc_type=doc_type,
        )
    except Exception as e:
        return Pass2SubResult(
            sub_id=sub.sub_id, anlage=sub.anlage,
            person_id_lokal=sub.person_hint, n_felder=0,
            dauer_ms=int((time.time() - start) * 1000),
            fehler=f"Smart-Schema-Service-Fehler: {e}",
        )

    flat_fn_schema = schema_resp.get("mistral_function_schema") or {}
    py_schema = schema_resp.get("pydantic_json_schema") or {}
    schema_n_felder = int(schema_resp.get("n_felder", 0))

    if schema_n_felder == 0:
        return Pass2SubResult(
            sub_id=sub.sub_id, anlage=sub.anlage,
            person_id_lokal=sub.person_hint, n_felder=0,
            dauer_ms=int((time.time() - start) * 1000),
            schema_n_felder=0,
            fehler=f"Smart-Schema leer fuer Anlage '{sub.anlage}'",
        )

    # 2. Streaming-Schema bauen + Mistral streamen
    streaming_schema = _baue_streaming_function_schema(
        flat_fn_schema, py_schema, sub.anlage,
    )
    user_prompt = _baue_user_prompt(
        sub.anlage, sub.sub_id, sub.person_hint, sub.seiten, sub=sub,
    )

    felder_collected: list[ExtrahiertesFeld] = []
    feld_index = 0
    first_field_ms: Optional[int] = None
    last_field_ms: Optional[int] = None

    try:
        async for chunk in mistral.extract_structured_streaming(
            text=sub_text,
            function_schema=streaming_schema,
            system_prompt=SYSTEM_PROMPT_STREAMING,
            user_prompt=user_prompt,
            model=LARGE_MODEL,
            temperature=0.1,
            max_tokens=8000,
            array_property="felder",
        ):
            if chunk.chunk_type == "completed_field" and chunk.completed_field:
                f = _parse_single_field_dict(chunk.completed_field, py_schema, sub)
                if f is None:
                    continue
                felder_collected.append(f)
                elapsed = int((time.time() - start) * 1000)
                if first_field_ms is None:
                    first_field_ms = elapsed
                    log.info("STREAM sub=%s T_first_field=%dms", sub.sub_id, elapsed)
                last_field_ms = elapsed
                ev = Pass2FeldEvent(
                    sub_id=sub.sub_id, anlage=sub.anlage,
                    person_id_lokal=sub.person_hint, feld=f,
                    feld_index=feld_index, elapsed_ms=elapsed,
                )
                feld_index += 1
                res = feld_callback(ev)
                if asyncio.iscoroutine(res):
                    await res
            elif chunk.chunk_type == "done":
                pass  # Stream-Ende
    except Exception as e:
        return Pass2SubResult(
            sub_id=sub.sub_id, anlage=sub.anlage,
            person_id_lokal=sub.person_hint,
            n_felder=len(felder_collected), felder=felder_collected,
            dauer_ms=int((time.time() - start) * 1000),
            schema_n_felder=schema_n_felder,
            fehler=f"Mistral-Stream-Fehler: {e}",
            t_first_field_ms=first_field_ms,
            t_last_field_ms=last_field_ms,
        )

    return Pass2SubResult(
        sub_id=sub.sub_id, anlage=sub.anlage,
        person_id_lokal=sub.person_hint,
        n_felder=len(felder_collected), felder=felder_collected,
        dauer_ms=int((time.time() - start) * 1000),
        schema_n_felder=schema_n_felder,
        t_first_field_ms=first_field_ms,
        t_last_field_ms=last_field_ms,
    )


# Streaming-spezifischer System-Prompt (legt Array-Form fest)
SYSTEM_PROMPT_STREAMING = (
    "Du bist ein praeziser deutscher Steuerfeld-Extraktor. "
    "Du erhaeltst OCR-Text einer Anlage einer Steuererklaerung und ein "
    "Funktionsschema. Rufe das Tool genau einmal mit einer 'felder'-Liste auf. "
    "Pro erkanntes Feld emittiere ein Element {feld_name, wert, elster_code}. "
    "Felder ohne Wert lasse weg. Geldbetraege als Zahlen (Punkt als Dezimaltrenner). "
    "IdNr als 11-stelliger String. Datum YYYY-MM-DD. Steuerklasse als Ziffer 1-6. "
    "WICHTIG: Emittiere die Felder in der Reihenfolge, in der sie im Dokument "
    "auftauchen, damit fruehe Felder schnell sichtbar werden."
)


async def _verarbeite_sub_anlage(
    sub: SubAnlageHint,
    ocr_text: str,
    seiten_text: list[str],
    steuerjahr: int,
    doc_type: Optional[str],
    httpc: httpx.AsyncClient,
    mistral: MistralClient,
) -> Pass2SubResult:
    """Holt Schema, ruft Mistral, parst Antwort.

    VAST-Spezialfälle:
      * religionsabruf → kein Mistral-Call (Werte sind schon strukturiert
        in sub.vast_inline_felder vorhanden) — wir bauen synthetische
        ExtrahiertesFeld-Objekte.
      * Andere VAST-Typen → Smart-Schema-Anlagen kommen aus ziel_anlagen
        (mehrere Anlagen, z.B. ['N','VOR']).
    """
    start = time.time()
    sub_text = _seiten_text_fuer_sub(sub, seiten_text, ocr_text)

    # ── VAST religionsabruf — Skip Mistral ────────────────────────────
    if sub.vast_typ == "religionsabruf":
        return _religionsabruf_synthese(sub, start)

    # Welche Anlagen ans Smart-Schema?  Bei VAST nehmen wir die
    # ziel_anlagen aus Pass 1 (z.B. KAP für KapErtrag-Mitteilung); sonst
    # die einzelne sub.anlage.
    anlagen_request: list[str]
    if sub.vast_typ:
        # Für VAST: alle ziel_anlagen abfragen (oder fallback auf sub.anlage)
        # Wir nutzen das Inline-Feld aus dem SubAnlageHint, das wir aus
        # bescheinigung.ziel_anlagen befüllen.
        # Da SubAnlageHint nur EINE primäre Anlage trägt, und ziel_anlagen
        # in Pass1Result.anlagen_hints reflektiert ist, fragen wir hier
        # nur die primäre an — die anderen werden über separate sub_anlagen
        # mit derselben Bescheinigung erfasst (Pass 1 emittiert eine
        # sub_anlage pro Bescheinigung; Multi-Anlagen wie ['N','VOR']
        # werden von Smart-Schema aus EINEM Anlagen-Code mitgeliefert).
        anlagen_request = [sub.anlage]
    else:
        anlagen_request = [sub.anlage]

    # 1. Smart-Schema holen
    try:
        schema_resp = await _hole_smart_schema(
            httpc=httpc,
            anlagen=anlagen_request,
            steuerjahr=steuerjahr,
            doc_type=doc_type,
        )
    except Exception as e:
        return Pass2SubResult(
            sub_id=sub.sub_id, anlage=sub.anlage, person_id_lokal=sub.person_hint,
            n_felder=0, dauer_ms=int((time.time() - start) * 1000),
            fehler=f"Smart-Schema-Service-Fehler: {e}",
        )

    fn_schema = schema_resp.get("mistral_function_schema") or {}
    py_schema = schema_resp.get("pydantic_json_schema") or {}
    schema_n_felder = int(schema_resp.get("n_felder", 0))

    if schema_n_felder == 0:
        return Pass2SubResult(
            sub_id=sub.sub_id, anlage=sub.anlage, person_id_lokal=sub.person_hint,
            n_felder=0, dauer_ms=int((time.time() - start) * 1000),
            schema_n_felder=0,
            fehler=f"Smart-Schema leer fuer Anlage '{sub.anlage}' (steuerjahr {steuerjahr})",
        )

    # 2. Mistral Large aufrufen
    user_prompt = _baue_user_prompt(sub.anlage, sub.sub_id, sub.person_hint, sub.seiten, sub=sub)
    try:
        args = await mistral.extract_structured(
            text=sub_text,
            function_schema=fn_schema,
            system_prompt=SYSTEM_PROMPT,
            user_prompt=user_prompt,
            model=LARGE_MODEL,
            temperature=0.1,
            max_tokens=8000,
        )
    except Exception as e:
        return Pass2SubResult(
            sub_id=sub.sub_id, anlage=sub.anlage, person_id_lokal=sub.person_hint,
            n_felder=0, dauer_ms=int((time.time() - start) * 1000),
            schema_n_felder=schema_n_felder,
            fehler=f"Mistral-Large-Fehler: {e}",
        )

    # 3. Parse
    felder = _parse_extraction_response(args, py_schema, sub)

    return Pass2SubResult(
        sub_id=sub.sub_id, anlage=sub.anlage, person_id_lokal=sub.person_hint,
        n_felder=len(felder), felder=felder,
        dauer_ms=int((time.time() - start) * 1000),
        schema_n_felder=schema_n_felder,
    )


def _seiten_text_fuer_sub(
    sub: SubAnlageHint,
    seiten_text: list[str],
    ocr_volltext: str,
) -> str:
    """Schneidet die fuer diese sub_anlage relevanten Seiten heraus."""
    if not seiten_text or not sub.seiten:
        return ocr_volltext
    relevante = []
    for p in sub.seiten:
        idx = p - 1  # 1-basiert -> 0-basiert
        if 0 <= idx < len(seiten_text):
            relevante.append(f"--- Seite {p} ---\n{seiten_text[idx]}")
    if not relevante:
        return ocr_volltext
    return "\n\n".join(relevante)


# ──────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────


async def extrahiere_alle_sub_anlagen(
    sub_anlagen: list[SubAnlageHint],
    ocr_text: str,
    seiten_text: list[str],
    steuerjahr: int,
    doc_type: Optional[str],
    mistral: MistralClient,
    max_parallel: int = 4,
) -> AsyncIterator[Pass2SubResult]:
    """
    Yieldt Pass2SubResult-Objekte sobald sie fertig sind (asyncio as_completed).
    Backward-compat: Non-streaming Pfad.
    """
    sem = asyncio.Semaphore(max_parallel)
    async with httpx.AsyncClient() as httpc:
        async def _bounded(sub: SubAnlageHint) -> Pass2SubResult:
            async with sem:
                return await _verarbeite_sub_anlage(
                    sub, ocr_text, seiten_text, steuerjahr, doc_type, httpc, mistral
                )

        tasks = [asyncio.create_task(_bounded(s)) for s in sub_anlagen]
        for fut in asyncio.as_completed(tasks):
            res = await fut
            yield res


async def extrahiere_alle_sub_anlagen_streaming(
    sub_anlagen: list[SubAnlageHint],
    ocr_text: str,
    seiten_text: list[str],
    steuerjahr: int,
    doc_type: Optional[str],
    mistral: MistralClient,
    max_parallel: int = 4,
) -> AsyncIterator[object]:
    """
    Streaming-Variante: yieldt sowohl `Pass2FeldEvent` (pro fertigem Feld)
    als auch `Pass2SubResult` (pro fertiger sub_anlage) interleaved.

    Caller kann per `isinstance(item, Pass2FeldEvent)` unterscheiden und
    pro Feld sofort einen StatePatch emittieren — Time-to-First-Chip wird
    deutlich besser, weil Mistral nicht erst die ganze Tool-Call-Antwort
    fertig schreiben muss.
    """
    queue: asyncio.Queue = asyncio.Queue()
    sem = asyncio.Semaphore(max_parallel)

    async def _bounded(sub: SubAnlageHint, httpc: httpx.AsyncClient) -> None:
        async with sem:
            async def _on_feld(ev: Pass2FeldEvent) -> None:
                await queue.put(ev)
            sr = await _verarbeite_sub_anlage_streaming(
                sub, ocr_text, seiten_text, steuerjahr, doc_type,
                httpc, mistral, _on_feld,
            )
            await queue.put(sr)

    async with httpx.AsyncClient() as httpc:
        tasks = [asyncio.create_task(_bounded(s, httpc)) for s in sub_anlagen]
        n_subs_left = len(sub_anlagen)
        try:
            while n_subs_left > 0:
                item = await queue.get()
                if isinstance(item, Pass2SubResult):
                    n_subs_left -= 1
                yield item
        finally:
            # Falls Caller frueher abbricht, alle tasks aufraeumen
            for t in tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
