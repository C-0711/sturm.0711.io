"""
Pass 3 — Reconciliation, IdNr-Kanonisierung, Master-Merge.

Kein LLM. Nimmt alle ExtrahiertesFeld-Objekte aus Pass 2 und:

  1. Validiert ELSTER-Codes lokal (Format E\\d{6,8}).
  2. Kanonisiert Personen ueber IdNr (statt 'A'/'B'/'p_a').
  3. Merged Personen mit gleicher IdNr aber unterschiedlichen Namen
     -> namens_varianten[].
  4. Master-Merge mit Quellen-Prioritaet (vast > lstb_pdf > est_vorjahr
     > ki_extraktion_lt_0.8).
  5. Aggregiert Anlagen ueber alle Belege -> Composite-Profil
     (haupt_typen + sub_marker).
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from pass2_extraktion import ExtrahiertesFeld, Pass2SubResult

log = logging.getLogger("sturm.pass3")


# Default-URL des cb-smart-schema-Service. Override via Env.
SMART_SCHEMA_URL = os.environ.get("SMART_SCHEMA_URL", "http://localhost:7820")


# Akzeptiert klassische E-Codes (E0200204) UND nummerische (110) — die
# Smart-Schema-Service-DB nutzt teils noch die alten XSD-internen Indices.
_ELSTER_CODE_RE = re.compile(r"^[A-Za-z0-9._-]{2,15}$")
_IDNR_RE = re.compile(r"^\d{11}$")


# Quellen-Prioritaet (kleinere Zahl = hoeher).
QUELLEN_PRIO: dict[str, int] = {
    "benutzer_korrektur": 0,
    "vast": 1,
    "lstb_pdf": 2,
    "est_vorjahr": 3,
    "rentenbescheid": 2,
    "kapitalertragsbescheinigung": 2,
    "spendenquittung": 4,
    "rechnung": 4,
    "ki_extraktion": 5,
    "ki_extraktion_lt_0.8": 6,
}


@dataclass
class CanonPerson:
    person_id_lokal: str  # 'p_a' / 'p_b' / 'p_unbekannt'
    idnr: Optional[str] = None
    vorname: Optional[str] = None
    nachname: Optional[str] = None
    namens_varianten: list[dict] = field(default_factory=list)
    konfidenz_identitaet: float = 0.5


@dataclass
class CanonFeld:
    pfad: str                   # Domain-Pfad-Key
    primaerer_elster_code: str
    elster_code_aliase: list[str]
    anlagen: list[str]
    primaere_anlage: str
    person_idnr: Optional[str]
    person_id_lokal: Optional[str]
    label: Optional[str]
    value_type: str             # 'number' / 'string' / 'integer' / ...
    wert: object
    konfidenz: float
    alle_werte: list[dict]      # Append-Log
    aktualisiert_am: str


@dataclass
class CompositeProfil:
    haupt_typen: list[str]
    sub_marker: list[str]


@dataclass
class Pass3Result:
    personen: list[CanonPerson]
    felder: list[CanonFeld]
    profil: CompositeProfil
    n_felder_total: int
    n_felder_dupliziert: int
    warnungen: list[dict] = field(default_factory=list)
    # v1.1 flags die der Reducer in /flags/* setzen soll.
    flags: dict[str, object] = field(default_factory=dict)


# ──────────────────────────────────────────────────────────────────────
# Step 1: ELSTER-Code-Validierung (lokal)
# ──────────────────────────────────────────────────────────────────────


def _ist_valider_elster_code(code: str) -> bool:
    return bool(code) and bool(_ELSTER_CODE_RE.match(code))


def _validate_via_service(
    felder: list[ExtrahiertesFeld],
    steuerjahr: int,
    url: str = SMART_SCHEMA_URL,
) -> dict[str, dict]:
    """
    Optional: Batch-Validierung gegen cb-smart-schema /validate-batch.
    Liefert {code -> {valid, reasons, konfidenz}}.
    Bei Fehler/Timeout: leeres Dict (Pipeline faellt auf lokale Validation zurueck).
    """
    try:
        import httpx
    except ImportError:
        log.warning("httpx nicht installiert, Service-Validation uebersprungen.")
        return {}
    if not felder:
        return {}
    payload = {
        "felder": [
            {"code": f.elster_code, "wert": f.wert, "anlage": f.primaere_anlage}
            for f in felder
        ],
        "steuerjahr": steuerjahr,
    }
    try:
        with httpx.Client(timeout=5.0) as client:
            r = client.post(f"{url}/validate-batch", json=payload)
            r.raise_for_status()
            body = r.json()
    except Exception as e:
        log.warning("validate-batch-Service-Aufruf fehlgeschlagen: %s", e)
        return {}
    return {it["code"]: it for it in body.get("results", [])}


# ──────────────────────────────────────────────────────────────────────
# Step 2+3: Personen aus Feldern extrahieren + IdNr-Kanonisierung
# ──────────────────────────────────────────────────────────────────────


# ELSTER-Codes fuer IdNr (heuristisch).
_IDNR_CODES = {"E0100201", "E0100202", "E0100203", "E0100204", "E0100205"}
# Vorname/Nachname-Codes (heuristisch — bezeichnung-Match wuerde robuster sein,
# aber wir haben in Pass 2 nur den feld_name als Hint).
_NAME_CODE_PATTERNS = (
    "name", "vorname", "nachname", "geburts",
)


def _personen_kanonisieren(
    felder: list[ExtrahiertesFeld],
    beleg_id: str,
) -> tuple[list[CanonPerson], dict[str, str]]:
    """
    Returns (personen, lokal_to_idnr_map).
    lokal_to_idnr_map: 'p_a' -> '12345678901' wenn extrahiert.
    """
    # Gruppiere alle Felder nach person_id_lokal — bei VAST gibt es kein
    # 'p_a'/'p_b', sondern direkt eine person_idnr → wir nutzen die als
    # virtuellen Lokal-Schlüssel ('p_<last4>'), damit der nachgelagerte
    # _merge_personen via IdNr richtig zusammenführt.
    gruppen: dict[str, list[ExtrahiertesFeld]] = {}
    for f in felder:
        if f.person_id_lokal:
            key = f.person_id_lokal
        elif f.person_idnr and _IDNR_RE.match(f.person_idnr):
            key = f"p_{f.person_idnr[-4:]}"
        else:
            key = "p_unbekannt"
        gruppen.setdefault(key, []).append(f)

    personen: list[CanonPerson] = []
    lokal_to_idnr: dict[str, str] = {}

    for lokal, fs in gruppen.items():
        idnr = None
        vorname = None
        nachname = None
        ts = _now_iso()

        for f in fs:
            if f.elster_code in _IDNR_CODES and isinstance(f.wert, str) and _IDNR_RE.match(f.wert):
                idnr = f.wert
            elif idnr is None and f.person_idnr and _IDNR_RE.match(f.person_idnr):
                # VAST: person_idnr ist direkt am Feld angetackert
                idnr = f.person_idnr
            fn_low = f.feld_name.lower()
            if any(p in fn_low for p in ("vorname",)):
                vorname = str(f.wert)
            elif any(p in fn_low for p in ("nachname", "familienname")):
                nachname = str(f.wert)
            elif fn_low.startswith("name") and isinstance(f.wert, str):
                # 'Mustermann, Max' -> nachname=Mustermann, vorname=Max
                if "," in f.wert and not nachname:
                    parts = [p.strip() for p in f.wert.split(",", 1)]
                    nachname, vorname = parts[0], parts[1]

        voller_name = " ".join(p for p in (vorname, nachname) if p) or None
        namens_varianten: list[dict] = []
        if voller_name:
            namens_varianten.append({
                "voller_name": voller_name,
                "quelle_beleg_id": beleg_id,
                "ts": ts,
            })

        personen.append(CanonPerson(
            person_id_lokal=lokal,
            idnr=idnr,
            vorname=vorname,
            nachname=nachname,
            namens_varianten=namens_varianten,
            konfidenz_identitaet=1.0 if idnr else 0.6,
        ))
        if idnr:
            lokal_to_idnr[lokal] = idnr

    return personen, lokal_to_idnr


def _merge_personen(alle_personen: list[CanonPerson]) -> list[CanonPerson]:
    """Merge Personen mit gleicher IdNr (z.B. 'Ute' vs 'Maria Ute')."""
    by_idnr: dict[str, CanonPerson] = {}
    ohne_idnr: list[CanonPerson] = []
    for p in alle_personen:
        if p.idnr:
            existing = by_idnr.get(p.idnr)
            if existing is None:
                by_idnr[p.idnr] = p
            else:
                # name_varianten zusammenfuehren
                seen_namen = {nv["voller_name"] for nv in existing.namens_varianten}
                for nv in p.namens_varianten:
                    if nv["voller_name"] not in seen_namen:
                        existing.namens_varianten.append(nv)
                # Vorname/Nachname behalten den ersten gefundenen
                existing.vorname = existing.vorname or p.vorname
                existing.nachname = existing.nachname or p.nachname
        else:
            ohne_idnr.append(p)
    return list(by_idnr.values()) + ohne_idnr


# ──────────────────────────────────────────────────────────────────────
# Step 4: Master-Merge mit Quellen-Prioritaet + Domain-Pfad
# ──────────────────────────────────────────────────────────────────────


# Sehr knapper Domain-Pfad-Mapper (Heuristik). In Production wuerde
# meta_label diese Mapping-Tabelle pflegen.
def _domain_pfad(
    elster_code: str,
    feld_name: str,
    primaere_anlage: str,
    person_idnr: Optional[str],
    person_id_lokal: Optional[str],
) -> str:
    """Bilde 'kategorie.unterkategorie.feld[p_x]' Pfad."""
    fn_low = feld_name.lower()
    anlage = primaere_anlage.lower()

    # Heuristik anhand Anlage
    kategorie_map = {
        "n": "einkuenfte.nichtselbstaendig",
        "kap": "einkuenfte.kapital",
        "r": "einkuenfte.rente",
        "v": "einkuenfte.vermietung",
        "g": "einkuenfte.gewerbebetrieb",
        "s": "einkuenfte.selbstaendig",
        "vor": "vorsorge",
        "sa": "sonderausgaben",
        "agb": "aussergewoehnliche_belastungen",
        "kind": "kinder",
        "ha_35a": "sonderausgaben.haushaltsnahe",
        "est1a": "persoenlich",
    }
    kategorie = kategorie_map.get(anlage, anlage)
    pfad = f"{kategorie}.{fn_low}"
    person_suffix = ""
    if person_idnr:
        person_suffix = f"[{person_idnr}]"
    elif person_id_lokal:
        person_suffix = f"[{person_id_lokal}]"
    return pfad + person_suffix


_VALUE_TYPES = {
    int: "integer",
    float: "number",
    bool: "boolean",
    str: "string",
}


def _ermittle_value_type(wert) -> str:
    if isinstance(wert, bool):
        return "boolean"
    if isinstance(wert, int):
        return "integer"
    if isinstance(wert, float):
        return "number"
    if isinstance(wert, str):
        if _IDNR_RE.match(wert):
            return "string"
        # iban?
        if re.match(r"^DE\d{20}$", wert.replace(" ", "")):
            return "iban"
        # ISO date?
        if re.match(r"^\d{4}-\d{2}-\d{2}$", wert):
            return "date"
        return "string"
    return "string"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _master_merge(
    alle_felder: list[tuple[ExtrahiertesFeld, str, str]],
    personen_lookup: dict[str, str],  # lokal -> idnr
) -> tuple[list[CanonFeld], int]:
    """
    Args:
        alle_felder: [(feld, beleg_id, quellen_typ), ...]
        personen_lookup: zur IdNr-Anreicherung
    Returns:
        (canon_felder, n_dupliziert)
    """
    by_pfad: dict[str, CanonFeld] = {}
    n_dupliziert = 0

    for feld, beleg_id, quellen_typ in alle_felder:
        if not _ist_valider_elster_code(feld.elster_code):
            log.warning("Skip ungueltiger ELSTER-Code: %r", feld.elster_code)
            continue

        person_idnr = feld.person_idnr or personen_lookup.get(feld.person_id_lokal or "")
        pfad = _domain_pfad(
            feld.elster_code, feld.feld_name, feld.primaere_anlage,
            person_idnr, feld.person_id_lokal,
        )
        prio = QUELLEN_PRIO.get(quellen_typ, QUELLEN_PRIO["ki_extraktion"])
        if feld.konfidenz < 0.8 and quellen_typ == "ki_extraktion":
            prio = QUELLEN_PRIO["ki_extraktion_lt_0.8"]

        wert_eintrag = {
            "wert": feld.wert,
            "quelle": {
                "quellen_typ": quellen_typ,
                "actor": "sturm",
                "tool": "PASS2_EXTRAKTION",
                "modell": "mistral-large-latest",
                "prioritaet_hinweis": prio,
            },
            "konfidenz": feld.konfidenz,
            "ts": _now_iso(),
            "beleg_id": beleg_id,
            "sub_id": feld.sub_id,
            "zitat": feld.quellzitat,
        }

        if pfad in by_pfad:
            n_dupliziert += 1
            cf = by_pfad[pfad]
            cf.alle_werte.append(wert_eintrag)
            # Aliase verwalten
            if feld.elster_code != cf.primaerer_elster_code and feld.elster_code not in cf.elster_code_aliase:
                cf.elster_code_aliase.append(feld.elster_code)
            for a in feld.anlagen:
                if a not in cf.anlagen:
                    cf.anlagen.append(a)
            # Quellen-Prio bestimmt aktiv
            aktive_prio = _aktive_prio(cf)
            if prio < aktive_prio:
                cf.wert = feld.wert
                cf.konfidenz = feld.konfidenz
                cf.aktualisiert_am = wert_eintrag["ts"]
        else:
            cf = CanonFeld(
                pfad=pfad,
                primaerer_elster_code=feld.elster_code,
                elster_code_aliase=[],
                anlagen=list(feld.anlagen),
                primaere_anlage=feld.primaere_anlage,
                person_idnr=person_idnr,
                person_id_lokal=feld.person_id_lokal,
                label=feld.feld_name,
                value_type=_ermittle_value_type(feld.wert),
                wert=feld.wert,
                konfidenz=feld.konfidenz,
                alle_werte=[wert_eintrag],
                aktualisiert_am=wert_eintrag["ts"],
            )
            by_pfad[pfad] = cf

    return list(by_pfad.values()), n_dupliziert


def _aktive_prio(cf: CanonFeld) -> int:
    if not cf.alle_werte:
        return 99
    # nimm den letzten gewinnenden -> low number wins; suche min
    prios = [
        (w.get("quelle", {}) or {}).get("prioritaet_hinweis", 99) or 99
        for w in cf.alle_werte
        if w.get("wert") == cf.wert
    ]
    return min(prios) if prios else 99


# ──────────────────────────────────────────────────────────────────────
# Step 5: Composite-Profil
# ──────────────────────────────────────────────────────────────────────


def _composite_profil(
    anlagen_set: set[str],
    personen: list[CanonPerson],
) -> CompositeProfil:
    haupt: list[str] = []
    if "N" in anlagen_set:
        haupt.append("ARBEITNEHMER")
    if any(a in anlagen_set for a in ("KAP", "KAP_BET", "KAP_I")):
        haupt.append("KAPITALANLEGER")
    if "R" in anlagen_set:
        haupt.append("RENTNER")
    if "V" in anlagen_set:
        haupt.append("VERMIETER")
    if any(a in anlagen_set for a in ("G", "S")):
        haupt.append("SELBSTAENDIG")

    sub: list[str] = []
    n_personen_mit_eink = sum(
        1 for p in personen
        if p.idnr  # heuristisch: nur Personen mit IdNr zaehlen als Steuerpflichtige
    )
    if n_personen_mit_eink >= 2:
        sub.append("DOPPELVERDIENER")
    if "Kind" in anlagen_set:
        sub.append("MIT_KINDERN")
    if "HA_35a" in anlagen_set:
        sub.append("HAUSHALTSNAH")

    return CompositeProfil(haupt_typen=haupt or ["UNBEKANNT"], sub_marker=sub)


# ──────────────────────────────────────────────────────────────────────
# Public Entry-Point
# ──────────────────────────────────────────────────────────────────────


def reconcile(
    sub_results: list[Pass2SubResult],
    beleg_id: str,
    quellen_typ: str = "ki_extraktion",
    validate_via_service: bool = False,
    steuerjahr: int = 2024,
) -> Pass3Result:
    """Kompletter Pass 3 ueber alle Pass-2-Ergebnisse.

    Args:
        validate_via_service: Wenn True, wird zusaetzlich der cb-smart-schema
            /validate-batch-Endpoint aufgerufen. Bei Service-Fehler oder Timeout
            faellt die Funktion still auf die lokale Format-Validierung zurueck
            (Backwards-Compat).
        steuerjahr: Wird an /validate-batch weitergegeben.
    """
    # Sammle alle Felder
    flat: list[tuple[ExtrahiertesFeld, str, str]] = []
    anlagen_set: set[str] = set()
    warnungen: list[dict] = []

    for sr in sub_results:
        anlagen_set.add(sr.anlage)
        if sr.fehler:
            warnungen.append({
                "warnung_id": f"w_pass2_{sr.sub_id}",
                "typ": "konfidenz_niedrig",
                "schwere": "warn",
                "nachricht": f"Pass-2 fuer sub_anlage '{sr.sub_id}' fehlgeschlagen: {sr.fehler}",
                "betroffene_belege": [beleg_id],
                "registriert_am": _now_iso(),
            })
            continue
        for f in sr.felder:
            flat.append((f, beleg_id, quellen_typ))

    # Optional: Service-Validation
    if validate_via_service and flat:
        all_felder = [t[0] for t in flat]
        service_res = _validate_via_service(all_felder, steuerjahr=steuerjahr)
        for code, res in service_res.items():
            if not res.get("valid"):
                warnungen.append({
                    "warnung_id": f"w_validate_{code}",
                    "typ": "feld_validation",
                    "schwere": "warn",
                    "nachricht": f"Feld {code} ungueltig: {'; '.join(res.get('reasons', []))}",
                    "betroffene_belege": [beleg_id],
                    "registriert_am": _now_iso(),
                })

    # Personen kanonisieren
    pers_per_beleg, lokal_to_idnr = _personen_kanonisieren(
        [t[0] for t in flat], beleg_id,
    )
    personen = _merge_personen(pers_per_beleg)

    # Lookup uebernehmen + globale Personen (gemerged) noch mal mappen
    for p in personen:
        if p.idnr:
            lokal_to_idnr[p.person_id_lokal] = p.idnr

    # Master-Merge
    canon_felder, n_dup = _master_merge(flat, lokal_to_idnr)

    # Composite-Profil
    profil = _composite_profil(anlagen_set, personen)

    # §34-Trigger (Zeile 19 LStB > 0) — siehe _detect_par34_trigger.
    flags: dict[str, object] = {}
    if _detect_par34_trigger(canon_felder):
        flags["fuenftelung_pruefen"] = True
        warnungen.append({
            "warnung_id": "w_par34_trigger",
            "typ": "regel",
            "schwere": "info",
            "nachricht": "§34 EStG Fünftelregelung pruefen: Entschaedigung / "
                         "Arbeitslohn fuer mehrere Kalenderjahre > 0 € erkannt (Zeile 19 LStB).",
            "betroffene_belege": [beleg_id],
            "registriert_am": _now_iso(),
        })

    return Pass3Result(
        personen=personen,
        felder=canon_felder,
        profil=profil,
        n_felder_total=len(canon_felder),
        n_felder_dupliziert=n_dup,
        warnungen=warnungen,
        flags=flags,
    )


# ──────────────────────────────────────────────────────────────────────
# §34 EStG (Fünftelregelung) Trigger
# ──────────────────────────────────────────────────────────────────────


_PAR34_FELDNAMEN = (
    "entschaedigung",
    "entschädigung",
    "entsch_digung",      # ä-Stripping aus Smart-Schema-Feldnamen
    "arbeitslohn_fuer_mehrere",
    "arbeitslohn_f_r_mehrere",   # ü-Stripping
    "mehrere_jahre",
    "mehrjahresarbeitslohn",
    "zeile_19",
    "zeile19",
    "nr_19",                # 'laut nr 19' im Smart-Schema-Feldnamen
    "lstb_zeile_19",
)
# Klassische ELSTER-Codes (heuristisch — siehe E10-XSD).
# Live Smart-Schema-Service nutzt teils nummerische Codes; '165.' ist
# "Entschädigung / Arbeitslohn für mehrere Jahre" laut LStB.
_PAR34_ELSTER_CODES = {"E0200505", "E0200506", "165.", "165"}


def _to_number_or_none(wert) -> Optional[float]:
    """Convert wert (int/float/string) to float; None bei nicht-zahl."""
    if isinstance(wert, bool):
        return None
    if isinstance(wert, (int, float)):
        return float(wert)
    if isinstance(wert, str):
        s = wert.strip().replace(".", "").replace(",", ".") if wert.count(",") and wert.count(".") <= 1 else wert.strip()
        # primitive: nur ".", kein "," → schon im US-Format
        if "," not in wert and "." in wert:
            s = wert.strip()
        try:
            return float(s)
        except (ValueError, TypeError):
            return None
    return None


def _detect_par34_trigger(felder: list[CanonFeld]) -> bool:
    """True wenn ein Feld auf §34 (Zeile 19 LStB) hindeutet UND Wert > 0."""
    for f in felder:
        wert_num = _to_number_or_none(f.wert)
        if wert_num is None or wert_num <= 0:
            continue
        fn_low = (f.label or "").lower().replace(" ", "_").replace("-", "_")
        # primaerer_elster_code: keine .upper() — nummerische Codes wie '165.' bleiben gleich.
        ec = (f.primaerer_elster_code or "")
        ec_upper = ec.upper()
        if any(p in fn_low for p in _PAR34_FELDNAMEN):
            log.info("§34-Trigger: feld='%s' wert=%s", f.label, wert_num)
            return True
        if ec in _PAR34_ELSTER_CODES or ec_upper in _PAR34_ELSTER_CODES:
            log.info("§34-Trigger via ELSTER-Code %s wert=%s", ec, wert_num)
            return True
    return False
