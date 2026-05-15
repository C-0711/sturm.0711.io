# Stricker Bulk E2E — Fehlerreport

**Target:** https://sturm.0711.io
**Started:** 2026-05-15T11:25:28.945Z
**Case-ID:** `stricker-e2e-2026-05-15t11-25-28-2023-mp6tzgq3`
**Fixtures:** 7 Dateien
**Bulk-Upload-Dauer:** 35.5s

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

Erfolgreich: **7** · Fehlgeschlagen: **0**

| # | Datei | State | Felder | Anlagen | Run-ID | Dauer | Stage-Fehler |
|---|---|---|---|---|---|---|---|
| 0 | `stricker_4.jpg` | ✅ ok | 0 | KAP | `mp6tzhku-qgp10x` | 15.5s | 0 |
| 1 | `stricker_5.jpg` | ✅ ok | 0 | KAP | `mp6tzhkw-hex82n` | 15.5s | 0 |
| 2 | `stricker_6.jpg` | ✅ ok | 0 | KAP | `mp6tzhkw-wpcnf3` | 15.5s | 0 |
| 3 | `stricker_7.jpg` | ✅ ok | 0 | KAP | `mp6tztl7-viscf1` | 4.3s | 0 |
| 4 | `stricker_8.jpg` | ✅ ok | 0 | KAP | `mp6tztlb-g212l8` | 12.2s | 0 |
| 5 | `stricker_est_2023.pdf` | ✅ ok | 34 | AV, ESt1A, KAP, KAP_I, N, SA, VOR | `mp6tztld-slo7zb` | 12.2s | 0 |
| 6 | `stricker_vast.pdf` | ✅ ok | 20 | N | `mp6tzwwq-yi75nj` | 14.5s | 0 |

## Case-Level-Aggregat

- **Dokumente:** 7
- **eCodes (merged):** 34
- **Konflikte:** 15
- **Pflicht-Coverage:** 2/5 (40 %, measurable=true)

### BMF Lane-1 Berechnung

| Position | Wert |
|---|---|
| zu versteuerndes Einkommen | 62.293,90 € |
| tarifliche Einkommensteuer | 16.191,04 € |
| Solidaritätszuschlag | 0,00 € |
| festzusetzende Steuer | 16.191,04 € |
| Grenzsteuersatz | 41.80 % |
| ⌀-Steuersatz | 25.99 % |

### Konflikte (15)

| eCode | Drucktext | Anlage | Kandidaten | Sieger |
|---|---|---|---|---|
| `E0200201` | Bruttoarbeitslohn | N | `63.559,90` (REGEX_100%, stricker_est_2023.pdf)<br>`69.291,80` (REGEX_3F, stricker_vast.pdf) | `63.559,90` |
| `E0200202` | Bruttoarbeitslohn | N | `63.559,90` (REGEX_100%, stricker_est_2023.pdf)<br>`69.291,80` (REGEX_3F, stricker_vast.pdf) | `63.559,90` |
| `E0200203` | Bruttoarbeitslohn | N | `63.559,90` (REGEX_100%, stricker_est_2023.pdf)<br>`69.291,80` (REGEX_3F, stricker_vast.pdf) | `63.559,90` |
| `E0200204` | Bruttoarbeitslohn | N | `63.559,90` (REGEX_100%, stricker_est_2023.pdf)<br>`69.291,80` (REGEX_3F, stricker_vast.pdf) | `63.559,90` |
| `E0200301` | Lohnsteuer | N | `6.720,00` (REGEX_100%, stricker_est_2023.pdf)<br>`7.532,00` (REGEX_3F, stricker_vast.pdf) | `6.720,00` |
| `E0200302` | Lohnsteuer | N | `6.720,00` (REGEX_100%, stricker_est_2023.pdf)<br>`7.532,00` (REGEX_3F, stricker_vast.pdf) | `6.720,00` |
| `E0200303` | Lohnsteuer | N | `6.720,00` (REGEX_100%, stricker_est_2023.pdf)<br>`7.532,00` (REGEX_3F, stricker_vast.pdf) | `6.720,00` |
| `E0200304` | Lohnsteuer | N | `6.720,00` (REGEX_100%, stricker_est_2023.pdf)<br>`7.532,00` (REGEX_3F, stricker_vast.pdf) | `6.720,00` |
| `E0200501` | Kirchensteuer des Arbeitnehmers | N | `302,37` (REGEX_100%, stricker_est_2023.pdf)<br>`338,94` (REGEX_3F, stricker_vast.pdf) | `302,37` |
| `E0200502` | Kirchensteuer des Arbeitnehmers | N | `302,37` (REGEX_100%, stricker_est_2023.pdf)<br>`338,94` (REGEX_3F, stricker_vast.pdf) | `302,37` |
| `E0200503` | Kirchensteuer des Arbeitnehmers | N | `302,37` (REGEX_100%, stricker_est_2023.pdf)<br>`338,94` (REGEX_3F, stricker_vast.pdf) | `302,37` |
| `E0200504` | Kirchensteuer des Arbeitnehmers | N | `302,37` (REGEX_100%, stricker_est_2023.pdf)<br>`338,94` (REGEX_3F, stricker_vast.pdf) | `302,37` |
| `E0107101` | zu versteuerndes Einkommen | ESt1A | `62293.9` (BMF_RECHNER, stricker_est_2023.pdf)<br>`68025.8` (BMF_RECHNER, stricker_vast.pdf) | `62293.9` |
| `E0107201` | tarifliche Einkommensteuer | ESt1A | `15772.46` (BMF_RECHNER, stricker_est_2023.pdf)<br>`17968.71` (BMF_RECHNER, stricker_vast.pdf) | `15772.46` |
| `E0107301` | festzusetzende Steuer | ESt1A | `15772.46` (BMF_RECHNER, stricker_est_2023.pdf)<br>`17968.71` (BMF_RECHNER, stricker_vast.pdf) | `15772.46` |

