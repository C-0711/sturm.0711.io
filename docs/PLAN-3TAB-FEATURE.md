# 0711-STURM — Umsetzungsplan: 3-Tab-Feature

> Tab 1 Steuerfall-Übersicht · Tab 2 Kurator-Chat · Tab 3 ReactFlow-Prozessansicht (per Switch tauschbar). Generiert 2026-06-02 aus Recon-Workflow (6 Leser + 1 Synthese).

## Umsetzungsplan

I now have all the grounding I need. The recon reports are accurate on every line number I checked. Let me write the implementation plan.

# Umsetzungsplan: 3-Tab-Feature in `src/ui/steuerfall.html`

Read-only Recon abgeschlossen, alle Pfad:Zeile-Angaben gegen den echten Code verifiziert (`steuerfall.html`, `core/runner.ts`, `core/events.ts`, `server.ts`, `core/tools/resolvers/llm.ts`). Keine Personendaten zitiert.

---

## 0. Architektur-Grundsatzentscheidung (vorab, weil sie alles andere prägt)

Die zentrale, durch zwei unabhängige Recons (run-transparenz, reactflow, endpunkte, live-sse) **deckungsgleich belegte** Wahrheit:

> **Case-Runs persistieren keine Event-Historie.** `server.ts:477` ruft `runWorkflow(def, { runsDir, input, appId })` **ohne `onEvent`** auf (verifiziert: RunOptions.onEvent ist optional, `runner.ts:75`; der Subscribe-Hook `runner.ts:101-103` greift nur wenn gesetzt). Der `EventBus` ist reines In-Memory-Pub/Sub ohne Backlog (`events.ts:16-19, 31-33`). Auf Platte landen nur `_meta.json`, `<stageId>/output.json` (sanitisiert, `runner.ts:204`) und `_result.json` (`runner.ts:229`). **`_result.json` hat KEIN `events`-Feld** (reactflow-Recon hat das frischeste echte File geparst).

Daraus folgt die Phasenstrategie:

- **Tab 2 zerfällt in zwei Realitätsebenen.** Timing + Output + Fehler pro Stage sind **sofort** (read-only) baubar. Prompts, LLM-Roh-Antworten, externe Request/Response-Paare, Stage-Inputs und der **zeitliche Ablauf** sind **heute nirgends persistiert** und erfordern **Backend-Instrumentierung** (Runner + Tool-Layer), bevor sie für abgeschlossene Runs angezeigt werden können.
- **Empfohlener Schnitt:** Tab 2 wird in **Phase A** als Replay aus vorhandenen Artefakten gebaut (Timing/Output/Fehler) **und** kann gleichzeitig **live** animieren, indem es sich an denselben Upload-SSE-Stream hängt, den Tab 1 schon konsumiert (`steuerfall.html:1016-1066`). In **Phase B** wird die Trace-Persistenz nachgerüstet, wodurch Prompts/externe Calls sowohl live als auch im Replay erscheinen.

---

## 1. Tab-Konzept

### Mount-Punkt (konkret, mit Zeilennummern)

`steuerfall.html` ist Vanilla, ein einziger `<script>`-IIFE (`595–1650`). Der mittlere Bereich ist `.fall-wrap` (`497–590`, `max-width:960px` → `:12`).

**Tab-Leiste einfügen:** nach `.fall-head` (Ende `:511`), vor `<section class="panel">Belege hochladen` (`:513`). Also Insertion zwischen Zeile 511 und 513.

```html
<!-- nach :511 -->
<div class="fall-tabs" role="tablist">
  <button class="fall-tab is-active" role="tab" data-tab="overview" aria-selected="true">
    <i data-lucide="layout-dashboard"></i><span>Steuerfall-Übersicht</span>
  </button>
  <button class="fall-tab" role="tab" data-tab="slotA" aria-selected="false">
    <i data-lucide="git-fork"></i><span id="tab-slotA-label">Prozessansicht</span>
  </button>
  <button class="fall-tab" role="tab" data-tab="slotB" aria-selected="false">
    <i data-lucide="messages-square"></i><span id="tab-slotB-label">Kurator-Chat</span>
  </button>
  <!-- Swap-Switch rechtsbündig -->
  <label class="sturm-toggle-row" id="swap-row" style="margin-left:auto;" title="Chat ↔ Prozessansicht tauschen">
    <span class="sturm-toggle-lbl">Tabs tauschen</span>
    <span class="sturm-toggle" id="swap-toggle"><span class="sturm-toggle-knob"></span></span>
  </label>
</div>
```

### Panes

- **Tab 1 (Übersicht, unverändert):** die bestehenden Sections `513–589` (Belege-Upload, Gesamterklärung, Live-Events, Versiegelung, Run-Historie, Layer-Tabelle) werden gemeinsam in `<div id="pane-overview" class="fall-pane">…</div>` gehüllt. **Kein Eingriff in deren Inhalt/Logik** — nur ein Wrapper-`<div>` um `:513` (öffnen) und nach `:589` (schließen). Das Run-Detail-Modal `#run-detail` (`570–572`, fixed Overlay) bleibt unangetastet an Ort.
- **Slot A / Slot B (= Tab 2/3):** zwei neue, initial `hidden` Container, eingefügt **nach `:589`, vor `</div>` der `.fall-wrap` (`:590`)**:
  ```html
  <div id="pane-slotA" class="fall-pane" hidden></div>
  <div id="pane-slotB" class="fall-pane" hidden></div>
  ```
  Wichtig: Die Begriffe „Slot A/B" sind bewusst **nicht** „Flow/Chat" — denn welcher Slot was zeigt, entscheidet der Swap-Switch (siehe unten). Tab-2-Pane und Tab-3-Pane sind also die *Positionen*, der **Inhalt** (Flow-Insel `#flow-mount`, Chat-Root `#kurator-mount`) wandert dazwischen.

### Swap-Switch — exakte Mechanik

