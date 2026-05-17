# @0711/envelope

Project-scoped HMAC envelope + extraction-fingerprint signing for the 0711 platform.

Used by:
- **sturm** — workspace master signatures, ELSTER replay certificates
- **eyeAI** — Atlas-KC SaMD provenance, scan ingestion attestations
- **gateway.0711.io** — `/api/attest`, `/api/verify/:fingerprint`, per-project handshake (Phase 2+)

## Threat model

HMAC-SHA256 with symmetric keys per project. Adequate for:
- Tamper-detection on master snapshots between trusted services
- Fingerprint signatures bound to a key-id (rotation-friendly)
- Handshake nonces between Gateway and registered projects

NOT adequate for (Phase G+):
- Externally untrusted verifiers (use Ed25519)
- Cross-org provenance proofs (use Ed25519 + cert chain)

## Modules

| Module | Purpose |
|---|---|
| `canonical.ts` | RFC 8785 JCS — deterministic JSON for hashing |
| `envelope.ts` | `signEnvelope({ project, payload }, key, keyId)` — project-bound v2 |
| `master.ts` | `signMaster(payload, key, keyId)` — wire-compat with sturm v1 master.json |
| `fingerprint.ts` | `computeFingerprint`, `signFingerprint` — replay certificates |
| `keys.ts` | `resolveSharedKey({ envVar, keyFile, rootDir })` — env-or-file with autogen |

## Wire compat

`signMaster` produces signatures byte-for-byte identical to sturm's pre-extraction
`src/lib/master-signer.ts` so existing `master.json` files keep verifying.
Use `signEnvelope` for new code — it binds the `project` field into the canonical
payload, preventing replay attacks across projects.
