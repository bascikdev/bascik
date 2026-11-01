---
name: bascik-refactor
description: Have coding agents refactor a live production site to Bascik with production parity. Use when every route must match the live site in pixels, element geometry and interactions at every breakpoint and score 100 in all five Lighthouse categories; when generating a breakpoint viewport matrix from legacy CSS, comparing a route with production, gating Lighthouse reports, writing llms.txt, building responsive WebP variants, or wrapping a Cloudflare Worker with CSP, robots and cache headers; or when writing the execution contract, prompt pack, route and failure prompts, driver agent, and decisions ledger for that work. Opt-in, so new projects do not include it.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Refactoring a Live Site with Coding Agents

Requires the `bascik` skill for component rules and the `bascik-migrate` skill for the framework-to-Bascik procedure; this skill runs that procedure route by route until every route matches production. It is opt-in, so projects created with `npm create bascik@rc` do not include it. Install it with `npx skills add bascikdev/bascik --skill bascik-refactor`.

## Procedure

Read `node <skills-dir>/bascik/scripts/read-doc.mjs /how-to/agent-migration` first, then [references/production-parity.md](references/production-parity.md) for the full method.

1. Record the inventories in `docs/migration/` and generate the breakpoint matrix with `scripts/breakpoint-matrix.mjs`. No target exists yet, so run the inventory scripts on production alone, without `--target`: `scripts/interaction-crawl.mjs --discover` drafts `interactions.json` (review it and remove `"draft"`), `scripts/presence-by-route.mjs` and `scripts/state-capture.mjs` record layers and open states, and `scripts/capture-baselines.mjs --states` records the production baselines, ids `<route>@<caseId>`, in `artifacts/baselines/`. Copy `scripts/llms-txt.mjs` and `scripts/worker-response-policy.mjs` into the project's `scripts/` before the config or Worker uses them. Compare and audit a production build (`bascik --build`, then `bascik --server` on port 8080), never the dev server.
2. Fill in [references/templates/execution-contract.md](references/templates/execution-contract.md) and the [references/templates/prompt-pack-index.md](references/templates/prompt-pack-index.md); every prompt reads the contract first.
3. Migrate route by route with [references/templates/one-route.md](references/templates/one-route.md) and repair with [references/templates/one-failure.md](references/templates/one-failure.md). Run `scripts/production-defects.mjs` on production first, then `scripts/run-checks.mjs` for every parity check in one command. Iterate with `--cases <ids>` (a phone, a tablet, a desktop and the route's breakpoint edges) and `--only <checks>`; production's side comes from the production cache, so only the target is loaded. Those runs print `PARTIAL` and decide nothing: a run that leaves out cases or checks cannot be signed. The gate is the full `docs/migration/breakpoints.json` matrix with every check, and "done" is decided only there; pass `--refresh-prod` at the start of every check stage and review round, and whenever production changed (sign-off refuses cached production more than a day old).
4. Review each route side by side: an agent with image input follows [references/templates/visual-review.md](references/templates/visual-review.md), then a person reviews the `scripts/review-page.mjs` page and signs `docs/migration/review/<route>.json`.
5. Run the queue with [references/templates/driver-agent.md](references/templates/driver-agent.md): PASS needs every check, a visual review with no differences and a human pass verdict (`review-page.mjs --verify`). No findings is not a PASS on its own. Escalate framework issues in its reproducible format.
6. Log every intentional difference in [references/templates/decisions-ledger.md](references/templates/decisions-ledger.md); a row that changes pixels also gets an `accepted.json` entry for `compare-route.mjs --accepted`. A `PD-` row from `production-defects.mjs` that a reviewer finds is not a defect gets an `accepted.json` entry with `"defect": ["PD-xxxxxx"]` and a ledger row of the entry's id instead of a design change, so it is neither a fix target nor a `copied-defect`. `--reject PD-xxxxxx` is for one iteration run only: `review-page.mjs` refuses a gate run that used it. Elements with the same text and kind share a `PD-` id, so check every element a rejection covers.

## Components and TypeScript

The parity checks prove the page looks and behaves like production; they do not prove the code is easy to work in. Hold every route to the `bascik` skill's rules as well:

- **Pages are lists of tags.** Each section with a nameable job is a component, a block repeated on a route or across routes is one component with props (`repeated-sections.mjs` checks the rendered pages), and the page holds their tags. Do not port framework-only wrappers, one-element components, or props threaded through layers; use slots.
- **TypeScript stays TypeScript.** When the legacy site is TypeScript, its component logic, prop and state types, and data helpers move to `.ts` companions, `<script type="text/typescript">` blocks, and `.ts` modules, with the types carried across. A module one component or page uses lives beside it (in the component's folder, imported with `./`; beside a page as `.ts`), content with the component that renders it, and only shared modules in `src/lib/`: never park per-route data (a route's FAQ entries, its plans) in `src/lib/`. `audit-components.mjs` reports `single-use-module`. New code is TypeScript unless the person asks for JavaScript. Erasable syntax needs no setup; for `enum`, decorators, or npm packages in the browser, use esbuild through `scripts.typescript` and `pipeline.exec`. Docs: `/scoped-javascript#typescript-in-component-scripts`, `/configuration#scriptstypescript`, `/how-to/bundling-npm-packages`.
- **Clean semantic HTML.** The new repository owns clean semantic HTML, as [references/production-parity.md](references/production-parity.md) says: keep every semantic element production has, never turn semantic markup into `<div>`s, and make each component's root the element for its job. Parity is about what visitors see and can do, not the old markup, so a refactor may fix non-semantic production markup (a clickable `<div>`, a `<div>` navigation, a skipped heading level, an unlabeled input) when the look and behavior stay the same. Log each fix in the decisions ledger the way a production defect is logged. Checklist: `node <skills-dir>/bascik/scripts/read-doc.mjs /component-best-practices#use-htmls-elements`.
- **Markup is built with `html`.** Every script and helper that returns markup uses `html` from `@bascik/bascik/html` (`raw()` only for markup the project wrote or sanitized CMS HTML, `json()` for JSON-LD). Never port the legacy site's escaper or write one; `audit-components.mjs` reports `hand-written-escaper`. Switching to `html` can change how characters are escaped (`&#39;` for `'`); list each such byte difference in the decisions ledger, since it does not change what visitors see.
- **Gate it.** `node <skills-dir>/bascik/scripts/audit-components.mjs` exits 0 for every migrated route, or each kept warning has a row in the decisions ledger.

## Scripts

For responsive images, use `node <skills-dir>/bascik-components/scripts/responsive-webp.mjs` from the existing component skill. Read `/how-to/optimizing-images` for the local generation and native HTML workflow.

| Script                                                                     | Use                                                                    |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`scripts/breakpoint-matrix.mjs`](scripts/breakpoint-matrix.mjs)           | Legacy breakpoints to `breakpoints.json` (B - 1, B, B + 1, midpoints)  |
| [`scripts/capture-baselines.mjs`](scripts/capture-baselines.mjs)           | Production baselines (`<route>@<caseId>`): page, geometry, open states |
| [`scripts/geometry-diff.mjs`](scripts/geometry-diff.mjs)                   | Element boxes, production vs target, per matrix case                   |
| [`scripts/compare-route.mjs`](scripts/compare-route.mjs)                   | Pixels, geometry, evidence and interaction traces per route            |
| [`scripts/lighthouse-gate.mjs`](scripts/lighthouse-gate.mjs)               | Fails unless every report is 100 in all five categories                |
| [`scripts/llms-txt.mjs`](scripts/llms-txt.mjs)                             | Post exec script that writes `dist/llms.txt`                           |
| [`scripts/worker-response-policy.mjs`](scripts/worker-response-policy.mjs) | Cloudflare Worker wrapper: CSP hashes, robots and cache headers        |
| [`scripts/interaction-crawl.mjs`](scripts/interaction-crawl.mjs)           | Activates every interactive element; compares effects (CDP listeners)  |
| [`scripts/state-capture.mjs`](scripts/state-capture.mjs)                   | Open dropdowns and disclosures: styles, icons, crops                   |
| [`scripts/repeated-sections.mjs`](scripts/repeated-sections.mjs)           | Sections on 2+ routes must be one component, styled alike              |
| [`scripts/text-style-diff.mjs`](scripts/text-style-diff.mjs)               | Text styles at rest, `:hover`, `:focus-visible` (CDP)                  |
| [`scripts/spacing-diff.mjs`](scripts/spacing-diff.mjs)                     | Vertical gaps inside each section, 2 px                                |
| [`scripts/alignment-diff.mjs`](scripts/alignment-diff.mjs)                 | text-align, line count and offsets per width                           |
| [`scripts/overlap-diff.mjs`](scripts/overlap-diff.mjs)                     | Overlapping pairs within 1 px, pixel exact                             |
| [`scripts/testid-carryover.mjs`](scripts/testid-carryover.mjs)             | Production and legacy test hooks on the same elements                  |
| [`scripts/testid-coverage.mjs`](scripts/testid-coverage.mjs)               | `data-testid` on controls, landmarks, component roots                  |
| [`scripts/presence-by-route.mjs`](scripts/presence-by-route.mjs)           | Banners, dialogs, sticky layers per route, fresh and dismissed         |
| [`scripts/production-defects.mjs`](scripts/production-defects.mjs)         | Production's own bugs, logged as fixes before parity                   |
| [`scripts/run-checks.mjs`](scripts/run-checks.mjs)                         | Every parity check per route; one report; exit 1 on any finding        |
| [`scripts/review-page.mjs`](scripts/review-page.mjs)                       | Side-by-side page per route; `--sign` and `--verify` the sign-off      |

The scripts load Playwright and sharp from the project (`npm install -D playwright sharp`, `npx playwright install chromium`). Run each with `--help`. Every script that loads production keeps it read-only: on both sides it blocks service workers and the common analytics hosts and refuses requests other than GET or HEAD outside the target (a GET with a side effect and WebSocket traffic still get through, so skip such controls with `--skip-control`); add a site's own tracker with `--block <host or URL part>`, and pass `--min-interval-ms 1000` for a site you do not run ("Capture settings" in [references/production-parity.md](references/production-parity.md)). Never drive production from a browser script of your own without the same rules. Set `REFACTOR` to this skill's `scripts/` folder (for example `.agents/skills/bascik-refactor/scripts`) so prompts call `node "$REFACTOR/run-checks.mjs"`. Each check, its tolerance and its misuse cases are in [references/production-parity.md](references/production-parity.md).
