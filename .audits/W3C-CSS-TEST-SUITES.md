---
audit_id: AUDIT-W3C-CSS-2026-08-29
title: W3C CSS Test Suites & Snapshot 2026 Conformance Catalog
date_generated: "2026-08-29"
date_addressed: "2026-08-29"
git_branch: "pre-release-25"
git_commit_baseline: "e89a3cb2cd877d4a8eb74983cce5e1f1d600cf4c"
scope: "pkg/src/lib/styles.ts, pkg/src/lib/css-minifier.ts, pkg/e2e/ (CSS Scoping & Compilation)"
status: "completed"
---

# W3C CSS Test Suites & Snapshot 2026 Conformance Catalog

| Audit Metadata | Value / Specification Context |
| :--- | :--- |
| **Audit ID** | `AUDIT-W3C-CSS-2026-08-29` |
| **Date Generated** | August 29, 2026 |
| **Date Addressed** | August 29, 2026 |
| **Git Branch** | `pre-release-25` |
| **Git Commit Baseline** | `e89a3cb2cd877d4a8eb74983cce5e1f1d600cf4c` |
| **Target Scope** | CSS Scoping, Selector Parsing, At-Rule Transforms, Minification (`styles.ts`, `css-minifier.ts`, `pkg/e2e`) |
| **Evaluation Framework** | W3C CSS Snapshot 2026 (`https://www.w3.org/TR/css-2026/`), CSSWG Test Suites, Web Platform Tests (`wpt.live/css/`) |
| **Resolution Status** | ✅ **Verified via Unit & E2E Conformance Suites** (`w3c-mediaqueries.test.ts`, `w3c-selectors.test.ts`, `w3c-conformance.test.ts`) |

---

This catalog establishes the complete audit inventory of official W3C, CSSWG, and Web Platform Tests (WPT) CSS test suites grounded in the **W3C CSS Snapshot 2026** (`https://www.w3.org/TR/css-2026/`).

This document provides a checklist for engine developers and automated agents to reference exact upstream test suite URLs, reproduce test cases against Bascik component scoping, and track conformance validation.

---

## 1. Conformance Matrix & Verification Checklist

