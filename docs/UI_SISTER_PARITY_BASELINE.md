# UI-06 Sister Surface Parity Baseline

Updated: 2026-05-24 17:08 CEST  
Owners: Architect + Operator

## Scope in this pass

- Establish live baseline for P1/P2 sister surfaces
- Lock adapter strategy per domain
- Add automated screenshot baseline hooks per surface
- Keep `ctax` fully out of scope for this UI migration stream

## Current baseline (live)

| Surface | URL | HTTP | Current title | Target tier |
|---|---|---:|---|---|
| sturm-mandanten | `https://sturm-mandanten.0711.io` | 200 | 0711 Intelligence — Diese Lane ist in Vorbereitung | P1 |
| cornea-quantum | `https://quantum.0711.io` | 200 | 0711 Quantum — Self-contained Vertical AI | P1 |
| elster-quantum | `https://elster-quantum.0711.io` | 200 | 0711 Intelligence — Diese Lane ist in Vorbereitung | P2 |
| bosch-edu | `https://bosch-edu.0711.io` | 200 | Bosch Thermotechnik Academy | P2 |
| hoor | `https://hoor.0711.io` | 200 | Hoor | P2 |

## Adapter checklist

### P1 (must-do)

- [ ] Add shared header shell and breadcrumb parity
- [ ] Apply token bridge (`sturm.css` mapped vars)
- [ ] Verify nav semantics and route handoff to primary apps
- [x] Add screenshot baseline and diff hooks for each surface (`scripts/sister-parity-probe.mjs`)

### P2 (selective)

- [ ] Keep service identity intact, add only token/nav alignment where safe
- [ ] No forced full-skin rewrite
- [ ] Keep docs/status pages readable and consistent with control-plane language

## Automation and evidence

- Probe command: `npm run test:e2e:sister-parity`
- Latest probe artifact: `reports/sister-parity-2026-05-24T15-08-09-909Z/REPORT.md`
- Latest result: 5/5 reachable, desktop + mobile screenshots captured for all sister surfaces

## Execution note

This baseline is linked from `/ui` checklist row `UI-06` and will be updated as adapter tasks are completed.
