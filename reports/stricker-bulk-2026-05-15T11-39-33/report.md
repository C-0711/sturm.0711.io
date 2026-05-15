# Stricker Bulk E2E — Fehlerreport

**Target:** https://sturm.0711.io
**Started:** 2026-05-15T11:39:33.218Z
**Case-ID:** `stricker-e2e-2026-05-15t11-39-33-2023-mp6uhk5p`
**Fixtures:** 7 Dateien
**Bulk-Upload-Dauer:** 127.8s

## Eingabe-Dateien

| # | Datei | Größe |
|---|---|---|
| 1 | `stricker_4.jpg` | 209.2 KB |
| 2 | `stricker_5.jpg` | 194.9 KB |
| 3 | `stricker_6.jpg` | 240.9 KB |
| 4 | `stricker_7.jpg` | 74.5 KB |
| 5 | `stricker_8.jpg` | 142.4 KB |
| 6 | `stricker_est_2023.pdf` | 2763.9 KB |
| 7 | `stricker_vast.pdf` | 33.7 KB |

## Per-Dokument-Status

Erfolgreich: **6** · Fehlgeschlagen: **1**

| # | Datei | State | Felder | Anlagen | Run-ID | Dauer | Stage-Fehler |
|---|---|---|---|---|---|---|---|
| 0 | `stricker_4.jpg` | ✅ ok | 0 | KAP | `mp6uhl0f-72pk8t` | 69.0s | 0 |
| 1 | `stricker_5.jpg` | ✅ ok | 0 | KAP | `mp6uhl0h-13ma3z` | 69.0s | 0 |
| 2 | `stricker_6.jpg` | ✅ ok | 6 | KAP | `mp6uhl0h-iukru5` | 70.1s | 0 |
| 3 | `stricker_7.jpg` | ✅ ok | 6 | KAP | `mp6uj29s-osjoyd` | 55.2s | 0 |
| 4 | `stricker_8.jpg` | ✅ ok | 0 | KAP | `mp6uj29v-dap2za` | 57.6s | 0 |
| 5 | `stricker_est_2023.pdf` | ❌ error | 0 | — | `mp6uj345-idwhfx` | 20.5s | 1 |
| 6 | `stricker_vast.pdf` | ✅ ok | 21 | N | `mp6ujj0k-qd4vz9` | 34.4s | 0 |

## Case-Level-Aggregat

- **Dokumente:** 7
- **eCodes (merged):** 24
- **Konflikte:** 4
- **Pflicht-Coverage:** 0/0 (0 %, measurable=false)

### BMF Lane-1 Berechnung

| Position | Wert |
|---|---|
| zu versteuerndes Einkommen | 68.025,80 € |
| tarifliche Einkommensteuer | 18.597,86 € |
| Solidaritätszuschlag | 58,02 € |
| festzusetzende Steuer | 18.655,88 € |
| Grenzsteuersatz | 42.00 % |
| ⌀-Steuersatz | 27.34 % |

### Konflikte (4)

| eCode | Drucktext | Anlage | Kandidaten | Sieger |
|---|---|---|---|---|
| `E1900701` | Kapitalerträge | KAP | `-36` (LLM_FSM, stricker_6.jpg)<br>`5.06` (LLM_FSM, stricker_7.jpg) | `-36` |
| `E0107101` | zu versteuerndes Einkommen | ESt1A | `0` (BMF_RECHNER, stricker_6.jpg+stricker_7.jpg)<br>`68025.8` (BMF_RECHNER, stricker_vast.pdf) | `0` |
| `E0107201` | tarifliche Einkommensteuer | ESt1A | `0` (BMF_RECHNER, stricker_6.jpg+stricker_7.jpg)<br>`17968.71` (BMF_RECHNER, stricker_vast.pdf) | `0` |
| `E0107301` | festzusetzende Steuer | ESt1A | `0` (BMF_RECHNER, stricker_6.jpg+stricker_7.jpg)<br>`17968.71` (BMF_RECHNER, stricker_vast.pdf) | `0` |

## Stage-Verlauf pro Dokument

### ✅ stricker_4.jpg

- Run-ID: `mp6uhl0f-72pk8t`
- Felder extrahiert: **0**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 1314 ms |
| `felderKatalog` | ✓ ok | 1 ms |
| `quantumGround` | ✓ ok | 11087 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 8 ms |
| `phase3LlmFill` | ✓ ok | 53811 ms |
| `phase4Disambig` | ✓ ok | 1 ms |
| `phase5Merge` | ✓ ok | 0 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 71 ms |

### ✅ stricker_5.jpg

- Run-ID: `mp6uhl0h-13ma3z`
- Felder extrahiert: **0**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 3 ms |
| `felderKatalog` | ✓ ok | 649 ms |
| `quantumGround` | ✓ ok | 13050 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 1 ms |
| `phase3LlmFill` | ✓ ok | 53812 ms |
| `phase4Disambig` | ✓ ok | 1 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 70 ms |

### ✅ stricker_6.jpg

- Run-ID: `mp6uhl0h-iukru5`
- Felder extrahiert: **6**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 3 ms |
| `felderKatalog` | ✓ ok | 1 ms |
| `quantumGround` | ✓ ok | 11086 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 2 ms |
| `phase3LlmFill` | ✓ ok | 54909 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 57 ms |
| `phase7Validator` | ✓ ok | 9 ms |

### ✅ stricker_7.jpg

- Run-ID: `mp6uj29s-osjoyd`
- Felder extrahiert: **6**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 3 ms |
| `felderKatalog` | ✓ ok | 14 ms |
| `quantumGround` | ✓ ok | 2824 ms |
| `felderNarrow` | ✓ ok | 0 ms |
| `phase1Regex` | ✓ ok | 6 ms |
| `phase3LlmFill` | ✓ ok | 50898 ms |
| `phase4Disambig` | ✓ ok | 1 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 54 ms |
| `phase7Validator` | ✓ ok | 7 ms |

### ✅ stricker_8.jpg

- Run-ID: `mp6uj29v-dap2za`
- Felder extrahiert: **0**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 1 ms |
| `felderKatalog` | ✓ ok | 7 ms |
| `quantumGround` | ✓ ok | 4194 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 6 ms |
| `phase3LlmFill` | ✓ ok | 49174 ms |
| `phase4Disambig` | ✓ ok | 1 ms |
| `phase5Merge` | ✓ ok | 0 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 0 ms |

### ❌ stricker_est_2023.pdf

- Run-ID: `mp6uj345-idwhfx`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":6310,"message":"Phase 3 LLM-Fill: alle 7 Anlage(n) fehlgeschlagen — vLLM chat: vLLM chat 400: {\"error\":{\"message\":\"This model's maximum context length is 8192 tokens. However, you requested`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 6 ms |
| `felderKatalog` | ✓ ok | 7 ms |
| `quantumGround` | ✓ ok | 4433 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 52 ms |
| `phase3LlmFill` | ✗ error | — |

### ✅ stricker_vast.pdf

- Run-ID: `mp6ujj0k-qd4vz9`
- Felder extrahiert: **21**
- Anlagen erkannt: N

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 4 ms |
| `felderKatalog` | ✓ ok | 4 ms |
| `quantumGround` | ✓ ok | 4488 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 6 ms |
| `phase3LlmFill` | ✓ ok | 26654 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 2 ms |
| `phase6BmfRechner` | ✓ ok | 53 ms |
| `phase7Validator` | ✓ ok | 8 ms |
