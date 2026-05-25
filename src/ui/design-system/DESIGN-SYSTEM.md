# STURM Design System — `alpha.6_2` Canonical

**Source:** `~/.openclaw/workspace/sturm-redesign/alpha-6_2/` (provided by Mastermind C 2026-05-25)
**Canonical CSS:** `src/ui/design-system/sturm.css` (732 lines)
**Surface:** Every page on `sturm.0711.io` (landing, app, designer, ocr-studio, gateway-style ops surfaces, future modules).
**Status:** Authoritative. No competing CSS may ship.

> **Bombas rule of thumb:** _If it does not load `sturm.css`, it is not STURM._ The single exception is `index.html` (landing) which keeps its tokens inline because the hero loads independently — but it MUST use the same token values + the same `.serif/.mono/.brand-tile` semantics. New pages always link `sturm.css`.

---

## 0. North-Star Identity

**Vibe.** Dark warm-neutral cockpit. Lab-grade calm. Quiet champagne accent (oklch 0.82 0.06 85, ~ warm gold). No screaming colors. Truth states are coded chips, not banners.

**Three voices in one product.**
1. **Editorial** — landing (`index.html`): Spectral serif headlines, generous whitespace, "Document in. Result out."
2. **Operator** — app/designer/ocr-studio: Geist UI, JetBrains Mono labels, dense panels, sticky topbars.
3. **Engineering trace** — IDs, hashes, timestamps, latencies: always JetBrains Mono, always `tabular-nums`.

**Three typefaces, three jobs.**
- `Geist 300/400/500/600` → body, headings, buttons.
- `Spectral 300/400/500/600` → landing hero + section editorial (`.serif`).
- `JetBrains Mono 400/500` → IDs, labels (uppercase 10–11px), stat-values, table cells, kbd, code (`.mono`).

**Theme attribute.** Every page boots with `<html data-theme="dark">` (or `"light"`), set by an inline script reading `localStorage.sturm-theme`. **Default: dark.**

---

## 1. Token Layer

Tokens are declared on `:root, [data-theme="dark"]` and overridden on `[data-theme="light"]`. **Never use raw oklch() or hex in component CSS — always reference a token.**

