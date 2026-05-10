"""
Pass 1 — VAST-Variante (Vorausgefüllte Steuererklärung / Steuer-Abruf).

VAST-Dokumente vom Finanzamt sind anders strukturiert als ESt-Erklärungen:

  * Pro Bescheinigung 1 Seite (Religionsabruf, LStB, KapErtrag-Mitteilung, …)
  * Header pro Seite: "Transferticket: Steuer-Abruf, Zuletzt abgerufen am …"
  * Status-Marker: "Diese Bescheinigung wurde übernommen." vs. "… wurde nicht übernommen."
  * Personen-Identifikation per IdNr (kein "Person A/B")
  * Namens-Varianten ("Ute" vs "Maria Ute")
  * LStB enthält Zeile 19 ("Entschädigungen / Arbeitslohn für mehrere
    Kalenderjahre") als §34-Trigger.

Output: VastPass1Result mit einer Liste von Bescheinigungen, die in
pass1_klassifikation auf das einheitliche SubAnlageHint-Format gemappt
werden (kompatibel zu Pass 2).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Optional

from mistral_client import MistralClient, SMALL_MODEL

log = logging.getLogger("sturm.pass1_vast")


# ──────────────────────────────────────────────────────────────────────
# Datenmodell (datenklassen statt Pydantic-BaseModel — kein zusätzlicher
# Build-Schritt nötig; das Mistral-JSON wird manuell auf diese Klassen
# gemappt — das Schema ist im Prompt beschrieben.)
# ──────────────────────────────────────────────────────────────────────


_VAST_BESCHEINIGUNG_TYPEN = {
    "religionsabruf",
    "lohnsteuerbescheinigung",
    "kapitalertrag_mitteilung",
    "rentenbescheinigung",
    "ag_zuschuss",
    "spendenbescheinigung",
    "sonstig",
}


@dataclass
class VastBescheinigung:
    typ: str                       # einer aus _VAST_BESCHEINIGUNG_TYPEN
    uebermittler: str              # AG-Name, Bank, Versicherung, …
    empfaenger_idnr: Optional[str] # 11-stellig, die Person für die das gilt
    seite: int                     # 1-basiert
    uebernommen: bool              # aus dem "wurde (nicht) übernommen"-Marker
    ziel_anlagen: list[str] = field(default_factory=list)  # ELSTER-Anlagen-Codes
    konfidenz: float = 0.85
    inline_felder: dict = field(default_factory=dict)      # bei Religionsabruf: {idnr, religion}


@dataclass
class VastPersonHint:
    idnr: str
    vorname: Optional[str] = None
    nachname: Optional[str] = None
    namens_varianten: list[str] = field(default_factory=list)


@dataclass
class VastPass1Result:
    doc_type: str = "vast_steuerabruf"
    doc_type_konfidenz: float = 0.0
    transferticket_datum: Optional[str] = None
    bescheinigungen: list[VastBescheinigung] = field(default_factory=list)
    personen_im_doc: list[VastPersonHint] = field(default_factory=list)
    n_seiten: int = 0
    fehler: Optional[str] = None


# ──────────────────────────────────────────────────────────────────────
# Detection — schnelle Heuristik
# ──────────────────────────────────────────────────────────────────────

_VAST_KEYWORDS = (
    re.compile(r"Transferticket\s*:?\s*Steuer-?Abruf", re.IGNORECASE),
    re.compile(r"Zuletzt abgerufen am", re.IGNORECASE),
    re.compile(r"wurde (nicht\s+)?übernommen", re.IGNORECASE),
    re.compile(r"Die folgende Daten wurden von der Finanzverwaltung abgerufen", re.IGNORECASE),
    re.compile(r"Übermittlung der Bescheinigung an die Finanzverwaltung", re.IGNORECASE),
)


async def detect_vast_format(ocr_text: str, dateiname: str) -> bool:
    """Schnelle Heuristik: ist das ein VAST/Steuer-Abruf-Doc?"""
    if not ocr_text:
        return False
    name_low = (dateiname or "").lower()
    name_hint = "vast" in name_low or "steuer-abruf" in name_low or "steuerabruf" in name_low
    n_hits = sum(1 for r in _VAST_KEYWORDS if r.search(ocr_text))
    # 2 oder mehr Marker = sicher VAST; 1 + Dateinamen-Hint = auch VAST
    if n_hits >= 2:
        return True
    if n_hits >= 1 and name_hint:
        return True
    return False


# ──────────────────────────────────────────────────────────────────────
# LLM-Klassifikation
# ──────────────────────────────────────────────────────────────────────


SYSTEM_PROMPT = (
    "Du bist ein Klassifikator für VAST-Dokumente (Vorausgefüllte "
    "Steuererklärung / Steuer-Abruf vom Finanzamt). Du bekommst OCR-Text "
    "eines VAST-PDFs (mehrere Bescheinigungen, eine pro Seite) und "
    "extrahierst pro Bescheinigung: Typ, Übermittler, Empfänger-IdNr, "
    "Übernommen-Status, Ziel-Anlagen. Du antwortest NUR als JSON."
)


USER_PROMPT_TMPL = """Klassifiziere dieses VAST-Steuerabruf-Dokument.

