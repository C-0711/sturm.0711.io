#!/usr/bin/env python3
"""
elster_extract.py — generischer Extraktions-Workflow gegen den
ELSTER-Quantum-Container.

Eingaben (nichts hardcoded):
  --container <dir>   Pfad zum Container (enthält atoms.json,
                      paragraph_estg.json, disambiguation_hints.json,
                      nested_schemas/, container.json)
  --input <dir>       Ordner mit beliebigen Belegen / Rechnungen
                      (.pdf, .jpg, .jpeg, .png, .tif, .tiff)
  --out <dir>         Ausgabe-Ordner für OCR + Treffer + Report

Pipeline:
  1) Container laden (atoms, §EStG-Mapping, Hints).
  2) Index aus atoms.metadata.drucktext (+ atoms.value) bauen.
  3) Jeden Beleg OCR-en (pdftotext / pdftoppm+tesseract / tesseract).
  4) Pro Zeile alle Drucktext-Labels via Normalisierung suchen
     und den datentyp-passenden Wert (currency/date/string) extrahieren.
  5) Wert gegen atom.formatRegex normalisieren & validieren.
  6) Treffer schreiben: eCode, drucktext, anlage, value, range, §EStG,
     Beleg-Datei, Beleg-Zeile, Treffer-Begründung.
  7) Aggregierter Report (Markdown + JSON) pro Anlage gruppiert.

KEINE Beleg-Inhalte sind im Code referenziert. Alle Felder, Labels,
Regex, §EStG-Zuordnungen und Range-Werte kommen ausschließlich aus
dem Container.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Iterable


# ---------- 1. Container -------------------------------------------------

def load_container(container_dir: Path) -> dict[str, Any]:
    atoms_path = container_dir / "atoms.json"
    para_path = container_dir / "paragraph_estg.json"
    hints_path = container_dir / "disambiguation_hints.json"
    meta_path = container_dir / "container.json"

    if not atoms_path.exists():
        raise SystemExit(f"atoms.json fehlt in {container_dir}")

    atoms = json.loads(atoms_path.read_text(encoding="utf-8"))
    paragraph = (
        json.loads(para_path.read_text(encoding="utf-8"))
        if para_path.exists() else {"mapping": {}}
    )
    hints = (
        json.loads(hints_path.read_text(encoding="utf-8"))
        if hints_path.exists() else {"hints": {}}
    )
    meta = (
        json.loads(meta_path.read_text(encoding="utf-8"))
        if meta_path.exists() else {}
    )
    return {
        "meta": meta,
        "atoms": atoms,
        "paragraph_mapping": paragraph.get("mapping", {}),
        "hints": hints.get("hints", {}),
    }


# ---------- 2. Index -----------------------------------------------------

def normalize_label(s: str) -> str:
    """Vergleichs-Normalform: lowercased, Umlaute/Diakritika entfernt,
    Whitespace kollabiert, Satzzeichen außer Wortzeichen entfernt."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def build_index(atoms: list[dict]) -> list[dict]:
    """Liefert pro Atom die Such-Tokens für Drucktext + value-Bezeichnung."""
    index = []
    for atom in atoms:
        meta = atom.get("metadata") or {}
        drucktext = (meta.get("drucktext") or "").strip()
        bez = (atom.get("value") or "").strip()
        labels = []
        for lbl in (drucktext, bez):
            nlabel = normalize_label(lbl)
            if nlabel and len(nlabel) >= 4:  # zu kurze Labels filtern
                labels.append({"raw": lbl, "norm": nlabel})
        if not labels:
            continue
        kontext = meta.get("kontextPaths") or []
        prefix = kontext[0].split("/")[0] if kontext else ""
        index.append({
            "atom": atom,
            "labels": labels,
            "prefix": prefix,
        })
    return index


# ---------- 3. OCR -------------------------------------------------------

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}
PDF_EXT = {".pdf"}


