# Steuer-Core als versioniertes Bundle — Konsolidierungsplan

> Antwort auf: „alle beteiligten Funktionalitäten und Datenbanken in ein völlig
> separates Image ziehen, um Wartbarkeit, Kontrolle und Stabilität zu erhöhen".
>
> Grundlage: vollständige Stack-Inventur (6 Subagents, 2026-06-03). Dieser Plan
> ist **geerdet** — jede Komponente, jeder Port, jedes Schema unten ist verifiziert.

---

## 0. TL;DR

- Was `quantum.0711.io/ctax/` **wirklich** ausliefert, ist ein **deterministischer
  Rechen-Kern** aus 4 Teilen: `ctax-web` (:7190) → `tornado` (:7180) → `BMF-MCP`
  (lane1-bmf :12010) → **zwei** Postgres-DBs. Die **GPU/ML-Modelle** (vLLM, PaddleOCR,
  Embedding) sind **geteilte externe Server** auf der H200 — sie gehören **nicht** ins Image.
- **Größtes Risiko heute:** die deutsche Steuer-Recht-Logik (Formeln/Tafeln/Konstanten/
  Regelwerk) existiert **nur live in der DB**, ist **nirgends versioniert**, die Dump-
  Symlinks sind tot. Ein Volume-Verlust = Verlust der gesamten Rechenlogik.
- **Empfehlung:** kein Mono-Image, sondern **ein versioniertes Bundle** = 3 schlanke
  Images (`ctax-web`, `tornado`, `bmf-mcp`) + 1 Stock-Postgres + 1 State-Volume, in
  **einem** Git-Repo, mit **DB-als-Code** und **GPU extern per Env-URL**.
- Das bringt genau die drei Ziele: **Wartbarkeit** (ein `git pull` + `compose up`,
  statt 4 Start-Mechanismen + divergenter Nicht-Git-Snapshot), **Kontrolle** (gepinnte
  Image-Tags, Steuerlogik als Migration), **Stabilität** (reproduzierbar, rollback-fähig,
  Cutover gegen die Hildburg-Harness).

---

## 1. Was „der Stack" tatsächlich ist (Synthese)

Die Inventur zeigt: es sind **zwei weitgehend unabhängige Produkte**, die sich nur
**einen** Dienst teilen.

### 1a. Das Live-ELSTER-Produkt (was `/ctax/` zeigt) — der Konsolidierungs-Gegenstand
```
                 Cloudflare-Tunnel  *.0711.io → :80 nginx
                          │  (^~ /ctax/ →)
                          ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  DETERMINISTISCHER KERN (CPU, versionierbar, → ins Bundle)     │
   │                                                                │
   │  ctax-web  :7190   Node/tsx, web/server.ts (systemd --user)    │
   │    │  Upload→Extraktion→ELSTER-Mapping→Berechnung→Audit/Chat   │
   │    ├──────────────► tornado :7180  Rust, OCR/Extraktion (sysd) │
   │    ├──────────────► BMF-MCP :12010 Python/FastMCP (Docker)     │
   │    ├──────────────► Postgres elster_catalog :11111 (Docker)    │
   │    └──────────────► Postgres bmf_steuerrechner (in :12432)     │
   └───────┬───────────────────────────┬──────────────────────────┘
           │ (OCR/Embed/Chat)          │ (Tarif rein in Python im MCP)
           ▼                           ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  GPU/ML-MODELLE (extern, geteilt, NICHT ins Image)            │
   │  vLLM gemma4-mm :11435 (PM2, TP=2, ~62 GB)                     │
   │  vLLM embeddinggemma :11436   PaddleOCR :11440 (uvicorn)       │
   │  Ollama :11434 (Auditor)      Triton :18000-2 (inaktiv)        │
   └──────────────────────────────────────────────────────────────┘
```

