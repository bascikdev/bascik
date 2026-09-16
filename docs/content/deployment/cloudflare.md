# Cloudflare Adapter

Deploy a Bascik site to Cloudflare Workers or Pages so a CDN serves your static files with zero compute overhead, while a generated Worker automatically executes your server scripts, stream scripts, and API routes at the edge, with no separate backend server or manual infrastructure wiring. Inspect live production demonstrations of [server scripts](https://cloudflare-adapter.bascik.dev/server), [stream scripts](https://cloudflare-adapter.bascik.dev/stream), [mixed-page ordering](https://cloudflare-adapter.bascik.dev/mixed), and [edge API routes](https://cloudflare-adapter.bascik.dev/api-demo) at [cloudflare-adapter.bascik.dev](https://cloudflare-adapter.bascik.dev/).

## How it works: CDN-first with Edge Workers

The Cloudflare adapter eliminates the need to run, configure, or pay for a separate origin server for dynamic content:

- **Single unified deployment:** You do not need to host dynamic pages separately or wire up proxy rules between static storage and application servers. A single `bascik --build --target cloudflare` command packages both static assets and edge execution logic into one deployment bundle.
- **Static pages and assets come directly from the CDN:** Pure static HTML pages, CSS, client JavaScript, images, and fonts are served directly by Cloudflare's global edge cache. The Worker is never invoked for these paths, eliminating execution costs and compute latency.
- **Dynamic pages execute inside the Worker:** Pages that contain `<script data-bascik-server>` or `<script data-bascik-stream>` have their compiled HTML templates baked directly into the generated Worker bundle. When a visitor requests a dynamic page, the Worker invokes the server scripts, resolves data from bindings (such as KV or D1) or external APIs, interpolates the values into the page template, and streams the finished HTML to the browser.
- **Zero client-side hydration or API boilerplate:** There is no client-side framework, no hydration step, and no need to manually author `/api/*` endpoints to hydrate client components. The browser receives standard HTML rendered directly from the edge Worker.

## What you get

Build once on Node with `bascik --build --target cloudflare` (or `--target cloudflare-workers`). The normal `dist/` output is unchanged; alongside it Bascik writes a deployment folder with two halves:

- a **public tree** (`public/`): every static file uploaded to Cloudflare's global CDN;
- a **generated Worker bundle** (`worker.js`) and config (`wrangler.jsonc`): each `data-bascik-server` and `data-bascik-stream` job, every API route, and the precompiled page templates those jobs render into.

At request time the flow is:

1. The CDN answers ordinary static paths directly. The Worker is never invoked for them.
2. Requests for a page with request-time scripts, or for any `/api/` path, invoke the Worker based on `run_worker_first`.
3. The Worker resolves every `server` job, commits headers, and streams the document: static HTML first, then each `stream` fragment as it resolves, in source order.

No client-side JavaScript is added, nothing hydrates, and there is no per-fragment HTTP endpoint. A page with stream scripts renders progressively in a browser even with JavaScript disabled.

## Prerequisites

- Node.js 24 for the build.
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

Pages with request-time scripts are **not** in `public/`. Their templates live inside `worker.js`, so a routing mistake that lets such a request reach the static layer yields a 404, never a page with inert placeholders.

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

Or connect the repository with Cloudflare Workers Builds in the dashboard:

- Build command: `npx bascik --build --target cloudflare`
- Root directory: `dist/.bascik/cloudflare`

### Worker Name Resolution

The generated `name` in `wrangler.jsonc` is automatically resolved in priority order:
1. **Environment variables:** `CLOUDFLARE_WORKER_NAME` or `WORKER_NAME` (e.g. `CLOUDFLARE_WORKER_NAME=bascik-streaming-test` in Cloudflare dashboard build settings).
2. **Authored Wrangler config:** An existing `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` in your project root (matching Wrangler discovery precedence, supporting JSONC comments, trailing commas, and TOML syntax).
3. **Project `package.json`:** The `name` property from your root `package.json` (with npm `@scope/` prefixes stripped).
4. **Fallback:** Defaults to `"bascik-site"` only if no project name, config file, or environment variable is found.

Set `BASCIK_SITE_URL` as a build environment variable if the site generates a sitemap or robots.txt.

Wrangler configuration files are parsed strictly with the same parsers Wrangler uses (`jsonc-parser` for JSONC and `smol-toml` for TOML). A malformed configuration file (for example, duplicate TOML keys, unclosed strings, or invalid JSONC) fails the build with an actionable error naming the file and location. Bascik never falls back to a lower-precedence configuration file after a malformed file is selected, and error messages never include configuration values or source excerpts.

## Configuration Ownership and Wrangler Integration

For projects that manage bindings (KV, D1, R2, Vectorize), environment variables (`vars`), named environments (`[env.production]`), custom routes, or observability settings, maintain your own `wrangler.jsonc` (or `wrangler.json` / `wrangler.toml`) in the project root.

Bascik never overwrites or modifies your authored configuration. In your root `wrangler.jsonc`, configure `main` and `assets.directory` to point to Bascik's output artifacts:

```jsonc
{
  "name": "bascik-site",
  "main": "worker.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": [
      "/api/*",
      "/stream"
    ]
  }
}
```

Static requests are served directly from `./public` by the Cloudflare CDN, while paths in `run_worker_first` route directly to `worker.js`.

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

If your project has a root-level `wrangler.jsonc` with `main` pointing to your own worker script, **that wrapper receives every request** only if you set `run_worker_first: ["/*"]`. Without the `/*` pattern, the CDN serves static assets directly, and your wrapper never executes for those paths.

Defining `main: "worker.js"` alone does **not** guarantee the Worker executes before asset serving. The `run_worker_first` array is what controls which paths the Worker handles first. If you only list selective paths (e.g. `["/api/*"]`), the CDN will serve everything else directly, and your wrapper will not run for those paths.

### Middleware Composition Is an Application Responsibility

The Cloudflare adapter does not provide a middleware composition layer. If you need redirects, authentication checks, or custom headers on paths that are also static assets, you must compose that logic in your application-owned worker or use Cloudflare's native features (e.g. `_middleware.js`, `headers`, `redirect` in `wrangler.jsonc`). Bascik's generated Worker handles dynamic pages and API routes; application-owned code is responsible for any additional routing concerns.

### Tradeoff: Routing All Requests Through the Worker

Setting `run_worker_first: ["/*"]` means **every** request passes through the Worker. The Worker then forwards unmatched requests to `env.ASSETS.fetch(request)`, which the CDN serves. The tradeoff is:

- **Pros:** Full control over every request; can enforce redirects, authentication, headers, and observability uniformly.
- **Cons:** Static assets are no longer served directly by the CDN without Worker involvement, increasing latency and compute cost for purely static content.

For most projects, selective `run_worker_first` patterns (only `/api/*` and dynamic page paths) provide the best balance: dynamic content executes in the Worker, while static assets bypass it entirely.

### Keeping Application Configuration Aligned with Bascik's Route Inventory

Bascik generates an inventory of invocation routes during build (`buildInvocationRoutes` in `build.ts`). This inventory includes:

- Every dynamic page alias (e.g. `/`, `/account`, `/account.html`, `/account/`)
- `/api/*` if the project has API routes
- `/_routes.json` and `/_worker.js` (generated control files)
- `/*` if the overflow limit is exceeded

Your application-owned `wrangler.jsonc` `run_worker_first` should reference paths from this generated inventory. Since Bascik writes the `wrangler.jsonc` alongside the build output, the generated routes are stable within a release. If you manually extend `run_worker_first`, ensure the patterns match what Bascik generates, or regenerate after changing page structure or adding API routes.

### Verified Behavior in Local workerd Tests

The following scenarios were validated against local workerd (via `npx wrangler dev`):

| Scenario | Expected Behavior |
|---|---|
| **Static page** (`/`) | CDN serves from `./public`; Worker never invoked |
| **API route** (`/api/run`) | Worker invoked first (listed in `run_worker_first`), dispatches to API handler |
| **Dynamic page** (`/about` with server script) | Worker invoked first, renders template with server data |
| **Dynamic page alias** (`/about.html`) | Worker invoked first, renders corresponding dynamic page |
| **HTML-navigation request** | If path is in `run_worker_first`, Worker handles it; otherwise CDN serves static |
| **Private dynamic templates** | Remain in the Worker's private graph; inaccessible as static files under `./public` |

These behaviors are confirmed by the existing integration tests in `adapters/cloudflare/src/serverless-build.integration.test.ts` and `adapters/cloudflare/src/cloudflare.test.ts`.

Bascik supports two clean configuration ownership workflows:

### 1. Default Generated Configuration (Zero-Configuration Workflow)

By default, running `bascik --build --target cloudflare` generates a complete, self-contained `wrangler.jsonc` in `dist/.bascik/cloudflare/` that points to the compiled `worker.js` and `./public` assets directory.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "bascik-site",
  "main": "worker.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": [
      "/api/*",
      "/stream"
    ]
  }
}
```

Static requests are served directly from `./public` by the Cloudflare CDN, while paths in `run_worker_first` route directly to `worker.js`.

You can run Wrangler commands directly from the output directory:

```sh
cd dist/.bascik/cloudflare
npx wrangler dev
npx wrangler deploy
```

### 2. Application-Authored Wrangler Configuration (Root Config Workflow)

For projects that manage bindings (KV, D1, R2, Vectorize), environment variables (`vars`), named environments (`[env.production]`), custom routes, or observability settings, maintain your own `wrangler.jsonc` (or `wrangler.json` / `wrangler.toml`) in the project root.

Bascik never overwrites or modifies your authored configuration. In your root `wrangler.jsonc`, configure `main` and `assets.directory` to point to Bascik's output artifacts:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-application",
  "main": "dist/.bascik/cloudflare/worker.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist/.bascik/cloudflare/public",
    "binding": "ASSETS",
    "not_found_handling": "404-page"
  },
  "vars": {
    "ENVIRONMENT": "production"
  },
  "kv_namespaces": [
    {
      "binding": "GREETINGS",
      "id": "xxxxxx"
    }
  ]
}
```

