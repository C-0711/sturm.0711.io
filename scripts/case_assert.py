#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
case_assert.py — Cent-genauer Abgleich E2E-Report gegen Ground-Truth-Fixture.

ZWECK (siehe docs/CENT-PERFECT-TASKLIST.md, Epic E2/E3)
    Vergleicht einen von scripts/case_e2e.py erzeugten Ergebnis-Report gegen ein
    Ground-Truth-Fixture (tests/groundtruth/<case>.json). Pro Position wird
    Soll/Ist/Diff ausgegeben. Zusaetzlich:
      - Bescheid-Kennzahlen (Erstattung/zvE) gegen Soll bzw. Korridor.
      - Coverage-Assertion: jeder Beleg liefert Felder ODER eine begruendete
        Warnung — sonst FAIL.

PRINZIP
    - Defensiv: Eingangswerte koennen als '34.726,16', '2960,00', '34726' oder
      Zahl vorliegen. normalize() klopft deutsche/anglo-Formate auf float.
    - Schluessel-tolerant: ein Soll-E-Code wird gegen JEDE beobachtete Position
      desselben E-Codes im Report gematcht (bester Cent-Treffer gewinnt). Die
      Engine ist in Entwicklung; mal kommt der Wert aus 'fields', mal aus
      'belege', mal aus 'mastercase.fakten'.

AUFRUF
    python3 case_assert.py <e2e-report.json> <groundtruth.json> [--json]
                           [--strict-optional] [--no-coverage]

EXIT-CODE
    0  alle PFLICHT-Checks bestanden (Abweichungen <= Toleranz).
    1  mindestens eine Pflicht-Abweichung > Toleranz, Coverage-Fail,
       oder Report enthaelt einen Engine-Fehler.
    3  Aufruf-/Datei-Fehler.
