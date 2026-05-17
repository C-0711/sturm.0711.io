# ctx — Handover

**Session date**: 2026-05-17
**Repo at hand**: `sturm.0711.io` @ branch `main`
**Status**: Live and verified end-to-end against H200V

A drop-in **context container** tool: take the first context window of any LLM chat (ChatGPT, Claude, Gemini, …), turn it into an addressable, quantum-indexed retrieval surface that other LLMs can attach to via plain HTTP. Same wire format whether produced by CLI, by a workflow run via SSE, or — eventually — by a remote gitchain-anchored container.

---

## 1. Executive summary

What was built in this session, in order of dependency:

1. **`src/workflows/project-context/`** — a 6-stage workflow that wraps a project's git as a submodule inside a gitchain container, atomizes the project, builds a Quantum-Cascade index, and exposes append-only events. Designed but **not wired** into boot; needs `scripts/encode-gemma-quantum-container.ts` refactor before it runs.
2. **`runs/project-context/abrechnung/`** — concrete sample container `0711:project:sturm:abrechnung:v1`. 150 atoms across 15 Abrechnung-relevant files in this repo, fully indexed (~12s build, 1.2 MB on disk).
3. **`src/lib/ctx-*` + `scripts/ctx.ts`** — generic, transcript-driven version of (1). CLI (`new`, `list`, `index`, `retrieve`, `serve`), local registry, HTTP server (`/ctx/*`), transcript parser (markdown turns, OpenAI/Claude JSON exports, plain prompts, code-block split-out).
4. **`src/workflows/ctx-bootstrap/`** — same flow as (3) but wrapped as a sturm workflow with 5 stages and SSE streaming, **wired into boot**, registered as `ctx-bootstrap` in `/api/workflows`.
5. **`src/ui/ctx-demo.html`** — dedicated public-facing demo page: textarea + file upload + sample-fill, live DAG progress, post-run retrieval playground, copy-pasteable curl/OpenAPI/preamble snippets for cross-LLM consumption.
6. **`workspaces.ts` split plan** — analysis only, not executed. See §10.

End-to-end verified: a 1.3 KB transcript pasted into the UI produces a queryable retrieval endpoint in **~2 s** (~750 ms embed + ~850 ms encode + a few ms each for the other 3 stages), retrieves semantically correct hits at 0.4–0.5 score for direct queries, co-ranks prose and code atoms naturally.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│   USER INPUT                                                                 │
│   • paste box (ctx-demo.html)        • CLI stdin (scripts/ctx.ts)            │
│   • file upload (ctx-demo.html)      • POST /api/workflows/ctx-bootstrap/run │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐  │
│   │  INGEST  │──▶│   PARSE  │──▶│ ATOMIZE  │──▶│   INDEX  │──▶│ PUBLISH  │  │
│   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘  │
│                                                                              │
│   allocate id   transcript→     atoms/code/    embeddinggemma  upsert        │
│   write source  atoms (turns    <slug>.md      + MRL×TQ        registry      │
│                  + code blocks)                cascade         emit URL      │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│   ON-DISK CONTAINER LAYOUT (runs/ctx/<shortId>/)                             │
│                                                                              │
│   source.txt                          raw input (audit + rebuild)            │
│   atoms/code/<slug>.md                one file per atom, frontmatter + body  │
│   index/atom-ids.json                 idx → slug map (retrieval order)       │
│   index/cascade.json                  manifest: tiers, embedder, seed        │
│   index/embeddings.fp32.bin           exact 768d×4 bytes/vector              │
│   index/embeddings.tq-d256-b3.bin     coarse tier (MRL→256, b=3)             │
│   index/embeddings.tq-d768-b3.bin     fine tier (full 768, b=3)              │
│   events.jsonl                        append-only agent log (created on use) │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│   CROSS-LLM CONSUMPTION (plain HTTP)                                         │
│                                                                              │
│   GET    /ctx                       → list all containers                    │
│   GET    /ctx/:id                   → container metadata                     │
│   POST   /ctx/:id/retrieve          → {query, k} → {hits: [...]}             │
│   GET    /ctx/:id/atom/:slug        → raw atom markdown                      │
│   POST   /ctx/:id/events            → {agent, query, atom_ids, ...}          │
│   GET    /ctx/:id/events            → ndjson event log                       │
│                                                                              │
│   No SDK required. Same endpoints serve curl / ChatGPT Custom GPT Action     │
│   / Claude MCP shim / Cursor / Gemini CLI / any agent runtime.               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Layer model

