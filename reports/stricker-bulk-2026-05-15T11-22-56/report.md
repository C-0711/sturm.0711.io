# Stricker Bulk E2E — Fehlerreport

**Target:** https://sturm.0711.io
**Started:** 2026-05-15T11:22:56.167Z
**Case-ID:** `stricker-e2e-2026-05-15t11-22-56-2023-mp6tw6us`
**Fixtures:** 7 Dateien
**Bulk-Upload-Dauer:** 35.1s

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

Erfolgreich: **0** · Fehlgeschlagen: **7**

| # | Datei | State | Felder | Anlagen | Run-ID | Dauer | Stage-Fehler |
|---|---|---|---|---|---|---|---|
| 0 | `stricker_4.jpg` | ❌ running | 0 | — | `mp6tw7q7-0po7zj` | — | 0 |
| 1 | `stricker_5.jpg` | ❌ running | 0 | — | `mp6tw7q7-iw2hq2` | — | 0 |
| 2 | `stricker_6.jpg` | ❌ running | 0 | — | `mp6tw7q7-8wshp5` | — | 0 |
| 3 | `stricker_7.jpg` | ❌ running | 0 | — | `mp6twj99-osg08y` | — | 0 |
| 4 | `stricker_8.jpg` | ❌ running | 0 | — | `mp6twj9a-og4rvk` | — | 0 |
| 5 | `stricker_est_2023.pdf` | ❌ running | 0 | — | `mp6twj9b-ok4fzh` | — | 0 |
| 6 | `stricker_vast.pdf` | ❌ running | 0 | — | `mp6twmry-huc0ll` | — | 0 |

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

### ❌ stricker_4.jpg

- Run-ID: `mp6tw7q7-0po7zj`
- Felder extrahiert: **0**
- Anlagen erkannt: —

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 4 ms |
| `felderKatalog` | ✓ ok | 3 ms |
| `quantumGround` | ✓ ok | 12589 ms |
| `felderNarrow` | ✓ ok | 0 ms |
| `phase1Regex` | ✓ ok | 3 ms |
| `phase3LlmFill` | ✓ ok | 2 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 0 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 0 ms |

### ❌ stricker_5.jpg

- Run-ID: `mp6tw7q7-iw2hq2`
- Felder extrahiert: **0**
- Anlagen erkannt: —

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 0 ms |
| `felderKatalog` | ✓ ok | 3 ms |
| `quantumGround` | ✓ ok | 12174 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 1 ms |
| `phase3LlmFill` | ✓ ok | 1 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 0 ms |

### ❌ stricker_6.jpg

- Run-ID: `mp6tw7q7-8wshp5`
- Felder extrahiert: **0**
- Anlagen erkannt: —

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 4 ms |
| `felderKatalog` | ✓ ok | 4 ms |
| `quantumGround` | ✓ ok | 12804 ms |
| `felderNarrow` | ✓ ok | 0 ms |
| `phase1Regex` | ✓ ok | 7 ms |
| `phase3LlmFill` | ✓ ok | 3 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 0 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 0 ms |

### ❌ stricker_7.jpg

- Run-ID: `mp6twj99-osg08y`
- Felder extrahiert: **0**
- Anlagen erkannt: —

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 6 ms |
| `felderKatalog` | ✓ ok | 2 ms |
| `quantumGround` | ✓ ok | 2844 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 3 ms |
| `phase3LlmFill` | ✓ ok | 3 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 0 ms |

### ❌ stricker_8.jpg

- Run-ID: `mp6twj9a-og4rvk`
- Felder extrahiert: **0**
- Anlagen erkannt: —

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 3 ms |
| `felderKatalog` | ✓ ok | 4 ms |
| `quantumGround` | ✓ ok | 7984 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 52 ms |
| `phase3LlmFill` | ✓ ok | 4 ms |
| `phase4Disambig` | ✓ ok | 2 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 0 ms |
| `phase7Validator` | ✓ ok | 1 ms |

### ❌ stricker_est_2023.pdf

- Run-ID: `mp6twj9b-ok4fzh`
- Felder extrahiert: **0**
- Anlagen erkannt: —

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 4 ms |
| `quantumGround` | ✓ ok | 7981 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 47 ms |
| `phase3LlmFill` | ✓ ok | 7 ms |
| `phase4Disambig` | ✓ ok | 4 ms |
| `phase5Merge` | ✓ ok | 2 ms |
| `phase6BmfRechner` | ✓ ok | 51 ms |
| `phase7Validator` | ✓ ok | 6 ms |

### ❌ stricker_vast.pdf

- Run-ID: `mp6twmry-huc0ll`
- Felder extrahiert: **0**
- Anlagen erkannt: —

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 4 ms |
| `felderKatalog` | ✓ ok | 4 ms |
| `quantumGround` | ✓ ok | 4439 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 7 ms |
| `phase3LlmFill` | ✓ ok | 4 ms |
| `phase4Disambig` | ✓ ok | 0 ms |
| `phase5Merge` | ✓ ok | 1 ms |
| `phase6BmfRechner` | ✓ ok | 25 ms |
| `phase7Validator` | ✓ ok | 2 ms |
