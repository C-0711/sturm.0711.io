#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Source lokale .env, fallback auf cb-ctax-.env (Keys teilen)
if [ -f .env ]; then
  set -a; source .env; set +a
elif [ -f ../../dev-cb-ctax/.env ]; then
  set -a; source ../../dev-cb-ctax/.env; set +a
fi

: "${PORT:=7800}"
export PORT
echo "→ STURM starting on :$PORT"
exec npx tsx src/server.ts
