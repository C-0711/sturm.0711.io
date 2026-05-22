#!/usr/bin/env python3
"""
Bescheid-Pipeline — Single-arm Polar → Lane-1 → Steuerbescheid-Vorschau.

Usage:
    python3 bescheid_pipeline.py --mandant haubrich-koch-hildburg-2024 --year 2024
    python3 bescheid_pipeline.py --mandant haubrich-koch-hildburg-2024 --force-polar
    python3 bescheid_pipeline.py --canonical /path/to/canonical-layer.json --profile /path/to/profil.json

Stages:
    1. INPUT-SCAN     : meta/*.json (OCR-Cache) + canonical_layer (Polar T1+T2 Cache)
    2. POLAR-RUN      : (optional) gemma4-mm Tier-1 + Tier-2 wenn cache stale
    3. PROFIL-INJECT  : Stammdaten aus profiles/<mandant>.json
    4. MERGE+FILTER   : Polar ∪ Profil → eCode-Dict, Garbage-Filter für Numerik-eCodes
    5. LANE-1-COMPUTE : MCP berechne_vollstaendige_steuer_v2
    6. RENDER         : Markdown-Bescheid + Audit-JSON

Output:
    /tmp/bescheid-<mandant>-<year>.json
    /tmp/bescheid-<mandant>-<year>.md
"""
import argparse, json, glob, os, re, sys, time, urllib.request, subprocess
from pathlib import Path

# ── Konstanten ──────────────────────────────────────────────────────────────
POLAR_ROOT     = Path(os.environ.get("POLAR_ROOT", "/home/christoph.bertsch/0711-STURM-polar"))
WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", "/home/christoph.bertsch/0711/0711-STURM/workspaces"))
PROFILES_DIR   = POLAR_ROOT / "profiles"
LANE1_MCP      = os.environ.get("LANE1_MCP", "http://localhost:12010/mcp")
LANE1_TOOL     = "berechne_vollstaendige_steuer_v2"

# String-eCodes (Stammdaten, Daten, Religion, Namen) — Lane-1 erlaubt hier Strings
STRING_ECODES = {
    "E0100201","E0100301","E0100081","E0100082","E0100401","E0100402",
    "E0100403","E0100422","E0100601","E0100602","E0100702","E0100009",
    "E0100001","E0101001","E0101002","E0101104","E0101206","E0101301",
    "E0102102","E0102202","E0101201","E0102201","E0109402","E0109705",
    "E0109704","E0242401","E0823201","E0805703","E0200002","E2003904",
}

# ── Util ─────────────────────────────────────────────────────────────────────
def log_stage(name, t_start, **kv):
    dt = (time.time() - t_start) * 1000
    extra = " · ".join(f"{k}={v}" for k,v in kv.items())
    print(f"  [{name:18}] {dt:>8.1f} ms  {extra}", flush=True)
    return dt

def fmt_value(v, ecode):
    s = str(v).strip()
    s = re.sub(r"[€$]|EUR", "", s).strip()
    if ecode in STRING_ECODES: return s
    if s.lower() in ("ja","nein","yes","no","true","false","x"): return s
    if re.match(r"^-?[\d.]+,\d{1,2}$", s): return s
    if re.match(r"^-?\d+\.\d{1,2}$", s):  return s.replace(".",",")
    if re.match(r"^-?\d+$", s): return s
    return None

# ── Stage 1: Input-Scan ──────────────────────────────────────────────────────
def stage_input_scan(mandant, force_polar):
    ws = WORKSPACE_ROOT / mandant
    meta_dir = ws / "meta"
    canonical_cache = ws / "canonical-layer.json"
    # Fallback auf /tmp/hildburg-canonical-layer-v2.json wenn vorhanden
    legacy_cache = Path(f"/tmp/{mandant.split('-')[-2] if '-' in mandant else mandant}-canonical-layer-v2.json")

    if not meta_dir.exists():
        raise SystemExit(f"FATAL: workspace meta dir nicht da: {meta_dir}")

    metas = sorted(meta_dir.glob("*.json"))
    n_belege = len(metas)

    # Inbox: PDFs ohne Meta-Eintrag → fresh-OCR needed
    inbox_dir = ws / "inbox"
    fresh_pdfs = []
    if inbox_dir.exists():
        meta_filenames = set()
        for m in metas:
            try:
                meta_filenames.add(json.load(open(m)).get("originalFilename"))
            except Exception:
                pass
        for pdf in inbox_dir.glob("*.pdf"):
            if pdf.name not in meta_filenames:
                fresh_pdfs.append(pdf)
    cache_path = None
    if canonical_cache.exists() and not force_polar:
        cache_path = canonical_cache
    elif legacy_cache.exists() and not force_polar:
        cache_path = legacy_cache
    return {"meta_dir": meta_dir, "metas": metas, "n_belege": n_belege,
            "canonical_cache": cache_path, "workspace": ws,
            "fresh_pdfs": fresh_pdfs, "inbox": str(inbox_dir) if inbox_dir.exists() else None}

