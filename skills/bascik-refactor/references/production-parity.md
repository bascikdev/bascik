# Production parity with coding agents

The workflow for refactoring a live site to Bascik so that every route matches production at every breakpoint and
scores 100 in all five Lighthouse categories, mobile and desktop. It works with any coding agent that can run shell
commands. The human-readable version, with a live demo, is `read-doc.mjs /how-to/agent-migration` in the `bascik`
skill.

## The three-source evidence model

| Source                                    | Role                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Live production DOM, read with Playwright | Visual and geometric truth: `getBoundingClientRect()`, `getComputedStyle()`, pseudo-elements, `currentSrc`  |
| Legacy repository, read-only              | Intent: why an element sits where it does, grid spans and offsets, Sass media queries, state, API contracts |
| New Bascik repository                     | Clean semantic implementation: HTML components, scoped CSS, small TypeScript islands                        |

Golden rule: live production wins on geometry; the legacy source explains the responsive math; the Bascik repository
owns clean semantic HTML and CSS. Record production defects (low contrast, missing focus outline, blurry image, the
layout bugs `production-defects.mjs` finds) as observations and fix them. Never copy them. Log every fix in the
decisions ledger.

Two failure modes this model prevents:

1. Screenshot guessing: close at one width, wrong spacing, fonts and breakpoints everywhere else.
2. Blind DOM copying: grid wrapper divs, hydration data and generated class names pasted into components.

## Inventories (docs/migration/, committed)

Record these before writing any page. Every later prompt reads them.

- `routes.json`: every reachable route, redirect, PDF and API endpoint, each with its legacy owner and target page.
  Shape: `{ "routes": [{ "path", "legacy", "target" }], "redirects": [{ "from", "to", "status" }], "files": [], "api": [{ "path", "method" }] }`.
- `urls.txt`: one target URL per line (`$TARGET_URL` plus each route path), generated from `routes.json`; the
  Lighthouse gate's `--expect-urls`.
- `breakpoints.json`: the viewport matrix, `{ "thresholds": [], "sources": {}, "cases": [{ "width", "height" }] }`.
  A case may add `hasTouch`, `isMobile`, `colorScheme` or `reducedMotion`. Generate it with
  `scripts/breakpoint-matrix.mjs`, then review it.
- `interactions.json`: every interactive surface (dropdowns, drawer, carousel, tabs, slider, modal, sticky header) as
  an array of steps: `{ "name", "route", "testId" | "role" + "roleName" | "selector", "nth", "panel", "action",
"key", "expect": { "ariaExpanded", "visible", "focused" }, "minWidth", "maxWidth", "legacy" }`. Actions: click,
  press, hover, keyboard, outside-click, focus-out. Steps run in order on one page per matrix case.
- `integrations.json`: every third-party script with its network and cookie contract:
  `[{ "name", "loads", "origins", "cookies", "pages" }]`.
- `decisions.md`: the differences-and-decisions ledger (template: `templates/decisions-ledger.md`).
- `accepted.json`: one entry per ledger row that changes pixels, `[{ "id", "route", "minWidth", "maxWidth", "mask",
"maxRatio" }]`, passed to `compare-route.mjs --accepted`. The scripts never read `decisions.md` itself.

## Environment and servers

Set `PROD_URL`, `TARGET_URL` (default `http://localhost:8080`), `BASCIK_SITE_URL` (the public origin; the build
needs it for the sitemap, robots.txt and canonicals) and `REFACTOR` (the `bascik-refactor/scripts` folder of the
installed skills). Compare and audit a production build only: `npx bascik --build && npx bascik --server`, or
`npx wrangler dev --config wrangler.wrapper.jsonc` for the Cloudflare wrapper. Copy `llms-txt.mjs` and
`worker-response-policy.mjs` into the project's `scripts/` folder before the config or the Worker imports them; both
import nothing else.

## Capture settings

Identical on both sides: width and height, browser version, device scale factor 1, zoom 100 percent, light color
scheme, reduced motion, scroll position 0, the same cookie notice state. Before measuring, wait for
`document.fonts.ready`, complete eager images and finished finite animations. `scripts/lib/capture.mjs` does this.

## The breakpoint matrix rule

1. Discover the real thresholds: CSS, Sass and Less media queries, breakpoint variables and theme tokens,
   `matchMedia()` and `useMediaQuery()` queries, `innerWidth` checks, responsive image `sizes`. A component library's
   grid breakpoints live in its package: pass production's compiled stylesheets to `breakpoint-matrix.mjs` too, or
   add the library's documented breakpoints with `--add`.
