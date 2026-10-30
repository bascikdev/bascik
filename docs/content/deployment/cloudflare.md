# Cloudflare Adapter

Deploy a Bascik site to Cloudflare Workers or Pages so a CDN serves your static files with zero compute overhead, while a generated Worker automatically executes your server scripts, stream scripts, and API routes at the edge, with no separate backend server or manual infrastructure wiring.

> **See it live on Cloudflare Workers.** [cloudflare-adapter.bascik.dev](https://cloudflare-adapter.bascik.dev/) is a Bascik site deployed with this adapter. Its home page comes straight from the CDN, and each demo page runs in the generated Worker:
>
> - [Server scripts](https://cloudflare-adapter.bascik.dev/server): request context and platform bindings rendered before headers commit.
> - [In-place skeleton swap](https://cloudflare-adapter.bascik.dev/stream) and [progressive append](https://cloudflare-adapter.bascik.dev/stream-append): stream scripts flushing chunked HTML from the edge.
> - [Mixed server and stream page](https://cloudflare-adapter.bascik.dev/mixed): the mixed-page ordering rule in one response.
> - [Product catalog](https://cloudflare-adapter.bascik.dev/catalog?q=frother) and [streamed catalog](https://cloudflare-adapter.bascik.dev/catalog-stream): server and stream scripts returning `<product-card>` tags that the Worker renders with the component's markup and scoped CSS, including a card whose own server script runs per request.
> - [Edge API client](https://cloudflare-adapter.bascik.dev/api-demo): browser `fetch()` calls to a deployed API route.

## How it works: CDN-first with Edge Workers

The Cloudflare adapter eliminates the need to run, configure, or pay for a separate origin server for dynamic content:

- **Single unified deployment:** You do not need to host dynamic pages separately or wire up proxy rules between static storage and application servers. A single `bascik --build --target cloudflare` command packages both static assets and edge execution logic into one deployment bundle.
- **Static pages and assets come directly from the CDN:** Pure static HTML pages, CSS, client JavaScript, images, and fonts are served directly by Cloudflare's global edge cache. The Worker is never invoked for these paths, eliminating execution costs and compute latency.
- **Dynamic pages execute inside the Worker:** Pages that contain `<script data-bascik-server>` or `<script data-bascik-stream>` have their compiled HTML templates baked directly into the generated Worker bundle. When a visitor requests a dynamic page, the Worker invokes the server scripts, resolves data from bindings (such as KV or D1) or external APIs, interpolates the values into the page template, and streams the finished HTML to the browser.
- **Zero client-side hydration or API boilerplate:** There is no client-side framework, no hydration step, and no need to manually author `/api/*` endpoints to hydrate client components. The browser receives standard HTML rendered directly from the edge Worker.

## What you get

Build once on Node with `bascik --build --target cloudflare` (or `--target cloudflare-workers`). The normal `dist/` output is unchanged; alongside it Bascik writes a deployment folder with two halves:

- a **public tree** (`public/`): every static file uploaded to Cloudflare's global CDN;
- a **generated Worker bundle** (`worker.js`) and config (`wrangler.jsonc`): each `data-bascik-server` and `data-bascik-stream` job, every API route, the precompiled page templates those jobs render into, and the component manifest (`.bascik/dist/components.json`) with the scripts inside components, so component tags the jobs return are rendered in the Worker. See [Returning component tags](/server-scripts#returning-component-tags).

At request time the flow is:

1. The CDN answers ordinary static paths directly. The Worker is never invoked for them.
2. Requests for a page with request-time scripts, or for any `/api/` path, invoke the Worker based on `run_worker_first`.
3. The Worker resolves every `server` job, commits headers, and streams the document: static HTML first, then each `stream` fragment as it resolves, in source order.

No client-side JavaScript is added, nothing hydrates, and there is no per-fragment HTTP endpoint. A page with stream scripts renders progressively in a browser even with JavaScript disabled.

## Start from the template

For a new site, let `create-bascik` set this up:

```sh
npm create bascik@rc my-site -- --template cloudflare
```

The `--` is required: npm keeps flags placed before it for itself and does not pass them on. That is the standard starter with the adapter and Wrangler installed, `npm run build` set to `bascik --build --target cloudflare`, `npm run preview` and `npm run deploy` running Wrangler from the emitted bundle, and a demo page (`src/pages/edge.html`) and API route (`src/api/hello.ts`) that run in the Worker. `npm run dev` is still the Bascik dev server. The rest of this guide applies unchanged; the manual steps below are for adding the adapter to an existing project.

## Prerequisites

- Node.js 22.22 or newer for the build (Node.js 24 LTS recommended).
- `@bascik/adapter-cloudflare` installed in your project:

```sh
npm install --save-dev @bascik/adapter-cloudflare
```

- Wrangler for local preview and deployment:

```sh
npm install --save-dev wrangler
```

## Build

```sh
bascik --build --target cloudflare
```

The build prints a summary and writes `dist/.bascik/cloudflare/` (or `dist/.bascik/<target>/` matching the specified target name):

```text
dist/.bascik/cloudflare/
  public/            static assets directory served by the CDN
    index.html       static pages and assets, unchanged
    ...
  worker.js          the generated Worker bundle
  wrangler.jsonc     Workers static assets and routing configuration
  build-info.json    release id, compatibility date, bundle size, routes
```

The build notes, printed and kept in `build-info.json`, name the manifest's share of the bundle, so a growing component library is visible against the Worker size limit. The demo site reports:

```text
component manifest: 5781 bytes (3 components)
```

A static-only site has no manifest and its `worker.js` is unchanged. A script inside a component is bundled like a page job: one that imports a module the Workers runtime does not provide fails the build with the component's file and line.

Pages with request-time scripts are **not** in `public/`. Their templates live inside `worker.js`, so a routing mistake that lets such a request reach the static layer yields a 404, never a page with inert placeholders.

`public/` is all the asset layer serves. It never holds Bascik's private build folder (`.bascik/dist/`, beside `dist/`) or any other `.bascik` path, and the Worker answers 404 for `/.bascik/` in any letter case.

With a non-root [`base`](/configuration#base) such as `/docs/`, static files are staged below it (`public/docs/index.html`, `public/docs/assets/...`), so the asset layer serves them at the same `/docs/...` URLs that `bascik --server` uses. Nothing is served outside the prefix. The generated control files (`_worker.js`, `_routes.json`) stay at the root of `public/`, where the platform reads them.

`--target` needs a complete build and is rejected together with `--only`: a deployment bundle is one consistent release inventory.

## Preview locally

Preview the emitted bundle in Cloudflare's local runtime (workerd) using Wrangler from the emitted target folder:

```sh
cd dist/.bascik/cloudflare
npx wrangler dev
```

The Bascik dev server (`bascik`) is still the fastest loop for authoring components and scripts, but it runs on Node. Preview in workerd before deploying to catch runtime differences such as an unsupported Node module.

## Deploy

```sh
cd dist/.bascik/cloudflare
npx wrangler deploy
```

Always run Wrangler from the generated folder (or pass `--config dist/.bascik/cloudflare/wrangler.jsonc`). Wrangler reads `main` and `assets.directory` relative to the config file, so the generated config points at the `worker.js` and `public/` beside it. A project made with `create-bascik --template cloudflare` has this as `npm run deploy`.

Set `BASCIK_SITE_URL` as a build environment variable if the site generates a sitemap or robots.txt.

### Deploy from GitHub Actions

A workflow in your repository can build the site and run Wrangler itself. This one deploys every push to `main`, and uploads a Preview version for every push to any other branch without touching production, so each branch keeps its own Preview URL:

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: ["**"] # every branch; tag pushes do not match

# One run per branch at a time, in push order: a newer push to a branch cancels its running
# Preview upload, while a running deploy of main always finishes (a newer push to main
# replaces one that is still waiting, so only the newest waiting push deploys).
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm

      - run: npm ci

      - run: npx bascik --build --target cloudflare
        env:
          BASCIK_SITE_URL: https://shop.example.com

      - name: Upload a Preview version
        if: github.ref != 'refs/heads/main'
        working-directory: dist/.bascik/cloudflare
        # br-<branch>: lowercase letters, digits and single dashes, at most 33 characters.
        run: |
          slug="$(printf '%s' "$BRANCH" | tr -cs 'A-Za-z0-9' '-' | tr 'A-Z' 'a-z' | cut -c1-30 | sed 's/^-//; s/-$//')"
          npx wrangler versions upload --preview-alias "br-${slug:-branch}"
        env:
          BRANCH: ${{ github.ref_name }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy to production
        if: github.ref == 'refs/heads/main'
        working-directory: dist/.bascik/cloudflare
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
```

Before the first run:

- **Check that Preview URLs are on.** Without a `preview_urls` setting, Preview URLs follow `workers_dev`, which is on unless your config has `routes`. A Worker served only on a custom domain therefore needs `preview_urls: true` (see [Worker Previews](#worker-previews)), or the upload succeeds without a Preview URL. Setting it explicitly avoids surprises either way. Each branch then keeps one URL across pushes, `https://br-<branch>-<worker-name>.<your-subdomain>.workers.dev`, and Wrangler prints it as `Version Preview Alias URL`. For a script, set `WRANGLER_OUTPUT_FILE_PATH` to a file: Wrangler appends one JSON object per command, and the `version-upload` entry has `preview_alias_url`.
- **Create an API token** in the Cloudflare dashboard (My Profile > API Tokens) with **Workers Scripts: Edit** on your account, plus **Workers Routes: Edit** on the zone when your config has `routes` or a custom domain. The "Edit Cloudflare Workers" template grants these and more. Store it as the repository secret `CLOUDFLARE_API_TOKEN`, and your account ID as the repository variable `CLOUDFLARE_ACCOUNT_ID` (Settings > Secrets and variables > Actions).
- **Pin Wrangler** in your `devDependencies`, so `npx wrangler` runs the version your lock file names rather than downloading one.
- **Deploy once from `main`** before relying on Previews: `wrangler versions upload` only adds a version to a Worker that already exists, and fails with "You cannot upload a new version of a Worker that does not yet exist" for a new one.
- **Check `routes` before merging.** Wrangler runs without a terminal in CI, so `wrangler deploy` attaches each custom domain in `routes` without the confirmation it asks for locally, replacing a DNS record or another Worker's custom domain on that hostname.

`wrangler versions upload` is the generally available way to get a Preview from CI, and works without a `previews` block. A Preview alias is a lowercase DNS label: letters, digits and `-`, starting with a letter, and short enough that `<alias>-<worker-name>` fits in 63 characters. The `slug=` line builds one from the branch name: every run of other characters becomes one `-`, the `br-` prefix makes it start with a letter, and a branch name with no letters or digits, such as `_`, falls back to `br-branch`. At 33 characters it fits any Worker name up to 29 characters; lower the `cut` for a longer name. Two branches that differ only in punctuation or case, such as `feature/x` and `feature-x`, or that share their first 30 characters, get the same alias, and each push replaces the other's Preview. Append a few characters of a hash of the branch name to tell them apart if that matters.

The workflow runs only on push, so a pull request shows the checks and Previews of its branch's latest push. A fork's pushes never deploy to your account: the workflow runs in the fork only if its owner turns on Actions there, and then fails on the missing `CLOUDFLARE_API_TOKEN`. To skip it in forks instead, add `if: github.repository == '<owner>/<repo>'` to the job. Run tests in an earlier job of the same workflow and add `needs: [test]` to the deploy job, so nothing deploys when they fail. Keep the concurrency group on the workflow, not on the deploy job: a group holds only one waiting run, and a group on the job alone would let an older push's deploy that finished testing later replace a newer one that was waiting. If the deploy runs from a separate workflow instead, compare `git ls-remote origin "$GITHUB_REF"` with `$GITHUB_SHA` before Wrangler and skip the step when they differ, so an older push never deploys last.

### Deploy from Git with Workers Builds

Workers Builds builds and deploys the Worker on every push to the production branch. In the Cloudflare dashboard, open **Workers & Pages**, then either **Create** > **Import a repository** for a new Worker, or open an existing Worker and use **Settings** > **Build** > **Connect**. Use these build settings for a Bascik project:

| Setting                                    | Value                                                                                          |
| :----------------------------------------- | :--------------------------------------------------------------------------------------------- |
| Root directory                             | The folder with your `package.json` (the repository root for most projects)                    |
| Build command                              | `npm run build`, or `npx bascik --build --target cloudflare`                                   |
| Deploy command                             | `npm run deploy`, or `npx wrangler deploy --config dist/.bascik/cloudflare/wrangler.jsonc`     |
| Enable Preview Builds (**Branch control**) | On, if you want a Preview for each branch                                                      |
| Preview command                            | `npx wrangler preview --config dist/.bascik/cloudflare/wrangler.jsonc`                         |
| Build variables                            | `BASCIK_SITE_URL` for a sitemap or robots.txt; `NODE_VERSION` (22.22 or newer, 24 recommended) |

The root directory is where the build runs, not the folder Wrangler deploys: the generated folder does not exist until the build command has run. Workers Builds installs your dependencies with the package manager your lock file names, and uses the Wrangler version your `package.json` pins.

The Worker you connect must have the same name the generated config has, so set `name` in your own `wrangler.jsonc` (see [Keeping deployment config in the repo](#keeping-deployment-config-in-the-repo)) or set `CLOUDFLARE_WORKER_NAME` as a build variable. Workers Builds stops the deploy when the names differ.

`npx wrangler preview` needs a `previews` block in the config; see [Worker Previews](#worker-previews). Without one, use `npx wrangler versions upload --config dist/.bascik/cloudflare/wrangler.jsonc`, which uploads a version with a Preview URL and leaves production alone.

### Worker Previews

Cloudflare can serve a build that is not in production yet at its own URL. Two keys in your `wrangler.jsonc` control this, and the adapter carries both into the generated config:

- **`preview_urls: true`** gives every uploaded version a Preview URL on `workers.dev`, such as `<version-prefix>-<worker-name>.<your-subdomain>.workers.dev`. Preview URLs work even with `workers_dev: false`, which only turns off the production `<worker-name>.<your-subdomain>.workers.dev` route.
- **`previews`** configures the named Previews that `npx wrangler preview` creates. Wrangler refuses to run `wrangler preview` without this block; an empty `previews: {}` is enough when Previews use the same bindings as production. Put the bindings and `vars` a Preview should use instead (a test KV namespace, a staging API URL) inside it. Assets, compatibility settings and placement stay at the top level.

Create, check and remove a Preview from the generated folder:

```sh
cd dist/.bascik/cloudflare
npx wrangler preview --name milk-frother-sale
npx wrangler preview delete --name milk-frother-sale -y
```

`--name` defaults to the current git branch, which is what Workers Builds uses for branch builds. Wrangler prints the Preview's URLs; `--json` prints them for a script. `wrangler preview` is in open beta, and it uploads code without touching your routes or custom domains.

Preview URLs are public. Cloudflare adds `X-Robots-Tag: noindex` to every `workers.dev` Preview and version URL, so search engines skip those on their own. A Preview URL on a custom domain does not get that header. To keep one out of search results, put Cloudflare Access in front of it, or add a host rule to your `_headers`, written from a `post` [exec script](/exec-scripts) as shown in [Security settings on Cloudflare](#security-settings-on-cloudflare). Previews on `shop.example.com` are served at `<preview-name>.shop.example.com`, and a host placeholder matches one DNS label, so this rule never matches the production domain:

```text
https://:preview.shop.example.com/*
  X-Robots-Tag: noindex
```

`_headers` covers static files. A page or API route the Worker answers gets the header only from your Worker code (see [Sending every header from the Worker](#sending-every-header-from-the-worker)) or from Cloudflare Access.

A custom domain serves Previews when its `routes` entry (the one with `custom_domain: true`) has `previews_enabled: true`. Leave the key out to keep the setting the dashboard shows. See Cloudflare's [Previews documentation](https://developers.cloudflare.com/workers/previews/) for the URL shapes and limits, and [Previews on custom domains](https://developers.cloudflare.com/workers/previews/custom-domains/) for `previews_enabled`.

### Worker Name Resolution

The generated `name` in `wrangler.jsonc` is resolved in this order:

1. **Environment variables:** `CLOUDFLARE_WORKER_NAME`, `WORKER_NAME`, or `CF_PAGES_PROJECT_NAME` (for example `CLOUDFLARE_WORKER_NAME=milk-frother-shop` in the Workers Builds build variables).
2. **Your Wrangler config:** the `name` in a `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` in your project root (first match wins, in that order; JSONC comments, trailing commas and TOML are supported).
3. **Project `package.json`:** the `name` from your root `package.json` (with an npm `@scope/` prefix stripped).
4. **Fallback:** `"bascik-site"`, only if none of the above is found.

Wrangler itself checks `wrangler.json` before `wrangler.jsonc`, so keep only one of the two in your project root: with both, Bascik reads `wrangler.jsonc` and a Wrangler command run from the project root reads `wrangler.json`.

Your config file is read whichever source names the Worker, so an environment variable changes only the name, never the rest of your settings.

Wrangler configuration files are parsed strictly with the same parsers Wrangler uses (`jsonc-parser` for JSONC and `smol-toml` for TOML). A malformed configuration file (for example, duplicate TOML keys, unclosed strings, or invalid JSONC) fails the build with an actionable error naming the file and location. Bascik never falls back to a lower-precedence configuration file after a malformed file is selected, and error messages never include configuration values or source excerpts.

## Configuration Ownership and Wrangler Integration

The generated `dist/.bascik/cloudflare/wrangler.jsonc` is rebuilt on every build, so settings you add to it by hand are lost. Settings that belong to your deployment (bindings, `vars`, named environments, routes and custom domains, Previews, observability) go in a `wrangler.jsonc` (or `wrangler.json` / `wrangler.toml`) in your project root, committed with the site.

### Keeping deployment config in the repo

With a `wrangler.jsonc` in the project root, the build reads it and writes the generated config from it. Bascik never edits your file. Leave out `main` and `assets.directory`: the build supplies both. A shop for the Milk frother might keep this:

```jsonc
// wrangler.jsonc (project root)
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "milk-frother-shop",
  "compatibility_date": "2026-08-01",
  "routes": [{ "pattern": "shop.example.com", "custom_domain": true }],
  "workers_dev": false,
  "preview_urls": true,
  "previews": {},
  "vars": { "ENVIRONMENT": "production" },
  "kv_namespaces": [{ "binding": "STOCK", "id": "<your KV namespace id>" }],
  "assets": { "html_handling": "auto-trailing-slash" },
}
```

`bascik --build --target cloudflare` then writes this beside `worker.js` (the `run_worker_first` routes come from the site's dynamic pages and API routes):

```jsonc
// dist/.bascik/cloudflare/wrangler.jsonc (generated)
{
  "$schema": "../../../node_modules/wrangler/config-schema.json",
  "name": "milk-frother-shop",
  "main": "worker.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "routes": [{ "pattern": "shop.example.com", "custom_domain": true }],
  "workers_dev": false,
  "preview_urls": true,
  "previews": {},
  "vars": { "ENVIRONMENT": "production" },
  "kv_namespaces": [{ "binding": "STOCK", "id": "<your KV namespace id>" }],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "404-page",
    "run_worker_first": ["/api/*", "/stock"],
  },
}
```

A deploy with a `routes` entry that has `custom_domain: true` attaches that domain. Wrangler replaces the Worker's custom domains with the list in the config on every deploy, so a domain you added in the dashboard and left out of `routes` is removed.

### How the build merges your config

The table describes the top level of your config. Inside each `env.<name>` section the build does less, and Wrangler fills in the rest when you deploy with `--env <name>`:

- `main` is removed, with a warning, so every environment runs `worker.js`.
- `compatibility_flags`, when the section has them, get `nodejs_compat` added. A section without them inherits the top-level flags from Wrangler.
- `assets`, when the section has it, is merged with the same rules as the top level. A section without it inherits the top-level `assets`.
- Paths are rewritten as at the top level.
- Everything else, `name` and `compatibility_date` included, is copied as written. An environment with no `name` of its own deploys as `<name>-<environment>`, which is Wrangler's default.

| Your key                                      | In the generated config                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| :-------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                        | Resolved as in [Worker Name Resolution](#worker-name-resolution).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `main`                                        | Always `worker.js`. Yours is replaced, and the build prints a warning that names the file and the key. An `env.<name>.main` is removed, so every environment runs `worker.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `assets.directory`                            | Always `./public`, with a warning if you set it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `assets.binding`                              | Always `ASSETS`, the binding the generated Worker serves static files through. Any other value stops the build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `assets.run_worker_first`                     | The routes the build computes from your dynamic pages, API routes and 404 page, followed by the patterns you list (duplicates removed). Your `true`, or a list with `"/*"` and no `!` patterns, gives `true`: every request reaches the Worker (see [Sending every header from the Worker](#sending-every-header-from-the-worker)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `assets.not_found_handling`                   | Yours if set (for example `"none"` or `"single-page-application"`), otherwise `"404-page"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Other `assets` keys                           | Kept as written (`html_handling`, `base_path`, and so on). An `assets` value that is not an object is ignored, with a warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `compatibility_flags`                         | Your flags plus `nodejs_compat`, duplicates removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `compatibility_date`                          | Yours if set, otherwise the adapter's pinned date.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Paths Wrangler reads from the config's folder | Rewritten so they name the same files from the generated folder: `$schema`, `tsconfig`, `base_dir`, `build.cwd`, `build.watch_dir`, `d1_databases[].migrations_dir` and `migrations_pattern`, `site.bucket`, `wasm_modules`, `text_blobs`, `data_blobs`, `containers[].image_build_context`, `containers[].images.<name>.dockerfile` and `containers[].images.<name>.build_context`, and a `containers[].image` written as a path (starting with `./` or `../`, or naming a Dockerfile). A `d1_databases[]` entry with neither `migrations_dir` nor `migrations_pattern` gets `migrations_dir` set to your project's `migrations` folder, because Wrangler's default (`./migrations` beside the config) would otherwise point inside the generated folder. Absolute paths and URLs are kept. A `build.command` without `build.cwd` gets `cwd` set to your project root. |
| Everything else                               | Copied as written: `preview_urls`, `previews`, `workers_dev`, `routes`, `vars`, every binding, `observability`, `limits`, `placement`, `triggers`, `rules`, and keys the adapter does not know. Wrangler validates them when you run it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The keys come out in this order: `$schema`, `name`, `main`, `compatibility_date`, `compatibility_flags`, your other keys in your order, `env`, `assets`. With no `$schema` of yours, the build writes the path to the `config-schema.json` of the Wrangler your project installs, or leaves the key out when Wrangler is not installed.

Only the `cloudflare` and `cloudflare-workers` targets read your Wrangler config. The `cloudflare-pages` target ignores it.

### Local secrets

Wrangler reads `.dev.vars` from the folder of the config it runs, which is the generated folder, and every build cleans that folder. Keep `.dev.vars` in your project root (and in `.gitignore`), and pass it to `wrangler dev`; Wrangler resolves the path from the generated folder:

```sh
cd dist/.bascik/cloudflare
npx wrangler dev --env-file ../../../.dev.vars
```

Production secrets are not part of any config file. Set them once with `npx wrangler secret put <NAME>` from the generated folder, or in the dashboard under the Worker's **Settings** > **Variables and Secrets**.

### When `run_worker_first` Applies

The `run_worker_first` array lists **exact path patterns** that the Worker must handle **before** the CDN attempts to serve them as static assets. For each path in this list:

- If the path matches a **dynamic page** (one with `<script data-bascik-server>` or `<script data-bascik-stream>`), the Worker renders the page template with server data and streams the result.
- If the path matches an **API route** (`/api/*`), the Worker dispatches to the appropriate API handler.
- If the path matches a **dynamic page alias** (e.g. `/account.html` for `/account`), the Worker renders the corresponding dynamic page.

Requests **not** listed in `run_worker_first` are served directly by the CDN from `./public`; the Worker is never invoked, which eliminates execution cost and latency for purely static content.

### Selective vs. Global `run_worker_first`

- **Selective patterns** (recommended for most projects): Only list paths that must execute server code. Example: `["/api/*", "/stream"]` routes API and stream requests through the Worker, while everything else (`/`, `/about`, `/blog/*`, etc.) is served statically from the CDN.

- **Global `["/*"]`**: Routes **every** request through the Worker first. The Worker then forwards non-matching requests to `env.ASSETS.fetch(request)`, which the CDN serves. This is appropriate when you need **every** request to pass through your middleware (redirects, authentication, headers, observability), but it forfeits the static-asset Worker bypass for all paths.

### Why a Global Application-Owned Wrapper Must Receive Every Request

If you deploy your own Worker script that wraps Bascik's (see [Composition and Custom Worker Wrappers](#composition-and-custom-worker-wrappers)), **that wrapper receives every request** only if its config sets `run_worker_first: true` or `["/*"]`. Without the `/*` pattern, the CDN serves static assets directly, and your wrapper never executes for those paths.

Defining `main: "worker.js"` alone does **not** guarantee the Worker executes before asset serving. The `run_worker_first` array is what controls which paths the Worker handles first. If you only list selective paths (e.g. `["/api/*"]`), the CDN will serve everything else directly, and your wrapper will not run for those paths.

### Middleware Composition Is an Application Responsibility

The Cloudflare adapter does not provide a middleware composition layer. If you need redirects, authentication checks, or custom headers on paths that are also static assets, you must compose that logic in your application-owned worker or use Cloudflare's native features (e.g. `_headers` and `_redirects` files). Bascik's generated Worker handles dynamic pages and API routes; application-owned code is responsible for any additional routing concerns.

### Tradeoff: Routing All Requests Through the Worker

Setting `run_worker_first: ["/*"]` means **every** request passes through the Worker. The Worker then forwards unmatched requests to `env.ASSETS.fetch(request)`, which the CDN serves. The tradeoff is:

- **Pros:** Full control over every request; can enforce redirects, authentication, headers, and observability uniformly.
- **Cons:** Static assets are no longer served directly by the CDN without Worker involvement, increasing latency and compute cost for purely static content.

For most projects, selective `run_worker_first` patterns (only `/api/*` and dynamic page paths) provide the best balance: dynamic content executes in the Worker, while static assets bypass it entirely.

### Keeping Application Configuration Aligned with Bascik's Route Inventory

Bascik generates an inventory of invocation routes during build (`buildInvocationRoutes` in `build.ts`). This inventory includes:

- Every dynamic page alias (e.g. `/`, `/account`, `/account.html`, `/account/`)
- The aliases of a static `404.html` (`/404`, `/404/`, `/404.html`), so the Worker answers the custom 404 page with status `404` at its own URL, as `bascik --server` does, instead of the asset layer's `200`
- `/api/*` if the project has API routes
- `/_routes.json` and `/_worker.js` (generated control files)
- `/*` if the overflow limit is exceeded

You do not copy this inventory into your own config. The build writes it into the generated `wrangler.jsonc` on every build, so it follows new pages and API routes. Patterns you list in your own `assets.run_worker_first` are added after the computed ones, so a path you want the Worker to answer first stays in the list without hiding the routes the build needs.

### Verified Behavior in Local workerd Tests

The following scenarios were validated against local workerd (via `npx wrangler dev`):

| Scenario                                                            | Expected Behavior                                                                                                                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Static page** (`/`)                                               | CDN serves from `./public`; Worker never invoked                                                                                                                                         |
| **API route** (`/api/run`)                                          | Worker invoked first (listed in `run_worker_first`), dispatches to API handler                                                                                                           |
| **Dynamic page** (`/about` with server script)                      | Worker invoked first, renders template with server data                                                                                                                                  |
| **Dynamic page alias** (`/about.html`)                              | Worker invoked first, renders corresponding dynamic page                                                                                                                                 |
| **HTML-navigation request**                                         | If path is in `run_worker_first`, Worker handles it; otherwise CDN serves static                                                                                                         |
| **Private dynamic templates**                                       | Remain in the Worker's private graph; inaccessible as static files under `./public`                                                                                                      |
| **Static page alias** (`/about.html`, `/blog/`, `/docs/index.html`) | The asset layer answers with a `307` redirect to its canonical URL (`/about`, `/blog`, `/docs/`). `bascik --server` serves the same page directly with `200`. Both reach the same bytes. |

These behaviors are confirmed by the existing integration tests in `adapters/cloudflare/src/serverless-build.integration.test.ts` and `adapters/cloudflare/src/cloudflare.test.ts`.

### Without a config of your own

With no `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` in the project root, the build writes a complete config from defaults: the name from [Worker Name Resolution](#worker-name-resolution), the adapter's compatibility date and flags, and the `assets` block.

```jsonc
// dist/.bascik/cloudflare/wrangler.jsonc (generated, no config of yours)
{
  "$schema": "../../../node_modules/wrangler/config-schema.json",
  "name": "milk-frother-shop",
  "main": "worker.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": ["/api/*", "/stream"],
  },
}
```

That is enough for `npx wrangler dev` and `npx wrangler deploy` from `dist/.bascik/cloudflare`. Add your own config when you need anything the defaults do not have.

### Composition and Custom Worker Wrappers

If you need custom Cloudflare Worker composition (such as authentication checks, analytics interception, or proxying), you can author an application-owned entry point that wraps Bascik's generated Worker:

```ts
// worker-wrapper.ts
import bascikWorker from "./dist/.bascik/cloudflare/worker.js";

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: unknown) {
    // Perform custom Cloudflare logic or header transformations here
    return bascikWorker.fetch(request, env, ctx);
  },
};
```

The wrapper is deployed with its own config, because its `main` is the wrapper, not the generated `worker.js`. Give that file a name the build does not read, such as `wrangler.wrapper.jsonc`, so the build does not warn that its `main` and `assets.directory` are ignored. Point it at the generated output and run Wrangler from the project root:

```jsonc
// wrangler.wrapper.jsonc
{
  "name": "milk-frother-shop",
  "main": "worker-wrapper.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist/.bascik/cloudflare/public",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": true,
  },
}
```

```sh
npx wrangler deploy --config wrangler.wrapper.jsonc
```

Copy your bindings and `vars` into this file, since it is the config that deploys. `run_worker_first: true` sends every request to the wrapper; see [Why a Global Application-Owned Wrapper Must Receive Every Request](#why-a-global-application-owned-wrapper-must-receive-every-request).

## Legacy Cloudflare Pages target

If you are maintaining an existing project on Cloudflare Pages, build with the `cloudflare-pages` variant:

```sh
bascik --build --target cloudflare-pages
```

This writes `dist/.bascik/cloudflare-pages/` with `public/_worker.js` and `public/_routes.json`. Preview and deploy with:

```sh
npx wrangler pages dev dist/.bascik/cloudflare-pages/public --compatibility-date=2026-08-01 --compatibility-flags=nodejs_compat
npx wrangler pages deploy dist/.bascik/cloudflare-pages/public --project-name <your-project>
```

The runtime request handling is identical between both variants; only the packaging and routing files differ.

## Moving a static site from Pages to Workers

A Bascik site with no server scripts, stream scripts or API routes does not need the adapter on Workers either. Workers static assets serves the `dist/` of a plain `bascik --build`, the same folder Cloudflare Pages serves, with a Wrangler config and no Worker code.

### The config

Put a `wrangler.jsonc` in the project root:

```jsonc
// wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "milk-frother-docs",
  "compatibility_date": "2026-08-01",
  "assets": {
    "directory": "./dist",
    // /setup serves setup.html; /setup/ and /setup.html redirect to /setup.
    "html_handling": "auto-trailing-slash",
    // An unknown URL gets the nearest 404.html with status 404.
    "not_found_handling": "404-page",
  },
  "workers_dev": false,
  "preview_urls": true,
  "previews": {},
}
```

With no `main`, no Worker code runs and static requests are not billed as Worker invocations. `html_handling: "auto-trailing-slash"` and `not_found_handling: "404-page"` give the URL shape and 404 behavior a Pages site has. `workers_dev: false` leaves your custom domain as the only production host, and `preview_urls` with `previews` turns on [Worker Previews](#worker-previews).

Check the config without deploying: `npx bascik --build`, then `npx wrangler deploy --dry-run` and `npx wrangler dev` to serve `dist/` locally. For Workers Builds, use the same settings as in [Deploy from Git with Workers Builds](#deploy-from-git-with-workers-builds), with `npx bascik --build` as the build command and `npx wrangler deploy` as the deploy command (`npx wrangler preview` for other branches).

Do not add this config to a project that builds with `--target cloudflare`: the adapter reads the same file and ignores its `assets.directory`.

### What carries over

- **`_headers` and `_redirects`** use the same syntax and limits on Workers static assets as on Pages: 100 header rules, 2,000 characters a line, 2,000 static and 100 dynamic redirects, matching header values joined with a comma, and `! Name` to remove a header. Keep writing them into `dist/` from a `post` [exec script](/exec-scripts). Redirects run before asset matching.
- **Cloudflare Web Analytics** set up automatically for the zone keeps working: the beacon is added at the zone's edge, so it reaches a Worker on a custom domain in that zone. It is not added on `workers.dev` or `pages.dev` hosts. If your Content Security Policy already allows `https://static.cloudflareinsights.com`, nothing changes.
- **Zone settings** such as a browser cache TTL override apply to the Worker on the same zone as they did to Pages.

### What changes

- **Redirects are `307`, not `308`.** `/setup/` and `/setup.html` redirect to `/setup` with a temporary redirect on Workers, where Pages used a permanent one. No setting changes this.
- **A 404 gets the `Cache-Control` of the rules its path matches.** Pages sends `no-store` on every 404. Workers sends what your `_headers` rules give that path, and `_headers` cannot match on status. Keep the `Cache-Control` of page-shaped rules short, so a page published at a URL that used to 404 is not hidden behind a cached 404.
- **HTML responses carry an `ETag`**, so a revisit can end in a `304`.
- **An `@` in a file path costs a redirect.** Workers redirects a path that differs from its `encodeURIComponent` form, so `/assets/hero@2x.webp` answers `307` to `/assets/hero%402x.webp`. Reference such files with `%40` (Pages serves both spellings), or name them `hero-2x.webp`.
- **Previews on a custom domain are not marked `noindex`.** Pages added `X-Robots-Tag: noindex` to its preview deployments, and Workers adds it to `workers.dev` Preview URLs. If you serve Previews on a custom domain, add the host rule from [Worker Previews](#worker-previews) to your `_headers` or protect them with Cloudflare Access. Keep any `https://:project.pages.dev/*` rule until the Pages project is deleted.
- **Build environment variables differ.** Workers Builds sets `WORKERS_CI=1`, `WORKERS_CI_BRANCH` and `WORKERS_CI_COMMIT_SHA`, not `CF_PAGES`, `CF_PAGES_BRANCH` or `CF_PAGES_URL`. A build script that checks for Pages (for example to fetch full git history for page dates) must check for both.
- **Ignored files.** Workers static assets does not skip `node_modules`, `.git` or `.DS_Store` on its own; list such files in a `.assetsignore` in the assets folder. A Bascik `dist/` holds none of them.

### Moving the domain without downtime

A Pages custom domain is a `CNAME` record, and a Worker custom domain cannot be created on a hostname that already has one. Cloudflare must also be the nameserver for the domain. To switch without a gap:

1. Deploy the Worker and check it on a Preview URL: status codes, redirects, headers and the 404 page.
2. In the zone, add a Workers route for the domain (for example `docs.example.com/*`) to the new Worker, leaving the Pages custom domain in place. A route runs in front of the proxied hostname, so traffic moves at once, and deleting the route moves it back. Try a narrow route first, such as `docs.example.com/__worker-check*`. An HTML response with an `ETag` came from the Worker; one from Pages has none.
3. Check the live domain again, including the Web Analytics beacon in a browser.
4. Then either keep the route, replace the `CNAME` to Pages with a proxied placeholder record (an `AAAA` record to `100::`), and remove the domain from the Pages project; or remove the domain from Pages, delete the `CNAME`, add the domain to the Worker as a custom domain, and delete the route, which leaves a gap of a few seconds.
5. Put the domain in `routes` in `wrangler.jsonc`, so the repo owns it: the route you kept (`{ "pattern": "docs.example.com/*", "zone_name": "example.com" }`), or the custom domain (`{ "pattern": "docs.example.com", "custom_domain": true }`). A custom domain entry fails to deploy while the hostname still has a `CNAME`.
6. Pause the Pages project's automatic builds, and delete the project once the Worker has served traffic for a while. Deleting it also ends its `pages.dev` address.

## Content-Security-Policy

Set [`contentSecurityPolicy`](/configuration#contentsecuritypolicy) and the generated Worker sends the header, with the build's hashes, on every page it renders, while the build writes exact-path `public/_headers` rules for static pages. No wrapper and no `run_worker_first` are needed. Cloudflare reads at most 100 rules from `_headers` and skips any line over 2000 characters with no error, so a site whose rules would not fit, or a static page whose policy line is too long (one hash for each inline script and style), fails the build with a message that names the count or the page. See [Content Security Policy](/how-to/content-security-policy#cloudflare) and [Sending every header from the Worker](#sending-every-header-from-the-worker).

## Security settings on Cloudflare

The Worker has no config file of its own at request time. The build resolves the [`security`](/configuration#security) settings and [`scripts.stripAnsi`](/configuration#scriptsstripansi) and [`scripts.renderLimits`](/configuration#scriptsrenderlimits) from the default export plus the `build` export, and writes them into the Worker, so a `server` export does not reach Cloudflare. Rebuild after changing them.

- **Binding checks** (`blockScriptUrls`, `blockCodeBindings`) and `stripDirectiveScripts` act at build time, and the component manifest carries the binding settings, so components rendered by the Worker follow the same rules as `bascik --server`.
- **Headers** (`headers`, `hsts`, `privateDynamicPages`) go on every response the Worker answers: pages with server or stream scripts, API routes, and its own 404, 405 and 500 responses. HSTS is sent on `https://` requests.
- **Static files** (pages without server scripts, images, CSS) are served by Cloudflare's asset layer without the Worker, so the build writes the same headers into the generated `public/_headers`, as one site-wide rule at the top of the file. With the defaults it is:

  ```text
  /*
    X-Content-Type-Options: nosniff
    X-Frame-Options: SAMEORIGIN
    Referrer-Policy: strict-origin-when-cross-origin
    Cross-Origin-Opener-Policy: same-origin-allow-popups
    Cross-Origin-Resource-Policy: cross-origin
    Strict-Transport-Security: max-age=31536000
  ```

  The rule follows your settings: an overridden header carries your value, a removed one is left out, and `headers: false` with `hsts: false` writes no rule. Unlike the Worker, the asset layer cannot tell `https://` from `http://`, so static files get HSTS on every response; a browser ignores it over plain HTTP. `_headers` rules never apply to responses the Worker makes itself, and an asset the Worker passes through gets them once, from the asset layer, so no header is sent twice.

  Your own `_headers` rules still work, and they win on the static files they match. Write `dist/_headers` from a `pipeline.exec` script with `phase: "post"` (Bascik does not copy extensionless files from `src/pages`), and the Cloudflare build merges it into the generated file. Cloudflare joins the values when two matching rules set the same header, with a comma, so the build adds a `! Name` line to a rule of yours that sets one of these headers, and your value replaces Bascik's on the static files that rule matches:

  ```text
  /embed/*
    ! X-Frame-Options
    X-Frame-Options: ALLOWALL
  ```

  `_headers` rules apply only to static files. A page with server or stream scripts under `/embed/` is rendered by the Worker and keeps the value from `security.headers`, so the build prints a warning that names your rule and the page. A value meant for every page belongs in [`security.headers`](/configuration#security), which both the Worker and the static rule follow.

  A `/*` rule of your own takes the headers it does not set and becomes the site-wide rule, moved to the top; a header it removes with `! Name` stays removed. Your later rules that set one of the security headers, or a header your `/*` rule sets, get the same `! Name` line, so a more specific rule replaces the earlier value instead of being joined to it, whatever the `security` settings are. When Bascik writes nothing into the file (`headers: false`, `hsts: false` and no `contentSecurityPolicy`), your `_headers` ships exactly as written.

  The site-wide rule counts toward Cloudflare's 100-rule `_headers` limit, together with your rules and the [Content-Security-Policy](#content-security-policy) rules. Cloudflare counts path lines, so a path you write twice counts twice. A build over the limit fails with a message that names the count.

### Sending every header from the Worker

With `"assets": { "run_worker_first": true }` (or `["/*"]`) in your root `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`, every request reaches the Worker first, and `bascik --build --target cloudflare` keeps that setting in the generated config. The build then writes no `_headers` rules of its own: the Worker adds the security headers, and each static page's Content-Security-Policy, to what the asset layer returns, so the 100-rule and 2000-character limits no longer apply. A header your own `_headers` already set on that file is kept. The cost is a Worker invocation for every static file. Cloudflare Pages cannot run the Worker before static files, so this needs the Workers variant.

```jsonc
// wrangler.jsonc
{
  "assets": { "run_worker_first": true },
}
```

- **Dotfiles** (`hideDotfiles`): the Worker answers 404 for dot paths, and with `hideDotfiles: false` the build deploys dotfiles from `src/pages` and the Worker passes their requests to the asset layer. `/.bascik/` is never deployed.

## Bindings and secrets

Handlers reach Cloudflare bindings through `context.platform`, which is `undefined` on hosts that offer nothing and `{ name: 'node' }` on the built-in server:

```ts
// src/api/greeting.ts
export const GET = async (
  request: Request,
  context: {
    params: Record<string, string>;
    remoteIp: string;
    platform?: { name: string; env?: Record<string, unknown> };
  },
) => {
  const kv = context.platform?.env?.GREETINGS as
    { get(key: string): Promise<string | null> } | undefined;
  const text = (await kv?.get("hello")) ?? "Hello";
  return Response.json({ text, host: context.platform?.name ?? "unknown" });
};
```

`context.platform.env` is the Worker's `env` object: KV namespaces, D1 databases, secrets, and service bindings you declare in the Cloudflare dashboard or `wrangler.jsonc`. `context.platform.waitUntil` is the execution context's `waitUntil`. Bascik never copies bindings onto globals or mutates `process.env`; a handler that ignores `context.platform` runs unchanged on every host.

`context.remoteIp` is derived from Cloudflare's `CF-Connecting-IP` header only. `X-Forwarded-For` is never trusted.

## What runs where

| Site shape                 | Any static host | `bascik --server` | Cloudflare (this guide) | Other serverless hosts    |
| :------------------------- | :-------------- | :---------------- | :---------------------- | :------------------------ |
| Static pages only          | Supported       | Supported         | Supported               | Supported (static upload) |
| `data-bascik-server` pages | No              | Supported         | Supported               | Manual porting            |
| `data-bascik-stream` pages | No              | Supported         | Supported               | Manual porting            |
| API routes                 | No              | Supported         | Supported               | Manual porting            |

"Manual porting" means the handler function is reusable because it takes a standard `Request`, but you write the platform wrapper, the route table, and the method dispatch yourself. Bascik generates those only for the targets in this table.

Cloudflare Workers and Pages are Bascik's initial official serverless adapters. Future official adapters will expand out-of-the-box platform targets, and developers can author and publish custom adapters for other hosts (such as Fastly, AWS, or Netlify) using the `@bascik/bascik/adapter` contract. See [Custom Adapters](/deployment/custom-adapters) for authoring details.

## Limits that come with the platform

Provider limits are deployment constraints, not Bascik defaults, and they change. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) for your plan. The ones that shape a Bascik site:

- **Node APIs.** The Worker declares `nodejs_compat` for its compatibility date, which provides a subset of `node:*` (`crypto`, `buffer`, `path`, `url`, `util`, `stream`, `events`, and others). Request-time code that imports an unsupported builtin such as `node:child_process` or `node:worker_threads` fails the build with the import chain that reached it. Native addons and subprocesses are not available.
- **No persistent disk.** The runtime filesystem is per-request scratch space. Use KV, D1, R2, or Durable Objects through `context.platform.env` for durable state.
- **Bundle and CPU budgets.** `build-info.json` reports the compiled Worker size. Long-running jobs should move to a queue or a Durable Object; the per-request `scripts.timeout` and `http.apiTimeout` deadlines still apply inside the Worker.
- **Isolate lifecycle.** Module-level state is per isolate and can vanish between requests. Treat it as a cache, never as storage.
- **Client disconnects during a stream.** Local workerd does not report a disconnect while a streamed slot is still waiting, so an abandoned stream job, or a component script nested in one, runs until `scripts.timeout`; `bascik --server` aborts it at once. Pass the `signal` to your I/O anyway, and keep `scripts.timeout` short.
- **Database connections.** Use HTTP-based drivers or Cloudflare's connection products; a raw TCP pool that assumes a long-lived process does not fit the model.
- **No per-IP rate limit.** `http.rateLimit` is part of `bascik --server`; the Worker does not limit requests per IP. Use Cloudflare's [WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) for the routes that need one, such as API routes and pages with server scripts.
- **No `http.maxBodySize`.** The Worker does not apply `http.maxBodySize` to API request bodies; Cloudflare's request body limit for your plan applies instead (see the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). For a smaller cap, check the `content-length` header in your handler and answer 413, or add a WAF rule.

## Streaming and caching behavior

The request-time contract is the one documented for [Stream Scripts](/stream-scripts): `server` jobs settle before headers commit, so a failure there can still be a 500 with your authored `500.html`; a `stream` job that fails after commit yields an empty slot and the document completes. Fragments stay in source order behind a bounded lookahead.

Two details are specific to the edge:

- Streamed pages are sent with `Content-Encoding: identity`. The edge would otherwise compress the response on the fly and hold every byte until the stream closes, which defeats the early paint. Buffered pages and static assets keep edge compression.
- Composed responses carry `Cache-Control: private, no-store` (unless [`security.privateDynamicPages`](/configuration#security) is off), and any `Content-Length`, `ETag`, or `Content-Encoding` a template might have inherited is removed. Personalized output never enters a shared cache.

Every `Set-Cookie` header an API handler returns is preserved individually.

## Why not a separately hosted origin fronted by a Worker

Fetching your static HTML from a second public origin and having a Worker rewrite it costs an extra round trip per request, reintroduces recursion and origin-bypass risks, carries stale compressed headers across the rewrite, and creates two independently versioned deployments that can drift. A Worker also cannot modify HTML the browser has already received from another origin without client-side code. One versioned upload that contains both the assets and the function avoids all of it, which is why the build emits a single folder.

## How this compares to other full-stack frameworks

Modern full-stack web frameworks such as Next.js, Astro, SvelteKit, and Nuxt also offer Cloudflare deployment targets that divide traffic between static CDN assets and edge workers. Bascik adopts the same unified CDN-plus-worker deployment topology, but with a different client runtime footprint:

| Capability                        | Bascik (`@bascik/adapter-cloudflare`)        | Astro (`@astrojs/cloudflare`)           | Next.js (`@opennextjs/cloudflare` / Vercel Edge) | SvelteKit / Nuxt / Remix            |
| :-------------------------------- | :------------------------------------------- | :-------------------------------------- | :----------------------------------------------- | :---------------------------------- |
| **Unified CDN + Worker output**   | Yes (`wrangler.jsonc` / `_routes.json`)      | Yes (`_routes.json`)                    | Yes (via OpenNext or Vercel)                     | Yes (`_routes.json`)                |
| **Client-side framework runtime** | **Zero JS** (vanilla HTML/CSS/JS only)       | Opt-in per island (`client:*`)          | Required (React runtime + hydration)             | Required (Svelte/Vue/React)         |
| **Client hydration overhead**     | **0 KB**                                     | 0 KB (unless using interactive islands) | 70–120+ KB base                                  | 20–50+ KB base                      |
| **Streaming mechanism**           | Native HTTP streaming in document order      | Native HTTP streaming                   | React Server Components (RSC) streaming          | Framework SSR streaming             |
| **Edge Worker bundle content**    | Compiled HTML templates + server/stream jobs | Component SSR render functions          | React SSR runtime + compiled routes              | Framework SSR runtime + virtual DOM |

With Bascik, dynamic edge execution does not force a client-side JavaScript framework or hydration layer onto the visitor. The Worker executes data-fetching scripts at the edge, populates server slots, streams the document progressively, and finishes with zero client hydration overhead.

## Rollback and diagnostics

Every build includes a release identifier in `build-info.json`. Deployments can be rolled back via the Cloudflare dashboard or by redeploying an earlier commit. Errors thrown by server handlers are logged to the Worker console (viewable using `wrangler tail` or in the Cloudflare dashboard) and return an HTTP 500 status to the client without exposing internal traces or system paths.

## Testing and local validation

You can test Cloudflare deployments locally using the same workerd runtime that powers Cloudflare Workers:

- Run `npx wrangler dev` in `dist/.bascik/cloudflare` to preview static routing, server scripts, and API routes locally.
- Use curl with chunked output (`curl -N http://127.0.0.1:8787/<path>`) to inspect progressive streaming responses and timing in real time.
- Verify headers using `curl -i` to confirm static assets receive edge cache headers while dynamic and streamed pages receive `Cache-Control: private, no-store`.

> **Next:** [Custom Adapters](/deployment/custom-adapters) covers building custom deployment adapters. [Overview](/deployment) covers static hosting and the built-in Node server.