### 1.1 Color (dark theme, primary)

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.2 0.005 80)` | App background |
| `--bg-2` | `oklch(0.235 0.005 80)` | Cards, panels, table thead |
| `--bg-3` | `oklch(0.27 0.005 80)` | Inset chips, segmented bg, kbd |
| `--bg-4` | `oklch(0.31 0.005 80)` | Hover on `bg-3` chips |
| `--ink` | `oklch(0.95 0.005 80)` | Primary text, headings |
| `--ink-2` | `oklch(0.72 0.005 80)` | Body, nav-item rest, descriptions |
| `--ink-3` | `oklch(0.52 0.005 80)` | Captions, mono labels, hints |
| `--ink-4` | `oklch(0.4 0.005 80)` | Faintest scaffolding (sep dots, dashed bottoms) |
| `--line` | `oklch(0.32 0.005 80)` | Strong borders (hover state) |
| `--line-2` | `oklch(0.28 0.005 80)` | Default borders, dividers |
| `--accent` | `oklch(0.82 0.06 85)` | Brand champagne, active pill text, primary button bg |
| `--accent-deep` | `oklch(0.72 0.07 85)` | Brand tile gradient bottom, primary hover |
| `--accent-soft` | `oklch(0.82 0.06 85 / 0.12)` | Active pill background |
| `--on-accent` | `var(--bg)` | Text on primary button (dark on champagne) |

### 1.2 Semantic & Truth states

| Token | Value | Use |
|---|---|---|
| `--ok` | `oklch(0.78 0.13 145)` | Healthy / live / success |
| `--warn` | `oklch(0.82 0.14 85)` | Caution / unsaved / mixed |
| `--err` | `oklch(0.7 0.16 25)` | Error / failed |
| `--info` | `oklch(0.75 0.09 230)` | Informational / inferred |
| `--truth-live` | `var(--ok)` | Live-data badge |
| `--truth-mixed` | `oklch(0.78 0.13 75)` | Mixed-source badge |
| `--truth-seeded` | `oklch(0.72 0.06 60)` | Seeded/synthetic badge (hollow dot) |
| `--truth-inferred` | `var(--info)` | LLM-inferred badge |
| `--truth-unavailable` | `oklch(0.5 0.005 80)` | NOT_AVAILABLE badge (hollow dot, gray) |

> **Truth states are not "status colors".** They describe **the provenance of a value**, not the health of a system. Use `.s-dot` (`.ok/.warn/.err/.idle`) for runtime health.

### 1.3 Radii

| Token | px | Use |
|---|---|---|
| `--radius-sm` | 6px | nav-items, icon-btn, kbd pill |
| `--radius` | 8px | buttons, panels, inputs, accordions |
| `--radius-lg` | 12px | cards, app-cards, modals, popovers |

### 1.4 Light theme overrides (same token names, inverted values)

Already declared inside `sturm.css`. Switching theme is a one-attribute flip on `<html>`. **Never re-declare tokens at component level — let the theme attribute resolve them.**

---

## 2. Typography Scale

| Role | Family | Size | Weight | Tracking | Where |
|---|---|---:|---:|---|---|
| Landing hero | Geist (or `.serif` Spectral) | `clamp(42px, 6.4vw, 72px)` | 300 | -0.035em | `index.html` h1 |
| Page-head h1 | Geist | 36px | 300 | -0.025em | `.page-head h1` (app, ocr, designer) |
| Card title | Geist | 17px | 500 | -0.01em | `.card-title` |
| App-card title | Geist | 20px | 500 | -0.015em | `.app-card-title` |
| Section title | Geist | 15px | 500 | -0.005em | `.ocr-pane-head h2` |
| Topbar title | Geist | 17px | 500 | -0.01em | `.ocr-top-title` |
| Body | Geist | 14px | 400 | 0 | `<body>` |
| Landing body | Geist | 16px | 400 | 0 | `index.html` body only |
| Nav-item | Geist | 14px | 400 | 0 | `.nav-item` |
| Card desc | Geist | 13px | 400 | 0 | `.card-desc` |
| Button | Geist | 13px | 500 | 0 | `.btn` |
| Button-sm | Geist | 12px | 500 | 0 | `.btn-sm` |
| Stat value | JetBrains Mono | 28px | 400 | -0.01em | `.stat-value` |
| Mono label | JetBrains Mono | 10px | 500 | 0.08em UPPER | `.stat-label`, `.panel-h`, `.sidebar-section`, table thead |
| Brand name | Geist | 13px | 600 | 0.16em | `.brand-name` ("STURM") |
| Brand tag | JetBrains Mono | 11px | 400 | 0 | `.brand-tag` ("workflow engine") |
| Brand pill | JetBrains Mono | 10px | 500 | 0.06em UPPER | `.brand-pill` ("MVP", "ALPHA") |
| Card-id chip | JetBrains Mono | 10px | 400 | 0.04em | `.card-id` |
| Kbd | JetBrains Mono | 10px | 400 | 0 | `.kbd-pill .kbd` |

**Numerics rule.** Any number that may animate or compare in a column gets `font-variant-numeric: tabular-nums;` and JetBrains Mono. No exception.

**Letter-spacing rule.** Headlines tighten (`-0.01em` to `-0.035em`); uppercase mono labels widen (`+0.06em` to `+0.08em`). Never tighten mono.

---

## 3. Layout Patterns (5 canonical shells)

> Each shell sets `min-height: 100vh` and never overflows the viewport horizontally. Sticky elements use `backdrop-filter: blur(10px)` and a translucent bg via `color-mix(in oklab, var(--bg) 88-92%, transparent)`.

### 3.1 Sidebar shell `.shell` (app, anwendungen, future modules)

```
┌────────┬──────────────────────────────────┐
│sidebar │  topbar (56px, sticky)          │
│240px   ├──────────────────────────────────┤
│sticky  │  content (max-w 1200, auto)     │
│100vh   │   page-head → grid/list         │
└────────┴──────────────────────────────────┘
```
- `grid-template-columns: 240px 1fr`
- Sidebar = `.sidebar` (bg=`--bg`, border-right `--line-2`)
- Topbar = `.topbar` (56px, translucent + blur, sticky)
- Content = `.content` (`max-width: 1200px`, `padding: 56px 28px 80px`)

### 3.2 Two-pane studio `.ocr-shell` (OCR Studio, future side-by-side studios)

```
┌──────────────────────────────────────────┐
│ ocr-top (sticky)                         │
├──────────────────┬───────────────────────┤
│ left pane 1.4fr  │ right pane 1fr        │
│ document/source  │ extraction/inspector  │
└──────────────────┴───────────────────────┘
```
- `.ocr-body { grid-template-columns: 1.4fr 1fr; }`
- Right pane has `border-left: 1px solid var(--line-2)`.

### 3.3 Designer canvas `.dz-shell` (Designer)

```
┌──────────────────────────────────────────┐
│ dz-top (10px pad, sticky, blur)         │
├──────────┬──────────────────┬────────────┤
│ palette  │ canvas (drag)    │ inspector  │
└──────────┴──────────────────┴────────────┘
```
- `min-height: 100vh; max-height: 100vh` (locks scroll inside panes)
- Title is an inline-editable input (`.dz-wf-title`).
- Save-state dot (`.dz-save-state .dot` → `.warn` on dirty).

### 3.4 Gateway ops grid `.gw-shell` (control plane, healthchecks, status pages)

```
┌──────────┬───────────────────────────────┐
│ rail     │ multi-panel grid              │
│ 220px    │  (.panel + .dtable + .stat)   │
└──────────┴───────────────────────────────┘
```
- Narrower sidebar (220px) for ops surfaces.
- Body is a **panel grid**, not a content column.

### 3.5 Editorial landing `.menu` + hero (`index.html`)

- No persistent sidebar. Hamburger overlay menu (`.burger`, `.menu-search`).
- Hero uses Spectral serif or Geist 300 at clamp font-size.
- Sections separated by 56–80px of whitespace.

---

## 4. Component Catalog

Names are stable. Use these classes verbatim; **do not invent new names** for variants of these patterns.

### 4.1 Brand

- `.brand-tile` 28×28 gold gradient + uppercase letter. `.brand-tile.lg` = 36×36, 18px.
- `.brand-name` STURM, letter-spaced.
- `.brand-tag` mono "workflow engine" / "designer" / "ocr studio" / "control plane".
- `.brand-pill` uppercase mono badge ("MVP", "ALPHA", "BETA").

### 4.2 Buttons

| Class | Look | Use |
|---|---|---|
| `.btn .btn-primary` | filled champagne | Primary CTA, "Open app", "Save" |
| `.btn .btn-ghost` | bordered transparent | Secondary, "See examples" |
| `.btn .btn-subtle` | filled `--bg-2` | Tertiary, "Cancel" |
| `.btn .btn-sm` | smaller padding | Inline / toolbar |
| `.btn .arr` (span) | animates +3px X on hover | Use for "Open →" affordance |
| `.icon-btn` | 34×34 square, border | Icon-only, theme toggle, search |
| `.kbd-pill` | "⌘K" pill with kbd inside | Global search trigger |

**Rule:** Max **one** `.btn-primary` per visible viewport. If you need a second filled, you have a layout problem.

### 4.3 Pills (`.pill-row .pill`)

- Capsule (border-radius 999px), 7×14 padding.
- `.pill.active` = `accent-soft` bg + `accent` text + count inside changes color.
- `.pill .count` = mono 11px, rounded inset chip.
- **Use for:** category filters, classification filters, "All / X / Y" segmented choice.

### 4.4 Cards (workflow grid)

```
.card
├── .card-head { .card-title + .card-id (mono chip) }
├── .card-desc
└── .card-foot { 4 × .card-foot-cell { .label + .val } }
```
- 24px padding, `bg-2`, 12px radius, hover lifts border + slightly lighter bg.
- 4-column foot with dashed top border, mono 10.5px.
- **Used in:** `/app` workflow grid, future module index pages.

### 4.5 App cards (anwendungen, large details)

```
.app-card (28px pad, gap 14)
├── .app-card-head { .app-card-title + .app-card-sub (mono) + actions }
├── .app-card-desc (max-w 72ch)
├── .app-card-row (flex wrap, chips/buttons)
└── .accordion (expandable sub-section)
```

### 4.6 Truth chips (`.truth`)

```html
<span class="truth live">LIVE</span>
<span class="truth mixed">MIXED</span>
<span class="truth seeded">SEEDED</span>     <!-- hollow dot -->
<span class="truth inferred">INFERRED</span>
<span class="truth unavailable">NOT AVAIL</span>   <!-- hollow dot -->
```
- Inline-flex, 10px uppercase mono, 1px border using `currentColor`, 8% color-mix background.
- **Always render the dot**; the dot communicates "presence vs absence of source".

### 4.7 Status dots (`.s-dot`)

- 8×8 circle. `.ok` pulses with `@keyframes spulse`. `.warn` / `.err` / `.idle` are static.
- Use for **runtime health** (service up, run executing, lane healthy). Never for data provenance.

### 4.8 Chips (`.chip`)

Density-friendly inline chips: `.chip` + `.dim/.warn/.ok/.err/.info/.accent`. Mono, 11px, 4px radius. **Reserved for in-table or in-panel meta tags** — not for navigation.

### 4.9 Panels (`.panel`)

```
.panel
├── .panel-head { .panel-h (mono UPPER) + .panel-sub + .panel-spacer + actions }
└── .panel-body (or .panel-body.flush)
```
- Use for ops surfaces, health cards, log streams.
- Border 1px `--line-2`, 8px radius, no padding by default in `.flush`.

### 4.10 Tables (`.dtable`)

- `thead th`: mono UPPER 10px, sticky, `bg-2`.
- `tbody td`: 12×14 padding, `--line-2` bottom border, hover bg `oklch(0.245 …)`.
- Columns that contain numbers use `.num` (right-aligned tabular-nums mono).
- Columns that contain IDs use `.mono` (left, JetBrains 12px).

### 4.11 Forms (`.form-row`)

- Stack: mono UPPER label → input (`--bg`, `--line-2`, 6px radius) → optional `.hint` / `.hint.err` / `.hint.warn`.
- Focus = `border-color: var(--line)` (no glow ring).
- For monospace inputs (IDs, hashes), add `.mono` to the input.

### 4.12 Segmented control (`.seg`)

- Capsule background, mono micro-labels, `.on` element gets `--bg` lift + subtle shadow.
- Use for view-mode toggles (Editor / Preview, Live / Replay).

### 4.13 Stats (`.stat`)

```
.stat
├── .stat-label (mono UPPER 10px)
├── .stat-value (mono 28px tabular-nums, optional .unit)
└── .stat-delta (mono 11px, .up green, .down red)
```

### 4.14 Empty state

`.empty-state`: dashed border on `--line-2`, 56×24 pad, center text, mono 13px ink-3. **Always include a single primary action** below.

### 4.15 Run list / accordion (app history)

- `.runner-list` → `.run-row` (grid `14px 200px 1fr auto auto`).
- `.run-dot` = colored 8px health dot, `.run-name` (14px), `.run-pipeline` (mono), `.run-stages` (mono with `.run-arr` separator), `.run-time` (mono right).

---

## 5. Motion

- Hover transitions: **120–150ms ease** on `background`, `color`, `border-color`.
- `.btn:active` → `translateY(1px)` only. No scaling.
- `.btn .arr` on hover → `translateX(3px)`.
- `.s-dot.ok` → 2s `spulse` (radial halo via `box-shadow` + `color-mix`).
- **No bouncy springs, no slides, no fade-overlays.** STURM is a cockpit, not a marketing site.

---

## 6. Iconography

- Source: **Lucide** (`<script src="https://unpkg.com/lucide@latest">` + `lucide.createIcons()` on load).
- Inline SVG icons use `stroke-width: 1.5`, `currentColor`.
- Icon-only buttons → `.icon-btn` (34×34) or 28×28 inside sidebar brand.
- Round "ring" icon shell at top of hero pages: `.page-head .icon-ring` (56×56, bg-2, accent stroke).

---

## 7. Page Boilerplate (drop-in)

Every new STURM page starts with this skeleton. Anything else is a deviation that needs justification.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>STURM — <Module></title>
  <script>
    (function () {
      try {
        var t = localStorage.getItem('sturm-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', t);
      } catch (e) { document.documentElement.setAttribute('data-theme', 'dark'); }
    })();
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
  <link rel="stylesheet" href="/design-system/sturm.css" />
  <!-- page-specific styles ONLY; no token redefinitions -->
  <style>
    /* page-local helpers */
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar"> … </aside>
    <main class="main">
      <header class="topbar"> … </header>
      <section class="content"> … </section>
    </main>
  </div>
  <script src="https://unpkg.com/lucide@latest"></script>
  <script>lucide.createIcons();</script>
</body>
</html>
```