Pro Seite gibt es eine Bescheinigung. Erkenne pro Bescheinigung:

1) typ — einer aus:
   - 'religionsabruf'             (nur IdNr + Religion)
   - 'lohnsteuerbescheinigung'    (LStB vom Arbeitgeber)
   - 'kapitalertrag_mitteilung'   (freigestellte Kapitalerträge der Bank)
   - 'rentenbescheinigung'        (Renten-Mitteilung Träger)
   - 'ag_zuschuss'                (AG-Zuschuss Krankenversicherung)
   - 'spendenbescheinigung'
   - 'sonstig'

2) uebermittler — Name (Arbeitgeber, Bank, Träger, Verein …)
3) empfaenger_idnr — 11-stellig, die Person für die das gilt
4) seite — 1-basierte Seite im PDF
5) uebernommen — true wenn "wurde übernommen", false wenn "wurde nicht übernommen"
6) ziel_anlagen — welche ELSTER-Anlagen das relevant ist:
   - religionsabruf       → ['ESt1A']
   - lohnsteuerbescheinigung → ['N','VOR']
   - kapitalertrag_mitteilung → ['KAP']
   - rentenbescheinigung  → ['R','VOR']
   - ag_zuschuss          → ['VOR']
   - spendenbescheinigung → ['SA']

7) inline_felder — NUR für religionsabruf: { "idnr": "...", "religion": "Evangelisch" }
   Bei den anderen Typen leeres Objekt {}.

Sammle ausserdem ALLE im Dokument vorkommenden Personen (Steuerpflichtige + Ehepartner)
mit IdNr + Namens-Varianten (gleicher IdNr aber unterschiedliche Namen wie
"Ute" vs "Maria Ute" → in 'namens_varianten' beide auflisten).

Antworte NUR als JSON in diesem Format:
{
  "doc_type": "vast_steuerabruf",
  "doc_type_konfidenz": 0.95,
  "transferticket_datum": "2025-05-05",
  "bescheinigungen": [
    {"typ": "religionsabruf", "uebermittler": "Finanzamt",
     "empfaenger_idnr": "85236749007", "seite": 1, "uebernommen": false,
     "ziel_anlagen": ["ESt1A"], "konfidenz": 0.95,
     "inline_felder": {"idnr": "85236749007", "religion": "Evangelisch"}},
    {"typ": "lohnsteuerbescheinigung", "uebermittler": "Verbandsgemeindewerke Abwasser",
     "empfaenger_idnr": "85236749007", "seite": 2, "uebernommen": true,
     "ziel_anlagen": ["N","VOR"], "konfidenz": 0.95, "inline_felder": {}}
  ],
  "personen_im_doc": [
    {"idnr": "85236749007", "vorname": "Rainer", "nachname": "Stricker", "namens_varianten": ["Rainer Stricker"]},
    {"idnr": "54129386608", "vorname": "Ute", "nachname": "Stricker", "namens_varianten": ["Ute Stricker", "Maria Ute Stricker"]}
  ]
}

