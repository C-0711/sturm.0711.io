# Sturm + Quantum Container — Priority Ledger
**Generated:** 2026-05-09 21:00 CEST · Bombas
**Per Mastermind C directive:** "the most important fort project is 0711-Sturm with Quantum Container — Find all"

---

## 🌪️ STURM — Workflow Engine (LIVE PRODUCTION)

### Single Source of Truth: REACTOR-only
- **Path:** `/home/christoph.bertsch/0711/0711-STURM/`
- **GitHub:** `C-0711/sturm.0711.io.git` (private)
- **Live:** https://sturm.0711.io/ (HTTP/2 200, nginx-Wildcard, NOT cf-tunnel)
- **PM2:** id 20, name `sturm`, status online, uptime 30h, port 7800
- **Database:** writes to ctax-postgres + ctaxv1-postgres, reads from gitchain containers
- **Key files:**
  - `package.json` — node service
  - `ecosystem.config.cjs` — PM2 config
  - `e2e-confidence.ts` — pipeline confidence harness
  - `start.sh` — entry script (sources `.env`)
  - `.env`, `.env.example` (provisioning)
  - `.master-key.json` (anchor signer)
  - `.anchor-api-key` (anchor service auth)
  - `nginx/`, `logs/`, `legacy/`, `docs/`