With an application-authored root config, run Wrangler from your project root:

```sh
# Local workerd preview with your local bindings and .dev.vars
npx wrangler dev

# Deploy with your project environments and bindings
npx wrangler deploy
```

Local secrets and environment variables can be placed in `.dev.vars` in the project root according to standard Wrangler conventions.

### Composition and Custom Worker Wrappers

If you need custom Cloudflare Worker composition (such as authentication checks, analytics interception, or proxying), you can author an application-owned entry point that wraps Bascik's generated Worker:

```js
// worker-wrapper.js
import bascikWorker from "./dist/.bascik/cloudflare/worker.js";

export default {
  async fetch(request, env, ctx) {
    // Perform custom Cloudflare logic or header transformations here
    return bascikWorker.fetch(request, env, ctx);
  },
};
```

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

## Bindings and secrets

Handlers reach Cloudflare bindings through `context.platform`, which is `undefined` on hosts that offer nothing and `{ name: 'node' }` on the built-in server:

```ts
// src/api/greeting.ts
export const GET = async (
  request: Request,
  context: { params: Record<string, string>; remoteIp: string; platform?: { name: string; env?: Record<string, unknown> } },
) => {
  const kv = context.platform?.env?.GREETINGS as { get(key: string): Promise<string | null> } | undefined;
  const text = (await kv?.get('hello')) ?? 'Hello';
  return Response.json({ text, host: context.platform?.name ?? 'unknown' });
};
```