**Landing exception:** `index.html` may keep tokens inline (for fastest paint) but MUST mirror sturm.css token values exactly and may add Spectral.

---

## 8. Rules of Engagement

### 8.1 Hard rules (no exceptions without MC approval)

1. **One stylesheet:** `sturm.css` is canonical. Old files (`colors_and_type.css`, `sturm-app.css`) are deprecated.
2. **`href="/design-system/sturm.css"`** (absolute), never relative `"sturm.css"`.
3. **Tokens only.** Never inline `oklch()` / hex inside a component class — go through a token.
4. **Geist + Mono only.** Spectral allowed only on landing hero and editorial section eyebrows.
5. **Truth chips != health dots.** Don't conflate them.
6. **No new icon library.** Lucide stays.
7. **No drop shadows on cards/panels.** Borders only. Shadows allowed only on popovers/modals (`0 16px 48px oklch(0 0 0 / 0.4)`).
8. **No box-glow focus rings.** Focus = border color shift to `--line`.
9. **Tables = `.dtable`.** Don't reinvent table styling.
10. **Pills are filter pills.** Don't use them for nav, don't use them for status.

### 8.2 Soft rules (defaults — break with reason)

1. Content max-width `1200px`.
2. Topbar height `56px`.
3. Sidebar width `240px` (`220px` for ops/gateway shells).
4. Card padding `24px` (or `28px` for app-cards).
5. Page-head margin `32px 0 48px`, centered.
6. Grid gaps `20px` (cards) / `16px` (panels) / `12px` (chips).
7. Border radius progression `6 / 8 / 12`. Don't introduce new values.
8. Body font-size `14px` (`16px` only on landing).