The session deliverables are four concentric layers around the same retrieval primitive:

| Layer | Purpose | Status |
|---|---|---|
| **L1** `project-context` workflow | Gitchain-wrapped submodule pattern for whole-repo containers with provenance + anchor | Designed, stages written, not wired |
| **L2** Abrechnung sample | Proof: one concrete container in this repo | Built, indexed, verified |
| **L3** `ctx` CLI + lib + HTTP | Generic, transcript-driven; the actual portable surface | Live, smoke-tested |
| **L4** `ctx-bootstrap` workflow + demo UI | Same as L3 but rendered through the sturm engine for showcase | Live, smoke-tested |

L3 is the load-bearing layer for the merge. L4 is the public demo. L1 is the longer-term gitchain story. L2 is the sample data.

---

## 3. The retrieval primitive — Quantum-Cascade

Reused unchanged from the existing `gemma-quantum-container` work in this repo (see [reference memory](../../.claude/projects/-Users-christophbertsch-Desktop-sturm-0711-io/memory/reference_gemma_quantum_container.md)). The cascade is:

1. **Embed** via Ollama `embeddinggemma:latest` (`google/embeddinggemma-300m`, native 768d, multilingual incl. German).
   - Document-side prompt: `title: {title} | text: {content}`
   - Query-side prompt: `task: search result | query: {content}`
   - **Asymmetric prompts are mandatory** (3–7 MTEB points lost without them).
2. **Quantize** with MRL × TurboQuant:
   - Tier 0: MRL-truncate to 256d, TurboQuant b=3 → 200 candidates.
   - Tier 1: full 768d, TurboQuant b=3 → 50 candidates.
   - Tier 2 (exact): fp32 inner-product rerank → final top-K.
3. **Manifest** at `index/cascade.json` is loaded by `QuantumCascade.loadFromManifest(dir, manifest, finalK)`.

Compression: 7.5× at d=256, 7.8× at d=768. Build time: ~80 ms / 100 atoms on CPU.

**Critical env**: `EMBED_CPU=1` is mandatory on H200V — vLLM saturates both GPUs for `gemma4-mm`, so Ollama OOMs at GPU load. CPU embed is fast enough (~50 ms/atom).

---

## 4. File inventory

Grouped by what they belong to. Paths relative to repo root.

### 4.1 Shared library (the merge-critical core)

These are the files that have to come along when porting `ctx` into another Node/TS project. Total ~600 LOC.

| File | LOC | Role |
|---|---|---|
| [src/lib/ctx-shared.ts](../src/lib/ctx-shared.ts) | 230 | `Atom` interface, `buildIndex()`, `retrieveFromContainer()`, `writeAtoms()`, `ollamaReachable()`, `slugify()`, `encodeTier()`, `packIndicesBigEndian()` |
| [src/lib/transcript-parser.ts](../src/lib/transcript-parser.ts) | 145 | `parseTranscript()` — detects OpenAI/Claude JSON exports, markdown turns, plain prompts; splits code blocks as separate atoms |
| [src/lib/ctx-store.ts](../src/lib/ctx-store.ts) | 60 | Local container registry in `runs/ctx/index.json` |
| [src/lib/ctx-server.ts](../src/lib/ctx-server.ts) | 100 | Express router exposing the `/ctx/*` endpoint surface |
| [scripts/ctx.ts](../scripts/ctx.ts) | 175 | CLI entrypoint (`new`, `list`, `index`, `retrieve`, `serve`) |

