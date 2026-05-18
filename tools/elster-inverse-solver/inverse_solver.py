#!/usr/bin/env python3
"""
ELSTER Inverse Solver — derives eCodes from Einkommensteuererklärung via
constraint propagation. No hardcoded ground-truth values.

Architecture (6 waves):
  W0  raw OCR token extraction (numbers, dates, anlage/person context)
  W1  Ratio Math: hard statutory ratios (Soli=5.5%, KiSt=8/9%) + sums + diffs
  W2  Label-Adjacency: atom drucktext → OCR substring → value nearby
  W3  Structural: Person-A/B sections, reading-order, address-bundles
  W4  Enum-Validation: controlled-vocabulary string values
  W5  Lane 1 Verifier: full §32a calculation chain
  W6  Inverse Pflicht-Search: list missing pflicht atoms, search OCR

Run:
  python3 inverse_solver.py
"""
import json
import re
import math
import urllib.request
import urllib.error
from pathlib import Path
from collections import defaultdict, Counter
from dataclasses import dataclass, field, asdict
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent
OCR_DIR = ROOT / "out" / "ocr"
ATOMS_JSON = ROOT.parent / "Upload" / "data" / "atoms.json"
PARAGRAPH_ESTG = ROOT.parent / "Upload" / "data" / "paragraph_estg.json"
OUT_JSON = ROOT / "out" / "solver_result.json"
OUT_MD = ROOT / "out" / "SOLVER_REPORT.md"
LANE1_URL = "http://localhost:12010/mcp"

# Statutory ratios — German tax + social security 2023
SOLI_RATE = 0.055
KIST_RATES = (0.08, 0.09)
# Halbierte KiSt (Konfessionsverschiedenheit, Halbteilung)
KIST_HALB_RATES = (0.04, 0.045)
# Sozialversicherung 2023 (AN-Anteile gegen Bruttoeinkommen)
SV_RATES = [
    (0.093,   "RV-AN-Anteil",         "§158 SGB VI"),
    (0.073,   "KV-Basis-AN-Anteil",   "§241 SGB V"),
    (0.080,   "KV-AN-mit-Zusatz",     "§242 SGB V (+~1.6% Zusatz, halbiert)"),
    (0.01525, "PV-AN-Anteil",         "§55 SGB XI"),
    (0.01875, "PV-AN-Kinderlos",      "§55(3) SGB XI"),
    (0.013,   "ALV-AN-Anteil",        "§341 SGB III"),
]
RATIO_TOL = 0.005
RATIO_TOL_SV = 0.0035  # SV ratios are tighter (less rounding noise)
SUM_TOL_EUR = 1.00

# Statutory-exact values per VZ (extend per year)
STATUTORY_EXACT = {
    2023: {
        1230: ("Arbeitnehmer-Pauschbetrag", "§9a Nr.1a EStG"),
        1000: ("Sparer-Pauschbetrag (single)", "§20(9) EStG"),
        2000: ("Sparer-Pauschbetrag (verh.)", "§20(9) EStG"),
        10908: ("Grundfreibetrag", "§32a(1) EStG"),
        36: ("Sonderausgaben-Pauschbetrag", "§10c EStG"),
        72: ("Sonderausgaben-Pauschbetrag (verh.)", "§10c EStG"),
    }
}

# ─────────────────────────────────────────────────────────────────────────
# DATACLASSES
# ─────────────────────────────────────────────────────────────────────────
@dataclass
class NumValue:
    """A number extracted from an Einkommensteuererklärung.
    Anlage + Person + Vordruckzeile are the eCode-disambiguators."""
    line_no: int
    raw: str
    value: float
    is_currency: bool
    context: str
    anlage: Optional[str] = None         # Erklärung-Anlage (N, KAP, Vorsorgeaufwand, …)
    person: Optional[str] = None         # 'A' / 'B' / None
    vordruckzeile: Optional[str] = None  # Zeile im Vordruck (eCode-Disambig)
    section: Optional[str] = None        # Sub-section in Anlage (e.g. 'Summe', 'Einzelangaben')
    steuerklassen_range: Optional[str] = None  # for Anlage N: '1_5' or '6'

@dataclass
class DateValue:
    line_no: int
    raw: str
    context: str
    anlage: Optional[str] = None
    person: Optional[str] = None

@dataclass
class Lock:
    ecode: str
    drucktext: str
    value: object
    line_no: int
    locked_by: list
    paragraph: Optional[str] = None
    anlage: Optional[str] = None
    confidence: float = 1.0
    wave: int = 0

# ─────────────────────────────────────────────────────────────────────────
# WELLE 0 — OCR PARSING (no eCode commitment)
# ─────────────────────────────────────────────────────────────────────────
# Amount-Patterns priority: currency-with-cents → thousand-format → bare-int-in-context
CURR_RE = re.compile(r"\b(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2})\b")
THOUSAND_RE = re.compile(r"\b(-?\d{1,3}(?:\.\d{3})+)\b")          # 6.011, 63.559
INT_RE = re.compile(r"\b(\d{1,7})\b")
DATE_RE = re.compile(r"\b(\d{1,2}\.\d{1,2}\.\d{4})\b")
# Lines starting with these are OCR-line-bookmarks, content begins after first token
LINE_PREFIX_NOISE = re.compile(r"^\s*[®°\*\d]{1,3}[\s°]*")
# Financial-context detectors: a bare integer counts only if line has these
FINANCIAL_KEYWORDS = {
    "betrag", "summe", "lohn", "steuer", "kapitalertrag", "kapitalerträge",
    "soli", "soliditätszuschlag", "solidaritätszuschlag", "kirchensteuer",
    "pauschbetrag", "arbeitnehmeranteil", "arbeitgeberanteil",
    "krankenversicherung", "pflegeversicherung", "rentenversicherung",
    "arbeitslosenversicherung", "vorsorge", "freibetrag", "einkünfte",
    "werbungskosten", "sonderausgabe", "spende", "kontoführungsgebühr",
    "rechtsschutz", "arbeitsmittel", "entfernungspauschale", "zuschuss",
    "altersvorsorge", "gezahlt", "erstattet", "abzug", "anteil",
    "beitrag", "beiträge", "euro", "€",
}
# Noise references to numbers that AREN'T amounts
NUMBER_REFERENCE_PATTERNS = [
    # LStB-Zeilennummern sind 1-99. Beschränken auf \d{1,2} damit ALV-Wert
    # 841 nicht durch "Nr. 841" eaten wird.
    re.compile(r"Nr\.\s*\d{1,2}(?:\s*[a-z](?:\s*/\s*[a-z])?)?", re.I),
    re.compile(r"Zeilen?\s*\d+(?:\s+bis\s+\d+)?", re.I),
    re.compile(r"Seite\s*\d+\s*von\s*\d+", re.I),
    re.compile(r"Steuernummer\s*\S+", re.I),
    re.compile(r"\b(19|20)\d{2}\b"),            # year 19xx/20xx
    re.compile(r"§\s*\d+[a-z]?(?:\s*Abs\.?\s*\d+)?", re.I),
    re.compile(r"Steuerklasse\s*\d+(?:\s*[-–]\s*\d+)?", re.I),  # "Steuerklasse 1-5", "Steuerklasse 3"
    re.compile(r"\b\d+\s*[-–]\s*\d+\b"),       # plain range "1-5"
    re.compile(r"01\.01-31\.12", re.I),         # "01.01-31.12" period
]
# Aggregator keywords — sum-triplets are stronger if C-line contains these
AGGREGATOR_KEYWORDS = {"summe", "insgesamt", "gesamtbetrag", "betrag", "gesamt"}

PERSON_A_RE = re.compile(r"(Ehemann|Person\s*A|Steuerpflichtige\s+Person\s*(?:[.\s]|/.*Ehemann))", re.I)
PERSON_B_RE = re.compile(r"(Ehefrau|Person\s*B)", re.I)
ANLAGE_RE = re.compile(r"(Hauptvordruck\s+(ESt1A))|(Anlage\s+([A-Za-z][A-Za-z0-9_]*))", re.I)

OCR_NOISE_INTS = {
    # WISO-Print-Versions, ERiC-Stamps, OCR-Garbage that often appears as integer
    "41", "2024", "2025",
}