`context.platform.env` is the Worker's `env` object: KV namespaces, D1 databases, secrets, and service bindings you declare in the Cloudflare dashboard or `wrangler.jsonc`. `context.platform.waitUntil` is the execution context's `waitUntil`. Bascik never copies bindings onto globals or mutates `process.env`; a handler that ignores `context.platform` runs unchanged on every host.

`context.remoteIp` is derived from Cloudflare's `CF-Connecting-IP` header only. `X-Forwarded-For` is never trusted.

## What runs where

| Site shape | Any static host | `bascik --server` | Cloudflare (this guide) | Other serverless hosts |
| :--- | :--- | :--- | :--- | :--- |
| Static pages only | Supported | Supported | Supported | Supported (static upload) |
| `data-bascik-server` pages | No | Supported | Supported | Manual porting |
| `data-bascik-stream` pages | No | Supported | Supported | Manual porting |
| API routes | No | Supported | Supported | Manual porting |

"Manual porting" means the handler function is reusable because it takes a standard `Request`, but you write the platform wrapper, the route table, and the method dispatch yourself. Bascik generates those only for the targets in this table.

Cloudflare Workers and Pages are Bascik's initial official serverless adapters. Future official adapters will expand out-of-the-box platform targets, and developers can author and publish custom adapters for other hosts (such as Fastly, AWS, or Netlify) using the `@bascik/bascik/adapter` contract. See [Custom Adapters](/deployment/custom-adapters) for authoring details.

## Limits that come with the platform

Provider limits are deployment constraints, not Bascik defaults, and they change. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) for your plan. The ones that shape a Bascik site:

