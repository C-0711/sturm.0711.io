#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
case_e2e.py — Generischer E2E-Harness fuer die Steuer-Engine (ctax-web).

ZWECK
    Faehrt einen beliebigen Mandanten-Beleg-Ordner FRESH (ohne Cache) gegen die
    laufende Engine und schreibt einen strukturierten Ergebnis-Report als JSON.
    Der Report ist die Eingabe fuer `case_assert.py`, der ihn cent-genau gegen
    ein Ground-Truth-Fixture prueft.

    Dieses Skript ist fuer die Ausfuehrung AUF dem Host h200v gedacht, wo die
    Engine unter http://localhost:7190 erreichbar ist.

PRINZIP (siehe docs/CENT-PERFECT-TASKLIST.md, Epic E)
    - Ordner-parametrisiert. KEINE erwarteten Werte hier (die leben nur im
      Test-Fixture). KEINE Case-Daten (Namen/IdNr/Betraege) hartcodiert.
    - Defensiv gegen Schluessel-Varianten: die Engine ist in Entwicklung, daher
      werden Werte aus mehreren Quellen (fields, belege[].felderListe,
      mastercase.fakten) eingesammelt und zu einem normalisierten Positions-
      Index verdichtet. So bleibt der Harness stabil, waehrend sich einzelne
      Response-Felder noch aendern.

AUFRUF
    python3 case_e2e.py <belege-ordner> <vz> [caseId] [--out <pfad>]
                        [--base <url>] [--no-poll] [--timeout-precalc <s>]
                        [--poll-budget <s>] [--exclude <substr>] ...

    Beispiel (auf h200v):
        python3 case_e2e.py /home/christoph.bertsch/0711-sturm-elster/Belege 2024

EXIT-CODE
    0  Engine hat geantwortet und ein Report wurde geschrieben.
    2  Engine-Fehler / kein verwertbarer Response (Report enthaelt 'error').
    3  Aufruf-/Argumentfehler.
