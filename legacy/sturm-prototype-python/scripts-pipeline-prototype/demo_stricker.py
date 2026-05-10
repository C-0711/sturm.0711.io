"""
Demo — laeuft die STURM-Pipeline gegen Stricker ESt 2023 PDF und
streamt alle StatePatch-Events auf stdout. Druckt am Ende eine
Zusammenfassung (Time-to-First-Chip, total Felder, etc.).

Run:
  export MISTRAL_API_KEY=$(grep MISTRAL ~/dev-cb-ctax/backend/.env | cut -d= -f2)
  python demo_stricker.py
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from pathlib import Path

# Eigene Module
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from mistral_client import MistralClient  # noqa: E402
from pipeline import extract_case  # noqa: E402
from backend_emitter import BackendEmitter  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)-22s | %(message)s",
)
log = logging.getLogger("sturm.demo")


STRICKER_PDF = Path(
    "/home/christoph.bertsch/dev-cb-ctax/test-data/stricker-desktop/"
    "Elster 2023 Stricker - Einkommensteuererklärung.pdf"
)
CASE_ID = "0711:ctax:demo:stricker_2023:v1"
JAHR = 2024  # Smart-Schema-Service hat aktuell nur 2024-Metadata


async def haupt(target: str = "stdout", case_id_override: str | None = None,
                backend_url: str = "http://localhost:3032",
                streaming: bool = True) -> int:
    if not STRICKER_PDF.exists():
        log.error("PDF nicht gefunden: %s", STRICKER_PDF)
        return 2

    case_id = case_id_override or CASE_ID
    emitter: BackendEmitter | None = None
    if target == "backend":
        emitter = BackendEmitter(base_url=backend_url, actor="sturm", rolle="super_admin")
        try:
            rev = await emitter.lese_aktuelle_revision(case_id)
            log.info("Backend-Modus aktiv: case_id=%s, aktuelle revision=%d", case_id, rev)
        except Exception as e:
            log.error("Backend nicht erreichbar oder Fall %s nicht gefunden: %s", case_id, e)
            await emitter.schliessen()
            return 5

    mistral = MistralClient()
    if not mistral.verfuegbar:
        log.error("Kein MISTRAL_API_KEY gesetzt — Demo bricht ab.")
        log.info("Tipp: export MISTRAL_API_KEY=$(grep MISTRAL ~/dev-cb-ctax/backend/.env | cut -d= -f2)")
        return 3

    print("=" * 80)
    print(f"STURM Pipeline Demo — case_id={case_id}")
    print(f"Target:              {target}")
    print(f"PDF:                 {STRICKER_PDF.name} ({STRICKER_PDF.stat().st_size} bytes)")
    print(f"Jahr (Schema):       {JAHR}")
    print(f"Mistral keys:        {len(mistral._keys)}")
    print("=" * 80)

    n_backend_ok = 0
    n_backend_verworfen = 0
    n_backend_fehler = 0
    backend_latenzen: list[int] = []

    start = time.time()
    n_patches = 0
    n_felder_patches = 0
    n_warnungen = 0
    first_feld_chip_ms = None
    case_state_acc: list[dict] = []  # alle Patches in Reihenfolge (rebuild-fae)
    felder_seen: list[dict] = []
    personen_seen: list[dict] = []
    sub_anlagen_seen: list[dict] = []
    doc_typ = None

    try:
        async for patch in extract_case(
            pdf_path=STRICKER_PDF,
            case_id=case_id,
            jahr=JAHR,
            mistral=mistral,
            streaming=streaming,
        ):
            n_patches += 1
            event = patch.to_event()
            case_state_acc.append(event)
            print(f"[{n_patches:03d}] r={patch.revision:>3} {patch.tool:<28} {patch.kommentar or ''}".rstrip())

            # Backend-Bridge: Patch ans Live-Backend pushen.
            if emitter is not None:
                try:
                    erg = await emitter.emittiere_state_patch(patch)
                    if erg.verworfen:
                        n_backend_verworfen += 1
                    elif erg.ok:
                        n_backend_ok += 1
                        if erg.latenz_ms > 0:
                            backend_latenzen.append(erg.latenz_ms)
                    else:
                        n_backend_fehler += 1
                        log.warning("Backend-Push fehlgeschlagen tool=%s: %s",
                                    patch.tool, erg.fehler)
                except Exception as e:
                    n_backend_fehler += 1
                    log.warning("Backend-Push exception tool=%s: %s", patch.tool, e)

            for op in patch.ops:
                p = op.get("path", "")
                v = op.get("value")
                if patch.tool == "BELEG_HINZUFUEGEN" and isinstance(v, dict):
                    doc_typ = v.get("typ")
                    sub_anlagen_seen.extend(v.get("sub_anlagen") or [])
                if patch.tool == "FELD_SETZEN" and isinstance(v, dict) and "wert" in v:
                    if first_feld_chip_ms is None:
                        first_feld_chip_ms = int((time.time() - start) * 1000)
                    n_felder_patches += 1
                    felder_seen.append({
                        "pfad": v.get("pfad"),
                        "elster_code": v.get("primaerer_elster_code"),
                        "wert": v.get("wert"),
                        "anlage": v.get("primaere_anlage"),
                        "person": v.get("person_id"),
                    })
                if patch.tool == "PERSON_HINZUFUEGEN" and isinstance(v, dict):
                    personen_seen.append(v)
                if patch.tool == "WARNUNG_REGISTRIEREN":
                    n_warnungen += 1

    except Exception as e:
        log.exception("Pipeline crashte:")
        print(f"\n!!! Pipeline-Fehler: {e}\n")
        return 4

    total_ms = int((time.time() - start) * 1000)

    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"Patches insgesamt:        {n_patches}")
    print(f"Davon FELD_SETZEN:        {n_felder_patches}")
    print(f"Warnungen:                {n_warnungen}")
    print(f"Doc-Type erkannt:         {doc_typ}")
    print(f"Sub-Anlagen erkannt:      {len(sub_anlagen_seen)}")
    if sub_anlagen_seen:
        for sa in sub_anlagen_seen:
            print(f"   - {sa.get('anlage'):8s} sub_id={sa.get('sub_id'):16s} "
                  f"person={sa.get('person_id') or '-':4s} seiten={sa.get('seiten')}")
    print(f"Personen kanonisiert:     {len(personen_seen)}")
    for p in personen_seen:
        print(f"   - {p.get('person_id'):4s} idnr={p.get('idnr') or '?'} "
              f"name={p.get('vorname') or ''} {p.get('nachname') or ''} "
              f"name_var={[nv['voller_name'] for nv in (p.get('namens_varianten') or [])]}")

    print(f"Pipeline gesamt:          {total_ms} ms")
    print(f"Time-to-First-Chip:       "
          f"{first_feld_chip_ms} ms (Ziel <3000)" if first_feld_chip_ms else "Time-to-First-Chip:       — kein FELD_SETZEN-Patch")
    print(f"Time-to-Vollstaendig:     {total_ms} ms (Ziel <17000)")

    print("\nFelder (Top 25):")
    for f in felder_seen[:25]:
        wert_short = str(f["wert"])[:60]
        print(f"   {f['anlage']:8s} {f['elster_code']:10s} {f['pfad'][:55]:55s} = {wert_short}")

    if len(felder_seen) > 25:
        print(f"   ... und {len(felder_seen) - 25} weitere.")

    # Fokus-Werte (Stricker-Erwartung)
    print("\nFokus-Werte (erwartet bei Stricker ESt 2023):")
    for ec in ("E0200204", "E0200304", "E0200404", "E0200504", "E0100201", "E0100202"):
        treffer = [f for f in felder_seen if f["elster_code"] == ec]
        if treffer:
            for t in treffer:
                print(f"   {ec}  {t['pfad'][:50]:50s} = {t['wert']}")
        else:
            print(f"   {ec}  ? nicht extrahiert")

    if emitter is not None:
        avg_lat = sum(backend_latenzen) // len(backend_latenzen) if backend_latenzen else 0
        max_lat = max(backend_latenzen) if backend_latenzen else 0
        print("\nBackend-Bridge:")
        print(f"   Patches gepusht (200): {n_backend_ok}")
        print(f"   Verworfen (kein Reducer): {n_backend_verworfen}")
        print(f"   Fehler:                {n_backend_fehler}")
        print(f"   Latenz Ø/max:          {avg_lat} / {max_lat} ms")
        await emitter.schliessen()

    return 0 if n_felder_patches > 0 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", choices=["stdout", "backend"], default="stdout")
    parser.add_argument("--case-id", default=None,
                        help="Bestehender case_id (Backend-Modus). Default = demo case.")
    parser.add_argument("--backend-url", default="http://localhost:3032")
    parser.add_argument("--no-streaming", action="store_true",
                        help="Deaktiviert Pass-2-Streaming (Backward-Compat-Pfad).")
    args = parser.parse_args()
    rc = asyncio.run(haupt(target=args.target, case_id_override=args.case_id,
                           backend_url=args.backend_url,
                           streaming=not args.no_streaming))
    sys.exit(rc)