### 8.3 Forbidden anti-patterns

- ❌ Filled status banners ("⚠ Warning!" stripes). Use a chip + a truth.
- ❌ Multiple `.btn-primary` competing in one viewport.
- ❌ Mono font for prose. Mono is for IDs/labels/numbers/code.
- ❌ Letter-spaced lowercase mono. Mono is uppercase or natural-case never wide-tracked lowercase.
- ❌ Headings with bg colors / pills around them.
- ❌ Animated gradients, parallax, autoplay video.
- ❌ Fixed-position chat widgets that overlap content (unless an explicit user-toggled overlay).

---

## 9. Module-specific Conventions

### 9.1 `/index.html` (Landing)
- Hero "**Document in. Result out.**" — Geist 300 or Spectral (`.serif`).
- Hamburger menu, full-screen overlay.
- Workflow categories preview using `.card` grid.
- Footer mono links: `App · Designer · Docs · Status`.

### 9.2 `/app.html` (Workflow Engine)
- Sidebar shell `.shell` with full nav.
- Top: `.page-head` with icon-ring + "Workflow Engine" h1 + tagline.
- Filter `.pill-row` (All + categories with counts).
- Body: `.wf-grid` (3 cols → 2 → 1 responsive) of `.card`.
- Each card: title + mono ID chip + desc + 4-cell mono foot (kind, lanes, version, last run).