# ── Stage 2: Polar (von Cache oder fresh-run) ────────────────────────────────
def stage_polar(ctx, force_polar):
    if ctx["canonical_cache"] and not force_polar:
        cl = json.load(open(ctx["canonical_cache"])).get("canonical_layer", {})
        return {"source": "cache", "canonical_layer": cl, "path": str(ctx["canonical_cache"])}

    # Run hildburg-1sec-machine.ts via tsx
    runner = POLAR_ROOT / "scripts" / "hildburg-1sec-machine.ts"
    if not runner.exists():
        raise SystemExit(f"FATAL: polar runner fehlt: {runner}")
    out_path = Path(f"/tmp/polar-run-{ctx['workspace'].name}.json")
    cmd = ["npx", "tsx", str(runner)]
    env = {**os.environ,
           "META_DIR": str(ctx["meta_dir"]),
           "OUTPUT": str(out_path),
           # Default auf vLLM-EmbeddingGemma (port 11436) — 13× schneller als Ollama-CPU
           "EMBED_PROVIDER": os.environ.get("EMBED_PROVIDER", "vllm"),
           }
    res = subprocess.run(cmd, cwd=POLAR_ROOT, env=env, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        raise SystemExit(f"polar runner failed:\n{res.stderr[-2000:]}")
    cl = json.load(open(out_path)).get("canonical_layer", {})
    return {"source": "fresh", "canonical_layer": cl, "path": str(out_path)}

# ── Stage 3: Profil-Inject ───────────────────────────────────────────────────
def stage_profile(mandant):
    profile_path = PROFILES_DIR / f"{mandant}.json"
    if not profile_path.exists():
        # Fallback: lokal in /tmp
        profile_path = Path(f"/tmp/profiles/{mandant}.json")
    if not profile_path.exists():
        print(f"  [profil] keine profile/{mandant}.json — skip", flush=True)
        return {"ecodes": {}, "path": None}
    p = json.load(open(profile_path))
    return {"ecodes": p.get("ecodes", {}), "path": str(profile_path), "stammdaten": p.get("stammdaten",{})}

# ── Stage 3b (optional): Mandanten elsterExtract zusammenführen ──────────────
def stage_mandanten_meta(ctx):
    out = {}
    for f in ctx["metas"]:
        d = json.load(open(f))
        for v in d.get("elsterExtract",{}).get("values",[]) or []:
            if isinstance(v, dict) and v.get("elster_code"):
                ec = v["elster_code"]
                val = v.get("value","")
                if val and ec not in out:
                    out[ec] = val
    return out

# ── Stage 4: Merge + Filter ──────────────────────────────────────────────────
def stage_merge(polar_cl, mandanten_eb, profil_ec):
    # Polar canonical_layer → ecode → erste value
    polar_ec = {}
    for ec, entry in polar_cl.items():
        vals = entry.get("values") or []
        if vals:
            v = vals[0] if isinstance(vals[0], dict) else {"value": vals[0]}
            val = v.get("value", "")
            if val:
                polar_ec[ec] = val

    # Priorität: Profil > Mandanten (Stammdaten + Regex) > Polar (Numerik)
    merged = {**polar_ec, **mandanten_eb, **profil_ec}

    # Filter für Lane-1
    cleaned, dropped = {}, []
    for ec, v in merged.items():
        formatted = fmt_value(v, ec)
        if formatted is None or formatted == "":
            dropped.append({"ecode": ec, "value": str(v)[:60]})
        else:
            cleaned[ec] = formatted
    return {"cleaned": cleaned, "dropped": dropped, "polar_n": len(polar_ec),
            "mandanten_n": len(mandanten_eb), "profil_n": len(profil_ec), "union_n": len(merged)}

# ── Stage 5: Lane-1 Compute ──────────────────────────────────────────────────
def stage_lane1(elster_felder, year):
    req = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": LANE1_TOOL,
                   "arguments": {"parameters": {"erklaerungsjahr": year, "elster_felder": elster_felder}}}
    }
    r = urllib.request.Request(LANE1_MCP,
        data=json.dumps(req).encode(),
        headers={"Content-Type":"application/json",
                 "Accept":"application/json, text/event-stream"})
    resp_raw = urllib.request.urlopen(r, timeout=60).read().decode()
    m = re.search(r"^data:\s*(.+)$", resp_raw, re.MULTILINE)
    resp = json.loads(m.group(1)) if m else json.loads(resp_raw)
    if "error" in resp:
        return {"ok": False, "error": resp["error"]}
    content = resp.get("result",{}).get("content",[])
    for c in content:
        if isinstance(c, dict) and c.get("type") == "text":
            return {"ok": True, "result": json.loads(c["text"])}
    return {"ok": False, "error": "kein text-content in response"}

