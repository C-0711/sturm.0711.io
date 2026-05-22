# ELSTER Inverse Solver — Deterministic eCode Extraction

Pipeline that derives ELSTER eCodes from a German Einkommensteuererklärung PDF
through constraint propagation. No hardcoded ground-truth values — eCodes
emerge from Ratio Math + Spatial Zoning + statutory §§-EStG-Constraints +
Lane 1 BMF calculation verification.

## Architecture — 5 Waves

```
Welle 0   parse_ocr               — token extraction, date preservation,
                                    reference-mask, line-context tracking
Welle 1   Ratio Math              — Soli 5.5%, KiSt 8/9%, KiSt-halb (Konfess.-versch.),
                                    SV-Sätze (RV 9.3%, KV 7.3%, PV 1.5%, ALV 1.3%),
                                    Sum-Triplets, Diff-Triplets, Statutory-Exact
Welle 1.5 Math→Real-eCode-Transfer — PSEUDO_<role> → official ELSTER eCode via
                                    MATH_ROLE_TO_ECODE + atoms-lookup
Welle 2   Spatial Zoning          — per (Anlage, Person)-key zone from math-anchors,
                                    +OCR-fallback zones, case-insensitive
Welle 3   Label-Adjacency Cascade — zone-filtered, word-boundary, multi-line
                                    drucktext-prefix, drucktext-clean string,
                                    kontextPath /A vs /B Person-disambig,
                                    formatRegex with \Q..\E normalization
Welle 4   embeddinggemma Cascade  — FP32 cosine search (cascade tier 4),
                                    threshold 0.55 + anlage-allowlist filter,
                                    candidate disambig
Welle 5   Lane 1 BMF Verifier     — §32a Tarif via PostgreSQL Lane 1 stored
                                    procedures → Erstattung als Coherence-Proof
```

## Result on Stricker 2023

- **56 of 63 fields locked (89% coverage)**
- 17 Convergence-Locks (math + label, confidence 1.0)
- Lane 1 verification: **Erstattung 308,98 €** (BMF-konform=true)

## Files

| File | Purpose |
|---|---|
| `inverse_solver.py` | Main solver (Welle 0-3 + 1.5 + 5) |
| `welle4_cascade.py` | Cascade-search fallback via embeddinggemma-300m |
| `welle4_llm.py` | Alternative: constrained-LLM via Gemma-4 (Ollama JSON schema) |
| `tax_law_constants.py` | Statutory parameters 2023 (§32a Tarif, SV-Sätze, Pauschbeträge) |
| `quality_check.py` | Quality-metrics validator (L0-L6 layers) |
| `elster_extract.py` | Original V1 token-substring-match extractor |

## Dependencies

- Python 3.10+ (stdlib only for solver; numpy optional for quality_check)
- Ollama with `embeddinggemma:latest` model (for Welle 4 cascade)
- Lane 1 BMF Calculator running on port 12010 (PostgreSQL `lane1_bmf_calculator` schema)
- ELSTER atoms.json container (`../Upload/data/atoms.json`)

## Key Constraints — what makes this deterministic

| Constraint | Source | Effect |
|---|---|---|
| Soli/ESt = 5.5% | § 4 SolzG | Locks ESt + Soli pair simultaneously |
| KiSt/ESt = 8/9% | LKiStG | Locks KiSt + ESt, infers Bundesland |
| RV-AN/Brutto = 9.3% | § 158 SGB VI | Locks Brutto + Vorsorge-Anteil |
| Sum(Komp) = Summe-Feld | atoms.json drucktext "Summe..." | Locks Komponenten + Summe |
| Sparer-PB ∈ {1000, 2000} | § 20(9) EStG | Identifies Veranlagungsart |
| IdNr §139b AO mod-11 | gesetzliche Prüfziffer | Validates IdNr |
| IBAN ISO 13616 mod-97 | international | Validates IBAN |
| §32a Tarif 2023 | piecewise polynomial | Lane 1 verifier closes loop |

## Generic — works on any Einkommensteuererklärung 2023+

Stricker.pdf was the test case. The pipeline reads the atoms.json container
+ OCR + statutory constants. No PII or year-specific values are hardcoded.