2. For every threshold B, test B - 1, B and B + 1 CSS pixels.
3. Add one width inside every interval, plus the narrowest and widest supported widths.
4. Width and height are a pair.
5. Add hover, orientation and reduced-motion cases where the site uses them.
6. Sample scroll-driven states at the threshold minus 1 and plus 1, in both directions.

Expect a few dozen cases.

## The per-route loop

1. Capture production and the target with the settings above.
2. Find the owning production subtree from stable anchors: visible heading text, `href`, `src`, `alt`, landmarks,
   test ids. Never generated class names. Stop at the smallest ancestor that owns one coherent section.
3. Extract structure, geometry and computed styles. Property list: display, position, box-sizing, width, height,
   margin, padding, gap, align-items, justify-content, overflow, color, background, border, border-radius,
   box-shadow, font-family, font-size, font-weight, line-height, letter-spacing, text-align, white-space, transform,
   z-index. Also `::before` and `::after`, child order, line counts, image `currentSrc`, intrinsic size,
   `object-fit` and `object-position`.
4. Read the legacy owner of that subtree only. Translate resolved behavior; do not copy React or Sass wholesale.
5. Choose Bascik boundaries. The route page owns page-level composition and order. Extract a component when a
   surface repeats, has independent behavior or a meaningful responsive layout, or has a small prop and slot
   contract. Never wrap a whole page in one component.
6. Write CSS from measured relationships (container widths, padding, grid tracks, aspect ratios), not pixel nudges.
   Example: a 24-column grid, span 20 offset 2, inside a 1200 px container becomes one section with
   `width: min(100%, 1200px); margin: 0 auto` and the offset as padding,
   `calc(min(100%, 1200px) / 12)` on each side. Several nested wrapper divs become one element.
7. Validate after each section: build, type check, reload, re-measure the same boxes, compare a screenshot, run the
   section's interaction test. Fix it before the next section.
8. Compare the route in three layers (below).
9. Log intentional differences in the ledger.

## Three-layer comparison

Per route and matrix case:

1. Pixels: per-channel tolerance 10, only documented dynamic regions masked.
2. Geometry: `scripts/geometry-diff.mjs`. Flag `|dx| > 6`, `|dy| > 12`, `|dw| > 12` CSS pixels, plus nodes missing on
   either side. It catches cumulative drift (a small margin repeated per table row), doubled offsets (a relative top
   and a margin top from two media queries) and containers off-center at in-between widths.
3. Content and style: text, font metrics, colors, image source and crop, link targets.

`scripts/compare-route.mjs` runs all three and replays `interactions.json` on both sides. Accepted differences come
only from `accepted.json` entries tied to ledger rows. No route passes on one screenshot or on a Lighthouse score.

## Parity checks

Why they exist: in a real agent-driven refactor the automated loop passed pages that a human then caught side by side
with production. The old scripts compared absolute geometry of text nodes with loose thresholds and only open and
closed booleans for interactions, and agents read "no flags" as PASS. The issue types the human caught:

1. Missing interactions: a hero button that should scroll to its section did nothing.
2. Main-nav dropdown menus with the wrong style and missing icons.
3. A repeated section that any human would make a component, pasted per page, one copy styled wrong.
4. Some links with the wrong color, or the wrong font weight.
5. Vertical spacing between elements off by tens of pixels.
6. Text misaligned at certain breakpoints only.
7. A timeline with an SVG over one of its circles, overlapping it a little off.

`scripts/run-checks.mjs` runs one check per type, plus test hooks, presence and production defects, on every route at
every matrix case, and exits 1 on any finding; a check that crashed is a finding. It writes
`artifacts/checks/<route>/report.json`. Each check is also its own script with `--help`.

