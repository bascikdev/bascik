# Deploying bascik.dev and the Adapter Demo

This repo deploys two sites to Cloudflare. Everything that can live in the repo does: each Worker is defined by a `wrangler.jsonc`, and root scripts build, check, preview and deploy it. The steps that cannot live in the repo (the Git connection, custom domains, retiring the Pages project) are listed here with a check for each.

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
| `yarn docs:cf:deploy`          | `wrangler deploy` to production. Normally Workers Builds does this.             |
| `yarn adapter:cf:demo:build`   | builds `pkg`, the adapter, then the fixture with `--target cloudflare`          |
| `yarn adapter:cf:demo:dev`     | build, then `wrangler dev` in local workerd from the generated folder           |
| `yarn adapter:cf:demo:preview` | build, then `wrangler preview` from the generated folder                        |
| `yarn adapter:cf:demo:deploy`  | build, then `wrangler deploy` to production. Normally Workers Builds does this. |

The workspace scripts behind them (`yarn workspace bascik-docs cf:*`, `yarn workspace @bascik/adapter-cloudflare demo:*`) run one step each. `docs:cf:dev` serves `docs/dist`; while `yarn docs:dev` owns that folder, serve a separate build with `npx wrangler dev --assets <dir>` from `docs/`. Run Wrangler from the folder that owns the config, or pass `--config`: `npx` from a folder without a `package.json` runs from the nearest workspace and loads that workspace's config.

## State on 2026-10-30

Read with the `cf` CLI (read-only) and `curl`:

- **bascik.dev** is the Pages project `bascik`: production branch `main`, build `yarn pkg:build && yarn docs:build`, output `docs/dist`, root directory empty, previews for all branches. Custom domains `bascik.dev` and `bascik.pages.dev`. DNS: `CNAME bascik.dev -> bascik.pages.dev` (proxied); `www.bascik.dev` is a proxied `CNAME` to `bascik.dev` and answers `301` to `https://bascik.dev`. No Worker named `bascik` exists yet.
- **cloudflare-adapter.bascik.dev** is the Worker `bascik-streaming-test` with the custom domain attached, `workers.dev` off and Preview URLs on (`*-bascik-streaming-test.collin-inbox.workers.dev`). Its newest deployment is 2026-09-13, so `/catalog` and `/catalog-stream` answer `404` live, while the same build in local `wrangler dev` answers `200`.
- **The demo already has a Workers Builds connection** (`bascikdev/bascik`, root `/`), with production build `yarn pkg:build && yarn adapter:cf:build && cd adapters/cloudflare/e2e/fixture && node ../../../../pkg/bin/bascik.js --build --target cloudflare`, deploy `npx wrangler deploy --config adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare/wrangler.jsonc`, `NODE_VERSION=24`, watch paths `pkg/*`, `package.json`, `yarn*`, `adapters/cloudflare/*`. All nine recorded builds ran 2026-09-10 to 2026-09-13 (the successful ones from branch `pre-release-52`); none since, although `main` has moved on. The trigger now names branch `main`; it was modified 2026-10-30 18:59 UTC, so the demo is expected to deploy on the next merge to `main` that touches the watch paths. Until a build succeeds, the demo does not deploy on merge.
- **The demo's preview deploy command is `npx wrangler preview`** with root directory `/`, where there is no Wrangler config, so branch Preview builds fail. Fix it in step 1 below.

## One-Time Steps

These are dashboard or account changes. Do them in order, and run each check before going on.

### 1. Demo: Fix the Workers Builds Settings

Workers & Pages > `bascik-streaming-test` > Settings > Build:

| Setting                                | Value                                                                                                  |
| :------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| Git repository                         | `bascikdev/bascik`, production branch `main`                                                           |
| Root directory                         | `/` (the Yarn workspace root)                                                                          |
| Build command                          | `yarn adapter:cf:demo:build`                                                                           |
| Deploy command                         | `npx wrangler deploy --config adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare/wrangler.jsonc`  |
| Enable Preview Builds (Branch control) | On                                                                                                     |
| Preview command                        | `npx wrangler preview --config adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare/wrangler.jsonc` |
| Build variables                        | `NODE_VERSION=24`                                                                                      |
| Build watch paths                      | `pkg/*`, `adapters/cloudflare/*`, `package.json`, `yarn*` (as now)                                     |

