#!/bin/bash
# Start the Mistral Playground with keys from cb-ctax .env
set -euo pipefail
cd "$(dirname "$0")"
set -a
source ../.env 2>/dev/null || true
source ../backend/.env 2>/dev/null || true
set +a
export PORT="${PORT:-7800}"
exec node server.mjs