"""

import argparse
import glob
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request


# ---------------------------------------------------------------------------
# HTTP-Helfer (stdlib only — kein requests, damit auf h200v garantiert laeuft)
# ---------------------------------------------------------------------------

def _post(base, path, payload, timeout):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _get(base, path, timeout=30):
    with urllib.request.urlopen(base + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# Defensive Zugriffe — die Engine variiert Schluessel (deutsch/englisch, alt/neu)
# ---------------------------------------------------------------------------

def _first(d, *keys, default=None):
    """Erstes vorhandenes (nicht-None) Feld aus mehreren Schluessel-Kandidaten."""
    if not isinstance(d, dict):
        return default
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def _basename(src):
    """Pfad/Quelle robust auf den Dateinamen reduzieren (haengt evtl. '#page' an)."""
    s = str(src or "")
    s = s.split("#", 1)[0]
    return os.path.basename(s)


# ---------------------------------------------------------------------------
# Belege im Ordner finden (rekursiv, gaengige Formate, optional ausgeschlossen)
# ---------------------------------------------------------------------------

_DEFAULT_EXTS = (".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp")


def discover_belege(folder, exts=_DEFAULT_EXTS, excludes=()):
    found = []
    for ext in exts:
        found += glob.glob(os.path.join(folder, "**", "*" + ext), recursive=True)
        found += glob.glob(os.path.join(folder, "**", "*" + ext.upper()), recursive=True)
    # Duplikate (durch Lower/Upper-Glob) raus, deterministisch sortieren
    uniq = sorted(set(os.path.abspath(p) for p in found))
    if excludes:
        low = [e.lower() for e in excludes]
        uniq = [p for p in uniq
                if not any(sub in os.path.basename(p).lower() for sub in low)]
    return uniq


# ---------------------------------------------------------------------------
# Normalisierung: aus allen Quellen einen Positions-Index je (eCode, person) bauen
# ---------------------------------------------------------------------------

def _norm_field(f):
    """Ein einzelnes Feld auf eine einheitliche Form bringen (Schluessel-tolerant)."""
    if not isinstance(f, dict):
        return None
    ecode = _first(f, "eCode", "e_code", "ecode", "code")
    if ecode is None:
        return None
    return {
        "eCode": str(ecode),
        "label": _first(f, "label", "pdfLabel", "belegfeld_id", "feld", default=""),
        "wert": _first(f, "wert", "value", "val", "betrag", default=None),
        "person": _first(f, "person", "pers", default=None),
        "anlage": _first(f, "anlage", "form", default=None),
        "zeile": _first(f, "zeile", "line", default=None),
        "method": _first(f, "method", "lane", default=None),
        # Provenienz (Seite/Box) wenn vorhanden — nur zur Nachvollziehbarkeit
        "prov": _first(f, "prov", "provenance", "sources", default=None),
    }


def collect_positions(resp, mastercase):
    """
    Sammelt JEDEN beobachteten Wert je E-Code aus allen Quellen ein.

    Rueckgabe:
        {
          "<eCode>": {
             "eCode": "...",
             "labels": [...],          # alle gesehenen Labels (dedup)
             "observed": [             # jede Beobachtung mit Quelle
                {"wert": "...", "person": "A", "anlage": "...",
                 "source": "fields|beleg|fakten", "doc": "<basename|hash>"}
             ]
          }, ...
        }

    Bewusst KEINE Aggregation/Heuristik hier: der Assert-Schritt entscheidet,
    welcher beobachtete Wert zur Soll-Vorgabe passt. So bleibt der Report ein
    treues, verlustfreies Abbild dessen, was die Engine ausgegeben hat.
    """
    index = {}

    def _add(ecode, label, wert, person, anlage, source, doc):
        ec = str(ecode)
        slot = index.setdefault(ec, {"eCode": ec, "labels": [], "observed": []})
        if label and str(label) not in slot["labels"]:
            slot["labels"].append(str(label))
        slot["observed"].append({
            "wert": wert,
            "person": person,
            "anlage": anlage,
            "source": source,
            "doc": doc,
        })

    # 1) Top-Level fields[]
    for raw in _as_list(_first(resp, "fields", "felder")):
        nf = _norm_field(raw)
        if nf:
            _add(nf["eCode"], nf["label"], nf["wert"], nf["person"],
                 nf["anlage"], "fields", None)

    # 2) belege[].felderListe[] (bzw. felder[] wenn als Liste vorhanden)
    for b in _as_list(_first(resp, "belege", "documents", "docs")):
        if not isinstance(b, dict):
            continue
        doc = _basename(_first(b, "source", "path", "datei", default=""))
        fl = _first(b, "felderListe", "felder", "fields")
        for raw in _as_list(fl if isinstance(fl, list) else None):
            nf = _norm_field(raw)
            if nf:
                _add(nf["eCode"], nf["label"], nf["wert"],
                     nf["person"] if nf["person"] is not None
                     else _first(b, "person"),
                     nf["anlage"], "beleg", doc)

    # 3) mastercase.fakten[] (harmonisiert; value oft praeziser/anders gerundet)
    if isinstance(mastercase, dict):
        mc = _first(mastercase, "mastercase", default=mastercase)
        for fk in _as_list(_first(mc, "fakten", "facts", "fields", "felder")):
            nf = _norm_field(fk)
            if nf:
                src_docs = ""
                if isinstance(nf.get("prov"), list) and nf["prov"]:
                    p0 = nf["prov"][0]
                    if isinstance(p0, dict):
                        src_docs = str(p0.get("document", ""))[:12]
                _add(nf["eCode"], nf["label"], nf["wert"], nf["person"],
                     nf["anlage"], "fakten", src_docs)

    return index


def summarize_belege(resp):
    """Coverage-Liste pro Beleg: Felder-Anzahl + Status/Typ (fuer A0/Coverage)."""
    out = []
    for b in _as_list(_first(resp, "belege", "documents", "docs")):
        if not isinstance(b, dict):
            continue
        # Feldanzahl tolerant: 'felder' kann int ODER Liste sein
        felder = _first(b, "felder", "fields")
        if isinstance(felder, list):
            n = len(felder)
        elif isinstance(felder, int):
            n = felder
        else:
            n = len(_as_list(_first(b, "felderListe")))
        out.append({
            "source": _basename(_first(b, "source", "path", "datei", default="")),
            "belegTyp": _first(b, "belegTyp", "typ", "type", default=None),
            "person": _first(b, "person", default=None),
            "status": _first(b, "status", default=None),
            "method": _first(b, "method", "lane", default=None),
            "feldAnzahl": n,
        })
    return out


def summarize_calcs(resp):
    """Bescheid-Kennzahlen tolerant flachklopfen (bindend.* nach oben ziehen)."""
    out = []
    for c in _as_list(_first(resp, "calcs", "bescheide", "calculations")):
        if not isinstance(c, dict):
            continue
        bind = _first(c, "bindend", "binding", "result", default={}) or {}
        out.append({
            "einheit": _first(c, "einheit", "person", "unit", default=None),
            "felder": _first(c, "felder", default=None),
            "quelle": _first(c, "quelle", "source", default=None),
            "konflikte": _first(c, "konflikte", "conflicts", default=None),
            "angerechnet": _first(c, "angerechnet", "anrechnung", default=None),
            "erstattung": _first(c, "erstattung", "refund", default=None),
            "bindend": {
                "zve": _first(bind, "zve", "zvE", "zu_versteuerndes_einkommen"),
                "einkommensteuer": _first(bind, "einkommensteuer", "est", "ESt"),
                "solidaritaetszuschlag": _first(bind, "solidaritaetszuschlag",
                                                "soli", "solz"),
                "kirchensteuer": _first(bind, "kirchensteuer", "kist", "KiSt"),
                "gesamtsteuer": _first(bind, "gesamtsteuer", "summe", "total"),
            },
            "abgleich": _first(c, "abgleich", "reconcile", default=None),
            "raw": c,  # vollstaendiger Bescheid bleibt fuer tiefe Asserts erhalten
        })
    return out


# ---------------------------------------------------------------------------
# Mastercase-Polling
# ---------------------------------------------------------------------------

def poll_mastercase(base, case_id, budget_s, interval_s, logf):
    """Pollt /api/mastercase bis status in {ready,error} oder Budget aus."""
    deadline = time.time() + budget_s
    last = None
    while time.time() < deadline:
        try:
            m = _get(base, "/api/mastercase?id=" + urllib.parse.quote(case_id),
                     timeout=30)
            last = m
            st = str(_first(m, "status", default="")).lower()
            logf("  mastercase status=%s" % (st or "?"))
            if st in ("ready", "error", "failed"):
                return m
        except urllib.error.HTTPError as e:
            logf("  mastercase HTTP %s" % e.code)
        except Exception as e:  # noqa: BLE001 — Polling soll robust weiterlaufen
            logf("  mastercase poll err: %s" % e)
        time.sleep(interval_s)
    return last


# ---------------------------------------------------------------------------
# Hauptablauf
# ---------------------------------------------------------------------------

def main(argv):
    ap = argparse.ArgumentParser(
        description="Generischer FRESH-E2E gegen die Steuer-Engine.")
    ap.add_argument("belege", help="Ordner mit Belegen (rekursiv durchsucht)")
    ap.add_argument("vz", type=int, help="Veranlagungszeitraum, z.B. 2024")
    ap.add_argument("caseId", nargs="?", default=None,
                    help="Case-ID (default: <ordnername>-e2e)")
    ap.add_argument("--out", default=None,
                    help="Ziel-JSON (default: /tmp/<caseId>.json)")
    ap.add_argument("--base", default=os.environ.get("CTAX_BASE",
                                                      "http://localhost:7190"),
                    help="Engine-Basis-URL (default http://localhost:7190)")
    ap.add_argument("--timeout-precalc", type=int, default=900,
                    help="Timeout fuer POST /api/steuerfall in s (default 900)")
    ap.add_argument("--poll-budget", type=int, default=600,
                    help="Mastercase-Poll-Budget in s (default 600)")
    ap.add_argument("--poll-interval", type=int, default=6,
                    help="Poll-Intervall in s (default 6)")
    ap.add_argument("--no-poll", action="store_true",
                    help="Mastercase-Polling ueberspringen")
    ap.add_argument("--exclude", action="append", default=[],
                    help="Dateiname-Teilstring zum Ausschliessen (mehrfach)")
    ap.add_argument("--fresh", dest="fresh", action="store_true", default=True,
                    help="fresh:true senden (Standard — kein Cache)")
    ap.add_argument("--no-fresh", dest="fresh", action="store_false",
                    help="fresh:false (Cache erlauben — nur fuer Debug)")
    args = ap.parse_args(argv)

    folder = os.path.abspath(args.belege)
    if not os.path.isdir(folder):
        print("FEHLER: kein Ordner: %s" % folder, file=sys.stderr)
        return 3

    case_id = args.caseId or (os.path.basename(folder.rstrip("/")) + "-e2e")
    out_path = args.out or ("/tmp/%s.json" % case_id)

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    belege = discover_belege(folder, excludes=args.exclude)
    if not belege:
        print("FEHLER: keine Belege in %s" % folder, file=sys.stderr)
        return 3

    log("== case_e2e ==")
    log("  base    : %s" % args.base)
    log("  ordner  : %s" % folder)
    log("  vz      : %s" % args.vz)
    log("  caseId  : %s" % case_id)
    log("  belege  : %d Datei(en)" % len(belege))
    if args.exclude:
        log("  exclude : %s" % ", ".join(args.exclude))

    report = {
        "harness": "case_e2e",
        "version": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "request": {
            "base": args.base,
            "ordner": folder,
            "vz": args.vz,
            "caseId": case_id,
            "fresh": bool(args.fresh),
            "belegPfade": belege,
            "belegAnzahl": len(belege),
            "exclude": list(args.exclude),
        },
    }

    t0 = time.time()
    try:
        payload = {
            "paths": belege,
            "vz": args.vz,
            "caseId": case_id,
            "fresh": bool(args.fresh),
        }
        log("  POST /api/steuerfall (fresh=%s) ..." % bool(args.fresh))
        resp = _post(args.base, "/api/steuerfall", payload, args.timeout_precalc)
        report["precalcSeconds"] = round(time.time() - t0, 1)
        log("  pre-calc ok in %.1fs" % report["precalcSeconds"])

        # Mastercase nachziehen (Hintergrund-Harmonizer)
        mastercase = None
        if not args.no_poll:
            log("  poll /api/mastercase (budget %ds) ..." % args.poll_budget)
            mastercase = poll_mastercase(
                args.base, case_id, args.poll_budget, args.poll_interval, log)
            st = str(_first(mastercase or {}, "status", default="?"))
            log("  mastercase final status=%s" % st)

        report["totalSeconds"] = round(time.time() - t0, 1)

        # --- strukturierte, schluessel-tolerante Sicht ---
        report["meta"] = {
            "ok": _first(resp, "ok", default=None),
            "veranlagungsart": _first(resp, "veranlagungsart",
                                      "veranlagung", default=None),
            "ocrCount": _first(resp, "ocrCount", default=None),
            "lane1Ms": _first(resp, "lane1Ms", default=None),
            "mastercaseStatus": _first(mastercase or {}, "status", default=None),
        }
        report["belege"] = summarize_belege(resp)
        report["calcs"] = summarize_calcs(resp)
        report["warnings"] = _as_list(_first(resp, "warnings", "warnungen",
                                             default=[]))
        report["positionen"] = collect_positions(resp, mastercase)

        # Rohdaten vollstaendig anhaengen — Asserts duerfen tiefer graben,
        # und der Report bleibt ein verlustfreies Audit-Artefakt.
        report["raw"] = {
            "steuerfall": resp,
            "mastercase": mastercase,
        }

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log("  geschrieben: %s" % out_path)
        log("  belege=%d  positionen(eCodes)=%d  calcs=%d  warnings=%d"
            % (len(report["belege"]), len(report["positionen"]),
               len(report["calcs"]), len(report["warnings"])))
        print(out_path)  # stdout = Pfad, fuer Pipelines
        return 0

    except Exception as e:  # noqa: BLE001
        report["error"] = str(e)
        report["traceback"] = traceback.format_exc()
        report["totalSeconds"] = round(time.time() - t0, 1)
        try:
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(report, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        log("FEHLER: %s" % e)
        log(report["traceback"])
        print(out_path)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
