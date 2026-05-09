# @0711/gitchain-types

Shared, deterministic, runtime-free TypeScript contracts for every GitChain
vertical. **No business logic**, only `interface` / `type` / `const` declarations
and lightweight type guards.

## Why this package exists

The GitChain pipeline crosses package boundaries — `elster-v3-multi`'s
`layer4-aggregate` stage feeds `c-pro`'s mandanten UI, the ELSTER-Export
lane, and the on-chain attestation worker. Without a single locked contract,
each consumer either re-declares the shape (drift) or imports from internal
paths (fragility).

This package is the canonical answer.

## Audit ownership

- **Schema author** (`@Bombas` 💣) implements changes.
- **Schema auditor** (`@Architect` 🏗️) reviews every PR before merge.
- Breaking changes require a major version bump and a migration note.

## Verticals

| Vertical | File | Status |
|---|---|---|
| ELSTER | `src/elster.ts` | Phase F.2 lock — pending audit |
| Bosch ETIM | `src/bosch-etim.ts` | TODO (after ELSTER ratifies) |
