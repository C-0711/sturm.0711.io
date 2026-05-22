# Bescheid-Pipeline

Single-arm Polar → Lane-1 → Steuerbescheid in **13-15 s** vom PDF-Meta-Cache, **31 ms** mit Cache-Hit.

## Files

```
~/0711-STURM-polar/
├── scripts/
│   ├── bescheid_pipeline.py            ← Orchestrator (Python)
│   └── hildburg-1sec-machine.ts        ← Polar Tier-1+2 (env-aware: META_DIR, OUTPUT)
└── profiles/
    ├── haubrich-koch-hildburg-2024.json  ← Stammdaten Hildburg
    └── v5-4-smoke-stricker.json          ← Stammdaten Stricker
```

## Usage

```bash
# Cache-Hit-Pfad (31 ms wall-clock)
python3 ~/0711-STURM-polar/scripts/bescheid_pipeline.py \
        --mandant haubrich-koch-hildburg-2024 --year 2024

# Fresh-Polar-Pfad (~13 s wall-clock, ignoriert canonical-Cache)
python3 ~/0711-STURM-polar/scripts/bescheid_pipeline.py \
        --mandant haubrich-koch-hildburg-2024 --year 2024 --force-polar

# Strict-Mode: fail wenn fresh PDFs in inbox/ ohne meta/ stehen
python3 ~/0711-STURM-polar/scripts/bescheid_pipeline.py \
        --mandant <id> --year 2024 --fail-on-fresh
```

## Stages

| # | Stage | Cache | Fresh |
|---|---|---:|---:|
| 1 | input_scan (workspace + inbox scan) | 0.4 ms | 0.4 ms |
| 1b | fresh-PDF audit (Inbox-Hook) | – | 0.1 ms |
| 2 | polar (canonical_layer cache OR Tier-1+2 run) | 5 ms | **13.4 s** |
| 3 | profile (`profiles/<mandant>.json`) | 0.1 ms | 0.1 ms |
| 4 | mandanten_meta (elsterExtract aggregation) | 2.5 ms | 2.5 ms |
| 5 | merge_filter (Union + numeric filter) | 0.3 ms | 0.3 ms |
| 6 | lane1_compute (MCP berechne_vollstaendige_steuer_v2) | 22 ms | 38 ms |
| 7 | render (Markdown + Audit-JSON) | 0.6 ms | 0.9 ms |
| **Σ** | **Wall-Clock** | **31 ms** | **~13.4 s** |

## Output

```
/tmp/bescheid-<mandant>-<year>.md       ← Steuerbescheid-Vorschau (Markdown)
/tmp/bescheid-<mandant>-<year>.json     ← Daten + Audit + Lane-1 Raw-Response
```

## Workspace-Layout (Mandant)

```
~/0711/0711-STURM/workspaces/<mandant>/
├── meta/                          ← OCR'd belege (uuid.json mit classification + kpis)
├── inbox/                         ← fresh PDFs (warten auf Mistral-OCR)
└── canonical-layer.json           ← Polar Tier-1+2 Output (Cache)
```

## Profile-Schema

```json
{
  "mandant": "<id>",
  "veranlagungsjahr": 2024,
  "stammdaten": { "vorname": "...", "verwitwet_seit": "...", "ost_kennzeichen": "0", ... },
  "ecodes": {
    "E0100201": "Nachname",
    "E0100401": "24.11.1935",
    "E0109705": "12.04.2012",
    "E0109704": "ja",
    "...": "..."
  }
}
```

Priorität beim Merge: **Profil** > Mandanten meta/elsterExtract > Polar canonical_layer.

## Status

- ✅ Cache-Hit (31 ms): Polar + Profil + Mandanten meta → Bescheid
- ✅ Fresh-Polar (13.4 s): wenn meta/ vorhanden aber canonical_layer.json fehlt
- ✅ Cross-Mandant: Hildburg + Stricker beide funktional
- ⚠️ Fresh-PDFs: Inbox-Hook erkennt sie, OCR-Integration ist eigenes Projekt
- ⚠️ Lane-1-Trigger-Lücken: §24a, §33b, §10 KV/PV feuern nicht trotz SQL-Migration (Container-Compute-Pfad-Issue, nicht Pipeline)

## Bekannte Bugs

1. **Versorgungsbezug als Aktivlohn**: Lane-1 setzt `bruttolohn = 30.707 €` (E0200801-Wert), ohne den 40 % Versorgungsfreibetrag (~9.726 €) abzuziehen.
2. **vorsorgeaufwendungen_absetzbar = 0**: Polar findet E2003104/E2004003 (KV) und E2004103 (PV), aber `ecode_to_canonical.py` im Lane-1-Container mapped sie nicht. Heutige SQL-Migration ist nicht in den Compute-Pfad reingeladen.
3. **Polar Drucktext-Leak**: Tier-2 schreibt manchmal Drucktext statt Wert in `value` (z. B. `E2001203 = "Zeile 23 bzw. 26 (Krankenversicherung)..."`). 17-29 eCodes pro Run werden vom numeric-Filter gedroppt.

## Validierungs-Run (Hildburg 2024)

```
ZvE 29.441,00 €  →  ESt §32a (Zone 3) 4.245,29 €  →  Erstattung 1.018,94 €
```

**Korrektur-Estimate** wenn Lane-1-Trigger greifen:
```
ZvE-Senkung ≈ 15.305 € (Versorgungsfreibetrag + §33b + §24a + KV/PV + WK-Diff)
neue ESt    ≈     500 €
neue Erstattung ≈ 2.700 €
```