Workers Builds installs with Yarn 4 from the root `packageManager` field and uses the Wrangler version the workspace pins. The deploy fails if the Worker name in the config differs from the connected Worker; both are `bascik-streaming-test`. The cf CLI lists `cf workers-builds workers migrate-to-previews`, which suggests a Worker's branch builds may have to be moved to Previews explicitly; check the Build settings page for that prompt.

Check:

```sh
cf workers get bascik-streaming-test            # note "id", the Worker tag
cf builds workers get <worker-tag>              # repository, branch, commands, previews_base_config
cf builds list --external-script-id <worker-tag> # newest build: branch, commit, outcome
```

Then, after the next merge to `main`:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://cloudflare-adapter.bascik.dev/catalog         # 200
curl -s -o /dev/null -w "%{http_code}\n" https://cloudflare-adapter.bascik.dev/catalog-stream  # 200
```

To check a Preview by hand before relying on branch builds: `yarn adapter:cf:demo:preview` prints the Preview URLs; curl `/`, `/catalog` and `/catalog-stream` on one, then delete it with `npx wrangler preview delete --name <branch> -y` from `adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare`. `cf workers-builds workers previews list --script-tag <worker-tag>` shows what is left.

### 2. Docs: Create the Worker with Workers Builds

Workers & Pages > Create > Import a repository > `bascikdev/bascik`. The Worker name must be `bascik`, as in `docs/wrangler.jsonc`.

| Setting                                | Value                                                                     |
| :------------------------------------- | :------------------------------------------------------------------------ |
| Root directory                         | `/` (empty)                                                               |
| Build command                          | `yarn pkg:build && yarn docs:build`                                       |
| Deploy command                         | `npx wrangler deploy --config docs/wrangler.jsonc`                        |
| Enable Preview Builds (Branch control) | On                                                                        |
| Preview command                        | `npx wrangler preview --config docs/wrangler.jsonc`                       |
| Build variables                        | `NODE_VERSION=24.17.0` (optional: the root `.nvmrc` already says 24.17.0) |
| Build watch paths                      | Default (all files)                                                       |

- Root `/` is preferred: Workers Builds reads the root `.nvmrc` and `packageManager` (`yarn@4.18.0`), and `npx` finds the hoisted Wrangler. `docs` as the root directory also works (the colon-named root scripts run from any workspace), with `npx wrangler deploy` and `npx wrangler preview` as the commands, but Node then falls back to the image default, because `.nvmrc` is at the repo root.
- No other build variables: the docs build script sets `BASCIK_SITE_URL` itself.
- Keep watch paths at the default. The docs build reads `pkg/`, `examples/`, `skills/`, `CHANGELOG.md` and the coverage JSON files.
- Not verified until the first branch build: that `npx wrangler preview` honors `--config` with root `/` (`wrangler preview --help` lists `-c/--config` as a global flag).

Check before merging, from the repo root: `yarn docs:cf:check` (a dry run; with a fresh build it reads about 325 files, uploads a no-op Worker of 0.31 KiB, and finds no bindings). After the first build:

```sh
cf workers get bascik           # exists; "subdomain": enabled false, previews_enabled true
cf builds list --external-script-id <worker-tag>
```

Open a Preview URL and compare it with the Pages preview of the same commit: status, `Location`, `Cache-Control`, `Content-Type`, security headers, and `X-Robots-Tag: noindex` (Cloudflare adds it on `workers.dev` Preview URLs). The expected differences are listed under "Pages and Workers Differ Here" below.

### 3. Docs: Move bascik.dev from Pages to the Worker

bascik.dev is a Pages custom domain, which is the proxied `CNAME bascik.dev -> bascik.pages.dev`. A Worker custom domain cannot be created on a hostname that still has a `CNAME`, so the switch goes through a Workers route first. Add to the Worker, check, then remove from Pages:

1. Add a narrow Workers route in zone `bascik.dev` to Worker `bascik`, such as `bascik.dev/__worker-check*`, and request `https://bascik.dev/__worker-check`. The Worker answers with its 404 page, and HTML from the Worker carries an `ETag`; HTML from Pages has none. That a route takes over from the Pages `CNAME` on this zone is expected but not yet verified, which is why this step comes first.
2. Replace it with the route `bascik.dev/*` to `bascik`. Traffic moves at once, and deleting the route moves it back to Pages.
3. Check `https://bascik.dev`: HTML `ETag` present, the URL matrix from step 2, the 301s for `/semantic-html` and `/name-attribute`, the Web Analytics beacon in a real browser (the zone injects it for browser-like HTML requests only, so plain `curl` never shows it), and `https://www.bascik.dev` still answering `301` to `https://bascik.dev`.
4. Remove the Pages hold on the hostname, choosing one:
   - **Keep the route** (no gap): replace the `CNAME` to Pages with a proxied placeholder `AAAA bascik.dev 100::`, then remove `bascik.dev` from the Pages project's custom domains.
   - **Switch to a Worker custom domain** (a gap of seconds): remove `bascik.dev` from the Pages project, delete the `CNAME`, add `bascik.dev` as the Worker's custom domain, then delete the route.