**Transitive runtime dependencies inside this repo** (also need to come along, or be reimplemented):

| Dependency | Path | What it provides |
|---|---|---|
| `gemma-embed` | [src/lib/gemma-embed.ts](../src/lib/gemma-embed.ts) | `embedDocuments`, `embedQueries`, `mrlTruncate`, `l2normalize`, `formatDocument`, `formatQuery` |
| `quantum-index` | [src/lib/quantum-index.ts](../src/lib/quantum-index.ts) | `QuantumIndex`, `QuantumCascade`, `CascadeManifest` interface |
| `qjl` | [src/lib/qjl/](../src/lib/qjl/) | `TurboQuantizer`, `PolarQuant`, `QJL` — the MRL × TurboQuant encoder/decoder |

Those three are first-party code in this repo. If you want to extract `ctx` as a standalone package, you'd need to either copy them too (recommended — they're ~1500 LOC, self-contained, no first-party deps) or extract them into a shared package first.

### 4.2 Sturm-side integration (only needed if merging into a sturm-shaped engine)

| File | LOC | Role |
|---|---|---|
| [src/workflows/ctx-bootstrap/index.ts](../src/workflows/ctx-bootstrap/index.ts) | 95 | Workflow definition + `registerCtxBootstrapStages()` |
| [src/workflows/ctx-bootstrap/stages/ctx-ingest.ts](../src/workflows/ctx-bootstrap/stages/ctx-ingest.ts) | 40 | Allocate id + persist source |
| [src/workflows/ctx-bootstrap/stages/ctx-parse.ts](../src/workflows/ctx-bootstrap/stages/ctx-parse.ts) | 35 | Transcript → atoms |
| [src/workflows/ctx-bootstrap/stages/ctx-atomize.ts](../src/workflows/ctx-bootstrap/stages/ctx-atomize.ts) | 30 | Write atoms/code/ + atom-ids.json |
| [src/workflows/ctx-bootstrap/stages/ctx-index.ts](../src/workflows/ctx-bootstrap/stages/ctx-index.ts) | 75 | Embed + Quantize via lib `buildIndex()` |
| [src/workflows/ctx-bootstrap/stages/ctx-publish.ts](../src/workflows/ctx-bootstrap/stages/ctx-publish.ts) | 60 | Upsert registry + emit retrieve URL |
| [src/ui/ctx-demo.html](../src/ui/ctx-demo.html) | 365 | Single-file vanilla HTML/CSS/JS demo page |

If the target project has its own workflow engine (or no engine at all), skip this whole layer — the CLI + HTTP server in §4.1 are sufficient.

### 4.3 Edits to existing files

Three small additive edits inside `sturm.0711.io` to wire the above in:

| File | Change |
|---|---|
| [src/workflows/index.ts](../src/workflows/index.ts) | +2 lines: import + register `ctxBootstrapWorkflow` |
| [src/server.ts](../src/server.ts) | +1 import, +1 mount (`app.use('/ctx', ...)`), +1 HTML route (`/ctx-demo.html`) — ~10 lines total |

### 4.4 The project-context (L1) workflow — designed, not wired

Drafted earlier in the session for the gitchain-submodule pattern. Compiles, does not register at boot. Use as reference when the gitchain side is in scope.

