# Greenfield-Konsolidierung — alle Lanes + ctax-web in EIN neues Repo

> Auftrag: „alles neu auf grüne Wiese, konsolidiert; nichts am Alten im Prozess
> ändern, nur Kopien in einem neuen, getrennten Repo anfassen. Alle Lanes 1·2·4·5."
>
> Grundlage: vollständige MCP-Oberflächen-Inventur aller 4 Lanes (4 Subagents,
> 2026-06-03) + die vorausgegangene Stack-Inventur. Jede Aussage unten ist live verifiziert.

---

## 0. Die zentrale Erkenntnis: Kuratierung, nicht Lift-and-Shift

Die 4 Lanes sind **kein** sauberer, übernehmbarer Stack. Sie sind eine Mischung aus
**produktiven Kernen**, **kaputter Laufzeit**, **totem Ballast** und **dreifacher
Duplikation**. Der Wert steckt in den **Daten** (Steuerlogik, XSD-Projektion, ELSTER-Katalog)
und in **wenigen sauberen Code-Kernen**. Greenfield heißt deshalb: **die Gewinner auswählen,
die Nähte neu bauen, Defekte fixen, Duplikate auf je EINE Quelle reduzieren** — nicht alles
kopieren.

**Was heute live ist vs. was es taugt:**

| Lane | Port | Läuft? | Tools | Verdikt |
|---|---|---|---|---|
| **1 BMF-Rechner** | 12010 | ✅ healthy | 39 | **Kronjuwel Rechnen.** §32a-Python-Pfad korrekt (verifiziert). Aber: `tarif_32a`-DB-Formeln veraltet+ungenutzt, `kirchensteuer`-Modul kaputt, `calc_core` 5/23 Dateien, `eval()` trotz Doku, stilles `0.0`-Safety-Net, hardcodierte Lookups. `anthropic`-Dep tot. |
| **2 RAG/Graph** | 12011 | ✅ healthy, aber **Insel** | 16 | **Kein laufender Konsument** ruft die MCP-Tools. Daten-Integrität kaputt: Graph 35k statt behaupteter 562k Kanten; Voyage konfiguriert, aber MiniLM-384 läuft; 2 divergente Vektor-Stores (FAISS 81,5k vs pg 35,5k); 451 MB `metadata.json` dupliziert DB-Text; **aktuelles Verhalten nur in uncommitted Code** (GitLab-Image ≠ laufendes Image). BFH-Schicht sauber. ~700 MB+ Assets. |
| **4 Master-Orchestrator** | 12013 | ❌ **läuft nicht** (nie gebaut) | 11 | War **produktiv** (103 reale Fälle bis 2026-04-30). Das „Gehirn": OCR (Mistral-Cloud) → Profil (3-Layer) → Lane-1-Berechnung + Checklisten-Flow. **Kein Anthropic-Agent-Loop** (Doku-Mythos). Lane-zu-Lane-Adressierung **container-untauglich** (localhost:9010 statt `LANE*_URL`). Lane 5 nie aufgerufen. Viel toter `reused/`-Ballast. |
| **5 ELSTER-Export** | 12014 | ✅ healthy, aber **~12/20 Tools kaputt** | 20 | **Daten = Gold** (XSD-treue E10-2024-Projektion: feld_definitionen 3431, validierungs_regeln 2196, XSD-Volltext). **Server-Code kaputt**: zentraler Generator ist ein async-generator-Bug; DB-Lookups scheitern an Spalten-Drift (`name_de` vs `bezeichnung`). **Kein echtes ERiC** (nur String-Heuristik, keine XSD-Validierung). |

---

## 1. Die Duplikation, die der Greenfield auflösen MUSS

Die Inventur hat **mehrfache, parallele Wahrheiten** zu Tage gefördert — die Hauptaufgabe der
Konsolidierung ist, je EINE zu wählen:

**A. Drei+ ELSTER-Feldkataloge (alle aus derselben offiziellen E10-2024-XSD):**
| Quelle | Ort | Zeilen | Charakter |
|---|---|---|---|
| `elster_catalog` | DB `elster-postgres` :11111 | feld 2569, kennzahl 3016, regel 2196 + Resolver-Atome/Embeddings | **reichstes normalisiertes Modell** (+ Quantum-Resolver) |
| `lane5_elster_export` | Schema in `ctax` | feld_definitionen 3431 | flache XSD-Projektion (+ Validierungsregeln) |
| `shared.feld_katalog` | Schema in `ctax` | 2222 | kuratierter BMF↔ELSTER-Mapping (Lane-1/5-Live-Lookup) |
| `atoms.json` | sturm-Repo | 2287 eCodes | sturm-Extraktor-Katalog (drucktext/vordruckzeile/regex) |
| → **Empfehlung:** **`elster_catalog`** als strukturelle SSoT (reichstes Modell, VZ-versioniert, ERiC-XSD-abgeleitet); `lane5`-Validierungsregeln + `atoms.json`-Extraktor-Metadaten als abgeleitete Sichten dranhängen. **Nicht drei parallel pflegen.** |

