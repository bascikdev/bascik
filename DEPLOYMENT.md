# Deploying bascik.dev and the Adapter Demo

This repo deploys two sites to Cloudflare. Everything that can live in the repo does: each Worker is defined by a `wrangler.jsonc`, GitHub Actions builds and deploys both (CI stage 5 in [.github/workflows/ci.yml](.github/workflows/ci.yml)), and root scripts build, check and preview each one locally. Nobody deploys by hand, and Cloudflare Workers Builds is not used. The steps that cannot live in the repo (credentials, the bascik.dev cutover, retiring the Pages project) are listed here with a check for each.

The user-facing version of this material, written for people deploying their own Bascik sites, is [docs/content/deployment/cloudflare.md](docs/content/deployment/cloudflare.md) (rendered at https://bascik.dev/deployment/cloudflare).

## The Two Deployments

| Site                                                                                 | Cloudflare resource                                                  | Defined in                                                                                       | Built by                                                                             |
| :----------------------------------------------------------------------------------- | :------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| Docs, [bascik.dev](https://bascik.dev)                                               | Worker `bascik`, assets only (no `main`)                             | [docs/wrangler.jsonc](docs/wrangler.jsonc)                                                       | `yarn pkg:build && yarn docs:build` into `docs/dist`                                 |
| Adapter demo, [cloudflare-adapter.bascik.dev](https://cloudflare-adapter.bascik.dev) | Worker `cloudflare-adapter`, static assets plus the generated Worker | [adapters/cloudflare/e2e/fixture/wrangler.jsonc](adapters/cloudflare/e2e/fixture/wrangler.jsonc) | `bascik --build --target cloudflare` in the fixture, into `dist/.bascik/cloudflare/` |

Both are in the account's zone `bascik.dev`, which uses Cloudflare nameservers (required for Worker custom domains).

### Docs: `docs/wrangler.jsonc`

- `name` `bascik`, `compatibility_date` `2026-08-23` (the date the Pages project used), no `main`, so no Worker code runs and asset requests are not billed as invocations.
- `assets`: `directory` `./dist` (resolved from the config file, so it is `docs/dist` from any working directory), `html_handling` `auto-trailing-slash`, `not_found_handling` `404-page`.
- `workers_dev: false`: bascik.dev is the only production host.
- `preview_urls: true` and `previews: {}`: Preview URLs for every uploaded version, and the block `wrangler preview` requires.
- The build writes `docs/dist/_headers` and `_redirects` (`docs/scripts/generate-pages-headers.ts`, rules in `docs/src/lib/pages-headers.ts`). Workers static assets reads both with the same syntax as Pages. The headers file includes a `https://:worker.:subdomain.workers.dev/*` rule with `X-Robots-Tag: noindex`. It is not needed: Cloudflare already adds that header to every `workers.dev` Preview and version URL (only Preview URLs on a custom domain lack it, and the docs Worker serves none). It is harmless and can stay. The file also keeps the `https://:project.pages.dev/*` noindex rule until the Pages project is deleted.

### Demo: `adapters/cloudflare/e2e/fixture/wrangler.jsonc`

- `name` `cloudflare-adapter`, `compatibility_date` `2026-08-01`, `compatibility_flags` `["nodejs_compat"]`.
- `routes`: `{ "pattern": "cloudflare-adapter.bascik.dev", "custom_domain": true }`. `wrangler deploy` replaces the Worker's custom domains with this list, so a domain added in the dashboard and not listed here is removed on the next deploy. `wrangler preview` never touches routes or domains.
- `workers_dev: false`, `preview_urls: true`, `previews: {}`.
- No bindings: the adapter adds `ASSETS`, `main: "worker.js"` and the computed `run_worker_first` when it writes `dist/.bascik/cloudflare/wrangler.jsonc`. The merge rules are in the user docs, under "How the build merges your config".
- The adapter E2E lane (`yarn adapter:cf:e2e`) builds the same fixture with `--target cloudflare-pages`, which ignores this file. Both builds write `adapters/cloudflare/e2e/fixture/dist/`, so do not run the demo build and the E2E lane at the same time.

### Scripts

Run from the repo root.

| Script                         | What it does                                                                    |
| :----------------------------- | :------------------------------------------------------------------------------ |
| `yarn docs:cf:dev`             | `wrangler dev` on the current `docs/dist` (build it first)                      |
| `yarn docs:cf:check`           | `wrangler deploy --dry-run` for the docs Worker                                 |
| `yarn docs:cf:preview`         | `wrangler preview`: a Preview named after the git branch                        |
| `yarn docs:cf:deploy`          | `wrangler deploy` to production. CI does this; see "Manual Deploy" below.       |
| `yarn adapter:cf:demo:build`   | builds `pkg`, the adapter, then the fixture with `--target cloudflare`          |
| `yarn adapter:cf:demo:dev`     | build, then `wrangler dev` in local workerd from the generated folder           |
| `yarn adapter:cf:demo:preview` | build, then `wrangler preview` from the generated folder                        |
| `yarn adapter:cf:demo:deploy`  | build, then `wrangler deploy` to production. CI does this; see "Manual Deploy". |

The workspace scripts behind them (`yarn workspace bascik-docs cf:*`, `yarn workspace @bascik/adapter-cloudflare demo:*`) run one step each. `docs:cf:dev` serves `docs/dist`; while `yarn docs:dev` owns that folder, serve a separate build with `npx wrangler dev --assets <dir>` from `docs/`. Run Wrangler from the folder that owns the config, or pass `--config`: `npx` from a folder without a `package.json` runs from the nearest workspace and loads that workspace's config.

## How Deploys Happen

CI runs on every branch push, and deploys both Workers in stage 5, after every static, unit, integration and E2E job of that run has passed. Nothing deploys when a test fails.

| Event                                   | What CI does                                                                                                                                                                                                                                                                                                                                   |
| :-------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `main` (a merged pull request)  | `wrangler deploy` for `bascik` (job `deploy-docs`) and `cloudflare-adapter` (job `deploy-demo`), then checks `https://bascik.dev/` and `https://cloudflare-adapter.bascik.dev/catalog`. Never a Preview.                                                                                                                                       |
| Push to any other branch of this repo   | `wrangler versions upload --preview-alias <alias>` for both Workers and a check of each Preview. The `preview-comment` job then writes both URLs to the run's job summary and, when the branch has an open pull request in this repo, creates or updates the one Preview comment on it. A branch without a pull request gets the summary only. |
| Pull request from a branch of this repo | Nothing: the stage 1 jobs skip, so every later job skips too. The branch's push run tests it, and its checks show on the pull request.                                                                                                                                                                                                         |
| Pull request from a fork                | Stages 1 to 4 test the merge commit. Stage 5 never runs on a `pull_request` event, and a fork's pull request gets no secrets anyway.                                                                                                                                                                                                           |
| Tag push                                | Nothing: the `push` trigger lists only `branches: ["**"]`, which skips tags. `release.yml` handles them.                                                                                                                                                                                                                                       |
| Push in someone's fork of this repo     | Stages 1 to 4 only: the deploy jobs also check `github.repository == 'bascikdev/bascik'`, so a fork with Actions turned on does not fail on missing credentials.                                                                                                                                                                               |

- **One test run per commit.** Without the stage 1 guard, a push to a branch with an open pull request would run CI twice: once for `push` and once for `pull_request`. The stage 1 jobs (`jelly`, `semgrep`, `typecheck`, `standards`) carry `if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository`, and every later job needs them directly or through another stage, so on a same-repo `pull_request` event the whole run skips: a job whose `needs` was skipped is skipped, not failed. The push run's check runs are on the branch's head commit, which is the pull request's head commit, so the pull request's Checks list shows them. It also lists the skipped jobs of the `pull_request` run under the same names; GitHub reports a skipped job as successful. The `main` ruleset requires no status checks today; if you add one, pick a check whose result you can confirm comes from the push run, because a skipped job of the same name passes.
- **A branch run tests the branch, not the merge.** The push run builds and tests the branch's own commit (`github.sha`), not `refs/pull/<n>/merge`. A branch that is behind `main` is tested without `main`'s newer commits until it is updated; the ruleset's "branches must be up to date" setting covers this for merges once a required check exists. A fork's pull request is still tested as the merge commit.
- **A Preview never touches production.** `wrangler versions upload` creates a new version with its own URL and leaves the deployed version, routes and custom domains alone. It is the generally available Versions feature, not the open-beta `wrangler preview`. The version message is `Preview <alias> at <sha>`.
- **The comment and the summary name the commit CI built**, `github.sha`, and the branch: "Built from `<sha>` on `<branch>`". The `preview-comment` job finds the pull request with `GET /repos/bascikdev/bascik/pulls?head=bascikdev:<branch>&state=open` (a fork's branch of the same name has another owner, so it never matches), and edits only the comment that starts with the hidden marker and was written by `github-actions[bot]`. It is the only job with `pull-requests: write`; every other job has `contents: read` only.
- **The alias is per branch** (`.github/scripts/preview-alias.mjs`, given `github.ref_name`). A branch name that is already lowercase `[a-z0-9-]`, starts with a letter and fits is used as is (`pre-release-20261026`). Any other name is lowercased, each run of other characters becomes one `-`, `b-` is prefixed when it starts with a digit, and a 6-character hash of the full branch name is appended (`collin/Foo` becomes `collin-foo-857f77`). The hash is added only when cleaning changed the name, so `feature/x` and `feature-x` get different aliases (`feature-x-<hash>` and `feature-x`) instead of overwriting each other's Preview, while a clean name stays readable. The alias is also shortened, before the hash, when `<alias>-cloudflare-adapter` would exceed one 63-character DNS label. Every push to the branch moves the same alias, so the URLs are `https://<alias>-bascik.<account-subdomain>.workers.dev` and `https://<alias>-cloudflare-adapter.<account-subdomain>.workers.dev` for the life of the branch. Both configs set `preview_urls: true`; Cloudflare adds `X-Robots-Tag: noindex` on `workers.dev` Preview URLs. Nothing in CI removes a Preview when its branch is deleted: the versions stay in `wrangler versions list`, and the alias keeps pointing at the last one.
- **The URL comes from Wrangler's machine-readable output** (`WRANGLER_OUTPUT_FILE_PATH`, read by `.github/scripts/wrangler-preview-url.mjs`), and the job fails when the upload reports no alias URL. Each deploy job also appends its own URL to the job summary, so one Worker's URL is visible even when the other's upload failed.
- **Smoke checks** (`.github/scripts/smoke-test.mjs`, retried for about a minute): docs Preview `/` 200, `/components` 200, `/components/` 307, `/semantic-html` and `/name-attribute` 301, an unknown path 404; demo Preview and production `/`, `/catalog`, `/catalog-stream` 200; docs production `/`, `/components` 200 and `/semantic-html` 301.
- **A newer push to a branch cancels the older run.** The workflow's concurrency group is per ref, with `cancel-in-progress` on for every ref except `main`, so a second push to a branch cancels the first push's whole run, its Preview upload included. Runs on `main` each get their own group (`ci-main-<run id>`), because a shared group would cancel a pending `main` run whenever a third one queued.
- **Never an older commit over a newer one.** No job has its own concurrency group. On a branch the workflow's group already allows one run at a time. On `main` a shared deploy group would hold only one pending deploy, so an older commit's deploy that queued later would cancel a newer commit's pending one, and the newest commit would never deploy; so `main` deploys never wait for or cancel each other. Runs also finish in any order: if commit X is pushed to `main` before Y but Y's tests finish first, Y deploys and X would deploy later and put older code live. So each deploy job runs `.github/scripts/newest-commit.mjs` right before Wrangler. It compares `github.sha` with the branch tip from `git ls-remote`, and when the branch has moved on, it skips the upload or deploy and the smoke checks with a notice. The newer run deploys instead, and the `preview-comment` job skips because it has no URLs. Two `main` deploys could only overlap if a newer commit were pushed, tested and deployed during the minute between an older run's check and the end of its `wrangler deploy`.
- **CI never asks before taking over a hostname.** Wrangler runs without a terminal in CI, and then `wrangler deploy` sets `override_existing_origin` and `override_existing_dns_record` when it attaches the custom domains in `routes` (Wrangler 4.152.0, `publishCustomDomains`). A hostname in `routes` that another Worker or a DNS record holds is taken over on the next push to `main`, without the prompt a local deploy shows. Add a hostname to a `routes` list only when you mean that.
- **The docs job checks out the full git history** (`fetch-depth: 0`), because `docs/scripts/generate-git-dates.ts` reads it for sitemap `lastmod` and article dates.
- The helpers are tested by `pkg/e2e/scripts/ci-deploy.test.ts` (run by `yarn pkg:unit` and the `unit-pkg` CI job). It also checks the five-stage job graph, and evaluates the workflow's own `if:` conditions for a push to `main`, a branch push, a tag, a same-repo pull request, a fork's pull request and a push in a fork, so a condition that would preview `main`, deploy from a pull request or a tag, or test a same-repo pull request twice fails it. When you add a stage 4 job, add it to the `needs` of both deploy jobs or that test fails.

## Credentials

| Name                    | Kind (Settings > Secrets and variables > Actions) | Value                                         |
| :---------------------- | :------------------------------------------------ | :-------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Repository secret                                 | The deploy API token described below          |
| `CLOUDFLARE_ACCOUNT_ID` | Repository variable                               | The Cloudflare account that owns both Workers |

Wrangler reads both from the environment. The workflow sets them only on the Wrangler steps, never on the build or install steps, and never prints them. Each deploy job starts with a step that fails with a pointer to this file when either is missing.

The token (id `a535972bb41d83efb3d745a817321ea0`) is a custom API token with only:

- Account: **Workers Scripts: Edit** and **Account Settings: Read** on the account.
- Zone: **Workers Routes: Edit** on the zone `bascik.dev` (custom domains and routes on deploy).
- User: **Memberships: Read** and **User Details: Read** (Wrangler checks who it is running as).

It cannot change DNS, Pages, other zones or account members. To rotate it: Cloudflare dashboard > My Profile > API Tokens > the token with that id > Roll, then store the new value with `gh secret set CLOUDFLARE_API_TOKEN` (it prompts, so the value stays out of shell history). Check it with `curl -s -H "Authorization: Bearer $TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify` (`"status": "active"`). To set the account: `gh variable set CLOUDFLARE_ACCOUNT_ID --body <account-id>`.

## Manual Deploy in an Emergency

Only when CI cannot deploy (an Actions outage, or a broken workflow on `main`) and production must change now. Deploy from a clean checkout of the commit that should be live, normally `origin/main`, never from a branch with local changes:

```sh
git switch --detach origin/main && git status --short   # must print nothing
corepack enable && yarn install --immutable
export CLOUDFLARE_ACCOUNT_ID=<account-id>
export CLOUDFLARE_API_TOKEN=<token>                     # or run `npx wrangler login` from docs/ instead
yarn pkg:build && yarn docs:build && yarn docs:cf:deploy  # docs, Worker bascik
yarn adapter:cf:demo:deploy                               # demo: builds, then deploys cloudflare-adapter
```

Both use the repo's own Wrangler (`^4.152.0`, a workspace devDependency); do not run a downloaded `npx wrangler@latest`. Then run the read-only checks below, and re-run the failed CI deploy once CI works, so the next deploy again comes from CI.

To roll back instead, pick an earlier version: `npx wrangler deployments list` then `npx wrangler rollback <version-id>` from `docs/` (docs) or `adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare` after a demo build (demo). A rollback lasts until the next push to `main` deploys again.

## Verify (Read-Only)

None of these change anything:

```sh
cf workers get bascik                         # exists; "subdomain": enabled false, previews_enabled true
cf workers get cloudflare-adapter          # references.domains lists cloudflare-adapter.bascik.dev
cd docs && npx wrangler deployments list      # newest deployment: message "main at <sha>" from CI
npx wrangler versions list                    # Preview versions carry "Preview <alias> at <sha>"
curl -s -o /dev/null -w "%{http_code}\n" https://bascik.dev/                                 # 200
curl -s -o /dev/null -w "%{http_code}\n" https://cloudflare-adapter.bascik.dev/catalog         # 200
curl -s -o /dev/null -w "%{http_code}\n" https://cloudflare-adapter.bascik.dev/catalog-stream  # 200
```

For the demo, run the `wrangler` commands from `adapters/cloudflare` with `--config e2e/fixture/dist/.bascik/cloudflare/wrangler.jsonc` after `yarn adapter:cf:demo:build`. On a branch run, the `Publish Preview URLs` job summary links both Previews, and so does the Preview comment when the branch has a pull request; the `Deploy Docs` and `Deploy Adapter Demo` job logs show each smoke check.

## Setup History (2026-10-30)

Everything below was a one-time account change, done by the maintainer session with its own credentials. It is recorded here for context and rollback; nothing in it needs doing again.

1. **Credentials.** A user API token scoped to Workers Scripts write and Account Settings read on the account, Workers Routes write on zone `bascik.dev`, and Memberships and User Details read was created and stored as the repository secret `CLOUDFLARE_API_TOKEN` (token id `a535972bb41d83efb3d745a817321ea0`), with the repository variable `CLOUDFLARE_ACCOUNT_ID`. See [Credentials](#credentials) to rotate it.
2. **bascik.dev moved from Pages to the Worker `bascik`.** The custom domain was removed from the Pages project, the proxied `CNAME bascik.dev -> bascik.pages.dev` was deleted, and a `wrangler deploy` of `main`'s docs build created the Worker with `bascik.dev` as its custom domain (declared in `docs/wrangler.jsonc`). Downtime was a few seconds. `www.bascik.dev` still answers `301` to `https://bascik.dev` through a zone redirect.
3. **The Pages project `bascik` was deleted**, after deleting its 498 deployments (Cloudflare refuses to delete a project with many). `bascik.pages.dev` no longer resolves.
4. **The demo Worker was recreated as `cloudflare-adapter`**, matching its subdomain. The old Worker `bascik-streaming-test` was deleted, which also removed its Workers Builds Git connection, its build trigger, and its custom domain. A `wrangler deploy` of `main`'s demo build created `cloudflare-adapter` with `cloudflare-adapter.bascik.dev` as its custom domain (declared in `adapters/cloudflare/e2e/fixture/wrangler.jsonc`).

Both production Workers were deployed from `main` at the time, so pages that exist only on unmerged branches (such as `/catalog` on the demo) answer `404` until CI deploys `main` again. From now on only CI stage 5 deploys either Worker; neither is connected to Workers Builds.

**Rollback of the docs to Pages** would mean recreating a Pages project and its `CNAME`, then removing the `routes` entry from `docs/wrangler.jsonc` first, or the next CI deploy takes the hostname back.

## Worker Secrets

Neither Worker has secrets or bindings, and neither build needs a secret. If one ever does, set a runtime secret on the Worker, never in a config file:

```sh
cd docs && npx wrangler secret put <NAME>
cd adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare && npx wrangler secret put <NAME>
```

A build-time value goes in a GitHub Actions secret, passed to the build step's `env` only. Check runtime secrets with `cf workers secrets list --worker cloudflare-adapter` (or `--worker bascik`).

## Pages and Workers Differ Here

Measured for bascik.dev by comparing the Pages preview of the same commit with `wrangler dev` (the same asset code as production) and the production demo Worker:

- Trailing-slash and `.html` redirects are `307` on Workers; Pages used `308`. No setting changes it.
- Pages sends `Cache-Control: no-store` on every 404. Workers sends the path's `_headers` value (`public, max-age=0, stale-while-revalidate=86400` for page-shaped URLs), because `_headers` cannot match on status.
- Workers sends an `ETag` on HTML; Pages sent none.
- **Open:** every `@2x` image URL in `/assets/demos/` and `/assets/vscode/` (46 files, 87 references on 18 pages) gets a `307` to its `%40` spelling on Workers. Fix in the image helper in `docs/src/lib/md-renderer.ts` (encode the path segment; Pages serves `%40` too) before the cutover.
- `docs/scripts/generate-git-dates.ts` needs the full git history for sitemap `lastmod` and article dates. Pages cloned shallowly, so the script fetched the rest when `CF_PAGES=1`. The CI deploy job checks out the full history (`fetch-depth: 0`), so the dates are right without that.
- Web Analytics is a zone-level automatic setup (`lite` mode) and is injected at the zone edge, so it keeps working on the Worker. Verified on cloudflare-adapter.bascik.dev, a Worker on the same zone. It is not injected on `pages.dev` or `workers.dev`.
- The zone's browser cache TTL override (`max-age=14400` on files such as `robots.txt`) is a zone setting and applies to the Worker as well.
