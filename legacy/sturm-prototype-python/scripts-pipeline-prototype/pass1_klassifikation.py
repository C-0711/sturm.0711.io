"""
Pass 1 — Strukturerkennung mit kleinem Mistral-Modell.

Output: Pass1Result mit
  - doc_type             (z.B. 'einkommensteuererklaerung')
  - doc_type_konfidenz   (0..1)
  - profil_hints         (z.B. ['ARBEITNEHMER','KAPITALANLEGER'])
  - sub_anlagen[]        (eine pro Anlage im Container, mit Page-Range + person_hint)
  - key_fields[]         (3-5 Schluesselwerte fuer sofortiges UI-Feedback)

Wird gefuettert mit OCR-Volltext + Seitenzahl. Bleibt klein und schnell
(< 3 s laut Doku-Ziel).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Optional

from mistral_client import MistralClient, SMALL_MODEL
from pass1_vast import (
    VastBescheinigung, VastPass1Result, VastPersonHint,
    detect_vast_format, klassifiziere_vast,
)

log = logging.getLogger("sturm.pass1")


@dataclass
class SubAnlageHint:
    sub_id: str
    anlage: str
    seiten: list[int]
    person_hint: Optional[str] = None  # "p_a" / "p_b" / None
    konfidenz: float = 0.7
    # VAST-Erweiterung — None für ESt-Pfad
    vast_typ: Optional[str] = None              # 'religionsabruf', 'lohnsteuerbescheinigung', …
    vast_uebermittler: Optional[str] = None     # Bank/AG-Name
    vast_uebernommen: Optional[bool] = None     # True/False/None
    vast_empfaenger_idnr: Optional[str] = None  # 11-stellig
    vast_inline_felder: Optional[dict] = None   # bei religionsabruf: {idnr, religion}


@dataclass
class KeyField:
    feld_name: str
    wert: str
    seite: Optional[int] = None
    konfidenz: float = 0.7


@dataclass
class Pass1Result:
    doc_type: str
    doc_type_konfidenz: float
    profil_hints: list[str] = field(default_factory=list)
    anlagen_hints: dict[str, float] = field(default_factory=dict)
    sub_anlagen: list[SubAnlageHint] = field(default_factory=list)
    key_fields: list[KeyField] = field(default_factory=list)
    n_seiten: int = 0
    fehler: Optional[str] = None
    # Vast-spezifischer Anteil — nur bei doc_type == 'vast_steuerabruf' gefüllt.
    vast_personen: list["VastPersonHint"] = field(default_factory=list)
    vast_transferticket_datum: Optional[str] = None


SYSTEM_PROMPT = (
    "Du bist ein deutscher Steuer-Dokumentklassifikator. "
    "Du bekommst OCR-Text einer (moeglicherweise mehrseitigen) Steuerunterlage "
    "und erkennst: doc_type, profil_hints, sub_anlagen mit Seiten-Range, "
    "und 3-5 Key-Fields. Du antwortest NUR als JSON, keine Erklaerung."
)

USER_PROMPT_TMPL = """Erkenne die Struktur dieser deutschen Steuerunterlage.

Es kann sich um EINEN Beleg handeln (z.B. Lohnsteuerbescheinigung)
oder einen CONTAINER mit mehreren Anlagen (Einkommensteuererklaerung,
VAST). Bei Containern liste alle erkannten sub_anlagen mit Seiten-Range
auf.

Anlagen-Codes (ELSTER): ESt1A, N, KAP, VOR, SA, Kind, R, V, AgB, SO,
G, S, AUS, FW, HA_35a, EM_35c, Mob, AV, KAP_BET, KAP_I, N_AUS, R_AUS.

Doc-Types: einkommensteuererklaerung, vast_steuerabruf,
lohnsteuerbescheinigung, kapitalertragsbescheinigung, spendenquittung,
handwerkerrechnung, rentenbescheid, kontoauszug, sonstige.

Personen-Hints: 'p_a' = Steuerpflichtiger A, 'p_b' = Ehegatte B.
Bei klar zugeordneten Anlagen (z.B. 'Anlage N Person A') person_hint setzen.

Antworte NUR als JSON in diesem Format:
{
  "doc_type": "einkommensteuererklaerung",
  "doc_type_konfidenz": 0.95,
  "profil_hints": ["ARBEITNEHMER", "KAPITALANLEGER", "DOPPELVERDIENER"],
  "anlagen_hints": {"ESt1A": 0.99, "N": 0.95, "KAP": 0.9, "VOR": 0.85, "SA": 0.8},
  "sub_anlagen": [
    {"sub_id": "sub_est1a", "anlage": "ESt1A", "seiten": [1,2], "person_hint": null, "konfidenz": 0.95},
    {"sub_id": "sub_n_a",   "anlage": "N",     "seiten": [3],   "person_hint": "p_a", "konfidenz": 0.9}
  ],
  "key_fields": [
    {"feld_name": "name_steuerpflichtiger_a", "wert": "Mustermann, Max", "seite": 1, "konfidenz": 0.99},
    {"feld_name": "veranlagungsart", "wert": "Zusammenveranlagung", "seite": 1, "konfidenz": 0.95}
  ]
}

