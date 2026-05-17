# Einen Workflow in 0711-STURM bauen

Dieser Guide zeigt dir, wie du einen neuen Workflow von null nach laufend bringst. Alle Code-Schnipsel sind echt — sie zeigen die tatsächlichen APIs der Engine, nicht Spekulation.

**Am Ende dieses Guides** hast du entweder
- selbst einen Workflow geschrieben und registriert, oder
- einen Spec-Text, den du an Claude Code gibst und der dir den Workflow baut.

---

## 0 · Was ist ein Workflow in STURM

Ein Workflow ist ein **gerichteter azyklischer Graph aus Stages**. Stages sind Funktionen mit typisierten Inputs und Outputs. Die Engine übernimmt:

- Topologische Ausführungsreihenfolge (parallele Stages laufen nebenläufig)
- Input-Auflösung via `${stageId.field}`
- SSE-Events an den Browser (`stage_start`, `stage_done`, …)
- Artefakt-Persistenz pro Run unter `runs/<workflow>/<runId>/<stage>/output.json`
- Abbruch bei erstem Fehler — alle nachfolgenden Stages werden als `skipped` markiert

**Du schreibst also nur Stages + eine Workflow-Definition.** Keine HTTP-Handler, kein SSE-Code, kein UI-Code.

---

## 1 · Das Minimal-Beispiel verstehen

`src/workflows/hello-ocr/index.ts` ist 38 Zeilen und läuft durch:

```ts
import { defineWorkflow } from '../../core/workflow.ts';

export const helloOcrWorkflow = defineWorkflow({
  id: 'hello-ocr',
  name: 'Hello OCR',
  description: 'Lädt Bild/PDF, macht Mistral OCR, gibt Plain-Text-Stats zurück.',
  input: {
    type: 'file',
    accept: ['pdf', 'png', 'jpg', 'jpeg', 'webp'],
    maxSizeMb: 20,
  },
  stages: {
    ocr: {
      uses: 'mistral-ocr',
      inputs: {
        filePath: '${input.filePath}',
        filename: '${input.filename}',
      },
    },
    stats: {
      uses: 'text-stats',
      inputs: { text: '${ocr.text}' },
    },
  },
  edges: [
    ['ocr', 'stats'],
  ],
});
```

**Zu lesen als:**

- Input ist eine hochgeladene Datei. Der Server macht daraus ein Objekt `{ filePath, filename, size, mime }` und reicht es als `input` an die Stages.
- Stage `ocr` ruft die generische Stage `mistral-ocr` auf (aus `src/stages/`) mit `filePath` und `filename` aus dem Workflow-Input.
- Stage `stats` ruft `text-stats` auf mit dem `text`-Feld aus dem Output von `ocr`.
- Kanten definieren Reihenfolge. `ocr` läuft zuerst, `stats` danach.

Das ist der ganze Workflow. Der Rest — SSE-Stream, UI-Graph, Artefakte — kommt gratis.

---

## 2 · Schritt für Schritt: ein neuer Workflow

### 2.1 Spec entwerfen

Bevor du Code schreibst, beantworte diese fünf Fragen als Text:

1. **Was ist der Input?** Datei (welche Formate?), Text, JSON?
2. **Was ist der Output?** JSON-Shape — Liste? Objekt mit Feldern? Score?
3. **Welche Stages braucht es?** Liste in Reihenfolge. Pro Stage: Name, was sie tut, was rein/raus geht.
4. **Gibt es parallele Pfade?** Zwei Dinge, die gleichzeitig laufen können?
5. **Gibt es Daten-Assets?** Kataloge, Lookups, Schemas — woher kommen sie?

### 2.2 Ordner anlegen

```
src/workflows/mein-workflow/
  index.ts          # defineWorkflow() + Registrierung der lokalen Stages
  stages/           # Workflow-eigene Stages
    foo.ts
    bar.ts
  data/             # Kataloge, Schemas (nur wenn nötig)
  lib/              # Shared Helpers zwischen den Stages (nur wenn nötig)
```

### 2.3 Eine Stage schreiben

Jede Stage ist eine Funktion, in `defineStage()` eingewickelt. Shape:

