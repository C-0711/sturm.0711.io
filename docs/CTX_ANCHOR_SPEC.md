# CTX On-Chain Anchor Specification (C5)

## What is anchored
Each CTX container, upon sealing (C2 Ed25519 signature), should have its manifest hash
recorded on Base mainnet via the Content Chain smart contract.

## Current state
-  → live Base mainnet data (block 46,414,857, last anchor: 0xcb71ce...)
-  table in gitchain-postgres: stores local anchor records
-  → implemented (DB-layer, see below)

## Endpoint: POST /ctx/:id/anchor
- Requires Bearer auth (B2)
- Reads container manifest hash + signature
- Records to blockchain_anchors table: { container_id, merkle_root, status: pending }
- Returns: { anchored: true, txStatus: pending, merkleRoot, note }

## On-chain write (future — needs BLOCKCHAIN_CONTRACT)
To write to Base mainnet:
1. Set env: BLOCKCHAIN_CONTRACT=<contract_address>, ANCHOR_RPC_URL=https://mainnet.base.org
2. Fund the signing wallet (PK via vault: )
3. The anchor endpoint will then submit tx via ethers.js

## Contract
- Network: Base Mainnet (chain ID 8453)
- ABI: contentHash(bytes32) → emit ContentSealed(address, bytes32, uint256)
- Deployed: Content Chain contract (address TBD — check 0711-gitchain/contracts/)
