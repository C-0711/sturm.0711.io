# Deploy — operational reference

Phase F.2 / Task 8. Single source of truth for how `0711-STURM` is deployed and reached.

## Topology

```
                           Cloudflare
              [ tunnel: 0711-platform ]      [ tunnel: mastermind-bridge ]
                       │                             │
                       │ HTTPS                       │ HTTPS
                       │                             │
                       ▼                             ▼
                  REACTOR (Mac)                 BRIDGE (Mac)
                  ───────────────               ───────────────
                  STURM web :7800               (mastermind UI)
                  RAG API   :7813
                  Ollama    :11434
                  Postgres  :5433  (gitchain)
                  ───────────────               ───────────────
```

REACTOR is the primary build/run host (Apple Silicon Mac mini on Scaleway-style hosting). All ports are LOCAL to REACTOR; outside reachability is via the Cloudflare Tunnel `0711-platform`. There is no direct SSH ingress in the tunnel today — see `deploy/cloudflare/README.md`.

## Ports — declared, no implicit defaults

| Service | Port | Env key | Notes |
|---|---|---|---|
| STURM web (Express + SSE) | `7800` | `PORT` | the workflow engine |
| Gemma 4 RAG API | `7813` | `STURM_RAG_PORT` | new in F.2; reads from gitchain containers |
| Ollama | `11434` | `OLLAMA_URL` | model host (Gemma + bge-m3) |
| Postgres (gitchain) | `5433` | `GITCHAIN_DATABASE_URL` | gitchain container metadata |
| Gitchain HTTP API | `3361` | `GITCHAIN_API_URL` | container CRUD |

CLAUDE.md historically named port 7800. Q.rtf referenced 7813 for "the RAG service on REACTOR". Both coexist: 7800 is the workflow engine UI, 7813 is the RAG read-API on top of signed containers.

## Tunnels

| Tunnel | Status | Notes |
|---|---|---|
| `0711-platform` | HEALTHY | 65 routes; serves `gitchain.0711.io`, `api-gitchain.0711.io`, `storage.0711.io`, `sturm.0711.io`, … |
| `mastermind-bridge` | HEALTHY | 1 route: `mastermind.0711.io` |
| `lightnet-tender` | HEALTHY | 3 routes: `lightnet-tender.0711.io`, `data-ln.0711.io`, `search-ln.0711.io` |
| `h200v-gitty` | **DOWN** | route `gitty.0711.io`; either restart or delete the tunnel |

The DOWN tunnel is not a runtime issue — it's a health/hygiene cleanup. Decide whether `gitty.0711.io` is a real production hostname or a relic; if relic, delete the tunnel from Cloudflare to remove the noise.

## Spinning up REACTOR locally

```sh
# 0. clone canonical
git clone git@github.com:C-0711/sturm.0711.io.git
cd sturm.0711.io

# 1. env — copy and fill from your secrets manager (NOT from 0711-ALLES.rtf)
cp deploy/reactor/env.production.example .env.production

# 2. install
npm ci

# 3. build the contract package
( cd packages/gitchain-types && npx tsc --noEmit -p . )

# 4. run parity tests
npm run test:parity

# 5. start STURM
npm start
```

Target: a fresh developer is serving `http://localhost:7800` within 30 minutes of `git clone`.

## Audit gate

- `npm run test:parity` must pass on the canonical `main`. CI enforces this on every PR.
- `tsx scripts/rename-strays.ts` must exit 0.
- The Cloudflare route map in `deploy/cloudflare/routes.yaml` must match the live tunnel config (run `deploy/cloudflare/refresh-routes.sh` to diff).

## Rotation cadence

Tokens, signing keys, and the `0711-ALLES.rtf` cleartext are out of scope for Task 8 — they're the security workstream. The vault on REACTOR (`0711:gateway:auth:v1`) is the single source of truth for production secrets. **Never** put production secrets in `.env.production` directly; use a secret manager or the gateway's age-sealed vault.
