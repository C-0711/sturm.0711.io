#!/usr/bin/env python3
"""
Welle 4 — Constrained-LLM-Fallback via Gemma-4 (Ollama JSON-Schema mode).

Input:
  - Welle 1-3 Output (55 locked eCodes als VORANALYSIERTE HINTS)
  - OCR-Volltext der Stricker.pdf
  - ELSTER-Container atoms.json (alle 2287 eCodes mit Metadaten als Lookup)

Output: JSON-Schema-constrained Liste zusätzlicher {ecode, value, drucktext,
source_line, anlage}-Tripel die der LLM aus dem OCR-Volltext mit eCode-Lookup
aus dem Container ableiten kann. Werden in locks.dict gemerged.
"""
import json
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).parent
ATOMS_JSON = ROOT.parent / "Upload" / "data" / "atoms.json"
SOLVER_JSON = ROOT / "out" / "solver_result.json"
OCR_FILE = ROOT / "out" / "ocr" / "Elster 2023 Stricker - Einkommensteuererklärung.ocr.txt"
OUT_JSON = ROOT / "out" / "welle4_result.json"
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "gemma4:e4b"


def build_compact_catalog(atoms: list[dict]) -> list[dict]:
    """Compact view of ELSTER container — only metadata needed for eCode lookup."""
    out = []
    for a in atoms:
        meta = a.get("metadata", {})
        out.append({
            "ecode": a["field_name"],
            "drucktext": (meta.get("drucktext") or "").replace("\n", " "),
            "anlage": meta.get("anlage"),
            "vordruckzeile": meta.get("vordruckzeile"),
            "datentyp": meta.get("datentyp"),
        })
    return out


def call_gemma(prompt: str, schema: dict) -> Optional[dict]:
    payload = {
        "model": MODEL,
        "prompt": prompt,
        "format": schema,        # Ollama 0.5+ constrained JSON
        "stream": False,
        "options": {"temperature": 0.0, "num_ctx": 32768},
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        OLLAMA_URL,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            text = r.read().decode()
        resp = json.loads(text)
        return json.loads(resp.get("response", "{}"))
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as e:
        print(f"  Gemma call failed: {e}")
        return None


def main():
    print("=== Welle 4 — Gemma-4 Constrained-LLM-Fallback ===")
    print()

    # Load Welle 1-3 results
    with open(SOLVER_JSON) as f:
        solver = json.load(f)
    locked = {k: v for k, v in solver["locks"].items() if not k.startswith("PSEUDO")}
    print(f"Loaded {len(locked)} locked eCodes from Welle 1-3")

    # Load OCR
    ocr_text = OCR_FILE.read_text()
    print(f"OCR length: {len(ocr_text)} chars")

    # Load container
    atoms = json.load(open(ATOMS_JSON))
    print(f"ELSTER container: {len(atoms)} atoms")

    # Compact catalog — filter to anlagen present in our locked-set + Sonderausgaben
    # (SA is where KiSt-gezahlt/erstattet lives, not in our locks yet)
    active_anlagen = {(v.get("anlage") or "").upper() for v in locked.values()}
    active_anlagen.update({"SA", "AV", "N", "KAP", "ESt1A", "Vorsorgeaufwand", "VOR"})
    catalog = build_compact_catalog(atoms)
    catalog_active = [c for c in catalog
                      if c.get("anlage") and c["anlage"].upper() in
                         {a.upper() for a in active_anlagen}]
    print(f"Catalog (active anlagen only): {len(catalog_active)} atoms")

    # Build hints — Welle 1-3 already-locked
    hints = []
    for k, v in locked.items():
        hints.append({
            "ecode": v["ecode"],
            "value": str(v["value"]),
            "drucktext": v["drucktext"][:60],
            "line": v["line_no"],
            "anlage": v["anlage"],
            "person": k.split("__")[-1] if "__" in k else None,
        })

    schema = {
        "type": "object",
        "properties": {
            "additional_locks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ecode":        {"type": "string"},
                        "value":        {"type": "string"},
                        "drucktext":    {"type": "string"},
                        "source_line":  {"type": "integer"},
                        "anlage":       {"type": "string"},
                        "person":       {"type": "string", "enum": ["A", "B", "none"]},
                        "confidence":   {"type": "number"},
                    },
                    "required": ["ecode", "value", "drucktext", "source_line", "anlage"],
                },
            },
        },
        "required": ["additional_locks"],
    }

    prompt = f"""Du bist ein deterministischer ELSTER-Parser. Aus einem PDF einer deutschen \
Einkommensteuererklärung 2023 sollen ELSTER-eCodes zu extrahierten Werten zugeordnet werden.

--- VORANALYSIERTE FORM-FIELD-HINTS (mathematisch verifiziert, NICHT ändern) ---
Diese {len(hints)} eCodes wurden bereits durch Ratio-Math + Label-Adjacency gelockt. \
Sie sind die WAHRHEIT und definieren die Anlage-Struktur des Dokuments:

{json.dumps(hints, ensure_ascii=False, indent=2)}

--- ELSTER-CONTAINER (eCode-Lookup) ---
Die folgende Liste enthält alle ELSTER-eCodes der relevanten Anlagen mit ihren \
Drucktexten. Du DARFST NUR eCodes aus dieser Liste verwenden:

{json.dumps(catalog_active, ensure_ascii=False)[:50000]}

--- OCR-VOLLTEXT (Einkommensteuererklärung 2023 Stricker) ---
{ocr_text}

--- AUFGABE ---
Finde im OCR-Volltext WEITERE Werte die noch NICHT in den HINTS gelockt sind, \
und ordne sie ihren ELSTER-eCodes aus dem Container zu.

Konkrete Lücken im aktuellen Lockset (DU SOLLST diese auffüllen, nicht erfinden):
1. KAP-Antrag Überprüfung des Steuereinbehalts (Person A + Person B) — Wert "1" für Ja
2. Sonderausgaben Kirchensteuer gezahlt 2023 = 924 EUR
3. Sonderausgaben Kirchensteuer erstattet 2023 = 356 EUR
4. Anlage N Werbungskosten — Arbeitsmittel-Betrag 103, Kontoführungsgebühren 16, \
   Berufl. Anteil Rechtsschutzversicherung 88
5. Anlage AV — Bezeichnung "Arbeitgeberanteil zur Zukunftssicherung" + Betrag 456

REGELN:
- NUR eCodes aus dem ELSTER-Container verwenden. KEINE erfundenen eCodes.
- source_line muss die OCR-Zeile sein in der der Wert steht.
- person="A" für Rainer Stricker, "B" für Ute Stricker, "none" für Felder ohne Personentrennung.
- value als String wie er im OCR steht.
- confidence 0.0-1.0 — wie sicher die Zuordnung ist.

Liefere JSON mit "additional_locks"-Array."""

    print(f"\nPrompt size: {len(prompt)} chars")
    print(f"Calling {MODEL} via Ollama...")
    result = call_gemma(prompt, schema)

    if result is None:
        print("Welle 4 failed — no response")
        return

    add = result.get("additional_locks", [])
    print(f"\n=== Gemma returned {len(add)} additional locks ===")
    for lock in add:
        print(f"  L{lock.get('source_line','?'):>3} {lock.get('ecode'):<12} [{lock.get('anlage','—'):<10}] "
              f"{lock.get('drucktext','')[:35]:35} = {lock.get('value')}  (conf={lock.get('confidence', '—')})")

    # Save
    OUT_JSON.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"\nWritten: {OUT_JSON}")


if __name__ == "__main__":
    main()