Gesamtseiten des Dokuments: {n_seiten}
"""


async def klassifiziere_vast(
    ocr_text: str,
    n_seiten: int,
    client: MistralClient,
) -> VastPass1Result:
    """Ruft Mistral-Small mit VAST-spezifischem Schema auf."""
    if not ocr_text.strip():
        return VastPass1Result(
            doc_type_konfidenz=0.0, n_seiten=n_seiten, fehler="leerer OCR-Text",
        )

    try:
        data = await client.extract_json(
            text=ocr_text,
            system_prompt=SYSTEM_PROMPT,
            user_prompt=USER_PROMPT_TMPL.replace("{n_seiten}", str(n_seiten)),
            model=SMALL_MODEL,
            temperature=0.05,
            max_tokens=3000,
        )
    except Exception as e:
        log.exception("Pass-1-VAST LLM-Call fehlgeschlagen.")
        return _vast_heuristik_fallback(ocr_text, n_seiten, fehler=str(e))

    return _parse_vast_response(data, n_seiten)


# ──────────────────────────────────────────────────────────────────────
# Response-Parser
# ──────────────────────────────────────────────────────────────────────


def _parse_vast_response(data: dict, n_seiten: int) -> VastPass1Result:
    bescheinigungen: list[VastBescheinigung] = []
    for b in data.get("bescheinigungen") or []:
        try:
            typ = str(b.get("typ", "sonstig"))
            if typ not in _VAST_BESCHEINIGUNG_TYPEN:
                typ = "sonstig"
            bescheinigungen.append(
                VastBescheinigung(
                    typ=typ,
                    uebermittler=str(b.get("uebermittler") or "?"),
                    empfaenger_idnr=(str(b["empfaenger_idnr"]) if b.get("empfaenger_idnr") else None),
                    seite=int(b.get("seite", 1)),
                    uebernommen=bool(b.get("uebernommen", False)),
                    ziel_anlagen=[str(a) for a in (b.get("ziel_anlagen") or [])],
                    konfidenz=float(b.get("konfidenz", 0.85)),
                    inline_felder=dict(b.get("inline_felder") or {}),
                )
            )
        except (KeyError, ValueError, TypeError) as e:
            log.warning("VAST-bescheinigung geskippt: %s (%s)", b, e)

    personen: list[VastPersonHint] = []
    for p in data.get("personen_im_doc") or []:
        try:
            personen.append(VastPersonHint(
                idnr=str(p["idnr"]),
                vorname=p.get("vorname"),
                nachname=p.get("nachname"),
                namens_varianten=[str(x) for x in (p.get("namens_varianten") or [])],
            ))
        except (KeyError, ValueError, TypeError):
            continue

    return VastPass1Result(
        doc_type="vast_steuerabruf",
        doc_type_konfidenz=float(data.get("doc_type_konfidenz", 0.9)),
        transferticket_datum=data.get("transferticket_datum"),
        bescheinigungen=bescheinigungen,
        personen_im_doc=personen,
        n_seiten=n_seiten,
    )


# ──────────────────────────────────────────────────────────────────────
# Heuristik-Fallback (no-LLM-Mode für Mistral-Quota-Probleme)
# ──────────────────────────────────────────────────────────────────────

# Pro-Seiten-Marker
_SEITENTRENNER_RE = re.compile(r"Transferticket\s*:?\s*Steuer-?Abruf", re.IGNORECASE)
_UEBERNOMMEN_RE = re.compile(r"wurde\s+(nicht\s+)?übernommen", re.IGNORECASE)
_TYP_PATTERNS: list[tuple[str, re.Pattern, list[str]]] = [
    ("religionsabruf", re.compile(r"Religionszugehörigkeit", re.IGNORECASE), ["ESt1A"]),
    ("lohnsteuerbescheinigung", re.compile(r"Lohnsteuerbescheinigung", re.IGNORECASE), ["N", "VOR"]),
    ("kapitalertrag_mitteilung", re.compile(r"Kapitalerträge|Kapitalertrag", re.IGNORECASE), ["KAP"]),
    ("rentenbescheinigung", re.compile(r"Rentenbezugsmitteilung|Rentenbescheinigung|Leistungsmitteilung", re.IGNORECASE), ["R", "VOR"]),
    ("spendenbescheinigung", re.compile(r"Zuwendungsbestätigung|Spendenbescheinigung", re.IGNORECASE), ["SA"]),
]

_IDNR_INLINE_RE = re.compile(r"Identifikationsnummer\s+(\d{11})")
_RELIGION_RE = re.compile(r"Religion\s+([A-Za-zÄÖÜäöüß-]+(?:\s+[A-Za-zÄÖÜäöüß-]+)?)")
_UEBERMITTLER_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("lohnsteuerbescheinigung", re.compile(r"Lohnsteuerbescheinigung\s+(.+?)(?:\n|$)", re.IGNORECASE)),
    ("kapitalertrag_mitteilung", re.compile(r"Kapitalerträge\s+(.+?)(?:\n|$)", re.IGNORECASE)),
    ("rentenbescheinigung", re.compile(r"(?:Renten\w*|Leistungsmitteilung)\s+(.+?)(?:\n|$)", re.IGNORECASE)),
]
_NAME_PAARE_RE = re.compile(
    r"(?:Ehepartner:\s*)?Vorname\s+([A-ZÄÖÜ][\wÄÖÜäöüß\- ]*?)\s*\n.*?Nachname\s+([A-ZÄÖÜ][\wÄÖÜäöüß\-]*)",
    re.DOTALL,
)


def _split_seiten(ocr_text: str) -> list[str]:
    """Spaltet OCR-Volltext entlang der Transferticket-Header in Seiten-Blöcke."""
    if not _SEITENTRENNER_RE.search(ocr_text):
        return [ocr_text]
    parts = _SEITENTRENNER_RE.split(ocr_text)
    return [p for p in parts if p.strip()]


def _vast_heuristik_fallback(ocr_text: str, n_seiten: int, fehler: str) -> VastPass1Result:
    """Kein LLM → strikte Regex-Heuristik. Reicht für Stricker-VAST-Demo."""
    seiten_blocks = _split_seiten(ocr_text)
    bescheinigungen: list[VastBescheinigung] = []
    personen_by_idnr: dict[str, VastPersonHint] = {}

    for i, block in enumerate(seiten_blocks, start=1):
        # Status (übernommen?)
        m_st = _UEBERNOMMEN_RE.search(block)
        uebernommen = bool(m_st and not m_st.group(1))  # group(1) ist 'nicht ' oder None

        # Typ
        typ = "sonstig"
        ziel_anlagen: list[str] = []
        for t, pat, anlagen in _TYP_PATTERNS:
            if pat.search(block):
                typ = t
                ziel_anlagen = list(anlagen)
                break

        # Übermittler
        uebermittler = "?"
        for tname, pat in _UEBERMITTLER_PATTERNS:
            if tname == typ:
                m = pat.search(block)
                if m:
                    uebermittler = m.group(1).strip()
                    break
        if typ == "religionsabruf":
            uebermittler = "Finanzamt (Meldebehörde)"

        # Empfänger-IdNr (= erste IdNr im Block)
        idnrs = _IDNR_INLINE_RE.findall(block)
        empfaenger_idnr = idnrs[0] if idnrs else None

        # Inline-Felder bei Religionsabruf
        inline: dict = {}
        if typ == "religionsabruf" and empfaenger_idnr:
            inline["idnr"] = empfaenger_idnr
            m_rel = _RELIGION_RE.search(block)
            if m_rel:
                inline["religion"] = m_rel.group(1).strip()

        bescheinigungen.append(VastBescheinigung(
            typ=typ,
            uebermittler=uebermittler,
            empfaenger_idnr=empfaenger_idnr,
            seite=i,
            uebernommen=uebernommen,
            ziel_anlagen=ziel_anlagen,
            konfidenz=0.6,
            inline_felder=inline,
        ))

        # Personen-Sammlung: jede IdNr + nachfolgender Vor/Nachname (best-effort)
        # Wir versuchen Paare auf einer Seite zu erkennen.
        for m in _NAME_PAARE_RE.finditer(block):
            vorname = m.group(1).strip()
            nachname = m.group(2).strip()
            voller = f"{vorname} {nachname}"
            # IdNr → die nächste, die *vor* diesem Match steht
            # Heuristik vereinfacht: nimm alle IdNrs im Block; wenn erste +
            # zweite, ist erste Steuerpflichtiger, zweite Ehepartner.
            # Dafür unten einfach auf passende IdNr vorne (Rainer) bzw.
            # hinten (Ehepartner) raten:
            target_idnr = empfaenger_idnr
            # Ehepartner-Heuristik: wenn "Ehepartner:" vor Vorname steht
            label_window = block[max(0, m.start() - 80):m.start()]
            if "Ehepartner" in label_window and len(idnrs) >= 2:
                target_idnr = idnrs[1]
            if not target_idnr:
                continue
            ph = personen_by_idnr.setdefault(
                target_idnr,
                VastPersonHint(idnr=target_idnr, vorname=vorname, nachname=nachname, namens_varianten=[]),
            )
            if voller not in ph.namens_varianten:
                ph.namens_varianten.append(voller)
            # ersten Eintrag als kanonisch behalten
            ph.vorname = ph.vorname or vorname
            ph.nachname = ph.nachname or nachname

    # Wenn aus Religionsabruf nur IdNrs ohne Namen herauskamen, trotzdem als
    # personen_im_doc registrieren (keine Namen).
    for b in bescheinigungen:
        if b.empfaenger_idnr and b.empfaenger_idnr not in personen_by_idnr:
            personen_by_idnr[b.empfaenger_idnr] = VastPersonHint(idnr=b.empfaenger_idnr)

    return VastPass1Result(
        doc_type="vast_steuerabruf",
        doc_type_konfidenz=0.7,
        bescheinigungen=bescheinigungen,
        personen_im_doc=list(personen_by_idnr.values()),
        n_seiten=n_seiten,
        fehler=f"VAST-Heuristik-Fallback ({fehler})",
    )