**Datenfluss (verifiziert):** `/api/steuerfall` → `runLane1` (OCR via tornado, Text via
pdftotext, beides content-addressed gecacht) → Feld-Injektion (Vorauszahlungen/§35a/KV-PV)
→ `normalisiereSteuerfall` → `bausteineAusFelder` → **BMF-MCP** (`berechne_vollstaendige_
steuer_v2`, eCode-keyed, **bindend**) → `berechneHaushaltAuthoritativ` → Ergebnis-JSON.
Zusätzlich: Kurator-Chat (vLLM/Opus), Auditor (Ollama, optional), Mastercase-Harmonizer
(fire-and-forget), Provenienz-Viewer (PNG + bboxes).

### 1b. CTAXV1 (paralleler Greenfield-Neubau) — NICHT im Live-Rechenpfad
`~/CTAXV1/docker-compose.yml`: `postgres`, `redis`, `lane1-bmf` ✅ (das ist der von
ctax-web genutzte BMF-MCP), `lane2-rag` (Rechts-RAG, läuft), `lane4-master` (Orchestrator,
**läuft nicht**), `lane5-elster` (XML/ERiC-Export, läuft), `gateway` (Skelett, läuft nicht),
`frontend` (nur README). **Selbst-enthalten**, koppelt nur über Cloud-APIs (Anthropic/
Mistral/Voyage) — **keine** Bindung an den GPU-Stack. **ctax-web nutzt von CTAXV1 nur
`lane1-bmf`.** lane2/4/5 sind ein eigenes Architektur-Universum.

### 1c. Die Datenbank-Realität (das Kernrisiko)
- **3 separate Postgres** + 1 leerer Redis. Die für den Kern relevanten:
  - `bmf_steuerrechner`-Schema (in `ctaxv1-postgres` :12432, DB `ctax`): **regelwerk 843,
    konstanten 309, formeln 199, modul_zuordnungen 120, schwellwerte 82, module 33** —
    **das ist die ausführbare Steuerlogik.** `lane1_bmf_calculator.*` sind 11 **Views**
    (englische Namen) darüber. **Größe nur ~2,7 MB.**
  - `elster_catalog` (`elster-postgres` :11111): offizieller ELSTER-E-Code-Katalog VZ2024
    (ERiC 42.4.4.0), 2.569 Felder, 35 Anlagen. **44 MB.** ctax-web braucht ihn **hart**
    zur Laufzeit (pre-validate, e10-xml, vordruckzeile).
  - Der Rest der `ctax`-DB (676 MB) ist **RAG/Vektor** (`lane3_vector_store` 604 MB,
    `lane2_rag_graph` 172 MB) — **nicht** Teil des deterministischen Rechen-Kerns.
- **⚠️ Die Steuerlogik ist nicht versioniert.** `INSERT INTO …formeln/schwellwerte/…`
  existiert nirgends auf Platte; `db/dumps/*.sql.gz` sind **tote Symlinks** (Zielordner
  leer). Migrations `0001–0014` beschreiben ein **nie deploytes** Ziel-Schema
  (`rules`/`catalog`/… — `rules` existiert live gar nicht).
- **Folge für das Bundle:** Der Kern braucht nur **~47 MB** DB (bmf_steuerrechner 2,7 MB
  + elster_catalog 44 MB), **nicht** die 600 MB Vektor-Daten.

### 1d. Deployment-Realität (das Wartbarkeits-Problem)
- **4 Start-Mechanismen nebeneinander:** Docker (BMF-MCP, lanes, sturm), **PM2**
  (gemma4-mm-vLLM via `/tmp/start-vllm-gemma4.sh` — fragil), **systemd --user** (tornado,
  ctax-web, quantum-rag), **bare nohup** (embed/OCR-vLLMs, PaddleOCR).
- **Der deployte ctax-web läuft aus `~/0711-sturm-elster/repo` — das ist KEIN Git-Checkout**,
  sondern ein divergenter Teil-Snapshot (genau die Drift, vor der CLAUDE.md warnt; hat beim
  letzten Deploy einen Boot-Crash durch fehlende Importe verursacht).
