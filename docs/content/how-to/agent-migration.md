# Migrating with Coding Agents

Enterprise websites built on React frameworks, such as Next.js with a component library like Ant Design, have been refactored to Bascik with coding agents. They went from Lighthouse scores in the 60s and 70s to 100 in all five categories (Performance, Accessibility, Best Practices, SEO and Agentic Browsing) on every page, mobile and desktop, while matching the live production site at every breakpoint.

Typical results on such a migration: Largest Contentful Paint drops from about 10 s to under 1.5 s on mobile, Total Blocking Time goes to 0 ms, Cumulative Layout Shift to 0.000, and page weight falls by more than 90 percent.

This page is the recipe. The skill, the prompt templates and the scripts are MIT licensed. Copy them and start today.

## What You Get

Everything ships in the opt-in `bascik-refactor` agent skill:

- [`references/production-parity.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/production-parity.md): the whole workflow, written for any coding agent.
- Six prompt templates:
  - [`execution-contract.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/execution-contract.md): the rules every prompt reads first.
  - [`prompt-pack-index.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/prompt-pack-index.md): the numbered phases, with the representative slice gate.
  - [`one-route.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/one-route.md): migrate one route.
  - [`one-failure.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/one-failure.md): repair one failing check.
  - [`driver-agent.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/driver-agent.md): the agent that runs the queue behind a PASS gate.
  - [`decisions-ledger.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/decisions-ledger.md): every intentional difference from the old site.
- Seven scripts:
  - [`breakpoint-matrix.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/breakpoint-matrix.mjs): finds the legacy breakpoints and writes the viewport matrix.
  - [`geometry-diff.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/geometry-diff.mjs): compares element boxes between production and Bascik.
  - [`compare-route.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/compare-route.mjs): pixel diff, geometry, evidence and interaction traces per route.
  - [`lighthouse-gate.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/lighthouse-gate.mjs): fails unless every report is 100 in all five categories.
  - [`llms-txt.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/llms-txt.mjs): writes `llms.txt` after the build.
  - [`responsive-webp.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/responsive-webp.mjs): WebP variants and a manifest for `srcset`.
  - [`worker-response-policy.mjs`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/scripts/worker-response-policy.mjs): a Cloudflare Worker wrapper for a strict CSP, robots and cache headers.

The scripts are plain Node.js modules with unit tests in the Bascik repository. None of them installs anything, and every one prints its options with `--help`.

## What You Need

1. A Bascik project on Node.js 22.18 or newer. `npm create bascik@rc` creates one with every agent skill already in `.agents/skills/` and `.claude/skills/`. For an existing project, install the skills as [Agent Skills](/agent-skills) describes.
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

   It prints `Server running at http://localhost:8080`. If port 8080 is taken it picks the next free port, so copy the printed URL into `TARGET_URL`. Rebuild after every change. On Cloudflare, use `npx wrangler dev` once the Worker wrapper below exists, and point `TARGET_URL` at the URL it prints.

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

The example site on this page is a generic marketing site: a header with a mobile drawer, a hero, a review carousel, a pricing slider, a contact form and a press list.

## The Breakpoint Matrix

Most visual bugs live between breakpoints, so the matrix is built from the legacy site's real thresholds, not from a list of popular devices.

1. Find every width threshold: CSS, Sass and Less media queries, breakpoint variables and theme tokens, `matchMedia()` and `useMediaQuery()` queries, `innerWidth` checks and responsive image `sizes`.
2. For every threshold B, test B - 1, B, and B + 1 CSS pixels.
3. Add one width inside every interval, plus the narrowest and widest supported widths.
4. Pair every width with a height. Width and height are one case, because sticky headers and `vh` units depend on both.
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

1. **Capture both sides with identical settings.** Same width and height, browser version, device scale factor 1, zoom, color scheme, reduced motion, scroll position and cookie notice state. Wait for `document.fonts.ready`, complete images and finished animations.
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

Measure the result instead of copying the wrappers. Span 20 with offset 2 leaves one twelfth of the container's width on each side. In Bascik that is one section with `width: min(100%, 1200px)`, `margin: 0 auto` and the offset as padding. The rendered framework DOM looked like this; the box below shows the Bascik component, and its Output was generated by the real compiler (built with minification off, as every Output in these docs is).

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
    <press-list></press-list>
  </body>
</html>
```

<!-- demo:migration-grid-source-html -->

```html
<!-- src/components/press-list/press-list.html -->
<section class="press">
  <h2 class="title">In the press</h2>
  <ul class="items">
    <li class="item">Example Daily: A faster site in a week</li>
    <li class="item">Web Weekly: Plans for every team</li>
    <li class="item">Tech Notes: Lighthouse 100 everywhere</li>
  </ul>
</section>
```

<!-- demo:migration-grid-source-css -->

```css
/* src/components/press-list/press-list.css */
.press {
  box-sizing: border-box;
  width: min(100%, 1200px);
  margin: 0 auto;
  /* Offset 2 of 24 columns on each side: one twelfth of the section's width. */
  padding: 32px calc(min(100%, 1200px) / 12);
}

.title {
  margin: 0 0 16px;
  font-size: 1.5rem;
}

.items {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  padding: 16px;
  border: 1px solid currentColor;
  border-radius: 8px;
}
```

<!-- demo:migration-grid-output-html -->

```html
<section class="bascik__press-list__press">
  <h2 class="bascik__press-list__title">In the press</h2>
  <ul class="bascik__press-list__items">
    <li class="bascik__press-list__item">
      Example Daily: A faster site in a week
    </li>
    <li class="bascik__press-list__item">Web Weekly: Plans for every team</li>
    <li class="bascik__press-list__item">
      Tech Notes: Lighthouse 100 everywhere
    </li>
  </ul>
</section>
```

<!-- demo:migration-grid-output-css -->

```css
.bascik__press-list__press {
  box-sizing: border-box;
  width: min(100%, 1200px);
  margin: 0 auto;

  padding: 32px calc(min(100%, 1200px) / 12);
}

.bascik__press-list__title {
  margin: 0 0 16px;
  font-size: 1.5rem;
}

.bascik__press-list__items {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.bascik__press-list__item {
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

It exits with code 1 when anything is flagged, so an agent can use it as an acceptance check.

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

Mask only documented dynamic regions, such as a rotating review carousel. No route passes on one screenshot, and no route passes on a Lighthouse score.

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
4. **Safety.** Browse production read-only. Never submit a real form or send synthetic analytics. No secrets in files.
5. **Working method.** Inspect, make the smallest change, run a focused check, format, hand off.
6. **Handoff.** Status, revisions, changed files, the exact commands and their results, and what is not verified.

### The Prompt Pack

Number the prompts and keep them in the repository, grouped into phases. The [prompt pack index](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/prompt-pack-index.md) is the template:

1. Record the real site: inventories and baselines.
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

- [`one-route.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/one-route.md) migrates one route. Its placeholders: `{{ROUTE}}`, `{{LEGACY_ENTRY}}`, `{{TARGET_PAGE}}`, `{{BASELINE_IDS}}`, `{{REQUIRED_COMPONENTS}}`, `{{INTERACTIONS}}`, `{{PARENT_PROMPT}}` and `{{CHILD_ID}}`.
- [`one-failure.md`](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/one-failure.md) repairs one failing check. Its placeholders: `{{FAILURE_ID}}`, `{{EVIDENCE}}`, `{{MATRIX_CASE}}`, `{{OWNER_FILES}}` and `{{ACCEPTANCE}}`.

Both end in acceptance checks that run the scripts on this page. The one-route checks collect fresh Lighthouse reports for their own route, so a stale report never passes.

### The Driver and the PASS Gate

A [driver agent](https://github.com/bascikdev/bascik/tree/main/skills/bascik-refactor/references/templates/driver-agent.md) works through the queue. Its one rule: never advance to the next prompt until every acceptance check passes on the final files. It keeps fixing application-owned failures itself, writing a one-failure prompt for each.

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

## The Score Playbook to 5 x 100

### Largest Contentful Paint

1. Remove hero fade and zoom animations that start at `opacity: 0`. Chromium does not record an LCP candidate while an element is transparent.
2. Serve responsive WebP with `srcset`. `responsive-webp.mjs` writes the variants, and a manifest with each file's URL:

   ```sh
   node "$REFACTOR/responsive-webp.mjs" \
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
     import { heroFor } from "@/lib/heroes.ts";
     export default () => {
       const hero = heroFor(process.env.BASCIK_PAGE_PATH);
       return hero
         ? `<link rel="preload" as="image" fetchpriority="high" imagesrcset="${hero.srcset}" imagesizes="100vw">`
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

Serve a strict Content Security Policy with a SHA-256 hash for every inline script and style and no `unsafe-inline`. `generate.cspHashes` writes the hashes per page to `dist/.bascik/csp-hashes.json`, and [Content Security Policy](/how-to/content-security-policy) shows the meta tag approach. On Cloudflare, `worker-response-policy.mjs` computes the hashes per response in a Worker wrapper instead. Hashing needs the whole page, so the wrapper buffers pages that stream unless you pass `streamedHtml: "pass"`.

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
10. **Cloudflare.** Build with `bascik --build --target cloudflare` and wrap the generated Worker in a thin application Worker for redirects, headers and a few edge API endpoints. The wrapper sees static pages only with `run_worker_first: ["/*"]`, which gives up the CDN's direct static serving. See [Composition and Custom Worker Wrappers](/deployment/cloudflare#composition-and-custom-worker-wrappers).

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

For Cloudflare, add a root `wrangler.jsonc` and a wrapper that imports the copied `scripts/worker-response-policy.mjs`. The full commented version is at the top of that file:

```js
// worker-wrapper.js
import bascikWorker from "./dist/.bascik/cloudflare/worker.js";
import { withResponsePolicy } from "./scripts/worker-response-policy.mjs";

export default withResponsePolicy(bascikWorker, {
  directives: { "img-src": ["'self'", "data:"] },
});
```

```jsonc
// wrangler.jsonc
{
  "name": "my-site",
  "main": "worker-wrapper.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist/.bascik/cloudflare/public",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": ["/*"],
  },
  "vars": { "ENVIRONMENT": "production" },
}
```

Run `npx wrangler dev` and `npx wrangler deploy` from the project root. The starter's `npm run deploy` deploys `dist/.bascik/cloudflare` on its own and would skip the wrapper.

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
11. Run `compare-route.mjs` and `geometry-diff.mjs` on the home page across the matrix.
12. Gate the home page with `lighthouse-gate.mjs`, mobile and desktop, and let the driver take over.

> **Next.** The framework guides map each feature to Bascik: [Switch to Bascik](/switch), [From Next.js](/switch/from-next) and [From React](/switch/from-react). [Agent Skills](/agent-skills) explains how to install and update the skills.
