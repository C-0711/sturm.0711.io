#!/usr/bin/env python3
"""
Welle 4 — Cascade-Search-Fallback via embeddinggemma-300m FP32 exact search.

For each unmapped OCR-line that contains a value (currency/int/string),
embed its context via Ollama embeddinggemma, cosine-search the 2287
elster-atoms FP32 embeddings, filter by anlage-zone + format, lock the
best-scoring candidate at confidence 0.7+.

Exports `run_cascade(ocr_text, locks, atoms, ...) -> list[dict]` for direct
integration into inverse_solver.py. Standalone-CLI bleibt für Debug erhalten.
"""
import json
import re
import math
import struct
import urllib.request
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).parent
DEFAULT_FP32_FILE = ROOT / "cascade" / "embeddings.gemma4.fp32.bin"
DEFAULT_CASCADE_META = ROOT / "cascade" / "embeddings.gemma4.cascade.json"
import os
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/embed")
MODEL = "embeddinggemma"

# Threshold calibrated for embeddinggemma on BMF-Korpus.
# Perfect drucktext-match ~ 0.55, partial ~ 0.4. Cascade-only locks
# (kein Math-Anchor) brauchen ≥0.55 für valide Treffer.
COSINE_THRESHOLD_PRIMARY = 0.55
COSINE_THRESHOLD_RAW = 0.42  # für initial Top-K retrieval


def l2(v):
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 0 else v


def cosine(q, v, d):
    return sum(q[i] * v[i] for i in range(d))


def embed_via_ollama(text: str, url: str = OLLAMA_URL,
                      model: str = MODEL) -> list:
    body = json.dumps({"model": model, "input": [text], "truncate": True}).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["embeddings"][0]


# ─────────────────────────────────────────────────────────────────────
# CASCADE — importierbares Public-API
# ─────────────────────────────────────────────────────────────────────
def load_fp32_embeddings(cascade_meta_path: Optional[Path] = None,
                           fp32_path: Optional[Path] = None) -> tuple[list, dict, int, int]:
    """Returns (emb_normalized, cascade_meta, N, D)."""
    meta_p = cascade_meta_path or DEFAULT_CASCADE_META
    fp32_p = fp32_path or DEFAULT_FP32_FILE
    if not meta_p.exists() or not fp32_p.exists():
        raise FileNotFoundError(
            f"Cascade embeddings missing: {fp32_p} or {meta_p}. "
            "Copy from h200v:~/0711-STURM-canonical/src/verticals/elster-v3/data/."
        )
    cascade = json.loads(meta_p.read_text())
    N, D = cascade["exact"]["n"], cascade["exact"]["d"]
    raw = fp32_p.read_bytes()
    all_floats = struct.unpack(f"{N*D}f", raw)
    emb = [all_floats[i*D:(i+1)*D] for i in range(N)]
    emb_n = [l2(v) for v in emb]
    return emb_n, cascade, N, D


