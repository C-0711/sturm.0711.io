"""
backend_emitter — Bruecke STURM-Pipeline -> cb-ctax-backend (/api/cases/...).

Jeder StatePatch der Pipeline wird auf den Reducer-Tool-Vertrag aus
backend/src/core/reducers/* gemappt und via httpx an
POST /api/cases/:case_id/aktion gesendet. Persistenz + SSE-Broadcast
geschehen dann im Backend (Single Source of Truth).

Mapping STURM-Pipeline-Tool -> Backend-Reducer-Tool:
    BELEG_HINZUFUEGEN          -> BELEG_ANGENOMMEN
    LANES_STATUS_AKTUALISIEREN -> (kein Reducer; wird verworfen, Pipeline-only)
    FELD_SETZEN                -> FELD_GESETZT
    PERSON_HINZUFUEGEN         -> (kein Reducer in v1.1; wird verworfen)
    WARNUNG_REGISTRIEREN       -> WARNUNG_HINZUGEFUEGT
    SUB_ANLAGE_HINZUFUEGEN     -> (kein Reducer; in BELEG_KLASSIFIZIERT
                                   integriert, wird verworfen)

Verworfene Patches werden geloggt (Severity DEBUG), damit die Pipeline
weiterlaeuft, aber das Backend keinen 400-Fehler bekommt.

Connection-Pool: ein httpx.AsyncClient pro Emitter mit limits=10 parallel.
Retry bei 409 (Revision-Conflict): 1x re-fetch des aktuellen Snapshots,
neue revision setzen, retryen. Schlaegt das fehl -> Fehler propagieren.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

log = logging.getLogger("sturm.backend_emitter")


# Reducer-Mapping — siehe Modul-Docstring oben.
# v1.2 / Wave 3: alle frueher verworfenen Tools haben jetzt Backend-Reducer.
TOOL_MAPPING: dict[str, Optional[str]] = {
    "BELEG_HINZUFUEGEN": "BELEG_ANGENOMMEN",
    "FELD_SETZEN": "FELD_GESETZT",
    "WARNUNG_REGISTRIEREN": "WARNUNG_HINZUGEFUEGT",
    # v1.2: jetzt mit Backend-Reducer.
    "LANES_STATUS_AKTUALISIEREN": "LANES_STATUS_AKTUALISIEREN",
    "PERSON_HINZUFUEGEN": "PERSON_HINZUFUEGEN",
    "SUB_ANLAGE_HINZUFUEGEN": "SUB_ANLAGE_GESETZT",
    # Wave 5 Followup F1: FLAG_SETZEN bekommt jetzt einen Backend-Reducer.
    "FLAG_SETZEN": "FLAG_SETZEN",
    # Wave 15 SSS (QQQ Followup #3): BELEG_KLASSIFIZIERT-Push.
    # Pass 1 emittiert doc_type + anlagen_hints; ohne diesen Mapping-Eintrag
    # blieben snapshot.belege[i].typ='unbekannt' und anlagen_hints={}.
    "BELEG_KLASSIFIZIERT": "BELEG_KLASSIFIZIERT",
}


@dataclass
class EmitterErgebnis:
    ok: bool
    backend_revision: Optional[int]
    latenz_ms: int
    fehler: Optional[str] = None
    verworfen: bool = False


class BackendEmitter:
    """Async HTTP-Client gegen cb-ctax-backend /api/cases/*."""

    def __init__(
        self,
        base_url: str = "http://localhost:3032",
        actor: str = "sturm",
        rolle: str = "super_admin",
        timeout_s: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.actor = actor
        self.rolle = rolle
        limits = httpx.Limits(max_connections=10, max_keepalive_connections=10)
        self.client = httpx.AsyncClient(
            timeout=timeout_s,
            limits=limits,
            headers={
                "Content-Type": "application/json",
                "X-Actor": actor,
                "X-Rolle": rolle,
                "X-Surface": "system",
            },
        )
        # Pro case_id die zuletzt vom Backend bestaetigte revision.
        self._aktuelle_revision: dict[str, int] = {}

    async def schliessen(self) -> None:
        await self.client.aclose()

    async def __aenter__(self) -> "BackendEmitter":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.schliessen()

    # ── Snapshot-Lookup (fuer Revision-Sync nach 409) ─────────────────────

    async def lese_aktuelle_revision(self, case_id: str) -> int:
        url = f"{self.base_url}/api/cases/{case_id}"
        r = await self.client.get(url)
        r.raise_for_status()
        rev = int(r.json().get("revision", 0))
        self._aktuelle_revision[case_id] = rev
        return rev

    # ── Tool-Aktion gegen Reducer-API ─────────────────────────────────────

    async def aktion(
        self,
        case_id: str,
        tool_kind: str,
        payload: dict[str, Any],
        kommentar: Optional[str] = None,
    ) -> EmitterErgebnis:
        """Sendet eine Reducer-Aktion ans Backend, mit Retry bei 409."""
        if case_id not in self._aktuelle_revision:
            try:
                await self.lese_aktuelle_revision(case_id)
            except Exception as e:
                return EmitterErgebnis(
                    ok=False, backend_revision=None, latenz_ms=0,
                    fehler=f"Snapshot-Lookup fehlgeschlagen: {e}",
                )

        url = f"{self.base_url}/api/cases/{case_id}/aktion"

        for versuch in (1, 2):
            erwartet = self._aktuelle_revision[case_id]
            body = {
                "tool": {"kind": tool_kind, "payload": payload},
                "expected_revision": erwartet,
                "kommentar": kommentar,
            }
            t0 = time.time()
            r = await self.client.post(url, json=body)
            latenz_ms = int((time.time() - t0) * 1000)

            # Wave 13 (Agent III) hat den Status-Code vereinheitlicht:
            #   201 Created  -> Reducer hat einen echten Patch produziert (revision++).
            #   200 OK       -> No-Op-Idempotenz (Reducer lieferte []).
            # Beides ist Erfolg. Wave 15 RRR: vorher hat die Bridge nur 200
            # akzeptiert, weshalb alle Pipeline-Pushes als "fehlgeschlagen"
            # geloggt wurden (false-positive WARNING-Spam).
            if r.status_code in (200, 201):
                data = r.json()
                neue_rev = int(data.get("revision", erwartet))
                self._aktuelle_revision[case_id] = neue_rev
                return EmitterErgebnis(ok=True, backend_revision=neue_rev, latenz_ms=latenz_ms)

            if r.status_code == 409 and versuch == 1:
                # Revision-Conflict: refresh und retry einmal
                try:
                    konflikt = r.json()
                    aktuell = int(konflikt.get("actual", 0))
                    self._aktuelle_revision[case_id] = aktuell
                    log.warning(
                        "[%s] 409 conflict tool=%s expected=%d actual=%d -> retry",
                        case_id[-12:], tool_kind, erwartet, aktuell,
                    )
                    continue
                except Exception:
                    await self.lese_aktuelle_revision(case_id)
                    continue

            # Sonstiger Fehler -> abbrechen
            try:
                msg = r.json().get("error", r.text[:200])
            except Exception:
                msg = r.text[:200]
            return EmitterErgebnis(
                ok=False,
                backend_revision=self._aktuelle_revision.get(case_id),
                latenz_ms=latenz_ms,
                fehler=f"HTTP {r.status_code}: {msg}",
            )

        return EmitterErgebnis(
            ok=False, backend_revision=None, latenz_ms=0,
            fehler="retry erschoepft",
        )

    # ── Mapping eines StatePatch (state_patch.StatePatch) -> Reducer-Call ─

    async def emittiere_state_patch(self, patch: Any) -> EmitterErgebnis:
        """
        Akzeptiert einen state_patch.StatePatch oder dessen to_event()-dict.
        Mappt das Pipeline-Tool auf einen Backend-Reducer und sendet.

        Gibt EmitterErgebnis(verworfen=True) zurueck wenn das Pipeline-Tool
        keinen Backend-Reducer hat (z.B. Lane-Status-Updates).
        """
        # Beide Eingabeformen unterstuetzen (StatePatch oder dict).
        if isinstance(patch, dict):
            tool_pipeline = patch.get("tool")
            case_id = patch.get("case_id")
            ops = patch.get("ops") or []
            kommentar = patch.get("kommentar")
        else:
            tool_pipeline = getattr(patch, "tool", None)
            case_id = getattr(patch, "case_id", None)
            ops = getattr(patch, "ops", None) or []
            kommentar = getattr(patch, "kommentar", None)

        if tool_pipeline not in TOOL_MAPPING:
            log.debug("Unbekanntes Pipeline-Tool '%s' verworfen.", tool_pipeline)
            return EmitterErgebnis(
                ok=True, backend_revision=None, latenz_ms=0, verworfen=True,
            )
        backend_tool = TOOL_MAPPING[tool_pipeline]
        if backend_tool is None:
            log.debug("Pipeline-Tool '%s' hat keinen Backend-Reducer (verworfen).",
                      tool_pipeline)
            return EmitterErgebnis(
                ok=True, backend_revision=None, latenz_ms=0, verworfen=True,
            )

        payload = self._payload_aus_ops(backend_tool, ops)
        if payload is None:
            log.warning("Konnte Payload fuer %s aus ops nicht ableiten.", backend_tool)
            return EmitterErgebnis(
                ok=True, backend_revision=None, latenz_ms=0, verworfen=True,
            )

        return await self.aktion(case_id, backend_tool, payload, kommentar=kommentar)

    # ── Payload-Extraktion aus RFC-6902-Ops ──────────────────────────────

    def _payload_aus_ops(
        self, backend_tool: str, ops: list[dict],
    ) -> Optional[dict[str, Any]]:
        """
        Pipeline emittiert RFC-6902-Patches direkt. Fuer den Backend-Reducer-
        Adapter brauchen wir aber strukturierte Payloads. Wir extrahieren sie
        aus den ops zurueck (Pipeline -> Reducer ist 1:1, also hilft uns das
        erste add-op).
        """
        if not ops:
            return None
        first = ops[0]
        value = first.get("value")

        # FLAG_SETZEN: pipeline emittiert ops=[{op:add, path:/flags/<name>, value:<v>}].
        # value ist hier KEIN dict (oft bool/str/zahl). Daher VOR dem dict-Check.
        if backend_tool == "FLAG_SETZEN":
            pfad = first.get("path", "")
            # /flags/<name> -> name (RFC-6901-Decode der ~0/~1-Escapes
            # brauchen wir hier nicht, weil flag-Namen bisher [a-z_]+ sind).
            if not pfad.startswith("/flags/"):
                return None
            flag_name = pfad[len("/flags/") :]
            if not flag_name:
                return None
            return {
                "flag_name": flag_name,
                "wert": value,
                "source": "sturm_pipeline",
            }

        if not isinstance(value, dict):
            return None

        if backend_tool == "BELEG_KLASSIFIZIERT":
            # Pipeline-Op: replace /belege/{idx}/klassifikation mit value=
            #   {beleg_id, typ, doc_typ_konfidenz, anlagen_hints,
            #    sub_anlagen[], steuerjahr_des_belegs, primaere_anlage}.
            # Reducer-Vertrag siehe BelegKlassifiziertPayload in
            # backend/src/core/reducers/beleg.ts.
            beleg_id = value.get("beleg_id")
            typ = value.get("typ")
            if not beleg_id or not typ:
                return None
            sub_anlagen = value.get("sub_anlagen")
            sub_dokumente = value.get("sub_dokumente")
            payload: dict[str, Any] = {
                "beleg_id": beleg_id,
                "typ": typ,
                "doc_typ_konfidenz": float(value.get("doc_typ_konfidenz", 0.5)),
                "anlagen_hints": value.get("anlagen_hints") or {},
            }
            if "steuerjahr_des_belegs" in value:
                payload["steuerjahr_des_belegs"] = value.get("steuerjahr_des_belegs")
            if "primaere_anlage" in value:
                payload["primaere_anlage"] = value.get("primaere_anlage")
            if sub_anlagen is not None:
                payload["sub_anlagen"] = sub_anlagen
            if sub_dokumente is not None:
                payload["sub_dokumente"] = sub_dokumente
            return payload

        if backend_tool == "BELEG_ANGENOMMEN":
            # Pipeline-Beleg hat alle Felder; wir mappen die Pflicht-Felder.
            return {
                "beleg_id": value.get("beleg_id"),
                "dateiname": value.get("dateiname"),
                "mime": value.get("mime"),
                "groesse_bytes": value.get("groesse_bytes"),
                "seitenzahl": value.get("seitenzahl"),
                "hochgeladen_von": value.get("hochgeladen_von"),
                "quellen_typ": value.get("quellen_typ"),
                "prioritaet": value.get("prioritaet"),
                "lane_permissions": value.get("lane_permissions"),
            }

        if backend_tool == "FELD_GESETZT":
            # value ist das _feld_zu_state_obj-Dict aus pipeline.py.
            pfad_voll = value.get("pfad", "")
            person_id = value.get("person_id")
            # domain_pfad = pfad ohne [person_id]-Suffix
            domain_pfad = pfad_voll
            if person_id and pfad_voll.endswith(f"[{person_id}]"):
                domain_pfad = pfad_voll[: -(len(person_id) + 2)]
            quelle = (value.get("alle_werte") or [{}])[0].get("quelle") or {
                "quellen_typ": "ki_extraktion",
                "actor": "sturm",
                "tool": "PASS2_EXTRAKTION",
                "modell": "mistral-large-latest",
            }
            return {
                "domain_pfad": domain_pfad,
                "person_id": person_id,
                "primaerer_elster_code": value.get("primaerer_elster_code"),
                "elster_code_aliase": value.get("elster_code_aliase") or [],
                "anlagen": value.get("anlagen") or [value.get("primaere_anlage")],
                "primaere_anlage": value.get("primaere_anlage"),
                "value_type": value.get("value_type", "string"),
                "wert": value.get("wert"),
                "konfidenz": value.get("konfidenz", 0.7),
                "quelle": quelle,
                "beleg_id": (value.get("alle_werte") or [{}])[0].get("beleg_id"),
                "sub_id": (value.get("alle_werte") or [{}])[0].get("sub_id"),
                "label": value.get("label"),
                "person_idnr": value.get("person_idnr"),
            }

        if backend_tool == "WARNUNG_HINZUGEFUEGT":
            # Reducer-Vertrag: warnung_id/severity/text/betroffene_pfade/quelle.
            schwere = value.get("schwere", "warn")
            severity = "error" if schwere == "fehler" else (
                "info" if schwere == "info" else "warn"
            )
            return {
                "warnung_id": value.get("warnung_id"),
                "severity": severity,
                "text": value.get("nachricht", ""),
                "betroffene_pfade": value.get("betroffene_pfade", []),
                "quelle": "sturm_pipeline",
            }

        if backend_tool == "PERSON_HINZUFUEGEN":
            # Pipeline-Person hat: person_id, rolle (steuerpflichtiger_a/_b/...),
            # idnr, vorname, nachname, namens_varianten, konfidenz_identitaet.
            #
            # Wave 15 RRR: bisheriger Code hat alle Personen ohne IdNr verworfen
            # ("Konnte Payload fuer PERSON_HINZUFUEGEN aus ops nicht ableiten").
            # Bei einer reinen ESt-PDF ohne VAST-Header haben wir oft KEINE
            # IdNr im klassischen Code-Mapping (E0100201 etc.) — die IdNr steckt
            # im Freitext-Feld E0200204. Trotzdem soll die Person im State
            # auftauchen, damit die UI den Hinweis "Person nicht identifiziert"
            # weglassen kann. Fallback: synth_<person_id> als Kanon-Schluessel.
            rolle_pipeline = value.get("rolle", "sonstige")
            rolle_map = {
                "steuerpflichtiger_a": "Stpfl",
                "steuerpflichtiger_b": "Ehegatte",
                "kind": "Kind",
                "sonstige": "Sonstige",
            }
            rolle_payload = rolle_map.get(rolle_pipeline, "Sonstige")
            varianten = value.get("namens_varianten") or []
            source = (
                varianten[0].get("quelle_beleg_id")
                if varianten and isinstance(varianten[0], dict)
                else "sturm_pass3"
            )
            idnr = value.get("idnr")
            person_id = value.get("person_id") or "p_unbekannt"
            if not idnr:
                # Synthetische IdNr aus person_id — der Reducer behandelt sie
                # transparent als kanonischen Schluessel (kein 11-stelliger
                # Format-Check im Reducer). UI kann sie an "synth_"-Praefix
                # erkennen und ggf. als "Identitaet noch nicht bestaetigt"
                # markieren.
                idnr = f"synth_{person_id}"
            return {
                "person_id": person_id,
                "idnr": idnr,
                "vorname": value.get("vorname"),
                "nachname": value.get("nachname"),
                "rolle": rolle_payload,
                "source": source,
                "konfidenz_identitaet": value.get("konfidenz_identitaet"),
                # Optional fuer KAP-Bescheinigungen:
                "kontoinhaber_bei": value.get("kontoinhaber_bei"),
            }

        if backend_tool == "SUB_ANLAGE_GESETZT":
            # Pipeline-Op: add /belege/{idx}/sub_anlagen/- mit value=sub_anlage.
            # Der Reducer erwartet allerdings einen Bulk-Payload mit beleg_id +
            # sub_anlagen[]. Wir extrahieren die beleg_id NICHT aus dem Pfad
            # (zu fragil), sondern erwarten sie im value oder Patch-kommentar.
            beleg_id = value.get("beleg_id")
            if not beleg_id:
                # Fallback: aus dem Pfad parsen (/belege/{idx}/sub_anlagen/-).
                # Wir kennen den Index, nicht die ID — gib auf, lass Pipeline
                # die ID explizit setzen.
                return None
            return {
                "beleg_id": beleg_id,
                "sub_anlagen": [
                    {
                        "anlage": value.get("anlage"),
                        "seiten": value.get("seiten") or [],
                        "person_id": value.get("person_id"),
                        "person_idnr": value.get("person_idnr"),
                        "vast_typ": value.get("vast_typ"),
                        "vast_uebernommen": value.get("vast_uebernommen"),
                        "konfidenz": value.get("konfidenz"),
                    },
                ],
            }

        if backend_tool == "LANES_STATUS_AKTUALISIEREN":
            # Pipeline-Op: replace /lanes_status/{lane} mit value={status,last_seen,...}
            # lane parsen wir aus dem Pfad.
            pfad = first.get("path", "")
            teile = pfad.strip("/").split("/")
            lane = teile[1] if len(teile) >= 2 else None
            if not lane:
                return None
            return {
                "lane": lane,
                "status": value.get("status"),
                "last_seen": value.get("last_seen"),
                "aktueller_task": value.get("aktueller_task"),
                "queue_len": value.get("queue_len"),
                "fehler_message": value.get("fehler_message"),
                "version": value.get("version"),
            }

        return None