- **Routing-Wahrheit ist nginx**, nicht die cloudflared-YAML (`/ctax/` läuft nur über das
  `*.0711.io → :80`-Wildcard). **Kein k3s auf h200v** — die `ctax-manifests`/`sturm-state`-
  PVC aus CLAUDE.md sind ein **anderer** Cluster (`dev-01`).

### 1e. Bekannte Defekte im Rechenkern (für die Konsolidierung mit-zu-sanieren)
- BMF-MCP: `tarif_32a`-**DB-Formeln sind veraltet** (2022-Koeffizienten) und werden **nicht
  benutzt** (echter Pfad rechnet §32a in Python, Jahre 2023/24/25 hardcoded) → das
  Einzeltool `berechne_tarif_32a` liefert andere Zahlen als die Vollberechnung.
- BMF-MCP: `kirchensteuer`-Modul **defekt** (ruft nicht-existente SQL-Funktion).
- BMF-MCP: `calc_core/` hat nur **5 von 23** Modul-Dateien → Rest wirft ImportError und wird
  **still übersprungen**; Safety-Net setzt unaufgelöste Formel-Identifier **still auf 0.0**.
- BMF-MCP: hardcodierte Lookups (`besteuerungsanteil` 2005–2040, `ertragsanteil`,
  `altersentlastung`) gehören in `thresholds`/`parameters` (= deckt sich mit offenen Tasks
  B3/B7 aus `CENT-PERFECT-STATUS.md`).
- CTAXV1 `.env`: Port-Variablennamen-Mismatch (`CALCULATOR_PORT` vs `LANE1_BMF_PORT`),
  funktioniert nur per Default-Zufall. tornado `infra/compose.yml` ist stale (Triton statt
  PaddleOCR). Sicherheits-Flag: `sturm`-Container hält API-Keys im Klartext-Env.

---

## 2. Ziel-Architektur: das „Steuer-Core"-Bundle

**Ein** Git-Repo `steuer-core/`, **ein** `docker-compose.yml`, gepinnte Tags. Zwei Tiers:

### Tier A — in das Bundle konsolidiert (deterministisch, CPU, versioniert)
| Service | Image (neu/wieder) | Port | Herkunft heute |
|---|---|---|---|
| `ctax-web` | **neu** `steuer-core/ctax-web` (node:20 + poppler + py-venv Pillow/PyMuPDF) | 7190 | systemd-Snapshot `~/0711-sturm-elster/repo` |
| `tornado` | **wieder** `~/tornado/Dockerfile` (2-stage Rust, pdfium + Katalog-Blob gebacken) | 7180 | systemd Rust-Binary |
| `bmf-mcp` | **wieder** `~/CTAXV1/services/lane1_bmf/Dockerfile` | 8000 | Docker `ctaxv1-lane1-bmf` |
| `postgres` | **Stock** `postgres:16` + `db/migrations` (DB-als-Code) | 5432 | zwei separate PG-Instanzen |
| (`quantum-rag`) | optional, mit ctax-web im selben Repo (Auditor-Grounding) | 12013 | systemd |

**Eine** `postgres:16`-Instanz mit **zwei Datenbanken** — `ctax` (Schema `bmf_steuerrechner`
+ die 11 `lane1_bmf_calculator`-Views, für den MCP) und `elster_catalog` (Schema `elster`,
für ctax-web). Die Dienste behalten ihre DB-Namen, es ändert sich nur der Host →
`postgres:5432`. **Kein** Apache-AGE/pgvector nötig (das brauchen nur die RAG-Lanes, die
nicht im Kern sind) → schlankes Stock-Image.

