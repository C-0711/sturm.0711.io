# E2E Anwendungen — Fehlerreport

**Datum:** 2026-05-15T08:17:09.219Z
**Target:** https://sturm.0711.io
**Fixture:** VAST_Belege_Stricker.pdf
**Case-ID:** e2e-2026-05-15t08-17-10-2025-mp6n9bci

## Zusammenfassung

- ✅ OK:   **8**
- ❌ Fail: **0**
- ⏭ Skip: **0**

| # | Schritt | Status | Fehler |
|---|---|---|---|
| 1 | open-anwendungen | ✅ ok |  |
| 2 | open-new-case-modal | ✅ ok |  |
| 3 | create-case | ✅ ok |  |
| 4 | steuerfall-loaded | ✅ ok |  |
| 5 | upload-and-extract | ✅ ok |  |
| 6 | verify-canonical-layer | ✅ ok |  |
| 7 | seal | ✅ ok |  |
| 8 | export | ✅ ok |  |

---

## ✅ Step 1: open-anwendungen
*GET /anwendungen.html*

- **Status:** ok
- **Started:** 2026-05-15T08:17:09.624Z
- **Finished:** 2026-05-15T08:17:10.838Z

### Screenshots

**loaded**

![loaded](./step-01-loaded.png)

### Log

```
[08:17:10] screenshot → step-01-loaded.png
[08:17:10] App-Sections gerendert: 1
```

---

## ✅ Step 2: open-new-case-modal
*Click "Neuer Fall" button*

- **Status:** ok
- **Started:** 2026-05-15T08:17:10.838Z
- **Finished:** 2026-05-15T08:17:10.902Z

### Screenshots

**modal-open**

![modal-open](./step-02-modal-open.png)

### Log

```
[08:17:10] screenshot → step-02-modal-open.png
```

---

## ✅ Step 3: create-case
*Fill modal + submit POST /api/applications/.../instances*

- **Status:** ok
- **Started:** 2026-05-15T08:17:10.902Z
- **Finished:** 2026-05-15T08:17:11.432Z

### Screenshots

**filled**

![filled](./step-03-filled.png)

### Log

```
[08:17:11] screenshot → step-03-filled.png
[08:17:11] POST instances → 201  null
[08:17:11] redirected → https://sturm.0711.io/steuerfall.html?app=steuerfall-est&case=e2e-2026-05-15t08-17-10-2025-mp6n9bci
[08:17:11] caseId fallback aus URL: e2e-2026-05-15t08-17-10-2025-mp6n9bci
```

---

## ✅ Step 4: steuerfall-loaded
*Verify /steuerfall.html rendered with case data*

- **Status:** ok
- **Started:** 2026-05-15T08:17:11.432Z
- **Finished:** 2026-05-15T08:17:11.720Z

### Screenshots

**loaded**

![loaded](./step-04-loaded.png)

### Log

```
[08:17:11] screenshot → step-04-loaded.png
[08:17:11] case-display: E2E 2026-05-15T08:17:10
[08:17:11] case-meta:    e2e-2026-05-15t08-17-10-2025-mp6n9bci · Mandant e2e-test · 2025 · in_bearbeitung
```

---

## ✅ Step 5: upload-and-extract
*Upload VAST_Belege_Stricker.pdf → SSE*

- **Status:** ok
- **Started:** 2026-05-15T08:17:11.720Z
- **Finished:** 2026-05-15T08:17:18.854Z

### Screenshots

**uploading-start**

![uploading-start](./step-05-uploading-start.png)

**after-upload**

![after-upload](./step-05-after-upload.png)

### Log

```
[08:17:11] file selected: /tmp/e2e-1778833031720-VAST_Belege_Stricker.pdf
[08:17:11] screenshot → step-05-uploading-start.png
[08:17:18] screenshot → step-05-after-upload.png
[08:17:18] drop-result: ✓ Extraktion abgeschlossen · 11 Stages
[08:17:18] last events:
[phase3LlmFill] stage_done
[phase4Disambig] stage_start
[phase4Disambig] phase4_start
[phase4Disambig] phase4_done
[phase4Disambig] stage_done
[phase5Merge] stage_start
[phase5Merge] phase5_done
[phase5Merge] stage_done
[phase6BmfRechner] stage_start
[phase6BmfRechner] bmf_rechner_start
[phase6BmfRechner] bmf_rechner_compute
[phase6BmfRechner] bmf_rechner_compute
[phase6BmfRechner] bmf_rechner_compute
[phase6BmfRechner] bmf_rechner_compute
[phase6BmfRechner] bmf_rechner_done
[phase6BmfRechner] stage_done
[phase7Validator] stage_start
[phase7Validator] validator_done
[phase7Validator] stage_done
[·] run_done
```

---

## ✅ Step 6: verify-canonical-layer
*Result table rendered with ≥1 row*

- **Status:** ok
- **Started:** 2026-05-15T08:17:18.854Z
- **Finished:** 2026-05-15T08:17:18.925Z

### Screenshots

**layer**

![layer](./step-06-layer.png)

### Log

```
[08:17:18] screenshot → step-06-layer.png
[08:17:18] layer rows: 9
[08:17:18] layer-sub:  aus Stage: phase6BmfRechner · 20 eCodes · REGEX_3F=16 · BMF_RECHNER=4
[08:17:18] GET /result stats  {"totalFields":20,"byOrigin":{"REGEX_3F":16,"BMF_RECHNER":4}}
```

---

## ✅ Step 7: seal
*Click "Versiegeln" → steuerfall-seal workflow*

- **Status:** ok
- **Started:** 2026-05-15T08:17:18.925Z
- **Finished:** 2026-05-15T08:17:21.519Z

### Screenshots

**after-seal**

![after-seal](./step-07-after-seal.png)

### Log

```
[08:17:18] btn-seal disabled? false
[08:17:18] POST /seal → 200
[08:17:21] screenshot → step-07-after-seal.png
[08:17:21] alerts captured  []
[08:17:21] case-meta after seal: e2e-2026-05-15t08-17-10-2025-mp6n9bci · Mandant e2e-test · 2025 · versiegelt
```

---

## ✅ Step 8: export
*Click "An ELSTER" → Lane-5 MCP (Stub erwartet)*

- **Status:** ok
- **Started:** 2026-05-15T08:17:21.519Z
- **Finished:** 2026-05-15T08:17:23.116Z

### Screenshots

**after-export**

![after-export](./step-08-after-export.png)

### Log

```
[08:17:21] btn-export disabled? false
[08:17:21] POST /export → 503  {"erfolg":false,"reason":"mcp-unavailable"}
[08:17:23] screenshot → step-08-after-export.png
```

---

## Netzwerk-Fehler (Status ≥ 400)

```
[08:17:21] POST https://sturm.0711.io/api/applications/steuerfall-est/instances/e2e-2026-05-15t08-17-10-2025-mp6n9bci/export → 503
  body: {"erfolg":false,"reason":"mcp-unavailable"}
```

## Console (errors + warnings)

```
[08:17:21] ERROR Failed to load resource: the server responded with a status of 503 ()
```