# Prompt pack index

Keep the prompts in `docs/migration/prompts/`, numbered `{{NN}}-<slug>.md`. Every prompt starts with "Read
`docs/migration/execution-contract.md` first" and ends with acceptance checks the driver can run. Copy this index,
replace each `{{NN}}` with a two-digit number, and add rows as the queue grows.

| #      | Phase                   | Prompt                                          | Acceptance                                                    | Status |
| ------ | ----------------------- | ----------------------------------------------- | ------------------------------------------------------------- | ------ |
| {{NN}} | 1. Record the real site | Inventories: routes, interactions, integrations | JSON files exist and every route in the sitemap is listed     |        |
| {{NN}} | 1. Record the real site | Breakpoint matrix and production baselines      | `breakpoints.json` reviewed; baseline screenshots per case    |        |
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

## The representative slice gate

Do not start phase 7 until a few representative pages (the home page, one content page, one page with a form, one
page with heavy media) score 100 in all five categories, mobile and desktop, and pass compare-route at every matrix
case. Every problem found here would otherwise repeat on every page.