def parse_currency(s: str) -> Optional[float]:
    """German number → float. Handles 1.234,56 / 1.234 / 16."""
    try:
        clean = s.replace(".", "").replace(",", ".")
        return float(clean)
    except ValueError:
        return None


def normalize_bmf_regex(raw_regex: str) -> str:
    """Convert Java/PCRE \\Q...\\E literal-escapes to Python-compatible regex.
    BMF atoms.json formatRegex uses Java syntax — Python re doesn't understand
    \\Q...\\E natively."""
    if not raw_regex or raw_regex == "X":
        return ".*"
    return re.sub(r"\\Q(.*?)\\E",
                   lambda m: re.escape(m.group(1)),
                   raw_regex)


def infer_atom_person(atom: dict) -> Optional[str]:
    """Infer Person A/B from kontextPath suffix (BMF convention: '/A' or '/B').
    Drucktext is identical for both ('Vorname' for both A and B atoms) —
    only kontextPath disambiguates."""
    meta = atom.get("metadata", {})
    kps = meta.get("kontextPaths") or []
    for kp in kps:
        if kp.endswith("/A") or "/A/" in kp:
            return "A"
        if kp.endswith("/B") or "/B/" in kp:
            return "B"
    # Fallback to drucktext heuristics
    dt = (meta.get("drucktext") or "").lower()
    if any(marker in dt for marker in ("ehefrau", "person b", "lebenspartner b",
                                         "ehepartner/-in b")):
        return "B"
    return None


def is_financial_line(line: str) -> bool:
    norm = line.lower()
    return any(kw in norm for kw in FINANCIAL_KEYWORDS)


def mask_reference_numbers(line: str) -> str:
    """Replace 'Nr. 23', 'Zeile 7', '2023', '§139b' with masks so they don't
    leak into integer extraction."""
    masked = line
    for pat in NUMBER_REFERENCE_PATTERNS:
        masked = pat.sub(lambda m: "·" * len(m.group(0)), masked)
    return masked

VORDRUCKZEILE_PREFIX_RE = re.compile(r"^\s*([®°\*]?\s*\d{1,3}[a-z]?)\s+")
# Section-Header in Anlage N of the Erklärung: "Lohnsteuerbescheinigung(en) Steuerklasse 1-5"
ANLAGE_N_STKLRANGE_RE = re.compile(r"Lohnsteuerbescheinigung\(en\)\s+Steuerklasse\s+(\d+)(?:\s*[-–]\s*(\d+))?", re.I)
ANLAGE_N_SUMME_RE = re.compile(r"^Summe\s+Lohnsteuer", re.I)


def parse_ocr(ocr_text: str) -> tuple[list[NumValue], list[DateValue], list[tuple]]:
    lines = ocr_text.split("\n")
    nums, dates = [], []
    line_ctx = [(None, None)]  # 1-indexed
    current_anlage, current_person = None, None
    # Anlage-N internal section tracking:
    in_summe_section = False  # under "Summe Lohnsteuerbescheinigung(en) ..." header
    stkl_range = None         # current Steuerklassen-Range section: "1_5" or "6"

    for line_no, line in enumerate(lines, start=1):
        # Anlage detection
        m = ANLAGE_RE.search(line)
        if m:
            current_anlage = (m.group(2) or m.group(4) or "").strip()
            if current_anlage and len(current_anlage) <= 4:
                current_anlage = current_anlage.upper()
            elif current_anlage:
                current_anlage = current_anlage.title()
        # Person detection
        if PERSON_B_RE.search(line):
            current_person = 'B'
        elif PERSON_A_RE.search(line):
            current_person = 'A'

        line_ctx.append((current_anlage, current_person))

        # Noise-line skip
        if any(x in line for x in ("*** Vorschau", "WISO Steuer", "ERiC-Print",
                                    "Datum der Ausfertigung", "Steuernummer")):
            continue
        if "Seite" in line and "von" in line:
            continue

        # Anlage-N internal section tracking
        # "Lohnsteuerbescheinigung(en) Steuerklasse 1-5" / "...Steuerklasse 6"
        # marks the StKl-Range subsection. "Summe Lohnsteuer..." marks Summen-Subsection.
        m_range = ANLAGE_N_STKLRANGE_RE.search(line)
        if m_range:
            lo, hi = m_range.group(1), m_range.group(2)
            stkl_range = f"{lo}_{hi}" if hi else lo
            in_summe_section = ANLAGE_N_SUMME_RE.search(line) is not None
        elif ANLAGE_N_SUMME_RE.search(line):
            in_summe_section = True

        # Extract leading Vordruck-Zeile (e.g. "37 Kapitalertragsteuer ...")
        # — this is the eCode-disambiguator for many fields
        vordruckzeile = None
        m_vz = VORDRUCKZEILE_PREFIX_RE.match(line)
        if m_vz:
            cand = m_vz.group(1).strip().lstrip("®°*").strip()
            # Only treat as Vordruckzeile if not a noise marker
            if cand and (cand[0].isdigit() and 1 <= int(re.match(r"\d+", cand).group()) <= 200):
                vordruckzeile = cand

        # ════════════════════════════════════════════════════════════════
        # STAGE 1 — Dates FIRST. Hardest pattern (DD.MM.YYYY), strict.
        # Captured dates are excluded from ALL number-pools downstream.
        # ════════════════════════════════════════════════════════════════
        date_spans = []  # (start, end, raw)
        for m in DATE_RE.finditer(line):
            d, mo, y = m.group(1).split(".")
            try:
                di, moi, yi = int(d), int(mo), int(y)
                if not (1 <= di <= 31 and 1 <= moi <= 12 and 1850 <= yi <= 2100):
                    continue
            except ValueError:
                continue
            dates.append(DateValue(line_no, m.group(1), line.strip(),
                                    current_anlage, current_person))
            date_spans.append((m.start(), m.end(), m.group(1)))

        # STAGE 2 — Build masked body: dates → mask, refs → mask, prefix → strip
        body = list(line)
        for s, e, _ in date_spans:
            for k in range(s, e):
                body[k] = "·"
        body = "".join(body)
        body = mask_reference_numbers(body)
        body = LINE_PREFIX_NOISE.sub("", body, count=1)

        # STAGE 3 — Currencies (decimal-comma format)
        currs_in_line = []
        for m in CURR_RE.finditer(body):
            raw = m.group(1)
            v = parse_currency(raw)
            if v is None:
                continue
            currs_in_line.append((raw, m.start(), m.end()))
            nums.append(NumValue(line_no, raw, v, True, line.strip(),
                                  current_anlage, current_person,
                                  vordruckzeile,
                                  "Summe" if in_summe_section else ("Einzelangaben" if stkl_range else None),
                                  stkl_range))
        masked = body
        for raw, _, _ in currs_in_line:
            masked = masked.replace(raw, "·" * len(raw), 1)

        # STAGE 4 — Thousand-format integers (6.011, 63.559)
        for m in THOUSAND_RE.finditer(masked):
            raw = m.group(1)
            v = parse_currency(raw)
            if v is None or v < 1:
                continue
            nums.append(NumValue(line_no, raw, v, True, line.strip(),
                                  current_anlage, current_person,
                                  vordruckzeile,
                                  "Summe" if in_summe_section else ("Einzelangaben" if stkl_range else None),
                                  stkl_range))
            masked = masked.replace(raw, "·" * len(raw), 1)

        # STAGE 5 — Bare integers, ONLY in financial context
        if is_financial_line(line):
            for m in INT_RE.finditer(masked):
                raw = m.group(1)
                if not raw or (raw[0] == "0" and len(raw) > 1):
                    continue
                val = float(raw)
                if val < 1 or val > 500_000:
                    continue
                nums.append(NumValue(line_no, raw, val, False, line.strip(),
                                      current_anlage, current_person,
                                      vordruckzeile,
                                      "Summe" if in_summe_section else ("Einzelangaben" if stkl_range else None),
                                      stkl_range))

    return nums, dates, line_ctx


