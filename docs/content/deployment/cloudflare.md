# Cloudflare Adapter

Deploy a Bascik site to Cloudflare Pages or Workers so a CDN serves your static files and a Worker runs your server scripts, stream scripts, and API routes per request, with no Bascik server process to operate.

## What you get

Build once on Node with `bascik --build --target cloudflare-pages`. The normal `dist/` output is unchanged; alongside it Bascik writes a deployment folder with two halves:

- a **public tree** to upload: every static file plus the generated Worker and its routing table;
- **private request-time code** compiled into that Worker: each `data-bascik-server` and `data-bascik-stream` job, every API route, and the page templates those jobs render into.

At request time the flow is:

1. The CDN answers ordinary static paths directly. The Worker is never invoked for them.
2. Requests for a page with request-time scripts, or for any `/api/` path, invoke the Worker.
3. The Worker resolves every `server` job, commits headers, and streams the document: static HTML first, then each `stream` fragment as it resolves, in source order.

No client-side JavaScript is added, nothing hydrates, and there is no per-fragment HTTP endpoint. A page with stream scripts renders progressively in a browser with JavaScript disabled.

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
bascik --build --target cloudflare-pages
```

The build prints a summary and writes `dist/.bascik/cloudflare-pages/`:

```text
dist/.bascik/cloudflare-pages/
  public/            upload this directory
    _worker.js       the generated Module Worker
    _routes.json     which paths invoke the Worker
    index.html       static pages and assets, unchanged
    ...
  build-info.json    release id, compatibility date, bundle size, routes
```

Pages with request-time scripts are **not** in `public/`. Their templates live inside `_worker.js`, so a routing mistake that lets such a request reach the static layer yields a 404, never a page with inert placeholders.

`--target` needs a complete build and is rejected together with `--only`: a deployment bundle is one consistent release inventory.

## Preview locally

Preview the emitted bundle in Cloudflare's local runtime (workerd), not the Bascik dev server:

```sh
npx wrangler pages dev dist/.bascik/cloudflare-pages/public --compatibility-date=2026-08-01 --compatibility-flags=nodejs_compat
```

Use the compatibility date and flags from `build-info.json`; the generated Worker declares them. The Bascik dev server (`bascik`) is still the fastest loop for authoring components and scripts, but it runs on Node. Preview in workerd before deploying to catch runtime differences such as an unsupported Node module.

## Deploy

```sh
npx wrangler pages deploy dist/.bascik/cloudflare-pages/public --project-name <your-project>
```

Or connect the repository in the Cloudflare dashboard with:

- Build command: `npx bascik --build --target cloudflare-pages`
- Build output directory: `dist/.bascik/cloudflare-pages/public`

Set `BASCIK_SITE_URL` as a build environment variable if the site generates a sitemap or robots.txt.

## Workers Static Assets variant

If you deploy Workers rather than Pages, build with the Workers target:

```sh
bascik --build --target cloudflare-workers
```

This writes `dist/.bascik/cloudflare-workers/` with `worker.js`, a `public/` assets directory, and a `wrangler.jsonc` that binds the assets directory as `ASSETS` and lists the request-time routes under `run_worker_first`. Preview and deploy from that folder:

```sh
cd dist/.bascik/cloudflare-workers
npx wrangler dev
npx wrangler deploy
```

The runtime code is identical in both variants; only the packaging and routing configuration differ.

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

"Manual porting" means the handler function is reusable because it takes a standard `Request`, but you write the platform wrapper, the route table, and the method dispatch yourself. Bascik generates those only for the targets in this table. Additional targets are additive: the same host-neutral execution core runs inside the Cloudflare Worker and the Node server today.

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

## Rollback and diagnostics

Every build has a release id in `build-info.json`. Cloudflare Pages keeps previous deployments; rolling back is a dashboard action or a redeploy of the earlier commit. Errors thrown by handlers are logged to the Worker's console (visible in `wrangler tail` or the dashboard) and never reach the client, which sees a generic `500`.

## Verification status

The adapter is tested in local workerd on every commit: a Node oracle (`bascik --server`) and the emitted Worker serve the same build and are compared for pages, streams, APIs, methods, cookies, errors, and source leakage, with a browser paint test run with JavaScript disabled. A deployed canary on Cloudflare's network is an owner-run release gate; until it is recorded, treat remote routing, CDN buffering, and quota behavior as pending verification rather than proven.

> **Next:** [Custom Adapters](/deployment/custom-adapters) covers building custom deployment adapters. [Overview](/deployment) covers static hosting and the built-in Node server.