Gesamtseiten des Dokuments: {n_seiten}
"""


async def klassifiziere(
    ocr_text: str,
    n_seiten: int,
    client: MistralClient,
    dateiname: str = "",
) -> Pass1Result:
    """Ruft Mistral-Small zur Strukturerkennung.

    Top-Level-Switch: ist das ein VAST-Doc → eigene Klassifikation
    (`klassifiziere_vast`) → mappet auf gemeinsamen Pass1Result.
    Sonst klassischer ESt-Pfad.
    """
    if not ocr_text.strip():
        return Pass1Result(
            doc_type="sonstige",
            doc_type_konfidenz=0.0,
            n_seiten=n_seiten,
            fehler="leerer OCR-Text",
        )

    # ── VAST-Detection ────────────────────────────────────────────
    if await detect_vast_format(ocr_text, dateiname):
        log.info("VAST-Format erkannt (dateiname=%s) — pass1_vast wird benutzt.", dateiname)
        # Erstversuch: LLM. Bei Fehler → bereits in pass1_vast eingebaute
        # Heuristik. Wir mappen am Ende auf Pass1Result.
        v: VastPass1Result = await klassifiziere_vast(ocr_text, n_seiten, client)
        return _vast_zu_pass1(v)

    try:
        data = await client.extract_json(
            text=ocr_text,
            system_prompt=SYSTEM_PROMPT,
            user_prompt=USER_PROMPT_TMPL.replace("{n_seiten}", str(n_seiten)),
            model=SMALL_MODEL,
            temperature=0.1,
            max_tokens=2000,
        )
    except Exception as e:
        log.exception("Pass 1 LLM-Call fehlgeschlagen.")
        return _heuristik_fallback(ocr_text, n_seiten, fehler=str(e))

    return _parse_response(data, n_seiten)


def _parse_response(data: dict, n_seiten: int) -> Pass1Result:
    sub_anlagen: list[SubAnlageHint] = []
    for s in data.get("sub_anlagen") or []:
        try:
            sub_anlagen.append(
                SubAnlageHint(
                    sub_id=str(s.get("sub_id") or f"sub_{s.get('anlage','x').lower()}"),
                    anlage=str(s["anlage"]),
                    seiten=[int(p) for p in (s.get("seiten") or [])],
                    person_hint=(s.get("person_hint") or None),
                    konfidenz=float(s.get("konfidenz", 0.7)),
                )
            )
        except (KeyError, ValueError, TypeError) as e:
            log.warning("sub_anlage geskippt: %s (%s)", s, e)

    key_fields: list[KeyField] = []
    for k in data.get("key_fields") or []:
        try:
            key_fields.append(
                KeyField(
                    feld_name=str(k["feld_name"]),
                    wert=str(k["wert"]),
                    seite=int(k["seite"]) if k.get("seite") else None,
                    konfidenz=float(k.get("konfidenz", 0.7)),
                )
            )
        except (KeyError, ValueError, TypeError):
            continue

    return Pass1Result(
        doc_type=str(data.get("doc_type", "sonstige")),
        doc_type_konfidenz=float(data.get("doc_type_konfidenz", 0.5)),
        profil_hints=list(data.get("profil_hints") or []),
        anlagen_hints={str(k): float(v) for k, v in (data.get("anlagen_hints") or {}).items()},
        sub_anlagen=sub_anlagen,
        key_fields=key_fields,
        n_seiten=n_seiten,
    )


# ──────────────────────────────────────────────────────────────────────
# Heuristik-Fallback (wenn LLM nicht erreichbar) — sehr grob
# ──────────────────────────────────────────────────────────────────────


_ANLAGEN_KEYWORDS: dict[str, str] = {
    "ESt1A": r"Mantelbogen|ESt 1 A|Hauptvordruck|Einkommensteuererkl",
    "N": r"Anlage N\b|Nichtselbstaendig|Bruttoarbeitslohn",
    "KAP": r"Anlage KAP\b|Kapitalertr|Zinsertr",
    "VOR": r"Anlage Vorsorge|Vorsorgeaufwendungen|Beitraege zur Krankenvers",
    "SA": r"Anlage Sonderausgaben|Spenden|Kirchensteuer",
    "Kind": r"Anlage Kind\b|Kindergeld",
    "R": r"Anlage R\b|Rente",
    "V": r"Anlage V\b|Vermietung",
    "AgB": r"Anlage AgB|aussergewoehnliche Belastungen",
    "HA_35a": r"haushaltsnahe|35a EStG",
}


def _heuristik_fallback(ocr_text: str, n_seiten: int, fehler: str) -> Pass1Result:
    """Kein LLM -> Keyword-Heuristik. Nur fuer Demo, wenn Mistral down."""
    hits: dict[str, float] = {}
    for anlage, pat in _ANLAGEN_KEYWORDS.items():
        if re.search(pat, ocr_text, re.IGNORECASE):
            hits[anlage] = 0.6
    sub_anlagen = [
        SubAnlageHint(
            sub_id=f"sub_{a.lower()}",
            anlage=a,
            seiten=list(range(1, n_seiten + 1)),
            konfidenz=k,
        )
        for a, k in hits.items()
    ]
    profil_hints: list[str] = []
    if "N" in hits:
        profil_hints.append("ARBEITNEHMER")
    if "KAP" in hits:
        profil_hints.append("KAPITALANLEGER")
    if "R" in hits:
        profil_hints.append("RENTNER")
    if "V" in hits:
        profil_hints.append("VERMIETER")

    doc_type = "einkommensteuererklaerung" if len(hits) >= 3 else (
        "lohnsteuerbescheinigung" if "N" in hits else "sonstige"
    )
    return Pass1Result(
        doc_type=doc_type,
        doc_type_konfidenz=0.5,
        profil_hints=profil_hints,
        anlagen_hints=hits,
        sub_anlagen=sub_anlagen,
        n_seiten=n_seiten,
        fehler=f"LLM-Fallback ({fehler})",
    )


# ──────────────────────────────────────────────────────────────────────
# VAST → Pass1Result: jede Bescheinigung wird zu einer SubAnlageHint.
# Pass 2 ist sub_anlage-zentriert und behandelt VAST-Bescheinigungen
# (mit gefülltem `vast_typ`) genau wie ESt-Anlagen, mit dem Unterschied
# dass `ziel_anlagen` aus VAST direkt für den Smart-Schema-Call benutzt
# werden — siehe Pass 2.
# ──────────────────────────────────────────────────────────────────────


_VAST_PROFIL_HINTS: dict[str, list[str]] = {
    "lohnsteuerbescheinigung": ["ARBEITNEHMER"],
    "kapitalertrag_mitteilung": ["KAPITALANLEGER"],
    "rentenbescheinigung": ["RENTNER"],
    "religionsabruf": [],
    "ag_zuschuss": ["ARBEITNEHMER"],
    "spendenbescheinigung": [],
    "sonstig": [],
}


def _vast_zu_pass1(v: "VastPass1Result") -> Pass1Result:
    """Map VAST-Result auf einheitliches Pass1Result, das Pass 2 verstehen kann."""
    sub_anlagen: list[SubAnlageHint] = []
    anlagen_hits: dict[str, float] = {}
    profil_hints_set: set[str] = set()

    for i, b in enumerate(v.bescheinigungen, start=1):
        # Primäre Anlage = erste in ziel_anlagen (oder 'ESt1A' als Fallback)
        primaere = (b.ziel_anlagen[0] if b.ziel_anlagen else "ESt1A")
        sub_id = f"sub_vast_{b.typ[:6]}_{i:02d}"
        sub_anlagen.append(SubAnlageHint(
            sub_id=sub_id,
            anlage=primaere,
            seiten=[b.seite],
            person_hint=None,                # VAST nutzt IdNr, nicht p_a/p_b
            konfidenz=b.konfidenz,
            vast_typ=b.typ,
            vast_uebermittler=b.uebermittler,
            vast_uebernommen=b.uebernommen,
            vast_empfaenger_idnr=b.empfaenger_idnr,
            vast_inline_felder=b.inline_felder or None,
        ))
        for a in b.ziel_anlagen:
            anlagen_hits[a] = max(anlagen_hits.get(a, 0.0), b.konfidenz)
        for ph in _VAST_PROFIL_HINTS.get(b.typ, []):
            profil_hints_set.add(ph)

    if len(v.personen_im_doc) >= 2:
        profil_hints_set.add("DOPPELVERDIENER")

    # Key-Fields: wir liefern pro Religionsabruf eine kleine Anzeige als
    # Sofort-UI-Hint (die "echten" Felder kommen aus Pass 2 via Smart-Schema
    # plus aus dem Religionsabruf-Skip-Pfad).
    key_fields: list[KeyField] = []
    for b in v.bescheinigungen:
        if b.typ == "religionsabruf" and b.inline_felder:
            religion = b.inline_felder.get("religion")
            if religion:
                key_fields.append(KeyField(
                    feld_name=f"religion_{b.empfaenger_idnr or 'unbekannt'}",
                    wert=str(religion),
                    seite=b.seite,
                    konfidenz=0.9,
                ))

    return Pass1Result(
        doc_type=v.doc_type,
        doc_type_konfidenz=v.doc_type_konfidenz,
        profil_hints=sorted(profil_hints_set),
        anlagen_hints=anlagen_hits,
        sub_anlagen=sub_anlagen,
        key_fields=key_fields,
        n_seiten=v.n_seiten,
        fehler=v.fehler,
        vast_personen=list(v.personen_im_doc),
        vast_transferticket_datum=v.transferticket_datum,
    )