# ─────────────────────────────────────────────────────────────────────────
# WELLE 1 — RATIO MATH
# ─────────────────────────────────────────────────────────────────────────
def find_ratio_locks(nums: list[NumValue], target: float, tol: float,
                      max_line_dist: int,
                      min_base: float = 0.0,
                      min_derived: float = 0.0,
                      base_anlage_allowed: Optional[set] = None,
                      derived_anlage_allowed: Optional[set] = None) -> list[dict]:
    """Find (base, derived) where derived/base ≈ target."""
    out = []
    amounts = [n for n in nums if n.value > 0.01]
    seen = set()
    for x in amounts:
        if x.value < min_base:
            continue
        if base_anlage_allowed and x.anlage not in base_anlage_allowed:
            continue
        for y in amounts:
            if x is y or y.value < min_derived:
                continue
            if derived_anlage_allowed and y.anlage not in derived_anlage_allowed:
                continue
            key = (id(x), id(y), round(target, 4))
            if key in seen:
                continue
            if abs(y.line_no - x.line_no) > max_line_dist:
                continue
            r = y.value / x.value
            if abs(r - target) < tol:
                out.append({"base": x, "derived": y, "ratio": r,
                             "expected": target,
                             "line_dist": abs(y.line_no - x.line_no)})
                seen.add(key)
    return out


def find_sum_locks(nums: list[NumValue], max_dist: int = 30,
                    tol: float = SUM_TOL_EUR,
                    require_aggregator_keyword: bool = True) -> list[dict]:
    """A + B ≈ C within proximity. Filters to triplets where C-line has
    aggregator keyword (Summe/Insgesamt/Gesamtbetrag/Betrag)."""
    out = []
    amounts = [n for n in nums if n.value > 0]
    n = len(amounts)
    seen = set()
    for i in range(n):
        for j in range(i + 1, n):
            a, b = amounts[i], amounts[j]
            if abs(b.line_no - a.line_no) > max_dist:
                continue
            # A and B should be in same Anlage (Sum-Konstellation)
            if a.anlage and b.anlage and a.anlage != b.anlage:
                continue
            target = a.value + b.value
            if target < 1.0:
                continue
            for k in range(n):
                if k in (i, j):
                    continue
                c = amounts[k]
                if abs(c.line_no - max(a.line_no, b.line_no)) > max_dist:
                    continue
                if c.line_no < max(a.line_no, b.line_no):
                    continue
                if abs(c.value - target) > tol or target <= 0.5:
                    continue
                # Aggregator filter: C-line OR the line BEFORE C must contain
                # an aggregator keyword
                if require_aggregator_keyword:
                    c_norm = (c.context or "").lower()
                    if not any(kw in c_norm for kw in AGGREGATOR_KEYWORDS):
                        continue
                key = tuple(sorted([id(a), id(b), id(c)]))
                if key in seen:
                    continue
                seen.add(key)
                out.append({"a": a, "b": b, "sum_value": c, "implied": target})
    return out


DIFF_KEYWORDS = {"saldo", "differenz", "verbleibt", "abzüglich", "davon", "erstattet"}


def find_diff_locks(nums: list[NumValue], max_dist: int = 3,
                     tol: float = SUM_TOL_EUR) -> list[dict]:
    """A - B ≈ C — strict: max_dist=3 lines, c.line_no ≥ max(a,b),
    requires diff-keyword in c-line or b-line."""
    out = []
    amounts = [n for n in nums if n.value > 0]
    n = len(amounts)
    seen = set()
    for i in range(n):
        for j in range(n):
            if i == j: continue
            a, b = amounts[i], amounts[j]
            if a.value <= b.value: continue
            if abs(b.line_no - a.line_no) > max_dist: continue
            if a.anlage and b.anlage and a.anlage != b.anlage: continue
            diff = a.value - b.value
            if diff < 1: continue
            for k in range(n):
                if k in (i, j): continue
                c = amounts[k]
                if abs(c.value - diff) > tol: continue
                # Hard reading-order: C must come at-or-after max(A, B)
                if c.line_no < max(a.line_no, b.line_no): continue
                if c.line_no - max(a.line_no, b.line_no) > max_dist: continue
                # Require diff-keyword in c-line OR b-line OR aggregator
                c_norm = (c.context or "").lower()
                b_norm = (b.context or "").lower()
                has_keyword = (any(kw in c_norm for kw in DIFF_KEYWORDS | AGGREGATOR_KEYWORDS) or
                               any(kw in b_norm for kw in DIFF_KEYWORDS))
                if not has_keyword: continue
                key = tuple(sorted([id(a), id(b), id(c)]))
                if key in seen: continue
                seen.add(key)
                out.append({"minuend": a, "subtrahend": b, "diff": c, "implied": diff})
    return out


def find_statutory_exact(nums: list[NumValue], vz: int = 2023) -> list[dict]:
    """Match exact statutory constants — works on all amount tokens."""
    out = []
    table = STATUTORY_EXACT.get(vz, {})
    for n in nums:
        if n.value != int(n.value):
            continue  # statutory constants are whole euros
        for exact_val, (label, paragraph) in table.items():
            if int(n.value) == exact_val:
                out.append({"value": n, "exact": exact_val,
                             "label": label, "paragraph": paragraph})
                break
    return out


# ─────────────────────────────────────────────────────────────────────────
# WELLE 2 — LABEL-ADJACENCY (only the highly discriminative labels)
# ─────────────────────────────────────────────────────────────────────────
NOISE_DRUCKTEXTE = {
    # Pure noise — never meaningful as drucktext-anchor in atoms.json
    "ja", "nein", "x", "summe", "betrag", "art",
    "bezeichnung", "anlage", "person", "ehemann", "ehefrau",
    "erläuterungen", "erläuterung", "hinweis", "einzelangaben",
    "sonstiges", "weitere", "ohne", "soweit", "mit",
    # NOTE: "name", "vorname", "religion", "datum" REMOVED — these ARE real
    # eCode-anchors for Stammdaten. Wave-3 zoning + Person-disambig resolves
    # the false-positives that originally motivated the filter.
}


def build_label_index(atoms: list[dict]) -> dict:
    idx = defaultdict(list)
    for a in atoms:
        dt = (a.get("metadata", {}).get("drucktext") or "").strip().lower()
        if not dt or dt in NOISE_DRUCKTEXTE:
            continue
        idx[dt].append(a)
    return idx


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def label_adjacency_locks(ocr_lines: list[str], atoms: list[dict],
                           locked_ecodes: set) -> list[dict]:
    """For each atom, emit candidates wherever its drucktext appears in OCR.
    No span-consumption — multiple atoms with same drucktext (e.g. Vorname A vs B)
    both emit candidates; per-line score-function (zone + person + section)
    picks the best atom per (line, value)."""
    out = []
    for atom in atoms:
        meta = atom.get("metadata", {})
        ecode = atom.get("field_name")
        if ecode in locked_ecodes:
            continue
        dt = (meta.get("drucktext") or "").strip()
        if not dt or len(dt) < 4 or dt.lower() in NOISE_DRUCKTEXTE:
            continue
        datentyp = meta.get("datentyp")
        format_regex = meta.get("formatRegex")
        max_laenge = meta.get("maxLaenge")
        # Try full drucktext first, then prefix-variants for multi-line / wrapped
        # labels in OCR (BMF drucktexts can be 80+ chars but OCR wraps them).
        dt_variants = [dt]
        # Split on newlines (BMF uses \n in drucktext for multi-line labels)
        if "\n" in dt:
            dt_variants += [seg.strip() for seg in dt.split("\n") if len(seg.strip()) >= 8]
        # Truncated prefix for long drucktexts (PDF-OCR may have truncated the line)
        if len(dt) > 30:
            # Take first 30-35 chars but cut at word boundary
            cut = dt[:35].rsplit(" ", 1)[0]
            if len(cut) >= 20:
                dt_variants.append(cut)

        for variant in dt_variants:
            v_norm = normalize(variant)
            if len(v_norm) < 4:
                continue
            v_pattern = re.compile(
                r"(?<![A-Za-zÄÖÜäöüß])" + re.escape(v_norm) + r"(?![A-Za-zÄÖÜäöüß])"
            )
            for line_no, line in enumerate(ocr_lines, start=1):
                ln_norm = normalize(line)
                if not v_pattern.search(ln_norm):
                    continue
                # Pass the matched variant as label so extract uses correct length
                value = extract_value_after_label(line, variant, datentyp,
                                                    format_regex, max_laenge)
                if value is None:
                    continue
                out.append({
                    "atom": atom, "value": value, "line_no": line_no,
                    "line": line.strip(),
                    "drucktext_len": len(dt),
                })
    return out