### 9.3 `/anwendungen.html` (Applications / Cases)
- Same `.shell` as app.
- Body uses `.app-card` (larger, 28px pad).
- Each app-card embeds `.accordion`s for sub-data (steuerfälle, mandanten, runs).
- Live polling via `/api/applications` — preserve current vanilla-JS implementation, do not React-rewrite.

### 9.4 `/designer.html` (Workflow Designer)
- `.dz-shell` (top + 3 panes, no scroll-through).
- Title `.dz-wf-title` inline-editable, `.dz-wf-id` mono chip, `.dz-save-state` dot (warn=dirty).
- Modal "New Workflow" with numbered step indicators.
- AI chat overlay uses standard chat-bubble pattern (no new component classes).

### 9.5 `/ocr-studio.html` (OCR Studio)
- `.ocr-shell` two-pane (1.4fr / 1fr).
- Top: title + `.brand-pill` "MVP" + actions.
- Left pane: document/source. Right pane: extraction/schema inspector.
- Empty state on first load: `.empty-state` + single primary "Upload document".

### 9.6 `/gateway.html` (Quantum Gateway / Control plane / Status surfaces)
- `.gw-shell` 220px sidebar + multi-panel grid.
- Heavy use of `.panel` + `.dtable` + `.stat` + `.s-dot`.
- Live counters in `.stat-value` (mono 28px, tabular).

