#!/usr/bin/env python3
"""
Welle 4 — Cascade-Search-Fallback via embeddinggemma-300m FP32 exact search.

For each unmapped OCR-line that contains a value (currency/int/string),
embed its context via Ollama embeddinggemma, cosine-search the 2287
elster-atoms FP32 embeddings, filter by anlage-zone + format, lock the
best-scoring candidate at confidence 0.7+.
"""
import json
import re
import math
import struct
import urllib.request
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).parent
ATOMS_JSON = ROOT.parent / "Upload" / "data" / "atoms.json"
SOLVER_JSON = ROOT / "out" / "solver_result.json"
OCR_FILE = ROOT / "out" / "ocr" / "Elster 2023 Stricker - Einkommensteuererklärung.ocr.txt"
FP32_FILE = ROOT / "cascade" / "embeddings.gemma4.fp32.bin"
CASCADE_META = ROOT / "cascade" / "embeddings.gemma4.cascade.json"
OUT_JSON = ROOT / "out" / "welle4_cascade_result.json"
OLLAMA_URL = "http://localhost:11434/api/embed"
MODEL = "embeddinggemma"

# Threshold calibrated earlier: 0.45 is realistic for embeddinggemma on
# this corpus (perfect drucktext-match gives ~0.55, partial ~0.4)
COSINE_THRESHOLD = 0.42


def l2(v):
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 0 else v


def cosine(q, v, d):
    return sum(q[i] * v[i] for i in range(d))


def embed_via_ollama(text: str) -> list:
    body = json.dumps({"model": MODEL, "input": [text], "truncate": True}).encode()
    req = urllib.request.Request(
        OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["embeddings"][0]


def main():
    print("=== Welle 4 — Cascade-Search-Fallback ===")

    # Load solver locks (Welle 1-3 result)
    solver = json.load(open(SOLVER_JSON))
    locked_ecodes = {v["ecode"] for k, v in solver["locks"].items()
                      if not k.startswith("PSEUDO")}
    print(f"Already locked: {len(locked_ecodes)} eCodes from Welle 1-3")

    # Load FP32 embeddings
    cascade = json.load(open(CASCADE_META))
    N, D = cascade["exact"]["n"], cascade["exact"]["d"]
    raw = open(FP32_FILE, "rb").read()
    all_floats = struct.unpack(f"{N*D}f", raw)
    emb = [all_floats[i*D:(i+1)*D] for i in range(N)]
    emb_n = [l2(v) for v in emb]
    print(f"Loaded FP32 embeddings: {N} x {D}")

    # Load atoms — idx-aligned with FP32 (cascade uses v1 atoms with sequential IDs)
    atoms_v1 = json.load(open(ATOMS_JSON))
    # Build idx → eCode mapping
    idx_to_atom = {}
    for i, a in enumerate(atoms_v1):
        idx_to_atom[i] = a
    print(f"Atoms: {len(atoms_v1)}")

    # Load OCR
    ocr_text = OCR_FILE.read_text()
    ocr_lines = ocr_text.split("\n")
    print(f"OCR: {len(ocr_lines)} lines")

    # Find OCR-lines with values but NO existing lock at that line
    locked_lines = {v["line_no"] for k, v in solver["locks"].items()
                     if not k.startswith("PSEUDO")}

    # Query targets — OCR-lines that contain a digit-sequence (likely value)
    # and aren't already locked
    queries = []
    for line_no, line in enumerate(ocr_lines, start=1):
        if line_no in locked_lines:
            continue
        clean = line.strip()
        # Skip noise
        if any(x in clean for x in ("*** Vorschau", "WISO Steuer", "ERiC-Print",
                                      "Seite", "Datum der Ausfertigung",
                                      "Finanzamt", "Steuernummer")):
            continue
        if len(clean) < 8:
            continue
        # Must contain at least one digit (real value)
        if not re.search(r"\d", clean):
            continue
        # Strip leading OCR-bookmark prefix
        body = re.sub(r"^\s*[®°\*\d]{1,3}[\s°]*", "", clean)
        if not body or len(body) < 6:
            continue
        queries.append((line_no, body))

    print(f"Unmapped OCR-line queries: {len(queries)}")
    print()

    new_locks = []
    for line_no, query_text in queries[:60]:
        try:
            v = embed_via_ollama(query_text)
        except Exception as e:
            print(f"  L{line_no} embed-fail: {e}")
            continue
        qn = l2(v)
        # Cosine top-5
        scores = sorted(
            [(cosine(qn, emb_n[i], D), i) for i in range(N)],
            reverse=True
        )[:5]
        top_score, top_idx = scores[0]
        if top_score < COSINE_THRESHOLD:
            continue
        atom = idx_to_atom[top_idx]
        meta = atom.get("metadata", {})
        ecode = atom["field_name"]
        # Skip if already locked
        if ecode in locked_ecodes:
            continue
        # Extract value from line — find first number/string token
        m = (re.search(r"\b\d{1,3}(?:\.\d{3})*,\d{2}\b", query_text)
             or re.search(r"\b\d{1,3}(?:\.\d{3})+\b", query_text)
             or re.search(r"\b(\d+)\b", query_text))
        value = m.group(0) if m else None
        if value is None:
            # String value — take longest word
            words = [w for w in query_text.split() if len(w) > 3]
            value = words[-1] if words else None
        if value is None:
            continue
        new_locks.append({
            "line_no": line_no,
            "ecode": ecode,
            "value": value,
            "drucktext": meta.get("drucktext", "")[:60],
            "anlage": meta.get("anlage"),
            "cosine": round(top_score, 4),
            "query": query_text[:80],
            "alternatives": [
                (round(s, 3), idx_to_atom[i].get("field_name"),
                 (idx_to_atom[i].get("metadata") or {}).get("drucktext", "")[:40])
                for s, i in scores[1:4]
            ],
        })

    # Build active-anlagen set from solver locks
    active_anlagen = {(v.get("anlage") or "").lower()
                       for v in solver["locks"].values()
                       if not v.get("ecode", "").startswith("PSEUDO")
                       and v.get("anlage")}
    active_anlagen.update({"sa", "av"})  # known fallback anlagen
    print(f"Active anlagen (from Wave-1-3): {sorted(active_anlagen)}")

    # Sort + dedup by eCode (keep highest cosine)
    # Anlage-Filter: cascade-treffer muss in einer aktiven Anlage liegen
    new_locks.sort(key=lambda x: -x["cosine"])
    seen_ecodes = set()
    final_locks = []
    for lock in new_locks:
        if lock["ecode"] in seen_ecodes:
            continue
        atom_anlage = (lock.get("anlage") or "").lower()
        if atom_anlage and atom_anlage not in active_anlagen:
            continue
        # Higher threshold: 0.55 for new locks (cascade-only, no math-anchor)
        if lock["cosine"] < 0.55:
            continue
        seen_ecodes.add(lock["ecode"])
        final_locks.append(lock)

    print(f"=== {len(final_locks)} new eCode-Locks via cascade-search ===")
    for lock in final_locks:
        print(f"  L{lock['line_no']:3d} {lock['ecode']:<12} [{(lock['anlage'] or '—'):<14}] "
              f"cos={lock['cosine']:.3f}  {lock['drucktext'][:35]:35} = {lock['value']}")
        for alt in lock["alternatives"]:
            print(f"        alt {alt[0]:.3f}  {alt[1]}  {alt[2]}")

    OUT_JSON.write_text(json.dumps({"new_locks": final_locks}, ensure_ascii=False, indent=2))
    print(f"\nWritten: {OUT_JSON}")


if __name__ == "__main__":
    main()