def extract_value_after_label(line: str, label: str, datentyp: str,
                                format_regex: Optional[str] = None,
                                max_laenge: Optional[int] = None) -> Optional[str]:
    """Take token(s) after the label substring + validate against formatRegex."""
    idx = line.lower().find(label.lower())
    if idx < 0:
        return None
    rest = line[idx + len(label):].strip()
    if not rest:
        return None

    candidate = None
    if datentyp == "currency":
        # Try in decreasing specificity: decimal-comma → thousand-format → bare int
        m = CURR_RE.search(rest)
        if m:
            candidate = m.group(1)
        else:
            m = THOUSAND_RE.search(rest)
            if m:
                candidate = m.group(1)
            else:
                # Bare int — used for fields where BMF schema declares "currency"
                # but value is integer (e.g. PLZ E0100601, integer-Euro Vorsorgewerte)
                m = re.search(r"\b(\d{1,8})\b", rest)
                candidate = m.group(1) if m else None
    elif datentyp == "date":
        m = DATE_RE.search(rest)
        candidate = m.group(1) if m else None
    elif datentyp == "string":
        # Strip leading parentheticals: "(derzeitige Adresse) Kirchstraße" → "Kirchstraße"
        cleaned = re.sub(r"^\s*\([^)]*\)\s*", "", rest)
        # Take first 1-3 tokens, capped at maxLaenge if given
        toks = cleaned.split()
        if not toks:
            return None
        candidate = " ".join(toks[:3])
        if max_laenge and len(candidate) > max_laenge:
            candidate = candidate[:max_laenge].rstrip()
    else:
        toks = rest.split()
        candidate = " ".join(toks[:3]) if toks else None

    if candidate is None:
        return None

    # Validate against formatRegex if present (skip "X" placeholder, skip enum-regex
    # that encodes ELSTER-codes — those need Text→Code mapping post-extraction)
    if format_regex and format_regex != "X":
        # Enum-regex skip applies only if the CANDIDATE looks like free text
        # (contains letters). Numeric enum codes (e.g. Steuerklasse 1-6) still
        # validate strictly so "1-5" range doesn't sneak through.
        is_enum_regex = format_regex.count("\\Q") > 3
        candidate_is_text = bool(re.search(r"[A-Za-zÄÖÜäöüß]", candidate))
        if not (is_enum_regex and candidate_is_text):
            try:
                normalized_re = normalize_bmf_regex(format_regex)
                if not re.fullmatch(normalized_re, candidate):
                    # For currency that expects pure-int (\d{1,12}$ no comma):
                    # try stripping thousand-seps and decimal-tail
                    if datentyp == "currency":
                        alt = candidate.replace(".", "").split(",")[0]
                        if re.fullmatch(normalized_re, alt):
                            return alt
                    return None
            except re.error:
                pass
    return candidate


# ─────────────────────────────────────────────────────────────────────────
# WELLE 1.5 — MATH-LOCK → REAL eCODE TRANSFER
# ─────────────────────────────────────────────────────────────────────────
# Role → eCode mapping. Drucktext from PSEUDO-lock identifies the math-role,
# eCode is the ELSTER target field. Person-suffix added at lock-time.
MATH_ROLE_TO_ECODE = {
    "Bruttoarbeitslohn":                 "E0200201",
    "Lohnsteuer/ESt":                    "E0200301",
    "Lohnsteuer (Halbteilung-Basis)":    "E0200301",
    "KESt":                              "E1904701",
    "RV-AN-Anteil":                      "E2000401",
    "KV-Basis-AN-Anteil":                "E2001203",
    "KV-AN-mit-Zusatz":                  "E2001203",
    "PV-AN-Anteil":                      "E2001505",
    "PV-AN-Kinderlos":                   "E2001505",
    "ALV-AN-Anteil":                     "E2004403",
    "Soli auf KESt":                     "E1904901",
    "KiSt auf KESt (BY/BW)":             "E1904801",
    "KiSt auf KESt (andere BL)":         "E1904801",
}


def math_to_ecode_transfer(locks: dict, atoms: list[dict],
                             nums: list[NumValue]) -> int:
    """Welle 1.5 — convert wave-1 PSEUDO math-locks to real eCode-locks
    using MATH_ROLE_TO_ECODE. Returns count of new real-eCode locks."""
    atom_index = {a["field_name"]: a for a in atoms}
    nums_idx = {(n.line_no, round(n.value, 2)): n for n in nums}
    nums_idx.update({(n.line_no, float(int(n.value))): n for n in nums})

    added = 0
    new_locks = {}
    for pseudo_key, lock in list(locks.items()):
        if lock.wave != 1:
            continue
        role = lock.drucktext
        ecode = MATH_ROLE_TO_ECODE.get(role)
        if not ecode:
            continue
        atom = atom_index.get(ecode)
        if not atom:
            continue
        meta = atom.get("metadata", {})
        # Person: prefer num-token person at (line, value)
        n = nums_idx.get((lock.line_no, round(float(lock.value), 2)))
        person = n.person if n and n.person else None
        lock_key = f"{ecode}__{person}" if person else ecode
        if lock_key in locks or lock_key in new_locks:
            continue
        new_locks[lock_key] = Lock(
            ecode, meta.get("drucktext", role),
            lock.value, lock.line_no,
            [f"math-transfer (via {pseudo_key})"] + list(lock.locked_by),
            None,                                  # paragraph
            meta.get("anlage") or lock.anlage,     # anlage (atom-canonical)
            1.0, 1,                                # confidence, wave
        )
        added += 1
    locks.update(new_locks)
    return added


# ─────────────────────────────────────────────────────────────────────────
# WELLE 5 — LANE 1 VERIFIER
# ─────────────────────────────────────────────────────────────────────────
def call_lane1(ecode_dict: dict, erklaerungsjahr: int = 2023) -> Optional[dict]:
    payload = json.dumps({
        "jsonrpc": "2.0", "id": "solver",
        "method": "tools/call",
        "params": {
            "name": "berechne_vollstaendige_steuer_v2",
            "arguments": {"parameters": {
                "erklaerungsjahr": erklaerungsjahr,
                "elster_felder": ecode_dict,
            }},
        },
    }).encode()
    try:
        req = urllib.request.Request(LANE1_URL, data=payload,
                                       headers={"Content-Type": "application/json",
                                                "Accept": "application/json, text/event-stream"})
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode()
        for ln in text.splitlines():
            if ln.startswith("data:"):
                body = json.loads(ln[5:].strip())
                content = body.get("result", {}).get("content", [{}])[0].get("text", "")
                return json.loads(content) if content else None
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        print(f"  Lane 1 unreachable: {e}")
        return None
    return None