| File | LOC | Role |
|---|---|---|
| [src/workflows/project-context/index.ts](../src/workflows/project-context/index.ts) | 115 | 6-stage workflow def |
| [src/workflows/project-context/stages/project-attach.ts](../src/workflows/project-context/stages/project-attach.ts) | 75 | `git submodule add` against project's own remote |
| [src/workflows/project-context/stages/project-atomize.ts](../src/workflows/project-context/stages/project-atomize.ts) | 200 | Walks `project/` at pinned SHA, splits files into atoms |
| [src/workflows/project-context/stages/project-quantum-encode.ts](../src/workflows/project-context/stages/project-quantum-encode.ts) | 80 | Shells out to `scripts/encode-gemma-quantum-container.ts` (needs script refactor before usable) |
| [src/workflows/project-context/stages/project-quantum-retrieve.ts](../src/workflows/project-context/stages/project-quantum-retrieve.ts) | 75 | Tool-stage wrapping `QuantumCascade.topK` |
| [src/workflows/project-context/stages/agent-turn.ts](../src/workflows/project-context/stages/agent-turn.ts) | 50 | Append to events.jsonl |
| [src/workflows/project-context/stages/project-push-out.ts](../src/workflows/project-context/stages/project-push-out.ts) | 70 | Push agent branch to project origin; commit outer container |

### 4.5 Sample data — the Abrechnung container (L2)

Concrete proof of the pattern. Curated 15 Abrechnung-relevant files from this repo (`bmf-rechner-compute`, `bmf-mcp-client`, `elster-v3/stages/phase{3,4,5}-*`, `canonical-layer`, `estg-citations`, related docs), atomized into 150 atoms, embedded, indexed.

| File | LOC | Role |
|---|---|---|
| [scripts/build-project-context-abrechnung.ts](../scripts/build-project-context-abrechnung.ts) | 330 | Self-contained build script (predates the lib extraction; works standalone) |
| [scripts/retrieve-project-context.ts](../scripts/retrieve-project-context.ts) | 75 | Query-side companion |
| `runs/project-context/abrechnung/` | (artifacts) | 150 atoms + cascade manifest + fp32 + 2 TQ tiers = 1.2 MB |

You can throw this sample away if not needed — it lives entirely under `runs/`.

---

## 5. Dependencies

### 5.1 npm packages

All already in `package.json` of `sturm.0711.io`:

| Package | Used for |
|---|---|
| `express` (^4.19) | HTTP server (`/ctx/*` routes) |
| `simple-git` | `project-context` workflow only (submodule operations) |
| `pg` | `project-context` workflow only (via `GitChainClient`) |
| Node built-ins | `fs/promises`, `crypto`, `path`, `child_process` |

No new dependencies were added in this session. Zero npm-install required.

### 5.2 External services

| Service | Where | Required for |
|---|---|---|
| Ollama with `embeddinggemma` | H200V `192.168.145.10:11434` (SSH tunnel) | **All embed and retrieve operations** |
| vLLM `gemma4-mm` | H200V `192.168.145.10:11435` (SSH tunnel, optional) | Not used by `ctx` directly. Only needed if you also want the sturm `steuerfall-est` Anwendung to boot — otherwise pass `STURM_TOOLS_BOOT=skip`. |

### 5.3 Internal lib dependencies (must port along with ctx)

`gemma-embed` → `quantum-index` → `qjl/`. Self-contained: no further first-party deps. Total surface ~1500 LOC.

---

## 6. Configuration

### 6.1 Environment variables

| Var | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Where to send EmbeddingGemma requests |
| `EMBED_MODEL` | `embeddinggemma` | Ollama model name |
| `EMBED_CPU` | `0` | Set to `1` to force CPU inference (mandatory on H200V) |
| `GEMMA_EMBED_BATCH` | `32` (script) / `16` (lib) | Batch size for embed requests |
| `CTX_STORE_ROOT` | `runs/ctx` (rel to cwd) | Override where containers live on disk |
| `PORT` | `7800` (sturm) / `9711` (standalone `ctx serve`) | HTTP port |
| `STURM_TOOLS_BOOT` | `boot` | Set to `skip` to bypass eager tool-container preflight |
| `STURM_BEARER_TOKEN` | unset | If set, `Authorization: Bearer <token>` required on protected sturm routes; `/ctx/*` is unprotected by design |

