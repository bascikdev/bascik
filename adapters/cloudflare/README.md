# @bascik/adapter-cloudflare

[![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fadapters%2Fcloudflare%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/adapters/cloudflare/test-coverage.json)
[![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fadapters%2Fcloudflare%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/adapters/cloudflare/test-coverage.json)

Cloudflare Workers with Static Assets and Cloudflare Pages hosting adapter for [Bascik](https://bascik.dev).

## Overview

This adapter compiles Bascik request-time scripts and API routes into a Cloudflare Workers deployment bundle with static asset routing. Install it in a Bascik project that deploys to Cloudflare (Node.js 24.11 or newer), or start one with `npm create bascik my-site -- --template cloudflare`:

```sh
npm install --save-dev @bascik/adapter-cloudflare wrangler
```

See the [Cloudflare deployment guide](https://bascik.dev/deployment/cloudflare) for setup instructions, recipes, and limits.

See it live: [cloudflare-adapter.bascik.dev](https://cloudflare-adapter.bascik.dev/) is a Bascik site deployed with this adapter. Its [book catalog](https://cloudflare-adapter.bascik.dev/catalog?q=monolith) renders the `<book-card>` tags a server script returns, and the [streamed catalog](https://cloudflare-adapter.bascik.dev/catalog-stream) streams them in batches from the Worker.

## Targets and Variants

- `cloudflare` / `cloudflare-workers` (Default): Outputs `worker.js`, `wrangler.jsonc`, and `public/` for Cloudflare Workers with Static Assets.
- `cloudflare-pages` (Legacy): Outputs `public/_worker.js` and `public/_routes.json` for Cloudflare Pages. Set the Pages project's compatibility date (the pinned one or later) and the `nodejs_compat` flag, for Production and Preview, in the dashboard: `wrangler pages deploy` does not set them.

## Quickstart

Develop in Cloudflare's local runtime (workerd), with source watching and browser live reload:

```sh
bascik --target cloudflare
```

Open `http://127.0.0.1:8787`; use `--port` and `--host` to override the public address. Bascik runs full production adapter builds, starts Wrangler, and proxies the runtime over local HTTP. Source edits rebuild the bundle and reload connected browsers. Requests can receive 503 while rebuilding or after a failed build; the watcher stays alive and retries after the next edit. The proxy is HTTP only, regardless of the Node server's TLS configuration. Live reload is injected by the local proxy, never written into production artifacts. Bare `bascik` remains the Node development server.

Build for Cloudflare Workers with Static Assets:

```sh
bascik --build --target cloudflare
```

Preview a production build locally with Wrangler from the emitted target directory (without Bascik's source watcher or live reload):

```sh
cd dist/.bascik/cloudflare
npx wrangler dev
```

Deploy with Wrangler:

```sh
cd dist/.bascik/cloudflare
npx wrangler deploy
```

## Compatibility Date

The adapter pins a supported Cloudflare compatibility date and `nodejs_compat` compatibility flag to ensure local workerd testing parity. An authored `compatibility_date` in your Wrangler config is kept; request-time `node:*` imports are then checked against it (and each `env.<name>` date), since `node:http`, `node:fs`, `node:os` and `node:perf_hooks` exist only from a date on, and the build notes print the date and flags the Worker deploys with.

## Your Wrangler Config

Put a `wrangler.jsonc` (or `wrangler.json` or `wrangler.toml`) in the project root. The build writes `dist/.bascik/cloudflare/wrangler.jsonc` from it and never edits your file.

- **Carried over as written:** every key the adapter does not own, at the top level and in each `env.<name>`: `preview_urls`, `previews`, `workers_dev`, `routes`, `vars`, bindings (`kv_namespaces`, `d1_databases`, `r2_buckets`, ...), `observability`, `limits`, `placement`, and keys the adapter does not know. Wrangler validates them.
- **Owned by the adapter:** `main` (always `worker.js`), `assets.directory` (always `./public`), and `assets.binding` (always `ASSETS`, the binding the generated Worker reads). An authored `main` or `assets.directory` is replaced and the build prints a warning naming the file and key. An authored `assets.binding` other than `ASSETS` fails the build.
- **Merged:** `compatibility_flags` are your flags plus `nodejs_compat`. Your other `assets` keys (`html_handling`, `base_path`, ...) are kept, and your `not_found_handling` replaces the default `404-page`. `assets.run_worker_first` is computed from your pages and API routes; your `true` or `["/*"]` sends every request to the Worker, and other patterns you list are added to the computed ones.
- **Rebased:** paths Wrangler reads relative to the config file are rewritten so they name the same files from the output folder: `$schema`, `tsconfig`, `base_dir`, `build.cwd`, `build.watch_dir`, `d1_databases[].migrations_dir` and `migrations_pattern`, `site.bucket`, `wasm_modules`, `text_blobs`, `data_blobs`, `containers[].image_build_context`, `containers[].images.<name>.dockerfile` and `build_context`, and a `containers[].image` spelled as a path. Two defaults Wrangler takes from the config's folder are written out so they still point at the project root: a `build.command` without `build.cwd` gets `cwd` set to the project root, and a D1 binding with neither `migrations_dir` nor `migrations_pattern` gets `migrations_dir` set to the project's `migrations` folder. Absolute paths and URLs are kept. Other files Wrangler looks for beside the config file, such as `.dev.vars`, `.env` and a default `tsconfig.json`, are not carried over: run `wrangler dev` or `wrangler types` with those files in the output folder, or pass their paths.

The Worker name comes from `CLOUDFLARE_WORKER_NAME`, `WORKER_NAME`, or `CF_PAGES_PROJECT_NAME`, then your config's `name`, then the `package.json` name. The rest of your config is carried over whichever source names the Worker.

## Demo Worker

[cloudflare-adapter.bascik.dev](https://cloudflare-adapter.bascik.dev/) is the E2E fixture, `e2e/fixture/`, deployed as the Worker `cloudflare-adapter`. Its `e2e/fixture/wrangler.jsonc` holds the whole Worker definition: the custom domain (`routes` with `custom_domain: true`), `workers_dev: false`, `preview_urls: true`, and the empty `previews` block that `wrangler preview` requires. The E2E lane builds the fixture with `--target cloudflare-pages`, which does not read that file.

From the repo root:

```sh
yarn adapter:cf:demo:build    # build pkg, the adapter, then the fixture with --target cloudflare
yarn adapter:cf:demo:dev      # watched adapter dev in local workerd on port 8787
yarn adapter:cf:demo:preview  # build, then wrangler preview (a Preview named after the git branch)
yarn adapter:cf:demo:deploy   # build, then wrangler deploy to production
```

The workspace script `demo:dev` runs `bascik --target cloudflare` from the fixture root. `demo:build`, `demo:preview`, and `demo:deploy` remain separate production steps for CI.

Watched development launches Wrangler from the project root, pointing it at the generated Worker config or Pages public directory by absolute path. Its working directory stays valid even when another build replaces the generated output.
Local bindings persist under the project's `.wrangler/state/`, outside generated output, so source rebuilds do not delete KV, D1, R2, or Durable Object data.

## Development

From the repository root:

```sh
yarn adapter:cf:build      # compile dist/
yarn adapter:cf:typecheck  # TypeScript type check
yarn adapter:cf:unit       # unit tests
yarn adapter:cf:coverage   # unit tests with coverage, written to test-coverage.json
yarn adapter:cf:e2e        # build the fixture and run Playwright against it in local workerd
yarn adapter:cf:e2e:dev    # real watched platform runtime and browser reload tests
```

The E2E lanes use the built compiler and adapter, so run `yarn pkg:build && yarn adapter:cf:build` first. The watched lane runs `adapters/e2e/playwright.dev.config.ts` against the real Wrangler runtime; CI runs it separately from production acceptance. `yarn adapter:e2e:dev` runs both platforms after building both adapters.

Cloudflare and Netlify run the same [demo browser contract](https://github.com/bascikdev/bascik/blob/main/adapters/e2e/demo-contract.test.ts)
against their real runtimes. Both demos expose `/`, `/server?name=collin`,
`/stream`, `/stream-append`, `/mixed`, `/catalog`, `/catalog-stream`, `/api-demo`,
`/errors`, and `/static` with matching titles and navigation. The `/static`
page demonstrates scoped client scripts and independent counters; the overview
only links to the demos. The contract checks static
client scripts, escaped input, book rendering and filtering, API dispatch,
no-JavaScript stream ordering, and safe failures. Platform-specific context and
routing assertions remain in this adapter's own suite. Error-demo requests
intentionally generate diagnostics.

CI deploys the demo Worker after every other stage passes, and posts a preview URL on pull requests. [DEPLOYMENT.md](https://github.com/bascikdev/bascik/blob/main/DEPLOYMENT.md) is the runbook.