# ─────────────────────────────────────────────────────────────────────────
# REPORT
# ─────────────────────────────────────────────────────────────────────────
def write_markdown_report(locks: dict, ratio_findings: dict,
                            sum_findings: list, statutory: list,
                            lane1_result: Optional[dict],
                            unlocked_currencies: list,
                            unlocked_integers: list,
                            unlocked_dates: list):
    md = ["# ELSTER Inverse Solver — Stricker 2023", ""]
    md.append(f"**Locks total:** {len(locks)}")
    md.append("")

    md.append("## Welle 1 — Ratio Math")
    md.append("")
    md.append("### Soli/KESt 5.5% pairs")
    for f in ratio_findings.get("soli", []):
        md.append(f"- L{f['base'].line_no} `{f['base'].raw}` × 5.5% ≈ "
                   f"L{f['derived'].line_no} `{f['derived'].raw}` "
                   f"(actual {f['ratio']:.4f})")
    md.append("")
    md.append("### KiSt 8% / 9% pairs")
    for rate, key in [(0.08, "kist_8"), (0.09, "kist_9")]:
        for f in ratio_findings.get(key, []):
            md.append(f"- L{f['base'].line_no} `{f['base'].raw}` × {int(rate*100)}% ≈ "
                       f"L{f['derived'].line_no} `{f['derived'].raw}` "
                       f"(actual {f['ratio']:.4f})")
    md.append("")
    md.append("### Sum constraints (A + B = C)")
    for f in sum_findings:
        md.append(f"- L{f['a'].line_no} `{f['a'].raw}` + L{f['b'].line_no} `{f['b'].raw}` "
                   f"= L{f['sum_value'].line_no} `{f['sum_value'].raw}` "
                   f"(implied {f['implied']:.2f})")
    md.append("")
    md.append("### Statutory-exact matches")
    for f in statutory:
        md.append(f"- `{f['value'].raw}` @ L{f['value'].line_no} = **{f['label']}** "
                   f"({f['paragraph']})")
    md.append("")

    md.append("## Locked eCodes (final)")
    md.append("| eCode | Drucktext | Wert | Anlage | Locked by | Wave | § |")
    md.append("|---|---|---|---|---|---|---|")
    for ecode, lock in sorted(locks.items()):
        md.append(f"| `{ecode}` | {lock.drucktext} | `{lock.value}` | "
                   f"{lock.anlage or '—'} | {', '.join(lock.locked_by)} | "
                   f"W{lock.wave} | {lock.paragraph or '—'} |")
    md.append("")

    if lane1_result:
        d = lane1_result.get("daten", {})
        md.append("## Welle 5 — Lane 1 Verifier")
        md.append(f"- ZvE: {d.get('zve')} €")
        md.append(f"- ESt: {d.get('einkommensteuer')} €")
        md.append(f"- Soli: {d.get('solidaritaetszuschlag')} €")
        md.append(f"- Gesamtsteuer: {d.get('gesamtsteuer')} €")
        md.append(f"- Erstattung/Nachzahlung: {d.get('erstattung_oder_nachzahlung')} €")
        md.append(f"- BMF-konform: {d.get('bmf_konform')}")
        md.append("")

    md.append("## Unlocked tokens (need Welle 2/3/4 expansion)")
    md.append(f"- Unlocked currency values: {len(unlocked_currencies)}")
    for n in unlocked_currencies[:30]:
        md.append(f"  - L{n.line_no} [{n.anlage or '—'} / Person {n.person or '—'}] "
                   f"`{n.raw}` — *{n.context[:80]}*")
    md.append(f"- Unlocked integers: {len(unlocked_integers)}")
    for n in unlocked_integers[:30]:
        md.append(f"  - L{n.line_no} [{n.anlage or '—'} / Person {n.person or '—'}] "
                   f"`{n.raw}` — *{n.context[:80]}*")
    md.append(f"- Unlocked dates: {len(unlocked_dates)}")
    for d in unlocked_dates[:20]:
        md.append(f"  - L{d.line_no} [{d.anlage or '—'} / Person {d.person or '—'}] "
                   f"`{d.raw}` — *{d.context[:80]}*")

    OUT_MD.write_text("\n".join(md))