### 6.2 SSH tunnel to H200V

```bash
mkdir -p /tmp/sturm-ssh && ssh -f -N -L 11434:localhost:11434 \
  -o ControlMaster=auto -o ControlPath=/tmp/sturm-ssh/h200v.sock \
  christoph.bertsch@192.168.145.10

# Close cleanly when done:
ssh -O exit -S /tmp/sturm-ssh/h200v.sock christoph.bertsch@192.168.145.10
```

The ControlMaster process can exit on long idle — re-run the open command if `curl localhost:11434/api/tags` stops responding.

---

## 7. Porting to another TypeScript/Node project

You said the target is another TS/Node project. Here's the concrete sequence.

### 7.1 Copy these files verbatim

```
src/lib/ctx-shared.ts
src/lib/transcript-parser.ts
src/lib/ctx-store.ts
src/lib/ctx-server.ts
src/lib/gemma-embed.ts
src/lib/quantum-index.ts
src/lib/qjl/                     # whole directory
scripts/ctx.ts
```

If you want the workflow + UI surface too:

```
src/workflows/ctx-bootstrap/    # whole directory
src/ui/ctx-demo.html
```

### 7.2 Import path adjustments

Every TS file uses **explicit `.ts` extensions** in imports (the repo runs via `tsx`, no build step). If your target uses `tsc` build, either:

- enable `"allowImportingTsExtensions": true` in `tsconfig.json` (TS ≥ 5.0), or
- run a find/replace dropping the extensions: `'./foo.ts'` → `'./foo'`.

The qjl/ subdirectory uses relative imports like `'./haar.ts'` — same rule applies.

### 7.3 Wire-in checklist

1. Ensure `express` is in your `package.json` (or swap `ctx-server.ts` for whatever HTTP framework you use — the routes are 5 simple JSON-in/JSON-out handlers).
2. Mount the router somewhere visible:
   ```ts
   import express from 'express';
   import { createCtxRouter } from './lib/ctx-server';
   app.use('/ctx', express.json({ limit: '5mb' }), createCtxRouter({
     ollamaUrl: process.env.OLLAMA_URL,
     embedCpu: process.env.EMBED_CPU === '1',
   }));
   ```
3. Decide your container store root via `CTX_STORE_ROOT` or leave default `runs/ctx` next to cwd.
4. Verify the SSH tunnel pattern is feasible in your target environment, **or** point `OLLAMA_URL` at a local Ollama install with `embeddinggemma` pulled (`ollama pull embeddinggemma`).
5. If you don't have a workflow engine: skip `src/workflows/ctx-bootstrap/` entirely; the CLI + HTTP server is fully self-sufficient.

### 7.4 What stays behind in sturm.0711.io

- `src/server.ts` edits (the `app.use('/ctx', ...)` mount + `/ctx-demo.html` route) are sturm-specific glue; reimplement equivalents in your target server.
- `src/workflows/index.ts` registration is sturm-engine-specific; only matters if you bring the workflow over.
- `runs/project-context/abrechnung/` is sample data — discard or rebuild for your domain.
- `src/workflows/project-context/` (the gitchain submodule pattern) depends on `src/lib/gitchain-client.ts` which depends on Postgres. Only port if you have or want gitchain in the target.

---

## 8. Smoke tests after merging

Run these in the target project to prove the merge worked. Assumes Ollama is reachable.

### 8.1 Library smoke

```bash
# Drop a transcript in
echo "**User:** Hello\n\n**Assistant:** Hi! \`\`\`ts\nconst x = 42;\n\`\`\`" \
  | EMBED_CPU=1 tsx scripts/ctx.ts new --name smoke
# Expect: 3 atoms extracted, indexed in ~1 s, JSON summary printed
```

### 8.2 CLI retrieve

```bash
tsx scripts/ctx.ts list
tsx scripts/ctx.ts retrieve smoke-<short> "the constant value" 2
# Expect: top hit = the code-block atom (score > 0.3)
```