5. Put the domain in `docs/wrangler.jsonc`, so the repo owns it: `"routes": [{ "pattern": "bascik.dev/*", "zone_name": "bascik.dev" }]` for the route, or `[{ "pattern": "bascik.dev", "custom_domain": true }]` for a custom domain. Only after step 4: a custom domain entry fails to deploy while the `CNAME` exists.

Checks: `cf dns records list --zone bascik.dev` (no `CNAME bascik.dev -> bascik.pages.dev`), `cf pages domains list --project-name bascik` (no `bascik.dev`), and `cf workers get bascik` (`references.domains` lists `bascik.dev` when it is a custom domain).

### 4. Docs: Retire the Pages Project

1. Pause the Pages project's automatic builds, production and preview, so it stops building every push: `bascik` > Settings > Builds > Branch control.
2. After the Worker has served bascik.dev for a while, delete the Pages project. This also ends `bascik.pages.dev`.
3. Then remove the `https://:project.pages.dev/*` noindex rule from `docs/src/lib/pages-headers.ts` and its test.

Check: `cf pages get bascik` returns not found.

### 5. Secrets

Neither Worker has secrets or bindings, and neither build needs a secret. If one ever does, set it on the Worker, never in a config file:

```sh
cd docs && npx wrangler secret put <NAME>
cd adapters/cloudflare/e2e/fixture/dist/.bascik/cloudflare && npx wrangler secret put <NAME>
```

Build-time values go in the Workers Builds build variables (marked secret when they are). Check with `cf workers secrets list --worker bascik-streaming-test` (or `--worker bascik`).

## Pages and Workers Differ Here

Measured for bascik.dev by comparing the Pages preview of the same commit with `wrangler dev` (the same asset code as production) and the production demo Worker:

- Trailing-slash and `.html` redirects are `307` on Workers; Pages used `308`. No setting changes it.
- Pages sends `Cache-Control: no-store` on every 404. Workers sends the path's `_headers` value (`public, max-age=0, stale-while-revalidate=86400` for page-shaped URLs), because `_headers` cannot match on status.
- Workers sends an `ETag` on HTML; Pages sent none.
- **Open:** every `@2x` image URL in `/assets/demos/` and `/assets/vscode/` (46 files, 87 references on 18 pages) gets a `307` to its `%40` spelling on Workers. Fix in the image helper in `docs/src/lib/md-renderer.ts` (encode the path segment; Pages serves `%40` too) before the cutover.
- **Open:** `docs/scripts/generate-git-dates.ts` fetches full git history only when `CF_PAGES=1`. Workers Builds sets `WORKERS_CI=1` instead, so sitemap `lastmod` and article dates lose history until the script also accepts `WORKERS_CI`. Stopgap: prefix the build command with `git fetch --unshallow || true && `.
- Web Analytics is a zone-level automatic setup (`lite` mode) and is injected at the zone edge, so it keeps working on the Worker. Verified on cloudflare-adapter.bascik.dev, a Worker on the same zone. It is not injected on `pages.dev` or `workers.dev`.
- The zone's browser cache TTL override (`max-age=14400` on files such as `robots.txt`) is a zone setting and applies to the Worker as well.
