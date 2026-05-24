# UI Migration Plan

Updated: 2026-05-24 17:18 CEST

## Coordinator defaults now locked

- `A5`: `app.html` is canonical from `alpha.6_2.zip`. `anwendungen.html` is alias-only if retained.
- `B5`: replace `gateway-ui-next`. Quality Lab lives inside the integrated control plane as a top-level tab behind the rollout flag, not as a parallel lab.
- `D4`: `ctax` is fully out of scope unless leadership explicitly reopens it.

## Shipped now

- `b0a59c7` `feat(ui): add stable design system css routes`
- `711dc3d` `docs(ui): publish sister-surface audit and live checklist`
- `https://sturm.0711.io/ds/sturm.css`
- `https://sturm.0711.io/ds/sturm@0.1.0.css`
- `https://sturm.0711.io/ds/sturm@latest.css`
- Cross-origin delivery enabled for `*.0711.io`

## Sister-surface audit matrix

| Site | Live state | Current UI state | Decision | ETA |
| --- | --- | --- | --- | --- |
| `sturm-mandanten.0711.io` | 200 | Public lane/placeholder posture live, repo contains richer STURM-family shell variants | Adapter/shell parity via `/ds/sturm.css`, not a bespoke third system | 0.5d after route-owner alignment |
| `cornea-quantum.0711.io` | 200 | Public placeholder posture, not yet a full product-family shell | P1 adapter parity only, reuse shared shell and tokens when route family goes live | 0.5d |
| `bosch-edu.0711.io` | 200 | Distinct branded Next.js product with its own palette and IA | Token-only/selective adoption for status and doc surfaces, no forced full-skin rewrite | 1d |
| `cb-chat.0711.io` | 200 | CTAX-branded chat experience with separate product grammar | Selective token-only alignment for shared primitives if kept active, no shell rewrite | 0.5d |
| `academy.0711.io` | 200 | Placeholder/lane-in-preparation surface | P2 selective alignment only, token adoption when lane graduates to a real surface | later |
| `dl.0711.io` | 302 → `/login` | GitChain auth/app surface | Token-only for auth, docs, and status surfaces, do not force STURM shell on core app UX | 0.5d |
| `jarvis.0711.io` | 200 GET / HEAD 405 | Standalone OpenJarvis surface with its own asset pipeline | Selective alignment only for landing/status surfaces, no product-shell rewrite | later |
| `ctax` | production | Protected surface | Explicitly out of scope per D4. No migration work unless leadership reopens it. | n/a |

## Recommended next pickup

1. Switch the first P1 adapter consumers, starting with `sturm-mandanten` and `cornea-quantum`, to import `https://sturm.0711.io/ds/sturm.css`.
2. Retire local sister-surface copies of STURM CSS where the import path is safe.
3. Expand the route migration matrix so UI-02 and UI-06 converge into one actionable ownership map.