### 8.3 HTTP retrieve

```bash
tsx scripts/ctx.ts serve --port 9711 &
sleep 1
curl -s -X POST http://localhost:9711/ctx/smoke-<short>/retrieve \
  -H 'content-type: application/json' \
  -d '{"query":"the constant value","k":2}' | jq .hits[0].score
# Expect: 0.3+
```

### 8.4 Cross-LLM check

Paste this into any LLM that supports curl-as-a-tool or a custom action:

```
You have a retrieval endpoint at POST http://localhost:9711/ctx/<short>/retrieve
that takes {"query": "...", "k": 5} and returns {hits: [{slug, score, path, symbol, preview}]}.

Call it now with query "the constant value" and tell me what you find.
```

Expect the LLM to invoke the endpoint and report back with the slug + score.

---

## 9. Verified retrieval quality (from this session)

Concrete numbers from the smoke tests we ran. **abrechnung-design-chat** container, 6 atoms (4 turns + 2 code blocks), built from a 1.3 KB transcript:

| Query | Top hit | Score |
|---|---|---|
| `BMF MCP graceful degradation` | turn-1 assistant prose (the `bmf-rechner-compute` design) | **0.472** |
| `Splittingtarif veranlagungsart` | tied: turn-1 prose + the code block with `VeranlagungArt` check | **0.399 / 0.388** |
| `Vorsorge-Höchstbetrag Splittingtarif` | turn-2 user (the §10 EStG question) | **0.337** |

**abrechnung sample container** (`0711:project:sturm:abrechnung:v1`), 150 atoms across 15 source files:

| Query | Top hit | Score |
|---|---|---|
| `BMF Rechner MCP graceful degradation` | `bmf-rechner-compute.ts#BmfRechnerComputeConfig` | **0.568** |
| `Solidaritätszuschlag Berechnung` | `estg-citations.ts#RECHENSCHRITT_CITATIONS` | **0.304** |
| `Splittingtarif Vorsorge` | `CONTAINER_BRIEF.md#§EStG-Framework` | 0.243 |

Latency: 350–450 ms per query end-to-end (query embed + 3-tier cascade + body load).

---

## 10. The other deliverable — workspaces.ts split plan

A parallel finding from this session, not implemented because it needs human review and a test harness first. Captured here for the merge record.

### 10.1 The problem

[src/server/workspaces.ts](../src/server/workspaces.ts) is **105,679 bytes / 2,556 lines** with **31 router endpoints** and one giant `createWorkspacesRouter` closure. Seven concurrent `.claude/worktrees/` directories all touching this file are a merge-conflict hazard.

### 10.2 Proposed seams

Split into per-domain sub-routers plus shared helpers. Old `workspaces.ts` becomes a ~80-line compose layer using `router.use()`:

| Target file | Bytes pulled | Contains |
|---|---|---|
| `src/server/workspaces/registry.ts` | ~150 LOC | `WorkspaceRecord`, `readIndex`/`writeIndex`/`generateWorkspaceId`, `GET /`, `POST /`, `GET /:ws` |
| `src/server/workspaces/documents.ts` | ~600 LOC | Upload + multer, `GET/PATCH /:ws/documents`, `GET /:ws/documents/:uuid/file` |
| `src/server/workspaces/classify.ts` | ~350 LOC | `POST .../reclassify`, `POST .../extract`, `POST .../template`, `POST .../merge` |
| `src/server/workspaces/pipeline.ts` | ~300 LOC | `GET /:ws/pipeline`, `GET/POST/DELETE /:ws/binding`, `GET /:ws/canonicals*`, `createPipelinesRouter` |
| `src/server/workspaces/bboxes.ts` | ~50 LOC | bbox GET + POST |
| `src/server/workspaces/jobs.ts` | ~80 LOC | jobs POST + GET |
| `src/server/workspaces/master.ts` | ~350 LOC | `master.json`, `master/:hash`, `master/log`, `master/verify`, the `cachedMasterKey` resolver |
| `src/server/workspaces/webhooks.ts` | ~110 LOC | 4 webhook endpoints + `GET /:ws/events` |
| `src/server/workspaces/audit.ts` | ~250 LOC | `POST .../audit`, `POST .../bboxes` (annotation-leaf math) |
| `src/server/workspaces/_meta.ts` | ~200 LOC | `DocumentMeta`, `HistoryChange`, `deriveVersionAndSha`, all `diff*` helpers |
| `src/server/workspaces/_paths.ts` | ~30 LOC | `SAFE_SEG`, `safeSeg`, `slugify`, `extOf` |

