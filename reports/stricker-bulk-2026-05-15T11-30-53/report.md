# Stricker Bulk E2E — Fehlerreport

**Target:** https://sturm.0711.io
**Started:** 2026-05-15T11:30:53.517Z
**Case-ID:** `stricker-e2e-2026-05-15t11-30-53-2023-mp6u6f6u`
**Fixtures:** 7 Dateien
**Bulk-Upload-Dauer:** 37.3s

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
| 0 | `stricker_4.jpg` | ❌ error | 0 | — | `mp6u6g25-c1zcbl` | 15.5s | 1 |
| 1 | `stricker_5.jpg` | ❌ error | 0 | — | `mp6u6g26-vxfqgn` | 15.5s | 1 |
| 2 | `stricker_6.jpg` | ❌ error | 0 | — | `mp6u6g27-1ue05j` | 15.5s | 1 |
| 3 | `stricker_7.jpg` | ❌ error | 0 | — | `mp6u6s0y-1jc3k7` | 5.7s | 1 |
| 4 | `stricker_8.jpg` | ❌ error | 0 | — | `mp6u6s0z-mvmyt4` | 14.1s | 1 |
| 5 | `stricker_est_2023.pdf` | ❌ error | 0 | — | `mp6u6s0z-fte5w9` | 14.1s | 1 |
| 6 | `stricker_vast.pdf` | ❌ error | 0 | — | `mp6u6wft-e9c1hh` | 14.9s | 1 |

## Case-Level-Aggregat

- **Dokumente:** 7
- **eCodes (merged):** 0
- **Konflikte:** 0
- **Pflicht-Coverage:** 0/0 (0 %, measurable=false)

## Stage-Verlauf pro Dokument

### ❌ stricker_4.jpg

- Run-ID: `mp6u6g25-c1zcbl`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":14,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — fetch failed","docIdx":0,"runId":"mp6u6g25-c1zcbl"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 2 ms |
| `quantumGround` | ✓ ok | 11664 ms |
| `felderNarrow` | ✓ ok | 3 ms |
| `phase1Regex` | ✓ ok | 4 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_5.jpg

- Run-ID: `mp6u6g26-vxfqgn`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":13,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — fetch failed","docIdx":1,"runId":"mp6u6g26-vxfqgn"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 1302 ms |
| `felderKatalog` | ✓ ok | 1 ms |
| `quantumGround` | ✓ ok | 11666 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 1 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_6.jpg

- Run-ID: `mp6u6g27-1ue05j`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":12,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — fetch failed","docIdx":2,"runId":"mp6u6g27-1ue05j"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 661 ms |
| `quantumGround` | ✓ ok | 13631 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 10 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_7.jpg

- Run-ID: `mp6u6s0y-1jc3k7`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":3,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — fetch failed","docIdx":3,"runId":"mp6u6s0y-1jc3k7"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 3 ms |
| `felderKatalog` | ✓ ok | 2 ms |
| `quantumGround` | ✓ ok | 3086 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 8 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_8.jpg

- Run-ID: `mp6u6s0z-mvmyt4`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":4,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — fetch failed","docIdx":4,"runId":"mp6u6s0z-mvmyt4"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 4 ms |
| `felderKatalog` | ✓ ok | 12 ms |
| `quantumGround` | ✓ ok | 8305 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 58 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_est_2023.pdf

- Run-ID: `mp6u6s0z-fte5w9`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":7,"message":"Phase 3 LLM-Fill: alle 7 Anlage(n) fehlgeschlagen — fetch failed","docIdx":5,"runId":"mp6u6s0z-fte5w9"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 10 ms |
| `quantumGround` | ✓ ok | 8303 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 53 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_vast.pdf

- Run-ID: `mp6u6wft-e9c1hh`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":3,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — fetch failed","docIdx":6,"runId":"mp6u6wft-e9c1hh"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 1 ms |
| `felderKatalog` | ✓ ok | 2 ms |
| `quantumGround` | ✓ ok | 4346 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 6 ms |
| `phase3LlmFill` | ✗ error | — |
