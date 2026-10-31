# Prompt pack index

Keep the prompts in `docs/migration/prompts/`, numbered `{{NN}}-<slug>.md`. Every prompt starts with "Read
`docs/migration/execution-contract.md` first" and ends with acceptance checks the driver can run. Copy this index,
replace each `{{NN}}` with a two-digit number, and add rows as the queue grows.

| #      | Phase                   | Prompt                                          | Acceptance                                                    | Status |
| ------ | ----------------------- | ----------------------------------------------- | ------------------------------------------------------------- | ------ |
| {{NN}} | 1. Record the real site | Inventories: routes, interactions, integrations | JSON files exist and every route in the sitemap is listed     |        |
| {{NN}} | 1. Record the real site | Breakpoint matrix and production baselines      | `breakpoints.json` reviewed; a baseline id per route and case |        |
| {{NN}} | 2. Local runtime        | Bootstrap, config boundaries, dev server        | `bascik --build` and `bascik --check` pass                    |        |
| {{NN}} | 2. Local runtime        | Worker packaging, redirects, headers            | every redirect in `routes.json` answers with its status       |        |
| {{NN}} | 2. Local runtime        | Test harness and Lighthouse runner              | the scripts run against one page, mobile and desktop          |        |
| {{NN}} | 3. Shell and home       | Shared head, header, footer, global CSS         | compare-route passes for the home page at every case          |        |
| {{NN}} | 3. Shell and home       | Home page sections                              | geometry-diff and interactions pass; shell locked by tests    |        |
| {{NN}} | 4. Forms                | Contact form: validation, states, submit        | interaction traces match; no real submission                  |        |
| {{NN}} | 5. Integrations         | Each script in `integrations.json`              | same network and cookie contract as production                |        |
| {{NN}} | 6. Slice gate           | Representative slice: a few page types          | **5 x 100 mobile and desktop on every slice page**            |        |
| {{NN}} | 7. Page families        | One family per agent (one-route template)       | compare-route passes for every route in the family            |        |
| {{NN}} | 8. Whole-site visual    | Every route at every case                       | compare-route passes site-wide; ledger covers each difference |        |
| {{NN}} | 9. Optimization, audits | Images, fonts, CSP, llms.txt                    | lighthouse-gate passes for every URL, mobile and desktop      |        |
| {{NN}} | 10. Handoff             | Docs, runbook, open items                       | build, check and all tests green on a clean checkout          |        |

## Phase 1 runs on production alone

No target page exists yet, so phase 1 never passes `--target` (a `--target` that is production is refused: it would
load the live site twice at once):

- `interaction-crawl.mjs --prod "$PROD_URL" --route <path>... --discover` crawls production alone and writes
  `docs/migration/interactions.draft.json`. Review every step, remove each `"draft"`, and save the steps as
  `docs/migration/interactions.json`; `compare-route.mjs` refuses a draft.
- `presence-by-route.mjs` and `state-capture.mjs` without `--target` write production's layers per route and its open
  states, and `production-defects.mjs` lists production's own bugs.
- `capture-baselines.mjs --prod "$PROD_URL" --route <path>... --states` records the baselines: for every route and
  matrix case `artifacts/baselines/<route slug>/<caseId>.png`, its `.nodes.json` geometry and every open state's
  crop, indexed in `artifacts/baselines/index.json`. A baseline id is `<route>@<caseId>` (`/pricing@360x812`,
  `/@1408x900-dark`); an open state adds `#<label>`. One-route prompts name theirs in `{{BASELINE_IDS}}`.

Each writes through the production cache under its own check's key, and only those checks reuse it. The first
`run-checks.mjs` of a route reads production-defects, interaction-crawl and state-capture from the cache when it passes
the same `--mask`, `--skip-control` and `--settle-ms`, and presence-by-route only when it also passes the same
`--route` values in the same order (an inventory of every route does not match a one-route run). repeated-sections,
text-style-diff, spacing-diff, alignment-diff, overlap-diff, testid-carryover and testid-coverage still load production
on that first run. Plan the first run of each route with that in mind.

## Iteration runs and gate runs

Inside a prompt, iterate with `run-checks.mjs --cases <ids> --only <checks>`: a few cases, the checks the last fix can
affect, and production read from the production cache. Those runs print `PARTIAL` and never fill the Acceptance
column. Every Acceptance cell that names a parity check means the gate run: the full `breakpoints.json` matrix, every
check (no `--cases`, `--only` or `--skip`), with `--refresh-prod` on the first run of each check stage and review round.
`review-page.mjs` refuses a report built from cached production more than a day old.

## The representative slice gate

Do not start phase 7 until a few representative pages (the home page, one content page, one page with a form, one
page with heavy media) score 100 in all five categories, mobile and desktop, and pass compare-route at every matrix
case. Every problem found here would otherwise repeat on every page.