### 10.3 Pre-split risks

1. **No tests on the surface being moved.** Sibling files have tests (`aggregation.test.ts`, `applications.test.ts`) but `workspaces.ts` has none. **Add one round-trip test per domain before splitting.**
2. **`cachedMasterKey` is a closure-scoped lazy**; if `master.ts` becomes its own factory, plumb the cache as a constructor arg.
3. **Worktree etiquette**: do the split on a single branch with no concurrent agents touching `workspaces.ts`.

### 10.4 Recommended order

1. Test harness (30 min)
2. Extract `_paths.ts` + `_meta.ts` — pure helpers (15 min, ~25 KB off the monolith)
3. Extract `master.ts` — most self-contained (30 min)
4. Extract `webhooks.ts` + `jobs.ts` + `bboxes.ts` (30 min)
5. Extract `documents.ts` + `classify.ts` + `pipeline.ts` + `audit.ts` (1–2 h)
6. Final compose layer in `workspaces.ts`

---

## 11. Known issues and pending work

### 11.1 Blockers

- **`scripts/encode-gemma-quantum-container.ts`** is hardcoded to the ELSTER atoms.json shape (uses `a.metadata.drucktext`, `a.atom_id`, etc.). The L1 `project-context/ctx-index` stage shells out to it, so until the script is refactored to accept `PCTX_ATOMS_DIR`/`PCTX_INDEX_DIR` env vars and a generic atom format, **L1 won't run end-to-end**. The L3/L4 path doesn't have this problem — it uses `buildIndex()` directly from `ctx-shared.ts`.

### 11.2 Pre-existing repo issues unrelated to this session

- **TypeScript errors in `src/server.ts:702-719`** on `ApplicationInstance` properties. Predate this session. Don't block runtime (repo uses `tsx`). Will look like noise on `tsc --noEmit`.

### 11.3 Deliberately not-done in this session

1. **MCP stdio shim** — ~40 lines once you want native Claude Desktop / Cursor wiring. Deferred; HTTP works for testing now.
2. **Share-URL fetchers** (`ctx new --from https://claude.ai/share/...`). Each LLM's share format is different and changes; paste-into-stdin is more robust.
3. **Container promotion to gitchain** — no `ctx push <id>` that turns `0711:ctx:local:*` → `0711:ctx:gitchain:*`. The on-disk layout already matches what gitchain expects; ~80 lines when wanted.
4. **Pruning / TTL** — `runs/ctx/` grows monotonically. Add `ctx rm` + a TTL when you have enough containers to care.
5. **Auth on `/ctx/*`** — mounted unprotected to match the `CLAUDE.md` playground posture. Gate at the reverse-proxy before public exposure.
6. **Workspaces split** — plan only (see §10).
7. **L1 workflow registration** — `project-context` workflow exists but `registerProjectContextStages()` is not called from `src/server.ts`. Wire-in when the gitchain side is ready.

---

## 12. Quick start (after merging)

### Local dev, sturm-style boot