### Pflicht-Felder fehlend (3)

| eCode | Drucktext | Anlage Z. | Suggestion |
|---|---|---|---|
| `E0100201` | Name | ESt1A Z.9 | — |
| `E0101104` | Straße (derzeitige Adresse) | ESt1A Z.13 | — |
| `E0100602` | Wohnort | ESt1A Z.16 | — |

## Stage-Verlauf pro Dokument

### ✅ stricker_4.jpg

- Run-ID: `mp6tzhku-qgp10x`
- Felder extrahiert: **0**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 1 ms |
| `quantumGround` | ✓ ok | 11248 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 5 ms |
| `phase3LlmFill` | ✓ ok | 6 ms |
| `phase4Disambig` | ✓ ok | 1 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 93 ms |

### ✅ stricker_5.jpg

- Run-ID: `mp6tzhkw-hex82n`
- Felder extrahiert: **0**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 0 ms |
| `quantumGround` | ✓ ok | 11247 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 1 ms |
| `phase3LlmFill` | ✓ ok | 6 ms |
| `phase4Disambig` | ✓ ok | 1 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 93 ms |

### ✅ stricker_6.jpg

- Run-ID: `mp6tzhkw-wpcnf3`
- Felder extrahiert: **0**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 637 ms |
| `quantumGround` | ✓ ok | 13199 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 10 ms |
| `phase3LlmFill` | ✓ ok | 7 ms |
| `phase4Disambig` | ✓ ok | 1 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 93 ms |

### ✅ stricker_7.jpg

- Run-ID: `mp6tztl7-viscf1`
- Felder extrahiert: **0**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 7 ms |
| `felderKatalog` | ✓ ok | 3 ms |
| `quantumGround` | ✓ ok | 2894 ms |
| `felderNarrow` | ✓ ok | 4 ms |
| `phase1Regex` | ✓ ok | 4 ms |
| `phase3LlmFill` | ✓ ok | 3 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 0 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 0 ms |

### ✅ stricker_8.jpg

- Run-ID: `mp6tztlb-g212l8`
- Felder extrahiert: **0**
- Anlagen erkannt: KAP

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 4 ms |
| `felderKatalog` | ✓ ok | 4 ms |
| `quantumGround` | ✓ ok | 7823 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 53 ms |
| `phase3LlmFill` | ✓ ok | 3 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 0 ms |

### ✅ stricker_est_2023.pdf

- Run-ID: `mp6tztld-slo7zb`
- Felder extrahiert: **34**
- Anlagen erkannt: AV, ESt1A, KAP, KAP_I, N, SA, VOR

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 4 ms |
| `quantumGround` | ✓ ok | 7822 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 51 ms |
| `phase3LlmFill` | ✓ ok | 6 ms |
| `phase4Disambig` | ✓ ok | 3 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 51 ms |
| `phase7Validator` | ✓ ok | 7 ms |

### ✅ stricker_vast.pdf

- Run-ID: `mp6tzwwq-yi75nj`
- Felder extrahiert: **20**
- Anlagen erkannt: N

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 3 ms |
| `quantumGround` | ✓ ok | 4309 ms |
| `felderNarrow` | ✓ ok | 0 ms |
| `phase1Regex` | ✓ ok | 1 ms |
| `phase3LlmFill` | ✓ ok | 2 ms |
| `phase4Disambig` | ✓ ok | 1 ms |
| `phase5Merge` | ✓ ok | 0 ms |
| `phase6BmfRechner` | ✓ ok | 50 ms |
| `phase7Validator` | ✓ ok | 4 ms |
