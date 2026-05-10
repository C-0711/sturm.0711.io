# Workflow: ELSTER — Anlagen-Erkennung & Feldextraktion

## Meta
- id: `elster-v1` (gleicher ID wie Vorgänger → gleiche URL → Replacement)
- owner: christoph@0711.io
- Replacement für den bestehenden `src/workflows/elster/`. Exportnamen
  `registerElsterStages` und `buildElsterWorkflowWithSchema` bleiben erhalten,
  damit `src/workflows/index.ts` unverändert bleibt.

## Ziel
Ein hochgeladenes Steuerdokument (PDF / Bild) läuft durch OCR, wird auf die
35 ELSTER-ESt-2024-Anlagen klassifiziert und pro erkannter Anlage werden die
relevanten Felder (eCodes) gegen den Mistral-Chat extrahiert. Ziel ist ein
**deutlich schnellerer** Lauf als der bisherige `elster-v1`: eine einzige OCR,
Regex-first-Klassifizierung mit LLM nur als Fallback, Extraktion parallelisiert
mit Concurrency 3.

## Input
- type: `file`
- accept: `['pdf', 'png', 'jpg', 'jpeg']`
- maxSizeMb: `50`

## Output
- type: `json`
- shape:
  ```json
  {
    "ocr":             { "model": "...", "pages": 3, "text": "...", "chars": 12345, "ms": 4200 },
    "klassifizierung": { "erkannte_anlagen": ["ESt1A", "N", "KAP"], "regex_hits": { "N": 2 }, "llm_hits": [], "used_llm": false, "ms": 80 },
    "extraktion":      { "per_anlage": { "N": { "values": { "E0200204": "12345,67" }, "filled": 8, "fieldCount": 42 } }, "totalFilled": 23, "ms": 5600 }
  }
  ```
- Erfolgs-Kriterium: alle drei Stages `done`, `klassifizierung.erkannte_anlagen.length >= 1`,
  `extraktion.per_anlage` enthält für jede erkannte Anlage einen Eintrag (auch
  wenn `filled === 0` — das ist kein Fehler, sondern "keine Werte gefunden").

## Stages

### ocr
- uses: `mistral-ocr` (generisch, existiert in `src/stages/`)
- config: keine Overrides nötig
- inputs:
  ```
  filePath: ${input.filePath}
  filename: ${input.filename}
  ```
- output (erwartet): `{ model, pages[], text, chars, annotation, ms }`
- Warum: einmalige OCR, der `text`-Feld wird von beiden nachgelagerten Stages
  als Volltext-Quelle benutzt.

### klassifizierung
- uses: `elster/klassifizierung` (workflow-lokal, neu)
- config:
  ```
  llmFallbackWhen: 'zero-or-one'    // Fallback nur wenn Regex <=1 Treffer
  model: 'mistral-small-latest'
  ```
- inputs:
  ```
  text: ${ocr.text}
  ```
- output: `{ erkannte_anlagen: string[], regex_hits: {...}, llm_hits: [...], used_llm: bool, ms }`
- Warum: Regex-Treffer auf kanonische Drucktexte (z.B. "Anlage N", "Kapitalvermögen")
  ist in 80–90% der Fälle ausreichend und kostet <50 ms. Der LLM-Call
  (`mistral-small-latest` mit JSON-Response und der vollen Anlagen-Liste als
  Enum) läuft nur, wenn Regex schwach war. Großer Speed-Gewinn ggü. LLM-first.

### extraktion
- uses: `elster/extraktion` (workflow-lokal, neu)
- config:
  ```
  concurrency: 3
  model: 'mistral-small-latest'
  maxFieldsPerAnlage: 200    // ESt1A hat 117, Rest kleiner — Grenze nur für Sicherheit
  maxTextChars: 60000
  ```
- inputs:
  ```
  text: ${ocr.text}
  anlagen: ${klassifizierung.erkannte_anlagen}
  ```
- output: `{ per_anlage: { [NAME]: { values: { [eCode]: string|null }, filled, fieldCount, durationMs } }, totalFilled, ms }`
- Warum: der langsame Teil. Parallelisierung über Anlagen bringt linearen
  Speed-up bis zum Rate-Limit. Progress per `ctx.emit('anlage_done', ...)` streamt
  live in den UI-Drawer.

## Edges
```
ocr → klassifizierung → extraktion
```

Keine parallelen Pfade — jede Stage braucht den Output der vorigen.

## Daten-Assets
- `data/anlagen.json` — 35 Anlagen (Name, Pflicht-Flag, Feldzahl). Quelle:
  ELSTER-Jahresdokumentation VZ 2024 (Excel-SpreadsheetML), geparst mit
  `scripts/parse-jahresdokumentation.mjs` im Ursprungs-Repo.
- `data/felder/<NAME>.json` — pro Anlage die vollen Felddefinitionen (eCode,
  Drucktext, Format, Regex, Vordruckzeile, Pflicht-Flag). 35 Dateien, ~2.500
  Feldeinträge insgesamt.

**Keine PII in diesen Dateien** — rein ELSTER-Schema-Metadaten, öffentlich aus
der Jahresdokumentation.

## Testfälle

1. **Happy path — Einkommensteuererklärung mit Anlagen N, KAP, SA**
   - Input: PDF einer gescannten Steuererklärung
   - Erwartet: `erkannte_anlagen ⊇ ["ESt1A", "N", "KAP", "SA"]`,
     `extraktion.per_anlage.N.values.E0200204` ist ein Geldbetrag als String
     (Bruttoarbeitslohn), `used_llm === false` (Regex reicht)

2. **Edge case — fremdes Dokument (kein Steuerformular)**
   - Input: z.B. ERiC-Entwicklerhandbuch (ein PDF ohne Anlagen-Kontext)
   - Erwartet: `klassifizierung.erkannte_anlagen.length` gering/0,
     `used_llm === true` (Regex-Fallback triggert LLM), `extraktion.per_anlage`
     entsprechend leer, kein Fehler — Workflow läuft sauber durch.

3. **Edge case — Mistral API down**
   - Input: beliebig
   - Erwartet: `ocr`-Stage wirft, Workflow stoppt bei `stage_error`,
     `klassifizierung` und `extraktion` als `skipped` markiert.