**B. Zwei E10-XML-Generatoren:** Lane-5 `ELSTERExportReaderV2` (Python, via MCP kaputt) vs.
sturm-TS-Pfad. → **Einen** wählen, gegen `lxml.etree.XMLSchema` + die `validierungs_regeln`
ehrlich validieren (echte XSD-Prüfung fehlt heute überall).

**C. Zwei eCode→canonical-Mapper-Linien:** Lane-1 `ecode_to_canonical` + `module_mappings`
(120 Regeln, SSoT, sauber) vs. sturms `adapter.ts` + field-mapper. → Lane-1-`module_mappings`
ist die deklarative Wahrheit; sturm-Adapter ist der TS-Konsument davon. Vereinheitlichen.

**D. Zwei OCR-Strategien:** tornado (Rust, lokale GPU, deterministisch, content-addressed
Cache — das, was ctax-web heute produktiv nutzt) vs. Lane-4 Mistral-Cloud-OCR. → **Fork, s. §6.**

---

## 2. Ziel-Architektur (eine saubere Pipeline aus den besten Teilen)

```
   ┌─────────────────────────────────────────────────────────────────────┐
   │  NEUES REPO  ·  ein docker-compose  ·  gepinnte Tags  ·  DB-als-Code   │
   │                                                                       │
   │  web (SPA + API)        ← aus sturm/ctax-web (SPA, Kurator, Flow, Audit)│
   │      │                                                                │
   │  ┌───┴── Pipeline (MCP-Services, je sauber abgegrenzt) ──────────────┐ │
   │  │  INGEST   = tornado (OCR/Extraktion) + Lane-4-Orchestrierung      │ │
   │  │             (Profil-Erkennung, Fall-Status, Checkliste, Optim.)   │ │
   │  │  MAP      = Lane-1 ecode_to_canonical + module_mappings (SSoT)     │ │
   │  │  CALC     = Lane-1 BMF-Rechner (bug-fixed)                         │ │
   │  │  AUDIT    = Lane-2 BFH/Recht-RAG (optional, 1 Vektor-Backend)      │ │
   │  │  EXPORT   = Lane-5 Daten + neuer XML-Generator + echte XSD-Valid.  │ │
   │  └───────────────────────────────────────────────────────────────────┘ │
   │                                                                       │
   │  postgres (EIN Instanz, Schema-getrennt, alles aus Migrations):       │
   │    bmf_steuerrechner · elster_catalog(SSoT) · lane5_validierung ·     │
   │    lane14_faelle/profile · (optional) rag-vektor                      │
   │  state-Volume: uploads/runs/ocr-cache/prov-cache/mastercase           │
   └─────────────────────────────────────────────────────────────────────┘
            │ (Env-URLs)                          │ (nur falls Mistral-OCR-Fork)
            ▼                                      ▼
   GPU/ML extern: vLLM gemma4-mm :11435 ·     Cloud: Mistral (OCR/Extraktion)
   embeddinggemma :11436 · PaddleOCR :11440 · Ollama :11434
```