**Ein** Named Volume `sturm-state` mountet `/app/{uploads,runs,ocr-cache,prov-cache,
mastercase}` (heute unter `$TMPDIR` → würde sonst bei Restart verschwinden). Deckt sich mit
dem `sturm-state`-PVC-Vertrag aus CLAUDE.md.

### Tier B — bleibt extern (GPU, geteilt, per Env-URL referenziert)
vLLM `gemma4-mm` :11435, vLLM `embeddinggemma` :11436, PaddleOCR :11440, Ollama :11434.
Das Bundle bekommt sie als Endpunkte: `VLLM_PRIMARY`, `TORNADO_EMBED_ENDPOINT`,
`TORNADO_OCR_ENGINES`, `KURATOR_URL`, `AUDITOR_URL`. Grund: 62-GB-Gewichte, GPU-gepinnt,
von mehreren Produkten geteilt — Imaging wäre weder sinnvoll noch portabel.

### Tier C — bewusst NICHT in der ersten Stufe
`lane2-rag` (Rechts-RAG), `lane4-master`, `lane5-elster` (XML/ERiC-Export), `gateway`,
`frontend`, die 600 MB Vektor-DB. **lane5-elster** ist der wahrscheinlichste „nächste
Kandidat" (zum echten Einreichen via ERiC), aber als **eigene** Stufe.

---

## 3. Warum Bundle statt Mono-Image

| | Mono-Image (1 Container, Supervisor) | **Bundle (empfohlen)** |
|---|---|---|
| Build | Rust+Node+Python+PG in einem Dockerfile → riesig, jeder Fix baut alles neu | 3 unabhängige Builds, getrennt cachebar |
| Daten | Postgres-im-Image = Anti-Pattern (Daten + Code im selben Layer) | DB-als-Code + Volume, sauber getrennt |
| Skalierung/Restart | alles oder nichts | pro Service rollbar/rollback-fähig |
| GPU | unmöglich zu imagen | sauber extern verdrahtet |
| „ein Artefakt"-Wunsch | ✓ (einziger Vorteil: Air-gap/Offline-Demo) | per `docker compose` / `docker save` aller Tags ebenfalls als ein Bündel exportierbar |

→ Das Ziel „Wartbarkeit/Kontrolle/Stabilität" wird durch das **Bundle** erreicht, nicht
durch ein Mono-Image. Falls ein **einzelnes Offline-Artefakt** zwingend ist, ist
`docker save ctax-web tornado bmf-mcp postgres > steuer-core.tar` der pragmatische Weg
(ein Tarball, intern weiterhin sauber getrennt).

---

## 4. Migrationspfad (geerdet, inkrementell, jederzeit abbrechbar)

