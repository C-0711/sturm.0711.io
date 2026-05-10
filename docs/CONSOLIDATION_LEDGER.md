# Consolidation Ledger — STURM 2026-05-10

> Audit trail for the Sturm consolidation: what was true *before*, what changed,
> what is true *after*. Every step is reproducible from git tags + commits.

---

## Pre-state · 2026-05-10

### Source of truth declared
- **Boss repo:** `https://github.com/C-0711/sturm.0711.io.git`
- **Local canonical clone:** `/Users/christophbertsch/0711-gitchain/canonical` (Mac)
- **Production runtime:** `/home/christoph.bertsch/0711/0711-STURM` (h200v, PM2 #31, port 7800)
- **Live URL:** `https://sturm.0711.io` (HTTP/2 200, CF-proxied)

### Drift snapshot
| Side | Branch | HEAD | Working tree |
|---|---|---|---|
| Mac (canonical) | `feat/phase-f2-task3-rule-scope-types` | `9e47e99` | clean |
| h200v (runtime) | `feat/gitchain-types-elster-contract` | `ac6d2ef` | **33 modified, 19 untracked** |

Mac is **+5 commits ahead** of h200v's branch (Phase F.2 Tasks 4 → 6 → 7 → 8 → 3).
h200v has **runtime tweaks + 5 new lib files** that never made it into git on Mac.

### Audit tags created
| Tag | Where | What it captures |
|---|---|---|
| `pre-consolidation-mac-2026-05-10` | Mac canonical | `9e47e99` — Phase F.2 Task 3 HEAD, clean tree |
| `pre-consolidation-h200v-2026-05-10` | h200v 0711-STURM | `3cdb8bb` (rescue commit on `rescue/h200v-runtime-2026-05-10` branch) — captures all 33 tracked-file edits + new lib files **without committing secrets** |

### Files explicitly NOT brought into git (security)
- `.anchor-api-key` — Ed25519 anchor signer key
- `.master-key.json` — master signer key
- `.wallet-rotation-20260508.txt` — wallet rotation log
- `*.bak.*` — live backups (Phase E + container-fix snapshots from 2026-05-08)
- `src/ui/pipeline.bundle.js` — build artifact, regenerable from `pipeline.jsx`

These remain on the production filesystem only and are now `.gitignore`d.

---

## Transformation steps

### Step 1 · Tag pre-state
```bash
# On Mac
cd /Users/christophbertsch/0711-gitchain/canonical
git tag -f pre-consolidation-mac-2026-05-10 9e47e99

# On h200v
cd ~/0711/0711-STURM
git checkout -b rescue/h200v-runtime-2026-05-10
# .gitignore extended for .anchor-api-key, .master-key.json, .wallet-rotation-*, *.bak.*
git add -u && git add <new code files only>
git commit -m "rescue(runtime): snapshot h200v PM2 runtime before consolidation"
git tag -f pre-consolidation-h200v-2026-05-10
```

### Step 2 · Create consolidation branch (Mac)
```bash
git checkout -b consolidation/sturm-2026-05-10  # off feat/phase-f2-task3
```

### Step 3 · Containerize (this commit)
Adds:
- `Dockerfile` — multi-stage Node 22-alpine + git + tini
- `.dockerignore` — explicit secret + .bak exclusion
- `docker-compose.yml` — sturm + postgres (pgvector/pg17), volumes for state
- `.env.example` — extended with `STURM_MASTER_HMAC_KEY` + `POSTGRES_PASSWORD`

Image goals:
- Self-contained: `docker compose up -d` brings up sturm + postgres
- Stateful: 8 named volumes (workspaces, runs, uploads, gitchain-repos, canonicals, pipelines, schemas, logs)
- Non-root: `sturm:sturm` user
- Healthcheck: `GET /api/workflows`
- Port: 7800 (matches existing nginx vhost on h200v)

### Step 4 · (Pending) Bring h200v's new lib files forward
The 5 files in `src/lib/` (`canonical-layer`, `cascade-runtime`, `embedding-runtime`,
`llm-chat`, `ocr`) and the runtime tweaks captured in
`pre-consolidation-h200v-2026-05-10` will be cherry-picked branch-by-branch.

### Step 5 · (Pending) Push to GitHub
```bash
git push origin consolidation/sturm-2026-05-10
git push origin pre-consolidation-mac-2026-05-10
# tag from h200v needs to be pushed via h200v's clone OR fetched first
```

### Step 6 · (Pending) Tag post-state
```bash
git tag post-consolidation-2026-05-10
```

---

## Post-state checklist

- [x] Mac canonical tagged `pre-consolidation-mac-2026-05-10`
- [x] h200v dirty state rescue-committed without secrets
- [x] h200v tagged `pre-consolidation-h200v-2026-05-10`
- [x] Consolidation branch created on Mac
- [x] Dockerfile + docker-compose.yml + .dockerignore added
- [x] .env.example extended with new variables
- [x] CONSOLIDATION_LEDGER.md (this file)
- [ ] h200v rescue branch fetched into Mac canonical as remote
- [ ] h200v new lib files cherry-picked onto consolidation branch
- [ ] Docker build succeeds (`docker build -t sturm:0.1.0 .`)
- [ ] Docker compose up succeeds + healthcheck passes
- [ ] Pushed to `github.com/C-0711/sturm.0711.io`
- [ ] Tagged `post-consolidation-2026-05-10`
- [ ] Master Catalog (Quantum Gateway) shows new state

---

## Rollback

If consolidation breaks anything:
```bash
# Mac
git checkout feat/phase-f2-task3-rule-scope-types
git branch -D consolidation/sturm-2026-05-10

# h200v: rescue branch is read-only audit trail, leave it in place.
# Production runtime is unchanged — PM2 #31 still runs the same code.
cd ~/0711/0711-STURM
git checkout feat/gitchain-types-elster-contract  # back to live branch
# Note: rescue commit captured the dirty state — if you want it back as
# uncommitted edits, do: git reset HEAD~1
```

The rescue tag and the original branches are immutable references — nothing
is lost during the consolidation.