# ─────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────
def main():
    print("=== ELSTER Inverse Solver ===")
    print(f"OCR: {OCR_DIR}")
    print(f"Atoms: {ATOMS_JSON}")
    print()

    # Welle 0
    ocr_file = OCR_DIR / "Elster 2023 Stricker - Einkommensteuererklärung.ocr.txt"
    ocr_text = ocr_file.read_text()
    ocr_lines = ocr_text.split("\n")
    nums, dates, line_ctx = parse_ocr(ocr_text)
    currs = [n for n in nums if n.is_currency]
    ints = [n for n in nums if not n.is_currency]
    print(f"W0: parsed {len(currs)} currencies, {len(ints)} integers, {len(dates)} dates")
    print(f"    anlagen seen: {sorted(set(a for a,_ in line_ctx if a))}")
    print()

    locks: dict[str, Lock] = {}

    # Welle 1 — Ratio Math
    print("W1: Ratio Math")
    # Use ALL amounts (not just currencies) — German tax forms mix int + currency
    all_amounts = nums
    ratio_findings = {
        "soli": find_ratio_locks(all_amounts, SOLI_RATE, RATIO_TOL, max_line_dist=10),
        "kist_8": find_ratio_locks(all_amounts, 0.08, RATIO_TOL, max_line_dist=10),
        "kist_9": find_ratio_locks(all_amounts, 0.09, RATIO_TOL, max_line_dist=10),
        "kist_halb_8": find_ratio_locks(all_amounts, 0.04, RATIO_TOL, max_line_dist=15),
        "kist_halb_9": find_ratio_locks(all_amounts, 0.045, RATIO_TOL, max_line_dist=15),
    }
    # SV ratios: base = Bruttoarbeitslohn (Anlage N), derived = SV-Beitrag
    # (Anlage Vorsorgeaufwand / AV). Brutto + Vorsorge können weit auseinander
    # liegen in der Erklärung (Anlage N → Anlage Vorsorgeaufwand sind ~100+
    # OCR-Zeilen entfernt). Anlage-Constraint verhindert Kreuz-Match mit
    # zufälligen Beträgen anderer Anlagen.
    for rate, label, paragraph in SV_RATES:
        key = f"sv_{label.replace(' ','_').replace('-','_')}"
        ratio_findings[key] = find_ratio_locks(
            all_amounts, rate, RATIO_TOL_SV, max_line_dist=200,
            min_base=10000.0, min_derived=50.0,
            base_anlage_allowed={"N"},
            derived_anlage_allowed={"Vorsorgeaufwand", "AV"},
        )
    print(f"  Soli (5.5%): {len(ratio_findings['soli'])}")
    print(f"  KiSt 8%: {len(ratio_findings['kist_8'])}, KiSt 9%: {len(ratio_findings['kist_9'])}")
    print(f"  KiSt halb 4%: {len(ratio_findings['kist_halb_8'])}, halb 4.5%: {len(ratio_findings['kist_halb_9'])}")
    for rate, label, _ in SV_RATES:
        key = f"sv_{label.replace(' ','_').replace('-','_')}"
        print(f"  {label} ({rate*100:.2f}%): {len(ratio_findings[key])}")
    sum_findings = find_sum_locks(nums, max_dist=20, tol=SUM_TOL_EUR)
    print(f"  Sum triplets: {len(sum_findings)}")
    diff_findings = find_diff_locks(nums, max_dist=20, tol=SUM_TOL_EUR)
    print(f"  Diff (A-B=C): {len(diff_findings)}")
    statutory = find_statutory_exact(nums, vz=2023)
    print(f"  Statutory-exact: {len(statutory)}")

    # Convert findings to Locks (still pseudo eCodes; Welle 2 will resolve to real)
    used_lines = set()

    # Soli locks
    for f in ratio_findings["soli"]:
        base, deriv = f["base"], f["derived"]
        if base.anlage == "KAP" or "Kapitalertragsteuer" in base.context.lower() \
                or "kapitalertragsteuer" in deriv.context.lower():
            base_role = ("KESt", "§32d EStG"); deriv_role = ("Soli auf KESt", "§4 SolzG")
        else:
            base_role = ("Lohnsteuer/ESt", "§19 EStG"); deriv_role = ("Soli", "§4 SolzG")
        pseudo_b = f"PSEUDO_{base_role[0].replace(' ','_')}_L{base.line_no}"
        pseudo_d = f"PSEUDO_{deriv_role[0].replace(' ','_')}_L{deriv.line_no}"
        person = base.person or 'A'
        if pseudo_b not in locks:
            locks[pseudo_b] = Lock(pseudo_b, base_role[0], base.value, base.line_no,
                                    [f"5.5%-ratio L{base.line_no}↔L{deriv.line_no}"],
                                    base_role[1], base.anlage, 1.0, 1)
        if pseudo_d not in locks:
            locks[pseudo_d] = Lock(pseudo_d, deriv_role[0], deriv.value, deriv.line_no,
                                    [f"5.5%-ratio L{base.line_no}↔L{deriv.line_no}"],
                                    deriv_role[1], deriv.anlage, 1.0, 1)
        used_lines.add(base.line_no); used_lines.add(deriv.line_no)

    # KiSt locks (full rates)
    for rate, key in [(0.08, "kist_8"), (0.09, "kist_9")]:
        bundesland = "BY/BW" if rate == 0.08 else "andere BL"
        for f in ratio_findings[key]:
            base, deriv = f["base"], f["derived"]
            if base.anlage == "KAP" or "Kapitalertragsteuer" in base.context.lower():
                base_role = ("KESt", "§32d EStG"); deriv_role = (f"KiSt auf KESt ({bundesland})", "§51a EStG")
            else:
                base_role = ("Lohnsteuer/ESt", "§19 EStG"); deriv_role = (f"KiSt ({bundesland})", "LKiStG")
            pseudo_b = f"PSEUDO_{base_role[0].replace(' ','_')}_L{base.line_no}"
            pseudo_d = f"PSEUDO_KiSt_{int(rate*100)}_L{deriv.line_no}"
            if pseudo_b not in locks:
                locks[pseudo_b] = Lock(pseudo_b, base_role[0], base.value, base.line_no,
                                        [f"{int(rate*100)}%-ratio L{base.line_no}↔L{deriv.line_no}"],
                                        base_role[1], base.anlage, 1.0, 1)
            if pseudo_d not in locks:
                locks[pseudo_d] = Lock(pseudo_d, deriv_role[0], deriv.value, deriv.line_no,
                                        [f"{int(rate*100)}%-ratio L{base.line_no}↔L{deriv.line_no}"],
                                        deriv_role[1], deriv.anlage, 1.0, 1)
            used_lines.add(base.line_no); used_lines.add(deriv.line_no)

    # KiSt halbiert (Konfessionsverschiedenheit)
    for rate, key in [(0.04, "kist_halb_8"), (0.045, "kist_halb_9")]:
        bundesland = "BY/BW" if rate == 0.04 else "andere BL"
        for f in ratio_findings[key]:
            base, deriv = f["base"], f["derived"]
            # Need: LSt-base (large) and KiSt-derived (~Brutto×9%/2)
            if base.value < 1000:  # nur sinnvoll wenn base wirklich LSt-Größe hat
                continue
            pseudo_b = f"PSEUDO_LSt_halbteil_L{base.line_no}"
            pseudo_d = f"PSEUDO_KiSt_konfessverschd_{int(rate*1000)}_L{deriv.line_no}"
            if pseudo_b not in locks:
                locks[pseudo_b] = Lock(pseudo_b, "Lohnsteuer (Halbteilung-Basis)", base.value,
                                        base.line_no,
                                        [f"KiSt-halb {rate*100:.1f}% L{base.line_no}↔L{deriv.line_no}"],
                                        "§19 EStG", base.anlage, 0.9, 1)
            if pseudo_d not in locks:
                locks[pseudo_d] = Lock(pseudo_d,
                                        f"KiSt halbiert ({bundesland}, Konfessionsverschiedenheit)",
                                        deriv.value, deriv.line_no,
                                        [f"KiSt-halb {rate*100:.1f}% L{base.line_no}↔L{deriv.line_no}"],
                                        "§51a EStG / LKiStG", deriv.anlage, 0.9, 1)
            used_lines.add(base.line_no); used_lines.add(deriv.line_no)

    # SV-Beitrags-Locks
    for rate, label, paragraph in SV_RATES:
        key = f"sv_{label.replace(' ','_').replace('-','_')}"
        for f in ratio_findings.get(key, []):
            base, deriv = f["base"], f["derived"]
            # Need: base ≥ 10000 (Brutto), derived ≥ 50
            pseudo_b = f"PSEUDO_Brutto_L{base.line_no}"
            pseudo_d = f"PSEUDO_{label.replace(' ','_').replace('-','_')}_L{deriv.line_no}"
            if pseudo_b not in locks:
                locks[pseudo_b] = Lock(pseudo_b, "Bruttoarbeitslohn", base.value, base.line_no,
                                        [f"SV {label} {rate*100:.2f}% L{base.line_no}↔L{deriv.line_no}"],
                                        "§19 EStG", base.anlage, 0.95, 1)
            if pseudo_d not in locks:
                locks[pseudo_d] = Lock(pseudo_d, label, deriv.value, deriv.line_no,
                                        [f"SV-ratio {rate*100:.2f}% L{base.line_no}↔L{deriv.line_no}"],
                                        paragraph, deriv.anlage, 0.95, 1)
            used_lines.add(base.line_no); used_lines.add(deriv.line_no)

    # Sum locks (Σ Komponenten = Summe-Feld)
    for f in sum_findings:
        a, b, c = f["a"], f["b"], f["sum_value"]
        anlage = c.anlage or a.anlage or b.anlage
        for n, label in [(a, "Komponente A"), (b, "Komponente B"), (c, "Summe")]:
            pseudo = f"PSEUDO_SUM_{anlage}_{label.replace(' ','_')}_L{n.line_no}"
            if pseudo not in locks:
                locks[pseudo] = Lock(pseudo, f"Sum-{label}", n.value, n.line_no,
                                      [f"Sum L{a.line_no}+L{b.line_no}=L{c.line_no}"],
                                      None, anlage, 1.0, 1)
            used_lines.add(n.line_no)

    # Statutory-exact (highest confidence locks)
    for f in statutory:
        n = f["value"]
        pseudo = f"PSEUDO_STATUTORY_{f['exact']}_L{n.line_no}"
        if pseudo not in locks:
            locks[pseudo] = Lock(pseudo, f["label"], n.value, n.line_no,
                                  [f"statutory-exact={f['exact']}"],
                                  f["paragraph"], n.anlage, 1.0, 1)
        used_lines.add(n.line_no)

    # Diff locks (with aggregator-keyword pre-filter)
    for f in diff_findings:
        a, b, c = f["minuend"], f["subtrahend"], f["diff"]
        anlage = a.anlage or c.anlage
        for n, label in [(a, "Minuend"), (b, "Subtrahend"), (c, "Differenz")]:
            pseudo = f"PSEUDO_DIFF_{anlage}_{label}_L{n.line_no}"
            if pseudo not in locks:
                locks[pseudo] = Lock(pseudo, f"Diff-{label}", n.value, n.line_no,
                                      [f"Diff L{a.line_no}-L{b.line_no}=L{c.line_no}"],
                                      None, anlage, 0.9, 1)
            used_lines.add(n.line_no)

    # ═════════════════════════════════════════════════════════════
    # Welle 1.5 — Math-Lock → Real-eCode-Transfer
    # ═════════════════════════════════════════════════════════════
    # Convert PSEUDO math-roles ('Bruttoarbeitslohn', 'RV-AN-Anteil', …) to
    # real ELSTER eCodes (E0200201, E2000401, …) via MATH_ROLE_TO_ECODE.
    # Adds real eCode locks at confidence 1.0 alongside the pseudo-locks.
    # ═════════════════════════════════════════════════════════════
    print("\nW1.5: Math-Lock → Real-eCode-Transfer")
    with open(ATOMS_JSON) as _f:
        _atoms_db = json.load(_f)
    transferred = math_to_ecode_transfer(locks, _atoms_db, nums)
    print(f"  Transferred {transferred} math-locks to real eCodes")

    # ═════════════════════════════════════════════════════════════
    # Welle 2 — Spatial Zoning from Math-Anchors
    # ═════════════════════════════════════════════════════════════
    # Zone key = (anlage_lower, person|None). Each math-lock contributes to
    # its (anlage, person)-zone. For atoms without explicit person → zone
    # accepts ANY person at the line; for atoms with person → must match.
    # ═════════════════════════════════════════════════════════════
    print("\nW2: Spatial Zoning (math-anchors → per (Anlage, Person) zones)")
    raw_zones = {}  # (anlage_lower, person) -> [lo, hi]
    # Math-lock person is in the originating PSEUDO key — track via num context
    nums_by_lineval = {(n.line_no, round(n.value, 2)): n for n in nums}
    for lock in locks.values():
        if not lock.anlage or lock.wave != 1:
            continue
        n = nums_by_lineval.get((lock.line_no, round(float(lock.value), 2)))
        person = n.person if n else None
        key = (lock.anlage.lower(), person)
        if key not in raw_zones:
            raw_zones[key] = [lock.line_no, lock.line_no]
        else:
            raw_zones[key][0] = min(raw_zones[key][0], lock.line_no)
            raw_zones[key][1] = max(raw_zones[key][1], lock.line_no)
    zones = {k: (max(0, lo - 15), hi + 20) for k, (lo, hi) in raw_zones.items()}
    for (a, p), (lo, hi) in sorted(zones.items(), key=lambda x: x[0]):
        print(f"  Zone {a:<20s} person={p or '—'}  L{lo}-L{hi}")

    # OCR-fallback zones for anlagen with no math-lock — person='A' default
    # (Person-B sections inside same anlage get separate zones from OCR markers)
    ocr_anlage_person_lines = defaultdict(list)
    cur_anlage, cur_person = None, None
    for line_no, line in enumerate(ocr_lines, start=1):
        m = ANLAGE_RE.search(line)
        if m:
            cur_anlage = (m.group(2) or m.group(4) or "").strip()
            if cur_anlage and len(cur_anlage) <= 4:
                cur_anlage = cur_anlage.upper()
            elif cur_anlage:
                cur_anlage = cur_anlage.title()
        if PERSON_B_RE.search(line):
            cur_person = 'B'
        elif PERSON_A_RE.search(line):
            cur_person = 'A'
        if cur_anlage:
            ocr_anlage_person_lines[(cur_anlage.lower(), cur_person)].append(line_no)

    for (anlage, person), line_nos in ocr_anlage_person_lines.items():
        if (anlage, person) in zones:
            continue
        # OCR-fallback: span the OCR-section
        lo = max(0, min(line_nos) - 2)
        hi = max(line_nos) + 5
        zones[(anlage, person)] = (lo, hi)
        print(f"  Zone {anlage:<20s} person={person or '—'}  L{lo}-L{hi} (OCR-fallback)")

    # ═════════════════════════════════════════════════════════════
    # Welle 3 — Label-Adjacency with Zone-Filter + Drucktext-Clean
    # ═════════════════════════════════════════════════════════════
    print("\nW3: Label-Adjacency (zone-filtered) → real eCodes")
    with open(ATOMS_JSON) as f:
        atoms = json.load(f)

    # Pre-index math-locks by (line_no, value-rounded) for fast convergence-check.
    # Also store integer-truncated form so currency-int atoms (Brutto 63559.90→63559)
    # converge with their math-lock counterpart.
    math_by_line_val = defaultdict(list)
    for lock in locks.values():
        if lock.wave == 1:
            v = float(lock.value)
            math_by_line_val[(lock.line_no, round(v, 2))].append(lock)
            # Int-truncated alias for integer-only formatRegex atoms
            math_by_line_val[(lock.line_no, float(int(v)))].append(lock)

    label_hits = label_adjacency_locks(ocr_lines, atoms, set())
    print(f"  Label-Adjacency hits: {len(label_hits)}")

    # Group label-hits by (line_no, value) → all candidate eCodes for same value
    candidates_by_value = defaultdict(list)
    for hit in label_hits:
        atom = hit["atom"]
        meta = atom.get("metadata", {})
        line_no = hit["line_no"]
        value_str = hit["value"]
        v_parsed = parse_currency(value_str) if meta.get("datentyp") == "currency" else None
        key = (line_no, round(v_parsed, 2)) if v_parsed is not None else (line_no, value_str)
        candidates_by_value[key].append((atom, value_str, v_parsed))

    # Pre-index num-values by line for vordruckzeile lookup
    nums_by_line = {n.line_no: n for n in nums}

    # Build line-level (anlage, person) tracker for STRING-extraction lines
    # where no NumValue exists (e.g. Vorname, Name rows)
    line_anlage_person = {}
    _cur_a, _cur_p = None, None
    for _ln, _l in enumerate(ocr_lines, start=1):
        _m = ANLAGE_RE.search(_l)
        if _m:
            _cur_a = (_m.group(2) or _m.group(4) or "").strip()
            if _cur_a and len(_cur_a) <= 4:
                _cur_a = _cur_a.upper()
            elif _cur_a:
                _cur_a = _cur_a.title()
        if PERSON_B_RE.search(_l):
            _cur_p = 'B'
        elif PERSON_A_RE.search(_l):
            _cur_p = 'A'
        line_anlage_person[_ln] = (_cur_a, _cur_p)

    def score_candidate(atom: dict, n: Optional[NumValue],
                          line_no: Optional[int] = None) -> float:
        """Higher is better. Person-disambig + anlage-match + section-match."""
        meta = atom.get("metadata", {})
        score = 1.0
        # Token-side person: prefer NumValue.person; fall back to line-tracker
        token_person = (n.person if n else None) or (
            line_anlage_person.get(line_no, (None, None))[1] if line_no else None
        )
        atom_person = infer_atom_person(atom)
        if token_person and atom_person:
            if token_person == atom_person:
                score += 8.0
            else:
                score -= 15.0
        # Drucktext-length tie-breaker: longer drucktext is more specific
        score += min(len(meta.get("drucktext") or ""), 30) / 100.0
        # Vordruckzeile match: if OCR has a leading Vordruckzeile and atom has same → +5
        if n and n.vordruckzeile:
            ocr_vz = re.match(r"\d+", n.vordruckzeile).group()
            atom_vz = meta.get("vordruckzeile", "")
            if atom_vz and ocr_vz == atom_vz.replace("a", "").replace("b", ""):
                score += 5.0
        # Anlage match: OCR-detected anlage = atom-anlage
        if n and n.anlage:
            ocr_a = n.anlage.upper()
            atom_a = (meta.get("anlage") or "").upper()
            if ocr_a == atom_a:
                score += 5.0
            elif atom_a.startswith(ocr_a + "_") or ocr_a.startswith(atom_a + "_"):
                # KAP_BET when ocr says KAP only → mild penalty (still related)
                score -= 2.0
            else:
                # Completely different anlage (e.g. ESt1A line picks Anlage V eCode)
                # — this is the PLZ-bug we want to crush
                score -= 10.0
        # Steuerklassen-Range match (for Anlage N)
        if n and n.steuerklassen_range:
            kp = " ".join(meta.get("kontextPaths") or [])
            target = f"LStB_{n.steuerklassen_range}"
            if target in kp:
                score += 4.0
            elif "LStB_" in kp:
                score -= 1.0
        # Section match: Summe ↔ "_Sum" kontextPath / Einzelangaben ↔ "_Einz"
        if n and n.section:
            kp = " ".join(meta.get("kontextPaths") or [])
            if n.section == "Summe" and kp.endswith("_Sum"):
                score += 2.0
            elif n.section == "Einzelangaben" and kp.endswith("_Einz"):
                score += 2.0
            elif n.section == "Summe" and kp.endswith("_Einz"):
                score -= 2.0
            elif n.section == "Einzelangaben" and kp.endswith("_Sum"):
                score -= 2.0
        # Person match
        if n and n.person and meta.get("anlage"):
            # Person B's eCodes typically have higher-numbered offsets but no
            # clean structural marker — leave as tie-breaker only
            pass
        return score

    def in_zone(atom_anlage: Optional[str], atom_person: Optional[str],
                  line_no: int) -> tuple[bool, Optional[str]]:
        """Returns (ok, person). When multiple person-zones cover the line,
        prefer the one matching the OCR line-context person (so L159 in
        Person-B section locks to KAP-B zone, not the overlapping KAP-A)."""
        if not atom_anlage:
            return True, None
        a_lower = atom_anlage.lower()
        # Line-context person from OCR-stream tracker
        line_person = line_anlage_person.get(line_no, (None, None))[1]
        preferred_person = atom_person or line_person

        # Try preferred-person zone first
        if preferred_person:
            z = zones.get((a_lower, preferred_person))
            if z and z[0] <= line_no <= z[1]:
                return True, preferred_person

        # Fallback: any zone of this anlage that covers the line
        for (a, p), (lo, hi) in zones.items():
            if a != a_lower or not (lo <= line_no <= hi):
                continue
            if atom_person and p and atom_person != p:
                continue
            return True, p
        return False, None

    def clean_string_value(raw_val, drucktext: str, max_laenge: Optional[int] = None):
        """Strip drucktext-leak + leading parenthetical/punctuation from value."""
        if not isinstance(raw_val, str) or not drucktext:
            return raw_val
        # Remove drucktext substring (case-insensitive)
        pat = re.compile(re.escape(drucktext), re.IGNORECASE)
        cleaned = pat.sub("", raw_val).strip()
        # Strip leading "(text)" parenthetical
        cleaned = re.sub(r"^\s*\([^)]*\)\s*", "", cleaned)
        cleaned = re.sub(r"^[\)\(\:\s,;.]+", "", cleaned)
        if max_laenge and len(cleaned) > max_laenge:
            cleaned = cleaned[:max_laenge].rstrip()
        return cleaned or raw_val

    converged = 0
    label_only = 0
    zone_rejected = 0
    for (line_no, val_key), candidates in candidates_by_value.items():
        n = nums_by_line.get(line_no)

        # Zone-filter with person-aware lookup
        in_zone_candidates = []
        for (atom, value_str, v_parsed) in candidates:
            atom_anlage = (atom.get("metadata", {}) or {}).get("anlage")
            atom_person = infer_atom_person(atom)
            ok, zone_person = in_zone(atom_anlage, atom_person, line_no)
            if ok:
                in_zone_candidates.append((atom, value_str, v_parsed, zone_person))
        if not in_zone_candidates:
            zone_rejected += 1
            continue
        # Drop the zone_person from the tuple for downstream code compatibility
        in_zone_candidates_3 = [(a, v, p) for (a, v, p, _) in in_zone_candidates]
        # Preserve zone_person mapping for lock annotation
        zone_person_by_atom = {id(a): zp for (a, v, p, zp) in in_zone_candidates}

        ranked = sorted(in_zone_candidates_3,
                         key=lambda c: score_candidate(c[0], n, line_no), reverse=True)
        best_atom, value_str, v_parsed = ranked[0]
        best_score = score_candidate(best_atom, n, line_no)
        zone_person = zone_person_by_atom.get(id(best_atom))
        ecode = best_atom["field_name"]
        meta = best_atom.get("metadata", {})
        drucktext = meta.get("drucktext", "")
        max_laenge = meta.get("maxLaenge")

        # Person-aware lock key: same eCode can be locked twice (Person A AND B)
        # E.g. E1904701 KESt locked at L132 for Rainer AND L159 for Ute
        lock_key = f"{ecode}__{zone_person}" if zone_person else ecode

        # Convergence: math-lock at same (line, value) exists?
        if v_parsed is not None:
            key = (line_no, round(v_parsed, 2))
            converging_math = math_by_line_val.get(key, [])
            if converging_math:
                converged += 1
                if lock_key not in locks:
                    locks[lock_key] = Lock(
                        ecode, drucktext, v_parsed, line_no,
                        ["label-adjacency", "zone-filter",
                         f"person={zone_person or '—'}",
                         f"disambig-score={best_score:.1f}"] +
                            [r for m in converging_math for r in m.locked_by],
                        None, meta.get("anlage"), 1.0, 2,
                    )
                continue
        # Label-only (0.6) with zone-filter + drucktext-clean
        cleaned_value = (clean_string_value(value_str, drucktext, max_laenge)
                          if v_parsed is None else v_parsed)
        if lock_key not in locks:
            label_only += 1
            locks[lock_key] = Lock(
                ecode, drucktext, cleaned_value, line_no,
                ["label-adjacency", "zone-filter",
                 f"person={zone_person or '—'}",
                 f"disambig-score={best_score:.1f}"],
                None, meta.get("anlage"), 0.6, 2,
            )

    print(f"  Convergence locks (math+label → 1.0): {converged}")
    print(f"  Label-only locks  (zone-pass → 0.6): {label_only}")
    print(f"  Zone-rejected:                       {zone_rejected}")

    # Find unlocked
    locked_line_ids = {(l.line_no, l.value) for l in locks.values()}
    unlocked_currs = [n for n in currs if (n.line_no, n.value) not in locked_line_ids]
    unlocked_ints = [n for n in ints if (n.line_no, n.value) not in locked_line_ids]
    unlocked_dates = list(dates)

    print(f"\nAfter Welle 1:")
    print(f"  Locked: {len(locks)} ({len(used_lines)} unique lines)")
    print(f"  Unlocked currencies: {len(unlocked_currs)}")
    print(f"  Unlocked integers:   {len(unlocked_ints)}")
    print(f"  Unlocked dates:      {len(unlocked_dates)}")

    # Welle 5 — Lane 1 verify with all math-locked amounts
    print(f"\nW5: Lane 1 verifier")
    lane1_result = None
    test_dict = {}

    # Map math-locked values to canonical eCodes where the constraint identifies the type
    # (We can do this generically because the lock-label tells us the role)
    role_to_ecode = {
        "Bruttoarbeitslohn":             "E0200201",
        "Lohnsteuer/ESt":                "E0200301",
        "Lohnsteuer (Halbteilung-Basis)": "E0200301",
        "KESt":                          "E1904701",
        "RV-AN-Anteil":                  "E2000401",
        "KV-Basis-AN-Anteil":            "E2001203",
        "KV-AN-mit-Zusatz":              "E2001203",
        "PV-AN-Anteil":                  "E2001505",
        "PV-AN-Kinderlos":               "E2001505",
        "ALV-AN-Anteil":                 "E2004403",
    }
    # Prefer Convergence-locks (wave 2, confidence 1.0) over pseudo-math-locks
    # when both have a role mapping
    converged_by_ecode = {l.ecode: l for l in locks.values()
                           if l.wave == 2 and l.confidence == 1.0}
    for ec, lock in converged_by_ecode.items():
        if ec not in test_dict:
            test_dict[ec] = f"{float(lock.value):.2f}".replace(".", ",")
    for lock in locks.values():
        ecode = role_to_ecode.get(lock.drucktext)
        if ecode and ecode not in test_dict:
            test_dict[ecode] = f"{lock.value:.2f}".replace(".", ",")

    # Structural: Zusammenveranlagung + Steuerklasse from OCR
    if any("Zusammenveranlagung" in l for l in ocr_lines):
        test_dict["E0101201"] = "X"
    # Steuerklasse: skip ranges like "1-5", only single digit
    for l in ocr_lines:
        m = re.search(r"Steuerklasse\s*(\d)(?!\s*[-–])", l)
        if m:
            test_dict["E0200002"] = m.group(1)
            break

    print(f"  Sending {len(test_dict)} math-locked eCodes to Lane 1:")
    for k, v in sorted(test_dict.items()):
        print(f"    {k} = {v}")
    lane1_result = call_lane1(test_dict, erklaerungsjahr=2023)
    if lane1_result and lane1_result.get("erfolg"):
        d = lane1_result.get("daten", {})
        print(f"\n  Lane 1 Ergebnis:")
        print(f"    ZvE: {d.get('zve')} | ESt: {d.get('einkommensteuer')} | "
              f"Soli: {d.get('solidaritaetszuschlag')} | "
              f"Erstattung: {d.get('erstattung_oder_nachzahlung')}")

    # Write JSON + Markdown
    out = {
        "vz": 2023,
        "locks_count": len(locks),
        "unlocked_currency_count": len(unlocked_currs),
        "unlocked_integer_count": len(unlocked_ints),
        "unlocked_date_count": len(unlocked_dates),
        "locks": {k: {**asdict(v), "value": str(v.value)} for k, v in locks.items()},
        "lane1_result_summary": (
            {"zve": lane1_result["daten"].get("zve"),
             "est": lane1_result["daten"].get("einkommensteuer"),
             "soli": lane1_result["daten"].get("solidaritaetszuschlag"),
             "gesamt": lane1_result["daten"].get("gesamtsteuer"),
             "erstattung": lane1_result["daten"].get("erstattung_oder_nachzahlung")}
            if lane1_result and lane1_result.get("erfolg") else None
        ),
    }
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str))
    write_markdown_report(locks, ratio_findings, sum_findings, statutory,
                            lane1_result, unlocked_currs, unlocked_ints, unlocked_dates)
    print(f"\nResults: {OUT_JSON}")
    print(f"Report:  {OUT_MD}")


if __name__ == "__main__":
    main()
