# 0711-STURM — Workflow Template Guide

> **Zweck**: Dieses Dokument ist eine **Spec-Vorlage**. Du füllst sie aus, gibst sie Claude Code, und Claude baut daraus einen neuen Workflow in `src/workflows/<workflow-id>/`.
>
> **Philosophie**: Workflows sind Daten + Stages. Die Engine (Runner, SSE, UI) ist fertig — du beschreibst nur, *was* passieren soll, nicht *wie* die Infrastruktur tickt.

---

## 0 · Vor dem Ausfüllen

Lies diese drei Dateien einmal, damit du Vokabular und verfügbare Bausteine kennst:

- `src/core/workflow.ts` — `defineWorkflow()`-Shape
- `src/core/stage.ts` — `Stage<TIn, TOut>`-Interface
- `src/stages/README.md` — Liste der generischen Stages (`mistral-ocr`, `claude-chat`, `ollama-chat`, `json-schema-validate`, `regex-label-match`, `merge`, `persist`)

Wenn eine Stage fehlt, die du brauchst, baust du sie workflow-lokal (`src/workflows/<id>/stages/`) — und wenn sie sich später als wiederverwendbar zeigt, promotest du sie nach `src/stages/`.

---

## 1 · Spec-Template (kopieren & ausfüllen)

```markdown
# Workflow: <human-lesbarer Name>

## Meta
- **id**: <kebab-case>-v1              # wird URL-Slug
- **version**: 1.0.0
- **owner**: <email>
- **tags**: [ocr, extract, …]

## Ziel (1–2 Sätze)
<Was macht der Workflow? Wofür ist das Ergebnis?>

## Input
- **type**: file | text | json | url
- **accept**: [pdf, png, …]             # nur bei file
- **max_size_mb**: 20
- **schema**:                           # nur bei json
  ```json
  { "type": "object", "properties": { … } }
  ```

## Output
- **type**: json
- **schema**:
  ```json
  { "type": "object", "properties": { … } }
  ```
- **Was ist "erfolgreich"?**
  <Kriterium, z.B. "alle Pflichtfelder belegt, Bewertung > 0.8">

## Stages

### stage-1-id
- **uses**: mistral-ocr                 # generisch, oder workflow-lokal via ./stages/foo
- **config**:
  ```ts
  { schema: 'permissiv', model: 'mistral-ocr-latest' }
  ```
- **inputs**:
  - `file`: `${input.file}`
- **output**: `{ text: string, annotation: object, pages: number }`
- **events**: `stage_start`, `stage_done` (automatisch), `ocr_progress` (optional)
- **fehlerverhalten**: fail-fast | skip | default-value

### stage-2-id
- **uses**: ./stages/meine-regel-engine
- **inputs**:
  - `text`: `${stage-1-id.text}`
- **output**: `{ eindeutig: [], konflikte: [] }`

### stage-n-id
…

## Edges (Reihenfolge + Parallelität)
```
stage-1 → stage-2 → stage-3
stage-1 → stage-4          # parallel zu 2
stage-3, stage-4 → stage-5 # join
```

## Daten-Assets
- **kataloge**: `data/xxx.json` (1.2 MB, aus <Quelle> via `scripts/build_xxx.py`)
- **lookups**: `data/aliase.json`
- **prompts**: inline in Stage-Config oder `prompts/<stage>.md`

## Validierung / Bewertung (optional)
- **strategie**: workflow-lokale Funktion `evaluate(output) → { score, reasons }`
- **schwelle_ok**: 0.8
- **metriken**: vollständigkeit, konsistenz, bmf-pflichterfüllung, …

## UI-Hinweise (optional — nur falls vom Default abweichend)
- **stage-farben**: default (wartet=grau, läuft=blau, ok=grün, fehler=rot)
- **custom-details-view**: `ui/stage-views/<stage-id>.tsx` (falls JSON-Dump nicht reicht)

## Test-Fälle
Mind. 2 Test-Fälle unter `test-data/<workflow-id>/`:
1. **happy-path**: <Beschreibung + Erwartung>
2. **edge-case**: <z.B. leeres Dokument, fehlende Seiten, Rotation>
```

---

## 2 · Prompt an Claude Code

Nachdem das Template ausgefüllt ist, nutze diesen Prompt:

> Ich will einen neuen Workflow für 0711-STURM bauen. Die Spec liegt unter `docs/specs/<workflow-id>.md`.
>
> Bitte:
> 1. Lies die Spec **und** `src/core/workflow.ts`, `src/core/stage.ts`, `src/stages/README.md` sowie einen existierenden Workflow (`src/workflows/hello-ocr/`) als Referenz.
> 2. Scaffolde `src/workflows/<workflow-id>/` mit `index.ts`, `stages/` (falls workflow-lokale Stages), `data/`, `README.md`.
> 3. Implementiere alle Stages. Generische Bausteine aus `src/stages/` bevorzugen — nur wirklich workflow-spezifische Logik lokal.
> 4. Registriere den Workflow in `src/workflows/index.ts`.
> 5. Lege Test-Fälle unter `test-data/<workflow-id>/` an (kopieren aus Spec-Beispielen) und schreibe einen Smoke-Test, der den Workflow end-to-end durchläuft.
> 6. Starte den Server neu (`pm2 restart sturm`) und verifiziere im Browser, dass der neue Workflow in pipeline.html im Selector erscheint und durchläuft.
>
> **Nicht ändern**: `src/core/*`, `src/stages/*` (außer mit explizitem Okay). Stages nur hinzufügen, nicht bestehende anfassen.
>
> **Stil**: Deutsche Benennung gemäß cb-ctax-`KODIERRICHTLINIE.md`. Keine Modellnamen in User-facing Strings.

