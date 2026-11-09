# Migrating with Coding Agents

Enterprise websites built on React frameworks, such as Next.js with a component library like Ant Design, have been refactored to Bascik with coding agents. They went from Lighthouse scores in the 60s and 70s to 100 in all five categories (Performance, Accessibility, Best Practices, SEO and Agentic Browsing) on every page, mobile and desktop, while matching the live production site at every breakpoint.

Typical results on such a migration: Largest Contentful Paint drops from about 10 s to under 1.5 s on mobile, Total Blocking Time goes to 0 ms, Cumulative Layout Shift to 0.000, and page weight falls by more than 90 percent.

This page is the recipe. The skill, the prompt templates and the scripts are MIT licensed. Copy them and start today.

## What You Get

Everything ships in the opt-in `bascik-refactor` agent skill:

- [`references/production-parity.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/production-parity.md): the whole workflow, written for any coding agent.
- Seven prompt templates:
  - [`execution-contract.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/execution-contract.md): the rules every prompt reads first.
  - [`prompt-pack-index.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/prompt-pack-index.md): the numbered phases, with the representative slice gate.
  - [`one-route.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/one-route.md): migrate one route.
  - [`one-failure.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/one-failure.md): repair one failing check.
  - [`driver-agent.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/driver-agent.md): the agent that runs the queue behind a PASS gate.
  - [`decisions-ledger.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/decisions-ledger.md): every intentional difference from the old site.
  - [`visual-review.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/visual-review.md): an agent with image input that looks for differences side by side.
