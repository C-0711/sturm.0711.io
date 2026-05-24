# UI-08 / D8 — Visual Regression + Route Smoke Suite

Implements the assigned task from `https://sturm.0711.io/ui/`:

- **Route smoke gate** for key STURM/Gateway routes
- **Visual regression gate** (desktop + mobile)
- **Reference comparison** against the alpha.6_2 design pack deployed at `/v6/*`

## Local usage

```bash
npm run test:e2e:ui:smoke -- --base http://127.0.0.1:7800
npm run test:e2e:ui:visual -- --base http://127.0.0.1:7800
```

Optional threshold override:

```bash
UI_VISUAL_MAX_DIFF_PERCENT=18 npm run test:e2e:ui:visual -- --base http://127.0.0.1:7800
```

Audit mode (includes non-migrated parity checks):

```bash
npm run test:e2e:ui:visual -- --base http://127.0.0.1:7800 --full-visual
```

## CI

Workflow: `.github/workflows/ui-regression.yml`

- boots STURM with `STURM_TOOLS_BOOT=skip`
- runs smoke gate
- runs visual gate (migrated routes)
- uploads report artifacts from `reports/ui-regression-*/`

## Report artifacts

Each run writes:

- `report.json`
- `REPORT.md`
- `*-canonical.png`
- `*-reference.png`
- `*-diff.png`
