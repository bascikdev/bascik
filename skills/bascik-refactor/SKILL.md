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

1. Record the inventories in `docs/migration/` and generate the breakpoint matrix with `scripts/breakpoint-matrix.mjs`. Copy `scripts/llms-txt.mjs` and `scripts/worker-response-policy.mjs` into the project's `scripts/` before the config or Worker uses them. Compare and audit a production build (`bascik --build`, then `bascik --server` on port 8080), never the dev server.
2. Fill in [references/templates/execution-contract.md](references/templates/execution-contract.md) and the [references/templates/prompt-pack-index.md](references/templates/prompt-pack-index.md); every prompt reads the contract first.
3. Migrate route by route with [references/templates/one-route.md](references/templates/one-route.md) and repair with [references/templates/one-failure.md](references/templates/one-failure.md).
4. Run the queue with [references/templates/driver-agent.md](references/templates/driver-agent.md): never advance until every acceptance check passes on the final files; escalate framework issues in its reproducible format.
5. Log every intentional difference in [references/templates/decisions-ledger.md](references/templates/decisions-ledger.md); a row that changes pixels also gets an `accepted.json` entry for `compare-route.mjs --accepted`.

## Scripts

| Script                                                                     | Use                                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`scripts/breakpoint-matrix.mjs`](scripts/breakpoint-matrix.mjs)           | Legacy breakpoints to `breakpoints.json` (B - 1, B, B + 1, midpoints) |
| [`scripts/geometry-diff.mjs`](scripts/geometry-diff.mjs)                   | Element boxes, production vs target, per matrix case                  |
| [`scripts/compare-route.mjs`](scripts/compare-route.mjs)                   | Pixels, geometry, evidence and interaction traces per route           |
| [`scripts/lighthouse-gate.mjs`](scripts/lighthouse-gate.mjs)               | Fails unless every report is 100 in all five categories               |
| [`scripts/llms-txt.mjs`](scripts/llms-txt.mjs)                             | Post exec script that writes `dist/llms.txt`                          |
| [`scripts/responsive-webp.mjs`](scripts/responsive-webp.mjs)               | WebP widths and a sha256 manifest for `srcset`                        |
| [`scripts/worker-response-policy.mjs`](scripts/worker-response-policy.mjs) | Cloudflare Worker wrapper: CSP hashes, robots and cache headers       |

The scripts load Playwright and sharp from the project (`npm install -D playwright sharp`, `npx playwright install chromium`). Run each with `--help`. Set `REFACTOR` to this skill's `scripts/` folder (for example `.agents/skills/bascik-refactor/scripts`) so prompts call `node "$REFACTOR/compare-route.mjs"`.