"""

import argparse
import json
import re
import sys


# ---------------------------------------------------------------------------
# Zahl-/Datum-Normalisierung (robust gegen deutsche und anglo Formate)
# ---------------------------------------------------------------------------

_NUM_RE = re.compile(r"[-+]?\d[\d.\s]*(?:,\d+|\.\d+)?")


def normalize_number(v):
    """
    Wandelt einen Wert in float (EUR) um. Akzeptiert:
        12345.67  (Zahl)
        "34.726,16" (deutsch: Punkt=Tausender, Komma=Dezimal)
        "2960,00"   (deutsch)
        "34726"     (ganzzahlig)
        "1.234.567,89", "  1 234,56 EUR", "-3.643,39"
        "1234.56"   (anglo: Punkt=Dezimal)  -> nur wenn kein Komma vorhanden
    Rueckgabe: float oder None, wenn nicht interpretierbar.
    """
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None

    # Nur den ersten Zahl-Token nehmen (Werte tragen evtl. ' EUR', '%', Text).
    m = _NUM_RE.search(s)
    if not m:
        return None
    tok = m.group(0).strip()
    tok = tok.replace(" ", "").replace(" ", "")

    has_comma = "," in tok
    has_dot = "." in tok

    if has_comma and has_dot:
        # Deutsch: Punkt = Tausender, Komma = Dezimal
        tok = tok.replace(".", "").replace(",", ".")
    elif has_comma:
        # Nur Komma -> Dezimaltrenner
        tok = tok.replace(",", ".")
    elif has_dot:
        # Nur Punkt: koennte Tausender (z.B. '1.234') ODER Dezimal ('1234.56')
        # sein. Heuristik: genau eine Punkt-Gruppe mit 1-2 Nachkommastellen ->
        # Dezimal. Sonst (z.B. '1.234' oder '1.234.567') -> Tausender.
        parts = tok.split(".")
        if len(parts) == 2 and 1 <= len(parts[1]) <= 2:
            pass  # als Dezimal lassen
        else:
            tok = tok.replace(".", "")
    try:
        return float(tok)
    except ValueError:
        return None


def normalize_date(v):
    """Datum auf ISO 'YYYY-MM-DD' bringen (akzeptiert TT.MM.JJJJ und ISO)."""
    if v is None:
        return None
    s = str(v).strip()
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", s)
    if m:
        d, mo, y = m.groups()
        return "%04d-%02d-%02d" % (int(y), int(mo), int(d))
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", s)
    if m:
        y, mo, d = m.groups()
        return "%04d-%02d-%02d" % (int(y), int(mo), int(d))
    return s


def normalize_text(v):
    return re.sub(r"\s+", " ", str(v or "")).strip().lower()


# ---------------------------------------------------------------------------
# Report-Zugriff: beobachtete Werte je E-Code holen
# ---------------------------------------------------------------------------

def observed_values_for(report, ecode):
    """
    Liefert die Liste der beobachteten Werte (mit Quelle) fuer einen E-Code aus
    dem case_e2e-Report. Faellt zurueck auf eine Direktsuche in raw.fields,
    falls der Report aelter/ohne 'positionen' ist.
    """
    out = []
    pos = (report or {}).get("positionen")
    if isinstance(pos, dict) and ecode in pos:
        for ob in pos[ecode].get("observed", []):
            out.append({
                "wert": ob.get("wert"),
                "person": ob.get("person"),
                "source": ob.get("source"),
                "doc": ob.get("doc"),
            })
        if out:
            return out

    # Fallback: direkt in den Rohdaten suchen (schluessel-tolerant)
    raw = (report or {}).get("raw", {})
    sf = raw.get("steuerfall", raw) if isinstance(raw, dict) else {}
    for f in (sf.get("fields") or sf.get("felder") or []):
        if isinstance(f, dict):
            ec = f.get("eCode") or f.get("e_code") or f.get("code")
            if str(ec) == ecode:
                out.append({
                    "wert": f.get("wert", f.get("value")),
                    "person": f.get("person"),
                    "source": "fields(raw)",
                    "doc": None,
                })
    return out


def best_number_match(observed, soll, tol_eur):
    """
    Aus den beobachteten Werten den mit der kleinsten Cent-Differenz waehlen.
    Rueckgabe: (ist_float_or_None, diff_or_None, treffer_dict_or_None).
    """
    best = None
    for ob in observed:
        iv = normalize_number(ob.get("wert"))
        if iv is None:
            continue
        diff = abs(iv - soll)
        if best is None or diff < best[1]:
            best = (iv, diff, ob)
    return best if best else (None, None, None)


# ---------------------------------------------------------------------------
# Coverage
# ---------------------------------------------------------------------------

def warnings_text(report):
    return " || ".join(str(w) for w in (report.get("warnings") or [])).lower()


def belegname_referenced(name, wtext):
    """Heuristik: taucht der (Teil-)Belegname in den Warnungen auf?"""
    base = name.lower()
    stem = re.sub(r"\.[a-z0-9]+$", "", base)  # Endung weg
    tokens = [t for t in re.split(r"[^a-z0-9]+", stem) if len(t) >= 4]
    if not tokens:
        return False
    hits = sum(1 for t in tokens if t in wtext)
    return hits >= max(1, len(tokens) // 2)


# ---------------------------------------------------------------------------
# Ausgabe-Helfer
# ---------------------------------------------------------------------------

def fmt_eur(x):
    if x is None:
        return "    —     "
    return "%12.2f" % x


def main(argv):
    ap = argparse.ArgumentParser(
        description="Cent-genauer Abgleich E2E-Report vs Ground-Truth.")
    ap.add_argument("report", help="E2E-Report-JSON (von case_e2e.py)")
    ap.add_argument("groundtruth", help="Ground-Truth-Fixture-JSON")
    ap.add_argument("--json", action="store_true",
                    help="Maschinenlesbares Ergebnis als JSON auf stdout")
    ap.add_argument("--strict-optional", action="store_true",
                    help="Auch optionale (required=false) Abweichungen failen")
    ap.add_argument("--no-coverage", action="store_true",
                    help="Coverage-Assertion ueberspringen")
    args = ap.parse_args(argv)

    try:
        with open(args.report, "r", encoding="utf-8") as f:
            report = json.load(f)
    except Exception as e:  # noqa: BLE001
        print("FEHLER: Report nicht lesbar: %s" % e, file=sys.stderr)
        return 3
    try:
        with open(args.groundtruth, "r", encoding="utf-8") as f:
            gt = json.load(f)
    except Exception as e:  # noqa: BLE001
        print("FEHLER: Ground-Truth nicht lesbar: %s" % e, file=sys.stderr)
        return 3

    results = {"positionen": [], "vorauszahlungen": [], "bescheid": [],
               "coverage": None}
    fail = False

    # Engine-Fehler im Report? -> sofort rot.
    if report.get("error"):
        print("ENGINE-FEHLER im Report: %s" % report.get("error"))
        if not args.json:
            print("=> FAIL (Report enthaelt keinen verwertbaren Lauf)")
        else:
            print(json.dumps({"ok": False, "reason": "engine_error",
                              "error": report.get("error")}, ensure_ascii=False))
        return 1

    def check_numeric_block(block_key, items, title):
        nonlocal fail
        print("\n=== %s ===" % title)
        hdr = "  %-10s %-8s %-44s %12s %12s %10s  %s"
        print(hdr % ("eCode/Key", "Pflicht", "Label", "Soll", "Ist", "Diff", "Quelle"))
        for key, spec in items.items():
            if not isinstance(spec, dict):
                continue
            required = bool(spec.get("required", False))
            mode = spec.get("matchModus", "zahl")
            label = str(spec.get("label", ""))[:44]
            tol = float(spec.get("toleranzCent", 0)) / 100.0

            # Korridor (z.B. Erstattung/zvE)
            if mode == "korridor":
                lo = spec.get("min")
                hi = spec.get("max")
                ist, diff, hit = _resolve_value(report, block_key, key, spec)
                ok = (ist is not None and
                      (lo is None or ist >= float(lo) - 1e-9) and
                      (hi is None or ist <= float(hi) + 1e-9))
                status = "OK" if ok else ("FAIL" if required else "warn")
                if not ok and (required or args.strict_optional):
                    fail = True
                rng = "[%s..%s]" % (
                    "%.2f" % float(lo) if lo is not None else "-inf",
                    "%.2f" % float(hi) if hi is not None else "+inf")
                print("  %-10s %-8s %-44s %12s %12s %10s  %s" % (
                    key, "ja" if required else "nein", label,
                    rng, fmt_eur(ist), status,
                    (hit.get("source") if hit else "n/a")))
                results[block_key].append({
                    "key": key, "modus": "korridor", "min": lo, "max": hi,
                    "ist": ist, "ok": ok, "required": required})
                continue

            # Datum
            if mode == "datum":
                soll = normalize_date(spec.get("value"))
                obs = observed_values_for(report, key)
                ist = None
                hit = None
                for ob in obs:
                    if normalize_date(ob.get("wert")) == soll:
                        ist = normalize_date(ob.get("wert"))
                        hit = ob
                        break
                if ist is None and obs:
                    hit = obs[0]
                    ist = normalize_date(obs[0].get("wert"))
                ok = (ist == soll)
                if not ok and (required or args.strict_optional):
                    fail = True
                print("  %-10s %-8s %-44s %12s %12s %10s  %s" % (
                    key, "ja" if required else "nein", label,
                    str(soll), str(ist), ("OK" if ok else
                     ("FAIL" if required else "warn")),
                    (hit.get("source") if hit else "FEHLT")))
                results[block_key].append({
                    "key": key, "modus": "datum", "soll": soll, "ist": ist,
                    "ok": ok, "required": required})
                continue

            # Text (z.B. Konfession)
            if mode == "text":
                soll = normalize_text(spec.get("value"))
                obs = observed_values_for(report, key)
                ist = None
                hit = None
                for ob in obs:
                    t = normalize_text(ob.get("wert"))
                    if t == soll or (soll and soll in t) or (t and t in soll):
                        ist = t
                        hit = ob
                        break
                if ist is None and obs:
                    hit = obs[0]
                    ist = normalize_text(obs[0].get("wert"))
                ok = (ist is not None and
                      (ist == soll or (soll and soll in ist) or
                       (ist and ist in soll)))
                if not ok and (required or args.strict_optional):
                    fail = True
                print("  %-10s %-8s %-44s %12s %12s %10s  %s" % (
                    key, "ja" if required else "nein", label,
                    str(soll)[:12], str(ist)[:12], ("OK" if ok else
                     ("FAIL" if required else "warn")),
                    (hit.get("source") if hit else "FEHLT")))
                results[block_key].append({
                    "key": key, "modus": "text", "soll": soll, "ist": ist,
                    "ok": ok, "required": required})
                continue

            # Standard: Zahl, cent-genau.
            # E-Code-Positionen werden gegen beobachtete Werte gematcht;
            # Spezial-Bloecke (Vorauszahlungen/Bescheid) holen den Ist-Wert aus
            # calcs/raw via _resolve_value (schluessel-tolerant).
            soll = normalize_number(spec.get("value"))
            if block_key in ("vorauszahlungen", "bescheid"):
                ist, _d, hit = _resolve_value(report, block_key, key, spec)
                diff = abs(ist - soll) if (ist is not None and soll is not None) else None
            else:
                obs = observed_values_for(report, key)
                ist, diff, hit = best_number_match(obs, soll, tol) \
                    if soll is not None else (None, None, None)
            if ist is None:
                ok = False
                status = "FEHLT" if required else "fehlt"
                if required or args.strict_optional:
                    fail = True
                print("  %-10s %-8s %-44s %12s %12s %10s  %s" % (
                    key, "ja" if required else "nein", label,
                    fmt_eur(soll), fmt_eur(None), status, "FEHLT"))
            else:
                ok = diff <= tol + 1e-9
                if not ok and (required or args.strict_optional):
                    fail = True
                status = "OK" if ok else ("FAIL" if required else "warn")
                print("  %-10s %-8s %-44s %12s %12s %10s  %s (%s%s)" % (
                    key, "ja" if required else "nein", label,
                    fmt_eur(soll), fmt_eur(ist),
                    ("%.2f" % diff), status,
                    hit.get("source") if hit else "",
                    ("/" + str(hit.get("doc"))[:16]) if hit and hit.get("doc") else ""))
            results[block_key].append({
                "key": key, "modus": "zahl", "soll": soll, "ist": ist,
                "diff": diff, "tolEur": tol, "ok": ok, "required": required,
                "quelle": (hit.get("source") if hit else None)})

    # 1) Eingangs-Positionen
    if isinstance(gt.get("positionen"), dict):
        check_numeric_block("positionen", gt["positionen"], "EINGANGSBETRAEGE (je E-Code)")

    # 2) Vorauszahlungen / Anrechnung  -> aus Bescheid 'angerechnet' + raw
    if isinstance(gt.get("vorauszahlungen"), dict):
        check_numeric_block("vorauszahlungen", gt["vorauszahlungen"],
                            "VORAUSZAHLUNGEN / ANRECHNUNG")

    # 3) Bescheid-Kennzahlen
    if isinstance(gt.get("bescheid"), dict):
        check_numeric_block("bescheid", gt["bescheid"], "BESCHEID-KENNZAHLEN")

    # 4) Coverage
    if not args.no_coverage and isinstance(gt.get("coverage"), dict):
        cov = gt["coverage"]
        belege = report.get("belege") or []
        wtext = warnings_text(report)
        min_belege = int(cov.get("minBelege", 0))
        allow_zero_with_warn = bool(
            cov.get("belegeMitNullFeldernErlaubtMitWarnung", True))
        print("\n=== COVERAGE (jeder Beleg: Felder ODER begruendete Warnung) ===")
        cov_fail = False
        if len(belege) < min_belege:
            print("  FAIL: nur %d Belege, erwartet >= %d" % (len(belege), min_belege))
            cov_fail = True
        zero_ok = 0
        zero_bad = 0
        for b in belege:
            n = b.get("feldAnzahl", 0) or 0
            name = b.get("source", "")
            if n > 0:
                continue
            # 0 Felder -> muss durch Warnung gedeckt sein
            covered = allow_zero_with_warn and (
                belegname_referenced(name, wtext) or
                # generische Warnung, die explizit auf 0-Felder/unbekannt hinweist
                any(k in wtext for k in ("0 feld", "keine felder", "unbekannt",
                                          "kein typ", "nicht zugeordnet",
                                          "ohne felder")))
            if covered:
                zero_ok += 1
                print("  ok   0 Felder, durch Warnung gedeckt : %s" % name)
            else:
                zero_bad += 1
                cov_fail = True
                print("  FAIL 0 Felder, KEINE Warnung         : %s" % name)
        # erwartete Belegnamen (optional)
        missing = []
        for exp in (cov.get("erwarteteBelegnamen") or []):
            if not any(exp.lower() in (b.get("source") or "").lower() for b in belege):
                missing.append(exp)
        if missing:
            print("  FAIL fehlende erwartete Belege: %s" % ", ".join(missing))
            cov_fail = True
        print("  Belege gesamt=%d | mit Feldern=%d | 0-Felder gedeckt=%d | 0-Felder UNGEDECKT=%d"
              % (len(belege), sum(1 for b in belege if (b.get("feldAnzahl") or 0) > 0),
                 zero_ok, zero_bad))
        results["coverage"] = {
            "belegeGesamt": len(belege),
            "minBelege": min_belege,
            "nullFelderGedeckt": zero_ok,
            "nullFelderUngedeckt": zero_bad,
            "fehlendeBelege": missing,
            "ok": not cov_fail,
        }
        if cov_fail:
            fail = True

    # Zusammenfassung
    n_fail_req = sum(1 for blk in ("positionen", "vorauszahlungen", "bescheid")
                     for r in results[blk]
                     if r.get("required") and not r.get("ok"))
    n_warn = sum(1 for blk in ("positionen", "vorauszahlungen", "bescheid")
                 for r in results[blk]
                 if (not r.get("required")) and not r.get("ok"))
    print("\n=== ERGEBNIS ===")
    print("  Pflicht-Abweichungen : %d" % n_fail_req)
    print("  Optionale Hinweise   : %d" % n_warn)
    if results["coverage"] is not None:
        print("  Coverage             : %s" %
              ("OK" if results["coverage"]["ok"] else "FAIL"))
    print("  => %s" % ("FAIL" if fail else "PASS"))

    if args.json:
        print(json.dumps({"ok": not fail,
                          "pflichtAbweichungen": n_fail_req,
                          "optionaleHinweise": n_warn,
                          "results": results}, ensure_ascii=False, indent=2))

    return 1 if fail else 0


def _resolve_value(report, block_key, key, spec):
    """
    Holt den Ist-Wert fuer Spezial-Keys (Bescheid/Vorauszahlung), die nicht als
    E-Code-Position vorliegen. Rueckgabe: (ist, diff_placeholder_None, hit).

    Reihenfolge der Quellen (schluessel-tolerant):
      - bescheid.erstattung      -> calcs[].erstattung
      - bescheid.zve_anker       -> calcs[].bindend.zve
      - vorauszahlungen.*        -> calcs[].angerechnet bzw. raw-Suche
      - sonst                    -> E-Code-Position (best match)
    """
    calcs = report.get("calcs") or []

    def _calc_vals(path_fn):
        vals = []
        for c in calcs:
            v = path_fn(c)
            n = normalize_number(v)
            if n is not None:
                vals.append((n, c))
        return vals

    if block_key == "bescheid" and key == "erstattung":
        vals = _calc_vals(lambda c: c.get("erstattung"))
        if vals:
            v, c = vals[0]
            return v, None, {"source": "calcs.erstattung",
                             "doc": c.get("einheit")}
        return None, None, None

    if block_key == "bescheid" and key in ("zve_anker", "zve"):
        vals = _calc_vals(lambda c: (c.get("bindend") or {}).get("zve"))
        if vals:
            v, c = vals[0]
            return v, None, {"source": "calcs.bindend.zve",
                             "doc": c.get("einheit")}
        return None, None, None

    if block_key == "vorauszahlungen":
        # Beste Naeherung: angerechnet-Summe; einzelne VZ-Posten stehen evtl. im
        # raw. Wir suchen tolerant nach dem Soll-Betrag in calcs.angerechnet und
        # in flachen raw-Zahlen, sonst FEHLT.
        soll = normalize_number(spec.get("value"))
        # a) exakter Treffer in angerechnet?
        for c in calcs:
            n = normalize_number(c.get("angerechnet"))
            if n is not None and soll is not None and abs(n - soll) < 0.005:
                return n, None, {"source": "calcs.angerechnet",
                                 "doc": c.get("einheit")}
        # b) tiefen-Suche in raw nach passendem Zahlenwert (best effort)
        hit = _deep_find_number(report.get("raw"), soll) if soll is not None else None
        if hit is not None:
            return hit, None, {"source": "raw(deep)", "doc": None}
        # c) sonst: angerechnet-Summe als Ist zeigen (zur Sichtbarkeit)
        for c in calcs:
            n = normalize_number(c.get("angerechnet"))
            if n is not None:
                return n, None, {"source": "calcs.angerechnet(summe)",
                                 "doc": c.get("einheit")}
        return None, None, None

    # Default: behandel key als E-Code-Position
    obs = observed_values_for(report, key)
    soll = normalize_number(spec.get("value"))
    if soll is not None:
        ist, diff, hit = best_number_match(obs, soll, 0)
        return ist, diff, hit
    if obs:
        return normalize_number(obs[0].get("wert")), None, obs[0]
    return None, None, None


def _deep_find_number(obj, target, tol=0.005, _depth=0):
    """Sucht rekursiv eine Zahl, die 'target' (cent) entspricht. Best effort."""
    if _depth > 8 or obj is None:
        return None
    if isinstance(obj, (int, float)):
        return float(obj) if abs(float(obj) - target) < tol else None
    if isinstance(obj, str):
        n = normalize_number(obj)
        return n if (n is not None and abs(n - target) < tol) else None
    if isinstance(obj, dict):
        for v in obj.values():
            r = _deep_find_number(v, target, tol, _depth + 1)
            if r is not None:
                return r
    if isinstance(obj, list):
        for v in obj:
            r = _deep_find_number(v, target, tol, _depth + 1)
            if r is not None:
                return r
    return None


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