```ts
// src/workflows/mein-workflow/stages/foo.ts
import { defineStage } from '../../../core/stage.ts';

interface FooInput {
  text: string;
}

interface FooOutput {
  woerter: string[];
  anzahl: number;
}

interface FooConfig {
  minLength?: number;
}

export const fooStage = defineStage<FooInput, FooOutput, FooConfig>({
  id: 'mein-workflow/foo',     // global eindeutig; "/" als Namespace-Konvention
  name: 'Foo-Stage',
  description: 'Zerlegt Text in Wörter und zählt.',

  async run(input, ctx) {
    const minLen = ctx.config.minLength ?? 0;

    const woerter = input.text
      .split(/\s+/)
      .filter(w => w.length >= minLen);

    ctx.emit('foo_count', { n: woerter.length });
    await ctx.artifacts.write('woerter.json', woerter);

    return { woerter, anzahl: woerter.length };
  },
});
```

**Was dir `ctx` gibt** (aus `src/core/types.ts`):

| Feld | Zweck |
|---|---|
| `ctx.config` | Die `config` aus der Workflow-Definition (stage-spezifisch) |
| `ctx.emit(name, payload)` | Custom-SSE-Event an den Browser |
| `ctx.logger.{debug,info,warn,error}(msg, data)` | Logs, erscheinen auch im SSE-Stream |
| `ctx.artifacts.{write,read,readBuffer,writeBuffer,exists,absolutePath}` | Dateisystem pro Run |
| `ctx.signal` | `AbortSignal` — lange `fetch`-Calls damit abbrechbar machen |
| `ctx.runId`, `ctx.workflowId`, `ctx.stageId` | Identifier |

**Was du NICHT tust:**
- `fs.writeFileSync('/tmp/...')` — nutze `ctx.artifacts`
- Globale Variablen zwischen Runs teilen — jeder Run ist isoliert
- Andere Stages direkt aufrufen — Orchestrierung ist Engine-Sache
- Fehler still schlucken — wirf sie. Der Runner macht daraus `stage_error`.

### 2.4 Workflow-Definition schreiben

```ts
// src/workflows/mein-workflow/index.ts
import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { fooStage } from './stages/foo.ts';

export function registerMeinWorkflowStages(): void {
  registerStage(fooStage);
}

export const meinWorkflow = defineWorkflow({
  id: 'mein-workflow-v1',
  name: 'Mein Workflow',
  description: 'Was er macht, in einem Satz.',
  input: { type: 'file', accept: ['pdf'], maxSizeMb: 20 },
  stages: {
    ocr: {
      uses: 'mistral-ocr',
      inputs: {
        filePath: '${input.filePath}',
        filename: '${input.filename}',
      },
    },
    foo: {
      uses: 'mein-workflow/foo',
      config: { minLength: 3 },
      inputs: { text: '${ocr.text}' },
    },
  },
  edges: [
    ['ocr', 'foo'],
  ],
});
```

### 2.5 Workflow registrieren

In `src/workflows/index.ts`:

```ts
import { registerWorkflow } from '../core/registry.ts';
import { helloOcrWorkflow } from './hello-ocr/index.ts';
import { registerElsterStages, buildElsterWorkflowWithSchema } from './elster/index.ts';
import { registerMeinWorkflowStages, meinWorkflow } from './mein-workflow/index.ts';

export function registerAllWorkflows(): void {
  registerWorkflow(helloOcrWorkflow);
  registerElsterStages();
  registerWorkflow(buildElsterWorkflowWithSchema());
  registerMeinWorkflowStages();
  registerWorkflow(meinWorkflow);
}
```

### 2.6 Laufen lassen

```bash
npx tsc --noEmit        # Typecheck muss grün sein
pm2 restart sturm       # Engine neu laden
pm2 logs sturm --lines 20

# Browser
open https://sturm.0711.io/pipeline.html?workflow=mein-workflow-v1
```

Der Workflow erscheint im Sidebar-Selector. Graph zeichnet sich automatisch aus `stages` und `edges`. Upload + Start → SSE streamt Events in den rechten Drawer.

---

## 3 · Input-Mapping-Syntax

Das ist der einzige „magische" Teil. Die Engine löst diese Templates auf, bevor eine Stage ihren Input bekommt:

