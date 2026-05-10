"""
STURM Pipeline Orchestrator — Pass 1+2+3 fuer EIN PDF.

  async for patch in extract_case(pdf_path, case_id, jahr):
      print(patch.to_json())

Stages:
  Pass 1   ->  Strukturerkennung (klein, ~3 s)         emittiert BELEG_HINZUFUEGEN + SUB_ANLAGEN
  Pass 2   ->  parallel Mistral Large pro sub_anlage   emittiert FELD_SETZEN-Patches as_completed
  Pass 3   ->  No-LLM Reconciliation                   emittiert PERSON_HINZUFUEGEN + Profil-Updates

Time-Logging:
  - Time-to-First-Chip = Sekunden bis erstem FELD_SETZEN-Patch
  - Time-to-Vollstaendig = Sekunden bis Pass-3-Abschluss

Schreibt nichts in cb-ctax-backend; Patches sind Stream-Output.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Optional

from mistral_client import MistralClient
from pass1_klassifikation import Pass1Result, klassifiziere
from pass2_extraktion import (
    ExtrahiertesFeld, Pass2FeldEvent, Pass2SubResult,
    extrahiere_alle_sub_anlagen, extrahiere_alle_sub_anlagen_streaming,
)
from pass3_reconciliation import Pass3Result, reconcile
from state_patch import (
    StatePatch, make_beleg_patch, make_feld_patch, make_flag_patch,
    make_klassifikation_patch, make_lane_status_patch, make_person_patch,
    make_warnung_patch,
)

log = logging.getLogger("sturm.pipeline")


@dataclass
class PipelineSummary:
    case_id: str
    pdf: str
    n_seiten: int
    doc_type: str
    n_sub_anlagen: int
    n_felder_extrahiert: int
    n_felder_unique: int
    n_personen: int
    profil_haupt: list[str]
    profil_sub: list[str]
    pass1_ms: int = 0
    pass2_ms: int = 0
    pass3_ms: int = 0
    pipeline_ms: int = 0
    time_to_first_chip_ms: Optional[int] = None
    fehler: list[str] = field(default_factory=list)


# ──────────────────────────────────────────────────────────────────────
# Pipeline
# ──────────────────────────────────────────────────────────────────────


async def extract_case(
    pdf_path: Path,
    case_id: str,
    jahr: int = 2024,
    mistral: Optional[MistralClient] = None,
    streaming: bool = True,
) -> AsyncIterator[StatePatch]:
    """
    Async generator. Yields StatePatch-Objekte progressiv.

    Hinweise:
      - Wenn der Stricker-PDF Steuerjahr 2023 ist und das Smart-Schema-Service
        nur 2024 hat, uebergeben wir 2024 (Schema ist nahezu identisch).
      - Pass 1 muss durch sein, bevor Pass 2 startet (Sub-Anlagen-Liste benoetigt).
      - Pass 2 sub_anlagen werden parallel verarbeitet, Patches kommen as_completed.
    """
    pipeline_start = time.time()
    mistral = mistral or MistralClient()

    # ── Bootstrap: Beleg-Skelett anlegen ────────────────────────────
    revision = 1
    beleg_id = f"b_{pdf_path.stem.lower().replace(' ', '_')[:24]}"
    beleg_index = 0  # erster Beleg in /belege

    yield make_lane_status_patch(case_id, revision, "sturm", "beschaeftigt", "ocr_laeuft")
    revision += 1

    # ── OCR (eingebettet, kein separater Container in dieser Demo) ──
    pdf_bytes = pdf_path.read_bytes()
    ocr_start = time.time()
    ocr = await mistral.ocr(pdf_bytes, dateiname=pdf_path.name)
    ocr_ms = int((time.time() - ocr_start) * 1000)
    log.info("OCR fertig: %d seiten, %dms, fehler=%s", ocr.n_seiten, ocr_ms, ocr.fehler)

    if not ocr.ok:
        yield make_warnung_patch(case_id, revision, {
            "warnung_id": "w_ocr_fehler",
            "typ": "sonstige",
            "schwere": "fehler",
            "nachricht": f"OCR fehlgeschlagen: {ocr.fehler}",
            "betroffene_belege": [beleg_id],
            "registriert_am": _now_iso(),
        })
        return

    # ── Pass 1 ──────────────────────────────────────────────────────
    yield make_lane_status_patch(case_id, revision, "sturm", "beschaeftigt", "pass1_klassifikation")
    revision += 1

    pass1_start = time.time()
    p1 = await klassifiziere(ocr.text, ocr.n_seiten, mistral, dateiname=pdf_path.name)
    pass1_ms = int((time.time() - pass1_start) * 1000)
    log.info(
        "Pass 1 fertig: doc_type=%s, %d sub_anlagen, %d key_fields, %dms, fehler=%s",
        p1.doc_type, len(p1.sub_anlagen), len(p1.key_fields), pass1_ms, p1.fehler,
    )

    # Beleg anlegen (mit sub_anlagen-Skelett)
    beleg = {
        "beleg_id": beleg_id,
        "typ": p1.doc_type,
        "dateiname": pdf_path.name,
        "groesse_bytes": len(pdf_bytes),
        "seitenzahl": ocr.n_seiten,
        "mime": "application/pdf",
        "hochgeladen_am": _now_iso(),
        "hochgeladen_von": "sturm_pipeline_prototype",
        "doc_typ_konfidenz": p1.doc_type_konfidenz,
        "steuerjahr_des_belegs": jahr,
        "primaere_anlage": None,
        "anlagen_hints": p1.anlagen_hints,
        "sub_anlagen": [
            {
                "sub_id": s.sub_id,
                "anlage": s.anlage,
                "person_id": s.person_hint,
                "seiten": s.seiten,
                "konfidenz": s.konfidenz,
                # VAST-Erweiterung — None bei ESt-Pfad
                "vast_typ": s.vast_typ,
                "vast_uebermittler": s.vast_uebermittler,
                "vast_uebernommen": s.vast_uebernommen,
                "vast_empfaenger_idnr": s.vast_empfaenger_idnr,
            }
            for s in p1.sub_anlagen
        ],
        "status": "extraktion_laeuft",
        "lane_permissions": ["sturm", "lane1", "lane5"],
        "quellen_typ": _quellen_typ_aus_doctyp(p1.doc_type),
        "prioritaet": _prioritaet_aus_doctyp(p1.doc_type),
    }
    yield make_beleg_patch(case_id, revision, beleg)
    revision += 1

    # ── BELEG_KLASSIFIZIERT (Wave 15 SSS / QQQ Followup #3) ─────────
    # Pass 1 hat doc_type + anlagen_hints + sub_anlagen — der
    # BELEG_ANGENOMMEN-Reducer ignoriert diese Felder bewusst (er ist
    # idempotent und kennt nur Hochlade-Metadaten). Damit
    # snapshot.belege[i].typ != 'unbekannt' und anlagen_hints != {},
    # pushen wir hier den dedizierten Klassifikations-Patch.
    klassifikation = {
        "typ": p1.doc_type,
        "doc_typ_konfidenz": p1.doc_type_konfidenz,
        "anlagen_hints": p1.anlagen_hints,
        "steuerjahr_des_belegs": jahr,
        "primaere_anlage": (
            sorted(
                p1.anlagen_hints.items(), key=lambda kv: kv[1], reverse=True,
            )[0][0]
            if p1.anlagen_hints else None
        ),
        # SubAnlage-Schema (case_state.d.ts): sub_id, anlage, person_id,
        # person_idnr?, seiten, konfidenz, vast_typ?, vast_uebernommen?.
        # vast_uebermittler / vast_empfaenger_idnr sind NICHT im Schema —
        # die bleiben im belege[].sub_anlagen-Skelett aus BELEG_HINZUFUEGEN.
        "sub_anlagen": [
            {
                "sub_id": s.sub_id,
                "anlage": s.anlage,
                "person_id": s.person_hint,
                "seiten": s.seiten,
                "konfidenz": s.konfidenz,
                "vast_typ": s.vast_typ,
                "vast_uebernommen": s.vast_uebernommen,
            }
            for s in p1.sub_anlagen
        ] if p1.sub_anlagen else None,
    }
    yield make_klassifikation_patch(
        case_id, revision, beleg_id, beleg_index, klassifikation,
    )
    revision += 1

    # Auch Key-Fields koennen schon als kleine UI-Hints hochgehen
    # (echte FELD_SETZEN-Patches kommen erst aus Pass 2 mit ELSTER-Code).
    # Wir registrieren nur eine Lane-Status-Update.
    yield make_lane_status_patch(case_id, revision, "sturm", "beschaeftigt", "pass2_extraktion")
    revision += 1

    # ── Pass 2 ──────────────────────────────────────────────────────
    pass2_start = time.time()
    sub_results: list[Pass2SubResult] = []
    first_chip_ms: Optional[int] = None

    if not p1.sub_anlagen:
        log.warning("Pass 1 lieferte 0 sub_anlagen — Pass 2 wird uebersprungen.")
    elif streaming:
        # ── STREAMING-PFAD ────────────────────────────────────────────
        # Pro Feld sofort Patch emittieren — Time-to-First-Chip < 3s Ziel.
        async for item in extrahiere_alle_sub_anlagen_streaming(
            sub_anlagen=p1.sub_anlagen,
            ocr_text=ocr.text,
            seiten_text=ocr.seiten_text,
            steuerjahr=jahr,
            doc_type=p1.doc_type,
            mistral=mistral,
            max_parallel=4,
        ):
            if isinstance(item, Pass2FeldEvent):
                if first_chip_ms is None:
                    first_chip_ms = int((time.time() - pipeline_start) * 1000)
                    log.info("STREAMING T_first_chip=%dms (sub=%s feld=%s)",
                             first_chip_ms, item.sub_id, item.feld.feld_name)
                pfad = _domain_pfad_simpel(item.feld)
                feld_obj = _feld_zu_state_obj(item.feld, pfad, beleg_id)
                yield make_feld_patch(case_id, revision, pfad, feld_obj, item.feld.elster_code)
                revision += 1
            elif isinstance(item, Pass2SubResult):
                sub_results.append(item)
                log.info(
                    "Pass 2 STREAM sub fertig: sub_id=%s anlage=%s n_felder=%d "
                    "T_first=%sms T_last=%sms total=%dms",
                    item.sub_id, item.anlage, item.n_felder,
                    item.t_first_field_ms, item.t_last_field_ms, item.dauer_ms,
                )
                if item.fehler:
                    yield make_warnung_patch(case_id, revision, {
                        "warnung_id": f"w_p2_{item.sub_id}",
                        "typ": "sonstige",
                        "schwere": "warn",
                        "nachricht": f"Pass 2 (streaming) fuer {item.sub_id} ({item.anlage}): {item.fehler}",
                        "betroffene_belege": [beleg_id],
                        "registriert_am": _now_iso(),
                    })
                    revision += 1
    else:
        # ── NON-STREAMING-PFAD (Backward-Compat) ──────────────────────
        async for sr in extrahiere_alle_sub_anlagen(
            sub_anlagen=p1.sub_anlagen,
            ocr_text=ocr.text,
            seiten_text=ocr.seiten_text,
            steuerjahr=jahr,
            doc_type=p1.doc_type,
            mistral=mistral,
            max_parallel=4,
        ):
            sub_results.append(sr)
            log.info(
                "Pass 2 sub fertig: sub_id=%s anlage=%s n_felder=%d (schema=%d) %dms",
                sr.sub_id, sr.anlage, sr.n_felder, sr.schema_n_felder, sr.dauer_ms,
            )
            if sr.fehler:
                yield make_warnung_patch(case_id, revision, {
                    "warnung_id": f"w_p2_{sr.sub_id}",
                    "typ": "sonstige",
                    "schwere": "warn",
                    "nachricht": f"Pass 2 fuer {sr.sub_id} ({sr.anlage}): {sr.fehler}",
                    "betroffene_belege": [beleg_id],
                    "registriert_am": _now_iso(),
                })
                revision += 1
                continue

            # Yield jeden Feld-Patch einzeln (Streaming-Verhalten).
            for feld in sr.felder:
                if first_chip_ms is None:
                    first_chip_ms = int((time.time() - pipeline_start) * 1000)
                pfad = _domain_pfad_simpel(feld)
                feld_obj = _feld_zu_state_obj(feld, pfad, beleg_id)
                yield make_feld_patch(case_id, revision, pfad, feld_obj, feld.elster_code)
                revision += 1

    pass2_ms = int((time.time() - pass2_start) * 1000)
    log.info("Pass 2 gesamt fertig: %dms, %d sub_results", pass2_ms, len(sub_results))

    # ── Pass 3 ──────────────────────────────────────────────────────
    yield make_lane_status_patch(case_id, revision, "sturm", "beschaeftigt", "pass3_reconciliation")
    revision += 1

    pass3_start = time.time()
    p3 = reconcile(sub_results, beleg_id=beleg_id, quellen_typ=_quellen_typ_aus_doctyp(p1.doc_type))
    pass3_ms = int((time.time() - pass3_start) * 1000)
    log.info(
        "Pass 3 fertig: %d personen, %d felder (dup=%d), profil=%s+%s, %dms",
        len(p3.personen), p3.n_felder_total, p3.n_felder_dupliziert,
        p3.profil.haupt_typen, p3.profil.sub_marker, pass3_ms,
    )

    # Personen — Pass-3 Personen + VAST-Personen aus Pass 1 mergen
    # (VAST kennt durch IdNr-Header schon Personen, auch wenn Pass 2 nichts
    # extrahiert hat — z.B. wenn nur Religionsabruf-Inline-Daten vorhanden
    # sind und keine Mistral-Felder mit Vor/Nachname).
    personen_by_idnr_emitted: set[str] = set()
    for p in p3.personen:
        # Falls VAST noch zusätzliche Namens-Varianten kennt → mergen.
        zusatz_varianten: list[dict] = []
        for vp in (p1.vast_personen or []):
            if vp.idnr and p.idnr and vp.idnr == p.idnr:
                seen = {nv["voller_name"] for nv in p.namens_varianten}
                for nm in vp.namens_varianten:
                    if nm not in seen:
                        zusatz_varianten.append({
                            "voller_name": nm, "quelle_beleg_id": beleg_id, "ts": _now_iso(),
                        })
                        seen.add(nm)
                # Vorname/Nachname mit VAST anreichern, falls leer
                p.vorname = p.vorname or vp.vorname
                p.nachname = p.nachname or vp.nachname
        all_varianten = p.namens_varianten + zusatz_varianten

        yield make_person_patch(case_id, revision, {
            "person_id": p.person_id_lokal,
            "rolle": "steuerpflichtiger_a" if p.person_id_lokal == "p_a"
                     else "steuerpflichtiger_b" if p.person_id_lokal == "p_b"
                     else "sonstige",
            "idnr": p.idnr,
            "vorname": p.vorname,
            "nachname": p.nachname,
            "namens_varianten": all_varianten,
            "konfidenz_identitaet": p.konfidenz_identitaet,
        })
        if p.idnr:
            personen_by_idnr_emitted.add(p.idnr)
        revision += 1

    # Personen die NUR via VAST bekannt sind (z.B. nur Religionsabruf →
    # IdNr aber kein Pass-2-Feld mit Namen) → trotzdem als Person emittieren.
    for vp in (p1.vast_personen or []):
        if vp.idnr and vp.idnr not in personen_by_idnr_emitted:
            yield make_person_patch(case_id, revision, {
                "person_id": f"p_{vp.idnr[-4:]}",
                "rolle": "sonstige",
                "idnr": vp.idnr,
                "vorname": vp.vorname,
                "nachname": vp.nachname,
                "namens_varianten": [
                    {"voller_name": nm, "quelle_beleg_id": beleg_id, "ts": _now_iso()}
                    for nm in vp.namens_varianten
                ],
                "konfidenz_identitaet": 0.95,
            })
            personen_by_idnr_emitted.add(vp.idnr)
            revision += 1

    # Pass-3-Warnungen
    for w in p3.warnungen:
        yield make_warnung_patch(case_id, revision, w)
        revision += 1

    # Pass-3-Flags (z.B. fuenftelung_pruefen aus §34-Trigger)
    for flag_name, flag_wert in (p3.flags or {}).items():
        yield make_flag_patch(
            case_id, revision, flag_name, flag_wert,
            kommentar=f"§34/Reducer-Flag: {flag_name} = {flag_wert!r}",
        )
        revision += 1

    # Lane-Status final
    yield make_lane_status_patch(case_id, revision, "sturm", "bereit", "fertig")
    revision += 1

    pipeline_ms = int((time.time() - pipeline_start) * 1000)
    log.info(
        "Pipeline gesamt: %dms (pass1=%d pass2=%d pass3=%d ocr=%d), TTFC=%s",
        pipeline_ms, pass1_ms, pass2_ms, pass3_ms, ocr_ms, first_chip_ms,
    )


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


def _quellen_typ_aus_doctyp(typ: str) -> str:
    return {
        "vast_steuerabruf": "vast",
        "lohnsteuerbescheinigung": "lstb_pdf",
        "rentenbescheid": "rentenbescheid",
        "kapitalertragsbescheinigung": "kapitalertragsbescheinigung",
        "spendenquittung": "spendenquittung",
        "einkommensteuererklaerung": "est_vorjahr",
    }.get(typ, "ki_extraktion")


def _prioritaet_aus_doctyp(typ: str) -> int:
    return {
        "vast_steuerabruf": 1,
        "lohnsteuerbescheinigung": 2,
        "rentenbescheid": 2,
        "kapitalertragsbescheinigung": 2,
        "einkommensteuererklaerung": 3,
        "spendenquittung": 4,
    }.get(typ, 5)


def _domain_pfad_simpel(feld: ExtrahiertesFeld) -> str:
    """Vereinfachte Pfad-Bildung fuer Streaming-Patches (Pass 3 macht es nochmal sauber)."""
    kategorie_map = {
        "N": "einkuenfte.nichtselbstaendig",
        "KAP": "einkuenfte.kapital",
        "VOR": "vorsorge",
        "SA": "sonderausgaben",
        "Kind": "kinder",
        "ESt1A": "persoenlich",
        "R": "einkuenfte.rente",
        "V": "einkuenfte.vermietung",
    }
    kat = kategorie_map.get(feld.primaere_anlage, feld.primaere_anlage.lower())
    suffix = f"[{feld.person_id_lokal}]" if feld.person_id_lokal else ""
    return f"{kat}.{feld.feld_name.lower()}{suffix}"


def _feld_zu_state_obj(feld: ExtrahiertesFeld, pfad: str, beleg_id: str) -> dict:
    return {
        "pfad": pfad,
        "primaerer_elster_code": feld.elster_code,
        "elster_code_aliase": [],
        "anlagen": feld.anlagen,
        "primaere_anlage": feld.primaere_anlage,
        "person_idnr": feld.person_idnr,
        "person_id": feld.person_id_lokal,
        "label": feld.feld_name,
        "value_type": _value_type_of(feld.wert),
        "wert": feld.wert,
        "konfidenz": feld.konfidenz,
        "verifiziert_von_user": False,
        "alle_werte": [{
            "wert": feld.wert,
            "quelle": {
                "quellen_typ": "ki_extraktion",
                "actor": "sturm",
                "tool": "PASS2_EXTRAKTION",
                "modell": "mistral-large-latest",
            },
            "konfidenz": feld.konfidenz,
            "ts": _now_iso(),
            "beleg_id": beleg_id,
            "sub_id": feld.sub_id,
            "zitat": feld.quellzitat,
        }],
        "aktualisiert_am": _now_iso(),
    }


def _value_type_of(wert) -> str:
    if isinstance(wert, bool):
        return "boolean"
    if isinstance(wert, int):
        return "integer"
    if isinstance(wert, float):
        return "number"
    return "string"


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