```bash
# 1. Open Ollama tunnel
mkdir -p /tmp/sturm-ssh && ssh -f -N -L 11434:localhost:11434 \
  -o ControlMaster=auto -o ControlPath=/tmp/sturm-ssh/h200v.sock \
  christoph.bertsch@192.168.145.10

# 2. Boot the server
PORT=7800 OLLAMA_URL=http://localhost:11434 EMBED_CPU=1 STURM_TOOLS_BOOT=skip \
  tsx src/server.ts

# 3. Open the demo
open http://localhost:7800/ctx-demo.html
# Click "Load sample" → "Build context" → watch 5 stages run, then use the playground.
```

### Standalone ctx CLI (no sturm engine)

```bash
# Build a container
pbpaste | EMBED_CPU=1 tsx scripts/ctx.ts new --name my-project

# List
tsx scripts/ctx.ts list

# Retrieve from CLI
tsx scripts/ctx.ts retrieve my-project-<short> "your question" 5

# Serve for cross-LLM consumption
EMBED_CPU=1 tsx scripts/ctx.ts serve --port 9711
```

### Cross-LLM consumption snippets

**curl (any agent):**
```bash
curl -X POST http://localhost:9711/ctx/<shortId>/retrieve \
  -H 'content-type: application/json' \
  -d '{"query": "...", "k": 5}'
```

**OpenAPI fragment for ChatGPT Custom GPT Action** (paste into Action editor):
```json
{
  "openapi": "3.1.0",
  "info": { "title": "0711 ctx", "version": "1.0" },
  "servers": [{ "url": "https://<your-host>" }],
  "paths": {
    "/ctx/<shortId>/retrieve": {
      "post": {
        "summary": "Retrieve top-K context atoms",
        "operationId": "retrieveContext",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["query"],
            "properties": {
              "query": { "type": "string" },
              "k": { "type": "integer", "default": 5 }
            }
          }}}
        },
        "responses": { "200": { "description": "Hits" } }
      }
    }
  }
}
```

**System-prompt preamble for any LLM:**
```
You have access to a retrieval tool called `ctx` that returns top-K
context atoms from this project's container. The container was bootstrapped
from a prior conversation. Before answering project-specific questions, call:

  POST http://<host>/ctx/<shortId>/retrieve
  Content-Type: application/json
  { "query": "<your search>", "k": 5 }

Treat returned atoms as authoritative project context. Each atom carries
{slug, score, path, symbol, preview}. Cite path#symbol when you use one.
```

---

## 13. Reference — key contracts

### 13.1 The `Atom` shape

```ts
export interface Atom {
  slug: string;             // stable; file name in atoms/code/<slug>.md
  path: string;             // origin tag (turn:0:user, src/foo.ts, ...)
  symbol: string;           // symbol/section/turn label
  kind: string;             // turn-user / turn-assistant / code-block / markdown-section / ts-symbol / file / prompt-system
  span?: { start: number; end: number };
  body: string;             // raw text
  title: string;            // for embedding-side document title prompt
  frontmatter?: Record<string, string>;  // extra fields written into atom file
}
```

### 13.2 The retrieve response

```ts
POST /ctx/:id/retrieve   →
{
  containerId: string;        // 0711:ctx:local:<shortId>
  query: string;
  k: number;
  hits: Array<{
    slug: string;             // matches the on-disk file under atoms/code/
    score: number;            // inner product, fp32 rerank
    path?: string;            // from atom frontmatter
    symbol?: string;          // from atom frontmatter
    preview: string;          // first ~240 chars of atom body
  }>;
}
```

### 13.3 The container registry record

```ts
export interface CtxRecord {
  id: string;             // 0711:ctx:local:<slug>-<short>
  shortId: string;        // <slug>-<short> — used as on-disk folder
  name: string;
  atomCount: number;
  nativeDim: number | null;
  builtAt: string;        // ISO
  status: 'pending' | 'indexed';
  outDir: string;         // absolute path
  notes?: string;
}
```

---

**End of handover.** Anything unclear, ask before merging — the layer boundaries matter more than the line counts.