| Ausdruck | Löst auf zu |
|---|---|
| `${input.filePath}` | Das `filePath`-Feld des Workflow-Inputs |
| `${input}` | Kompletter Input — nur wenn du alles brauchst |
| `${ocr.text}` | `text`-Feld des Outputs der Stage `ocr` |
| `${ocr.pages.0.markdown}` | Tiefer Zugriff via Punkt-Notation und Array-Index |
| `"literal-wert"` | Wird durchgereicht als String |

**Regel**: Nur Input-Mappings werden aufgelöst, nicht Config-Werte. Config ist statisch, Inputs sind dynamisch.

Spezialfall Multi-Output-Stage: deine Stage-Output-Keys werden mit `.` angesprochen. Wenn Stage `a` `{foo: 1, bar: [2,3]}` liefert, dann funktionieren `${a.foo}`, `${a.bar}`, `${a.bar.0}`.

---

## 4 · Schon verfügbare generische Stages

Aus `src/stages/`:

### `mistral-ocr`

Mistral OCR-API-Call, liefert Markdown + optionale JSON-Annotation.

**Input:** `{ filePath: string, filename: string, schema?: object, schemaName?: string }`
**Output:** `{ model, pages[], text, chars, annotation, ms }`
**Config:** `{ schema?, schemaName?, model? }`

`schema` kannst du entweder statisch in `config` setzen oder dynamisch über `inputs` reinziehen (z. B. aus einer `schema-bau`-Stage).

### `text-stats`

Triviale Textstatistik.

**Input:** `{ text: string }`
**Output:** `{ chars, words, lines, preview }`

**Braucht du eine, die fehlt?** Bau sie entweder workflow-lokal unter `stages/` oder als generische unter `src/stages/` + `src/stages/index.ts` registrieren. Generisch wird sie erst, wenn mindestens zwei Workflows sie nutzen.

---

## 5 · Prompt für Claude Code

Wenn du einen Workflow lieber nicht selbst tippen willst, gib Claude Code die ausgefüllte Spec unten plus diesen Prompt:

> Ich will einen neuen Workflow für 0711-STURM bauen. Die Spec steht unten.
>
> Bitte:
> 1. Lies `src/core/workflow.ts`, `src/core/types.ts`, `src/workflows/hello-ocr/index.ts` und `src/workflows/elster/stages/regel-engine.ts` einmal — das ist das Vokabular.
> 2. Scaffolde `src/workflows/<id>/` mit `index.ts`, `stages/`, ggf. `lib/` und `data/`.
> 3. Implementiere jede Stage gemäß der Spec. Generische Bausteine aus `src/stages/` bevorzugen. Nur wirklich workflow-spezifische Logik lokal.
> 4. Registriere den Workflow in `src/workflows/index.ts`.
> 5. Typecheck grün halten: `npx tsc --noEmit`.
> 6. Ergänze einen Smoke-Test-Absatz in der Stage-Definition-Docstring: mit welchem Input-Beispiel wird das Ergebnis so-und-so aussehen.
> 7. Starte neu: `pm2 restart sturm`. Im Browser `https://sturm.0711.io/pipeline.html?workflow=<id>` — der Graph muss erscheinen.
>
> **Nicht ändern:** `src/core/*`, bestehende `src/stages/*`. Wenn ein generischer Baustein fehlt, frag mich vorher.
>
> **Regeln:** Deutsche Benennung (siehe CLAUDE.md). Keine Case-Daten hartcodieren. Keine Modellnamen in User-facing Strings.

### Spec-Template (ausfüllen, dann an Claude Code)

```markdown
# Workflow: <menschlicher Name>

## Meta
- id: <kebab-case>-v1
- owner: <email>

## Ziel
<ein bis zwei Sätze — was geht rein, was kommt raus, warum>

## Input
- type: file | text | json
- accept: [<ext1>, <ext2>, …]         # nur bei file
- maxSizeMb: 20                       # nur bei file
- schema: <JSON-Schema>               # nur bei json

## Output
- type: json
- shape:
  ```json
  { "ergebnis": "...", "score": 0.0 }
  ```
- Erfolgs-Kriterium: <wann ist ein Run "ok"?>

## Stages

### stage-1-id
- uses: <generische-stage-id oder ./stages/<name>>
- config: { ... }
- inputs:
    feld: ${input.xxx}
- output (erwartet): { ... }
- Warum diese Stage: <Einordnung>

### stage-2-id
…

## Edges
```
stage-1 → stage-2 → stage-3
stage-1 → stage-4                 # parallel zu 2
stage-3, stage-4 → stage-5        # join
```

## Daten-Assets (falls vorhanden)
- <pfad>: <quelle, warum nötig>

## Testfälle
1. <happy path>: <Eingabebeispiel> → <erwartete Ausgabe>
2. <edge case>: <Eingabebeispiel> → <erwartetes Verhalten>
```

