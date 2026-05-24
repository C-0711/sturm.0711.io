# UI Migration Plan

Updated: 2026-05-24 18:36 CEST

## Coordinator defaults now locked

- `A5`: `app.html` is canonical from `alpha.6_2.zip`. `anwendungen.html` is alias-only if retained.
- `B5`: replace `gateway-ui-next`. Quality Lab lives inside the integrated control plane as a top-level tab behind the rollout flag, not as a parallel lab.
- `D4`: `ctax` is fully out of scope unless leadership explicitly reopens it.
- E6: no page is deleted or archived. Every page is transferred to the new design.
- Full inventory lock added: `/docs/UI_PAGE_INVENTORY_2026-05-24.md` (28-page transfer map).

## Shipped now

- `b0a59c7` `feat(ui): add stable design system css routes`
- `711dc3d` `docs(ui): publish sister-surface audit and live checklist`
- `https://sturm.0711.io/ds/sturm.css`
- `https://sturm.0711.io/ds/sturm@0.1.0.css`
- `https://sturm.0711.io/ds/sturm@latest.css`
- Cross-origin delivery enabled for `*.0711.io`
- UI-02 delivered: `/docs/UI_ROUTE_MIGRATION_MATRIX.md` (owner map + P0/P1/P2 route tiers)
- UI-08 delivered: `scripts/ui-regression.mjs` + `.github/workflows/ui-regression.yml`
- UI-06 advanced: `scripts/sister-parity-probe.mjs` + `/docs/UI_SISTER_PARITY_BASELINE.md`

## Sister-surface audit matrix

| Site | Live state | Current UI state | Decision | ETA |
| --- | --- | --- | --- | --- |
| `sturm-mandanten.0711.io` | 200 | Public lane/placeholder posture still live, internal v6 surface now ships the shared DS import from the running `sturm-mandanten` container | Adapter parity shipped in `1dbb589` with `https://sturm.0711.io/ds/sturm.css`; remaining gap is hostname cutover because the public domain still resolves to the shared nginx coming-soon page | cutover pending |
| `cornea-quantum.0711.io` | 200 | Public placeholder posture, not yet a full product-family shell | P1 adapter parity only, reuse shared shell and tokens when route family goes live | 0.5d |
| `bosch-edu.0711.io` | 200 | Distinct branded Next.js product with its own palette and IA | Token-only/selective adoption for status and doc surfaces, no forced full-skin rewrite | 1d |
| `cb-chat.0711.io` | 200 | CTAX-branded chat experience with separate product grammar | Selective token-only alignment for shared primitives if kept active, no shell rewrite | 0.5d |
| `academy.0711.io` | 200 | Placeholder/lane-in-preparation surface | P2 selective alignment only, token adoption when lane graduates to a real surface | later |
| `dl.0711.io` | 302 → `/login` | GitChain auth/app surface | Token-only for auth, docs, and status surfaces, do not force STURM shell on core app UX | 0.5d |
| `jarvis.0711.io` | 200 GET / HEAD 405 | Standalone OpenJarvis surface with its own asset pipeline | Selective alignment only for landing/status surfaces, no product-shell rewrite | later |
| `ctax` | production | Protected surface | Explicitly out of scope per D4. No migration work unless leadership reopens it. | n/a |

## Full inventory lock (28 pages)

- Tier 1: 2 pages fully alpha.6_2
- Tier 2: 11 pages in finish-pass
- Tier 3: 15 pages in full migration path

Canonical inventory source:

- `/docs/UI_PAGE_INVENTORY_2026-05-24.md`

## Recommended next pickup

1. Complete the public cutover for `sturm-mandanten`. The DS adapter is already shipped internally in `1dbb589`, but the hostname still lands on the shared coming-soon page.
2. Cut the next P1 consumer patch for `cornea-quantum` and link shipped commits back into `/ui`.
3. Transfer Tier-3 high-value pages first: `/anwendungen.html` -> `/steuerfall.html` -> `/abrechnung.html`.
4. Continue remaining Tier-3 pages route-by-route, with smoke/visual gate after each chunk.
