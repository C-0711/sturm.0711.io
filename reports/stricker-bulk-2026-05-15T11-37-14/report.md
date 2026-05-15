# Stricker Bulk E2E — Fehlerreport

**Target:** https://sturm.0711.io
**Started:** 2026-05-15T11:37:14.131Z
**Case-ID:** `stricker-e2e-2026-05-15t11-37-14-2023-mp6uekw4`
**Fixtures:** 7 Dateien
**Bulk-Upload-Dauer:** 41.2s

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
| 0 | `stricker_4.jpg` | ❌ error | 0 | — | `mp6uelqx-dz6fay` | 18.3s | 1 |
| 1 | `stricker_5.jpg` | ❌ error | 0 | — | `mp6uelqx-2z8brn` | 18.3s | 1 |
| 2 | `stricker_6.jpg` | ❌ error | 0 | — | `mp6uelqy-mrgi0t` | 18.3s | 1 |
| 3 | `stricker_7.jpg` | ❌ error | 0 | — | `mp6uezw3-xdacbq` | 13.5s | 1 |
| 4 | `stricker_8.jpg` | ❌ error | 0 | — | `mp6uezw4-klfvoq` | 14.0s | 1 |
| 5 | `stricker_est_2023.pdf` | ❌ error | 0 | — | `mp6uezw4-baaz2m` | 20.1s | 1 |
| 6 | `stricker_vast.pdf` | ❌ error | 0 | — | `mp6ufaan-irhyxd` | 8.2s | 1 |

## Case-Level-Aggregat

- **Dokumente:** 7
- **eCodes (merged):** 0
- **Konflikte:** 0
- **Pflicht-Coverage:** 0/0 (0 %, measurable=false)

## Stage-Verlauf pro Dokument

### ❌ stricker_4.jpg

- Run-ID: `mp6uelqx-dz6fay`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":1522,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — vLLM stream: fetch failed (nach 3 Versuchen)","docIdx":0,"runId":"mp6uelqx-dz6fay"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 1 ms |
| `quantumGround` | ✓ ok | 13133 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 9 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_5.jpg

- Run-ID: `mp6uelqx-2z8brn`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":1519,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — vLLM stream: fetch failed (nach 3 Versuchen)","docIdx":1,"runId":"mp6uelqx-2z8brn"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 4 ms |
| `felderKatalog` | ✓ ok | 679 ms |
| `quantumGround` | ✓ ok | 15111 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 1 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_6.jpg

- Run-ID: `mp6uelqy-mrgi0t`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":1514,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — vLLM stream: fetch failed (nach 3 Versuchen)","docIdx":2,"runId":"mp6uelqy-mrgi0t"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 5 ms |
| `felderKatalog` | ✓ ok | 1 ms |
| `quantumGround` | ✓ ok | 13134 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 2 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_7.jpg

- Run-ID: `mp6uezw3-xdacbq`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":9101,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — vLLM stream: fetch failed (nach 3 Versuchen)","docIdx":3,"runId":"mp6uezw3-xdacbq"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 6 ms |
| `felderKatalog` | ✓ ok | 3 ms |
| `quantumGround` | ✓ ok | 2960 ms |
| `felderNarrow` | ✓ ok | 3 ms |
| `phase1Regex` | ✓ ok | 13 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_8.jpg

- Run-ID: `mp6uezw4-klfvoq`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":1505,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — vLLM stream: fetch failed (nach 3 Versuchen)","docIdx":4,"runId":"mp6uezw4-klfvoq"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 5 ms |
| `felderKatalog` | ✓ ok | 13 ms |
| `quantumGround` | ✓ ok | 8115 ms |
| `felderNarrow` | ✓ ok | 2 ms |
| `phase1Regex` | ✓ ok | 57 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_est_2023.pdf

- Run-ID: `mp6uezw4-baaz2m`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":7634,"message":"Phase 3 LLM-Fill: alle 7 Anlage(n) fehlgeschlagen — vLLM stream: fetch failed (nach 3 Versuchen)","docIdx":5,"runId":"mp6uezw4-baaz2m"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 2 ms |
| `felderKatalog` | ✓ ok | 6 ms |
| `quantumGround` | ✓ ok | 8104 ms |
| `felderNarrow` | ✓ ok | 1 ms |
| `phase1Regex` | ✓ ok | 51 ms |
| `phase3LlmFill` | ✗ error | — |

### ❌ stricker_vast.pdf

- Run-ID: `mp6ufaan-irhyxd`
- Felder extrahiert: **0**
- Anlagen erkannt: —

**Fehler:**
- Stage `phase3LlmFill`: `{"ms":1505,"message":"Phase 3 LLM-Fill: alle 1 Anlage(n) fehlgeschlagen — vLLM stream: fetch failed (nach 3 Versuchen)","docIdx":6,"runId":"mp6ufaan-irhyxd"}`

| Stage | State | Dauer |
|---|---|---|
| `klassifizierung` | ✓ ok | 5 ms |
| `felderKatalog` | ✓ ok | 4 ms |
| `quantumGround` | ✓ ok | 4378 ms |
| `felderNarrow` | ✓ ok | 0 ms |
| `phase1Regex` | ✓ ok | 6 ms |
| `phase3LlmFill` | ✗ error | — |
