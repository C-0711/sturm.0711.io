# UI Route Migration Matrix (UI-02)

Updated: 2026-05-24 17:09 CEST  
Owner: Operator

This is the canonical route map for the v1 → v2 rollout across STURM, Gateway, and sister surfaces.

## Tier model

- **P0** full migration: STURM + Gateway
- **P1** shell parity/adapters: sturm-mandanten + cornea-quantum
- **P2** service/selective alignment: elster-quantum + academy/edu

## P0 — STURM routes (full migration)

| Route | Family | Target v2 source | Owner | Status |
|---|---|---|---|---|
| `/` | dashboard/workflow entry | `/v6/index.html` | Minimi | TODO |
| `/gateway` | graph workbench | `/v6/gateway.html` | Minimi + Pope | TODO |
| `/designer.html` | document studio | `/v6/designer.html` | Minimi | TODO |
| `/studio-ocr.html` | OCR studio | `/v6/ocr-studio.html` | Minimi | TODO |
| `/app.html` | app/case hub (canonical) | `/v6/app.html` | Minimi | TODO |
| `/anwendungen.html` | optional DE alias to `/app.html` | alias route | Minimi | TODO |
| `/steuerfall.html` | case cockpit | v2 tokenized shell | Minimi + Pope | TODO |
| `/abrechnung.html` | report cockpit | v2 tokenized shell | Minimi + Pope | TODO |
| `/workspaces.html` | workspace ops | v2 tokenized shell | Minimi | TODO |
| `/workspace.html` | workspace detail | v2 tokenized shell | Minimi | TODO |
| `/document.html` | document ops | v2 tokenized shell | Minimi | TODO |
| `/source-viewer.html` | evidence/source | v2 tokenized shell | Minimi | TODO |
| `/orchestrator` | assistant shell | v2 tokenized shell | Minimi | TODO |
| `/embed/workspace.html` | embed-safe workspace | embed adapter | Minimi | TODO |
| `/embed/integration.html` | embed-safe integration | embed adapter | Minimi | TODO |
| `/ctx-demo.html` | strategy/lab | lightweight alignment | Architect | TODO |
| `/fleet` | internal/fleet view | lightweight alignment | Architect | TODO |
| `/quantum-elster/` | internal strategy | lightweight alignment | Architect | TODO |
| `/sturm-remote-studio-ocr.html` | remote OCR bridge | lightweight alignment | Architect | TODO |

## P0 — Gateway routes (full migration)

| Route | Family | Target v2 source | Owner | Status |
|---|---|---|---|---|
| `https://gateway.0711.io/` | control center | quantum gateway v2 shell | Minimi + Pope | TODO |
| `https://gateway.0711.io/doku` | execution docs | gateway docs v2 shell | Architect + Pope | TODO |
| `https://gateway.0711.io/merge` | merge matrix | gateway v2 shell | Architect | TODO |
| `https://gateway.0711.io/master-catalog` | catalog matrix | gateway v2 shell | Architect | TODO |
| `https://gateway.0711.io/admiral` | operator/admiral | gateway v2 shell | Architect | TODO |
| `https://gateway.0711.io/drop` | operator chat/drop zone | gateway v2 shell | Architect | TODO |

## P1 — sister adapter parity

| Surface | Baseline URL | Adapter strategy | Owner | Status |
|---|---|---|---|---|
| sturm-mandanten | `https://sturm-mandanten.0711.io` | shell parity + token adapter | Architect + Operator | DOING |
| cornea-quantum | `https://quantum.0711.io` | shell parity + token adapter | Architect + Operator | DOING |

## P2 — selective/service-only alignment

| Surface | Baseline URL | Strategy | Owner | Status |
|---|---|---|---|---|
| elster-quantum | `https://elster-quantum.0711.io` | status/docs alignment only (no full redesign) | Architect | TODO |
| academy (bosch-edu) | `https://bosch-edu.0711.io` | selective token + nav alignment | Architect + Minimi | TODO |
| academy (hoor) | `https://hoor.0711.io` | selective token + nav alignment | Architect + Minimi | TODO |

## Baseline probe (for UI-06 handoff)

All priority domains were probed live and currently respond **HTTP 200**:

- `sturm.0711.io` — STURM — Workflow Engine
- `gateway.0711.io` — 0711 Quantum Gateway · Control Center
- `sturm-mandanten.0711.io` — 0711 Intelligence — Diese Lane ist in Vorbereitung
- `quantum.0711.io` — 0711 Quantum — Self-contained Vertical AI
- `elster-quantum.0711.io` — 0711 Intelligence — Diese Lane ist in Vorbereitung
- `bosch-edu.0711.io` — Bosch Thermotechnik Academy
- `hoor.0711.io` — Hoor

## Explicit out-of-scope

- ctax is out of scope for this migration stream (no audit, no redesign, no token alignment in this lane).