- **Node APIs.** The Worker declares `nodejs_compat` for its compatibility date, which provides a subset of `node:*` (`crypto`, `buffer`, `path`, `url`, `util`, `stream`, `events`, and others). Request-time code that imports an unsupported builtin such as `node:child_process` or `node:worker_threads` fails the build with the import chain that reached it. Native addons and subprocesses are not available.
- **No persistent disk.** The runtime filesystem is per-request scratch space. Use KV, D1, R2, or Durable Objects through `context.platform.env` for durable state.
- **Bundle and CPU budgets.** `build-info.json` reports the compiled Worker size. Long-running jobs should move to a queue or a Durable Object; the per-request `scripts.timeout` and `http.apiTimeout` deadlines still apply inside the Worker.
- **Isolate lifecycle.** Module-level state is per isolate and can vanish between requests. Treat it as a cache, never as storage.
- **Database connections.** Use HTTP-based drivers or Cloudflare's connection products; a raw TCP pool that assumes a long-lived process does not fit the model.

## Streaming and caching behavior

The request-time contract is the one documented for [Stream Scripts](/stream-scripts): `server` jobs settle before headers commit, so a failure there can still be a 500 with your authored `500.html`; a `stream` job that fails after commit yields an empty slot and the document completes. Fragments stay in source order behind a bounded lookahead.

Two details are specific to the edge:

- Streamed pages are sent with `Content-Encoding: identity`. The edge would otherwise compress the response on the fly and hold every byte until the stream closes, which defeats the early paint. Buffered pages and static assets keep edge compression.
- Composed responses carry `Cache-Control: private, no-store`, and any `Content-Length`, `ETag`, or `Content-Encoding` a template might have inherited is removed. Personalized output never enters a shared cache.

Every `Set-Cookie` header an API handler returns is preserved individually.

## Why not a separately hosted origin fronted by a Worker

Fetching your static HTML from a second public origin and having a Worker rewrite it costs an extra round trip per request, reintroduces recursion and origin-bypass risks, carries stale compressed headers across the rewrite, and creates two independently versioned deployments that can drift. A Worker also cannot modify HTML the browser has already received from another origin without client-side code. One versioned upload that contains both the assets and the function avoids all of it, which is why the build emits a single folder.

## How this compares to other full-stack frameworks

Modern full-stack web frameworks such as Next.js, Astro, SvelteKit, and Nuxt also offer Cloudflare deployment targets that divide traffic between static CDN assets and edge workers. Bascik adopts the same unified CDN-plus-worker deployment topology, but with a different client runtime footprint:

| Capability | Bascik (`@bascik/adapter-cloudflare`) | Astro (`@astrojs/cloudflare`) | Next.js (`@opennextjs/cloudflare` / Vercel Edge) | SvelteKit / Nuxt / Remix |
| :--- | :--- | :--- | :--- | :--- |
| **Unified CDN + Worker output** | Yes (`wrangler.jsonc` / `_routes.json`) | Yes (`_routes.json`) | Yes (via OpenNext or Vercel) | Yes (`_routes.json`) |
| **Client-side framework runtime** | **Zero JS** (vanilla HTML/CSS/JS only) | Opt-in per island (`client:*`) | Required (React runtime + hydration) | Required (Svelte/Vue/React) |
| **Client hydration overhead** | **0 KB** | 0 KB (unless using interactive islands) | 70–120+ KB base | 20–50+ KB base |
| **Streaming mechanism** | Native HTTP streaming in document order | Native HTTP streaming | React Server Components (RSC) streaming | Framework SSR streaming |
| **Edge Worker bundle content** | Compiled HTML templates + server/stream jobs | Component SSR render functions | React SSR runtime + compiled routes | Framework SSR runtime + virtual DOM |

With Bascik, dynamic edge execution does not force a client-side JavaScript framework or hydration layer onto the visitor. The Worker executes data-fetching scripts at the edge, populates server slots, streams the document progressively, and finishes with zero client hydration overhead.

## Rollback and diagnostics

Every build includes a release identifier in `build-info.json`. Deployments can be rolled back via the Cloudflare dashboard or by redeploying an earlier commit. Errors thrown by server handlers are logged to the Worker console (viewable using `wrangler tail` or in the Cloudflare dashboard) and return an HTTP 500 status to the client without exposing internal traces or system paths.

## Testing and local validation

You can test Cloudflare deployments locally using the same workerd runtime that powers Cloudflare Workers:

- Run `npx wrangler dev` in `dist/.bascik/cloudflare` to preview static routing, server scripts, and API routes locally.
- Use curl with chunked output (`curl -N http://127.0.0.1:8787/<path>`) to inspect progressive streaming responses and timing in real time.
- Verify headers using `curl -i` to confirm static assets receive edge cache headers while dynamic and streamed pages receive `Cache-Control: private, no-store`.

> **Next:** [Custom Adapters](/deployment/custom-adapters) covers building custom deployment adapters. [Overview](/deployment) covers static hosting and the built-in Node server.