- Twenty-one scripts:
  - [`breakpoint-matrix.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/breakpoint-matrix.mjs): finds the legacy breakpoints and writes the viewport matrix.
  - [`capture-baselines.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/capture-baselines.mjs): records production alone, before any target page exists: a full-page screenshot, element geometry and every open state per route and matrix case.
  - [`geometry-diff.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/geometry-diff.mjs): compares element boxes between production and Bascik.
  - [`compare-route.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/compare-route.mjs): pixel diff, geometry, evidence and interaction traces per route.
  - [`lighthouse-gate.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/lighthouse-gate.mjs): fails unless every report is 100 in all five categories.
  - [`llms-txt.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/llms-txt.mjs): writes `llms.txt` after the build.
  - [`responsive-webp.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-images/scripts/responsive-webp.mjs): WebP variants and a manifest for `srcset`, from the default image skill. See [Optimizing Images](/how-to/optimizing-images) for the everyday workflow.
  - [`worker-response-policy.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/worker-response-policy.mjs): a Cloudflare Worker wrapper for a strict CSP, robots and cache headers.
  - [`run-checks.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/run-checks.mjs): runs every parity check below per route and matrix case, and exits 1 on any finding.
  - [`production-defects.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/production-defects.mjs): finds production's own layout bugs first, so the target fixes them instead of copying them.
  - [`interaction-crawl.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/interaction-crawl.mjs): activates every control on both sides and compares what each one does. It clicks production's buttons too. Their POSTs and other writes to production are refused, but a control that changes something with a GET (a vote link, an add-to-cart URL) or opens a WebSocket (start a chat) still reaches the live site, so pass controls with side effects with `--skip-control`.
  - [`state-capture.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/state-capture.mjs): opens every dropdown and disclosure and compares styles and icons.
  - [`repeated-sections.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/repeated-sections.mjs): requires one component for a section repeated across routes.
  - [`text-style-diff.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/text-style-diff.mjs): compares text styles at rest, on hover and on keyboard focus.
  - [`spacing-diff.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/spacing-diff.mjs): compares vertical gaps inside each section within 2 px.
  - [`alignment-diff.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/alignment-diff.mjs): compares text alignment and line count at every width.
  - [`overlap-diff.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/overlap-diff.mjs): checks overlapping elements, such as an icon on a dot, within 1 px.
  - [`testid-carryover.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/testid-carryover.mjs): keeps every existing test hook on the same element.
  - [`testid-coverage.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/testid-coverage.mjs): finds controls, landmarks and component roots without a `data-testid`.
  - [`presence-by-route.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/presence-by-route.mjs): compares banners, dialogs and sticky bars per route, fresh and after dismissal.
  - [`review-page.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/review-page.mjs): writes the side-by-side page a person signs off on, and checks the sign-off.

The scripts are plain Node.js modules with unit tests in the Bascik repository. None of them installs anything, and every one prints its options with `--help`.

## What You Need

1. A Bascik project on Node.js 24.21 or newer. `npm create bascik@rc` creates one with every agent skill except the opt-in `bascik-refactor` already in `.agents/skills/` and `.claude/skills/`. For an existing project, install the skills as [Agent Skills](/agent-skills) describes.
2. A read-only checkout of the legacy repository.
3. The live production URL.
4. sharp and Lighthouse 13.3 or later as dev dependencies, plus Playwright, which the starter already has. The scripts load them from your project, never from the skill.
5. A coding agent that can run shell commands. The workflow is agent-agnostic: any agent that reads Agent Skills, or any agent you paste the templates into, works.

One rule for the scripts: run the command-line tools from the skill folder, and copy the two that become part of your site (`llms-txt.mjs` for the build, `worker-response-policy.mjs` for the Worker) into `scripts/`. A skills update then never changes your build.

## Why Agent Migrations Usually Fail

1. **Screenshot guessing.** An agent recreates a page from a screenshot. It looks close at one width, and the spacing, fonts and breakpoints are wrong everywhere else, with invented CSS.
2. **Blind DOM copying.** An agent pastes the rendered framework output (grid wrapper divs, hydration data, generated class names) into the new project. The result is div soup, broken ARIA and dead CSS.

Both fail for the same reason: the agent has one source of truth where it needs three.

## The Three-Source Evidence Model

| Source                                    | What it answers                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Live production DOM, read with Playwright | Visual and geometric truth: `getBoundingClientRect()`, `getComputedStyle()`, pseudo-elements, image `currentSrc`               |
| The legacy repository, read-only          | Intent: why an element sits where it does, the breakpoint math (grid spans, offsets, Sass media queries), state, API contracts |
| The new Bascik repository                 | The clean implementation: HTML components, scoped CSS, small TypeScript islands                                                |

> **The golden rule.** Live production wins on geometry. The legacy source explains the responsive math. The Bascik repository owns clean, semantic HTML and CSS.

Production defects, such as low contrast, a missing focus outline or a blurry image, are recorded as observations and fixed. They are never copied. Each fix goes in the decisions ledger, described below.

## Set Up the Three Sources

1. Lay out the folders. The legacy checkout sits next to the new site, and every inventory lives in the new repository:

   ```text
   migration/
     legacy/              read-only checkout of the old site
     site/                the Bascik project
       docs/migration/    routes.json, breakpoints.json, interactions.json, decisions.md, ...
       artifacts/         screenshots and reports (in .gitignore)
   ```

2. Make the legacy checkout read-only, so no agent edits it by accident. Use a worktree of the commit that is live today, then remove write permission:

   ```sh
   git -C legacy-repo worktree add ../migration/legacy <live-commit>
   chmod -R a-w migration/legacy
   ```

3. Create the Bascik project without prompts, install the `bascik-refactor` skill (new projects do not include it), and add the dependencies. Use `--template cloudflare` instead if production will run on Cloudflare Workers:

   ```sh
   cd migration
   npm create bascik@rc site -y -- --template default --no-dev
   cd site
   npx skills add bascikdev/bascik --skill bascik-refactor -y
   npm install -D sharp lighthouse
   npx playwright install chromium
   mkdir -p docs/migration artifacts scripts
   echo "artifacts/" >> .gitignore
   ```

4. Name the origins and the skill folder once, so every prompt and script uses the same values, and copy the two site scripts. If your skills live in `.claude/skills/` or another folder, change `REFACTOR` and nothing else:

   ```sh
   export PROD_URL=https://www.example.com
   export TARGET_URL=http://localhost:8080
   export BASCIK_SITE_URL="$PROD_URL"
   export REFACTOR=.agents/skills/bascik-refactor/scripts
   cp "$REFACTOR/llms-txt.mjs" "$REFACTOR/worker-response-policy.mjs" scripts/
   ```

   `BASCIK_SITE_URL` is the public origin. The build needs it for the sitemap, `robots.txt` and canonical URLs.

5. Serve a production build. Every comparison and every Lighthouse run targets it, never the dev server, which skips minification and adds live reload. Run this in a second terminal:

   ```sh
   npx bascik --build && npx bascik --server
   ```

   It prints `Server running at http://localhost:8080`. If port 8080 is taken it stops with an error instead of picking another port: pass a free one with `--port` and put that URL in `TARGET_URL`. Rebuild after every change. On Cloudflare, use `npx wrangler dev --config wrangler.wrapper.jsonc` once the Worker wrapper below exists, and point `TARGET_URL` at the URL it prints.

## Record the Inventories First

Before any page is written, an agent records what exists, as JSON in `docs/migration/`. Commit these files. Every later prompt reads them, and every gate checks against them.

`routes.json` lists every reachable route, redirect, PDF and API endpoint:

```json
{
  "routes": [
    {
      "path": "/pricing",
      "legacy": "pages/pricing.tsx",
      "target": "src/pages/pricing.html"
    }
  ],
  "redirects": [{ "from": "/plans", "to": "/pricing", "status": 301 }],
  "files": ["/press/media-kit.pdf"],
  "api": [{ "path": "/api/contact", "method": "POST" }]
}
```

`urls.txt` is the list the Lighthouse gate checks, one target URL per line. Generate it from `routes.json`:

```sh
node -e 'const { routes } = JSON.parse(require("fs").readFileSync("docs/migration/routes.json", "utf8"));
for (const r of routes) console.log(process.env.TARGET_URL + r.path);' > docs/migration/urls.txt
```

`interactions.json` lists every interactive surface with its legacy owner. Each step finds its trigger by test id, role and name (`"role": "button", "roleName": "Next review"`) or selector, adds `"nth"` when several match, and states what must be true afterward. `node "$REFACTOR/compare-route.mjs" --help` documents every field:

```json
[
  {
    "name": "open the mobile menu",
    "route": "/",
    "testId": "menu-trigger",
    "panel": { "testId": "menu-panel" },
    "action": "click",
    "expect": { "ariaExpanded": true, "visible": true },
    "maxWidth": 1023,
    "legacy": "components/Header/MobileMenu.tsx"
  }
]
```

`integrations.json` lists every third-party script with its network and cookie contract (`name`, `loads`, `origins`, `cookies`, `pages`), so nothing disappears silently.

### Inventory Production Before Any Page Exists

There is no target yet, so the inventory scripts run on production alone: leave out `--target`. Never point `--target` at production instead; the scripts refuse it, because it would load the live site twice at once. Each one writes production's side to `artifacts/checks/` and exits 0, and stores it in the production cache under its own check's key. Only those checks reuse it: the first `run-checks.mjs` of a route reads production-defects, interaction-crawl and state-capture from the cache when it passes the same `--mask`, `--skip-control` and `--settle-ms`, and presence-by-route only when it also passes the same `--route` values in the same order (its key holds the whole route list, so an inventory of every route does not match a `--route /contact` run). The other checks (repeated-sections, text-style-diff, spacing-diff, alignment-diff, overlap-diff, testid-carryover and testid-coverage) still load production on that first run, and from the cache after it.

```sh
node "$REFACTOR/interaction-crawl.mjs" --prod "$PROD_URL" --route / --route /pricing --discover
node "$REFACTOR/presence-by-route.mjs" --prod "$PROD_URL" --route / --route /pricing
node "$REFACTOR/state-capture.mjs" --prod "$PROD_URL" --route / --route /pricing
```

`--discover` turns the crawl into a first draft of `interactions.json` at `docs/migration/interactions.draft.json`: one step per control that did something, found by test id, role and name, or selector, with what production did in `"observed"`. The file and every step say `"draft": true`, and `compare-route.mjs` refuses a draft. Review each step (add the panel it opens, fix `expect`, drop noise, add what a crawl cannot do, such as typing in a search box), remove every `"draft"`, and save the steps as `docs/migration/interactions.json`.

### Production Baselines

A baseline is what production looks like at one route and matrix case, recorded before the target exists. `capture-baselines.mjs` records them one page at a time, with the same settings every check uses:

```sh
node "$REFACTOR/capture-baselines.mjs" --prod "$PROD_URL" --route / --route /pricing --states
```

For every route and case it writes `artifacts/baselines/<route>/<case>.png` (the full page), `<case>.nodes.json` (the box of every visible heading, paragraph, button and link, the geometry `geometry-diff.mjs` compares) and, with `--states`, a crop of every dropdown, drawer and accordion opened. `artifacts/baselines/index.json` lists them by id. A baseline id is `<route>@<case>`, with the case id `--cases` takes: `/pricing@360x812`, or `/@1408x900-dark` for a dark color scheme case. An open state adds `#<label>`, such as `/@360x812#BUTTON:Menu`. The one-route prompt names its baselines by id in `{{BASELINE_IDS}}`. With `--states`, the open states land in the production cache under `state-capture.mjs`'s own key, so the first `run-checks.mjs` with the same `--mask`, `--skip-control` and `--settle-ms` reads them instead of opening production's menus again.

The example site on this page is a generic marketing site: a header with a mobile drawer, a hero, a review carousel, a pricing slider, a contact form and a press list.

## The Breakpoint Matrix

Most visual bugs live between breakpoints, so the matrix is built from the legacy site's real thresholds, not from a list of popular devices.

1. Find every width threshold: CSS, Sass and Less media queries, breakpoint variables and theme tokens, `matchMedia()` and `useMediaQuery()` queries, `innerWidth` checks and responsive image `sizes`.
2. For every threshold B, test B - 1, B, and B + 1 CSS pixels.
3. Add one width inside every interval, plus the narrowest and widest supported widths.
4. Pair every width with a height. Width and height are one case, because sticky headers and `vh` units depend on both. For viewport-sized sections, include short portrait and landscape heights as well as tall screens. Add any reported failing pair and nearby pairs to the canonical matrix before acceptance.
5. Add hover, orientation and reduced-motion cases where the site uses them.
6. Sample scroll-driven states (a header that shrinks after a scroll threshold) at the threshold minus 1 and plus 1, scrolling down and back up.

The script scans the legacy source for step 1 and does steps 2 to 4. A component library keeps its grid breakpoints in its own package, which the script does not read. Save the compiled stylesheets production loads into `artifacts/prod-css/` and pass them too, or list the library's documented breakpoints with `--add`:

```sh
node "$REFACTOR/breakpoint-matrix.mjs" \
  --css '../legacy/src/**/*.{scss,css,less}' '../legacy/src/**/*.{ts,tsx,js,jsx}' \
  'artifacts/prod-css/*.css' --add 576,768,992,1200,1600 \
  --min 320 --max 1920 --out docs/migration/breakpoints.json
```

It writes `{ thresholds, sources, cases }`, where `sources` names the file each threshold came from. Expect a few dozen cases. Review them, then add the hover, orientation and reduced-motion cases by hand: a case may set `hasTouch`, `isMobile`, `colorScheme` or `reducedMotion`.

## The Per-Route Loop

One route at a time, one section at a time:

1. **Capture both sides with identical settings.** Same width and height, browser version, device scale factor 1, zoom, color scheme, reduced motion, scroll position and cookie notice state. Wait for `document.fonts.ready`, scroll the page through and back (lazy images load and scroll-triggered fade-ins run), wait for complete images and finished animations, then wait 5 seconds after navigation (`--settle-ms`) and for the DOM to go quiet. Every script, `compare-route.mjs` and `geometry-diff.mjs` included, does this the same way. Keep production read-only: every script blocks service workers and the common analytics hosts on both sides and refuses any request other than GET or HEAD that does not go to the target (see [Keep Production Read-Only](#keep-production-read-only)).
2. **Find the owning production subtree from stable anchors.** Use visible heading text, `href`, `src`, `alt`, landmarks and test ids, never generated class names. Climb to the smallest ancestor that owns one coherent section, and stop there.
3. **Extract structure, geometry and computed styles.** Use a fixed property list: display, position, box sizing, sizes, margins, paddings, gap, alignment, overflow, colors, backgrounds, border, radius, shadow, font family, size and weight, line height, letter spacing, text alignment, white-space, transform and z-index. Add `::before` and `::after`, child order, line counts, image `currentSrc`, intrinsic size and `object-fit`.
4. **Read the legacy owner of that subtree only.** Translate the resolved behavior. Do not copy React or Sass wholesale.
5. **Choose Bascik boundaries.** The route page owns page-level composition and order. Extract a component when a surface repeats, has its own behavior or responsive layout, or has a small prop and slot contract. Never wrap a whole page in one component.
6. **Write CSS from measured relationships.** Use container widths, padding, grid tracks and aspect ratios, not pixel nudges. The demo below shows one.
7. **Validate right away.** Build, type check, reload, measure the same boxes again, compare a screenshot and run the section's interaction test. Fix the section before starting the next one.
8. **Compare the route in three layers.** Pixels (with only documented dynamic regions masked), geometry, and content and style (text, font metrics, colors, image source and crop, link targets).
9. **Record decisions.** Every intentional difference goes in the decisions ledger with its evidence.

### Collapse Framework Grid Wrappers into One Section

A component library's grid renders wrappers. Here, a press list sits in a 24-column row, in a column that spans 20 and is offset by 2, inside a 1200 px container. The framework rendered several nested divs before the first heading.

Measure the result instead of copying the wrappers. Span 20 with offset 2 leaves one twelfth of the container's width on each side. In Bascik that is one section with `width: min(100%, 1200px)`, `margin: 0 auto` and the offset as padding. The rendered framework DOM looked like this; the box below shows the Bascik component, and its Output was generated by the real compiler.

<!-- demo:migration-grid-legacy -->

```html
<div class="ant-row css-1x2y3z">
  <div class="ant-col ant-col-20 ant-col-offset-2 css-1x2y3z">
    <div class="ant-row css-1x2y3z">
      <div class="ant-col ant-col-24 css-1x2y3z">
        <h2 class="css-4d5e6f">In the press</h2>
        <ul class="css-7g8h9i">
          <li class="css-0j1k2l">Example Daily: A faster site in a week</li>
          <li class="css-0j1k2l">Web Weekly: Plans for every team</li>
          <li class="css-0j1k2l">Tech Notes: Lighthouse 100 everywhere</li>
        </ul>
      </div>
    </div>
  </div>
</div>
```

<!-- demo:migration-grid-usage -->

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Press</title>
  </head>
  <body>
    <press-list />
  </body>
</html>
```

<!-- demo:migration-grid-source-html -->

```html
<!-- src/components/press-list/press-list.html -->
<section data-testid="press-list">
  <h2>In the press</h2>
  <ul>
    <li>Example Daily: A faster site in a week</li>
    <li>Web Weekly: Plans for every team</li>
    <li>Tech Notes: Lighthouse 100 everywhere</li>
  </ul>
</section>
```

<!-- demo:migration-grid-source-css -->

```css
/* src/components/press-list/press-list.css */
section {
  box-sizing: border-box;
  width: min(100%, 1200px);
  margin: 0 auto;
  /* Offset 2 of 24 columns on each side: one twelfth of the section's width. */
  padding: 32px calc(min(100%, 1200px) / 12);
}

h2 {
  margin: 0 0 16px;
  font-size: 1.5rem;
}

ul {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  padding: 16px;
  border: 1px solid currentColor;
  border-radius: 8px;
}
```

<!-- demo:migration-grid-output-html -->

```html
<section class="b_el_press-list_section" data-testid="press-list">
  <h2 class="b_el_press-list_h2">In the press</h2>
  <ul class="b_el_press-list_ul">
    <li class="b_el_press-list_li">Example Daily: A faster site in a week</li>
    <li class="b_el_press-list_li">Web Weekly: Plans for every team</li>
    <li class="b_el_press-list_li">Tech Notes: Lighthouse 100 everywhere</li>
  </ul>
</section>
```

<!-- demo:migration-grid-output-css -->

```css
.b_el_press-list_section {
  box-sizing: border-box;
  width: min(100%, 1200px);
  margin: 0 auto;

  padding: 32px calc(min(100%, 1200px) / 12);
}

.b_el_press-list_h2 {
  margin: 0 0 16px;
  font-size: 1.5rem;
}

.b_el_press-list_ul {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.b_el_press-list_li {
  padding: 16px;
  border: 1px solid currentColor;
  border-radius: 8px;
}
```

### The Geometry Diff

The geometry diff finds the bugs that eyes miss. Open production and the Bascik target in two tabs at each matrix width, and compare every visible heading, paragraph, button and link, matched by tag plus normalized text:

```js
function collectNodes(doc = document, view = window) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const map = new Map();
  for (const el of doc.querySelectorAll("h1, h2, h3, h4, p, button, a")) {
    const cs = view.getComputedStyle(el);
    if (
      cs.display === "none" ||
      cs.visibility === "hidden" ||
      cs.opacity === "0"
    )
      continue;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) continue;
    const text = norm(el.textContent || "");
    if (!text) continue;
    const key = `${el.tagName}:${text.slice(0, 70)}`;
    if (!map.has(key))
      map.set(key, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
  }
  return Object.fromEntries(map);
}
```

Flag a node when `|dx| > 6`, `|dy| > 12` or `|dw| > 12` CSS pixels, or when it exists on one side only. Three kinds of bugs it catches:

- **Cumulative drift.** A framework that wraps each table cell in a paragraph with a bottom margin adds a little per row, and hundreds of pixels by the end of a long table.
- **A doubled offset.** A hero offset applied twice, as a relative `top` from one media query and a `margin-top` from another.
- **Off-center containers at in-between widths.** A container that is centered at every device width and drifts at the widths between them.

Run it over the whole matrix:

```sh
node "$REFACTOR/geometry-diff.mjs" \
  --prod "$PROD_URL" --target "$TARGET_URL" \
  --route / --route /pricing \
  --matrix docs/migration/breakpoints.json --out artifacts/geometry
```

It waits like the checks before it reads the boxes (`--settle-ms`, then a quiet DOM), so a caption that types itself out is finished on both sides. Pass `--mask` for a documented dynamic region, such as a rotating carousel: its nodes are left out on both sides. It exits with code 1 when anything is flagged, so an agent can use it as an acceptance check.

### Route Comparison

`compare-route.mjs` runs all three layers for each route and matrix case. It captures both sides with identical settings, counts differing pixels with a per-channel tolerance, runs the geometry diff, records evidence (font load status, element boxes and computed styles, image `currentSrc`) and replays `interactions.json` on both sides:

```sh
node "$REFACTOR/compare-route.mjs" \
  --prod "$PROD_URL" --target "$TARGET_URL" \
  --route / --route /pricing \
  --matrix docs/migration/breakpoints.json \
  --interactions docs/migration/interactions.json \
  --accepted docs/migration/accepted.json \
  --mask '[data-testid="review-carousel"]' --out artifacts/compare
```

Each route gets `report.json` and a pair of PNGs per case under `artifacts/compare/`. A case fails when more than 0.1 percent of its pixels differ (`--max-ratio`), when the geometry diff flags a node, or when an interaction ends in a different state on the two sides. A missing or ambiguous trigger fails at once and names its locator and case.

`compare-route.mjs` captures each side the way the parity checks do: it scrolls the page through and back, so a lazy photo far below the fold is drawn and a section that fades in on scroll is visible on both sides, then waits until 5 seconds after navigation and for the DOM to go quiet, so a banner mounted after hydration or a caption that types itself out is finished. Pass `--settle-ms` with a longer time for a later timer, or 0 for a site with none.

Mask only documented dynamic regions, such as a rotating review carousel; the quiet wait ignores changes inside a mask. No route passes on one screenshot, and no route passes on a Lighthouse score.

### Parity Checks

Pixels and boxes miss what a reviewer notices first: a button that does nothing, a menu that opens unstyled, a link in the wrong weight. `run-checks.mjs` runs one check per issue type on every route and matrix case, after `production-defects.mjs` has logged what production itself gets wrong. Each check matches elements by test id, role, name or text, never by class. Text is what a reader sees (a menu hidden in the markup adds nothing, text in a `display: contents` wrapper counts), cut after the same number of visible characters on both sides and compared with all whitespace removed, so React's markup and the same page formatted by Prettier match; keep the source formatted. A check that crashes is a finding. A browser that closes mid-run (killed, out of memory) is relaunched for the retry and the checks after it, so one crash does not fail the rest of the run:

```sh
node "$REFACTOR/production-defects.mjs" --prod "$PROD_URL" --route / --route /pricing
node "$REFACTOR/run-checks.mjs" \
  --prod "$PROD_URL" --target "$TARGET_URL" \
  --route / --route /pricing \
  --legacy-src ../legacy --target-src . \
  --mask '[data-testid="review-carousel"]'
```

Each route gets `artifacts/checks/<route>/report.json`. A finding on an element production gets wrong, at the width where it is wrong, is listed as corrected instead of failing, because the ledger row says "production defect: fix in target". `production-defects.mjs` measures each page with its animations finished, and leaves out what a visitor never sees as broken: glyphs a few pixels past a tight `line-height` with overflow visible, visually hidden `sr-only` text, the turned-away face of a flip card, the back cards of a stacked deck under the front card's opaque background, an icon above its heading at every width, and overflow that comes only from a `--mask` region. `node "$REFACTOR/run-checks.mjs" --help` lists every check and its tolerance. Every check leaves out the `--mask` regions, so mask a carousel that advances on a timer, an autoplay video, a ticker that rotates its text or a relative time such as "5 minutes ago", and log each mask in the ledger. Mask the element itself, such as the `<video>` and not the hero around it: what is drawn over a masked region, such as the headline, is still compared. Do not mask a newsletter modal or a banner that opens on a timer. Every page waits 5 seconds after it starts loading before it is measured, so such a layer is on both sides; pass `--settle-ms` with a longer time for a later timer. Expect about two minutes per route per width on the first run; skipping a check to save time skips what it would catch.

### Finding Responsive Defects

Parity is not proof that a site works. A screenshot can match production, the page can have no sideways scroll and Lighthouse can score 100 while a headline is covered by a fixed header or a button spills out of its hero. The automated production-defect scan is a starting point, not an exhaustive visual review.

1. **Reproduce the visitor's case on production.** Use the exact CSS viewport width and height, scroll position and open state. Wait for fonts and images with the capture settings above, and save the screenshot and case id. A problem that only appears on the target is a migration regression, not a legacy defect.
2. **Measure relationships, not just page width.** With Playwright locators and `getBoundingClientRect()` through `locator.evaluate()`, record the section, text, CTA, image/background container and fixed/sticky header bounds. Inspect computed height, min/max-height, font size, line height, padding, gap, flex alignment, wrapping, overflow and positioning. Use text range bounds when element boxes do not explain clipped glyphs. Inspect ancestor clipping and painted layers too: an intact text box can still sit behind the header. Zero sideways scroll does not rule out vertical overflow.
3. **Trace the cause to the owning CSS.** A fixed `80vh` hero with large wrapping text, centered flex content and a large text-to-button gap can be shorter than its contents. Centering then pushes the heading above the hero and the button below it. Compare the available height with the content, padding and gaps before changing offsets.
4. **Repair the constraint without redesigning the site.** Let content determine the required height, use a viewport-based minimum where appropriate, make the background cover the resulting section, scale phone typography and spacing without sacrificing readability, and wrap CTA rows. Preserve unaffected desktop geometry. Do not hide overflow, truncate copy, transform-scale the section, absolutely position the CTA or add JavaScript resizing to conceal a CSS defect. Intentional overlays and decorative overlaps are not automatically bugs.
5. **Prove the fix with a regression test and visual review.** Add a focused Playwright test before editing and demonstrate that it fails. After the fix, assert that the visible heading clears the header, text and buttons stay within their intended section with its padding, the CTA follows the text with the intended gap, and there is no sideways scroll. Derive padding and gap expectations from the design and allow only a small stated rounding tolerance. Cover the failing pair, short and tall phones, landscape, breakpoint edges and unchanged desktop cases on every route using the component. Wait for fonts and images and test the production build. Inspect screenshots too: boxes alone cannot prove content is unobscured.

Record the measured cause, corrected expectation, before/after evidence and affected routes and width-height cases in the decisions ledger. Expand the canonical breakpoint matrix before the full acceptance run. Recognized `PD-` defects use the automatic correction handling above. A manually found defect that the scripts do not recognize needs a normal narrow `accepted.json` pixel-difference entry, a ledger row, inspection of remaining geometry/style findings, and visual and human review. Do not invent a `PD-` id, assume a ledger row alone exempts the change from checks, or broadly mask a hero to hide its broken headline.

The review page reads the `compare-route.mjs` and `run-checks.mjs` reports, so run both first. The sign-off records which screenshots and findings it covers:

```sh
node "$REFACTOR/review-page.mjs" --route / --route /pricing
# Run by the person who reviewed the page, or use the form on it:
node "$REFACTOR/review-page.mjs" --sign --route / --reviewer "Your name" --verdict pass
node "$REFACTOR/review-page.mjs" --verify --route / --route /pricing
```

`--verify` fails while `run-checks.mjs` reports findings for a route, and after any change to the target's screenshots or findings since its sign-off. `--sign` and `--verify` also refuse a partial report (a subset of the cases, a run that left out a check with `--only` or `--skip`, or another matrix file), and a report whose matrix differs from `docs/migration/breakpoints.json` as it is now. They refuse a report that used cached production measurements more than a day old, or that records none; `--max-prod-age 7d` (or `12h`, `30m`) moves that limit.

### Iteration Runs and the Gate

A full run over a 25-case matrix takes 20 to 50 minutes per route, too slow to repeat after every fix. Two things make the loop fast without lowering the bar for done.

Production is measured once. Every check keeps what it measured on production in `artifacts/prod-cache/`, and the next run loads only the target. The cache key holds everything that changes what production measures: the check, the skill's scripts, the browser version, the production origin, the route, the full matrix case, `--settle-ms`, the `--mask` and `--skip-control` selectors, and the block list; presence-by-route also keys on every route in order and on its `--dismiss` selectors, which no other check uses. A changed mask is a cache miss, never a stale result. Each run prints how many measurements came from the cache and how old the oldest one is. Pass `--refresh-prod` after production changes and at the start of every check stage and review round; `--prod-cache <dir>` moves the cache and `--no-prod-cache` turns it off.

While a route is being built, run a few cases and the checks the last fix can affect:

```sh
node "$REFACTOR/run-checks.mjs" \
  --prod "$PROD_URL" --target "$TARGET_URL" --route /pricing \
  --legacy-src ../legacy --target-src . \
  --cases 360x812,768,1280x900 --only spacing-diff,alignment-diff
```

A case id is `<width>x<height>`, with a suffix for each variant (`1408x900-dark`, `390x844-mobile-touch`), and a bare width selects every case of that width. An id the matrix does not have fails and lists the valid ones. Pick one phone, one tablet and one desktop case, plus the cases on both sides of every breakpoint the route's own CSS or JS reacts to.

Such a run prints `PARTIAL (3 of 25 cases; 2 of 11 checks, without ...): iteration result, not a gate`, and its report records `partial: true` with the checks that ran and the ones left out. A run of every case that leaves out one check is partial too, as is a run of any matrix file other than `docs/migration/breakpoints.json`. The gate is the full `docs/migration/breakpoints.json` matrix with every check. Run it once at the end of each route, and in every check and review round: "done" is decided only there. A site with no legacy repository passes `--no-legacy-repo` instead of `--legacy-src`; the report records why the test hook carryover check did not run, and the run can still be the gate.

The cache trades freshness for speed: a cached measurement shows production as it was when it was taken. A gate run reads the cache like any other, so sign-off refuses a report built from cached production more than a day old. Pass `--refresh-prod` on the gate run when the cache is older, and raise `--max-prod-age` only for a production site you know has not changed.

### Keep Production Read-Only

Every page load is a page view on the live site. The checks load production once per route, matrix case and check, and the crawl reloads it once per control, so one route run would put hundreds of synthetic visits in the owner's analytics. Every script that loads production (each check, `run-checks.mjs`, `capture-baselines.mjs`, `compare-route.mjs` and `geometry-diff.mjs`) applies the same rules in the browser, on both sides:

- **Analytics and tracking requests are blocked.** The default list covers Google Tag Manager, Analytics and ads, Vercel insights, Plausible, Segment, Hotjar, the Facebook pixel, Clarity and Cloudflare insights. Add a site's own tracker with `--block` (repeatable): a host such as `stats.example.net` also blocks its subdomains, and a value with a `/` such as `*/api/track` matches anywhere in the URL, with `*` as a wildcard. A pattern that matches `--prod` or `--target` itself is refused. `--no-default-block` drops the list when the page needs one of those hosts; log that in the ledger. The target blocks the same requests, so a tag that adds markup is missing on both sides, never on one.
- **No write leaves for production or a third party.** A form post, a beacon or an API write (any request other than GET or HEAD) is refused unless it goes to the target's own origin; with no `--target`, every one is refused.
- **Service workers are blocked.** A page's requests all go through these rules, and a worker cannot answer a reload from its cache.
- **A GET with a side effect and WebSocket traffic still get through.** A vote or unsubscribe link, a view counter, a tracker on a host not on the list, or a chat widget's socket reaches the live site. Block such a host with `--block`, and keep the controls that start them out of the crawl with `--skip-control`.
- **`--min-interval-ms` spaces production page loads.** The default is 0. Pass 1000 or more for a site you do not run or one behind a rate limit.

```sh
node "$REFACTOR/run-checks.mjs" --prod "$PROD_URL" --target "$TARGET_URL" --route / --legacy-src ../legacy \
  --block stats.example.net --min-interval-ms 1000
```

Each run prints what it blocked. The block list is part of the production cache key; the interval is not.

### Why a Human Signs Off Every Route

In a real agent-driven refactor, the automated loop passed pages that a person then caught side by side with production. The scripts had compared absolute geometry with loose thresholds, and the agents read "no flags" as a pass. What the person caught:

1. Missing interactions: a hero button that should scroll to its section did nothing.
2. Dropdown menus with the wrong style and missing icons.
3. A repeated section pasted per page instead of one component, one copy styled wrong.
4. Links with the wrong color or the wrong font weight.
5. Vertical spacing between elements off by tens of pixels.
6. Text misaligned at certain breakpoints only.
7. An icon overlapping a timeline circle, a little off.

Every one now has a check, and the checks still do not decide alone. `review-page.mjs` writes `artifacts/review/<route>.html` with production and Bascik side by side at every width, a difference overlay, the open menus, and the findings. A visual reviewer agent with image input reads it first, and its only job is to find differences. Then a person reviews the page and signs `docs/migration/review/<route>.json` with a pass or issues verdict. The driver marks a route PASS only when `review-page.mjs --verify` accepts that file.

## Interaction Parity

Visual parity is half the job. The floor for every site:

- Hover never replaces the keyboard focus indicator.
- A desktop dropdown opens from its trigger, and closes when another opens, on an outside click, on Escape and when focus leaves it.
- A mobile drawer keeps an accurate `aria-expanded`, and closes by its control, an outside click, a link activation and Escape.
- Nested disclosures inside the drawer behave the same way.
- The review carousel moves with its next and previous buttons and announces the change.
- The pricing slider changes with the keyboard and the pointer.
- The cookie notice state is the same on both sides before every capture.

Record every state with its trigger, precondition, action, result, focused element and a before and after screenshot. `compare-route.mjs` records `aria-expanded`, visibility and focus before and after each step, on both sides.

Write the end-to-end tests with roles, text or `data-testid`, never component classes. A production build hashes class and id names (`minify.identifiers`), while `data-testid` survives. See [E2E Testing](/testing/e2e-testing).

## Organize the Agents

A migration is a queue of small prompts that each end in a checkable state. These are the pieces.

### The Execution Contract

Every prompt reads the [execution contract](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/execution-contract.md) first. It holds:

1. **Locations and environment.** The live URL, the read-only legacy repository, the target repository, and the `PROD_URL`, `TARGET_URL`, `BASCIK_SITE_URL` and `REFACTOR` values.
2. **Non-negotiables.** Match production. 100 in all five Lighthouse categories on every page. Clean Bascik and TypeScript. No framework runtime carried over.
3. **No Lighthouse gaming.** No audit detection, no vendor-free mode for audits, no hidden content and no timers that outlast the audit.
4. **Safety.** Browse production read-only. Never submit a real form or send synthetic analytics: the scripts block analytics hosts, and `--block` and `--min-interval-ms` cover the rest. No secrets in files.
5. **Working method.** Inspect, make the smallest change, run a focused check, format, hand off.
6. **Handoff.** Status, revisions, changed files, the exact commands and their results, and what is not verified.

### The Prompt Pack

Number the prompts and keep them in the repository, grouped into phases. The [prompt pack index](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/prompt-pack-index.md) is the template:

1. Record the real site: inventories and baselines, on production alone (`capture-baselines.mjs`, and the crawl without `--target`).
2. Local runtime: bootstrap, config boundaries, Worker packaging, redirects, headers, the test harness and the Lighthouse runner.
3. The shared shell and the home page.
4. Forms.
5. Integrations.
6. **The representative slice gate.** Prove 100 in all five categories on a few representative pages before scaling out.
7. The remaining page families.
8. The whole-site visual gate.
9. Optimization and audits.
10. Handoff.

### One Route, One Failure

Two templates cover most of the queue:

- [`one-route.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/one-route.md) migrates one route. Its placeholders: `{{ROUTE}}`, `{{LEGACY_ENTRY}}`, `{{TARGET_PAGE}}`, `{{BASELINE_IDS}}`, `{{REQUIRED_COMPONENTS}}`, `{{INTERACTIONS}}`, `{{PARENT_PROMPT}}` and `{{CHILD_ID}}`, plus `{{LEGACY_REPO}}` from the execution contract.
- [`one-failure.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/one-failure.md) repairs one failing check. Its placeholders: `{{FAILURE_ID}}`, `{{EVIDENCE}}`, `{{MATRIX_CASE}}`, `{{OWNER_FILES}}` and `{{ACCEPTANCE}}`.

Both end in acceptance checks that run the scripts on this page. The one-route checks collect fresh Lighthouse reports for their own route, so a stale report never passes.

### The Driver and the PASS Gate

A [driver agent](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/driver-agent.md) works through the queue. Its one rule: never advance to the next prompt until every acceptance check passes on the final files, a visual review finds no differences, and a person has signed a pass verdict for the route. No findings from the scripts is not a PASS on its own. It keeps fixing application-owned failures itself, writing a one-failure prompt for each.

### Swarm with Disjoint Ownership

1. Build the shared shell (head, header, footer, global CSS) sequentially, and lock it with tests.
2. Then run several agents in parallel, each owning a strictly disjoint set of page families. No two agents edit the same file. Start with a few and add more once merges stay clean.
3. Split cross-cutting sweeps (converting every raster image to responsive WebP, removing redundant class prefixes) into folder buckets, one agent per bucket.
4. Finish with one build, check and test gate over the whole site.

### Escalate Framework Issues

When Bascik itself seems to block, the driver does not hack around it. It writes a self-contained issue with:

1. The question or defect.
2. The environment: Bascik, Node.js and browser versions.
3. A minimal reproduction.
4. What was investigated.
5. A proposed resolution.
6. A regression test plan.
7. Boundaries: what the fix must not change.

The queue holds until the issue is resolved. Fix it upstream: open it on [Bascik's GitHub issues](https://github.com/bascikdev/bascik/issues).

### The Differences-and-Decisions Ledger

Keep [`decisions-ledger.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/decisions-ledger.md) in `docs/migration/decisions.md`. Each row records one intentional difference from the legacy site: the route, the matrix case, the legacy behavior, the new behavior, the reason, the evidence and who approved it. Agents and reviewers read it before calling anything a regression.

The scripts do not read the ledger. When a row changes pixels, such as a footer recolored for contrast, add a matching entry to `docs/migration/accepted.json`, named by the row id and as narrow as the difference:

```json
[{ "id": "D-01", "route": "/", "mask": ["footer"] }]
```

`compare-route.mjs --accepted` masks those elements (or applies a `maxRatio` budget) only for matching routes and widths, and lists the ids it applied in the report. Never raise `--max-ratio` for the whole run to make one difference pass.

`production-defects.mjs` writes one `PD-` row per element and kind, with its routes and width range. When a reviewer finds a row is not a defect, such as a logotype whose glyphs pass a tight `line-height` with nothing cut off, reject it rather than change the design: add a ledger row saying why and an entry that lists the `PD-` id, which `production-defects.mjs` and `run-checks.mjs` read (by default from `docs/migration/accepted.json`, or `--accepted`). A rejected defect is neither a fix target nor a `copied-defect`. `--reject PD-1a2b3c` does the same for one run while you iterate; `review-page.mjs` refuses to sign or verify a run that used it, or an entry whose id has no ledger row, and the route report and review page list every rejected defect with its source. An id is the kind and the element's text, so elements with the same text and kind, such as a `BUTTON:Learn more` on two routes, share it: the run warns when a rejected id covers more than one element, so check each one. Later runs keep the script's rows current, adding routes, widths and selectors, and remove its older one-row-per-width rows that nobody approved.

```json
[
  {
    "id": "D-07",
    "defect": ["PD-1a2b3c"],
    "reason": "a logotype, nothing is cut off"
  }
]
```

## The Score Playbook to 5 x 100

### Largest Contentful Paint

1. Remove hero fade and zoom animations that start at `opacity: 0`. Chromium does not record an LCP candidate while an element is transparent.
2. Serve responsive WebP with `srcset`. `responsive-webp.mjs` writes the variants, and a manifest with each file's URL:

   ```sh
   node .agents/skills/bascik-images/scripts/responsive-webp.mjs \
     --src ../legacy/public/hero.png --out src/pages/img \
     --manifest src/lib/images.json --quality 80
   ```

3. Map each route to its hero in `src/lib/heroes.ts`. Build scripts read data paths from the project root:

   ```ts
   // src/lib/heroes.ts
   import { readFileSync } from "node:fs";

   type Entry = { width: number; url: string };
   const images: Record<string, Entry[]> = JSON.parse(
     readFileSync("src/lib/images.json", "utf8"),
   ).images;

   // Route -> source file name, as responsive-webp.mjs keyed it.
   const HEROES: Record<string, string> = { "/": "hero.png" };

   export function heroFor(pagePath = "/") {
     const entries = images[HEROES[pagePath] ?? ""];
     if (!entries) return undefined;
     const srcset = [...entries]
       .sort((a, b) => a.width - b.width)
       .map((e) => `${e.url} ${e.width}w`)
       .join(", ");
     return { src: entries.at(-1)!.url, srcset };
   }
   ```

4. Preload the route's LCP image from a `data-bascik-build` script. It reads `BASCIK_PAGE_PATH`, so each page preloads its own hero:

   ```html
   <script data-bascik-build>
     import { html } from "@bascik/bascik/html";
     import { heroFor } from "@/lib/heroes.ts";
     export default () => {
       const hero = heroFor(process.env.BASCIK_PAGE_PATH);
       return hero
         ? html`<link
             rel="preload"
             as="image"
             fetchpriority="high"
             imagesrcset="${hero.srcset}"
             imagesizes="100vw"
           />`
         : "";
     };
   </script>
   ```

   Use `data-bascik-build`, not `data-bascik-build-once`: build-once scripts get no page context. See [Environment Variables](/environment-variables).

5. Lazy-load every image below the fold with `loading="lazy"` and explicit `width` and `height`. [Performance](/lighthouse/performance) covers each technique in detail.

### Render Blocking and CLS

1. Inline the global stylesheet with `assets.inlineStyles: ["src/pages/css/styles.css"]`.
2. Self-host subsetted fonts, preload them, and give the fallback font matched metrics (`ascent-override`, `descent-override`, `size-adjust`) so the swap moves nothing.

### Total Blocking Time

1. Ship no framework runtime. Bascik pages are HTML with small scoped scripts.
2. Bundle vendor code at build time with a `pre` exec script, code-split it, and load it late or only on the pages that need it. See [Bundling npm Packages](/how-to/bundling-npm-packages).
3. Prefetch likely next pages on hover intent after load. See [Prefetching the Next Page](/lighthouse/performance#prefetching-the-next-page).

### Best Practices

Serve a strict Content Security Policy with a SHA-256 hash for every inline script and style and no `unsafe-inline`. `generate.cspHashes` writes the hashes per page to `.bascik/dist/csp-hashes.json`. Setting `contentSecurityPolicy` sends the header with those hashes on `bascik --server` and on Cloudflare, and [Content Security Policy](/how-to/content-security-policy) also shows a meta tag approach for static hosts. When you also need robots and cache headers on Cloudflare, `worker-response-policy.mjs` sends each route's hashes from that file in a Worker wrapper. The hashes are known before the body, so streamed pages keep streaming.

### Agentic Browsing

Lighthouse scores this category as a pass ratio, so 100 means every applicable audit passes:

1. A clean accessibility tree: a role and an accessible name for every control.
2. CLS 0.
3. An `llms.txt` with an H1. `scripts/llms-txt.mjs` writes one after the build: register it in `pipeline.exec` with `phase: "post"`. It skips noindex and error pages and prefers each page's canonical URL. For a smaller version without sections, run `add-example.mjs starter-site/scripts/llms-txt.ts` from the `bascik` skill.

See [Agentic Browsing](/lighthouse/agentic-browsing).

### SEO

Every route gets its own canonical URL, Open Graph and Twitter tags, and JSON-LD with a `BreadcrumbList` on subpages. See [SEO](/lighthouse/seo).

### Gate Every Page, Mobile and Desktop

Run the Lighthouse CLI from your project against the production server, once per URL and form factor, into two folders. Then gate each folder:

```sh
mkdir -p artifacts/lighthouse/mobile artifacts/lighthouse/desktop
rm -f artifacts/lighthouse/*/*.json
for url in $(grep -v '^#' docs/migration/urls.txt); do
  slug=$(printf '%s' "$url" | tr -c 'A-Za-z0-9' '_')
  npx lighthouse "$url" --quiet --chrome-flags=--headless=new --output=json \
    --output-path="artifacts/lighthouse/mobile/$slug.json"
  npx lighthouse "$url" --quiet --chrome-flags=--headless=new --output=json --preset=desktop \
    --output-path="artifacts/lighthouse/desktop/$slug.json"
done
node "$REFACTOR/lighthouse-gate.mjs" \
  --dir artifacts/lighthouse/mobile --form-factor mobile --expect-urls docs/migration/urls.txt
node "$REFACTOR/lighthouse-gate.mjs" \
  --dir artifacts/lighthouse/desktop --form-factor desktop --expect-urls docs/migration/urls.txt
```

Performance, Accessibility, Best Practices and SEO must score exactly 1, and every passable Agentic Browsing audit must pass. The gate also checks the form factor and that every expected URL has a report.

Agentic Browsing needs Lighthouse 13.3 or later and Chrome 150 or later. Lighthouse launches your installed Chrome; set `CHROME_PATH` to use another one. Do not collect with `@lhci/cli`: it runs its own bundled Lighthouse 12, which has no Agentic Browsing category, so the gate fails every report.

## Gotchas

1. **Scoped ids.** Bascik rewrites static string literals in `getElementById`, `querySelector("#id")` and similar calls, plus `aria-controls`, `popovertarget`, `commandfor` and `href="#id"`. An id built at runtime cannot be rewritten, and the `js-dynamic-id-lookup` lint flags it. Use literals, DOM traversal or bubbling `CustomEvent`s. See [Scoped JavaScript](/scoped-javascript) and [Compatibility](/compatibility).
2. **Test locators.** With `minify.identifiers` on, class and id names are hashed. End-to-end tests use roles, text or `data-testid`.
3. **Lowercase redirects and code-split chunks.** A Worker that redirects uppercase URLs to lowercase breaks esbuild chunks, whose `[hash]` is always uppercase. Exempt asset paths (any path with a file extension, or your bundle folder) from the redirect.
4. **JSX drops whitespace between tags; HTML keeps it.** `white-space: pre-wrap` on a container turns formatted indentation into blank lines. Put it on the leaf element only.
5. **`transform` creates a stacking context.** A transform used for spacing can push content under an overlay. Use margin or padding for layout.
6. **Buttons have default padding.** Reset `padding: 0` on icon buttons, or flex children shrink.
7. **Font subsetting.** Some fonts reach their ff, fi and fl ligatures only through the GSUB table. A subsetter that keeps cmap glyphs only drops them, and words render with gaps. Keep the GSUB glyphs.
8. **Scroll-driven states need threshold sampling,** not screenshots.
9. **Keep the decisions ledger,** so intentional fixes are not reported as regressions.
10. **Cloudflare.** Build with `bascik --build --target cloudflare` and wrap the generated Worker in a thin application Worker for redirects, headers and a few edge API endpoints. The wrapper sees static pages only with `run_worker_first: true`, which gives up the CDN's direct static serving. See [Composition and Custom Worker Wrappers](/deployment/cloudflare#composition-and-custom-worker-wrappers).

## Reference Configuration

Every key below exists in Bascik today, and the file builds as pasted once `scripts/llms-txt.mjs` is copied in. See [Configuration](/configuration) and [Exec Scripts](/exec-scripts):

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  assets: {
    // Global styles inlined into every page's <head>.
    inlineStyles: ["src/pages/css/styles.css"],
  },
  pipeline: {
    exec: [
      // Add your vendor bundle step once it exists (see Bundling npm Packages):
      // { script: "scripts/bundle-vendor.mjs", phase: "pre" },
      // Write dist/llms.txt from the finished pages.
      { script: "scripts/llms-txt.mjs", phase: "post" },
    ],
  },
  scripts: {
    // Build scripts that read live content must rerun on every build.
    cache: { exclude: ["src/pages/press/**"] },
  },
  generate: {
    manifest: true,
    cspHashes: true,
  },
  // http: { precompress: true } only matters for `bascik --server`.
});
```

For Cloudflare, add a wrapper that imports the copied `scripts/worker-response-policy.mjs`. The full commented version is at the top of that file:

```js
// worker-wrapper.js
import bascikWorker from "./dist/.bascik/cloudflare/worker.js";
import cspHashes from "./.bascik/dist/csp-hashes.json";
import { withResponsePolicy } from "./scripts/worker-response-policy.mjs";

export default withResponsePolicy(bascikWorker, {
  cspHashes,
  directives: { "img-src": ["'self'", "data:"] },
});
```

The wrapper deploys with its own config, because its `main` is the wrapper, not the generated `worker.js`. Name that file `wrangler.wrapper.jsonc`, not `wrangler.jsonc`: the build reads a root `wrangler.jsonc` into the generated config and warns that its `main` and `assets.directory` are ignored. See [Composition and Custom Worker Wrappers](/deployment/cloudflare#composition-and-custom-worker-wrappers).

```jsonc
// wrangler.wrapper.jsonc
{
  "name": "my-site",
  "main": "worker-wrapper.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist/.bascik/cloudflare/public",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": true,
  },
  "vars": { "ENVIRONMENT": "production" },
}
```

Run `npx wrangler dev --config wrangler.wrapper.jsonc` and `npx wrangler deploy --config wrangler.wrapper.jsonc` from the project root. Copy the site's bindings and `vars` into this file, since it is the config that deploys. The starter's `npm run deploy` deploys `dist/.bascik/cloudflare` on its own and would skip the wrapper.

## Day-One Checklist

1. Create the project with `npm create bascik@rc site -y -- --template default --no-dev`, or install the skills in an existing one, then install the opt-in skill with `npx skills add bascikdev/bascik --skill bascik-refactor`.
2. Check out the legacy repository read-only, next to the new site.
3. Install sharp and Lighthouse as dev dependencies, and the Chromium browser.
4. Create `docs/migration/`, `artifacts/` and `scripts/`, ignore `artifacts/`, set `PROD_URL`, `TARGET_URL`, `BASCIK_SITE_URL` and `REFACTOR`, and copy the two site scripts.
5. Fill in the execution contract from its template and commit it.
6. Have an agent record `routes.json`, `interactions.json` and `integrations.json`, then generate `urls.txt`.
7. Generate `breakpoints.json` with `breakpoint-matrix.mjs` and review it.
8. Write the prompt pack index and start `decisions.md` and `accepted.json`.
9. Build the shared shell and the home page, and lock them with tests.
10. Serve a production build with `bascik --server`.
11. Run `production-defects.mjs`, `compare-route.mjs`, `geometry-diff.mjs` and `run-checks.mjs` on the home page across the matrix, then review it with `review-page.mjs` and sign it off.
12. Gate the home page with `lighthouse-gate.mjs`, mobile and desktop, and let the driver take over.

> **Next.** The framework guides map each feature to Bascik: [Switch to Bascik](/switch), [From Next.js](/switch/from-next) and [From React](/switch/from-react). [Agent Skills](/agent-skills) explains how to install and update the skills.