---

## 10. Adding a New Page

Checklist Bombas runs before merging any new STURM page:

- [ ] Loads `/design-system/sturm.css` absolute, no relative paths.
- [ ] `data-theme` boot script present.
- [ ] Uses only documented classes (no `.my-card-v2`, `.wrapper-blue`, etc.).
- [ ] Tokens come from sturm.css, no inline oklch outside `:root`.
- [ ] Lighthouse-style sanity: dark + light theme both render correctly.
- [ ] Topbar uses backdrop-filter + translucent bg.
- [ ] All numeric columns use `.num` / tabular-nums.
- [ ] Mono labels are UPPERCASE + tracked +0.06em–0.08em.
- [ ] At most one `.btn-primary` per viewport.
- [ ] Lucide loaded once, `createIcons()` called after DOM ready.
- [ ] Page survives a docker image rebuild (lives in `src/ui/`, not just `docker cp`'d).
- [ ] Live verified via browser screenshot vs the matching alpha.6_2 reference.

---

## 11. Versioning

- This document = **STURM Design System v6.2 (alpha.6_2 canon).**
- Changes to tokens, type scale, or component classes require an MC-approved PR that updates this file AND `sturm.css` in lockstep.
- Bombas owns: PR review, screenshot regression, deploy verification.
- Pope/Operator/Architect contributions must conform; deviations → Bombas re-aligns before merge.

---

**Last reviewed:** 2026-05-25 by Fleet Admiral Bombas, post-Phase-A ship of `bombas/sturm-redesign-phase-a-foundation`.
**Next milestone:** Phase B (landing alignment) — apply Section 9.1 verbatim.