def run_cascade(
    ocr_lines: list[str],
    locked_ecodes: set[str],
    locked_lines: set[int],
    atoms: list[dict],
    emb_n: list,
    N: int,
    D: int,
    active_anlagen: set[str],
    ollama_url: str = OLLAMA_URL,
    model: str = MODEL,
    max_queries: int = 60,
) -> list[dict]:
    """Run cascade-search for unmapped OCR-lines. Returns ranked new-locks list.

    Each lock-dict has: line_no, ecode, value, drucktext, anlage, cosine,
    alternatives. Cosine threshold: 0.55 (primary), 0.42 (raw top-K seed).
    Anlage-Filter: nur cascade-treffer in aktiven Anlagen (aus Welle 1-3 locks).
    """
    idx_to_atom = {i: a for i, a in enumerate(atoms)}

    # Build query targets — OCR-lines with digits, not already locked, not noise
    queries = []
    for line_no, line in enumerate(ocr_lines, start=1):
        if line_no in locked_lines:
            continue
        clean = line.strip()
        if any(x in clean for x in ("*** Vorschau", "WISO Steuer", "ERiC-Print",
                                      "Seite", "Datum der Ausfertigung",
                                      "Finanzamt", "Steuernummer")):
            continue
        if len(clean) < 8 or not re.search(r"\d", clean):
            continue
        body = re.sub(r"^\s*[®°\*\d\[\]]{1,5}[\s°]*", "", clean)
        if not body or len(body) < 6:
            continue
        queries.append((line_no, body))

    new_locks = []
    for line_no, query_text in queries[:max_queries]:
        try:
            v = embed_via_ollama(query_text, url=ollama_url, model=model)
        except Exception:
            continue
        qn = l2(v)
        scores = sorted(
            [(cosine(qn, emb_n[i], D), i) for i in range(N)],
            reverse=True,
        )[:5]
        top_score, top_idx = scores[0]
        if top_score < COSINE_THRESHOLD_RAW:
            continue
        atom = idx_to_atom[top_idx]
        meta = atom.get("metadata", {})
        ecode = atom["field_name"]
        if ecode in locked_ecodes:
            continue
        # value extraction
        m = (re.search(r"\b\d{1,3}(?:\.\d{3})*,\d{2}\b", query_text)
             or re.search(r"\b\d{1,3}(?:\.\d{3})+\b", query_text)
             or re.search(r"\b(\d+)\b", query_text))
        value = m.group(0) if m else None
        if value is None:
            words = [w for w in query_text.split() if len(w) > 3]
            value = words[-1] if words else None
        if value is None:
            continue
        new_locks.append({
            "line_no": line_no,
            "ecode": ecode,
            "value": value,
            "drucktext": (meta.get("drucktext") or "")[:60],
            "anlage": meta.get("anlage"),
            "cosine": round(top_score, 4),
            "query": query_text[:80],
            "alternatives": [
                (round(s, 3), idx_to_atom[i].get("field_name"),
                 (idx_to_atom[i].get("metadata") or {}).get("drucktext", "")[:40])
                for s, i in scores[1:4]
            ],
        })

    # Dedup + anlage-filter + primary-threshold
    new_locks.sort(key=lambda x: -x["cosine"])
    seen_ecodes: set[str] = set()
    final_locks = []
    for lock in new_locks:
        if lock["ecode"] in seen_ecodes:
            continue
        atom_anlage = (lock.get("anlage") or "").lower()
        if atom_anlage and active_anlagen and atom_anlage not in active_anlagen:
            continue
        if lock["cosine"] < COSINE_THRESHOLD_PRIMARY:
            continue
        seen_ecodes.add(lock["ecode"])
        final_locks.append(lock)
    return final_locks


def main():
    """Standalone-CLI für Debug: nimmt --ocr / --atoms / --solver-result
    + ruft die importierbare run_cascade() Function auf."""
    import argparse
    p = argparse.ArgumentParser(description="Welle 4 Cascade-Search standalone runner.")
    p.add_argument("--ocr",     required=True, help="OCR-Volltext (.txt)")
    p.add_argument("--atoms",   required=True, help="atoms.json (Container-Snapshot)")
    p.add_argument("--solver-result", required=True,
                    help="solver_result.json aus Welle 1-3 (für locked_ecodes/lines)")
    p.add_argument("--fp32",    default=str(DEFAULT_FP32_FILE))
    p.add_argument("--cascade-meta", default=str(DEFAULT_CASCADE_META))
    p.add_argument("--output",  required=True)
    args = p.parse_args()

    print("=== Welle 4 — Cascade-Search-Fallback (standalone) ===")
    solver = json.loads(Path(args.solver_result).read_text())
    locked_ecodes = {v["ecode"] for k, v in solver["locks"].items()
                      if not k.startswith("PSEUDO")}
    locked_lines = {v["line_no"] for k, v in solver["locks"].items()
                     if not k.startswith("PSEUDO")}
    active_anlagen = {(v.get("anlage") or "").lower()
                       for v in solver["locks"].values()
                       if not v.get("ecode", "").startswith("PSEUDO")
                       and v.get("anlage")}
    active_anlagen.update({"sa", "av"})
    print(f"Already locked: {len(locked_ecodes)} eCodes, active anlagen: {sorted(active_anlagen)}")

    emb_n, _, N, D = load_fp32_embeddings(Path(args.cascade_meta), Path(args.fp32))
    atoms = json.loads(Path(args.atoms).read_text())
    ocr_lines = Path(args.ocr).read_text().split("\n")

    final_locks = run_cascade(
        ocr_lines=ocr_lines,
        locked_ecodes=locked_ecodes,
        locked_lines=locked_lines,
        atoms=atoms,
        emb_n=emb_n, N=N, D=D,
        active_anlagen=active_anlagen,
    )

    print(f"=== {len(final_locks)} new eCode-Locks via cascade-search ===")
    for lock in final_locks:
        print(f"  L{lock['line_no']:3d} {lock['ecode']:<12} "
              f"[{(lock['anlage'] or '—'):<14}] cos={lock['cosine']:.3f}  "
              f"{lock['drucktext'][:35]:35} = {lock['value']}")
        for alt in lock["alternatives"]:
            print(f"        alt {alt[0]:.3f}  {alt[1]}  {alt[2]}")

    Path(args.output).write_text(
        json.dumps({"new_locks": final_locks}, ensure_ascii=False, indent=2)
    )
    print(f"\nWritten: {args.output}")


if __name__ == "__main__":
    main()