def ocr_pdf(pdf: Path, out_dir: Path) -> str:
    """Erst pdftotext -layout, bei leerem Ergebnis pdftoppm + tesseract."""
    txt_path = out_dir / (pdf.stem + ".pdftotext.txt")
    subprocess.run(
        ["pdftotext", "-layout", str(pdf), str(txt_path)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    text = txt_path.read_text(encoding="utf-8", errors="ignore") if txt_path.exists() else ""
    if text.strip():
        return text

    # Fallback: rasterize + tesseract
    raster_prefix = out_dir / (pdf.stem + ".page")
    subprocess.run(
        ["pdftoppm", "-r", "250", "-png", str(pdf), str(raster_prefix)],
        check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    parts = []
    for img in sorted(out_dir.glob(pdf.stem + ".page-*.png")):
        out_txt = img.with_suffix("")  # tesseract hängt .txt an
        subprocess.run(
            ["tesseract", "-l", "deu+eng", "--psm", "6",
             str(img), str(out_txt)],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        p = Path(str(out_txt) + ".txt")
        if p.exists():
            parts.append(p.read_text(encoding="utf-8", errors="ignore"))
    return "\n".join(parts)


def ocr_image(img: Path, out_dir: Path) -> str:
    out_base = out_dir / img.stem
    subprocess.run(
        ["tesseract", "-l", "deu+eng", "--psm", "6",
         str(img), str(out_base)],
        check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    p = Path(str(out_base) + ".txt")
    return p.read_text(encoding="utf-8", errors="ignore") if p.exists() else ""


def ocr_any(file: Path, out_dir: Path) -> str:
    ext = file.suffix.lower()
    if ext in PDF_EXT:
        return ocr_pdf(file, out_dir)
    if ext in IMAGE_EXT:
        return ocr_image(file, out_dir)
    if ext in {".txt", ".md"}:
        return file.read_text(encoding="utf-8", errors="ignore")
    return ""


# ---------- 4. Wert-Extraktion + Validierung -----------------------------

# Wert-Pattern pro datentyp — generisch, container-konform
RX_CURRENCY = re.compile(
    r"(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|-?\d+(?:[,\.]\d{1,2})?)\s*(?:€|EUR)?\s*$"
)
RX_DATE = re.compile(
    r"\b(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}|\d{4}-\d{2}-\d{2})\b"
)


def normalize_currency_to_cents(raw: str) -> int | None:
    """'1.234,56' / '63.559,90' / '63559' → Cents (int)."""
    s = raw.strip().replace("€", "").replace("EUR", "").strip()
    sign = -1 if s.startswith("-") else 1
    s = s.lstrip("+-")
    if not s:
        return None
    # deutsche Notation: . = Tausender, , = Dezimal
    if "," in s:
        s = s.replace(".", "")
        s = s.replace(",", ".")
    try:
        f = float(s)
    except ValueError:
        return None
    return sign * int(round(f * 100))


def normalize_date(raw: str) -> str | None:
    raw = raw.strip()
    m = re.match(r"^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$", raw)
    if m:
        d, mo, y = m.groups()
        if len(y) == 2:
            y = ("20" if int(y) < 50 else "19") + y
        return f"{int(d):02d}.{int(mo):02d}.{int(y):04d}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", raw)
    if m:
        y, mo, d = m.groups()
        return f"{int(d):02d}.{int(mo):02d}.{int(y):04d}"
    return None


def is_currency_regex(regex: str) -> bool:
    """Heuristik: enthält der formatRegex eine Kommagruppe `,\\d{2}` → Geldbetrag."""
    return ",\\d" in regex or ",\\d{2" in regex


def extract_value(line_after_label: str, datentyp: str,
                  format_regex: str = "") -> dict | None:
    s = line_after_label.strip()
    if not s:
        return None
    if datentyp == "currency":
        m = RX_CURRENCY.search(s)
        if not m:
            return None
        raw = m.group(1)
        if is_currency_regex(format_regex):
            cents = normalize_currency_to_cents(raw)
            if cents is None:
                return None
            return {"raw": raw, "normalized": cents, "format": "cents"}
        # Ganzzahl-Feld (Tage, Kilometer, Anzahl)
        try:
            iv = int(raw.replace(".", "").replace(",", ""))
        except ValueError:
            return None
        return {"raw": raw, "normalized": iv, "format": "int"}
    if datentyp == "date":
        m = RX_DATE.search(s)
        if not m:
            return None
        nd = normalize_date(m.group(1))
        if not nd:
            return None
        return {"raw": m.group(1), "normalized": nd, "format": "TT.MM.JJJJ"}
    if datentyp == "string":
        return {"raw": s, "normalized": s.strip(), "format": "string"}
    return None


def value_matches_regex(value_raw: str, atom: dict) -> bool:
    rx = (atom.get("metadata") or {}).get("formatRegex") or ""
    if not rx or rx in ("X", "N", "D"):
        return True
    try:
        return re.fullmatch(rx, value_raw.strip()) is not None
    except re.error:
        return True


# ---------- 5. Matcher ---------------------------------------------------

@dataclass
class Hit:
    eCode: str
    drucktext: str
    bezeichnung: str
    anlage: str
    datentyp: str
    pflicht: bool
    vordruckzeile: str
    formatRegex: str
    minLaenge: Any
    maxLaenge: Any
    kontextPaths: list
    paragraph: str
    value_raw: str
    value_normalized: Any
    value_format: str
    source_file: str
    source_line_no: int
    source_line: str
    match_label: str
    match_confidence: float
    citation_document: str
    citation_section: str
    alternatives: list = field(default_factory=list)  # alt eCodes mit gleichem Drucktext/Anlage


def best_label_match(line_norm: str, index: list[dict]) -> list[tuple[dict, dict, int]]:
    """Liefert alle Index-Einträge, deren normalisierter Label-String
    in der normalisierten Zeile als Teilstring vorkommt.
    Längster Treffer pro Atom gewinnt.
    """
    hits = []
    for entry in index:
        best = None
        for lbl in entry["labels"]:
            pos = line_norm.find(lbl["norm"])
            if pos < 0:
                continue
            if best is None or len(lbl["norm"]) > len(best[1]["norm"]):
                best = (pos, lbl)
        if best:
            hits.append((entry, best[1], best[0]))
    return hits


def line_after(label_norm: str, original: str) -> str:
    """Best-effort: gibt den Original-Text nach dem Label zurück.
    Sucht das Label tolerant im Original (case-insensitive, ohne Diakritika
    auf einer Kopie). Fallback: ganzes Trailing-Stück."""
    orig_norm = normalize_label(original)
    pos = orig_norm.find(label_norm)
    if pos < 0:
        return original
    # ungefähre Token-Position in der Original-Zeile
    tokens_in_label = len(label_norm.split())
    tokens = re.split(r"(\s+)", original)
    word_count = 0
    out_index = 0
    for i, t in enumerate(tokens):
        if t.strip() and not t.isspace():
            word_count += 1
        if word_count > tokens_in_label:
            out_index = i
            break
    return "".join(tokens[out_index:]).strip()


def paragraph_for(prefix: str, mapping: dict) -> str:
    return mapping.get(prefix, "")


ANLAGE_HEADING_RX = re.compile(
    r"\bAnlage\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9_]+(?:[-_/][A-Za-zÄÖÜäöüß0-9]+)?)",
    re.UNICODE,
)
ANLAGE_NAME_MAP = {
    # Klartext-Überschriften → Anlagen-Code (vom Container)
    "sonderausgaben": "SA",
    "vorsorgeaufwand": "VOR",
    "haushaltsnahe": "HA_35a",
    "kind": "Kind",
    "kapitalvermoegen": "KAP",
    "kap": "KAP",
    "n": "N",
    "r": "R",
    "v": "V",
    "g": "G",
    "s": "S",
    "l": "L",
    "av": "AV",
    "vor": "VOR",
    "agb": "AgB",
    "ausserordentliche": "AgB",
    "sonderausgaben_": "SA",
    "est1a": "ESt1A",
    "hauptvordruck": "ESt1A",
    "n_aus": "N_AUS",
    "n_gre": "N_GRE",
    "n_dhh": "N_DHH",
    "fw": "FW",
    "aus": "AUS",
}


def detect_anlage_context(line: str) -> str | None:
    m = ANLAGE_HEADING_RX.search(line)
    if not m:
        return None
    raw = m.group(1).strip()
    key = normalize_label(raw).replace(" ", "_")
    # exakte Treffer zuerst
    if raw in {"N", "R", "V", "G", "S", "L", "KAP", "VOR", "AV", "SA",
               "AgB", "Kind", "ESt1A", "N_AUS", "N_GRE", "N_DHH", "FW",
               "AUS", "SO", "Mob", "WA_ESt", "HA_35a"}:
        return raw
    return ANLAGE_NAME_MAP.get(key)


# generische Labels, die ohne Anlagen-Kontext zu viel Noise erzeugen
GENERIC_LABELS = {
    normalize_label(x) for x in (
        "Summe", "Betrag", "Bezeichnung", "Finanzamt", "Name",
        "Einkunftsart", "Identifikationsnummer", "Datum", "Anzahl",
        "Art", "Vorname", "Religion", "Wohnort", "Hausnummer",
        "Postleitzahl Inland", "Straße",
    )
}


def scan_document(text: str, file_name: str, index: list[dict],
                  para_map: dict) -> list[Hit]:
    hits: list[Hit] = []
    seen: set[tuple[str, int, str]] = set()  # eCode, lineno, value → dedup
    current_anlage: str | None = None
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        # Anlagen-Kontext aktualisieren, BEVOR wir die Zeile matchen
        new_anlage = detect_anlage_context(stripped)
        if new_anlage:
            current_anlage = new_anlage
        line_norm = normalize_label(stripped)
        if not line_norm:
            continue
        candidates = best_label_match(line_norm, index)
        if not candidates:
            continue
        # nach Label-Länge sortieren (längste Labels = präzisere Treffer)
        candidates.sort(key=lambda c: len(c[1]["norm"]), reverse=True)
        # 1) bevorzugte Filterung nach aktueller Anlage
        if current_anlage:
            preferred = [
                c for c in candidates
                if (c[0]["atom"].get("metadata") or {}).get("anlage") == current_anlage
            ]
            if preferred:
                candidates = preferred
        used_atoms = set()
        # Gruppen für Alternatives: (drucktext_norm, anlage) → bereits emittierter Hit
        emitted_by_group: dict[tuple[str, str], int] = {}
        for entry, label, _ in candidates:
            atom = entry["atom"]
            ecode = atom["field_name"]
            if ecode in used_atoms:
                continue
            # generische Labels ohne Anlagen-Kontext überspringen
            if label["norm"] in GENERIC_LABELS and not current_anlage:
                continue
            meta = atom.get("metadata") or {}
            tail = line_after(label["norm"], stripped)
            val = extract_value(
                tail,
                meta.get("datentyp", "string"),
                meta.get("formatRegex", ""),
            )
            if not val:
                # auch wenn kein Wert da → trotzdem nicht emitten
                continue
            if not value_matches_regex(val["raw"], atom):
                # nicht regex-konform → überspringen statt halluzinieren
                continue
            # bei generischen Labels: nur wenn anlage matched
            if label["norm"] in GENERIC_LABELS:
                if meta.get("anlage") != current_anlage:
                    continue
            key = (ecode, lineno, str(val["normalized"]))
            if key in seen:
                continue
            # Gruppen-Key: gleiche Drucktext + Anlage + Wert + Zeile = Alternative
            group_key = (
                normalize_label(meta.get("drucktext") or ""),
                meta.get("anlage") or "",
                str(val["normalized"]),
                lineno,
            )
            if group_key in emitted_by_group:
                prev_idx = emitted_by_group[group_key]
                hits[prev_idx].alternatives.append({
                    "eCode": ecode,
                    "vordruckzeile": str(meta.get("vordruckzeile", "")),
                    "kontextPaths": meta.get("kontextPaths") or [],
                    "paragraph": paragraph_for(entry["prefix"], para_map),
                })
                seen.add(key)
                used_atoms.add(ecode)
                continue
            seen.add(key)
            used_atoms.add(ecode)
            emitted_by_group[group_key] = len(hits)
            hits.append(Hit(
                eCode=ecode,
                drucktext=meta.get("drucktext", ""),
                bezeichnung=atom.get("value", ""),
                anlage=meta.get("anlage", ""),
                datentyp=meta.get("datentyp", ""),
                pflicht=bool(meta.get("pflicht")),
                vordruckzeile=str(meta.get("vordruckzeile", "")),
                formatRegex=meta.get("formatRegex", ""),
                minLaenge=meta.get("minLaenge"),
                maxLaenge=meta.get("maxLaenge"),
                kontextPaths=meta.get("kontextPaths") or [],
                paragraph=paragraph_for(entry["prefix"], para_map),
                value_raw=val["raw"],
                value_normalized=val["normalized"],
                value_format=val["format"],
                source_file=file_name,
                source_line_no=lineno,
                source_line=stripped,
                match_label=label["raw"],
                match_confidence=min(1.0, len(label["norm"]) / max(len(line_norm), 1)),
                citation_document=atom.get("citation_document", ""),
                citation_section=atom.get("citation_section", ""),
            ))
    return hits


# ---------- 6. Report ----------------------------------------------------

def write_per_doc(out_dir: Path, file_name: str, hits: list[Hit]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / (Path(file_name).stem + ".hits.json")
    p.write_text(
        json.dumps([asdict(h) for h in hits], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return p


def write_report(out_dir: Path, all_hits: list[Hit], container_meta: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    md = out_dir / "REPORT.md"
    js = out_dir / "REPORT.json"

    js.write_text(
        json.dumps({
            "container": {
                "id": container_meta.get("id"),
                "version": container_meta.get("version"),
                "merkle_root": container_meta.get("merkle_root"),
                "atoms_total": (container_meta.get("stats") or {}).get("atoms_total"),
            },
            "hits": [asdict(h) for h in all_hits],
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    by_anlage: dict[str, list[Hit]] = {}
    for h in all_hits:
        by_anlage.setdefault(h.anlage or "?", []).append(h)

    lines = []
    lines.append("# ELSTER-Extraktions-Report")
    lines.append("")
    lines.append(f"- Container: `{container_meta.get('id','?')}` "
                 f"({container_meta.get('version','?')})")
    lines.append(f"- merkle_root: `{container_meta.get('merkle_root','?')}`")
    lines.append(f"- Treffer gesamt: **{len(all_hits)}**")
    lines.append(f"- Anlagen mit Treffern: **{len(by_anlage)}**")
    lines.append("")
    for anlage in sorted(by_anlage):
        rows = by_anlage[anlage]
        lines.append(f"## Anlage {anlage} — {len(rows)} Treffer")
        lines.append("")
        lines.append("| eCode (Alt.) | Drucktext | Wert (Beleg) | Normalisiert | Vordruckzeile | Range/Regex | §EStG | Beleg | Zeile |")
        lines.append("|---|---|---|---|---|---|---|---|---|")
        for h in rows:
            rng = ""
            if h.minLaenge is not None or h.maxLaenge is not None:
                rng = f"len {h.minLaenge or 0}–{h.maxLaenge or '?'} "
            rng = (rng + f"`{h.formatRegex}`").strip()
            pipe = "\\|"
            drucktext = h.drucktext.replace("|", pipe)
            value_raw = h.value_raw.replace("|", pipe)
            rng_md = rng.replace("|", pipe)
            paragraph = h.paragraph.replace("|", pipe)
            alts = ""
            if h.alternatives:
                alts = " · alt: " + ", ".join(
                    f"`{a['eCode']}`" for a in h.alternatives
                )
            lines.append(
                f"| `{h.eCode}`{alts} "
                f"| {drucktext} "
                f"| {value_raw} "
                f"| {h.value_normalized} ({h.value_format}) "
                f"| {h.vordruckzeile} "
                f"| {rng_md} "
                f"| {paragraph} "
                f"| {Path(h.source_file).name} "
                f"| {h.source_line_no} |"
            )
        lines.append("")
    md.write_text("\n".join(lines), encoding="utf-8")
    return md


# ---------- 7. CLI -------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description="Elster-Quantum-Extraktion (generisch).")
    p.add_argument("--container", required=True, type=Path)
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()

    if not args.container.is_dir():
        raise SystemExit(f"--container muss Verzeichnis sein: {args.container}")
    if not args.input.is_dir():
        raise SystemExit(f"--input muss Verzeichnis sein: {args.input}")
    args.out.mkdir(parents=True, exist_ok=True)
    ocr_dir = args.out / "ocr"
    hits_dir = args.out / "hits"
    ocr_dir.mkdir(parents=True, exist_ok=True)
    hits_dir.mkdir(parents=True, exist_ok=True)

    container = load_container(args.container)
    index = build_index(container["atoms"])
    para_map = container["paragraph_mapping"]

    print(f"[container] {container['meta'].get('id','?')} "
          f"atoms={len(container['atoms'])} index={len(index)}")

    all_hits: list[Hit] = []
    files = []
    container_abs = args.container.resolve()
    for ext in (PDF_EXT | IMAGE_EXT):
        files.extend(sorted(args.input.rglob(f"*{ext}")))
    # Container-Ordner aus dem Beleg-Scan ausschließen
    files = [f for f in files if container_abs not in f.resolve().parents
             and f.resolve() != container_abs]
    if not files:
        print(f"[warn] keine Belege in {args.input}", file=sys.stderr)

    for f in files:
        print(f"[ocr ] {f.name}")
        text = ocr_any(f, ocr_dir)
        if not text.strip():
            print(f"[warn] OCR leer: {f.name}", file=sys.stderr)
            continue
        # Roh-OCR persistieren
        (ocr_dir / (f.stem + ".ocr.txt")).write_text(text, encoding="utf-8")
        hits = scan_document(text, str(f), index, para_map)
        print(f"[hits] {f.name}: {len(hits)}")
        write_per_doc(hits_dir, f.name, hits)
        all_hits.extend(hits)

    report_md = write_report(args.out, all_hits, container["meta"])
    print(f"[done] Treffer gesamt: {len(all_hits)}")
    print(f"[done] Report: {report_md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
