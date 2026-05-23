#!/bin/bash
# Recreate sturm-mandanten container with new image.
# Preserves env, ports, volumes from previous container.
# Adds bind-mount for atoms-polar.json (runtime artifact ~2.5MB).
set -e

NEW_IMAGE="${1:-sturm-mandanten:latest}"
ATOMS_HOST_PATH="/home/christoph.bertsch/0711-STURM-mandanten/data/atoms-polar.json"

# Sanity: atoms file exists?
if [ ! -f "$ATOMS_HOST_PATH" ]; then
  echo "ERROR: atoms file missing at $ATOMS_HOST_PATH"
  exit 1
fi

# Save env (excluding default PATH/HOME etc.)
docker inspect sturm-mandanten --format "{{json .Config.Env}}" 2>/dev/null | \
  python3 -c "import json,sys; envs=json.load(sys.stdin); [print(e) for e in envs if not e.startswith((\"PATH=\",\"HOME=\",\"NODE_VERSION=\",\"YARN_VERSION=\"))]" > /tmp/sturm-env.txt 2>/dev/null || {
    echo "ERROR: container not found, cannot extract env. Use docker-compose instead."
    exit 1
  }

docker stop sturm-mandanten >/dev/null
docker rm sturm-mandanten >/dev/null

docker run -d \
  --name sturm-mandanten \
  --restart unless-stopped \
  --network bridge \
  --add-host host.docker.internal:host-gateway \
  -p 7801:7800 \
  -v /home/christoph.bertsch/0711-STURM-mandanten/runs:/app/runs \
  -v /home/christoph.bertsch/0711/0711-STURM/applications-data:/app/applications-data \
  -v /home/christoph.bertsch/0711/0711-STURM/uploads:/app/uploads \
  -v /home/christoph.bertsch/0711/0711-STURM/schemas:/app/schemas \
  -v /home/christoph.bertsch/0711/0711-STURM/workspaces:/app/workspaces \
  -v /home/christoph.bertsch/0711/0711-STURM/applications:/app/applications \
  -v "$ATOMS_HOST_PATH:/tmp/atoms-polar.json:ro" \
  --env-file /tmp/sturm-env.txt \
  "$NEW_IMAGE"

for i in $(seq 1 30); do
  sleep 1
  STATUS=$(docker inspect sturm-mandanten --format "{{.State.Health.Status}}" 2>/dev/null || echo "missing")
  if [ "$STATUS" = "healthy" ]; then echo "healthy at t+${i}s"; exit 0; fi
done
echo "WARN: not healthy after 30s"
docker logs sturm-mandanten --tail 20
exit 1
