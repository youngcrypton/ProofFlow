# ProofFlow Phase 1 Design Audit

**Date:** 2026-08-09
**Scope:** Existing React dashboard in `apps/web`, with no backend, API, routing, or product-behavior changes.
**Baseline score:** 76/100
**Target after Phase 1:** 92/100

## Executive finding

ProofFlow already has the right product vocabulary and a credible visual direction: forest green, restrained lime, editorial headings, compact mono metadata, explicit testnet disclosure, and a clear AI → policy → X Layer trust boundary. The main gap is not product thinking; it is system discipline. The current interface is a strong prototype whose visual rules are expressed as a long, compact stylesheet rather than a small, coherent design system.

The redesign should preserve the existing information architecture and lifecycle behavior while making the surface feel calmer, more legible, and more dependable under financial consequence.

## What is working

- The trust boundary is visible and correctly separates AI observation, deterministic policy, and onchain settlement.
- Testnet status is explicit in the shell and release flow.
- The page has a useful command-center structure: priority queue, network health, agreement table, detail panel, evidence, audit trail, and vault state.
- State colors already distinguish positive, attention, danger, and pending states.
- Financial values use a mono treatment and the UI exposes exact addresses, hashes, chain IDs, and transaction data.
- Modal focus restoration, Escape handling, `aria-modal`, `aria-live`, reduced-motion support, and semantic form labels are present.
- The production bundle is small for the current surface: approximately 292 kB JavaScript and 21 kB CSS before refinement.
- The existing typecheck, 25 tests, and production build pass.

## Findings by system

### Architecture and hierarchy

- `apps/web/src/main.tsx` contains the complete application, data orchestration, wallet lifecycle, modal flows, and presentation components in one 291-line/54 kB source file. This is workable for the current scope but makes system-wide consistency harder to maintain.
- The page hierarchy is directionally correct, but the current heading rhythm is too compressed in detail views and too similar across panels. The primary state and next action need a stronger, more consistent visual anchor.
- Navigation is visually present but most links are hash anchors and several are placeholders. Phase 1 must not invent routes; it should make current navigation states clearer without implying unavailable destinations.

### Typography

- DM Sans, DM Mono, and Playfair Display create a distinctive editorial voice, but the stylesheet applies typography through many selectors instead of tokens.
- The current type scale jumps from small mono labels to large headings without a documented intermediate scale.
- Body copy, table metadata, modal labels, and status copy are often 10–13 px. This creates a refined compact look but risks readability, especially on mobile and for long explanations.
- Numeric values need consistent tabular alignment and a documented number style.
- The external Google Fonts import introduces a render dependency and can create a font swap/layout shift in production.

### Color and contrast

- The forest/lime/neutral palette is coherent and appropriate for a trust product.
- Semantic colors are present but duplicated as literal values in many selectors, making drift likely.
- `--surface` is referenced by the secondary button but is not defined. This is a concrete design-token defect.
- Dark-panel text and muted text require a disciplined contrast pass. Muted copy should never be the only carrier of important meaning.
- State is generally communicated through text and badges, but the system should make the state mark, border, background, and copy variants predictable.

### Spacing, borders, elevation, and radii

- The current spacing is mostly 8/10/12/14/16/18/20/22/24/28/42/48 px, but there is no explicit scale. Similar surfaces use different padding and radius values.
- Cards use a single very light shadow and 5–8 px radii. The calm direction is right, but interactive surfaces need a clearer hover/focus elevation model.
- The stylesheet has a second appended block of modal and settlement rules, which makes cascade order part of the design system. Consolidating rules will reduce accidental overrides.
- The table, queue, and detail cards need consistent internal row heights and divider behavior.

### Components and interaction states

- Buttons have a useful primary/secondary split, but hover currently translates every button upward. That is too broad for financial software and can create visual jitter. Pressed, focus-visible, loading, and destructive/attention variants need explicit states.
- Inputs have a focus ring, but error, disabled, read-only, and file-upload states need the same vocabulary as buttons and badges.
- The modal is functional and keyboard-aware, but its close control, focus treatment, and footer hierarchy need stronger polish.
- Loading uses a shimmer row, but the skeleton geometry is generic. It should match metric, queue, table, and detail shapes so loading does not cause layout shift.
- Empty states are clear but visually understated; they should include a calm explanation and one action without feeling promotional.
- Icons are mostly text glyphs (`↻`, `◈`, `⌂`, `▣`, `◌`, `!`). They are lightweight but inconsistent across platforms and do not guarantee consistent stroke, baseline, or screen-reader behavior.