# ── Stage 6: Render ──────────────────────────────────────────────────────────
def render_bescheid(mandant, year, daten, audit, profile_path):
    bd = daten.get("berechnungsdetails", {})
    out = []
    out.append(f"# Steuerbescheid-Vorschau {year} — {mandant}\n")
    out.append(f"*Fall-ID: `{daten.get('fall_id','—')}`*\n")
    out.append(f"*BMF-konform: `{daten.get('bmf_konform', '—')}`*\n")
    if profile_path:
        out.append(f"*Profil: `{profile_path}`*\n")
    out.append(f"\n## Ergebnis\n\n")
    out.append("| Position | Betrag |\n|---|---:|\n")
    out.append(f"| zu versteuerndes Einkommen | **{daten.get('zve',0):,.2f} €** |\n")
    out.append(f"| Einkommensteuer §32a | **{daten.get('einkommensteuer',0):,.2f} €** |\n")
    out.append(f"| Solidaritätszuschlag | {daten.get('solidaritaetszuschlag',0):,.2f} € |\n")
    out.append(f"| Gesamtsteuerschuld | {daten.get('gesamtsteuer',0):,.2f} € |\n")
    out.append(f"| − Vorauszahlungen | {daten.get('steuervorauszahlungen',0):,.2f} € |\n")
    eo = daten.get('erstattung_oder_nachzahlung',0)
    label = "Erstattung" if eo < 0 else "Nachzahlung"
    out.append(f"| **{label}** | **{abs(eo):,.2f} €** |\n")
    out.append(f"| Grenzsteuersatz | {daten.get('grenzsteuersatz',0)*100:.2f} % |\n")
    out.append(f"| Ø-Steuersatz | {daten.get('durchschnittssteuersatz',0)*100:.2f} % |\n")

    out.append(f"\n## Rechenschritte\n\n")
    out.append("| # | §-Schritt | Betrag |\n|---|---|---:|\n")
    for step in bd.get("rechenschritte", []):
        out.append(f"| {step.get('schritt','?')} | {step.get('bezeichnung','?')} | {step.get('wert',0):,.2f} € |\n")

    out.append(f"\n## Eingabe-Aggregation\n\n")
    out.append(f"- Polar Tier-1+2:   {audit['merge']['polar_n']:>3} eCodes\n")
    out.append(f"- Mandanten meta/:  {audit['merge']['mandanten_n']:>3} eCodes\n")
    out.append(f"- Profil-Stammdaten:{audit['merge']['profil_n']:>3} eCodes\n")
    out.append(f"- Union:            {audit['merge']['union_n']:>3} eCodes\n")
    out.append(f"- Lane-1 akzeptiert:{len(audit['lane1_input']):>3} eCodes\n")
    out.append(f"- Gefiltert:        {len(audit['merge']['dropped']):>3} (non-numeric in number-slots)\n")

    fehl = daten.get("fehlende_belege", [])
    if fehl:
        out.append(f"\n## Fehlende Belege\n\n")
        for f in fehl:
            out.append(f"- **{f.get('category')}**: {f.get('betrag')} € — {f.get('begruendung')} ({f.get('legal_reference')})\n")

    out.append(f"\n## Timing\n\n")
    out.append("| Stage | ms |\n|---|---:|\n")
    for k,v in audit["timings"].items():
        out.append(f"| {k} | {v:.1f} |\n")
    out.append(f"| **Σ Wall-Clock** | **{sum(audit['timings'].values()):.1f}** |\n")

    return "".join(out)

# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mandant", required=True)
    ap.add_argument("--year", type=int, default=2024)
    ap.add_argument("--force-polar", action="store_true")
    ap.add_argument("--fail-on-fresh", action="store_true",
                    help="Abort if there are PDFs in inbox/ without meta/-entries")
    ap.add_argument("--out-dir", default="/tmp")
    args = ap.parse_args()

    print(f"\n═══ Bescheid-Pipeline · {args.mandant} · {args.year} ═══\n")
    timings = {}
    t_global = time.time()

    # 1. INPUT
    t = time.time(); ctx = stage_input_scan(args.mandant, args.force_polar)
    timings["input_scan"] = log_stage("input_scan", t, belege=ctx["n_belege"],
                                       cache=bool(ctx["canonical_cache"]),
                                       fresh_pdfs=len(ctx["fresh_pdfs"]))

    # 1b. OCR-Stage (fresh-PDF-Erkennung — Inbox-Hook)
    if ctx["fresh_pdfs"]:
        print(f"\n  ⚠ {len(ctx['fresh_pdfs'])} PDF(s) im inbox/ ohne meta/-Eintrag:")
        for pdf in ctx["fresh_pdfs"][:6]:
            print(f"      • {pdf.name}")
        if len(ctx["fresh_pdfs"]) > 6:
            print(f"      … +{len(ctx['fresh_pdfs'])-6} weitere")
        print(f"      → diese PDFs brauchen Mistral-OCR + Klassifizierung "
              f"(noch nicht in dieser Pipeline; nutze mandanten-v5_4 upload-bulk)")
        if args.fail_on_fresh:
            raise SystemExit(f"FATAL: {len(ctx['fresh_pdfs'])} fresh PDFs (--fail-on-fresh)")
        print()

    # 2. POLAR
    t = time.time(); polar = stage_polar(ctx, args.force_polar)
    timings["polar"] = log_stage("polar", t, source=polar["source"], ecodes=len(polar["canonical_layer"]))

    # 3a. PROFIL
    t = time.time(); profil = stage_profile(args.mandant)
    timings["profile"] = log_stage("profile", t, ecodes=len(profil["ecodes"]))

    # 3b. MANDANTEN-Meta (optional)
    t = time.time(); mandanten = stage_mandanten_meta(ctx)
    timings["mandanten_meta"] = log_stage("mandanten_meta", t, ecodes=len(mandanten))

    # 4. MERGE+FILTER
    t = time.time(); merge = stage_merge(polar["canonical_layer"], mandanten, profil["ecodes"])
    timings["merge_filter"] = log_stage("merge_filter", t,
        union=merge["union_n"], cleaned=len(merge["cleaned"]), dropped=len(merge["dropped"]))

    # 5. LANE-1 Compute
    t = time.time(); l1 = stage_lane1(merge["cleaned"], args.year)
    timings["lane1_compute"] = log_stage("lane1_compute", t, ok=l1["ok"])
    if not l1["ok"]:
        print(f"\n✗ Lane-1 ERROR: {json.dumps(l1['error'], ensure_ascii=False)[:500]}")
        sys.exit(2)

    # 6. RENDER
    t = time.time()
    daten = l1["result"].get("daten", {})
    audit = {"merge": merge, "profil_path": profil.get("path"),
             "lane1_input": merge["cleaned"], "timings": timings}
    md = render_bescheid(args.mandant, args.year, daten, audit, profil.get("path"))
    out_md   = Path(args.out_dir) / f"bescheid-{args.mandant}-{args.year}.md"
    out_json = Path(args.out_dir) / f"bescheid-{args.mandant}-{args.year}.json"
    out_md.write_text(md)
    out_json.write_text(json.dumps({"daten": daten, "audit": audit, "lane1_raw": l1["result"]},
                                    ensure_ascii=False, indent=2))
    timings["render"] = log_stage("render", t, md=str(out_md))

    total_ms = (time.time() - t_global) * 1000
    print(f"\n═══ Σ Wall-Clock: {total_ms:>7.1f} ms ═══")
    print(f"\n  Ergebnis: ZvE {daten.get('zve',0):,.2f} € → ESt {daten.get('einkommensteuer',0):,.2f} € → "
          f"{'Erstattung' if daten.get('erstattung_oder_nachzahlung',0)<0 else 'Nachzahlung'} "
          f"{abs(daten.get('erstattung_oder_nachzahlung',0)):,.2f} €")
    print(f"\n  Output: {out_md}")
    print(f"          {out_json}")

if __name__ == "__main__":
    main()