Reine Vanilla-State-Logik, **kein Backend**. Zwei DOM-Subtrees existieren persistent: `#flow-mount` (ReactFlow-Insel) und `#kurator-mount` (Chat). Der Switch entscheidet via `appendChild`, in welchen Pane-Container welcher Subtree gehängt wird — **nicht** zerstört/neu gemountet (reactflow-Recon §4: „Container-Divs verschieben statt zerstören → kein Re-Mount der React-Root").

```js
const SWAP_KEY = 'sturm-steuerfall-tabswap-' + APP_ID;   // pro App persistiert
let swapped = localStorage.getItem(SWAP_KEY) === '1';

function applySwap() {
  const flowHost = swapped ? slotB : slotA;   // slotA/slotB = die Pane-Divs
  const chatHost = swapped ? slotA : slotB;
  flowHost.appendChild(flowMount);
  chatHost.appendChild(kuratorMount);
  // Tab-Labels mitführen, damit der Reiter zeigt was drin ist:
  document.getElementById('tab-slotA-label').textContent = swapped ? 'Kurator-Chat' : 'Prozessansicht';
  document.getElementById('tab-slotB-label').textContent = swapped ? 'Prozessansicht' : 'Kurator-Chat';
  swapToggle.classList.toggle('is-on', swapped);
}
```

- **Persistenz:** `localStorage[SWAP_KEY]`, pro App-ID gekeyt (analog zum existierenden `sturm-token`-Muster aus `nav.js:22-33` und dem Theme-Toggle in `:1635`).
- **Reiter-Beschriftung wandert mit:** Slot-A-Reiter heißt „Prozessansicht" oder „Kurator-Chat" je nach Swap-Zustand — sonst wäre die Zuordnung verwirrend.

### CSS — Design-System wiederverwenden

`sturm-app.css` hat fertige, generische (nur drawer-präfixierte) Klassen. Drei Alias-Regeln in den inline-`<style>` von `steuerfall.html` (nach `:478`), die die bestehenden Tokens spiegeln:

```css
.fall-tabs { display:flex; gap:2px; align-items:center; margin-bottom:14px;
             border-bottom:1px solid var(--color-border); padding-bottom:8px; }
.fall-tab  { padding:5px 10px; border:0; background:transparent;
             color:var(--color-text-secondary); font-size:12.5px; font-weight:500;
             border-radius:var(--radius-sm); cursor:pointer; display:flex; gap:6px; align-items:center; }
.fall-tab.is-active { color:var(--color-text-primary); background:var(--color-bg-active); }
.fall-pane[hidden] { display:none; }
```

- Tabs spiegeln 1:1 `.sturm-drawer-tab(s)` (`sturm-app.css:641–654`); Aktiv-Zustand `.is-active` identisch (`:654`).
- Switch nutzt **direkt** die existierenden Klassen `.sturm-toggle` / `.sturm-toggle-knob` / `.sturm-toggle.is-on` / `.sturm-toggle-row` / `.sturm-toggle-lbl` (`sturm-app.css:349–364`) — kein neues CSS nötig.

### Layout-Reibung (muss gelöst werden)

`.fall-wrap` hat `max-width:960px` (`:12`) und der Scroll-Container ist `align-items:center` (`:496`, verifiziert). Eine ReactFlow-Leinwand will breiter. Lösung: wenn Slot mit Flow aktiv ist, am `.fall-wrap` per JS eine Klasse `.is-wide` setzen, die `max-width:none; width:100%` erzwingt; bei Tab 1/Chat zurücknehmen. Das ist die einzige strukturelle Layout-Änderung.

### JS-Verdrahtung

Tab-Switch-Listener + Swap-Listener + Lazy-Mount in den `DOMContentLoaded`-Block (`1631–1648`, neben Theme-Btn `:1635`, Modal-Close `:1640`, Dedup-Toggle `:1647`). Flow- und Chat-Insel werden **lazy** beim ersten Aktivieren des jeweiligen Tabs gemountet (Performance + Capability-Check für Chat, siehe Tab 3).

---

## 2. Transparenz-Daten — Verfügbarkeit

Legende: **(A)** dauerhaft auf Platte · **(B)** nur live via SSE · **(C)** gar nicht erfasst.

| Signal | HEUTE | Quelle / Lücke | SOFORT baubar vs. INSTRUMENTIEREN |
|---|---|---|---|
| **Zeit pro Stage (ms)** | **(A)** | `_result.json.stages[id].ms` (`runner.ts:201,203`); via `…/runs/:runId/summary` schon ausgeliefert (`server.ts:1137`) | **SOFORT** |
| **Gesamt-Zeit Run** | **(A)** | `_result.json.ms` (`runner.ts:227-228`), `summary.totalMs` (`server.ts:1146`) | **SOFORT** |
| **Absolute Stage-Zeitstempel (Gantt)** | **(C)** | nur globales `startedAt` (`_meta.json`, `runner.ts:156`); kein `startedAt`/`endedAt` pro Stage | INSTRUMENTIEREN (trivial: bei `runner.ts:184/201` zwei ISO-Felder in `stageResults`) |
| **Output pro Stage (voll)** | **(A)** | `<stageId>/output.json` roh+ungekürzt (`runner.ts:204`) — Achtung: das `output` im `_result.json` ist `sanitizeForLog`-gekürzt; Tab 2 muss die separate Datei lesen | **SOFORT** (Endpoint nötig, s.u.) |
| **Input pro Stage** | **(C)** | kein `<stageId>/input.json`; `resolveInputs` (`runner.ts:183`) verworfen. Indirekt aus Vorgänger-`output.json` + Edge-Mapping rekonstruierbar | INSTRUMENTIEREN (1 Zeile: `artifacts.write('${id}/input.json', resolved)` nach `runner.ts:183`) |
| **Fehler pro Stage** | **(A)** | `_result.json.stages[id].error{message,stack}` (`runner.ts:215-218`); partial-Fehler oft im `output.json` | **SOFORT** |
| **Stage-State / skipped** | **(A)** | `_result.json` (`runner.ts:168, 203`) | **SOFORT** |
| **LLM-Prompt (System+User)** | **(C)** | in Stages lokal gebaut, direkt verschickt, **nie** gespeichert/emittiert | **INSTRUMENTIEREN** (Trace-Sink) |
| **LLM-Roh-Antwort** | **(C)** | `chatJson` liefert `{parsed,raw,usage}` (`llm-chat.ts`), aber Handle verwirft `raw`/`usage`: `resolvers/llm.ts:77-78` gibt nur `res.parsed` zurück (verifiziert). Streaming-Pfad verwirft `accumulated` (`phase3-llm-fill.ts:194`) | **INSTRUMENTIEREN** |
| **LLM-Token-Usage** | **(C)** | dito, am Handle verworfen | **INSTRUMENTIEREN** |
| **Externe Calls: vLLM/Mistral/Ollama URL** | **(B)** | `meta.baseUrl` im Handle; Modell im `phase3_start`-Event | INSTRUMENTIEREN (persistieren) |
| **Externe Calls: vLLM/Mistral/OCR Request-Body** | **(C)** | nirgends | **INSTRUMENTIEREN** |
| **Externe Calls: vLLM/Mistral/OCR Response-Body** | **(C)** | nirgends (s.o. LLM-raw) | **INSTRUMENTIEREN** |
| **Externe Calls: BMF-MCP Response** | **(A)** | `bmf_rechner_response.json` + `phase6BmfRechner/output.json.mcp_raw` (`bmf-rechner-compute.ts:250,195`) — **einzige** voll persistierte externe Antwort | **SOFORT** (anzeigen) |
| **Externe Calls: BMF-MCP Request (volle Werte)** | **(C)** | nur eCode-Keys ephemer im Start-Event; Werte fehlen | INSTRUMENTIEREN |
| **Retries (LLM/Ollama)** | **(C)** | `MAX_RETRIES`-Schleifen emittieren nichts (`llm-chat.ts`, `phase3-llm-fill.ts`) | INSTRUMENTIEREN |
| **Zeitlicher Ablauf / Event-Transcript** | **(B) live, (C) persistiert** | Case-Run ruft `runWorkflow` ohne `onEvent` (`server.ts:477`); Bus flüchtig (`events.ts`). Live aber konsumierbar (Tab-1-Reader `steuerfall.html:1016-1066`) | LIVE **SOFORT** / Replay **INSTRUMENTIEREN** |
| **Custom-Stage-Events** (`phase3_field`, `ocr_done`, `ensemble_model_done`, `kpi_warning` …) | **(B)** | nur live via SSE, sanitisiert, nie persistiert | LIVE **SOFORT** / Replay INSTRUMENTIEREN |
| **MCP-Health (live)** | **(B)** | `…/mcps/health` Dots (`steuerfall.html:677`) — Health, **kein** Call-Trace | n/a (vorhanden) |

**Kernaussage:** „Zeit + Output + Fehler pro Stage" und der **Live-Ablauf** sind sofort baubar. „Prompts + LLM-Antworten + externe Request/Response + Stage-Input + Replay-Ablauf" brauchen ein **neues per-Run Trace-Artefakt** (Phase B).

---

## 3. Tab 2 — ReactFlow pro Run

### 3.1 Datenquelle

**Phase A — Replay (read-only, sofort):** Es fehlt heute ein case-scoped, token-freier Endpoint, der Stage-**Output-Bodies** liefert (der einzige Output-Body-Endpoint `…/stages/:stageId/output` ist token-pflichtig, `server.ts:1774`; `summary` liefert keine Bodies). **Neuer Endpoint:**

```
GET /api/applications/:appId/instances/:caseId/runs/:runId/detail   (token-frei, case-scoped)
```

Aggregiert in `server.ts` (direkt neben `…/summary`, `server.ts:1104-1151`, gleiches `appId→extractionId→runDir`-Muster):
- `meta` aus `_meta.json`, `input` aus `_input.json` (`server.ts:1700`),
- die statische **Workflow-Definition** für Topologie/Ports via `summarizeWorkflow` (`server.ts:192-231`),
- pro Stage: `{ id, uses, name, state, ms, error, output }` — `output` = Body aus `<stageId>/output.json` (statt N token-pflichtiger Roundtrips),
- falls vorhanden: `bmf_rechner_response.json`, später `<stageId>/_trace.json` (Phase B).

**Live-Animation (sofort, parallel):** Wenn Tab 2 offen ist *während* ein Upload läuft, hängt sich die Flow-Insel an **denselben** SSE-Reader, den Tab 1 schon hat (`steuerfall.html:1016-1066`, Event-Format `EventEnvelope` mit `name/stageId/at/payload`, `events.ts:23-30`). `stage_start`→Node „running", `stage_done`→„ok" + ms, `stage_error`→„error". Kein neuer Endpoint nötig; nur ein zweiter Subscriber auf den vorhandenen Reader-Stream (Broadcast-Pattern: Reader pusht Events an ein internes Mini-Event-Target, das Tab 1 *und* Flow-Insel hören).

### 3.2 ReactFlow-Aufsatz

**esm.sh + htm-Insel (Option A der reactflow-Recon).** Begründung: `steuerfall.html` ist token-freies Vanilla, lädt sonst kein React; eine isolierte Insel kollidiert mit nichts und braucht keinen esbuild-Build. Vorbild ist `steuerfall-flow.html:183-201` (importmap + `import ReactFlow,{Background,Controls,MiniMap,Handle,Position} from "reactflow"` + `createRoot(...).render(html\`…\`)`). **Nicht** pipeline.bundle.js wiederverwenden (UMD-Globals, Bundle exportiert nichts, `pipeline.jsx:3675` mountet sofort auf `#root` — Refactor zu teuer). **Kein** iframe auf pipeline.html (zweite Topbar/Sidebar, kein nahtloses Tab-Gefühl, und zeigt ebenfalls keine Prompts).

Lazy-Import beim ersten Tab-2-Aktivieren: `await import('https://esm.sh/reactflow@11.11.4')` + htm. ReactFlow-CSS in `<head>` nach `:10` ergänzen (`cdn.jsdelivr.net/npm/reactflow@11.11.4/dist/style.css`).

### 3.3 Node-Modell

Aus `summarizeWorkflow().stages[]` + `edges`. Auto-Layout aus dem `pipeline.jsx:116-160`-Muster (`layoutWorkflow`: topo-Layer → Spalten, `COL_W=320, ROW_H=200`) als htm-Port nachbauen (klein, keine Lib).

Pro Node (`StageNode`-Anatomie aus `pipeline.jsx:166-225` als Vorlage):
- `data.label` (Stage-Name), `data.uses`,
- **State-Badge** `idle/running/ok/error/skipped` (live aus SSE, im Replay aus `_result.json.stages[id].state`),
- **`data.ms`** Laufzeit (`fmtDur`-Muster `pipeline.jsx:343`),
- Handles links(target)/rechts(source).

Edges `animated: true` solange Quell-Stage `running` (Live), sonst statisch (`pipeline.jsx:3441`-Muster).

### 3.4 Detail-Panel je Node

Bottom-of-Canvas-Panel bei Node-Klick, Vorbild `StageInspectorPanel` (`pipeline.jsx:2222-2401`). Sektionen:

| Sektion | Quelle Phase A | Quelle Phase B |
|---|---|---|
| **Timing** (ms, später Start/Ende) | `detail.stages[id].ms` | + absolute Zeitstempel |
| **Output** (Syntax-highlighted JSON) | `detail.stages[id].output` (`jsonToHtml`-Muster `pipeline.jsx:1963-1984`) | — |
| **Input** | leer / „aus Vorgänger rekonstruiert" | `<stageId>/input.json` |
| **Prompts → LLM + Antworten** | **leerer Zustand** mit Hinweis „Prompt-Tracing inaktiv" | `<stageId>/_trace.json` Einträge `kind:'llm'` |
| **Externe Calls (URL/Req/Resp)** | nur BMF-MCP (`bmf_rechner_response.json`) | `<stageId>/_trace.json` Einträge `kind:'http'/'mcp'` |
| **Fehler** | `detail.stages[id].error` | — |

**Ehrlichkeit im UI:** In Phase A zeigen die Sektionen Prompts/externe Calls einen expliziten leeren Zustand („Diese Transparenz erfordert aktiviertes Run-Tracing — siehe Phase B"), statt leer/irreführend zu wirken.

### 3.5 Live vs. Replay — Modus-Logik

- **Run-Auswahl:** kleines Dropdown oben in der Flow-Insel, gespeist aus `instance.runs[]` (schon geladen, `steuerfall.html:697`), Default = neuester Run.
- **Replay:** gewählter Run → `GET …/runs/:runId/detail` → Nodes statisch mit Endzuständen. (Phase B: zusätzlich `_events.jsonl` zeitgerafft abspielbar.)
- **Live:** läuft gerade ein Upload (erkennbar am aktiven SSE-Reader / `inst.status==='in_bearbeitung'`), animiert die Insel die Übergänge in Echtzeit aus dem Broadcast.

---

## 4. Tab 3 — Kurator-Chat

### 4.1 Einbettung

Der Orchestrator-Chat (`orchestrator.html`) ist vollständig wiederverwendbar, aber **keine gekapselte Komponente** — eine anonyme IIFE (`orchestrator.html:294-555`) mit `document.getElementById` auf globale IDs. **Refactor zu einer Factory**, kein iframe (iframe scopt nicht auf `CASE_ID`, weil `orchestrator.html` keinen `?case=`-Param liest, nur `?mode=`, chat-embed-Recon §3).

**Vorgehen:**
1. Markup aus `orchestrator.html` übernehmen — Chat-Log `:267-277` + Eingabezeile `:279-291`. **Verwerfen:** Header + Case-Picker (`:253-265`) — denn `CASE_ID` ist in `steuerfall.html` schon aus der URL geparst (`:633-634`). Dadurch entfällt `loadCases()` (`:310-328`) komplett.
2. CSS `.orch-*` (`orchestrator.html:10-250`) in den inline-`<style>` von `steuerfall.html` kopieren — nutzt durchgängig `var(--color-*)`, portabel. **`body{height:100vh;display:flex}` (`:11-19`) NICHT übernehmen** — durch Pane-Höhe ersetzen.
3. Send-Loop (`send()` `:407-531`, Bubble-Factory `:347-397`, SSE-Parser `handleSseBlock()` `:498-530`) in eine `function mountKuratorChat(rootEl, {appId, caseId})` heben: `getElementById` → `rootEl.querySelector`, `APP_ID`-Konstante (`:295`) und `caseSelect.value` (`:436,:460`) durch die Parameter ersetzen.

### 4.2 Endpoint-Anbindung

- **Primär:** `POST /api/orchestrator/chat-stream` (SSE, `orchestrator.ts:724`) — das nutzt auch die Standalone-Seite (`orchestrator.html:455`).
- **Fallback:** `POST /api/orchestrator/chat-sync` (JSON, `orchestrator.ts:692`).
- **`/chat` (echtes vLLM-Streaming, `orchestrator.ts:660`) ignorieren** (dokumentierter helmet+SSE-Flush-Bug, `orchestrator.ts:722-723`).
- Request-Body: `{ caseId: CASE_ID, messages: [...] }` — `appId` weglassen (Guard greift nur `if (body.appId && …)`, `orchestrator.ts:734-736`; `APP_ID` ist ohnehin `steuerfall-est`).

### 4.3 Capability-Check / 404-Degradation (wichtig)

Der Orchestrator-Router wird **nur bedingt gemountet** — nur wenn `resolveOrchestratorVllm()` ein erreichbares vLLM liefert (`server.ts:271-272`); sonst liefern **alle** Routen 404 (`server.ts:282-283`). Heute gibt es **keine** saubere Degradation — 404 endet als hässliches Fehler-Token in der Bubble (`orchestrator.html:465,482-485`).

**Beim ersten Aktivieren von Tab 3:** einmal `GET /api/orchestrator/tools` pingen. Bei `!res.ok` → Pane zeigt ausgegrauten Zustand „Kurator nicht verfügbar — kein Steuer-LLM gebunden", statt Chat-Eingabe. (Router-Existenz == vLLM vorhanden ist das implizite Signal.)

### 4.4 Bezug zur Opus-Anbindung

- **Heute Gemma-4/vLLM, nicht Opus.** Modell aus `resolveOrchestratorVllm()` (`server.ts:276`). System-Prompt nennt sich neutral „STURM-Steuerassistent", verbietet Modellnamen in Antworten (`orchestrator.ts:87-88`) — konform zu CLAUDE.md Regel 2.
- **Für eine Opus-Kurator-Variante:** zweiter Router/Provider-Mount (eigener Anthropic-Pfad); **die Tab-3-UI bleibt identisch**, nur `fetch`-Ziel ändert sich. Das „Erfragen/Optimieren des Falls" lässt sich rein über `OrchestratorOptions.systemPrompt` (`orchestrator.ts:53`, genutzt `:309,:547`, heute nicht gesetzt → Default) steuern, ohne Loop-Änderung. Der Werkzeugkatalog (`orchestrator-tools.ts:143-577`: `fall_status`, `pflicht_luecken`, `verdaechtige_felder`, `fall_versiegeln` mit `bestaetigt`-Flow …) trägt die „optimiere den Fall"-Semantik bereits.
- **Tool-Transparenz-Brücke:** Die SSE-Events `tool_call`/`tool_result` tragen `name/args/result/ms` (`orchestrator.ts:588,601`) — die Bubble-Factory rendert sie schon als aufklappbare Chips (`orchestrator.html:367-391`). Das ist Kurator-Interaktion (Tab 3), **nicht** Stage-Forensik (Tab 2); die beiden Datenquellen bleiben getrennt.

---

## 5. Datei-Änderungsliste pro Phase

### Phase A — Tabs + Chat + Flow (Replay/Live), ohne Backend-Instrumentierung

| Datei | Änderung |
|---|---|
| `src/ui/steuerfall.html` | **`<head>`** nach `:10`: ReactFlow-CSS-Link. **`<style>`** nach `:478`: `.fall-tabs/.fall-tab/.is-active/.fall-pane` + `.is-wide`-Override + `.orch-*`-Block (aus `orchestrator.html:10-250`, ohne `body{...}`). **Markup:** Tab-Leiste+Swap nach `:511`; Wrapper `#pane-overview` um `:513…:589`; `#pane-slotA`/`#pane-slotB` nach `:589`; Chat-Markup-Vorlage (versteckt) als Template. **`<script>`-IIFE:** `mountKuratorChat()`-Factory (Port aus `orchestrator.html:294-555`); Flow-Insel-Modul (esm.sh+htm, Layout-Port aus `pipeline.jsx:116-160`, Node/Panel-Port aus `:166-225,2222-2401`); Tab-Switch + Swap-Logik + `localStorage`-Persistenz; SSE-Reader (`:1016-1066`) zu Broadcast erweitern, damit Flow-Insel mithört; Capability-Ping `GET /api/orchestrator/tools`. **`DOMContentLoaded`** (`:1631-1648`): Listener registrieren, Lazy-Mount. |
| `src/server.ts` | Neuer Handler **`GET /api/applications/:appId/instances/:caseId/runs/:runId/detail`** neben `…/summary` (`:1104`). Aggregiert `_meta.json` + `_input.json` (`:1700`) + `summarizeWorkflow` (`:192`) + pro Stage `<stageId>/output.json` + `bmf_rechner_response.json`. Token-frei, case-scoped (gleiches Guard-Muster wie `:1108-1116`). |

### Phase B — Trace-Persistenz (Backend-Instrumentierung) für Prompts/externe Calls/Input/Replay

| Datei | Änderung |
|---|---|
| `src/core/runner.ts` | (1) Nach `resolveInputs` (`:183`): `await artifacts.write('${stageId}/input.json', resolved)`. (2) Bei `:184`/`:201`: `startedAt`/`endedAt` (ISO) in `stageResults[id]` → Gantt. (3) `ctx` um einen `trace(entry)`-Sink erweitern (schreibt append in `<stageId>/_trace.json`), an alle Stages durchgereicht. (4) Optional: Append-Subscriber, der jedes Event nach `runs/<wf>/<runId>/_events.jsonl` schreibt (Muster existiert in `job-runner.ts:43,275`) → echter Replay-Ablauf. |
| `src/core/tools/resolvers/llm.ts` | `chatJsonImpl` (`:77-78`) gibt heute nur `res.parsed` zurück und verwirft `raw`/`usage`. Über den injizierten `trace`-Sink pro Call `{kind:'llm', model, system, prompt, raw, usage, ms, retries}` schreiben. **Zentral hier**, damit alle Handle-basierten Stages automatisch erfasst werden (statt ~60 Stages einzeln). |
| `src/lib/llm-chat.ts` / `src/lib/bmf-mcp-client.ts` | Optional: Roh-HTTP Request/Response + Retry-Zähler an den Trace-Sink melden (URL/Req-Body/Resp-Body/Latenz). |
| `src/verticals/elster-v3/stages/phase3-llm-fill.ts` | Streaming-Pfad (`accumulated`, `:194`): die akkumulierte Roh-Antwort in den Trace-Sink schreiben (geht nicht über den Handle). |
| `src/server.ts` | `…/runs/:runId/detail` um `<stageId>/_trace.json` + `<stageId>/input.json` erweitern. Optional neuer **`GET …/runs/:runId/events`** (SSE-Replay aus `_events.jsonl`, Vorbild `server/jobs.ts:44`). |
| `src/ui/steuerfall.html` | Detail-Panel-Sektionen „Prompts" / „Externe Calls" / „Input" von leerem Zustand auf echte Trace-Daten umstellen; optional zeitgerafftes Replay über `…/events`. |

### Phase C (optional) — Opus-Kurator

| Datei | Änderung |
|---|---|
| `src/server.ts` (`:270-285`) + `src/server/orchestrator.ts` | Zweiter Provider/Router-Mount (Anthropic-Pfad) mit gesetztem `systemPrompt` (`orchestrator.ts:53`). UI unverändert. CLAUDE.md Regel 2 beachten (keine Modellnamen user-facing). |

---

## 6. Risiken, Aufwand, offene Entscheidungen

### Risiken

1. **Layout-Kollision Flow ↔ `.fall-wrap` `max-width:960px`** (`:12`, `align-items:center` `:496`). Mitigation: `.is-wide`-Klasse pro aktivem Slot. Niedriges Risiko, aber leicht zu übersehen.
2. **esm.sh-Abhängigkeit zur Laufzeit** (CDN). pipeline.html nutzt jsdelivr-UMD, `steuerfall-flow.html` nutzt esm.sh — beide CDN-basiert, also kein neues Muster, aber Offline/CSP-Risiko. Falls strenge CSP: ReactFlow lokal vendoren.
3. **Phase-A-Tab-2 zeigt Prompts/externe Calls NICHT** — das ist exakt die zentrale Feature-Anforderung. Risiko: Erwartung „vollständig transparent" wird in Phase A nur teilweise erfüllt. Mitigation: ehrlicher leerer Zustand + klare Phasen-Kommunikation.
4. **Trace-Daten sind sensibel** (Phase B): Prompts enthalten Dokumentinhalte (Namen, IDNr, Beträge). `runs/` ist gitignored (CLAUDE.md Regel 4) — passt. Aber `…/detail` ist token-frei: die Tab-2-Surface ist bewusst token-frei (`server.ts:294-298`), Prompts dort auszuliefern ist konsistent mit dem bestehenden token-freien Stage-Output, sollte aber bewusst bestätigt werden.
5. **`sanitizeForLog`-Decke** (`runner.ts:253-267`): Strings > 2000 Zeichen werden gekürzt. Für Trace-Artefakte (Phase B) muss die Kürzung umgangen werden, sonst sind lange Prompts abgeschnitten. Betrifft nur die neuen `_trace.json`, nicht das bestehende `output.json` (das wird roh geschrieben, `runner.ts:204`).
6. **Live-Reader-Broadcast**: Tab 1 und Flow-Insel teilen sich einen SSE-Reader. Refactor des bestehenden Readers (`:1016-1066`) zu einem Broadcast-Pattern darf die heutige Tab-1-Logik nicht brechen (Upload-Progress, Stage-Anzeige). Mittleres Risiko — der Reader ist die kritischste bestehende Codestelle, die angefasst wird.

### Aufwand (grob)

- **Phase A:** Tabs+Swap ~0.5 Tag; Chat-Factory-Port ~0.5 Tag; Flow-Insel (Layout+Node+Panel-Port aus pipeline.jsx, Replay+Live) ~1.5–2 Tage; `…/detail`-Endpoint ~0.5 Tag. **≈ 3–3.5 Tage.** Liefert: funktionierende 3 Tabs, Swap, Chat voll funktional, Flow mit Timing/Output/Fehler + Live-Animation.
- **Phase B:** Runner-Instrumentierung (Input/Zeitstempel/Trace-Sink/`_events.jsonl`) ~1 Tag; LLM-Handle + Streaming-Pfad Trace ~1 Tag; Endpoint-Erweiterung + UI-Panels ~0.5 Tag; optional Replay-SSE ~0.5 Tag. **≈ 2.5–3 Tage.** Liefert: vollständige Prompt/externe-Call/Input-Transparenz + echter zeitlicher Replay.
- **Phase C (optional):** Opus-Mount ~0.5–1 Tag.

### Offene Entscheidungen

1. **Phasen-Schnitt:** Phase A allein ausliefern (Timing/Output + Live + Chat) oder zwingend mit Phase B (Prompts/Calls)? Die Kernanforderung „welche Prompts + Antworten / externe Request/Response" ist **nur mit Phase B** erfüllbar.
2. **Live-only vs. Replay für Prompts:** Falls Backend-Instrumentierung zu teuer — Alternative aus reactflow-Recon §3: Tab 2 startet den Run **selbst live** und zeigt Prompts im Moment des Laufs (sofern Stages sie emittieren). Deckt aber **keine** vergangenen Runs ab. Entscheidung: persistieren (Phase B) vs. nur-live.
3. **Trace-Sink-Ort:** zentral in `ctx`/Tool-Handles (erfasst alle Stages automatisch, empfohlen) vs. Konvention „jede LLM/MCP-Stage schreibt `request`/`response`-Artefakt" (mehr Boilerplate, aber granularer).
4. **`_events.jsonl` für echten zeitlichen Replay** (Stage-Reihenfolge, `phase3_field`-Streaming nachspielbar) — Nice-to-have oder Pflicht? Erfordert zusätzlich eine Run-Registry für Re-Attach an laufende Runs (live-sse-Recon §4).
5. **Swap-Persistenz-Scope:** pro App (`SWAP_KEY+APP_ID`, vorgeschlagen) vs. pro Fall vs. global.
6. **Tab-2 für Multi-Doc-Fälle:** ein Fall hat mehrere Runs (ein Run pro Beleg, `instance.documents[].runId`). Run-Dropdown (vorgeschlagen) vs. kombinierte Sicht. Empfehlung: Dropdown, da „EIN konkreter Fall-Run vollständig transparent" die Anforderung ist.

---

## Anhang — Recon-Reports (6)

### Recon: run-transparenz

I now have full confirmation. The elster case-run trigger (server.ts:477, 591, 833) calls `runWorkflow` with **no `onEvent`** callback — so events go only to the live SSE `res.write` subscription, never to disk. The `events.jsonl` files that exist are for `project-context` workflow and workspace jobs, not elster case-runs. I have everything to write the report.

# Recon-Report: Run-Transparenz im 0711-STURM Case-Run (elster-v5.2-rag / v6-vision)

Geltungsbereich: ELSTER-Extraktions-Run, getriggert per Doc-Upload in der ctax-Fallansicht (`src/server.ts:477, 591, 833`, `appId: 'steuerfall-est'`). Read-only-Befund. Antwort-Schema je Signal: **(A)** dauerhaft auf Platte, **(B)** nur ephemer via Event/SSE, **(C)** gar nicht erfasst.

## Architektur-Grundlage (für Tab 2 entscheidend)

Drei Persistenz-Schichten, plus ein flüchtiger Event-Strom:

1. **Artefakt-Store pro Run** — `src/core/artifacts.ts:12`. Layout `runs/<workflowId>/<runId>/`. Pro Stage schreibt der Runner **automatisch** `runs/<wf>/<runId>/<stageId>/output.json` (`runner.ts:204`), plus `_meta.json` (`runner.ts:155`) und `_result.json` (`runner.ts:229`). Einzelne Stages schreiben zusätzlich eigene Artefakte via `ctx.artifacts.write(...)`.
2. **case-level master.json** — `src/server/case-master.ts:119–121`, aus `aggregation.ts` aggregiert. Fall-Ebene, nicht Run-Transparenz.
3. **GitChain-Store (optional)** — `artifacts-gitchain.ts`, nur aktiv wenn `GITCHAIN_DATABASE_URL`+`GITCHAIN_REPO_ROOT` gesetzt (`runner.ts:128`). Committet pro Stage denselben fs-Inhalt; fügt **keine** zusätzlichen Transparenz-Felder hinzu außer Commit-Message `"[stageId] <name> OK (<ms>ms)"` (`gitchain.ts:54`).
4. **EventBus → SSE** — `events.ts:7`. Subscriber bekommen Live-Events. **Der Bus persistiert nichts.** Im Case-Run-Pfad ist der einzige Subscriber `res.write(formatSseEvent(env))` (`server.ts:496, 613, 834, 1616`). **`runWorkflow` wird im Case-Pfad OHNE `onEvent` aufgerufen** (`server.ts:477` etc.) → kein Event-Transcript wird je geschrieben. Die existierenden `events.jsonl` (`job-runner.ts:43`, `workflows/project-context`) gehören zu anderen Subsystemen und betreffen Elster-Runs NICHT.

Konsequenz: **Was nicht im `output.json` einer Stage oder einem explizit geschriebenen Artefakt landet, ist nach Run-Ende unwiederbringlich weg** — die SSE-Events leben nur während der Verbindung.

---

## Signal-für-Signal

### 1. Verarbeitungszeit pro Stage (ms) + gesamt — **(A) persistiert**

- Pro Stage: `runner.ts:201` misst `ms = Date.now() - t0`, schreibt es nach `stageResults[stageId].ms` (`runner.ts:203`) und damit in **`_result.json`** (`runner.ts:229`). Shape: `{ runId, workflowId, state, ms, stages: { <stageId>: { stageId, state, ms, output } } }`.
- Gesamt: `totalMs` in `_result.json.ms` (`runner.ts:227–228`).
- Zusätzlich ephemer in `stage_done`-Event (`runner.ts:211`) und in vielen Stages doppelt im output (`phase3 ... ms`/`durationMs` `phase3-llm-fill.ts:251, 243`; `bmf ... stats.ms` `bmf-rechner-compute.ts:240`).
- **Lücke:** Bei Stages in derselben Topo-Schicht ist nur Stage-Wallclock erfasst, kein Start-/Endzeitstempel pro Stage (nur `_meta.json.startedAt` global, `runner.ts:156`). Eine echte Gantt-Darstellung (parallele Schichten zeitlich überlappend) braucht absolute `startedAt`/`endedAt` pro Stage — das ist **(C)**.

### 2. Input je Stage — **(C) im Normalfall NICHT persistiert** (teilweise (B))

- Der **resolvierte Input** (`resolveInputs`, `runner.ts:183`) wird nirgends als Artefakt geschrieben. Es gibt **kein `<stage>/input.json`**.
- Nur der **Run-weite** Top-Level-Input wird ephemer im `run_start`-Event emittiert — und dort **truncated** durch `sanitizeForLog` (`runner.ts:152`): Strings > 2000 Zeichen abgeschnitten, Arrays auf 50 Elemente, Tiefe > 4 → `'…'` (`runner.ts:253–267`). Persistiert wird selbst dieser truncatete Run-Input nicht.
- Faktisch rekonstruierbar ist Stage-Input nur **indirekt** über die `output.json` der Vorgänger-Stages (die per Edge eingespeist werden). Das reicht für viele Stages, aber: der genaue gemappte Input-Slice (`${ocr.text}` etc.) ist nicht festgehalten, und der OCR-Volltext, der z.B. in jeden phase3-Prompt eingeht, ist nur im `ocr/output.json` als Ganzes vorhanden.

### 3. Output je Stage — **(A) persistiert, VOLLSTÄNDIG**

- `runner.ts:204`: `await artifacts.write(`${stageId}/output.json`, output)` — schreibt das **rohe, ungekürzte** Stage-Output-Objekt (kein `sanitizeForLog` auf dem fs-Pfad!). Das ist die verlässlichste Transparenzquelle.
- Achtung Asymmetrie: das `stage_done`-**Event** trägt nur `sanitizeForLog(output)` (`runner.ts:211`), die **Datei** aber den vollen Output. Tab 2 sollte also `output.json` lesen, nicht den Event-Payload.
- Stages schreiben teils reichere Sub-Artefakte: `phase3_per_anlage/<anlage>.json` (`phase3-llm-fill.ts:775`), `bmf_rechner_response.json` + `computed_layer.json` + `eric_payload.xml` + `canonical_layer_final.json` (`bmf-rechner-compute.ts:250–253`).

### 4. An LLMs gesendete PROMPTS (System+User) + ROH-Antworten — **(C) NICHT erfasst** (kritischste Lücke)

- **Prompts:** Werden in den Stages lokal gebaut (z.B. `slicePrompt` `phase3-llm-fill.ts:618–644`; Container-Brief + Hints + OCR-Volltext + Regeln) und **direkt an `vllmStreamExtract`/`ctx.tools.getByRole('extraction-llm').chatJson` übergeben, aber NIRGENDS gespeichert oder emittiert**. Kein `ctx.artifacts.write(prompt)`, kein Event mit dem Prompt-Text.
- **Roh-Antworten:** Der generische LLM-Wrapper `chatJson` liefert zwar `{ parsed, raw, usage }` zurück (`llm-chat.ts:92–96, 266, 305, 348`) — also Roh-Text + Token-Usage. **ABER** der Tool-Handle wirft beides weg: `resolvers/llm.ts:77–78` ruft `chatJson<T>(...)` und gibt `return res.parsed` zurück. `raw` und `usage` gehen am Handle-Boundary verloren. Da die elster-Stages ausschließlich über den Handle gehen (`getByRole<LlmHandle>('extraction-llm')`, `phase3-llm-fill.ts:672`), sehen sie die Roh-Antwort **nie** und können sie nicht persistieren.
- **Streaming-Pfad (Default in v5.x):** `vllmStreamExtract` (`phase3-llm-fill.ts:70`) akkumuliert die Antwort in `accumulated` (`:154, :194`), nutzt sie aber nur zum Feld-Parsing und gibt das geparste Objekt zurück. `accumulated` (= die Roh-Antwort) wird **verworfen**, nie geschrieben/emittiert.
- Was **schwach** erfasst ist: pro fertig dekodiertem Feld ein `phase3_field`-Event `{ anlage, eCode, value, slice }` (`phase3-llm-fill.ts:665`) — flüchtig (B), und nur das Extraktionsergebnis, nicht Prompt/Roh-Antwort. Modell-Name landet in `phase3_start` (B) und über `origin: 'LLM_FSM'` indirekt im output (A), aber **welcher konkrete Prompt zu welchem Wert führte, ist nicht nachvollziehbar.**
- Token-Verbrauch pro LLM-Call: **(C)** für alle Handle-basierten Calls (verworfen). Einzige Ausnahme im gesamten gelesenen Code: `audit.ts` (Workspace-Feature, nicht Case-Run) hält `semanticTokens` im `AuditReport` (`audit.ts:423, 53`).

### 5. Externe Schnittstellen-Aufrufe (URL + Request-Body + Response-Body) — überwiegend **(C)**

- **vLLM / Mistral / Ollama (LLM):** URL teilweise (B/A) — `meta.baseUrl` im Handle, Modell im `phase3_start`-Event (B). **Request-Body (Messages/Schema): (C).** **Response-Body: (C)** (siehe #4, am Handle verworfen). Kein Audit-Artefakt.
- **BMF-MCP (`berechne_vollstaendige_steuer_v2`):**
  - URL: ephemer im `bmf_rechner_start`-Event als `mcp_url` (`bmf-rechner-compute.ts:164`) **(B)**.
  - Request-Body (`{ erklaerungsjahr, elster_felder }`, `bmf-rechner-compute.ts:171`): nur die **eCode-Keys** ephemer im Start-Event (`input_ecodes`, `:163`) — die **Werte fehlen** → effektiv **(C)** für den vollen Request.
  - Response-Body: **(A) persistiert!** `result.mcp_raw = mcpResponse` (`:195`) landet im `phase6BmfRechner/output.json`, und zusätzlich explizit als `bmf_rechner_response.json` (`:250`). Das ist die einzige externe Schnittstelle mit voll persistierter Antwort.
  - JSON-RPC-Transportdetails (SSE-Frame-Parsing) in `bmf-mcp-client.ts:113–143` — Roh-HTTP-Body wird nicht gespeichert, nur das geparste `result`.
- **Mistral-OCR (Cloud):** Aufruf in `mistral-ocr-classify.ts:184` (`callMistralOcrWithFallback`). Persistiert wird das **geparste** Ergebnis (`parsed`, pages, annotation) im output **(A)**, plus ephemere Events `ocr_started`/`ocr_done`/`ocr_classified`/`ocr_degraded` (B, `:183, 210, 211, 187`). **Roher API-Request/Response: (C).** Der OCR-Layer hat einen `degradation`-Pfad (Fallback) — dass ein Fallback griff, ist via `ocr_degraded` (B) + `parsed.degradation` (A) sichtbar, aber nicht welcher konkrete API-Call fehlschlug.
- **Postgres (BMF-Rechner DB):** Nur indirekt hinter dem MCP. **Nicht direkt sichtbar** für den Run — **(C)**.
- **GitChain:** Commit-SHAs werden im GitChain-Backend gespeichert (`gitchain.ts:44–46`), aber im fs-Run-Ordner nicht referenziert; Fehler nur als `log_warn`-Event (B, `runner.ts:208, 233`). Für Standard-Dev (ohne GitChain-Env) **(C)**.

### 6. Fehler / Retries je Stage — **teils (A), Retries (B/C)**

- **Stage-Fehler:** **(A)** — bei Exception schreibt der Runner `state: 'error', error: { message, stack }` nach `stageResults` → `_result.json` (`runner.ts:215–218`). Plus `stage_error`-Event (B, `:219`). Übersprungene Folge-Stages: `state: 'skipped'` in `_result.json` (`:168`).
- **Stage-interne, abgefangene Fehler:** Oft **(A)** im output, wenn die Stage sie ins Ergebnis schreibt — z.B. `phase3 per_anlage.<x>.error` (`phase3-llm-fill.ts:559, 589, 791`), `bmf stats.error` (`bmf-rechner-compute.ts:178, 188`). Solche "partial"-Fehler kippen den Stage-State nicht und sind nur im output.json auffindbar.
- **Retries:** **(B/C).** Die vLLM-/Ollama-Retry-Schleifen (`llm-chat.ts:219–248`, `phase3-llm-fill.ts:107–139`, `MAX_RETRIES=2`, expo Backoff) protokollieren **nichts** — kein Event, kein Artefakt. Dass 2× retried wurde, ist nach dem Run unsichtbar. Sign-Korrekturen sind besser dran: `phase3_sign_corrected`-Event (B, `phase3-llm-fill.ts:742, 749`), aber auch das nur ephemer.
- **Genereller Fehler-Kanal:** `ctx.logger.{debug,info,warn,error}` → `log_*`-Events (`runner.ts:25–32`) — **alle (B)**, nie persistiert. `kpi_warning` (`bmf-rechner-compute.ts:177, 257`) ebenfalls (B).

---

## Persistierte Run-Dateien — Inventar (Quelle der Wahrheit für Tab 2)

```
runs/<workflowId>/<runId>/
  _meta.json              { runId, workflowId, startedAt }              runner.ts:155   (A)
  _result.json            { runId, workflowId, state, ms,               runner.ts:229   (A)
                            stages: { <id>: {state, ms, output*, error?{message,stack}} } }
  <stageId>/output.json   voller roher Stage-Output (ungekürzt)         runner.ts:204   (A)
  phase3_per_anlage/<anlage>.json   Phase3-Detail je Anlage             phase3-llm-fill.ts:775
  phase6BmfRechner/output.json      enthält mcp_raw (BMF-Response)       bmf-rechner-compute.ts
  bmf_rechner_response.json         BMF-MCP-Rohantwort                   bmf-rechner-compute.ts:250
  computed_layer.json / eric_payload.xml / canonical_layer_final.json   :251–253
```
\* `output` im `_result.json` ist `sanitizeForLog`-gekürzt; die separate `<stageId>/output.json` ist voll.

`master.json` liegt **nicht** unter `runs/`, sondern im Workspace-Pfad der Anwendung (`case-master.ts:119`); enthält Fall-Aggregat inkl. `documents[].runId` (Verknüpfung Fall → Runs), `merged_layer` mit Citations (`page`/`snippet`), `conflicts`, `bmf`. Für Tab 1 (Übersicht) relevant, für Tab-2-Run-Detail nur als Index Run↔Datei.

---

## Was für „wirklich ALLE Infos" HEUTE FEHLT (muss nachgerüstet werden)

Priorisiert, mit konkretem Ansatzpunkt:

1. **LLM-Prompts + Roh-Antworten + Token-Usage werden komplett verworfen** (#4). Das ist die größte Lücke für Tab 2 („welche Prompts gingen an LLMs + Antworten").
   - Fix-Punkt A: `resolvers/llm.ts:77–78` gibt nur `res.parsed` zurück — `raw`/`usage` gehen verloren. Handle muss eine Capture-Senke bekommen (z.B. `ctx.artifacts.write` über einen injizierten Recorder, oder ein `llm_call`-Event mit Prompt-Hash + raw).
   - Fix-Punkt B: Streaming-Pfad `phase3-llm-fill.ts:194` (`accumulated`) — die akkumulierte Roh-Antwort wird nicht geschrieben.
   - Es gibt **keinen** zentralen LLM-Call-Logger. Empfehlung: pro Call ein Artefakt `llm_calls/<stage>-<n>.json` mit `{ url, model, provider, system, prompt, raw, usage, ms, retries }`.

2. **Kein Stage-Input-Artefakt** (#2). Es existiert kein `<stage>/input.json`. Der Runner hat den resolvierten Input bei `runner.ts:183` zur Hand — eine Zeile `await artifacts.write(`${stageId}/input.json`, resolved)` würde Tab 2 vollständig machen. Heute nur indirekt über Vorgänger-Outputs rekonstruierbar.

3. **Externe HTTP-Requests/Responses werden außer beim BMF-MCP nicht persistiert** (#5). vLLM/Mistral/Ollama/Mistral-OCR: weder Request-Body noch Response-Body landen auf Platte. Es gibt **keinen** zentralen Outbound-HTTP-Interceptor (kein `src/lib/audit.ts`-Äquivalent für Schnittstellen — `audit.ts` ist ein fachlicher Wert-Audit, **kein** Request/Response-Logger, siehe unten).

4. **Retries sind unsichtbar** (#6). `MAX_RETRIES`-Schleifen emittieren nichts. Für „welche externen Schnittstellen befragt wurden" fehlt damit die Information, dass/wie oft ein Call wiederholt wurde und mit welchem Fehler.

5. **Event-Strom ist flüchtig — kein Run-Transcript** (Architektur). Da Case-Runs `runWorkflow` ohne `onEvent` aufrufen (`server.ts:477`), gibt es **keine** persistente Event-Historie. Wer Tab 2 öffnet, nachdem der Run lief, sieht nur die Artefakt-Endzustände, **nicht** den zeitlichen Ablauf (Stage-Reihenfolge live, `phase3_field`-Streaming, `log_*`, `kpi_warning`, `phase3_sign_corrected`). Nachrüstung: im Case-Run-Pfad ein `onEvent`, das `runs/<wf>/<runId>/events.jsonl` append-only schreibt (Muster existiert bereits in `job-runner.ts:275` und `agent-turn.ts:53` — nur nicht für Elster verdrahtet).

6. **Keine absoluten Stage-Zeitstempel** (#1). Nur Wallclock-`ms` pro Stage + globales `startedAt`. Für eine Gantt-/Parallelitäts-Visualisierung (Tab 2 zeigt parallele Schichten) fehlen `startedAt`/`endedAt` pro Stage. Trivial nachrüstbar bei `runner.ts:184/201`.

7. **Klarstellung zu `src/lib/audit.ts`:** Loggt **nirgendwohin auf Platte** und ist **nicht** Teil des Case-Run-Pfads. Es ist ein **on-demand Workspace-Qualitätscheck** (Konsistenz/Semantik/Vision/Cross-Model/Struktur), der ein `AuditReport`-Objekt **zurückgibt** (`audit.ts:1069`) — die Persistenz liegt beim Aufrufer in `src/server/workspaces.ts` (Doc-`meta.json`), nicht im Run-Ordner. Für Tab-2-Run-Transparenz liefert `audit.ts` **nichts**; es ist eher ein Kandidat für Tab 1/3. Einziges dort sauber erfasstes externes Signal: ein Mistral-Chat-Call mit `semanticTokens`/`semanticError` (`audit.ts:401, 423`) — aber wieder ohne Prompt/Roh-Antwort-Persistenz.

### Fazit-Matrix

| Signal | Status | Belastbarster Beleg |
|---|---|---|
| Zeit/Stage + gesamt | **A** | `_result.json` (`runner.ts:203,228`) |
| Input/Stage | **C** (indirekt via Vorgänger-output) | kein `input.json`; nur trunc. run_start-Event `runner.ts:152` |
| Output/Stage | **A** (voll) | `<stage>/output.json` `runner.ts:204` |
| LLM Prompt + Roh-Antwort + Tokens | **C** | `resolvers/llm.ts:78` (`raw`/`usage` verworfen); `phase3-llm-fill.ts:194` |
| Externe Calls URL/Req/Resp | meist **C**, BMF-Resp **A** | `bmf_rechner_response.json` `:250` vs. LLM/OCR nichts |
| Fehler/Stage | **A** | `_result.json.stages.*.error` `runner.ts:216` |
| Retries | **C** | `llm-chat.ts:219`, `phase3-llm-fill.ts:107` (stumm) |
| Event-Transcript (Ablauf) | **B** (live), **C** (persistiert) | `server.ts:477` ruft `runWorkflow` ohne `onEvent` |

Gelesene Dateien (absolute Pfade): `/Users/.../src/core/runner.ts`, `/src/core/artifacts.ts`, `/src/core/artifacts-gitchain.ts`, `/src/core/events.ts`, `/src/core/tools/resolvers/llm.ts`, `/src/core/tools/handles.ts`, `/src/lib/audit.ts`, `/src/lib/llm-chat.ts`, `/src/lib/bmf-mcp-client.ts`, `/src/server/case-master.ts`, `/src/server/aggregation.ts`, `/src/server.ts` (Run-Trigger-Stellen), `/src/verticals/elster-v3/index.ts`, `/src/verticals/elster-v3/stages/phase3-llm-fill.ts`, `/src/verticals/elster-v3/stages/mistral-ocr-classify.ts`, `/src/verticals/elster-v3/stages/bmf-rechner-compute.ts`.

---

### Recon: ui-mitte

Recon abgeschlossen. The "Chat-Calls" at server.ts:175 refer to LLM chat completions for the schema generator, not a Kurator chat surface. No kurator/chat route exists. Here is the report.

---

# Recon "ui-mitte" — steuerfall.html: mittlerer Bereich, Rendering, Tab-Insertion, wiederverwendbare CSS

## 1. Grobgliederung der Seite

`steuerfall.html` (1653 Z.) ist eine statische HTML-Seite mit inline `<style>` (Z. 11–478) und einem einzigen inline `<script>` (Z. 595–1650). Kein React, kein Build-Step für diese Seite. Layout-Shell:

- `.sturm-app` (Z. 481) → `<aside id="sturm-nav-host">` (Z. 482, von `nav.js` ersetzt) + `.sturm-main` (Z. 484).
- `.sturm-main` enthält `header.sturm-topbar` (Z. 485–494) und darunter einen scrollenden Flex-Container (Z. 496) mit `.fall-wrap` (Z. 497), `max-width: 960px` (Z. 12).
- **Der gesamte „mittlere Bereich" lebt in `.fall-wrap` (Z. 497–590).** Das ist die einspaltige Content-Säule; es gibt aktuell keine horizontale Dreiteilung und keinen Chat/ReactFlow — die Seite ist rein dokument-/aggregat-zentriert.

## 2. Der mittlere Bereich = Fallberechnung/Gesamterklärung (genaue Panels + Zeilen)

Innerhalb `.fall-wrap` in DOM-Reihenfolge (alle `<section class="panel">`, sofern nicht anders):

| Block | Element-ID | Zeilen | Inhalt |
|---|---|---|---|
| Fall-Kopf (Titel/Meta + Action-Buttons + MCP-Health-Dots) | `.fall-head` / `#mcp-dots` | 498–511 | H1 `#case-display`, Meta `#case-meta`; Buttons: Pro-Abrechnung, master.json, eric.xml, Versiegeln, An ELSTER |
| **Belege hochladen** | `#drop`, `#bulk-queue` | 513–528 | Drag&Drop + Bulk-Queue |
| **Gesamterklärung** (Kern der Fallberechnung) | `#aggregate-panel` | **530–553** | siehe unten |
| Live-Events (SSE-Log) | `#events-panel` | 555–558 | `<pre>`-artiges Event-Log, initial `hidden` |
| Versiegelung | `#seal-panel` | 560–563 | Seal-Resultat |
| **Run-Historie** | `#runs` | 565–568 | Liste aller Runs des Falls |
| Run-Detail-Modal | `#run-detail` (`.run-detail-backdrop`) | 570–572 | Fixed-Overlay, per-Run Stage-Aufschlüsselung |
| **Canonical Layer (letzter Run)** | `#layer-panel` | 574–589 | `<table class="layer-table">` eCode/Feld/Anlage/Wert/Origin |

Das **Gesamterklärung-Panel `#aggregate-panel` (Z. 530–553)** ist das Herzstück der Fallberechnung und enthält:
- Kopf mit `#aggregate-sub` + Button `#btn-aggregate-refresh` (Z. 531–537)
- `#bmf-tiles` — KPI-Kacheln zvE / ESt / Soli / festzusetzende Steuer (Z. 538)
- `#bmf-result` — Erstattung/Nachzahlung-Bilanz (Z. 539)
- `<details id="bmf-detail">` — klappbare „Detaillierte Berechnung" mit Rechenschritten, Formel, Soli, Vorauszahlungen, fehlende Belege (Z. 540–543)
- `#coverage-bar` — Pflicht-Coverage (Z. 544)
- `<details id="missing-list">` Pflicht-Felder fehlend (Z. 545–548)
- `<details id="conflict-list">` Konflikte zwischen Belegen (Z. 549–552)

**Wichtig für das Feature:** Die heutige „Übersicht" verteilt sich also auf **mehrere Geschwister-Sections** innerhalb `.fall-wrap` (Belege-Upload, Gesamterklärung, Events, Versiegelung, Run-Historie, Layer-Tabelle) — nicht auf ein einzelnes Wrapper-Element. Für „Tab 1 = heutige Ansicht" muss man diese Sections gemeinsam in einen Tab-Pane-Container hüllen.

## 3. Wie die Übersicht gerendert/gefüllt wird (fetch-Calls)

Bootstrap: `DOMContentLoaded` (Z. 1631–1648) ruft `loadInstance()` (Z. 697) und `loadMcpHealth()` (Z. 673). Frühes Exit-Gate `window.__sturmSteuerfallNoCase` (Z. 662–669) wenn `?app=`/`?case=` fehlen; der gesamte Logik-Body steckt im `else`-Zweig (Z. 669 … Schließung Z. 1649). `APP_ID`/`CASE_ID` aus URL (Z. 633–634).

fetch-Calls (alle relativ, token-frei für diese Surface):

| Funktion | Endpoint | Zweck | Z. |
|---|---|---|---|
| `loadMcpHealth` | `GET /api/applications/{app}/mcps/health` | MCP-Dots | 677 |
| `loadInstance` | `GET /api/applications/{app}/instances/{case}` | Stammdaten + `instance.runs[]`, treibt alles Weitere | 698 |
| `renderRuns`→`loadRunSummary` | `GET …/runs/{runId}/summary` | pro Run: Stages/ms/state/fields (gecacht `runSummaryCache`, Z. 740) | 743 |
| `loadAggregate`→`renderAggregate` | `GET …/instances/{case}/aggregate` | **füllt Gesamterklärung** (bmf-tiles, result, detail, coverage, missing, conflicts, merged_layer) | 1229 |
| `loadLastLayer` (Alt-Pfad) | `GET …/instances/{case}/result` | canonical_layer (faktisch ersetzt durch aggregate→`renderLayer`, Z. 1501) | 844 |
| Upload (1 Datei) | `POST …/upload` → SSE | `startUpload`, Z. 977 | 996 |
| Upload (≥2) | `POST …/upload-bulk` → SSE | `startBulkUpload`, Z. 1094 | 1135 |
| Seal | `POST …/seal` (JSON o. SSE) | Z. 1515 | 1517 |
| Export | `POST …/export` | Z. 1600 | 1601 |

Render-Funktionen: `renderRuns` (Z. 759), `openRunDetail` (Z. 804), `renderAggregate` (Z. 1394), `renderBmfResult` (Z. 1255), `renderBmfDetail` (Z. 1279), `paintLayer`/`renderLayer` (Z. 893/922).

## 4. Wo der 3-Tab-Umschalter eingefügt würde — konkreter Insertion-Point

**Tab-Leiste:** unmittelbar **vor** der ersten inhaltlichen Section, also zwischen `.fall-head` (Ende Z. 511) und `<section class="panel">Belege hochladen` (Z. 513). Insertion-Point: **nach Z. 511, vor Z. 513**.

**Tab-Panes:**
- **Tab 1 (Übersicht):** umschließt die bestehenden Sections **Z. 513–589** (Belege-Upload, Gesamterklärung, Events, Versiegelung, Run-Historie, Layer-Tabelle). Das Run-Detail-Modal `#run-detail` (Z. 570–572) ist ein Fixed-Overlay und kann an Ort bleiben oder ans `.fall-wrap`-Ende verschoben werden.
- **Tab 2 (ReactFlow-Run-Transparenz) und Tab 3 (Kurator-Chat):** neue Container, initial leer/`hidden`, nach Z. 589 (vor `</div>` der `.fall-wrap` Z. 590) eingefügt.

**JS-Verdrahtung:** Tab-Switch-Listener am sinnvollsten im `DOMContentLoaded`-Block (Z. 1631–1648), analog zu den dort registrierten Listenern (Theme-Btn Z. 1635, Modal-Close Z. 1640, Dedup-Toggle Z. 1647). Der **Switch „Chat↔ReactFlow zwischen Tab 2/3 tauschen"** ist reine JS-State-Logik (welcher Pane-Container welche Komponente hostet); kein Backend nötig.

**Constraint aus dem Code:** `.fall-wrap` hat `max-width: 960px` (Z. 12) und der Scroll-Container ist `align-items:center` (Z. 496) — eine vollflächige ReactFlow-Leinwand will breiter sein. Für Tab 2 müsste man entweder die `max-width` für diesen Tab aufheben oder den ReactFlow-Pane aus `.fall-wrap` herauslösen. Das ist die wesentliche Layout-Reibung.

## 5. Wiederverwendbare Tab-/Switch-Komponenten im Design-System

In `sturm-app.css` gibt es **fertige Tab- und Toggle-Klassen** (primär für den Pipeline-Right-Drawer gebaut, aber generisch nutzbar):

**Tabs — `.sturm-drawer-tabs` / `.sturm-drawer-tab` (Z. 641–654):**
- `.sturm-drawer-tabs` (Z. 641): `display:flex; gap:2px` — Tab-Leiste.
- `.sturm-drawer-tab` (Z. 643–650): `padding:5px 10px; border:0; background:transparent; color:var(--color-text-secondary); font-size:12.5px; font-weight:500; border-radius:var(--radius-sm)`, inkl. Icon-Slot (`svg` 14×14, Z. 652).
- `.sturm-drawer-tab:hover` (Z. 653) und **`.sturm-drawer-tab.is-active`** (Z. 654): `color:var(--color-text-primary); background:var(--color-bg-active)` — der Aktiv-Zustand ist bereits per `.is-active` modelliert.
- Pane-Container-Pendant: `.sturm-drawer-body` (Z. 656) `flex:1; overflow-y:auto; padding:8px 10px`.
- Kosmetischer Hinweis: Diese Klassen tragen den semantischen Präfix „drawer". Funktional sind sie generische Tabs; man kann sie 1:1 verwenden oder leichte Alias-Klassen (z.B. `.fall-tabs`/`.fall-tab`) mit denselben Regeln anlegen.

**Switch — `.sturm-toggle` (Z. 349–364):**
- `.sturm-toggle-row` (Z. 349): Label+Toggle-Zeile (`display:flex; gap:8px; cursor:pointer`).
- `.sturm-toggle` (Z. 350–355) + `.sturm-toggle-knob` (Z. 356–361) + **`.sturm-toggle.is-on`** (Z. 362–363): fertiger Pill-Switch mit Knob-Animation. `.sturm-toggle-lbl` (Z. 364) für Beschriftung.
- → **Direkt nutzbar für den geforderten „Chat↔ReactFlow tauschen"-Switch.**

Weitere ggf. nützliche generische Klassen: `.sturm-pill` (Z. 254, mit `-emoji`/`-meta`), `.sturm-btn`/`.sturm-btn-primary` (Z. 366/374). Tokens (`--color-bg-active`, `--color-accent`, `--radius-sm`, `--duration-fast`, `--ease-default`) sind in `colors_and_type.css` definiert (eingebunden steuerfall.html Z. 7).

## 6. ReactFlow-Integrationsmuster (für Tab 2)

ReactFlow ist im Repo bereits etabliert, aber **nur in `pipeline.html`/`pipeline.jsx`**, nicht in steuerfall.html. Muster in `pipeline.html`:
- CSS `reactflow@11.11.4/dist/style.css` (Z. 9), UMD-Bundles React 18.3.1 + react-dom + `reactflow@11.11.4/dist/umd/index.js` (Z. 190–192).
- `pipeline.jsx` Z. 3: `const RF = window.ReactFlow;` (UMD-Global, kein ESM/Build). Mount: `ReactDOM.createRoot(document.getElementById('root')).render(<App/>)` (Z. 3674).
- **Run-Replay** (das, was Tab 2 braucht) existiert dort bereits: `?run=<runId>` lädt abgeschlossene Run-Artefakte (pipeline.jsx Z. 3076+); Stage-Outputs via `GET /api/runs/{workflowId}/{runId}/stages/{stageId}/output` (pipeline.jsx Z. 3146–3275; Server-Handler `src/server.ts:1774`), Input via `/_input.json` (Z. 3313). Run-Detail-Modal in steuerfall.html verlinkt heute schon nach `pipeline.html?workflow=…&run=…` (steuerfall.html Z. 834).

Für Tab 2 in steuerfall.html müssten dieselben UMD-Scripts + reactflow-CSS in den `<head>` (nach Z. 10), ein Mount-Root in den Tab-2-Pane, und eine kleine App, die per `CASE_ID`→`instance.runs`→Run-ID die obigen Run-Endpoints konsumiert.

## 7. Ehrliche Lückenanalyse — was NICHT vorhanden ist

**Datenseitig (kritisch für die Feature-Tiefe):**
- **Pro-Stage Verarbeitungszeit:** vorhanden. `…/runs/{runId}/summary` liefert `stages[]` mit `{id, state, ms, error}` aus `_result.json` (server.ts Z. 1133–1140). Gesamt-`totalMs` ebenfalls (Z. 1146). Reicht für die Zeit-Achse.
- **Pro-Stage Input/Output:** vorhanden, aber nur über die **token-gesicherte** Pipeline-Surface `GET /api/runs/{wf}/{runId}/stages/{stageId}/output` (server.ts Z. 1774, `requireBearerToken`). Die steuerfall-Surface (`/instances/.../runs/.../summary`) ist token-frei und liefert **kein** Stage-I/O. Für Tab 2 müsste man entweder Bearer-Token mitführen (nav.js Z. 22–33 persistiert `?token=` in `localStorage` als `sturm-token`) oder einen neuen token-freien I/O-Endpoint bauen. **Es gibt keinen aggregierten „Run-Graph mit allen I/O"-Endpoint.**
- **Welche externen Schnittstellen befragt wurden inkl. Request/Response:** **NICHT als strukturierte API vorhanden.** Es existiert nur die Live-MCP-Health (`/mcps/health`, Dots). Roh-Request/Response zu BMF-Lane1 / ELSTER-MCP werden nicht als abrufbares Artefakt pro Run exponiert; allenfalls implizit in einzelnen Stage-Outputs. Das ist die größte Datenlücke.
- **Welche Prompts an LLMs gingen + Antworten:** **NICHT als API vorhanden.** Es gibt LLM-Chat-Clients (`src/workflows/elster/lib/mistral-chat.ts`, `claude-chat.ts`, `haiku-chat.ts`, `src/lib/llm-chat.ts`), aber keinen Endpoint, der Prompt/Completion pro Stage/Run zurückgibt. Ob Prompts überhaupt als Run-Artefakt auf Disk landen, ist hier nicht belegt und müsste in den jeweiligen Stages verifiziert werden. Realistisch erfordert Tab 2 ein Stage-seitiges „prompt/response in Artefakt persistieren" + neuen Lese-Endpoint.

**Kurator-Chat (Tab 3): komplett NICHT vorhanden.**
- Kein `chat`/`kurator`-Route-Handler in `src/` (grep über `app.get/post(.*chat|kurator)` → leer). Der „Chat-Calls"-Kommentar in `server.ts:175` betrifft den **Schema-Generator** (LLM-Completions), nicht eine Kurator-Surface.
- Kein Chat-UI, kein `#chat`-Element, kein Chat-fetch in steuerfall.html (grep → leer). Tab 3 wäre Greenfield: UI-Composer + neuer Backend-Endpoint (Chat-Client-Libs als Bausteine vorhanden).

**UI-seitig:**
- Keine Tab-Logik/`role="tab"` irgendwo in steuerfall.html (grep → leer). Es gibt **keinen generischen `.sturm-tab`** — nur die drawer-präfixierten `.sturm-drawer-tab(s)`. Tab-State/ARIA müssen neu geschrieben werden; nur das Styling ist wiederverwendbar.
- Kein React in steuerfall.html (rein vanilla inline-Script). Für Tab 2 ist eine bewusste Entscheidung nötig: ReactFlow-UMD nachladen (wie pipeline.html) vs. iframe-Einbettung von `pipeline.html?run=…`.
- `.fall-wrap` `max-width:960px` + zentrierter Scroll-Container kollidiert mit einer breiten ReactFlow-Leinwand (siehe §4).

---

## Schlüssel-Belege (Pfad:Zeile)
- Insertion-Point Tab-Leiste: `src/ui/steuerfall.html:511`→`:513`
- Tab-1-Pane-Umfang: `src/ui/steuerfall.html:513–589`
- Tab-2/3-Pane-Einfügung: `src/ui/steuerfall.html:589`→`:590`
- Gesamterklärung (heutige Berechnungs-Übersicht): `src/ui/steuerfall.html:530–553`, Renderer `renderAggregate` `:1394`
- Daten-Bootstrap: `loadInstance` `:697`, `loadAggregate` `:1223/1229`
- JS-Listener-Block: `src/ui/steuerfall.html:1631–1648`
- Wiederverwendbare Tabs: `src/ui/design-system/sturm-app.css:641–654` (`.sturm-drawer-tabs`, `.sturm-drawer-tab`, `.is-active`), Pane `:656`
- Wiederverwendbarer Switch: `src/ui/design-system/sturm-app.css:349–364` (`.sturm-toggle`, `.sturm-toggle-knob`, `.is-on`)
- ReactFlow-Muster: `src/ui/pipeline.html:9,190–192`, `src/ui/pipeline.jsx:3,3674`; Run-Replay `pipeline.jsx:3076+`
- Stage-Output-Endpoint (token-pflichtig): `src/server.ts:1774`; Run-Summary (token-frei, ohne I/O): `src/server.ts:1099–1151`
- Kein Chat/Kurator-Endpoint: grep leer; Chat-Client-Libs `src/workflows/elster/lib/{mistral,claude,haiku}-chat.ts`, `src/lib/llm-chat.ts`

---

### Recon: reactflow

This is a decisive finding. The persisted `_result.json` for actual ELSTER runs has **no `events` array** (only `runId/workflowId/state/ms/stages`), and each stage entry carries no per-stage events either. The `persistedEvents` buffer in runner.ts exists in the type but is empty on disk for these runs — meaning prompts/responses/external-call request-response pairs are **NOT persisted** and cannot be retrieved read-only for a past run. This is the single most important gap for Tab 2's "which prompts went to LLMs + responses / which external interfaces + request/response" requirement.

I have everything needed for a complete, evidence-backed report.

# Recon-Report: ReactFlow-Setup in 0711-STURM (Tab-2-Visualisierung)

## TL;DR (Architektur-Entscheidung)
Es gibt **zwei vollständig getrennte ReactFlow-Aufsätze** im Repo:

1. **`src/ui/pipeline.jsx` (3675 Z.) → esbuild → `pipeline.bundle.js`** — die **produktive, datengetriebene** Engine-UI. ReactFlow kommt als **UMD-Global** (`window.ReactFlow`), React/ReactDOM ebenfalls als UMD. Kein ES-Modul, kein esm.sh.
2. **`steuerfall-flow.html` (499 Z., im Repo-Root, NICHT unter src/ui)** — ein **statischer, handgeschriebener Mock** via **esm.sh + htm**. Alle Nodes/Edges/Werte sind **hartcodiert** (Fall „Stricker", echte IDNr/Beträge im Markup — Vorsicht, das ist genau das, was CLAUDE.md Regel 1 verbietet). Read-only Show-Piece, keine Run-Anbindung.

Für Tab 2 (ein konkreter Run, transparent) ist **pipeline.jsx das einzig brauchbare Vorbild** — es liest echte Run-Artefakte. `steuerfall-flow.html` ist nur als Layout-/Styling-Referenz (Lane-Färbung, IN/OUT-Chips, Service-Nodes, Ledger/Dossier-Nodes) wertvoll, nicht als Datenquelle.

---

## 1. Wie ist ReactFlow jeweils aufgesetzt

### A) pipeline.jsx / pipeline.bundle.js (gebundelt, UMD-Global)
- **Lade-Kette** `pipeline.html:190-193`:
  ```
  react@18.3.1/umd/react.production.min.js
  react-dom@18.3.1/umd/react-dom.production.min.js
  cdn.jsdelivr.net/npm/reactflow@11.11.4/dist/umd/index.js
  /pipeline.bundle.js?v=20260515a
  ```
  CSS: `cdn.jsdelivr.net/npm/reactflow@11.11.4/dist/style.css` (`pipeline.html:9`).
- **Zugriff** `pipeline.jsx:1-3`: `const RF = window.ReactFlow;` — alle Komponenten als `RF.ReactFlow`, `RF.Background`, `RF.Controls`, `RF.MiniMap`, `RF.Handle`, `RF.ReactFlowProvider`.
- **Build** `package.json:25`: `esbuild src/ui/pipeline.jsx --bundle=false --loader:.jsx=jsx --jsx=transform --target=es2020 --minify --outfile=src/ui/pipeline.bundle.js`. **`--bundle=false`** heißt: React/ReactDOM/ReactFlow werden NICHT eingebunden, sondern als freie Globals erwartet (deshalb die UMD-Scripts im HTML). Es gibt **keinen import/export** im jsx — `React`, `ReactDOM`, `ReactFlow` sind via `/* global */`-Kommentar (`pipeline.jsx:1`) freie Bezeichner.
- **Bundle ist generiert** (`pipeline.bundle.js:1` `"use strict";const{useState,...}=React,RF=window.ReactFlow;…`, identischer Code, minifiziert). **→ Niemals das Bundle editieren; immer `pipeline.jsx` ändern und `npm run build:ui:pipeline` laufen lassen.**

### B) steuerfall-flow.html (esm.sh + htm)
- **importmap** `steuerfall-flow.html:183-193`: `react`, `react-dom`, `react-dom/client`, `reactflow` (alle `esm.sh@...`), `htm@3.1.1`.
- **ESM-Modul** `:195-201`: `import ReactFlow, { Background, Controls, MiniMap, Handle, Position, MarkerType, Panel } from "reactflow"; const html = htm.bind(React.createElement);` — JSX-frei, alles über `html\`...\``-Template-Literals.
- Mount `:496`: `createRoot(document.getElementById("flow")).render(html\`<${App} />\`)`.

**Die beiden Stile sind inkompatibel zu mischen:** pipeline nutzt JSX + UMD-Globals, steuerfall-flow nutzt htm + ES-Module. Für die Koexistenz in `steuerfall.html` muss man **eine** Schiene wählen (siehe §4).

---

## 2. Wie werden nodes/edges definiert und mit Daten gefüttert (pipeline.jsx)

### Custom Node-Typen (das wiederverwendbare Muster)
- `pipeline.jsx:335`: `const nodeTypes = { stage: StageNode, container: ContainerNode, fanout: FanoutNode };`
- `StageNode` `:166-225` — rendert `data.label`, `data.sub`, State-Badge (`idle/running/ok/error/skipped` `:167-169`), KPI-Chips (`data.kpis[] {label,value,tone}` `:192-201`), Progress-Bar (`data.progress.value` `:202-209`), **Laufzeit `data.ms` via `fmtDur` `:210`**, und **historische Mittelwerte `data.avgMs`/`avgOutputSize` `:211-221`**. Handles links(target)/rechts(source) `:176,222`.
- `ContainerNode` `:234-298`, `FanoutNode` `:305-333` (mit Branch-Chips + ms pro Branch).
- **Das ist genau die Node-Anatomie, die Tab 2 braucht** (Timing pro Stage ist bereits da; Input/Output/Prompt/Response müssten als zusätzliche `data.*`-Felder + Detail-Panel ergänzt werden).

### Node-/Edge-Konstruktion aus Workflow-Definition (datengetrieben)
- **nodes** `:3379-3434` (`useMemo`): `workflow.stages.map(...)` → pro Stage ein Node mit `type: isFanout?'fanout':'stage'`, `position` aus Auto-Layout/Override, und einem `data`-Objekt, das live-State (`stageStates[s.id]`), KPIs (`stageKpis[s.id]`), Field-Flow (`stageFieldFlow[s.id]`) und Aggregat-Stats (`statsByStage[s.id]`) zusammenführt. Plus Container-Nodes `:3412-3432`.
- **edges** `:3436-3463`: `workflow.edges.map(([a,b]) => ...)` mit `animated: stageStates[a/b].state==='running'` `:3441`; dazu gestrichelte Container→Stage-Referenzkanten `:3446-3461`.
- **Auto-Layout** `layoutWorkflow(wf)` `:116-160`: topologische Layer → Spalten (`COL_W=320, ROW_H=200` `:147`), vertikal zentriert. Genau das, was man für die Run-Visualisierung wiederverwenden kann.
- **Mount** `:3582-3615`: `<RF.ReactFlowProvider>` → `<FlowViewportManager>` (`:2848-2893`, kapselt `<RF.ReactFlow>` + Background/Controls/MiniMap + `fitView`-Logik). Node-Klick `:3589-3592` setzt `selectedStage` und öffnet ein Panel.

### Datenquellen pro Stage (read-only, bereits implementiert)
- **`streamRun`** `:2795-2846` — SSE-Parser für `POST /api/workflows/:id/run` (Live-Lauf). Event-Handler `onEvent` `:3473-3529` mappt `stage_start/stage_done/stage_error/stage_skipped` → `stageStates`, plus `fanout_*`/`branch_*`/`kpi_report`.
- **Replay/Per-Run-Inspektion** `:3140-3193` — bei gesetztem `runId` werden Stage-Outputs lazy nachgeladen via `GET /api/runs/:workflowId/:runId/stages/:stageId/output` (`server.ts:1779`). Auch Quality-Artefakte (fieldMapper, phase5Merge, bmfRechner …) per gleicher Route.
- **Replay-Einstieg per URL** `:3078-3084`: `?run=<runId>` → `runId` gesetzt → Artefakte geladen, ohne neu zu laufen. **Genau dieser Pfad ist die Brücke**: `steuerfall.html` verlinkt bereits `pipeline.html?workflow=…&run=<runId>` (`steuerfall.html:834`).

### Detail-Panel-Vorbild (das Herzstück für Tab 2)
- **`StageInspectorPanel`** `:2222-2401` — Bottom-of-Canvas-Panel, das bei Node-Klick aufgeht. Es zeigt bereits **3 Sektionen, die fast deckungsgleich mit der Tab-2-Anforderung sind**:
  - **Transformation** (`stage.description` + `inputPorts`/`outputPorts` aus `stage.hints`) `:2274-2313`
  - **KPIs** `:2316-2328`
  - **Eingaben** — aufgelöste `${stageId.field}`-Refs mit Live-Werten (`resolveInputRef` `:78-94`, Tabelle `:2330-2362`) → **das ist „Input je Stage"**
  - **Konfiguration** (`jsonToHtml(cfg)`) `:2364-2373`
  - **Ausgaben** — roher Output-Tree als Syntax-highlighted JSON (`:2375-2396`) → **das ist „Output je Stage"**
- `state.ms` wird im Panel-Header gezeigt `:2260` → **Timing je Stage ist da**.

**Fazit zu Detail-Reichtum:** Input/Output/Config/Timing/KPIs sind **vollständig vorhanden und read-only abrufbar**. Was fehlt → siehe §3.

---

## 3. Kann man EINEN Run mit Prompt/Response/externen-Calls rendern? — Die ehrliche Lücken-Analyse

**Input / Output / Timing pro Stage: JA, bereits vorhanden.** `StageInspectorPanel` + `/stages/:stageId/output` + `_result.json.stages[].ms`.

**Prompts an LLMs + Antworten / externe Schnittstellen mit Request+Response: NEIN — diese Daten werden nicht persistiert.** Belege:
- Der Runner hält zwar einen `persistedEvents`-Buffer (`runner.ts:193-202`) und der `RunResult`-Typ enthält `events` (`runner.ts:343`), **ABER auf der Platte fehlt das Feld**: Ich habe das jüngste echte `_result.json` (`runs/elster-v5_2/mp4b4lr8-z73qxd/_result.json`) geparst — top-level keys sind nur `['runId','workflowId','state','ms','stages']`, **`events` fehlt** (`events count: (none)`). Ältere/andere Runs können abweichen, aber der aktuelle Stand persistiert keine Events.
- Selbst wenn `events` da wäre: `log_*`-Events werden bewusst rausgefiltert (`runner.ts:195`), und die existierenden `ctx.emit`-Calls tragen **keine** Prompt-/Response-Texte. Stichprobe der Emit-Stellen: `mistral-small-ocr.ts:202/214/219` emittiert nur `{index,mode,chars}`; `klassifizierung.ts:542` nur `{anlagen,rejected}`; `dokument-typ.ts:39` nur `{typ_id}`. **Kein Stage emittiert den verschickten Prompt oder die rohe LLM-Antwort.** Es gibt **keine** Events wie `llm_request`/`llm_response`/`http_request`/`mcp_call` mit Payload-Body.
- Externe Calls (vLLM Gemma, Mistral, Ollama, BMF-MCP, ELSTER-MCP) sind nirgends als Request/Response-Paar abgelegt. Einzig `bmf_rechner_response.json` liegt als Artefakt im Run-Ordner (siehe `find`-Output) — also **eine** externe Response zufällig persistiert, aber nicht systematisch und ohne zugehörigen Request.
- `ctx.tools` (ToolContainer, `runner.ts:204-221`/`:306`) kapselt MCP-Aufrufe, instrumentiert sie aber nicht in ein abrufbares Audit-Log.

**Konsequenz für Tab 2:** Die Felder „welche Prompts gingen an LLMs + Antworten" und „welche externen Schnittstellen inkl. Request/Response" sind mit dem heutigen Datenbestand **nicht read-only befüllbar**. Das erfordert **Backend-Arbeit** (eigentliche Engine-Änderung, nicht nur UI):
  1. Stages müssten Prompt/Response/HTTP-Paare via `ctx.emit('llm_call', {prompt, response, model, ms})` o.ä. emittieren (bzw. ein Artefakt `${stageId}/calls.json` schreiben),
  2. der Runner müsste diese Events tatsächlich in `_result.json` persistieren (Buffer ist da, Persistenz ist abgeklemmt),
  3. ein token-freier Read-Endpoint analog `/runs/:runId/summary` müsste sie ausliefern.
  Das berührt CLAUDE.md Regel 2 (keine Modellnamen in user-facing Strings) und Regel 1 (keine Case-Daten — Prompts enthalten Dokumentinhalte; Persistenz davon ist sensibel, `runs/` ist aber ohnehin gitignored).

**Live-Run-Variante (Workaround ohne Persistenz):** Würde Tab 2 den Run **selbst live starten** (wie `steuerfall.html:977-1091` es für den Upload tut, bzw. wie `pipeline.jsx:streamRun`), könnte man Prompt/Response **im Moment des Laufs** zeigen — sofern die Stages sie emittieren. Für „einen vergangenen Run transparent nachzeichnen" reicht das nicht.

---

## 4. Wie montiert man ein ReactFlow-Panel INNERHALB des vanilla steuerfall.html

### Host-Page-Fakten (`steuerfall.html`)
- **Reines Vanilla-JS**, kein React/ReactDOM/ReactFlow geladen (`:7-10`: nur design-system CSS + lucide). Ein großer `<script>`-IIFE `:595-1650`.
- **Layout**: `.sturm-app` → `<aside id="sturm-nav-host">` (`:482`) + `.sturm-main` (`:484`). Der mittlere Bereich ist ein **zentrierter Scroll-Container** `:496` mit `.fall-wrap` (`max-width:960px`, `:12`), darin die Panels: Upload `:513`, Gesamterklärung `:530`, Live-Events `:555`, Versiegelung `:560`, Run-Historie `:565`, Canonical-Layer `:574`.
- **Mount-Punkt-Muster ist etabliert**: Der Sidebar wird per dynamischem ESM-Import gemountet (`:1614` `import('/nav.js').then(...)`) in `#sturm-nav-host`. Das beweist, dass die Seite ES-Module nachladen kann.
- **State**: globales `instance`-Objekt (`:671`, `loadInstance` `:697`) mit `instance.runs[]` (Run-IDs) und `instance.displayName`. Run-Historie + Modal (`renderRuns` `:759`, `openRunDetail` `:804`) nutzen bereits `/runs/:runId/summary` (`server.ts:1109`, liefert `stages[]{id,state,ms}`, `totalMs`, `fields`).
- **Wichtig**: Das Run-Detail-Modal verlinkt nach extern (`pipeline.html?...&run=...` `:834`) — d.h. die heutige „Transparenz" delegiert komplett an pipeline.html.

### Mount-Optionen (mit Bewertung)

**Option A — esm.sh + htm, isolierte React-Insel (empfohlen für schnellen, sauberen Tab 2).**
- Vorbild: `steuerfall-flow.html` (importmap `:183`, ESM-Import `:195`, `createRoot(...).render(...)` `:496`).
- Vorgehen: In `steuerfall.html` ein Tab-Container mit drei Buttons + drei `<div>`-Panes. Tab 2 = `<div id="flow-mount">`. Per `import('reactflow')` (esm.sh) eine kleine ReactFlow-Insel rein-rendern; Daten aus `/runs/:runId/summary` (Timing/State) + pro-Stage `/stages/:stageId/output` (Input/Output) ziehen.
- **Koexistenz unkritisch**: React läuft nur in dieser Insel, das restliche Vanilla-JS bleibt unberührt. importmap ist global, kollidiert aber mit nichts (steuerfall.html lädt sonst kein React).
- Token: `/runs/.../output` ist **token-gated** (`requireBearerToken`, `server.ts:1779`), steuerfall.html ist sonst token-frei. Entweder `authTokenQuery()`-Muster aus pipeline.jsx übernehmen (`:31-34`, liest `localStorage['sturm-token']`), **oder** besser einen token-freien App-scoped Endpoint analog `/runs/:runId/summary` ergänzen, der die Stage-Outputs ausliefert.

**Option B — pipeline.bundle.js wiederverwenden (UMD-Globals).**
- Man müsste in steuerfall.html die 3 UMD-Scripts (react/react-dom/reactflow) + CSS laden (`pipeline.html:190-193`). Dann steht `window.ReactFlow` bereit und man kann die **vorhandenen Komponenten** (`StageNode`, `StageInspectorPanel`, `layoutWorkflow`) nutzen — **aber** das Bundle exportiert nichts (es `createRoot`-mountet sofort auf `#root`, `pipeline.jsx:3675`). Man müsste pipeline.jsx refaktorieren, damit die wiederverwendbaren Teile als Modul/Global exportiert werden. Höherer Aufwand, aber maximale Wiederverwendung der reichen Inspector-Logik.

**Option C — iframe auf pipeline.html (pragmatischster „echter Run"-Weg).**
- Tab 2 = `<iframe src="/pipeline.html?workflow=${sum.workflowId}&run=${runId}">`. pipeline.html kann genau das schon (Replay via `?run=`, `:3078`). Null neuer ReactFlow-Code, sofort der volle Graph inkl. Inspector. Nachteil: zwei UIs, eigene Topbar/Sidebar im iframe, kein nahtloses Tab-Gefühl, und es zeigt auch nur Input/Output/Timing (Prompt/Response fehlen dort ebenso, §3).

### Switch Chat ↔ ReactFlow zwischen Tab 2/3
Reine Vanilla-State-Frage: ein Boolean (z.B. `swapPanels`) entscheidet, ob `#flow-mount` in Tab-2-Pane oder Tab-3-Pane hängt. Da React-Insel und Chat unabhängige DOM-Subtrees sind, genügt `appendChild`/`hidden`-Toggling der beiden Container — kein Re-Mount der React-Root nötig, wenn man die Container-Divs verschiebt statt zerstört. (Es gibt **noch keinen** Kurator-Chat in steuerfall.html — der ist separat zu bauen; `runs/ctx/abrechnung-design-chat-*/events.jsonl` deutet auf einen existierenden Chat-Mechanismus woanders hin, hier nicht im Scope geprüft.)

---

## 5. Konkrete wiederverwendbare Muster (Pfad:Zeile)

| Zweck | Vorbild |
|---|---|
| Custom Node mit State/KPIs/**Timing** | `pipeline.jsx:166-225` (`StageNode`), `fmtDur` `:343-348` |
| Reiches Detail-Panel (Input-Refs, Config, Output-JSON, ms) | `pipeline.jsx:2222-2401` (`StageInspectorPanel`) |
| Input-Ref-Auflösung `${stage.field}` read-only | `pipeline.jsx:78-94` (`resolveInputRef`), Tabelle `:2338-2358` |
| JSON-Syntax-Highlight ohne Lib | `pipeline.jsx:1963-1984` (`jsonToHtml`) |
| Auto-Layout (topo→Spalten) | `pipeline.jsx:116-160` (`layoutWorkflow`) |
| nodes/edges datengetrieben bauen | `pipeline.jsx:3379-3463` |
| ReactFlow mount + fitView + MiniMap | `pipeline.jsx:2848-2893` (`FlowViewportManager`), Provider `:3582` |
| SSE-Run-Stream parsen (Live) | `pipeline.jsx:2795-2846` (`streamRun`), Handler `:3473-3529` |
| Replay per `?run=` + Artefakt-Fetch | `pipeline.jsx:3078-3084`, `:3140-3193` |
| esm.sh+htm ReactFlow-Insel + Lane-Styling/IN-OUT-Chips/Service-Nodes | `steuerfall-flow.html:183-201, 205-280, 423-459, 468-496` |
| Vanilla-Mountpunkt + dyn. ESM-Import in steuerfall.html | `steuerfall.html:482, 1614-1629` |
| Run-Liste + Summary (Timing/State/fields, token-frei) | `steuerfall.html:759-837`; Endpoint `server.ts:1109-1156` |
| Stage-Output read (token-gated!) | `server.ts:1779-1791` |
| Bundle-Build-Befehl (nach jsx-Edit auszuführen) | `package.json:25` |

## 6. Empfehlung in einem Satz
Tab 2 mit einer **esm.sh+htm ReactFlow-Insel** (Option A) bauen, die `layoutWorkflow`/`StageNode`/`StageInspectorPanel`-Muster aus pipeline.jsx als Vorlage übernimmt und ihre Daten aus `/runs/:runId/summary` (Timing/State, bereits token-frei) + Stage-Outputs zieht — wobei für die geforderten **Prompt/Response/External-Call-Panels zuerst Backend-Instrumentierung** nötig ist (Stages emittieren+persistieren diese Daten heute nicht; `_result.json` enthält kein `events`-Feld), oder dieser Teil per **Live-Run** statt Replay realisiert wird.

---

### Recon: chat-embed

I have a complete picture. Here is the recon report.

---

# Recon "chat-embed": Orchestrator-Chat als Tab-Panel in `steuerfall.html`

## Kurzfazit

Der bestehende Orchestrator-Chat ist **vollstaendig wiederverwendbar als Embed** und passt exakt zu Tab 3 (Kurator-Chat). Er ist eine eigenstaendige, gerahmte Vanilla-JS-Seite (`orchestrator.html`) ohne externe JS-Abhaengigkeiten, deren Send-Loop bereits zwei Endpunkte (`chat-stream` SSE / `chat-sync` JSON) kann und auf eine `caseId` scopt. Es gibt **kein extrahierbares Chat-Widget-Modul** — die gesamte Logik liegt in einer einzigen anonymen IIFE im `<script>`-Block; fuer den Embed muss diese Logik kopiert/in ein Modul gehoben oder die Seite per `<iframe>` eingebettet werden. Eine 404-Degradation ist **nicht implementiert** (siehe Luecken).

---

## 1. Endpunkte & Mounting

Router-Factory: `src/server/orchestrator.ts:645` (`createOrchestratorRouter`). Gemountet unter Prefix `/api/orchestrator` in `src/server.ts:273`, fest mit `appId: 'steuerfall-est'` (`src/server.ts:274`). **Wichtig: Das Mounting ist bedingt** — nur wenn `resolveOrchestratorVllm()` ein erreichbares vLLM/Gemma liefert (`src/server.ts:271-272`). Ohne vLLM existiert der gesamte Router nicht (`src/server.ts:282-283` loggt "nicht aktiviert"), d.h. **alle drei Endpunkte liefern dann 404**.

Drei (+1) Routen:

| Route | Methode | Pfad (absolut) | Vertrag | Definition |
|---|---|---|---|---|
| Tools-Liste | GET | `/api/orchestrator/tools` | JSON `{appId, model, tools[]}` | `orchestrator.ts:648` |
| Chat (SSE, echtes vLLM-Streaming) | POST | `/api/orchestrator/chat` | SSE `token`/`tool_call`/`tool_result`/`done`/`error` | `orchestrator.ts:660` |
| **Chat-Sync** (JSON, nicht-streamend) | POST | `/api/orchestrator/chat-sync` | JSON `{reply, iterations, steps[], totalMs, mode}` | `orchestrator.ts:692` |
| **Chat-Stream** (SSE auf chat-sync-Loop) | POST | `/api/orchestrator/chat-stream` | SSE `token_chunk`/`tool_call`/`tool_result`/`done`/`error` | `orchestrator.ts:724` |

**Welche nutzt das UI:** Die Default-Route der Chat-Seite ist `chat-stream` (`orchestrator.html:455`); `chat-sync` ist die Escape-Hatch via `?mode=sync` in der Seiten-URL (`orchestrator.html:427-431`). Die echte `/chat`-Route (vLLM-Streaming mit OpenAI-Tools + Fallback-Probe, `orchestrator.ts:660`) wird vom UI **nicht** verwendet — vermutlich wegen des im Code dokumentierten helmet+SSE-Flush-Bugs (`orchestrator.ts:722-723`). Fuer den Embed also `chat-stream` (primaer) + `chat-sync` (Fallback) anbinden, `/chat` ignorieren.

**Request-Body (alle drei POST identisch):**
```json
{ "caseId": "<optional>", "appId": "steuerfall-est", "messages": [ {"role":"user","content":"…"} ] }
```
Definiert in `orchestrator.html:434-439` (sync) bzw. `:458-463` (stream).

---

## 2. caseId-Scoping

Zwei-stufig, sauber durchgereicht:

- **Client:** `caseId: caseSelect.value || undefined` im Body (`orchestrator.html:436`, `:460`). Quelle ist das `<select id="caseSelect">` (`orchestrator.html:261`), befuellt aus `GET /api/applications/steuerfall-est/instances` (`orchestrator.html:312`), wobei `opt.value = inst.caseId` (`orchestrator.html:318`).
- **Server:** `body.caseId` → `runChatLoop*(opts, messages, body.caseId, …)` (`orchestrator.ts:677`, `:706`, `:753`) → landet als `caseIdHint` im `OrchestratorHandlerCtx` (`orchestrator.ts:306`, `:545`).
- **Tool-Aufloesung:** `resolveCaseId(args, ctx)` (`orchestrator-tools.ts:59-62`) — Prioritaet ist `args.caseId` (vom LLM gesetzt) **vor** `ctx.caseIdHint`. D.h. der Picker liefert nur den **Default**; das LLM kann den Fall pro Tool-Call ueberschreiben. Fast alle Tools verlangen `caseId` als `required` (z.B. `fall_status` `orchestrator-tools.ts:178`).

**`appId`-Guard:** Body-`appId` muss zum gemounteten Router passen, sonst 400 — `orchestrator.ts:671-673` (chat), `:702-704` (sync), `:734-736` (stream). Beim Embed in `steuerfall.html` ist `APP_ID` aus `?app=` (`steuerfall.html:633`) bereits `steuerfall-est`, passt also; man kann `appId` weglassen (Guard greift nur `if (body.appId && …)`).

**Embed-Vorteil:** In `steuerfall.html` sind `APP_ID`/`CASE_ID` schon aus der URL geparst (`steuerfall.html:622`, `:633-634`). Der eingebettete Chat braucht also **keinen eigenen Case-Picker** — `caseSelect.value` faellt weg, stattdessen direkt `CASE_ID` in den Body. Der gesamte `loadCases()`-Block (`orchestrator.html:310-328`) und der Header (`orchestrator.html:253-265`) entfallen im Embed.

---

## 3. Das wiederverwendbare "Chat-Widget" (Zeilen)

Es gibt **keine gekapselte Komponente** — eine einzige IIFE `orchestrator.html:294-555`. Aufteilung fuer den Embed:

**Markup (uebernehmen, ohne Header/Picker):**
- Chat-Log-Container: `orchestrator.html:267-277` (`<main class="orch-chat" id="chatLog">` + `#emptyState` mit Hint-Buttons `:270-275`)
- Eingabezeile: `orchestrator.html:279-291` (`#userInput`, `#sendBtn`, `#abortBtn`, `#statusLine`)
- **Verwerfen:** Header `:253-265` (Titel + Case-Picker), da Fall-Kontext aus `steuerfall.html` kommt.

**CSS:** `orchestrator.html:10-250` — alle `.orch-*`-Klassen. Nutzt durchgaengig `var(--color-*)` aus dem geteilten Design-System (`/design-system/colors_and_type.css`, geladen in beiden Seiten), d.h. **portabel ohne Anpassung**. `body{height:100vh;display:flex}` (`:11-19`) muss beim Embed durch Tab-Panel-Hoehe ersetzt werden.

**JS-Bausteine (die eigentliche Logik):**
- Bubble-Factory `startAssistantBubble()` `:347-397` — liefert `{appendToken, appendToolChip, finalize}`. Tool-Chips inkl. aufklappbarem Detail (Request/Response-JSON) `:367-391` — **direkt relevant fuer Tab 2** (Schnittstellen-Transparenz).
- `appendUserBubble()` `:335-345`, `ensureNotEmpty()` `:331-333`, `shortJson()` `:399-404`.
- **Send-Loop `send(text)` `:407-531`** — das Herzstueck. Enthaelt sync-Pfad `:430-452`, stream-Pfad `:453-481`, SSE-Block-Parser `handleSseBlock()` `:498-530`. History-Array `:306` wird mitgeschickt (`messages: history` `:438`, `:462`) und nach Abschluss um die Assistant-Antwort ergaenzt `:487-490`.
- Event-Wiring `:533-551` (Send-Button, Cmd/Ctrl+Enter `:536-541`, Auto-Resize `:542-545`, Hint-Prompt-Buttons `:546-551`).
- Abort via `AbortController` `:421`, `:535`.

**Konkreter Embed-Pfad:** Die IIFE referenziert ihre DOM-Knoten per `document.getElementById` (`:296-303`). Fuer mehrere Tabs/Panels in einer Seite muss das auf `panel.querySelector(...)` umgestellt und in eine `function mountKuratorChat(rootEl, {appId, caseId})`-Factory gehoben werden. Die einzige externe Abhaengigkeit der Factory ist `caseSelect.value` (`:436`, `:460`) → ersetzen durch den uebergebenen `caseId`. **`APP_ID`-Konstante** `:295` ist hartkodiert `'steuerfall-est'` — beim Embed durch den Parameter ersetzen.

**Alternative ohne Refactor:** `<iframe src="/orchestrator?case=…">`. Geht heute aber **nicht sauber**, weil `orchestrator.html` den Fall nur ueber den internen Picker waehlt und keine `?case=`-URL-Param liest (kein `URLSearchParams` fuer `case`/`app` in der Datei; das einzige `URLSearchParams` `:427` liest nur `mode`). Ein iframe wuerde also den Picker zeigen statt auf `CASE_ID` zu scopen — Refactor (Factory) ist der sauberere Weg.

---

## 4. 404-/Fehler-Degradation

**Es gibt keine gezielte 404-Behandlung.** Verhalten heute:

- `send()` prueft im stream-Pfad `if (!res.ok || !res.body) throw new Error('HTTP ${res.status}…')` (`orchestrator.html:465`), im sync-Pfad analog `:441`. Bei 404 (Router nicht gemountet, weil kein vLLM) wirft `fetch` selbst nicht — es kommt eine echte 404-Response, der `throw` greift, der `catch` `:482-485` schreibt `[Fehler: HTTP 404: …]` als Token in die Bubble. **Funktional, aber haesslich** (kein Feature-Disable, kein leerer Zustand).
- `loadCases()` (im Embed entfallend) hat einen eigenen try/catch `:325-327`, der nur die Statuszeile setzt.
- **Kein Capability-Check vorab:** Die Seite ruft nie `GET /api/orchestrator/tools` auf, um zu erkennen, ob der Orchestrator ueberhaupt aktiv ist. Genau das fehlt fuer ein sauberes Embed.

**Empfehlung fuer den Embed:** Beim Aktivieren von Tab 3 einmal `GET /api/orchestrator/tools` pingen; bei `!res.ok` (404) den Tab deaktiviert/ausgegraut anzeigen ("Kurator nicht verfuegbar — kein Steuer-LLM gebunden") statt einer Fehler-Bubble. Das ist der einzige robuste 404-Pfad, und der Server liefert dieses Signal bereits implizit (Router-Existenz == vLLM vorhanden, `src/server.ts:271-283`).

---

## 5. Bezug zur geplanten Opus-"Kurator"-Anbindung

- **Heutiges Backend ist Gemma-4/vLLM, nicht Opus.** Modell kommt aus `resolveOrchestratorVllm()` → `modelName` (`server.ts:276`, in Tool-Loop `orchestrator.ts:339-346`, `:466-482`). Der System-Prompt nennt sich neutral "STURM-Steuerassistent" und verbietet explizit Modellnamen wie "gemma-4" in Antworten (`orchestrator.ts:87-88`) — passt zur CLAUDE.md-Regel "Keine Modellnamen in User-facing Strings". Fuer eine Opus-Kurator-Variante muesste ein zweiter Router/Provider gemountet werden (eigener vLLM-/Anthropic-Pfad); die Tab-3-UI bleibt identisch, nur das `fetch`-Ziel/`appId` aendert sich.
- **System-Prompt ist injizierbar:** `OrchestratorOptions.systemPrompt` (`orchestrator.ts:53`, genutzt `:309`, `:547`) ueberschreibt `DEFAULT_SYSTEM_PROMPT` (`orchestrator.ts:72-90`). Aktuell wird er **nicht** aus `server.ts` gesetzt (`server.ts:273-280` lassen ihn weg → Default). Ein "Kurator, der den Fall erfragt/optimiert" liesse sich also rein durch Setzen von `systemPrompt` beim Mount realisieren, ohne Loop-Aenderung.
- **Werkzeugkatalog ist fall-zentriert** (`orchestrator-tools.ts:143-577`): `liste_faelle`, `fall_status`, `fall_dokumente`, `auswertung`, `verdaechtige_felder`, `pflicht_luecken`, `tool_health`, `fall_versiegeln`, `fall_exportieren`, `paragraph_lookup`. Genau die "optimiere/erfrage den Fall"-Semantik (z.B. `pflicht_luecken` + `verdaechtige_felder` vor `fall_versiegeln`, erzwungen via `bestaetigt`-Flow `orchestrator-tools.ts:438-446`). Damit ist Tab 3 inhaltlich tragfaehig, sobald ein Modell gebunden ist.
- **Tool-Transparenz fuer Tab 2:** Die SSE-Events `tool_call`/`tool_result` tragen `name`, `args`, `result`, `durationMs`/`ms` (`orchestrator.ts:411`, `:430` echtes `/chat`; `:588`, `:601` sync/stream). Der Loop misst pro Tool die Dauer (`t0`/`durationMs` `orchestrator.ts:422-430`; `tCall`/`ms` `:589-601`). **Das ist genau die Datenquelle, die Tab 2 (Stage-Zeiten, Schnittstellen-Request/Response, LLM-Prompts) braucht** — aber siehe Luecken: Prompt-Texte und externe HTTP-Request/Response werden NICHT exponiert.

---

## 6. Luecken (was NICHT vorhanden ist)

1. **Kein Tab-System, kein ReactFlow, kein Switch in `steuerfall.html`.** Heute ist die Seite ein einspaltiges Fall-Dashboard (1652 Zeilen, kein `tab`/`iframe`). ReactFlow existiert nur in `src/ui/0711-fleet.html` (`reactflow@11.11.4` via esm.sh, `0711-fleet.html:89`) und in der generischen `pipeline.html` — **nicht** in `steuerfall.html`. Tabs (1)+(2)+(3) und der Chat/Flow-Switch sind komplett zu bauen.
2. **Kein wiederverwendbares Chat-Modul.** Logik liegt in einer anonymen IIFE mit `getElementById` auf globale IDs (`orchestrator.html:294-555`). Fuer ein Embed neben anderen Panels muss sie in eine scope-bare Factory (`querySelector`-basiert, Parameter `appId`/`caseId`) gehoben werden. Kein Export, kein ES-Modul.
3. **Keine Capability-/404-Degradation** (siehe §4). 404 endet heute als Fehler-Token in der Bubble; kein Vorab-Check via `/tools`.
4. **`orchestrator.html` liest keinen `?case=`/`?app=`-URL-Param** (nur `?mode=`, `:427`). Ein reines iframe-`src="/orchestrator?case=…"` scopt deshalb **nicht** automatisch — der Picker bleibt. Saubere Anbindung braucht entweder den Factory-Refactor oder eine kleine Erweiterung in `orchestrator.html`, die `?case=`/`?app=` liest und den Picker vorbelegt/versteckt.
5. **Tab-2-Datenbedarf nur teilweise gedeckt.** Aus dem Chat-Loop kommen Tool-Name/Args/Result/Dauer — **aber NICHT**: (a) die an das LLM gesendeten Prompts/Antworten (werden nirgends als Event/Artefakt exponiert; `messages` bleiben serverseitig in `orchestrator.ts`), (b) externe HTTP-Request/Response der Tools (Tools rufen Files/Container direkt, z.B. `tool_health` ueber `getToolContainer().healthAll()` `orchestrator-tools.ts:394-398`; RAG via `rag.retrieveCascade` `:563` — kein roher Request/Response wird zurueckgegeben). Fuer Tab 2 ("welche externen Schnittstellen, inkl. Request/Response; welche Prompts gingen an LLMs") ist die **Run-Artefakt-Ebene** die richtige Quelle (`runs/<workflow>/<run-id>/<stage>/output.json`, vgl. `loadLatestCanonicalLayer` `orchestrator-tools.ts:92-121`), **nicht** der Orchestrator-Chat. Der Chat liefert nur die Kurator-Interaktion (Tab 3), nicht die Stage-Forensik (Tab 2).
6. **Tab 2 ist eine separate Recon-/Bauaufgabe.** Der Orchestrator-Chat deckt Tab 3 ab; die vollstaendige Run-Visualisierung (Stage-IO, Prompts, Interface-Calls) muss aus der Runner-/Artefakt-Schicht gespeist werden (`src/core/`, `runs/`), die in diesen drei Dateien nicht behandelt wird.

---

## Relevante Pfade (absolut)

- `/Users/christophbertsch/Desktop/sturm.0711.io/.claude/worktrees/optimistic-davinci-584d2b/src/ui/orchestrator.html` — Chat-UI (CSS `:10-250`, Markup `:253-291`, IIFE/Logik `:294-555`)
- `/Users/christophbertsch/Desktop/sturm.0711.io/.claude/worktrees/optimistic-davinci-584d2b/src/server/orchestrator.ts` — Router `:645-771`, Endpunkte `chat:660` / `chat-sync:692` / `chat-stream:724` / `tools:648`, System-Prompt `:72-90`
- `/Users/christophbertsch/Desktop/sturm.0711.io/.claude/worktrees/optimistic-davinci-584d2b/src/server/orchestrator-tools.ts` — Werkzeugkatalog `:143-577`, `resolveCaseId` `:59-62`
- `/Users/christophbertsch/Desktop/sturm.0711.io/.claude/worktrees/optimistic-davinci-584d2b/src/server.ts` — bedingtes Mounting `:270-285`, Page-Routes `/orchestrator` `:1832-1833`
- `/Users/christophbertsch/Desktop/sturm.0711.io/.claude/worktrees/optimistic-davinci-584d2b/src/ui/steuerfall.html` — Ziel-Seite; `APP_ID`/`CASE_ID` aus URL `:622`,`:633-634`; Guard ohne Param `:636`; kein Tab/iframe/ReactFlow vorhanden
- `/Users/christophbertsch/Desktop/sturm.0711.io/.claude/worktrees/optimistic-davinci-584d2b/src/ui/0711-fleet.html` — einzige bestehende ReactFlow-Referenzimplementierung (`:89`) als Vorlage fuer Tab 2

---

### Recon: endpunkte

I now have a complete, evidence-backed picture. Compiling the report.

# Recon „endpunkte" — Pro-Run-Transparenz für Tab 2 (steuerfall.html)

Alle Belege als `Pfad:Zeile`. Pfade relativ-gekürzt: `server.ts` = `/Users/christophbertsch/Desktop/sturm.0711.io/.claude/worktrees/optimistic-davinci-584d2b/src/server.ts`, `runner.ts`/`artifacts.ts`/`events.ts` = `…/src/core/…`, `workflow-stats.ts` = `…/src/server/workflow-stats.ts`.

## 1. Fundamentale Begrenzung: Was landet überhaupt pro Run auf der Platte?

Der Runner persistiert pro Run nur drei Sorten Artefakte (`runner.ts`):
- `_meta.json` — `{ runId, workflowId, startedAt }` (`runner.ts:155`).
- `<stageId>/output.json` — der **sanitisierte** Output jeder OK-Stage (`runner.ts:204`).
- `_result.json` — `{ runId, workflowId, state, ms, stages: { <id>: { stageId, state, ms, output?, error? } } }` (`runner.ts:228-229`).

Layout fix in `artifacts.ts:8-13` (`runs/<workflowId>/<runId>/<stageId>/<file>`). Wichtig: **Outputs werden vor dem Schreiben durch `sanitizeForLog` gekürzt** — Strings > 2000 Zeichen abgeschnitten, Buffer zu `[Buffer N bytes]`, Arrays auf 50 Elemente, Tiefe 4 (`runner.ts:203-204,253-267`). Der auf Platte liegende `output.json` ist also bereits eine gekürzte Sicht, nicht das Roh-Output.

**Timings**: Pro-Stage `ms` und Run-`ms` werden in `_result.json` geschrieben (`runner.ts:201,213,227-228`). `startedAt` in `_meta.json`. Es gibt **kein** `finishedAt` pro Stage, nur Run-Gesamt-`ms` und (in manchen Konsumenten erwartetes) `finishedAt` auf Run-Ebene — letzteres schreibt der Runner aber gar nicht (`workflow-stats.ts:162` liest `parsed.finishedAt`, das `runner.ts` nie setzt → de facto immer `null`).

**Prompts & externe I/O: NICHT persistiert.** Es gibt keinen Mechanismus, der LLM-Prompts, LLM-Antworten oder MCP/HTTP-Request/Response pro Stage auf Platte schreibt. Diese Daten existieren nur flüchtig auf dem `EventBus` während des Laufs (`events.ts:21-34`) und werden live als SSE rausgestreamt. Nach Run-Ende sind sie weg. Zwei Teil-Ausnahmen (die einzigen Stellen, an denen Roh-LLM-Material überhaupt auf Platte kommt):
  - `qualitaetsgate/raw_responses.json` — `[{ chunk, raw: <auf 4000 chars gekürzt> }]`, nur die **Antwort**, ohne den Prompt (`…/src/workflows/elster/stages/qualitaetsgate.ts:296,319,415`).
  - `llm-ensemble-vote` schreibt `per_model_raw.json` (`…/src/stages/llm-ensemble-vote.ts`), ebenfalls nur Roh-Antworten pro Modell, kein Prompt.

  Beide sind stage-spezifisch, nicht workflow-übergreifend, und der Prompt selbst (z. B. `buildGatePrompt(...)`) wird nirgends abgelegt.

## 2. HTTP-Endpunkte, die HEUTE Pro-Run-Daten an den Browser liefern

Geordnet nach Relevanz für Tab 2. Token-Status notiert (alle case-scoped Routen sind absichtlich `requireBearerToken`-frei, Kommentar `server.ts:294-298`).

| Methode | Pfad | Zeile | Shape (was es liefert) | Token |
|---|---|---|---|---|
| GET | `/api/applications/:appId/instances/:caseId/runs/:runId/summary` | `server.ts:1104-1151` | `{ runId, workflowId, startedAt, state, totalMs, stages: [{ id, state, ms, error }], fields }`. Liest `_meta.json` + `_result.json`. **Dies ist der existierende Run-Detail-Endpunkt** — am nächsten an Tab 2, aber nur Stage-Liste + Timing + Status, **kein Output-Inhalt, keine Prompts, keine externe I/O**. | nein |
| GET | `/api/applications/:appId/instances/:caseId/runs/:runId/progress` | `server.ts:1159-1202` | `{ runId, workflowId, completedStages: string[], finished }`. Reines Polling-Lite via Verzeichnis-Scan, scannt notfalls alle Workflows nach der runId. Keine Timings/Outputs. | nein |
| GET | `/api/workflows/:id/stats` | `server.ts:236-247` | Aggregat über letzte N Runs (`computeWorkflowStats`, `workflow-stats.ts:118-208`): pro Stage `avgMs/p95Ms/samples/errorRate/avgOutputSize/outputSizeUnit`, pro Workflow `runs/successRate/avgMs/p95Ms/lastRunAt`. **Workflow-weit, nicht ein konkreter Run** — für Tab 2 (genau EIN Run) nur als Vergleichs-Baseline brauchbar. | nein |
| GET | `/api/runs/:workflowId/:runId` | `server.ts:1689-1697` | Liefert das **rohe `_result.json`** 1:1 (`{ state, ms, stages: {<id>: { stageId, state, ms, output(sanitized), error }}}`). Enthält bereits die sanitisierten Stage-**Outputs** inline. Reichste Run-Quelle, aber: nur `workflowId/runId` (nicht case-scoped) **und Token-pflichtig**. | **ja** |
| GET | `/api/runs/:workflowId/:runId/stages/:stageId/output` | `server.ts:1774-1786` | Roh-`<stageId>/output.json` einer einzelnen Stage. Genau der Per-Stage-Output-Body, den Tab 2 pro Knoten braucht — aber pro Stage einzeln, und Token-pflichtig. | **ja** |
| GET | `/api/runs/:workflowId/:runId/_input.json` | `server.ts:1700-1708` | `{ filename, originalFilename, size, mime, persistedAt }` — Run-Input-Metadaten. | **ja** |
| GET | `/api/runs/:workflowId/:runId/_input/:filename` | `server.ts:1710-1715` | Die hochgeladene Originaldatei (Beleg) selbst. | **ja** |
| GET | `/api/workflows/:id/runs` | `server.ts:1648-1687` | Run-Liste (≤20) eines Workflows: `[{ runId, state, ms, kpiScore, finishedAt }]`. Run-Auswahl, kein Detail. | **ja** |
| GET | `/api/applications/:appId/instances/:caseId/master` | `server.ts:924-958` | Persistiertes `master.json` (P2) — case-level, fasst den letzten/aggregierten Extraktions-Stand zusammen inkl. Citation-Chain `{page, snippet}`. Fall-Ergebnis, nicht Run-Mechanik. | nein |
| GET | `/api/applications/:appId/instances/:caseId/result` | `server.ts:298-365` | Aggregat des **letzten** extraction-Runs: `{ runId, canonical_layer, eric_xml, source, stats }`. Liest `phase7Validator/phase6BmfRechner/phase5Merge`-Outputs. Ergebnis-zentriert. | nein |
| GET | `/api/applications/:appId/instances/:caseId/aggregate` | `server.ts:965-1025` | Case-Aggregation über alle Belege: `{ merged_layer, conflicts, pflicht_missing, …, bmf? }`. | nein |
| GET | `/api/applications/:appId/instances/:caseId` | `…/src/server/applications.ts:172-180` | Die Instance: u. a. `runs: string[]`, `documents: [{ runId, filename, anlagen, fieldsExtracted, trustBreakdown, … }]`. **Die Run-IDs eines Falls kommen von hier** — Voraussetzung, um die Run-Liste für Tab 2 zu füttern. | nein |

Workflow-Definition (für die ReactFlow-Topologie — Knoten/Kanten/Ports, statisch, nicht run-spezifisch): `GET /api/workflows/:id` → `summarizeWorkflow` mit `stages[{id,uses,name,description,hints,inputs,config}]` + `edges` + `containers` (`server.ts:192-231`).

**Live-SSE (während ein Run läuft, nicht für Nachbetrachtung):** Hier — und nur hier — fließen Prompts/Logs/externe Signale. `POST …/instances/:caseId/upload` (`server.ts:446-537`), `…/upload-bulk` (`server.ts:542-713`), `POST /api/workflows/:id/run` (`server.ts:1558-1642`). Der Bus re-emittiert `stage_start/stage_done/log_*` plus die ~60 Custom-Events der Stages (`ensemble_model_done`, `mistral_small_ocr_page`, `gemma_vision_ocr_started`, `ocr_done`, `llm_vote`, `regex_hits`, … — Inventar via Grep über `ctx.emit`). Auch diese sind **sanitisiert** und werden **nicht gespeichert**. Tab 2 als Nachbetrachtung eines abgeschlossenen Runs sieht davon nichts.

## 3. Gibt es schon einen run-summary/detail-Endpunkt zum Erweitern?

Ja — zwei Kandidaten, beide unvollständig für „alle Transparenz":

1. **`…/runs/:runId/summary`** (`server.ts:1104-1151`) ist der natürliche Erweiterungspunkt: case-scoped, token-frei, kennt bereits `appId→extractionId→runDir`. Liefert heute aber nur Stage-Namen + Timings + Status + Feld-Count. Es fehlt: Per-Stage-Input, Per-Stage-Output-Body, Prompts, externe I/O.
2. **`/api/runs/:workflowId/:runId`** (`server.ts:1689-1697`) liefert das vollständige (sanitisierte) `_result.json` inkl. Stage-Outputs — die inhaltsreichste Quelle —, ist aber **token-pflichtig** und **nicht case-scoped** (Tab-2-UI ist token-frei und kennt nur appId/caseId, nicht direkt workflowId).

## 4. Welcher NEUE Endpunkt ist für Tab 2 nötig

Tab 2 braucht „alle Transparenz EINES Runs": pro Stage Zeit + Input + Output + welche externen Schnittstellen mit welchem Request/Response + welche Prompts mit welchen Antworten. Realistisch heißt das **zweistufig**:

**A) Sofort baubar aus dem, was auf Platte liegt — neuer Aggregat-Endpunkt:**

`GET /api/applications/:appId/instances/:caseId/runs/:runId/detail`

Case-scoped, token-frei, analog zu `summary`. Aggregiert in einer Antwort:
- `meta` (aus `_meta.json`) + `input` (aus `_input.json`, `server.ts:1700`),
- die **Workflow-Definition** (`summarizeWorkflow`, `server.ts:192`) für Knoten/Kanten/Ports,
- pro Stage: `{ id, uses, name, state, ms, error, inputs (aufgelöste Werte), output (Body aus `<stageId>/output.json`) }` — d. h. den ganzen Stage-Output-Inhalt inline, statt heute einen Roundtrip pro Stage über die token-pflichtige Route `…/stages/:stageId/output` (`server.ts:1774`),
- die wenigen vorhandenen Roh-LLM-Artefakte (`qualitaetsgate/raw_responses.json`, `llm-ensemble-vote/per_model_raw.json`) sofern vorhanden.

Damit ist „Zeit pro Stage + Input/Output je Stage" vollständig — read-only, kein Stage-/Runner-Eingriff. Es ist im Kern eine case-scoped, token-freie, voll-aggregierende Variante von `…/runs/:runId/summary` + `/api/runs/:workflowId/:runId`.

**B) Echte Lücke — erfordert Persistenz-Erweiterung im Runner, NICHT nur einen Endpunkt:**

„Welche externen Schnittstellen mit Request/Response" und „welche Prompts mit Antworten" sind **heute nirgends gespeichert** (siehe §1). Ein Endpunkt allein kann sie nicht liefern. Nötig wäre vorgelagert:
- ein Stage-übergreifender Trace-Sink, der LLM-Calls (Prompt + Modell + Antwort) und MCP/HTTP-Calls (URL + Request-Body + Response + Latenz) pro `(runId, stageId)` als Artefakt schreibt — z. B. `<stageId>/_io.json` bzw. `<stageId>/_prompts.json`. Anknüpfpunkte: zentral in `ctx` (`runner.ts:186-198`, neues `ctx.trace(...)`) oder in den Tool-Handles (`getByRole<LlmHandle>`/`McpHandle`), damit es alle Stages automatisch erfasst statt 60× einzeln.
- die `sanitizeForLog`-Kürzung (`runner.ts:253-267`) müsste für diese Trace-Artefakte umgangen/konfigurierbar werden, sonst sind Prompts > 2000 Zeichen abgeschnitten.

Erst danach kann der Endpunkt aus (A) diese Felder mitliefern.

## 5. Ehrliche Lücken-Liste (was NICHT vorhanden ist)

- **Keine Prompt-Persistenz.** Prompts werden in Stages gebaut (`…/stages/quality/critic-llm.ts:261`, `qualitaetsgate.ts:296`, `mistral-small-ocr.ts:75`, `lighton-ocr.ts:65`, `gemma-vision-ocr.ts:152`, `llm-ensemble-vote.ts:159`) und direkt verschickt — nirgends gespeichert.
- **Keine externe-I/O-Persistenz.** Kein Request/Response-Log für MCP, vLLM, Ollama, BMF-MCP etc. auf Platte. MCP-Aufrufe sind nur als Live-Health unter `…/mcps/health` (`server.ts:1032`, deprecated) / `…/tools/health` (`server.ts:1083`) sichtbar — Health, nicht Call-Trace.
- **Kein Endpunkt liefert die aufgelösten Stage-Inputs** eines Runs. Der Runner kennt sie zur Laufzeit (`resolveInputs`, `runner.ts:38-49,183`), verwirft sie aber. Tab 2 müsste sie aus `output.json` der Vorgänger-Stage + `summarizeWorkflow().stages[].inputs` rekonstruieren — oder (A) reicht sie mit.
- **Stage-Outputs sind nur sanitisiert verfügbar** (gekürzt, `runner.ts:204`). Roh-Outputs existieren nicht auf Platte. Für „vollständig transparent" ist das eine inhärente Decke, sofern man die Sanitisierung nicht aufweicht.
- **`finishedAt` pro Run wird nie geschrieben** (`runner.ts` setzt es nicht; `workflow-stats.ts:162` und der `runs`-Lister `server.ts:1676` lesen es ins Leere).
- **Kein einziger case-scoped, token-freier Endpunkt liefert Stage-Output-Bodies.** Die einzige Output-Body-Quelle (`…/stages/:stageId/output`, `server.ts:1774`) ist token-pflichtig und pro Stage einzeln — für eine token-freie Tab-2-UI unbrauchbar ohne Token.
- **Kurator-Chat (Tab 3) ist zustandslos und wird nicht persistiert.** `/api/orchestrator/chat` und `/chat-sync` nehmen `messages[]` aus dem Client-Body, schreiben kein Transcript pro Fall/Run (`…/src/server/orchestrator.ts:660-712`). `runsDir` wird zwar in den Router gereicht (`server.ts:279`, `orchestrator.ts:47,304,543`), aber für Tool-Ausführung, nicht für Chat-Verlauf. Falls Tab 3 einen historischen Verlauf zeigen soll, existiert dafür heute keine Quelle.

**Fazit für Tab 2:** Für „Zeit + Input/Output pro Stage" genügt ein neuer case-scoped Aggregat-Endpunkt (A), der bereits vorhandene Platten-Artefakte bündelt — bevorzugt durch Anreichern des existierenden `…/runs/:runId/summary` (`server.ts:1104`). Für „externe Schnittstellen-Calls + Prompts/Antworten" muss zuerst der **Runner/Tool-Layer** ein Trace-Artefakt pro Stage schreiben (B); ohne diese Persistenz-Erweiterung ist diese Transparenz-Klasse für abgeschlossene Runs grundsätzlich nicht abrufbar.

---

### Recon: live-sse

I have a complete, grounded picture. Here is the report.

# Recon "live-sse" — Kann Tab 2 LIVE animieren UND historisch replayen?

## Kurzbefund (TL;DR)

- **LIVE animieren: JA, vollständig vorhanden.** Es gibt zwei parallele SSE-Mechaniken im selben Wire-Format. Der relevante Pfad für die ctax-Fallansicht ist der **POST-Upload-SSE-Stream** (`/api/applications/:appId/instances/:caseId/upload`), den `steuerfall.html` bereits konsumiert.
- **Historisch REPLAYEN: NICHT vorhanden für Workflow/Case-Runs.** Die Workflow-Engine (`core/runner.ts` + `core/events.ts`) streamt Events nur live an Subscriber und schreibt sie **nirgends als Event-Log auf Disk**. Persistiert wird nur der *Endzustand* (`_result.json`, `_meta.json`, pro-Stage `output.json`). Ein zeitlich aufgelöster Replay (Timeline mit `at`-Timestamps, Animation der Stage-Übergänge) ist daraus **nicht** rekonstruierbar.
- **Eine separate Subsystem-Engine (JobRunner) hat echten persistenten Replay** — aber sie deckt einen anderen Scope ab (Workspace-Jobs: reclassify/extract/audit/citations/import), **nicht** die ELSTER-Extraction-Runs eines Falls. Sie ist als Architektur-Vorbild relevant, aber nicht direkt für Tab 2 nutzbar.

---

## 1. Event-Envelope-Format

Zwei verschiedene Envelopes je nach Subsystem.

### 1a. Workflow-Runs (relevant für die Fall-Verarbeitung)
Definiert in `/Users/christophbertsch/Desktop/sturm.0711.io/.claude/worktrees/optimistic-davinci-584d2b/src/core/types.ts:197`:

```ts
interface EventEnvelope { name; runId; workflowId; stageId?; at /*ISO*/; payload? }
```

- Konstruiert in `core/events.ts:23-30` (`EventBus.emit` setzt `at: new Date().toISOString()`).
- SSE-Serialisierung: `core/events.ts:43-45` → `formatSseEvent` schreibt `event: <name>\ndata: <json>\n\n` (Event-Name **und** im JSON dupliziert).
- Standard-Event-Namen (`core/types.ts:187-195`): `run_start`, `run_done`, `run_error`, `stage_start`, `stage_done`, `stage_error`, `stage_skipped` — plus beliebige Custom-Events von Stages.

**Emittiert vom Runner** (`core/runner.ts`):
- `run_start` mit `{ workflowId, input: sanitizeForLog(input) }` — Z. 152
- `stage_start` `{ uses }` — Z. 185
- `stage_done` `{ ms, output: sanitizeForLog(output) }` — Z. 211
- `stage_error` `{ ms, message }` — Z. 219; `stage_skipped` — Z. 169
- `run_done` `{ ms }` / `run_error` `{ ms }` — Z. 238/240
- Logger-Events `log_debug|info|warn|error` — Z. 27-30

**Wichtig für Tab-2-Anforderungen (Prompts / externe Schnittstellen):** Custom-Stage-Events tragen genau die geforderten Detail-Daten — aber **nur im Live-Stream**, nicht persistiert. Belege (`ctx.emit(...)`):
- LLM-Ensemble: `ensemble_start {models}`, `ensemble_model_done {model, ms, keys}`, `ensemble_model_error`, `ensemble_done` — `src/stages/llm-ensemble-vote.ts:146,171,178,248`
- Kritiker-LLM: `critic_started {provider, model}`, `critic_done` — `src/stages/quality/critic-llm.ts:277,319`
- Schema-Guard-LLM: `schema_guard_started`, `schema_guard_done`, `source_budget_exceeded` — `src/stages/quality/schema-guarded-llm.ts:142,172,200`
- Retrieval: `atoms.retrieved {query, hits}` — `src/workflows/project-context/stages/project-quantum-retrieve.ts:76`
- Klassifizierung: `llm_hits {anlagen, rejected}` — `src/workflows/elster/stages/klassifizierung.ts:348`

Diese Events nennen *welcher* LLM/welche Query lief, aber die **vollen Prompts und rohen Request/Response-Bodies** der externen Schnittstellen werden in der Regel **gar nicht emittiert** — nur Metadaten (Modellname, ms, Key-Count). Volle Roh-Responses landen nur dann auf Disk, wenn ein Stage das explizit als Artefakt schreibt (Ausnahmen: `llm-ensemble-vote.ts:247` → `per_model_raw.json`; `elster/stages/qualitaetsgate.ts:415` → `qualitaetsgate/raw_responses.json`). Es gibt **kein** generisches Tracing aller LLM/MCP-Calls.

### 1b. JobRunner-Events (anderes Subsystem)
`/Users/.../src/lib/job-runner.ts` + `src/lib/job-types.ts`. Andere Form: `{ seq, type, data, ... }` (sequenz-nummeriert, **nicht** `EventEnvelope`). SSE-Serialisierung in `src/server/jobs.ts:58-61` (`event: <type>\ndata: <json>`). Event-Typen: `queued`, `started`, `progress`, `doc_started`, `doc_done`, `doc_failed`, `completed`, `failed`, `cancelled`, `cancel_requested` etc.

---

## 2. SSE-Endpunkte (mit Pfad:Zeile)

| Zweck | Methode + Pfad | Datei:Zeile | Live? | Replay? |
|---|---|---|---|---|
| **Fall-Upload (1 Datei)** — treibt die Verarbeitung an, streamt `run_meta`+alle Run-Events | POST `/api/applications/:appId/instances/:caseId/upload` | `server.ts:446` (SSE-Header `471-475`, `bus.subscribe`→`res.write` `496`, `run_meta` `497`) | **JA** | nein |
| **Fall-Upload (bulk)** — multiplexed, Events mit `payload.docIdx` | POST `.../upload-bulk` | `server.ts:542` (`bus.subscribe` `613`, Events `bulk_start`/`doc_start`/`doc_done`/`bulk_done`) | **JA** | nein |
| **Seal-Run** | POST `.../seal` | `server.ts:719` (subscribe `834`) | JA | nein |
| **Generischer Workflow-Run** | POST `/api/workflows/:id/run` | `server.ts:1558` (SSE-Header `1602`, subscribe `1616`, `run_meta` `1621`) | JA | nein |
| **JobRunner Events (anderes Subsystem)** | GET `/api/jobs/:jobId/events` | `src/server/jobs.ts:44` | JA (`?live=true`) | **JA** (History-Replay aus `events.jsonl`, default) |

**Charakteristik aller Workflow-SSE-Surfaces:** Es sind **POST-getriebene** Streams, die an den Lifecycle *eines gerade gestarteten* Runs gebunden sind (`runWorkflow(...)` wird im Handler aufgerufen, dann `run.bus.subscribe`). Es gibt **keinen GET-SSE-Endpunkt, der einen bereits laufenden Run nachträglich attached** oder einen abgeschlossenen Run aus Disk **streamt**. Bricht der Client die Verbindung ab (`req.on('close')`, z. B. `server.ts:504/1629`), läuft der Run im Hintergrund weiter — aber die bis dahin verpassten Events sind **verloren**, weil `EventBus` keinen Buffer/Backlog hält (`core/events.ts:16-19`: Subscriber bekommen nur Events *ab* Subscribe-Zeitpunkt; Kommentar bestätigt das explizit).

Die UI konsumiert das bereits: `steuerfall.html` liest `res.body.getReader()` + `TextDecoder`, parst `^data:` und schaltet auf `stage_start`/`stage_done`/`run_done` (`src/ui/steuerfall.html:1016-1066`, bulk: `1157-1187`, ein dritter Reader `1555-1578`). Das ist die direkte Vorlage für die Live-Animation in Tab 2.

---

## 3. Werden Run-Events persistiert? — NEIN (für Workflow-Runs)

`EventBus` ist reines In-Memory-Pub/Sub: `emit` iteriert nur über `subscribers` (`core/events.ts:31-33`), kein File-Write, kein Append. `core/artifacts.ts` (der einzige Disk-Writer im Run-Pfad) kann nur `write`/`writeBuffer`/`read` — **keine** Append-/Event-Log-Methode (`artifacts.ts:29-59`). Der Runner ruft `artifacts.write` exakt dreimal pro Run + einmal pro Stage:

- `_meta.json` `{ runId, workflowId, startedAt }` — `runner.ts:155`
- pro Stage `<stageId>/output.json` (sanitisierter Output) — `runner.ts:204`
- `_result.json` (`RunResult`: state, total-ms, `stages[].{state, ms, error}`, plus sanitisierter `output` je Stage) — `runner.ts:229`

Was daraus rekonstruierbar ist (für „abgeschlossene Fälle"):
- **Ja:** Stage-Liste, finaler Stage-State, **`ms` pro Stage** (Verarbeitungszeit!) und total, finaler **Output je Stage** (= „Output je Stage"), Fehler-Messages.
- **Nein:** Zeitstrahl/Reihenfolge mit `at`-Timestamps, das **Input je Stage** (nur der resolvte Input lebt transient in `resolveInputs`, `runner.ts:183`; nie geschrieben), die Live-Log-Events, die Custom-Stage-Events (Ensemble/Critic/Retrieval), und die geforderten **Prompts + externen Request/Response-Bodies**.

Die UI hat dafür heute nur Polling-Lese-Endpunkte (token-frei), die diesen Endzustand abgreifen — keine Replay-Animation:
- `GET .../runs/:runId/summary` (liest `_result.json`+`_meta.json`) — `server.ts:1104`
- `GET .../runs/:runId/progress` (scannt Stage-Unterordner) — `server.ts:1159`
- `GET /api/runs/:workflowId/:runId/stages/:stageId/output` — `server.ts:1774`

### Kontrast: JobRunner persistiert sehr wohl
`workspaces/<wsId>/.jobs/<jobId>.events.jsonl` ist ein **append-only Event-Log** (`job-runner.ts:6,43,275` `fs.appendFile`). `readEvents(wsId, jobId, fromSeq)` (`job-runner.ts:222`) + `subscribeLive` (`job-runner.ts:238`) liefern genau das, was Replay braucht. Der Jobs-SSE-Endpunkt macht **default History-Replay** und schließt nach `replay_complete`; `?live=true` für Live-Tail; `?fromSeq=N` für Resume (`server/jobs.ts:44-83`). **Dieses Muster fehlt der Workflow-Engine komplett.**

---

## 4. Was fehlt konkret für Tab-2-Replay (mit Detailtiefe Prompts/Schnittstellen)

1. **Run-Event-Persistenz (Kernlücke).** Der `EventBus` muss jedes Event zusätzlich append-only auf Disk schreiben — z. B. `runs/<wf>/<runId>/_events.jsonl`. Minimal-invasiv: in `runner.ts` neben `bus.subscribe(onEvent)` einen Append-Subscriber hängen, oder dem `EventBus` einen optionalen `sink(env)` geben. Envelope hat `at` bereits → Timeline gratis.
2. **GET-SSE-Replay-Endpunkt.** Analog zu `server/jobs.ts:44`: `GET /api/applications/.../runs/:runId/events?live=&fromSeq=` — bei abgeschlossenem Run die `_events.jsonl` durchspielen (optional zeitgerafft), bei laufendem Run live attachen. Erfordert eine Run-Registry (laufende `EventBus`-Instanzen per `runId`), die es heute nicht gibt — aktuell ist der Bus nur lokal im POST-Handler (`server.ts:1608`, `496`, `833`) referenziert; nach Client-Disconnect gibt es **keinen Re-Attach-Pfad**.
3. **Stage-Inputs persistieren.** `resolveInputs`-Ergebnis je Stage als `<stageId>/input.json` schreiben (heute nur Output). Sonst bleibt „Input je Stage" in Tab 2 leer.
4. **Externe Calls + Prompts generisch tracen.** Es gibt keinen zentralen Hook über LLM/MCP/RAG-Calls. Heute landen volle Prompts/Roh-Responses nur ad-hoc (`llm-ensemble-vote.ts:247`, `qualitaetsgate.ts:415`). Für die Anforderung „welche Prompts gingen an LLMs + Antworten / welche Schnittstellen mit Request/Response" braucht es entweder (a) Instrumentierung im `ToolContainer`/den Handles (`core/tools/*`), die Calls als Trace-Events emittiert+persistiert, oder (b) eine Konvention, dass jeder LLM/MCP-Stage `request`/`response` als Artefakt schreibt. Aktuell ist diese Detailtiefe **weder live noch persistiert flächendeckend verfügbar** — nur Metadaten (Modellname, ms).
5. **Backlog/Buffer im EventBus** (für Live-Tab, das mitten im Run attached): heute verpasst ein spät-subscribter Client alle vorherigen Stages (`core/events.ts:16-19`). Sobald (1) existiert, kann der Replay-Endpunkt das per `fromSeq` lösen.

**Fazit:** Live-Animation ist mit dem bestehenden Upload-SSE-Stream (`server.ts:446`/`542`) und dem `EventEnvelope`-Format sofort baubar (UI-Vorlage in `steuerfall.html:1016ff` existiert). Echter historischer Replay eines abgeschlossenen Falls ist **heute nicht möglich** — die Events sind flüchtig; persistiert wird nur der Endzustand. Es existiert mit dem `JobRunner` (`job-runner.ts` + `server/jobs.ts:44`) ein fertiges Persistenz/Replay-Muster, das auf die Workflow-Engine übertragen werden müsste (Punkte 1-2), ergänzt um Stage-Input- und Prompt/Schnittstellen-Tracing (Punkte 3-4) für die geforderte Transparenz-Tiefe.

---