**Prinzip:** GPU-Modelle bleiben extern (Env-URL). DB ist **eine** Instanz, **alles als
Migration** (schließt das #1-Risiko: Steuerlogik heute nur live). Jede Pipeline-Stufe bleibt
ein abgegrenzter MCP-Service (saubere Naht) — aber **kuratiert** aus dem besten vorhandenen Code.

---

## 3. Was aus welcher Quelle ins neue Repo wandert (Kopie-Matrix)

| Stufe | Übernehmen (Kopie) | Aktion |
|---|---|---|
| **web** | sturm `web/*` + `src/workflows/elster/lib/**` + `src/server/harmonize.ts` + `src/lib/*` | **take** (läuft, Hildburg grün) |
| **INGEST/OCR** | `~/tornado/` (Rust + Katalog-Blob) | **take** (Binary/Dockerfile da) |
| **INGEST/Orchestr.** | Lane-4 `services/{mistral_ocr,…,checkliste,dynamische_screening,optimierung_*,document_type_detector,profil_anlagen_map}.py` + `reused/lane14/profile_detector_v3.py` | **take-core + fix** (Container-Adressierung, DB-Pool vereinheitlichen, `reused`-Ballast raus) |
| **MAP** | Lane-1 `ecode_to_canonical.py` + `module_mappings`-Daten | **take** (SSoT) |
| **CALC** | Lane-1 `bmf_2024_calculator_api.py`, `formula_executor.py`, `bmf_calculator_enhanced.py`, Server + DB-Daten (formeln/konstanten/schwellwerte/regelwerk/module/modul_zuordnungen) | **take + fix** (§32a→DB, kirchensteuer, calc_core/eval/0.0-Net, Lookups→DB) |
| **AUDIT/RAG** | Lane-2 `bfh_*` + ELSTER-Cascade + Graph/FAISS | **optional + rebuild** (1 Vektor-Backend, Graph-Kanten klären, Code committen) |
| **EXPORT** | Lane-5 **DB-Daten** (feld_definitionen, validierungs_regeln, komplexe_typen, aufzaehlungen, XSD) + `coercion.py` + `_format_value` | **take-data, rebuild-server** (async-bug, Spalten-Drift, echte XSD-Validierung neu) |
| **DATEN (SSoT)** | `elster_catalog` (:11111) Dump | **take** als Feld-/Regel-Wahrheit |
| **`_shared/`** | CTAXV1 `services/_shared/{mcp_base,mcp_tools,mcp_types,config,entrypoint.sh}` | **take** (gemeinsames MCP-Gerüst) |
| **XSD** | `schemas/elster-2024-reference/*.xsd` | schon im sturm-Repo |

**Bewusst NICHT übernehmen:** Lane-2 `metadata.json` (451 MB, dupliziert DB), `.restored`/`.bak`,
`bm25_corpus/stats` (kein Reader), AGE-Schema (leer/ungenutzt); Lane-4 `case_builder_v5`
(2510 Z. tot), `income_analyzer`, fehlendes `lane7`; Lane-5 leere englische Alias-Tabellen +
`field_mappings_archive_*` + dormante AI-Mapper; alle `anthropic`-Deps in Calc/RAG/Export.

---

## 4. Vorgeschlagene Repo-Struktur (neues, getrenntes Repo — nur Kopien)

```
ctax-core/                      (neues Repo, NICHTS Altes wird angefasst)
  docker-compose.yml            ein Bundle, gepinnte Tags, Healthchecks
  .env.example                  alle Env-Keys (GPU-URLs, PG, Key-SLOTS — keine Geheimnisse)
  db/migrations/                DB-als-Code:
    01_bmf_steuerrechner.sql    (Steuerlogik — das #1-Risiko, zuerst)
    02_elster_catalog.sql       (Feld-/Regel-SSoT)
    03_lane5_validierung.sql    (XSD-Projektion + Validierungsregeln)
    04_lane14_faelle.sql        (Fall-/Profil-/Checklisten-Tabellen)
  services/
    web/                        ← sturm ctax-web (Node/tsx) + Dockerfile
    ingest-tornado/             ← ~/tornado (Rust) + Dockerfile
    orchestrator/               ← Lane-4-Kern (Python) + Dockerfile
    calc-bmf/                   ← Lane-1 (Python) + Dockerfile
    export-elster/              ← Lane-5-Daten + neuer Server + Dockerfile
    rag/                        ← Lane-2 (optional) + Dockerfile
    _shared/                    ← gemeinsames MCP-Gerüst
  tests/groundtruth/            ← Hildburg-Harness (case_e2e/case_assert) als Cutover-Tor
  docs/                         ← diese Architektur + ADRs
```

---

## 5. Build-Reihenfolge (phasiert, jederzeit grün abbrechbar)

1. **Repo + DB-als-Code** — neues Repo, `pg_dump` der 4 Datenquellen → Migrations. **Schließt
   sofort das größte Risiko** (Steuerlogik versioniert), ohne irgendetwas Live anzufassen.
2. **CALC + MAP** (Lane 1) containerisieren, gegen die Migrations laufen, Bugs fixen, mit der
   Hildburg-Harness verifizieren (Korridor +160,78 € / zvE 43.588).
3. **web + INGEST (tornado)** dazu — der heute produktive Spine; Harness end-to-end grün.
4. **EXPORT** (Lane 5) neu bauen (XML-Generator + echte XSD-Validierung).
5. **Orchestrator** (Lane 4: Profil/Checkliste/Fall-Status) — container-tauglich gemacht.
6. **RAG** (Lane 2) optional, zuletzt — nur wenn juristisches Grounding in v1 gewünscht.

---

## 6. Echte Entwurfs-Entscheidungen (deine)

1. **OCR/Ingest:** tornado lokal (kein Cloud-Dep, deterministisch, läuft heute) — empfohlen — /
   Lane-4 Mistral-Cloud (was CTAXV1 nutzte) / beide pluggbar.
2. **Feld-/Regel-SSoT:** `elster_catalog` (reichstes Modell) — empfohlen — / `lane5`-Projektion
   vereinen / `atoms.json` (sturm) als Basis.
3. **Repo-Heimat:** ⚠️ Du sagtest „GitHub". **CLAUDE.md sagt: GitLab ist der kanonische
   Origin, NICHT auf GitHub pushen.** → neues GitLab-Repo (projektkonform) / neues GitHub-Repo
   (wie gesagt, gegen Policy) / erst nur lokal scaffolden, Origin später.
4. **RAG in v1?** ja (mit Rebuild auf 1 Vektor-Backend) / nein (später; Audit bleibt determ.).

Nach der Entscheidung: ich lege das neue Repo **lokal** an (reine Kopien), beginne mit
Phase 1 (DB-als-Code), rühre kein laufendes System an.