| Script                   | Compares                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Tolerance                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `production-defects.mjs` | Runs first, on production: squished or stretched images (aspect ratio off with `object-fit` fill or none; `loading="lazy"` images are loaded first; an inline svg with `preserveAspectRatio="none"` off its viewBox ratio), an icon off the center of its heading or of its text label (a paragraph, span or list item beside it) or wrapped away from it, text overflowing or clipped, overlapping text (not text in a fixed, sticky or dialog layer, which covers the page by design), horizontal page scroll                                                                                                                                                                                                                                                                                                                                                                                                               | 2 percent; 4 px for icon centers                                  |
| `interaction-crawl.mjs`  | Every element matching the interactive selector, any element with a click or hover listener (CDP `DOMDebugger.getEventListeners`), with a delegated click listener on document or window the pointer-cursor elements, and the triggers of CSS `:hover` menus; each clicked or hovered from a fresh load, scrolled into view first, and the controls inside what a control opens (a dialog's Close) one level deep. Effects: scroll distance, target and where the target lands (under a sticky header is a finding), hash, URL, `aria-expanded`, open, hidden, form values (a stepper), content moved in a clipped region (a carousel track), newly visible and focused elements, minus what the page changes on its own until the settle time. An element whose selector changes per load is found again by test id, role and name, href or text; a target element that still cannot be activated is an `unmeasured` finding | 8 px of scroll; 24 px of landing                                  |
| `state-capture.mjs`      | Every disclosure the crawl finds, clicked or hovered open on both sides after its animation (an in-page link that only scrolls is not one): the panel's computed styles and size, its place relative to its trigger, the styles of its items at rest and with `:hover` and `:focus-visible` forced, its icons (kind and file; an inline svg's drawing and fill and stroke colors; a `::before` or `::after` glyph), the trigger's style and icon transforms while open (a chevron that turns), the brightness of the page around the panel (a scrim), and a pixel crop of the panel                                                                                                                                                                                                                                                                                                                                           | 1 px for place; 8 of 255 per pixel channel; 10 percent brightness |
| `repeated-sections.mjs`  | Structural fingerprints (tag tree with landmarks and heading levels, no text) of landmarks and of divs that hold a heading, and small bands with a heading and a link or button (fingerprinted with their heading text), on two or more routes, must render from one component in `src/components` (a page source that holds the section's heading text, character references decoded, pastes it; a layout component around a page's slot is not the section's component), and every instance must match production's style signature, every part included, with masked regions left out of fingerprints and signatures                                                                                                                                                                                                                                                                                                       | exact                                                             |
| `text-style-diff.mjs`    | Color, weight, style, family, size, line height, letter spacing, decoration with its thickness and underline offset, transform, shadow, text fill and a `background-clip: text` gradient, and the focus ring (outline, box-shadow) of every text element, each copy of a repeated text on its own, at rest, `:hover` and `:focus-visible` (CDP `CSS.forcePseudoState` on the element and its ancestors, so a link's or a card's `:hover` counts). A `<time datetime>` is matched by its datetime                                                                                                                                                                                                                                                                                                                                                                                                                              | exact                                                             |
| `spacing-diff.mjs`       | Inside each landmark (or the body, for content outside them), every block of content at any depth: the gap to the block above it, its offset from the section top and its height. Between landmarks: the space to the previous one and each one's height, unless a finding inside it explains it. Wrappers do not matter; fixed layers do not count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2 px                                                              |
| `alignment-diff.mjs`     | Per matrix case, text-align, rendered line count and the left and right offset from its container and from the page edges, for headings, paragraphs, buttons, links, list items, labels, captions, cells, every other element with its own text (a stat in a div, a row of spans), and images, pictures, videos and large svgs, each copy of a repeated text on its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2 px                                                              |
| `overlap-diff.mjs`       | Pairs that overlap by 1 px or more in production (one positioned or an svg or img, a positioned `::before` or `::after`, the parts of a large inline svg, an icon nested in a dot or avatar up to 160 px, two painted blocks pulled over each other), paired in document order: center offset and size ratio on the target, then the pixels both cover, with masked regions left out. Fixed and sticky layers pair only with their own parts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 1 px; zero pixels                                                 |
| `testid-carryover.mjs`   | Every `data-testid`, `data-test`, `data-test-id`, `data-cy` and `data-qa` in production's DOM and the legacy source, on the same element of the target with the same name and value, and on no more elements than in production; a legacy hook that renders only on demand on the same kind of element in the target's source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | exact                                                             |
| `testid-coverage.mjs`    | A `data-testid` on every control, widget role (switch, option, checkbox), element in the tab order or with a click listener, form, dialog, landmark and component root of the target, and on the controls in a page's `<template>`: the root is the component name (components in any folder, named by their file), parts are `<component>-<part>`. A gap names a file and line only when a source tag matches it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | exact                                                             |
| `presence-by-route.mjs`  | Fixed, sticky and overlay layers and in-flow bars above the header per route, at the top and scrolled to the middle and bottom, each route in a fresh browser context, again after dismissal and in a new tab; each fixed layer's dock (top, middle or bottom; left, center or right). A live region without a name is named by its test id, id or place, never by its rotating text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | exact                                                             |

Rules every check follows: elements are matched by stable anchors (test id, role and accessible name, in-page `href`,
tag and text), never by class names; each page is captured with the settings above and the waits in
`scripts/lib/capture.mjs`, then waits until 5 s after it started loading (`--settle-ms`) and until the page has had no
DOM change outside the masks for 0.75 s (at most 4 s), so a banner, a newsletter modal on a timer or content that
arrives late is on both sides before anything is measured; the scroll and animation an activation starts are waited
for too; hidden elements do not count. Masks are only for documented dynamic regions: an autoplay carousel, an
autoplay video, a rotating ticker, a relative time or other text a clock drives. Pass each with `--mask` (every check
and `run-checks.mjs` take it), log it in the ledger, and keep it as narrow as the region: mask the `<video>`, not the
hero around it, because a masked region is left out of every screenshot while what is drawn over it (the headline, an
open menu) is still compared. Never mask a modal or banner on a timer; raise `--settle-ms` past its timer instead,
since masking it removes the layer presence-by-route checks. Expect about two minutes per route per matrix case
(state-capture and interaction-crawl take most of it, since both reload the page per interactive element); run every
check anyway. A check that crashes on a navigation timeout is run once more and the report notes the retry.

The interaction crawl and state capture are not read-only toward production. They never follow a plain navigation
link or press a submit button, but they click every other control (a `<button type="button">`, a `role="button"`, an
element with a click listener) from a fresh load, once per matrix case and again per layer it opens. A handler that
posts to the live site (add to cart, subscribe through JavaScript, vote or like, start a chat, analytics events) runs
each time. Before the first run, list the site's side-effecting controls and pass each with `--skip-control
<selector>` (both checks and `run-checks.mjs` take it); those controls are not activated on either side, so compare
them by hand and note it in the ledger.

### Production defects

Production is the truth for geometry, not for bugs. `production-defects.mjs` runs on production before a route is
written, at every matrix case. Each defect (a squished image, an icon misaligned with its heading, text overflow,
horizontal scroll) is appended to `docs/migration/decisions.md` as "production defect: fix in target" with its route,
width and selector. The parity checks then compare the target with the corrected expectation for that element at that
case: their findings there move to `corrected` in the report instead of failing, and the review page lists the
defects apart from the findings, so the reviewer sees every intentional difference. A target that copies a defect
fails with `copied-defect`.

### Presence by route

`presence-by-route.mjs` opens every route in a fresh context (no cookies, no storage) and waits for the settle time
and a stable render, so a cookie banner that slides in after load, or a modal on a timer, is seen. It inventories fixed
and sticky elements, dialogs, alert dialogs, live regions, layers along a viewport edge and in-flow bars above the
site header, by role and accessible name, at the top of the page and again scrolled to the middle and the bottom (a
"Back to top" button that shows after scrolling), with the edge each fixed layer is docked to. Then it dismisses each
layer once (Accept, Close, Got it and the like, or a `--dismiss` selector) across all routes and inventories again, in
that tab and in a new tab: a dismissal that persists in production, across routes and tabs, must persist on the
target (consent kept in sessionStorage comes back in every new tab). A cookie notice present on only some routes must
be on exactly those routes, docked where production docks it.

### The review gate

No route passes on findings alone. After `run-checks.mjs` passes:

1. `review-page.mjs --route <path>` writes `artifacts/review/<route>.html`: production and the target side by side per
   matrix case, a diff overlay toggle, the open states, the findings beside the images, production's defects, the
   checklist above and a sign-off form.
2. A visual reviewer agent with image input runs `templates/visual-review.md`. Its job is to find differences; the
   route cannot pass while it reports any.
3. A person reviews the page and signs `docs/migration/review/<route>.json` (`{ route, reviewer, verdict, notes, date,
reviewed }`, verdict pass or issues), from the form or with `review-page.mjs --sign`. `reviewed` is a hash of the
   target's screenshots and the findings the page showed.
4. `review-page.mjs --verify --route <path>` is the last item of the driver's PASS gate. It fails when the route's
   run-checks report fails, and when the target's screenshots or findings changed after the sign-off: a fix after the
   review needs a new review.

## Interaction parity floor

- Hover never replaces the keyboard focus indicator.
- A desktop dropdown opens from its trigger and closes when another opens, on outside click, Escape and focus exit.
- A mobile drawer and its nested disclosures keep accurate `aria-expanded` and close by control, outside click, link
  activation and Escape.
- Carousels move with next and previous controls; sliders change by keyboard and pointer.
- Record each state: trigger, precondition, action, result, focused element, before and after screenshots.
- End-to-end locators use roles, text or `data-testid`. With `minify.identifiers` on, class and id names are hashed.

## Organizing agents

- Execution contract: `templates/execution-contract.md`. Every prompt reads it first.
- Prompt pack: `templates/prompt-pack-index.md`, grouped into phases, with the representative slice gate (prove
  5 x 100 on a few pages before scaling).
- Repeatable prompts: `templates/one-route.md` and `templates/one-failure.md`.
- Visual review: `templates/visual-review.md`, an agent with image input that looks for differences only.
- Driver: `templates/driver-agent.md`. Never advance until every acceptance check passes on the final files. Keep
  fixing application-owned failures. Escalate framework issues in the reproducible format and hold the queue.
- Swarming: build the shared shell sequentially and lock it with tests; then several agents on strictly disjoint page
  families (start with a few); split cross-cutting sweeps into folder buckets; finish with one build, check and test
  gate.

## Score techniques

- LCP: no hero animation that starts at `opacity: 0` (Chromium records no LCP candidate while transparent);
  responsive WebP with `srcset` (`scripts/responsive-webp.mjs`; its manifest's `url` fields build the srcset, and
  `--manifest src/lib/images.json` keeps it out of the published site); a route-aware preload of the hero from a
  `data-bascik-build` script reading `BASCIK_PAGE_PATH` (a `data-bascik-build-once` script has no page context);
  `loading="lazy"` below the fold.
- Render blocking and CLS: `assets.inlineStyles` with the global stylesheet path; self-hosted subset fonts, preloaded,
  with a metric-matched fallback (`ascent-override`, `descent-override`, `size-adjust`).
- TBT: no framework runtime; vendor code bundled by a `pre` exec script, code-split and loaded late; hover-intent
  prefetch after load.
- Best Practices: strict CSP with SHA-256 hashes and no `unsafe-inline`. `generate.cspHashes` writes
  `.bascik/dist/csp-hashes.json` (written after post exec scripts finish, so a post script cannot read it). On
  Cloudflare, `scripts/worker-response-policy.mjs` sends each HTML response's route hashes from that file in a Worker
  wrapper, so streamed pages keep streaming. Never hash the live response body on a site with server or stream
  scripts: a script reflected from the request would be hashed and allowed (`hashResponseBodies` is for static
  sites only).
- Agentic Browsing: scored as a pass ratio (Lighthouse 13.3 or later, Chrome 150 or later). Roles and names on
  every control, CLS 0, and `llms.txt` from the copied `scripts/llms-txt.mjs` as a `post` exec script.
- SEO: per-route canonical, Open Graph, Twitter tags, JSON-LD with `BreadcrumbList` on subpages.
- Collect: `npx lighthouse <url> --output=json --output-path=artifacts/lighthouse/mobile/<slug>.json`, and again with
  `--preset=desktop` into `artifacts/lighthouse/desktop/`, from the project's Lighthouse 13.3 or later. Not
  `@lhci/cli`: it runs a bundled Lighthouse 12 without Agentic Browsing.
- Gate: `scripts/lighthouse-gate.mjs` requires Performance, Accessibility, Best Practices and SEO at exactly 1 and
  every passable Agentic Browsing audit passed, for the requested form factor, on every expected URL.
- Never game the audit: no user-agent detection, no vendor-free audit mode, no hidden content, no timers that outlast
  the run.

## Gotchas

1. Scoped ids: static literals in `getElementById`, `querySelector("#id")` and similar calls are rewritten, and so are
   `aria-controls`, `popovertarget`, `commandfor` and `href="#id"`. Dynamic lookups are not, and the
   `js-dynamic-id-lookup` lint flags them. Use literals, DOM traversal or bubbling `CustomEvent`s.
2. With `minify.identifiers` on, test with roles, text or `data-testid`.
3. esbuild's `[hash]` in chunk names is uppercase. A Worker redirect to lowercase URLs breaks those chunks: exempt
   asset paths (any path with a file extension, or the bundle folder) from the redirect. Bascik has no chunk name
   option.
4. JSX drops whitespace between tags; HTML keeps it. Put `white-space: pre-wrap` on the leaf only.
5. `transform` creates a stacking context. Do not use it for spacing.
6. Buttons have default padding. Reset `padding: 0` on icon buttons.
7. Font subsetting must keep GSUB-reachable ligature glyphs (ff, fi, fl), or words render with gaps.
8. Scroll-driven states need threshold sampling, not screenshots.
9. Keep the ledger, so intentional fixes are not reported as regressions.
10. Cloudflare: `bascik --build --target cloudflare`, then a wrapper that imports the default export of
    `dist/.bascik/cloudflare/worker.js` and calls its `fetch(request, env, ctx)`. The wrapper deploys with its own
    config named `wrangler.wrapper.jsonc`, not `wrangler.jsonc`: the build reads a root `wrangler.jsonc` into the
    generated config and warns that its `main` and `assets.directory` are ignored. That config points `main` at the
    wrapper, with `assets.directory` `dist/.bascik/cloudflare/public`, binding `ASSETS`,
    `not_found_handling: "404-page"` (or the site's 404.html is never served), and `run_worker_first: true` so static
    pages reach the wrapper too (at the cost of CDN bypass), plus the site's bindings and `vars`. Run and deploy from
    the root with `npx wrangler dev --config wrangler.wrapper.jsonc` and
    `npx wrangler deploy --config wrangler.wrapper.jsonc`; the starter's `npm run deploy` skips the wrapper. See
    `/deployment/cloudflare#composition-and-custom-worker-wrappers`.

## Reference configuration

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  assets: { inlineStyles: ["src/pages/css/styles.css"] },
  pipeline: {
    exec: [
      // Your vendor bundle step, once it exists: { script: "scripts/bundle-vendor.mjs", phase: "pre" },
      { script: "scripts/llms-txt.mjs", phase: "post" },
    ],
  },
  scripts: { cache: { exclude: ["src/pages/press/**"] } },
  generate: { manifest: true, cspHashes: true },
});
```

`http.precompress` only affects `bascik --server`; the Cloudflare target ignores it. Redirect-only pages get
`<meta name="bascik-sitemap" content="exclude">`. Dynamic routes use `data-bascik-routes`.

## Scripts

All are dependency-free `.mjs` files (Node.js 22.22+). Playwright and sharp come from your project (the starter has
`@playwright/test`; add `npm install -D sharp lighthouse`, then `npx playwright install chromium`); each script says
so when one is missing. Run any of them with `--help`.

| Script                       | What it does                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| `breakpoint-matrix.mjs`      | Thresholds from CSS, Sass and scripts, expanded into `breakpoints.json`  |
| `geometry-diff.mjs`          | collectNodes on both sides per matrix case, flagged by threshold; exit 1 |
| `compare-route.mjs`          | Pixels, geometry, evidence, interactions, `--accepted`; report and PNGs  |
| `lighthouse-gate.mjs`        | Five categories at 100 for a form factor and a URL list; exit 1          |
| `llms-txt.mjs`               | Post exec script: `dist/llms.txt` from built pages                       |
| `responsive-webp.mjs`        | WebP widths up to the source width, plus a sha256 manifest               |
| `worker-response-policy.mjs` | Worker wrapper: CSP hashes, X-Robots-Tag and Cache-Control per response  |
| `production-defects.mjs`     | Production's own bugs, logged as fixes before parity                     |
| `interaction-crawl.mjs`      | Activates every interactive element; compares effects (CDP listeners)    |
| `state-capture.mjs`          | Open dropdowns and disclosures: styles, icons, crops                     |
| `repeated-sections.mjs`      | Sections on 2+ routes must be one component, styled alike                |
| `text-style-diff.mjs`        | Text styles at rest, `:hover`, `:focus-visible` (CDP)                    |
| `spacing-diff.mjs`           | Vertical gaps inside each section, 2 px                                  |
| `alignment-diff.mjs`         | text-align, line count and offsets per width                             |
| `overlap-diff.mjs`           | Overlapping pairs within 1 px, pixel exact                               |
| `testid-carryover.mjs`       | Production and legacy test hooks on the same elements                    |
| `testid-coverage.mjs`        | `data-testid` on controls, landmarks, component roots                    |
| `presence-by-route.mjs`      | Banners, dialogs, sticky layers per route, fresh and dismissed           |
| `run-checks.mjs`             | All of the above per route; one report; exit 1 on any finding            |
| `review-page.mjs`            | Side-by-side review page, `--sign` and `--verify` for the human sign-off |