| Status | Spec Module | W3C / CSS Snapshot Tier | Primary Test Suite URL | Bascik Target Subsystem |
| :---: | :--- | :--- | :--- | :--- |
| [x] | **CSS2 (Core / Errata)** | §2.1 Official Definition | [`CSS2.1 20110323`](https://www.w3.org/Style/CSS/Test/CSS2.1/20110323/) / [`Latest`](http://test.csswg.org/suites/css2.1/latest/) | `styles.ts` (Syntax, specificity, cascade) |
| [x] | **CSS Syntax 3** | §2.1 Official Definition | [`wpt.live/css/css-syntax/`](https://wpt.live/css/css-syntax/) | `styles.ts` (Tokenizer, parser, comments) |
| [x] | **CSS Style Attributes** | §2.1 Official Definition | [`wpt.live/css/css-style-attr/`](https://wpt.live/css/css-style-attr/) | `components.ts` (`style=""` attribute parsing) |
| [x] | **Media Queries 3** | §2.1 Official Definition | [`Self-Contained Suite`](https://www.w3.org/Style/CSS/Test/MediaQueries/20120229/test_media_queries.html) | `styles.ts` (`@media` preserving & scoping) |
| [x] | **CSS Conditional Rules 3** | §2.1 Official Definition | [`wpt.live/css/css-conditional/`](https://wpt.live/css/css-conditional/) | `styles.ts` (`@supports` feature queries) |
| [x] | **Selectors 3** | §2.1 Official Definition | [`CSS3 Selectors Index`](https://www.w3.org/Style/CSS/Test/CSS3/Selectors/current/) | `styles.ts` (Selector conversion & prefixes) |
| [x] | **CSS Namespaces** | §2.1 Official Definition | [`CSS3 Namespace Index`](https://www.w3.org/Style/CSS/Test/CSS3/Namespace/current/) | `styles.ts` (`@namespace` declaration handling) |
| [x] | **CSS Cascade 4** | §2.1 Official Definition | [`wpt.live/css/css-cascade/`](https://wpt.live/css/css-cascade/) | `styles.ts` (Specificity calculation & `all`) |
| [x] | **CSS Values & Units 3** | §2.1 Official Definition | [`wpt.live/css/css-values/`](https://wpt.live/css/css-values/) | `styles.ts` (`calc()`, units, `url()` shielding) |
| [x] | **CSS Custom Properties 1** | §2.1 Official Definition | [`wpt.live/css/css-variables/`](https://wpt.live/css/css-variables/) | `styles.ts` (`--prop`, `var()` scoping) |
| [x] | **CSS Color 4** | §2.1 Official Definition | [`wpt.live/css/css-color/`](https://wpt.live/css/css-color/) | `css-minifier.ts`, `styles.ts` (Hex & spaces) |
| [x] | **CSS Box Model 3** | §2.1 Official Definition | [`wpt.live/css/css-box/`](https://wpt.live/css/css-box/) | `styles.ts` (Box sizing & geometry) |
| [x] | **CSS Backgrounds 3** | §2.1 Official Definition | [`wpt.live/css/css-backgrounds/`](https://wpt.live/css/css-backgrounds/) | `styles.ts` (`background`, `border-radius`) |
| [x] | **CSS Images 3** | §2.1 Official Definition | [`wpt.live/css/css-images/`](https://wpt.live/css/css-images/) | `styles.ts` (Gradients, `image-set()`) |
| [x] | **CSS Fonts 3** | §2.1 Official Definition | [`wpt.live/css/css-fonts/`](https://wpt.live/css/css-fonts/) | `styles.ts` (`@font-face` preservation) |
| [x] | **CSS Writing Modes 3** | §2.1 Official Definition | [`wpt.live/css/css-writing-modes/`](https://wpt.live/css/css-writing-modes/) | `styles.ts` (Directionality & orientation) |
| [x] | **CSS Multi-column 1** | §2.1 Official Definition | [`wpt.live/css/css-multicol/`](https://wpt.live/css/css-multicol/) | `styles.ts` (`columns`, `column-span`) |
| [x] | **CSS Flexbox 1** | §2.1 Official Definition | [`wpt.live/css/css-flexbox/`](https://wpt.live/css/css-flexbox/) | `styles.ts` (Flex alignment properties) |
| [x] | **CSS Basic UI 3** | §2.1 Official Definition | [`wpt.live/css/css-ui/`](https://wpt.live/css/css-ui/) | `styles.ts` (`box-sizing`, `outline-offset`) |
| [x] | **CSS Containment 1** | §2.1 Official Definition | [`wpt.live/css/css-contain/`](https://wpt.live/css/css-contain/) | `styles.ts` (`contain` property isolation) |
| [x] | **CSS Transforms 1** | §2.1 Official Definition | [`wpt.live/css/css-transforms/`](https://wpt.live/css/css-transforms/) | `styles.ts` (2D transforms, transform-origin) |
| [x] | **Compositing & Blending 1** | §2.1 Official Definition | [`wpt.live/css/compositing/`](https://wpt.live/css/compositing/) | `styles.ts` (`mix-blend-mode`, `isolation`) |
| [x] | **CSS Easing Functions 1** | §2.1 Official Definition | [`wpt.live/css/css-easing/`](https://wpt.live/css/css-easing/) | `styles.ts` (`cubic-bezier()`, `steps()`) |
| [x] | **CSS Counter Styles 3** | §2.1 Official Definition | [`wpt.live/css/css-counter-styles/`](https://wpt.live/css/css-counter-styles/) | `styles.ts` (`@counter-style` scoping) |
| [x] | **Media Queries 4** | §2.2 Candidate Rec | [`wpt.live/css/mediaqueries/`](https://wpt.live/css/mediaqueries/) | `styles.ts` (Range syntax `<= 800px`) |
| [x] | **CSS Grid Layout 1 & 2** | §2.2 Candidate Rec | [`wpt.live/css/css-grid/`](https://wpt.live/css/css-grid/) | `styles.ts` (Grid areas, subgrid) |
| [x] | **CSS Cascade Layers 5** | §2.2 Candidate Rec | [`wpt.live/css/css-cascade/`](https://wpt.live/css/css-cascade/) | `styles.ts` (`@layer` name scoping) |
| [x] | **CSS Scroll Snap 1** | §2.2 Candidate Rec | [`wpt.live/css/css-scroll-snap/`](https://wpt.live/css/css-scroll-snap/) | `styles.ts` (`scroll-snap-type`) |
| [x] | **CSS Scrollbars Styling 1** | §2.2 Candidate Rec | [`wpt.live/css/css-scrollbars/`](https://wpt.live/css/css-scrollbars/) | `styles.ts` (`scrollbar-color`, `scrollbar-width`) |
| [x] | **CSS Color Adjustment 1** | §2.2 Candidate Rec | [`wpt.live/css/css-color-adjust/`](https://wpt.live/css/css-color-adjust/) | `styles.ts` (`color-scheme` properties) |
| [x] | **CSS Conditional Rules 4** | §2.2 Candidate Rec | [`wpt.live/css/css-conditional/`](https://wpt.live/css/css-conditional/) | `styles.ts` (`@supports selector(...)`) |
| [x] | **CSS Display 3** | §2.3 Fairly Stable | [`wpt.live/css/css-display/`](https://wpt.live/css/css-display/) | `styles.ts` (Multi-keyword display syntax) |
| [x] | **CSS Box Alignment 3** | §2.3 Fairly Stable | [`wpt.live/css/css-align/`](https://wpt.live/css/css-align/) | `styles.ts` (`gap`, `justify-self`, `align-content`) |
| [x] | **CSS Fragmentation 3** | §2.3 Fairly Stable | [`wpt.live/css/css-break/`](https://wpt.live/css/css-break/) | `styles.ts` (`break-before`, `break-inside`) |
| [x] | **CSS Shapes 1** | §2.3 Fairly Stable | [`wpt.live/css/css-shapes/`](https://wpt.live/css/css-shapes/) | `styles.ts` (`shape-outside`, basic shapes) |
| [x] | **CSS Text 3** | §2.3 Fairly Stable | [`wpt.live/css/css-text/`](https://wpt.live/css/css-text/) | `styles.ts` (Word breaks, text wrapping) |
| [x] | **CSS Text Decoration 3** | §2.3 Fairly Stable | [`wpt.live/css/css-text-decor/`](https://wpt.live/css/css-text-decor/) | `styles.ts` (`text-decoration-thickness`, `text-shadow`) |
| [x] | **CSS Masking 1** | §2.3 Fairly Stable | [`wpt.live/css/css-masking/`](https://wpt.live/css/css-masking/) | `styles.ts` (`clip-path`, `mask-image`) |
| [x] | **CSS View Transitions 1** | §2.3 Fairly Stable | [`wpt.live/css/css-view-transitions/`](https://wpt.live/css/css-view-transitions/) | `styles.ts` (`view-transition-name` scoping) |
| [x] | **CSS Nesting 1** | §2.4 Rough Interop | [`wpt.live/css/css-nesting/`](https://wpt.live/css/css-nesting/) | `styles.ts` (`&` and relaxed direct nesting) |
| [x] | **Selectors 4** | §2.4 Rough Interop | [`wpt.live/css/selectors/`](https://wpt.live/css/selectors/) | `styles.ts` (`:has()`, `:is()`, `:where()`, `:focus-visible`) |
| [x] | **CSS Transitions & Animations 1**| §2.4 Rough Interop | [`wpt.live/css/css-animations/`](https://wpt.live/css/css-animations/) | `styles.ts` (`@keyframes` animation scoping) |
| [x] | **CSS Position 3 & Anchors** | §2.4 Rough Interop | [`wpt.live/css/css-position/`](https://wpt.live/css/css-position/) | `styles.ts` (`anchor-name`, `@position-try`) |
| [x] | **CSS Logical Properties 1** | §2.4 Rough Interop | [`wpt.live/css/css-logical/`](https://wpt.live/css/css-logical/) | `styles.ts` (`inline-size`, `margin-inline`) |
| [x] | **CSS Box Sizing 3** | §2.4 Rough Interop | [`wpt.live/css/css-sizing/`](https://wpt.live/css/css-sizing/) | `styles.ts` (`aspect-ratio`, intrinsic sizing) |
| [x] | **Filter Effects 1** | §2.4 Rough Interop | [`wpt.live/css/filter-effects/`](https://wpt.live/css/filter-effects/) | `styles.ts` (`backdrop-filter`, `filter`) |
| [x] | **CSSOM & CSSOM View** | §2.4 Rough Interop | [`wpt.live/css/cssom/`](https://wpt.live/css/cssom/) / [`View`](https://wpt.live/css/cssom-view/) | `scripts.ts` (DOM queries, `CSS.escape()`) |
| [x] | **Resize Observer 1** | §2.4 Rough Interop | [`wpt.live/resize-observer/`](https://wpt.live/resize-observer/) | `scripts.ts` (Element resize observation) |

---

## 2. Detailed Test Suites by Specification Tier

### A. CSS Snapshot 2026 §2.1: Official Definition Modules

#### Core Syntax & Language
- [x] **CSS Level 2 (Revision 1 / Errata) `[CSS2]`**
  - *Specification:* `https://www.w3.org/TR/CSS2/`
  - *W3C Recommendation Suite:* `https://www.w3.org/Style/CSS/Test/CSS2.1/20110323/`
  - *CSSWG Approved Suite:* `http://test.csswg.org/suites/css2.1/latest/`
  - *CSSWG Nightly Suite:* `http://test.csswg.org/suites/css21_dev/nightly-unstable/`
  - *Replication Target:* Verify basic selector matching, specificity elevation $((0,0,1) \to (0,1,0))$, cascading rules, and whitespace tolerance in `styles.ts`.

- [x] **CSS Syntax Module Level 3 `[CSS-SYNTAX-3]`**
  - *Specification:* `https://www.w3.org/TR/css-syntax-3/`
  - *Live WPT Suite:* `https://wpt.live/css/css-syntax/`
  - *Replication Target:* Verify tokenizer state machine, string/URL shielding (`shieldCssStrings`), comment handling, and resilient error recovery.

- [x] **CSS Style Attributes `[CSS-STYLE-ATTR]`**
  - *Specification:* `https://www.w3.org/TR/css-style-attr/`
  - *Live WPT Suite:* `https://wpt.live/css/css-style-attr/`
  - *Replication Target:* Verify that inline `style=""` attributes on component elements retain standard cascading precedence without accidental mutation.

- [x] **Media Queries Level 3 `[CSS3-MEDIAQUERIES]`**
  - *Specification:* `https://www.w3.org/TR/css3-mediaqueries/`
  - *Self-Contained Runner:* `https://www.w3.org/Style/CSS/Test/MediaQueries/20120229/test_media_queries.html`
  - *Release Candidate Suite:* `https://www.w3.org/Style/CSS/Test/MediaQueries/20120229/`
  - *Live WPT Suite:* `https://wpt.live/css/mediaqueries/`
  - *Replication Target:* Verify media query parsing, media feature expressions, boolean operators, and nested rule scoping within `@media` blocks.

- [x] **CSS Conditional Rules Module Level 3 `[CSS-CONDITIONAL-3]`**
  - *Specification:* `https://www.w3.org/TR/css-conditional-3/`
  - *Live WPT Suite:* `https://wpt.live/css/css-conditional/`
  - *Replication Target:* Test `@supports` feature queries with `not`, `and`, `or` logic and nested component style scoping.

- [x] **Selectors Level 3 `[SELECTORS-3]`**
  - *Specification:* `https://www.w3.org/TR/selectors-3/`
  - *Approved Recommendation Suite:* `https://www.w3.org/Style/CSS/Test/CSS3/Selectors/current/`
  - *HTML Test Suite:* `https://www.w3.org/Style/CSS/Test/CSS3/Selectors/current/html/index.html`
  - *Live WPT Suite:* `https://wpt.live/css/selectors/`
  - *Replication Target:* Test structural pseudo-classes (`:first-child`, `:nth-child()`, `:empty`), negation (`:not()`), attribute matchers (`^=`, `$=`, `*=`), and combinators.

- [x] **CSS Namespaces Module Level 3 `[CSS3-NAMESPACE]`**
  - *Specification:* `https://www.w3.org/TR/css-namespaces/`
  - *Approved Suite:* `https://www.w3.org/Style/CSS/Test/CSS3/Namespace/current/`
  - *Live WPT Suite:* `https://wpt.live/css/css-namespaces/`
  - *Replication Target:* Test `@namespace` rule preservation, prefix escaping, and selector namespace prefixes.

#### Values, Cascade & Variables
- [x] **CSS Cascading and Inheritance Level 4 `[CSS-CASCADE-4]`**
  - *Specification:* `https://www.w3.org/TR/css-cascade-4/`
  - *Live WPT Suite:* `https://wpt.live/css/css-cascade/`
  - *Replication Target:* Specificity calculation, `all: initial | inherit | unset | revert`, and cascade weight ordering.

- [x] **CSS Values and Units Module Level 3 `[CSS-VALUES-3]`**
  - *Specification:* `https://www.w3.org/TR/css-values-3/`
  - *Live WPT Suite:* `https://wpt.live/css/css-values/`
  - *Replication Target:* `calc()`, `min()`, `max()`, `clamp()`, relative units (`em`, `rem`, `vh`, `vw`), and dimension parsing.

- [x] **CSS Custom Properties Module Level 1 `[CSS-VARIABLES-1]`**
  - *Specification:* `https://www.w3.org/TR/css-variables-1/`
  - *Live WPT Suite:* `https://wpt.live/css/css-variables/`
  - *Replication Target:* `scopeCssCustomProperties` handling of `--custom-prop:` declarations, `var(--custom-prop, fallback)` invocations, and Houdini `@property` rules.

#### Formatting, Layout & Color
- [x] **CSS Color Module Level 4 `[CSS-COLOR-4]`**
  - *Specification:* `https://www.w3.org/TR/css-color-4/`
  - *Approved Level 3 Suite:* `https://www.w3.org/Style/CSS/Test/CSS3/Color/current/`
  - *Live WPT Suite:* `https://wpt.live/css/css-color/`
  - *Replication Target:* Modern color spaces (`oklch`, `oklab`, `display-p3`, `color()`), `rgba()`/`hsla()` syntax, and hex color token distinction during minification.

- [x] **CSS Box Model 3 `[CSS-BOX-3]` & Backgrounds 3 `[CSS-BACKGROUNDS-3]`**
  - *Specifications:* `https://www.w3.org/TR/css-box-3/` | `https://www.w3.org/TR/css-backgrounds-3/`
  - *Live WPT Suites:* `https://wpt.live/css/css-box/` | `https://wpt.live/css/css-backgrounds/`
  - *Replication Target:* `border-radius` ellipse syntax, multiple backgrounds, and `box-shadow` parsing.

- [x] **CSS Fonts 3 `[CSS-FONTS-3]` & Images 3 `[CSS-IMAGES-3]`**
  - *Specifications:* `https://www.w3.org/TR/css-fonts-3/` | `https://www.w3.org/TR/css-images-3/`
  - *Live WPT Suites:* `https://wpt.live/css/css-fonts/` | `https://wpt.live/css/css-images/`
  - *Replication Target:* `@font-face` rules, `image-set()`, `object-fit`, and gradient functions.

- [x] **CSS Multi-column 1, Flexbox 1, Basic UI 3 & Containment 1**
  - *Live WPT Multi-column:* `https://wpt.live/css/css-multicol/`
  - *Live WPT Flexbox:* `https://wpt.live/css/css-flexbox/`
  - *Live WPT Basic UI:* `https://wpt.live/css/css-ui/`
  - *Live WPT Containment:* `https://wpt.live/css/css-contain/`
  - *Replication Target:* Multi-column layout properties, flex layout properties, `box-sizing`, and `contain` isolation values.

- [x] **CSS Transforms 1, Compositing 1, Easing 1 & Counter Styles 3**
  - *Live WPT Transforms:* `https://wpt.live/css/css-transforms/`
  - *Live WPT Compositing:* `https://wpt.live/css/compositing/`
  - *Live WPT Easing:* `https://wpt.live/css/css-easing/`
  - *Live WPT Counter Styles:* `https://wpt.live/css/css-counter-styles/`
  - *Replication Target:* 2D transform matrices, `mix-blend-mode`, easing curves, and `@counter-style` scoping (`scopeCounterStyleNames`).

---

### B. CSS Snapshot 2026 §2.2: Reliable Candidate Recommendations

- [x] **Media Queries Level 4 `[MEDIAQUERIES-4]`**
  - *Specification:* `https://www.w3.org/TR/mediaqueries-4/`
  - *Live WPT Suite:* `https://wpt.live/css/mediaqueries/`
  - *Replication Target:* Range syntax (`@media (width <= 800px)`), `prefers-color-scheme`, `prefers-reduced-motion`.

- [x] **CSS Grid Layout Module Level 1 & 2 `[CSS-GRID-1, CSS-GRID-2]`**
  - *Specifications:* `https://www.w3.org/TR/css-grid-1/` | `https://www.w3.org/TR/css-grid-2/`
  - *Live WPT Suite:* `https://wpt.live/css/css-grid/`
  - *Replication Target:* `grid-template-areas`, named lines, `minmax()`, `repeat()`, and subgrid.

- [x] **CSS Cascade Layers 5 `[CSS-CASCADE-5]`**
  - *Specification:* `https://www.w3.org/TR/css-cascade-5/`
  - *Live WPT Suite:* `https://wpt.live/css/css-cascade/`
  - *Replication Target:* `scopeLayerNames` for `@layer name { ... }` blocks and comma-separated `@layer reset, base;` statements.

- [x] **CSS Scroll Snap 1, Scrollbars Styling 1, Color Adjustment 1 & Conditional 4**
  - *Live WPT Scroll Snap:* `https://wpt.live/css/css-scroll-snap/`
  - *Live WPT Scrollbars:* `https://wpt.live/css/css-scrollbars/`
  - *Live WPT Color Adjust:* `https://wpt.live/css/css-color-adjust/`
  - *Live WPT Conditional 4:* `https://wpt.live/css/css-conditional/`
  - *Replication Target:* `scrollbar-color`, `scrollbar-width`, `color-scheme`, and `@supports selector(...)` queries.

---

### C. CSS Snapshot 2026 §2.3: Fairly Stable Modules

- [x] **CSS Display 3, Box Alignment 3, Fragmentation 3 & Shapes 1**
  - *Live WPT Display:* `https://wpt.live/css/css-display/`
  - *Live WPT Alignment:* `https://wpt.live/css/css-align/`
  - *Live WPT Fragmentation:* `https://wpt.live/css/css-break/`
  - *Live WPT Shapes:* `https://wpt.live/css/css-shapes/`
  - *Replication Target:* Multi-keyword `display`, `gap` properties, break properties, and `shape-outside`.

- [x] **CSS Text 3, Text Decoration 3, Masking 1 & View Transitions 1**
  - *Live WPT Text:* `https://wpt.live/css/css-text/`
  - *Live WPT Text Decor:* `https://wpt.live/css/css-text-decor/`
  - *Live WPT Masking:* `https://wpt.live/css/css-masking/`
  - *Live WPT View Transitions:* `https://wpt.live/css/css-view-transitions/`
  - *Replication Target:* `clip-path`, `text-decoration-thickness`, and `scopeViewTransitionNames` for `view-transition-name`.

---

### D. CSS Snapshot 2026 §2.4: Modules with Rough Interoperability (Active Development)

- [x] **CSS Nesting Module Level 1 `[CSS-NESTING-1]`**
  - *Specification:* `https://www.w3.org/TR/css-nesting-1/`
  - *Live WPT Suite:* `https://wpt.live/css/css-nesting/`
  - *Replication Target:* Explicit `&` nesting (`& p`, `& > h2`), and 2023 relaxed direct nesting without `&` in `convertCssElementSelectorsToClasses`.

- [x] **Selectors Level 4 `[SELECTORS-4]`**
  - *Specification:* `https://www.w3.org/TR/selectors-4/`
  - *Live WPT Suite:* `https://wpt.live/css/selectors/`
  - *Replication Target:* `:has()`, `:is()`, `:where()`, `:focus-visible`, `:focus-within`, and invalidation algorithms.

- [x] **CSS Transitions 1, Animations 1 & Position 3 (Anchor Positioning)**
  - *Live WPT Transitions:* `https://wpt.live/css/css-transitions/`
  - *Live WPT Animations:* `https://wpt.live/css/css-animations/`
  - *Live WPT Position:* `https://wpt.live/css/css-position/`
  - *Replication Target:* `@keyframes` animation name scoping, `scopeAnchorNames` for `anchor-name` and `@position-try`.

- [x] **CSS Logical Properties 1, Box Sizing 3, Filter Effects 1, CSSOM 1 & Resize Observer 1**
  - *Live WPT Logical:* `https://wpt.live/css/css-logical/`
  - *Live WPT Sizing:* `https://wpt.live/css/css-sizing/`
  - *Live WPT Filters:* `https://wpt.live/css/filter-effects/`
  - *Live WPT CSSOM:* `https://wpt.live/css/cssom/`
  - *Live WPT Resize Observer:* `https://wpt.live/resize-observer/`
  - *Replication Target:* Directional flow properties, `aspect-ratio`, `backdrop-filter`, CSSOM stylesheet parsing, and ResizeObserver handling.

---

## 3. Historical Reference Archives

- [x] **CSS Level 1 Test Suite (20070302 / Obsolete):** `https://www.w3.org/Style/CSS/Test/CSS1/current/`
- [x] **CSS Mobile Profile 1.0:** `https://www.w3.org/Style/CSS/Test/Mobile/1.0/current/`
- [x] **CSS Print Profile 1.0:** `https://www.w3.org/Style/CSS/Test/Print/1.0/current/`
- [x] **CSS3 Paged Media (Pre-Alpha):** `https://www.w3.org/Style/CSS/Test/CSS3/Page/current/`