---

## 6 · Checkliste vor Go-Live

- [ ] `npx tsc --noEmit` → exit 0
- [ ] Workflow in `src/workflows/index.ts` registriert
- [ ] `pm2 restart sturm && pm2 logs sturm` zeigt neuen Workflow in der Startup-Zeile
- [ ] `curl https://sturm.0711.io/api/workflows/<id>` liefert die Definition
- [ ] `https://sturm.0711.io/pipeline.html?workflow=<id>` zeigt den Graph mit allen Stages im `wartet`-Status
- [ ] Upload + „Workflow starten" → SSE-Events kommen an, Stages laufen durch
- [ ] Artefakte liegen unter `runs/<id>/<runId>/` — `_result.json` mit `state: "ok"`
- [ ] Keine Case-Daten im Code oder in Prompts
- [ ] Keine Modellnamen (Opus, Claude, Mistral) in User-facing Strings

---

## 7 · Anti-Patterns — nicht machen

| Nicht tun | Stattdessen |
|---|---|
| Stage ruft andere Stages auf | Neue Stage oder Workflow-Edge |
| `console.log` in Stages | `ctx.logger.debug/info/warn/error` |
| `fs.writeFileSync('/tmp/…')` | `ctx.artifacts.write(relPath, data)` |
| State zwischen Runs in Modul-Variable | Artefakte oder separater Service |
| Lange Sync-Schleife über alle Items | Stage parallelisiert über mehrere Stages, Engine macht den Rest |
| Harter Retry in der Stage | Stage wirft, User re-triggert den Run (MVP-Pragma) |
| Prompts/Kataloge mit echten Personen-Daten | Nur zur Laufzeit aus Input/Artefakten |

---

## 8 · Wenn was klemmt

- **Typecheck bricht**: meist fehlender Import oder falsche Stage-ID in der Workflow-Def. Die Registry wirft beim Laden eine klare Fehlermeldung mit Stage-ID.
- **Stage startet nicht**: Liste der registrierten Stages steht in `pm2 logs sturm` kurz nach Start. Nicht da? Dann fehlt die `registerStage(...)`-Zeile.
- **Input ist `undefined` in der Stage**: Mapping-Template stimmt nicht — vorherige Stage hat das Feld nicht im Output. Check `runs/<id>/<runId>/<prev-stage>/output.json`.
- **Workflow hängt**: Pipeline hat einen Zyklus. Der Runner wirft beim Start mit Liste der unresolved Stages.
- **Browser zeigt alten Stand**: Hard-Reload (Cmd+Shift+R), Engine nicht restartet oder Browser-Cache.

Alles andere: `pm2 logs sturm --lines 50` + `runs/<workflow>/<latest>/_result.json`.

---

## 9 · Tool-Konsum (P4+)

Stages MÜSSEN externe Werkzeuge über `ctx.tools` konsumieren. Direkter
`process.env`-Zugriff in `src/stages/` oder `src/verticals/` wird von
`npm run lint:no-env` abgelehnt.

```ts
// Richtig:
const llm = ctx.tools.getByRole<LlmHandle>('extraction-llm');
const r = await llm.chatJson(prompt, { schema, signal: ctx.signal });

// Falsch (CI failt):
const r = await fetch(`${process.env.VLLM_URL}/v1/chat/completions`, ...);
```

Neue Werkzeuge werden im Anwendung-Roster (`src/applications/<id>/index.ts`)
deklariert, sobald eine Stage eine neue externe Abhängigkeit braucht. In
Ausnahmefällen (z.B. `STURM_GIT_AUTHOR_NAME` für die Gitchain-Identität)
kann die Zeile mit `// lint-no-env: allow — <Begründung>` markiert werden.