### Git State (DIRTY — important to audit)
- **Branch:** `feat/gitchain-types-elster-contract` (NOT main!)
- **HEAD:** `ac6d2ef045b617e19c9f4e6e710326e3dc850ed3`
- **Dirty:** 33 uncommitted lines
- **Branches local:** main, feature/gitchain-integration, feature/gitchain-phase2, feat/gitchain-types-elster-contract (current)
- **Recent commits:**
  - `ac6d2ef` feat(gitchain-types): lock ELSTER layer4-aggregate data contract (PR #1, awaits Architect audit)
  - `41998c8` chore(running-state): Source-Tree-Snapshot — alle untracked Source-Files
  - `5d3c9eb` chore(running-state): zweite Welle Server.ts + Elster-Workflow Klassifizierung-Stage
  - `2892280` chore(running-state): Staged-Snapshot vom laufenden STURM-Service
  - `a50e2eb` fix(classify): JPG/PNG via image_url statt document_url

### Sturm Workflows (verticals/)
- `elster-v3-multi` — primary, multi-stage German tax form aggregator
- Hello-OCR, elster-v1, steuerbelege-v1, belege-bundle-v1 (legacy / earlier versions)
- Active: `src/verticals/elster-v3/` — Layer 1, Layer 2, Layer 3 (multi.ts), Layer 4 (aggregate via gitchain-types)

### Sturm-Sturm Container Output
- `src/verticals/elster-v3/data/container.json` — produced quantum container `0711:elster:bmf:jahresdok-2024:v1`
- `merkle.json` — Merkle tree of ELSTER atoms (root: `66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd`)
- `atoms.json` — 2287 ELSTER eCodes across 35 Anlagen, signed
- `embeddings.meta.json` — bge-m3, 1024d, 2287 vectors via Ollama

### Sturm Sub-Locations (NOT canonical — claude worktrees + cache)
- `~/.cache/claude-cli-nodejs/-home-christoph-bertsch-0711-0711-STURM` (Claude cache)
- `~/.cache/claude-cli-nodejs/-tmp-sturm-gitchain` (Claude tmp scratch)
- `~/.claude/projects/-home-christoph-bertsch-0711-0711-STURM` (Claude project metadata)
- `~/.claude/projects/-tmp-sturm-gitchain` (Claude project metadata)

### Sturm Prototype Forks (in dev-cb-ctax — different lineage)
- `~/dev-cb-ctax/backend/src/sturm/` — Sturm code embedded in ctax backend (older fork?)
- `~/dev-cb-ctax/scripts/sturm_pipeline_prototype/` — pipeline prototype
- `~/dev-cb-ctax/scripts/sturm_prototype/` — earlier prototype
- `~/dev-cb-ctax/.claude/worktrees/{nice-gagarin,reverent-payne,serene-goldstine}/scripts/sturm_*` — Claude worktree copies of these prototypes

**⚠️ DECISION POINT:** are these Sturm-prototypes-in-dev-cb-ctax STALE (replaced by 0711-STURM/) or PARALLEL (still actively used)? Pope to classify.

### Sturm GitHub Stubs in Ledger
- `~/0711/0711-vault/islands/_remote-stubs/c-0711_sturm_0711_io.yaml` (auto-generated 18:38)

---

## 📦 QUANTUM CONTAINER — Pattern + All Realizations

### The Pattern (defined locally)
- **Schema:** `~/0711/0711-vault/schema/container.v1.yaml` (Bombas, signed Phase 1)
- **Container ID format:** `0711:<vertical>:<purpose>:<identifier>:v<N>`
- **Required fields:** id, schema_version, version, type, namespace, identifier, merkle_root, container_sha256, signature, issuer_fingerprint, anchor_*
- **Provenance:** ed25519-signed manifest, x25519-encrypted blobs, anchor on Base mainnet

### Containers Produced — Live Inventory

#### Vault Container (Bombas, Phase 1 today)
- **ID:** `0711:gateway:auth:v1`
- **Issuer fp:** `sha256:4657b3f701b1fa5aac371845715460603f7838186196abfceb03b0bd311118d0`
- **Anchor digest:** `737517b33b4ea18f30f1b643bc9b47d725559d156121fc73956d266689dab5f2`
- **Contents:** 7 secrets (3 git PATs + 4 LLM keys)

#### ELSTER Container (Sturm-produced)
- **ID:** `0711:elster:bmf:jahresdok-2024:v1`
- **Merkle root:** `66e8ddf58ea9861de6bd8cb9051e32ec3c44d0a07be9c013296a3bc1b76157bd`
- **Issuer fp:** `sha256:a8861d4c1048152da063dc15d67bea9ed6c79ef1ccdefa0f02036c2826992dea`
- **Path:** `~/0711/0711-STURM/src/verticals/elster-v3/data/container.json`
- **Status:** signature: null, anchor_block: null → **NOT yet anchored on Base**

#### CTAX Mandant Containers (~/0711/containers/, 47 instances)
- **Pattern:** `0711:ctax:<uuid>:<sub-uuid>:v1`
- **Examples:**
  - `0711-ctax-4e639633-f84a-4317-a78a-a7e34d460a2c-{multiple uuids}-v1` (9 instances of mandant `4e63...`)
  - `0711-ctax-anon-4f5f03a5-307d-43c1-8-v1`
- **Aggregated in ledger:** `~/0711/0711-vault/islands/reactor/ctax-container-instances.yaml`

#### CTAX Core Containers (~/0711/core-containers/, 27 instances)
- **Pattern:** `0711-ctax-core-test-mandant-test-{a|b}-{happy|idem|lock}-{timestamp}-{seq}-v1`
- **Use:** test fixtures for ctax mandant lifecycle (happy path, idempotency, lock contention)
- **Status:** test artifacts, not production

#### CTAX Misc Containers (~/0711/ctax-containers/, 4 entries)
- `bmf-formeln/` — BMF formulas catalog
- `elster-felder/` — ELSTER field catalog
- `profile/` — profile data
- `inject.sh` — injection script

#### Test Containers (~/0711/test-containers/, 12 entries)
- Pattern: numeric IDs `7736506153`, `7736506154`, etc.
- These look like **Bosch product IDs** → likely test containers for Bosch product gitchain pipeline

#### Bosch Product Containers (~/0711/migration/bosch-products/, 817 instances)
- **Pattern:** `bosch-<product-id>` — each Bosch product = one quantum container
- **Aggregated in ledger:** `~/0711/0711-vault/islands/reactor/bosch-product-data-pipeline.yaml`

#### Cache Containers (~/.0711/cache/{containers,inject}, ad-hoc)

#### Punk-stream / experimental (~/0711/experiments/punk-stream/backend/containers, ~/0711/experiments/punk-containers)
- Experimental, not production

### Quantum Container Total Inventory
| Realm | Count | Type |
|---|---|---|
| Gateway/Auth (vault) | 1 | LIVE, anchor-ready |
| ELSTER (Sturm) | 1 | produced, NOT anchored |
| CTAX Mandants | 47 | production data containers |
| CTAX Core (tests) | 27 | test fixtures |
| CTAX Misc (catalogs) | 4 | catalog containers |
| Test Containers | 12 | test fixtures (Bosch IDs) |
| Bosch Products | 817 | data containers (versioned in localhost gitea:3340) |
| Punk-stream experiments | a few | experimental |
| **TOTAL** | **~910** | |

---

## 🔗 GitChain — The Backbone

### gitchain-types Package (PR #1, just delivered today)
- **Path:** `~/0711/0711-STURM/packages/gitchain-types/` (NOT in `~/packages/` as my SSH ls suggested earlier — it's nested inside Sturm)
- **Purpose:** type contract for ELSTER layer4-aggregate stage
- **Status:** Pushed as PR #1 to `C-0711/sturm.0711.io`, branch `feat/gitchain-types-elster-contract`
- **Awaits:** T-AR-002 Architect audit
- **Files:** `README.md`, `package.json`, `src/elster.ts` (281 lines), `src/index.ts`, `tsconfig.json`

### Other GitChain Repos
- `~/0711/0711-gitchain/` — main gitchain implementation (REACTOR copy of `C-0711/0711-gitchain`, last touched 2026-05-08)
- `~/.config/gitchain/` — gitchain user config
- `~/gitchain-dl/` — gitchain CLI download cache
- `~/gitchain-repos/` — gitchain repo cache
- `~/log/gitchain/` — gitchain logs
- `~/projects/bier/.gitchain/` — bier project's gitchain metadata
- `~/projects/landing-page-gitchain-for-banking/`, `~/projects/landing-page-pim-gitchain/` — landing page projects
- `~/.cache/claude-cli-nodejs/-home-christoph-bertsch-0711-0711-gitchain*` — Claude cache for gitchain work
- GitHub stubs: `c-0711_0711-gitchain.yaml`, `c-0711_gitchain-plugin.yaml`

---

## 🎯 Summary — What Mastermind C should know

### The big picture
**Sturm IS the workflow engine. Quantum Containers ARE the output format. Gitchain IS the backbone.**

Sturm produces ELSTER quantum containers (`0711:elster:bmf:jahresdok-2024:v1`) by running multi-stage aggregation pipelines. The container.v1.yaml schema in vault uses the same pattern. CTAX uses the pattern for mandants. Bosch uses it for products.

### What is solid (Phase 0 + 1 ratified)
- Vault container live + signed + anchor-ready
- 1 ELSTER container produced by Sturm (ready for anchoring once Architect ratifies the gitchain-types contract)
- 47 CTAX mandant containers in production
- 817 Bosch product containers (gitea-versioned)

### What is loose (Phase 1.5 / Wave 1 work)
- Sturm is on `feat/gitchain-types-elster-contract` branch (NOT main) with 33 dirty lines — needs PR #1 audit + merge to main
- ELSTER container has signature=null, anchor_block=null → not yet on chain
- 13 sturm-prototype copies in `dev-cb-ctax/` worktrees — STALE or PARALLEL?
- gitchain-types package lives inside `0711-STURM/packages/` not as standalone repo — should it move to its own repo for cross-product use?

### Recommended next moves
1. **Architect audit T-AR-002** — unblocks PR #1 merge, locks gitchain-types contract
2. **Anchor the ELSTER container on Base mainnet** — first non-vault production anchor, proves the end-to-end flow
3. **Sturm branch merge** — get `feat/gitchain-types-elster-contract` to main, clean dirty state
4. **Decide: extract `gitchain-types` to standalone repo?** — if other Sturm verticals (Bosch, CTAX-other) need their own contracts, package needs to live outside Sturm

### Open decisions for Pope (schema impact)
- Are sturm-prototypes in `dev-cb-ctax/scripts/` STALE or PARALLEL? (status taxonomy)
- Are container instances (47 + 27 + 12 + 817 = 903 directories) "islands" in the ledger sense, or "data products" outside the ledger?
- Should there be a separate "Container" entity in the ledger, distinct from "Repo Island"?
