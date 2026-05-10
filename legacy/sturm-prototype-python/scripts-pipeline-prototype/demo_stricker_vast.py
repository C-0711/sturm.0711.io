"""
Demo — STURM-Pipeline gegen 'VAST Belege Stricker.pdf' (5 Bescheinigungen).

Zeigt VAST-Detection, Bescheinigungs-Klassifikation, IdNr-Personen-Kanonisierung
mit Namens-Varianten ("Ute" vs "Maria Ute") und §34-Trigger (Zeile 19).

Run:
  cd ~/dev-cb-ctax/scripts/sturm_pipeline_prototype/
  source .venv/bin/activate
  export MISTRAL_API_KEY=$(grep MISTRAL ~/dev-cb-ctax/backend/.env | cut -d= -f2)
  python demo_stricker_vast.py                     # → stdout
  python demo_stricker_vast.py --target backend --case-id <id>   # → POST /api/case/<id>/state-patch
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import httpx  # noqa: E402
from mistral_client import MistralClient  # noqa: E402
from pipeline import extract_case  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)-22s | %(message)s",
)
log = logging.getLogger("sturm.demo_vast")


VAST_PDF = Path(
    "/home/christoph.bertsch/dev-cb-ctax/test-data/stricker-desktop/"
    "VAST Belege Stricker.pdf"
)
DEFAULT_CASE_ID = "0711:ctax:demo:stricker_vast_2024:v1"
JAHR = 2024


async def haupt() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", choices=["stdout", "backend"], default="stdout")
    parser.add_argument("--case-id", default=DEFAULT_CASE_ID)
    parser.add_argument("--backend-url", default="http://localhost:3032")
    args = parser.parse_args()

    if not VAST_PDF.exists():
        log.error("PDF nicht gefunden: %s", VAST_PDF)
        return 2

    mistral = MistralClient()
    if not mistral.verfuegbar:
        log.warning("Kein MISTRAL_API_KEY gesetzt — Pass 1+VAST nutzen Heuristik-Fallback.")
    print("=" * 80)
    print(f"STURM VAST Pipeline Demo — case_id={args.case_id}")
    print(f"PDF:                 {VAST_PDF.name} ({VAST_PDF.stat().st_size} bytes)")
    print(f"Jahr (Schema):       {JAHR}")
    print(f"Target:              {args.target}")
    print(f"Mistral keys:        {len(mistral._keys)}")
    print("=" * 80)

    start = time.time()
    n_patches = 0
    n_felder_patches = 0
    n_warnungen = 0
    n_flags = 0
    first_feld_chip_ms: int | None = None
    flags_set: dict = {}
    sub_anlagen_seen: list[dict] = []
    bescheinigungen_uebernommen: list[bool] = []
    personen_seen: list[dict] = []
    felder_seen: list[dict] = []
    warnungen_seen: list[dict] = []
    doc_typ = None

    backend_client: httpx.AsyncClient | None = None
    if args.target == "backend":
        backend_client = httpx.AsyncClient(base_url=args.backend_url, timeout=10.0)

    try:
        async for patch in extract_case(
            pdf_path=VAST_PDF,
            case_id=args.case_id,
            jahr=JAHR,
            mistral=mistral,
        ):
            n_patches += 1
            event = patch.to_event()
            print(f"[{n_patches:03d}] r={patch.revision:>3} {patch.tool:<28} {patch.kommentar or ''}".rstrip())

            if backend_client is not None:
                try:
                    resp = await backend_client.post(
                        f"/api/case/{args.case_id}/state-patch",
                        json=event,
                    )
                    if resp.status_code >= 400:
                        log.warning("backend POST → %s: %s", resp.status_code, resp.text[:200])
                except Exception as e:
                    log.warning("backend POST scheitert: %s", e)

            for op in patch.ops:
                v = op.get("value")
                if patch.tool == "BELEG_HINZUFUEGEN" and isinstance(v, dict):
                    doc_typ = v.get("typ")
                    sub_anlagen_seen.extend(v.get("sub_anlagen") or [])
                    for sa in (v.get("sub_anlagen") or []):
                        if sa.get("vast_typ"):
                            bescheinigungen_uebernommen.append(bool(sa.get("vast_uebernommen")))
                if patch.tool == "FELD_SETZEN" and isinstance(v, dict) and "wert" in v:
                    if first_feld_chip_ms is None:
                        first_feld_chip_ms = int((time.time() - start) * 1000)
                    n_felder_patches += 1
                    felder_seen.append({
                        "pfad": v.get("pfad"),
                        "elster_code": v.get("primaerer_elster_code"),
                        "wert": v.get("wert"),
                        "anlage": v.get("primaere_anlage"),
                        "person": v.get("person_idnr") or v.get("person_id"),
                    })
                if patch.tool == "PERSON_HINZUFUEGEN" and isinstance(v, dict):
                    personen_seen.append(v)
                if patch.tool == "WARNUNG_REGISTRIEREN" and isinstance(v, dict):
                    n_warnungen += 1
                    warnungen_seen.append(v)
                if patch.tool == "FLAG_SETZEN":
                    n_flags += 1
                    # path = /flags/{name}
                    name = (op.get("path") or "").rsplit("/", 1)[-1]
                    flags_set[name] = v

    except Exception as e:
        log.exception("Pipeline crashte:")
        print(f"\n!!! Pipeline-Fehler: {e}\n")
        return 4
    finally:
        if backend_client is not None:
            await backend_client.aclose()

    total_ms = int((time.time() - start) * 1000)

    print("\n" + "=" * 80)
    print("VAST SUMMARY")
    print("=" * 80)
    print(f"Patches insgesamt:              {n_patches}")
    print(f"Davon FELD_SETZEN:              {n_felder_patches}")
    print(f"Warnungen:                      {n_warnungen}")
    print(f"Flags gesetzt:                  {n_flags}  {flags_set}")
    print(f"Doc-Type erkannt:               {doc_typ}")
    print(f"Bescheinigungen erkannt:        {len(sub_anlagen_seen)}")
    if sub_anlagen_seen:
        n_uebernommen = sum(1 for s in sub_anlagen_seen if s.get("vast_uebernommen"))
        n_nicht_uebernommen = sum(1 for s in sub_anlagen_seen if s.get("vast_uebernommen") is False)
        print(f"   übernommen:                  {n_uebernommen}")
        print(f"   nicht übernommen:            {n_nicht_uebernommen}")
        for sa in sub_anlagen_seen:
            status = "✓ über" if sa.get("vast_uebernommen") else "✗ nicht über"
            print(f"   - {sa.get('vast_typ', '?'):24s} [{sa.get('anlage'):6s}] {status:14s} "
                  f"idnr={sa.get('vast_empfaenger_idnr') or '-':<11s} "
                  f"von={sa.get('vast_uebermittler') or '-'}")
    print(f"Personen kanonisiert:           {len(personen_seen)}")
    for p in personen_seen:
        nv = [nv["voller_name"] for nv in (p.get("namens_varianten") or [])]
        print(f"   - idnr={p.get('idnr') or '?':<11s} "
              f"name={p.get('vorname') or ''} {p.get('nachname') or ''}  "
              f"namens_varianten={nv}")

    print(f"§34-Trigger gesetzt:            {flags_set.get('fuenftelung_pruefen', False)}")
    print(f"Pipeline gesamt:                {total_ms} ms")
    print(f"Time-to-First-Chip:             {first_feld_chip_ms} ms")

    print("\nFelder (Top 25):")
    for f in felder_seen[:25]:
        wert_short = str(f["wert"])[:50]
        print(f"   {f['anlage']:8s} {f['elster_code']:10s} {f['pfad'][:55]:55s} = {wert_short}")
    if len(felder_seen) > 25:
        print(f"   ... und {len(felder_seen) - 25} weitere.")

    # Validation gegen Erwartung
    print("\nErwartung-Check (Stricker VAST 2024):")
    rainer_idnr = "85236749007"
    ute_idnr = "54129386608"
    p_rainer = next((p for p in personen_seen if p.get("idnr") == rainer_idnr), None)
    p_ute = next((p for p in personen_seen if p.get("idnr") == ute_idnr), None)
    print(f"   Rainer ({rainer_idnr}):       {'OK' if p_rainer else 'FEHLT'}")
    print(f"   Ute ({ute_idnr}):             {'OK' if p_ute else 'FEHLT'}")
    if p_ute:
        nv = [nv["voller_name"] for nv in (p_ute.get("namens_varianten") or [])]
        has_both = any("Maria Ute" in n for n in nv) and any("Ute" in n and "Maria" not in n for n in nv)
        print(f"   Ute Namens-Varianten:        {nv} → {'BEIDE OK' if has_both else 'unvollständig'}")

    n_besch = len([s for s in sub_anlagen_seen if s.get("vast_typ")])
    print(f"   5 Bescheinigungen:           {n_besch} → {'OK' if n_besch == 5 else 'WARN'}")
    print(f"   §34-Flag (Zeile 19 = 300 €): {flags_set.get('fuenftelung_pruefen', False)}")

    return 0 if n_patches > 0 else 1


if __name__ == "__main__":
    rc = asyncio.run(haupt())
    sys.exit(rc)
