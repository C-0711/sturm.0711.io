#!/bin/bash
# Phase B trigger: anchor 0711:elster:bmf:jahresdok-2024:v1 on Base mainnet
# Run on REACTOR. Reads BLOCKCHAIN_PRIVATE_KEY from gitchain-service container env.
set -euo pipefail

CONTAINER_ID="0711:elster:bmf:jahresdok-2024:v1"
SERVICE_HOST="http://localhost:3361"

echo "=== Phase B Anchor: $CONTAINER_ID ==="

# 1) Check container is sealed + not yet anchored
docker exec gitchain-service-gitchain-postgres-1 psql -U gitchain -d gitchain -t -c \
  "SELECT json_build_object('id', id, 'sealed', v5_1_merkle_root IS NOT NULL, 'anchor_tx', v5_1_anchor_tx, 'chain', v5_1_anchor_chain) FROM containers WHERE id='$CONTAINER_ID';"

# 2) Set ANCHOR_WALLET_KEY = BLOCKCHAIN_PRIVATE_KEY in the running gitchain-service
#    (or persist via docker-compose if you want it permanent)
echo ""
echo "=== Wallet ==="
docker exec gitchain-service-gitchain-service-1 sh -c "node -e '
const {ethers} = require(\"ethers\");
(async () => {
  const provider = new ethers.JsonRpcProvider(\"https://mainnet.base.org\");
  const w = new ethers.Wallet(process.env.BLOCKCHAIN_PRIVATE_KEY, provider);
  const bal = await provider.getBalance(w.address);
  console.log(\"signer:\", w.address);
  console.log(\"balance ETH:\", ethers.formatEther(bal));
})();
'"

echo ""
echo "=== Hint: to actually anchor, restart gitchain-service with: ==="
cat <<'CFGEOF'
# In docker-compose.yml under gitchain-service: environment:
ANCHOR_WALLET_KEY: ${BLOCKCHAIN_PRIVATE_KEY}
ANCHOR_CHAIN: base-mainnet
ANCHOR_RPC_URL: https://mainnet.base.org
ANCHOR_CONTRACT_ADDRESS: 0xAd31465A5618Ffa27eC1f3c0056C2f5CC621aEc7
PROMOTER_EMAIL: christoph@0711.io
CFGEOF

echo ""
echo "Then with API key (or SSO JWT for christoph@0711.io):"
echo "  curl $SERVICE_HOST/api/v4/containers/$(printf %s \"$CONTAINER_ID\" | jq -sRr @uri)/anchor/preview \\"
echo "       -H 'X-API-Key: <KEY>'"
echo "  curl -X POST $SERVICE_HOST/api/v4/containers/$(printf %s \"$CONTAINER_ID\" | jq -sRr @uri)/anchor \\"
echo "       -H 'X-API-Key: <KEY>'"