---

## 3 · Stage-Contract (für workflow-lokale Stages)

Jede Stage ist eine Funktion mit festem Shape:

```ts
import { Stage } from '../../../core/stage'

export const meineStage: Stage<{ text: string }, { treffer: string[] }> = {
  id: 'meine-stage',
  name: 'Meine Stage',
  description: 'Was sie tut, ein Satz',

  async run(input, ctx) {
    ctx.emit('custom_event', { info: '…' })
    ctx.logger.debug('…')

    const treffer = …

    await ctx.artifacts.write('treffer.json', treffer)

    return { treffer }
  }
}
```

**Der Context (`ctx`) gibt dir:**
- `emit(event, payload)` → SSE an den Browser
- `logger` → strukturierte Logs, landen im Run-Ordner
- `artifacts` → `read(path)`, `write(path, data)` pro Run persistent
- `config` → die Stage-Config aus der Workflow-Definition
- `runId`, `workflowId`, `stageId` → Kontext-IDs
- `signal` → AbortSignal für Cancellation

**Regeln:**
- Stages sind **pure bezüglich externer Seiten-Effekte außer**: SSE (via `ctx.emit`), Artefakte (via `ctx.artifacts`), Logs. Kein direkter `fs.writeFileSync` oder DB-Write.
- Input wird von der Engine aus den `inputs`-Mappings gefüllt — Stages lesen ihn als fertiges Objekt.
- Fehler werden **geworfen**, nicht stumm zurückgegeben. Der Runner fängt sie und emittet `stage_error`.
- Stages dürfen **keine anderen Stages aufrufen** — Orchestrierung ist Engine-Sache.

---

## 4 · Mini-Beispiel: "hello-ocr"

Kleinstmöglicher Workflow, der als Template und Smoke-Test dient:

```ts
// src/workflows/hello-ocr/index.ts
import { defineWorkflow } from '../../core/workflow'

export default defineWorkflow({
  id: 'hello-ocr',
  name: 'Hello OCR',
  description: 'Lädt Bild/PDF, macht Mistral OCR, gibt Plain-Text zurück.',
  input: { type: 'file', accept: ['pdf', 'png', 'jpg'] },
  output: { type: 'json', schema: { type: 'object', properties: { text: { type: 'string' }, chars: { type: 'number' } } } },
  stages: {
    'ocr': {
      uses: 'mistral-ocr',
      config: { schema: 'text-only' },
      inputs: { file: '${input.file}' }
    },
    'stats': {
      uses: 'text-stats',
      inputs: { text: '${ocr.text}' }
    }
  },
  edges: [['ocr', 'stats']]
})
```

Das ist **der ganze Workflow**. Der Graph in der UI, der SSE-Stream, das Artefakt-Pro-Run-Verzeichnis, der Event-Log — alles gratis aus der Engine.

---

## 5 · Checkliste vor dem Go-Live eines Workflows

- [ ] `src/workflows/<id>/index.ts` registriert in `src/workflows/index.ts`
- [ ] `README.md` im Workflow-Ordner erklärt Input/Output/Stages
- [ ] Test-Fälle in `test-data/<id>/` mit mindestens happy-path + 1 edge-case
- [ ] Smoke-Test lief lokal durch, Artefakte sehen gut aus
- [ ] pipeline.html zeigt den Workflow im Selector, Graph rendert, Events kommen an
- [ ] Kein Hartcoding von Case-Daten, API-Keys nur via `.env`
- [ ] Kein Modellname in User-facing Strings
- [ ] Bei Elster-verwandten Workflows: ELSTER-Codes aus Katalog, nicht erfunden

---

## 6 · Was NICHT in einen Workflow gehört

- **State über Runs hinweg**: Workflows sind zustandslos. Wenn du was merken musst, ist das ein separater Service.
- **Lange Hintergrund-Jobs**: Ein Workflow-Run soll in Minuten laufen, nicht Stunden. Für Stunden-Jobs: eigener Job-Runner, Workflow triggert ihn nur.
- **User-Management, Billing, Auth**: alles außerhalb der Engine.
- **Geheimnisse in der Spec**: keine API-Keys, keine User-Daten in der Markdown-Spec. Nur Referenzen auf `.env`-Variablen.

---

## 7 · Nächster Schritt

Wenn du bereit bist:

1. Kopiere Abschnitt 1 in `docs/specs/<mein-workflow>.md`
2. Fülle die Spec aus
3. Sende den Prompt aus Abschnitt 2 an Claude Code
4. Review den Diff, starte den Smoke-Test, merge
