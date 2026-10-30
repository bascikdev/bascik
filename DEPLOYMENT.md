# Deploying bascik.dev and the Adapter Demo

This repo deploys two sites to Cloudflare. Everything that can live in the repo does: each Worker is defined by a `wrangler.jsonc`, GitHub Actions builds and deploys both (CI stage 5 in [.github/workflows/ci.yml](.github/workflows/ci.yml)), and root scripts build, check and preview each one locally. Nobody deploys by hand, and Cloudflare Workers Builds is not used. The steps that cannot live in the repo (credentials, the bascik.dev cutover, retiring the Pages project) are listed here with a check for each.

The user-facing version of this material, written for people deploying their own Bascik sites, is [docs/content/deployment/cloudflare.md](docs/content/deployment/cloudflare.md) (rendered at https://bascik.dev/deployment/cloudflare).

## The Two Deployments

| Site                                                                                 | Cloudflare resource                                                     | Defined in                                                                                       | Built by                                                                             |
| :----------------------------------------------------------------------------------- | :---------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| Docs, [bascik.dev](https://bascik.dev)                                               | Worker `bascik`, assets only (no `main`)                                | [docs/wrangler.jsonc](docs/wrangler.jsonc)                                                       | `yarn pkg:build && yarn docs:build` into `docs/dist`                                 |
| Adapter demo, [cloudflare-adapter.bascik.dev](https://cloudflare-adapter.bascik.dev) | Worker `bascik-streaming-test`, static assets plus the generated Worker | [adapters/cloudflare/e2e/fixture/wrangler.jsonc](adapters/cloudflare/e2e/fixture/wrangler.jsonc) | `bascik --build --target cloudflare` in the fixture, into `dist/.bascik/cloudflare/` |

Both are in the account's zone `bascik.dev`, which uses Cloudflare nameservers (required for Worker custom domains).

### Docs: `docs/wrangler.jsonc`

- `name` `bascik`, `compatibility_date` `2026-08-23` (the date the Pages project used), no `main`, so no Worker code runs and asset requests are not billed as invocations.
- `assets`: `directory` `./dist` (resolved from the config file, so it is `docs/dist` from any working directory), `html_handling` `auto-trailing-slash`, `not_found_handling` `404-page`.
- `workers_dev: false`: bascik.dev is the only production host.
- `preview_urls: true` and `previews: {}`: Preview URLs for every uploaded version, and the block `wrangler preview` requires.
- The build writes `docs/dist/_headers` and `_redirects` (`docs/scripts/generate-pages-headers.ts`, rules in `docs/src/lib/pages-headers.ts`). Workers static assets reads both with the same syntax as Pages. The headers file includes a `https://:worker.:subdomain.workers.dev/*` rule with `X-Robots-Tag: noindex`. It is not needed: Cloudflare already adds that header to every `workers.dev` Preview and version URL (only Preview URLs on a custom domain lack it, and the docs Worker serves none). It is harmless and can stay. The file also keeps the `https://:project.pages.dev/*` noindex rule until the Pages project is deleted.

### Demo: `adapters/cloudflare/e2e/fixture/wrangler.jsonc`

- `name` `bascik-streaming-test`, `compatibility_date` `2026-08-01`, `compatibility_flags` `["nodejs_compat"]`.
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

CI deploys both Workers in stage 5, after every static, unit, integration and E2E job has passed. Nothing deploys when a test fails.

| Event                                   | What CI does                                                                                                                                                                                       |
| :-------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `main` (a merged pull request)  | `wrangler deploy` for `bascik` (job `deploy-docs`) and `bascik-streaming-test` (job `deploy-demo`), then checks `https://bascik.dev/` and `https://cloudflare-adapter.bascik.dev/catalog`.         |
| Pull request from a branch of this repo | `wrangler versions upload --preview-alias <alias>` for both Workers, checks each Preview, then the `preview-comment` job creates or updates one PR comment with both Preview URLs and the commits. |
| Pull request from a fork                | Nothing: a fork's pull request gets no secrets, and every stage 5 job checks `github.event.pull_request.head.repo.full_name == github.repository`.                                                 |

- **A Preview never touches production.** `wrangler versions upload` creates a new version with its own URL and leaves the deployed version, routes and custom domains alone. It is the generally available Versions feature, not the open-beta `wrangler preview`.
- **A pull request run builds the merge commit**, `refs/pull/<n>/merge` (the branch merged into `main`), the same commit stages 1 to 4 tested. The comment and the version message name both the branch's head commit and the base branch, so a Preview can include changes from `main` that the branch does not have yet.
- **The alias is per branch** (`.github/scripts/preview-alias.mjs`). A branch name that is already lowercase `[a-z0-9-]`, starts with a letter and fits is used as is (`pre-release-20261026`). Any other name is lowercased, each run of other characters becomes one `-`, `b-` is prefixed when it starts with a digit, and a 6-character hash of the full branch name is appended (`collin/Foo` becomes `collin-foo-857f77`). The hash keeps `feature/x`, `Feature_X` and `feature-x` from sharing an alias and overwriting each other's Preview. The alias is also shortened, before the hash, when `<alias>-bascik-streaming-test` would exceed one 63-character DNS label. Every push to the branch moves the same alias, so the URLs are `https://<alias>-bascik.<account-subdomain>.workers.dev` and `https://<alias>-bascik-streaming-test.<account-subdomain>.workers.dev` for the life of the branch. Both configs set `preview_urls: true`; Cloudflare adds `X-Robots-Tag: noindex` on `workers.dev` Preview URLs.
- **The URL comes from Wrangler's machine-readable output** (`WRANGLER_OUTPUT_FILE_PATH`, read by `.github/scripts/wrangler-preview-url.mjs`), and the job fails when the upload reports no alias URL.
- **Smoke checks** (`.github/scripts/smoke-test.mjs`, retried for about a minute): docs Preview `/` 200, `/components` 200, `/components/` 307, `/semantic-html` and `/name-attribute` 301, an unknown path 404; demo Preview and production `/`, `/catalog`, `/catalog-stream` 200; docs production `/`, `/components` 200 and `/semantic-html` 301.
- **No overlapping deploys, and never an older commit over a newer one.** Each job has a concurrency group per ref. A newer push to a pull request cancels the running upload; on `main` a running production deploy always finishes. A concurrency group does not order runs, though: if commit X is pushed before Y but Y's tests finish first, Y deploys and X would deploy later and put older code live. So each deploy job runs `.github/scripts/newest-commit.mjs` inside its group, right before Wrangler. It compares the commit the run built (the head commit on a pull request) with the branch tip from `git ls-remote`, and when the branch has moved on, it skips the upload or deploy and the smoke checks with a notice. The newer run deploys instead, and the Preview comment job skips because it has no URLs.
- **CI never asks before taking over a hostname.** Wrangler runs without a terminal in CI, and then `wrangler deploy` sets `override_existing_origin` and `override_existing_dns_record` when it attaches the custom domains in `routes` (Wrangler 4.152.0, `publishCustomDomains`). A hostname in `routes` that another Worker or a DNS record holds is taken over on the next push to `main`, without the prompt a local deploy shows. Add a hostname to a `routes` list only when you mean that.
- **The docs job checks out the full git history** (`fetch-depth: 0`), because `docs/scripts/generate-git-dates.ts` reads it for sitemap `lastmod` and article dates.
- The helpers are tested by `pkg/e2e/scripts/ci-deploy.test.ts` (run by `yarn pkg:unit` and the `unit-pkg` CI job), which also checks the five-stage job graph. When you add a stage 4 job, add it to the `needs` of both deploy jobs or that test fails.

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
yarn adapter:cf:demo:deploy                               # demo: builds, then deploys bascik-streaming-test
```

Both use the repo's own Wrangler (`^4.152.0`, a workspace devDependency); do not run a downloaded `npx wrangler@latest`. Then run the read-only checks below, and re-run the failed CI deploy once CI works, so the next deploy again comes from CI.

To roll back instead, pick an earlier version: `npx wrangler deployments list` then `npx wrangler rollback <version-id>` from `docs/` (docs) or `adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare` after a demo build (demo). A rollback lasts until the next push to `main` deploys again.

## Verify (Read-Only)

None of these change anything:

```sh
cf workers get bascik                         # exists; "subdomain": enabled false, previews_enabled true
cf workers get bascik-streaming-test          # references.domains lists cloudflare-adapter.bascik.dev
cd docs && npx wrangler deployments list      # newest deployment: message "main at <sha>" from CI
npx wrangler versions list                    # Preview versions carry "PR #<n>: <head sha> merged into main"
curl -s -o /dev/null -w "%{http_code}\n" https://bascik.dev/                                 # 200
curl -s -o /dev/null -w "%{http_code}\n" https://cloudflare-adapter.bascik.dev/catalog         # 200
curl -s -o /dev/null -w "%{http_code}\n" https://cloudflare-adapter.bascik.dev/catalog-stream  # 200
```

For the demo, run the `wrangler` commands from `adapters/cloudflare` with `--config e2e/fixture/dist/.bascik/cloudflare/wrangler.jsonc` after `yarn adapter:cf:demo:build`. On a pull request, the Preview comment links both Previews; the `Deploy Docs` and `Deploy Adapter Demo` job logs show each smoke check.

## State on 2026-10-30

Read with the `cf` CLI (read-only) and `curl`, after the maintainer's cutover (commit `a18dc30c`):

- **bascik.dev** is the Worker `bascik`, created and deployed by the maintainer at 20:02 UTC. `references.domains` lists the custom domain `bascik.dev`; `subdomain` has `enabled: false`, `previews_enabled: true`. The zone has no `CNAME bascik.dev -> bascik.pages.dev` any more, and the Pages project `bascik` has no custom domains. `https://bascik.dev/components/` answers `307` (Workers; Pages answered `308`). That deploy predates this branch's docs build, so `/semantic-html` answered `404` until CI deploys from `main`. `www.bascik.dev` is a proxied `CNAME` to `bascik.dev` and answers `301` to `https://bascik.dev`.
- **The Pages project `bascik` still exists** (production branch `main`, previews for all branches, `bascik.pages.dev`). Retiring it is step 4.
- **cloudflare-adapter.bascik.dev** is the Worker `bascik-streaming-test` with the custom domain attached, `workers.dev` off and Preview URLs on (`*-bascik-streaming-test.<account-subdomain>.workers.dev`). Its newest deployment was 2026-09-13, so `/catalog` and `/catalog-stream` answered `404` live until CI deploys the current build.
- **The demo had a Workers Builds connection.** Its trigger is being removed by the maintainer, so only CI deploys the demo. Until it is gone, a merge to `main` that touches its watch paths can deploy the demo twice (same build, harmless). Check with `cf builds workers get <worker-tag>` (not found once removed).

## One-Time Steps

These are dashboard or account changes. Do them in order, and run each check before going on.

### 1. Credentials and Workers Builds

1. Create the token and set the secret and variable as in [Credentials](#credentials).
2. Remove the demo's Workers Builds connection: Workers & Pages > `bascik-streaming-test` > Settings > Build > Disconnect. Do not connect the docs Worker to Workers Builds.

Check: `gh secret list` shows `CLOUDFLARE_API_TOKEN`, `gh variable list` shows `CLOUDFLARE_ACCOUNT_ID`, and a pull request from a branch of this repo gets the Preview comment.

### 2. Docs: First Deploy of the Worker (Done)

Done by the maintainer on 2026-10-30, before stage 5 first ran. It had to come first: `wrangler versions upload` only adds a version to an existing Worker and fails with "You cannot upload a new version of a Worker that does not yet exist" otherwise, so every pull request's docs Preview depended on it. Before deploying, from the repo root: `yarn docs:cf:check` (a dry run; with a fresh build it reads about 325 files, uploads a no-op Worker of 0.31 KiB, and finds no bindings).

Check: `cf workers get bascik` exists. Open a docs Preview URL from a pull request comment and compare it with production: status, `Location`, `Cache-Control`, `Content-Type`, security headers, and `X-Robots-Tag: noindex` (Preview only). The differences from Pages are listed under "Pages and Workers Differ Here" below.

### 3. Docs: Move bascik.dev from Pages to the Worker

Done by the maintainer session on 2026-10-30 with its own credentials, through the custom-domain path of item 4 below: `docs/wrangler.jsonc` lists `bascik.dev` as a custom domain since commit `a18dc30c`, the Worker holds it, and neither the Pages `CNAME` nor the Pages custom domain is left. The steps stay here as the record and for a rollback. CI's `wrangler deploy` now re-applies the same custom domain on every push to `main`; with the domain already on `bascik`, there is nothing for it to take over. Moving the hostname changes DNS and Pages, so a rollback to Pages is done with the maintainer's own credentials, not the deploy token, and needs the `routes` entry removed from `docs/wrangler.jsonc` first, or the next CI deploy takes the hostname back.

bascik.dev is a Pages custom domain, which is the proxied `CNAME bascik.dev -> bascik.pages.dev`. A Worker custom domain cannot be created on a hostname that still has a `CNAME`, so the switch goes through a Workers route first. Add to the Worker, check, then remove from Pages:

1. Add a narrow Workers route in zone `bascik.dev` to Worker `bascik`, such as `bascik.dev/__worker-check*`, and request `https://bascik.dev/__worker-check`. The Worker answers with its 404 page, and HTML from the Worker carries an `ETag`; HTML from Pages has none. That a route takes over from the Pages `CNAME` on this zone is expected but not yet verified, which is why this step comes first.
2. Replace it with the route `bascik.dev/*` to `bascik`. Traffic moves at once, and deleting the route moves it back to Pages.
3. Check `https://bascik.dev`: HTML `ETag` present, the URL matrix from step 2, the 301s for `/semantic-html` and `/name-attribute`, the Web Analytics beacon in a real browser (the zone injects it for browser-like HTML requests only, so plain `curl` never shows it), and `https://www.bascik.dev` still answering `301` to `https://bascik.dev`.
4. Remove the Pages hold on the hostname, choosing one:
   - **Keep the route** (no gap): replace the `CNAME` to Pages with a proxied placeholder `AAAA bascik.dev 100::`, then remove `bascik.dev` from the Pages project's custom domains.
   - **Switch to a Worker custom domain** (a gap of seconds): remove `bascik.dev` from the Pages project, delete the `CNAME`, add `bascik.dev` as the Worker's custom domain, then delete the route.
5. Put the domain in `docs/wrangler.jsonc`, so the repo owns it: `"routes": [{ "pattern": "bascik.dev/*", "zone_name": "bascik.dev" }]` for the route, or `[{ "pattern": "bascik.dev", "custom_domain": true }]` for a custom domain (done: the custom domain). Commit it only after item 4. A local, interactive `wrangler deploy` asks before replacing a conflicting record, but CI does not ask (see "How Deploys Happen"), so a custom domain entry merged while the Pages `CNAME` still exists makes the next `main` deploy try to replace that record itself.

Checks: `cf dns records list --zone bascik.dev` (no `CNAME bascik.dev -> bascik.pages.dev`), `cf pages domains list --project-name bascik` (no `bascik.dev`), and `cf workers get bascik` (`references.domains` lists `bascik.dev` when it is a custom domain).

### 4. Docs: Retire the Pages Project

1. Pause the Pages project's automatic builds, production and preview, so it stops building every push: `bascik` > Settings > Builds > Branch control.
2. After the Worker has served bascik.dev for a while, delete the Pages project. This also ends `bascik.pages.dev`.
3. Then remove the `https://:project.pages.dev/*` noindex rule from `docs/src/lib/pages-headers.ts` and its test.

Check: `cf pages get bascik` returns not found.

### 5. Worker Secrets

Neither Worker has secrets or bindings, and neither build needs a secret. If one ever does, set a runtime secret on the Worker, never in a config file:

```sh
cd docs && npx wrangler secret put <NAME>
cd adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare && npx wrangler secret put <NAME>
```

A build-time value goes in a GitHub Actions secret, passed to the build step's `env` only. Check runtime secrets with `cf workers secrets list --worker bascik-streaming-test` (or `--worker bascik`).

## Pages and Workers Differ Here

Measured for bascik.dev by comparing the Pages preview of the same commit with `wrangler dev` (the same asset code as production) and the production demo Worker:

- Trailing-slash and `.html` redirects are `307` on Workers; Pages used `308`. No setting changes it.
- Pages sends `Cache-Control: no-store` on every 404. Workers sends the path's `_headers` value (`public, max-age=0, stale-while-revalidate=86400` for page-shaped URLs), because `_headers` cannot match on status.
- Workers sends an `ETag` on HTML; Pages sent none.
- **Open:** every `@2x` image URL in `/assets/demos/` and `/assets/vscode/` (46 files, 87 references on 18 pages) gets a `307` to its `%40` spelling on Workers. Fix in the image helper in `docs/src/lib/md-renderer.ts` (encode the path segment; Pages serves `%40` too) before the cutover.
- `docs/scripts/generate-git-dates.ts` needs the full git history for sitemap `lastmod` and article dates. Pages cloned shallowly, so the script fetched the rest when `CF_PAGES=1`. The CI deploy job checks out the full history (`fetch-depth: 0`), so the dates are right without that.
- Web Analytics is a zone-level automatic setup (`lite` mode) and is injected at the zone edge, so it keeps working on the Worker. Verified on cloudflare-adapter.bascik.dev, a Worker on the same zone. It is not injected on `pages.dev` or `workers.dev`.
- The zone's browser cache TTL override (`max-age=14400` on files such as `robots.txt`) is a zone setting and applies to the Worker as well.