### Accessibility

Strengths:

- `aria-label`, `aria-live`, `role="status"`, `role="alert"`, `aria-modal`, and form labels are used in important places.
- Reduced motion is already supported.
- Focus restoration exists for the modal.

Risks to address:

- Text glyph icons must have reliable accessible names and should not be the only visual indicator.
- Button and link focus styles are not globally defined; keyboard users should see a consistent high-contrast focus ring.
- Some clickable rows are buttons with complex nested content; their focus/hover treatment must remain obvious.
- The mobile navigation's visibility is mostly CSS-driven and should keep an explicit expanded state and usable focus order.
- Small mono labels and muted text need a minimum readable size and contrast check.
- Modal focus containment is only partially implemented; Phase 1 should improve the visual and keyboard affordance without changing modal behavior.

### Responsiveness

- The current breakpoints are sensible, but the mobile layout hides important sidebar content and changes the queue into a reduced three-column presentation.
- The agreement table remains horizontally scrollable; that is acceptable for dense financial data, but the scroll affordance should be obvious and rows should remain readable.
- Detail grids collapse well, although state-banner action alignment and transaction preview wrapping are fragile at narrow widths.
- Header actions become crowded between 760–1100 px because network status disappears before the information hierarchy is rebalanced.

### Motion and performance

- Existing animation is limited to button hover, skeleton shimmer, and the network orbit, which is a healthy baseline.
- The orbit is decorative and can be reduced or paused under reduced motion.
- Transitions should use opacity, color, and small shadow changes rather than broad transform movement.
- No new dependency is warranted. CSS-only motion keeps the bundle stable and tree-shakeable.
- The Google Fonts import should be treated as a performance risk; Phase 1 can retain the intended font stack while avoiding new runtime dependencies and minimizing layout shift.

## Phase 1 decisions

1. Keep the existing product structure, endpoints, route behavior, and wallet flow unchanged.
2. Establish CSS tokens for typography, spacing, color, radius, border, elevation, and motion.
3. Consolidate the stylesheet into readable sections so the cascade communicates the system.
4. Refine buttons, badges, cards, tables, forms, modals, banners, skeletons, and focus states consistently.
5. Replace broad button movement with restrained interaction feedback.
6. Preserve the editorial palette and use stronger semantic contrast rather than adding new colors.
7. Improve mobile layout behavior without adding routes or features.
8. Keep all copy honest: testnet, advisory AI, deterministic policy, and confirmed receipt remain explicit.
9. Make only small presentation-layer JSX changes when needed for accessible labels or stable styling hooks.
10. Verify with typecheck, tests, production build, local browser inspection, and responsive screenshots before commit.

## Planned Phase 1 files

- `apps/web/src/styles.css` — primary design-system implementation and responsive refinement.
- `apps/web/src/main.tsx` — only presentation/accessibility hooks if needed; no API or lifecycle changes.
- `docs/design-audit-phase-1.md` — this audit and implementation record.

## Remaining weaknesses after Phase 1

- The application still has one very large frontend module and should be decomposed in a later maintainability phase.
- Several navigation destinations described by the product specification are not yet implemented; this phase will not fake them.
- Document preview, richer filterable agreement indexes, and production wallet support remain future work.
- Font hosting and a full Lighthouse/accessibility CI pass should be addressed before a public mainnet product.

## Phase 2 recommendations

1. Split the dashboard into feature modules with shared typed UI primitives.
2. Implement URL-addressable agreement filters and a real review queue.
3. Add a dedicated receipt view with explorer links and confirmed event details.
4. Add automated Playwright accessibility and responsive regression tests.
5. Replace external font loading with a deliberate hosted-font strategy after measuring the live Vercel performance profile.
6. Add product analytics only after defining a privacy-preserving event taxonomy.