**M1 — Steuerlogik versionieren (sofort, unabhängig vom Rest — schließt das #1-Risiko):**
`pg_dump` von `bmf_steuerrechner` (Schema **+ Daten**: formeln/schwellwerte/konstanten/
regelwerk/module/modul_zuordnungen/ertragsanteil_nachschlag/profil_modul_routing/…) + die 11
Views → `db/migrations/01_bmf_steuerrechner.sql`. `pg_dump elster_catalog` → `02_elster_
catalog.sql`. Einchecken. **Ab hier ist die Rechenlogik reproduzierbar** — selbst ohne
Containerisierung ein großer Stabilitätsgewinn. Die offene B4-Migration
(`docs/mcp-migrations/2026-06-03-B4-rentenanpassungsbetrag.sql`) wird Teil dieser Reihe.

**M2 — `ctax-web`-Dockerfile:** `node:20-slim` + `poppler-utils` + venv (`Pillow`,
`PyMuPDF`) + das Repo-Subset (`web/*`, `src/workflows/elster/lib/**`, `src/lib/*`,
`src/server/harmonize.ts`, `src/verticals/elster-v3/data/{atoms.json,nested_schemas,
paragraph_estg.json}`) + **Entrypoint `tsx web/server.ts`** (heute existiert **kein**
Start-Script dafür — das ist neu anzulegen).

**M3 — `tornado` + `bmf-mcp`:** vorhandene Dockerfiles wiederverwenden; Katalog-Blob
(`elster-current`) bzw. Python-Code sind bereits gebacken. tornado-Compose von Triton auf
**PaddleOCR :11440** korrigieren (Live-Wahrheit).

**M4 — `docker-compose.yml`:** alle vier + Volume verdrahten. Interne DNS:
`bmf-mcp:8000`, `postgres:5432`. GPU-URLs als Env (für h200v: `host.docker.internal` bzw.
LAN-IP). Healthchecks + `depends_on: postgres service_healthy`.

**M5 — `.env.example`:** alle Schlüssel dokumentiert (GPU-URLs, PG-URLs, `KURATOR_API_KEY`-
**Slot** — den trägst **du** ein, nicht ich). Port-Namen sauber (kein CTAXV1-Mismatch).

**M6 — Cutover mit grünem Tor:** Bundle auf Parallel-Port hochziehen → **`scripts/case_e2e.py
<belege> 2024` + `scripts/case_assert.py` gegen `tests/groundtruth/hildburg-2024.json`**
(Korridor: Erstattung +160,78 / zvE 43.588) muss **grün** sein → erst dann nginx `^~ /ctax/`
von systemd-:7190 auf Bundle-:7190 umlegen. **Rollback = nginx zurückklappen.**

**M7 — Stilllegen:** systemd-Unit `ctax-web` + den divergenten `~/0711-sturm-elster/repo`-
Snapshot abschalten; der Bundle-Git-Checkout wird die **einzige** Quelle. (tornado/bmf-mcp
können schrittweise nachziehen.)

**Registry/k3s-Brücke:** Images mit Tags in die GitLab-Registry pushen (`registry.gitlab.
mediacockpit.dev/0711/...`), damit derselbe Tag später von `ctax-manifests` (Cluster `dev-01`)
konsumiert werden kann — so versöhnt sich h200v-Compose mit dem k8s-Pfad aus CLAUDE.md.

---

## 5. Was es bringt — und die Caveats

**Gewinn:** ein `git pull && docker compose up -d` statt 4 Start-Systeme; Steuerlogik als
Code (heute nur live); gepinnte Tags = Rollback; reproduzierbarer Cutover gegen die
Ground-Truth-Harness; der Kern wird portabel (CPU-only, ~47 MB DB).

**Caveats:** (1) GPU-Modelle bleiben extern — das Bundle ist nur so verfügbar wie die
H200-Endpunkte (per Env umschaltbar, z.B. auf einen LLM-Proxy). (2) Zwei Deploy-Realitäten
(h200v-Compose **jetzt** vs. k3s `dev-01` **laut CLAUDE.md**) — der Plan baut Compose zuerst
und hält Image-Tags registry-fähig für die Manifeste. (3) Die MCP-Defekte (§1e) wandern mit;
sie sind als DB-Migrationen + kleine Python-Fixes im selben Bundle sauber zu beheben.

---

## 6. Offene Entscheidungen (bestimmen, was als Nächstes gebaut wird)
1. **Ziel-Laufzeit:** h200v-Compose-Bundle zuerst (empfohlen, dort läuft das Live-Produkt) /
   direkt k3s-Manifeste / beides parallel.
2. **Umfang Stufe 1:** nur der deterministische Rechen-Kern (empfohlen) / zusätzlich
   `lane5-elster` (ERiC-Export) / ganzes CTAXV1.
3. **Image-Form:** Bundle aus 3 Images (empfohlen) / einzelnes Mono-/Offline-Artefakt.

Nach der Entscheidung: ich scaffolde `steuer-core/` auf einem Branch (M1-Migration zuerst,
da risikoärmster + größter Sofort-Gewinn), ohne Live-Dienste anzufassen, bis der Cutover
grün ist.
