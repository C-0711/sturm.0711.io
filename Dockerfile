# STURM — Workflow-Engine Dockerfile
# Builds a self-contained image of the sturm.0711.io Node service.
#
# Build:    docker build -t sturm:0.1.0 .
# Run:      docker compose up -d
# Probe:    curl http://localhost:7800/api/workflows
#
# Multi-stage to keep the runtime image lean.

# ── Stage 1: deps ─────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Install minimal toolchain for native deps (pg, simple-git transitive)
RUN apk add --no-cache git python3 make g++ \
 && ln -sf /usr/bin/python3 /usr/bin/python

COPY package.json package-lock.json* ./
COPY packages/gitchain-types/package.json ./packages/gitchain-types/

# Install everything (tsx is in devDependencies but is the runtime).
RUN npm ci --no-audit --no-fund

# ── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# git is needed at runtime: simple-git invokes the binary for bare-repo ops.
RUN apk add --no-cache git tini \
 && addgroup -S sturm \
 && adduser  -S -G sturm sturm

# Copy installed node_modules from deps stage
COPY --from=deps --chown=sturm:sturm /app/node_modules ./node_modules

# Copy source (note: .dockerignore prunes secrets, .git, runs/, workspaces/)
COPY --chown=sturm:sturm . .

# Runtime data dirs (mounted as volumes in docker-compose)
RUN mkdir -p /data/workspaces /data/runs /data/uploads /data/canonicals \
            /data/pipelines /data/schemas /data/gitchain-repos \
            /data/logs \
 && chown -R sturm:sturm /data

ENV NODE_ENV=production \
    PORT=7800 \
    STURM_INPUT_RETENTION_DAYS=7 \
    STURM_DATA_DIR=/data \
    GITCHAIN_REPO_ROOT=/data/gitchain-repos

USER sturm
EXPOSE 7800

# Tini = proper PID 1 for signal handling (replaces PM2's role)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "src/server.ts"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:7800/api/workflows >/dev/null || exit 1
