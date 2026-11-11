# Netlify Adapter

Deploy a Bascik site to Netlify so the CDN serves your static files and one generated Netlify Function runs your server scripts, stream scripts, component tags returned by them, and API routes, with no separate backend server.

> **See it live on Netlify.** [netlify-adapter.bascik.dev](https://netlify-adapter.bascik.dev/) is a Bascik site deployed with this adapter. Its home page comes straight from the CDN, and each demo page runs in the generated function:
>
> - [Server scripts](https://netlify-adapter.bascik.dev/server?name=collin): request context and platform information rendered before headers commit.
> - [In-place skeleton swap](https://netlify-adapter.bascik.dev/stream) and [progressive append](https://netlify-adapter.bascik.dev/stream-append): stream scripts flushing chunked HTML.
> - [Mixed server and stream page](https://netlify-adapter.bascik.dev/mixed): the mixed-page ordering rule in one response.
> - [Book catalog](https://netlify-adapter.bascik.dev/catalog?q=monolith) and [streamed catalog](https://netlify-adapter.bascik.dev/catalog-stream): server and stream scripts returning `<book-card>` tags that the function renders with the component's markup and scoped CSS, including a card whose own server script runs per request.
> - [API client](https://netlify-adapter.bascik.dev/api-demo): browser `fetch()` calls to a deployed API route.

## How it works: CDN-first with Netlify Functions

- **Static pages and assets come from the CDN:** pages without request-time scripts, CSS, client JavaScript, images, and fonts are plain files in `publish/`. The function is never invoked for them.
- **Dynamic pages and API routes run in one function:** `bascik-pages` (Netlify Functions API v2, streaming) carries each `data-bascik-server` and `data-bascik-stream` job, the precompiled templates they render into, every API route in `src/api/`, and the component manifest, so component tags a script returns are rendered with the component's markup and scoped CSS. See [Returning component tags](/scripts#returning-component-tags).
- **Netlify routes only those paths to it:** the function's `config.path` lists every URL of each dynamic page (`/account`, `/account.html`, `/account/`) and each API route, written as URLPattern paths (`/api/items/[id]` becomes `/api/items/:id`, a final `[...rest]` becomes `*`).

The function produces the same status, body bytes, and headers as `bascik --server` for pages, streamed pages, rendered components, and API routes; the adapter's parity tests compare the two on every change.

## What you get

Build once on Node with `bascik --build --target netlify`. The normal `dist/` output is unchanged; alongside it Bascik writes a deployment folder with two halves:

- a **public tree** (`publish/`): static pages and assets served by Netlify's CDN;
- a **generated function bundle** (`functions/bascik-pages.mjs`): request-time scripts, API routes, compiled page templates, and the component manifest used to render component tags returned by scripts.

At request time the flow is:

1. The CDN answers ordinary static paths directly. The function is never invoked for them.
2. Requests for a page with request-time scripts, or for a compiled API route, invoke `bascik-pages`.
3. The function resolves every `server` job, commits headers, and streams the document: static HTML first, then each `stream` fragment as it resolves, in source order.

No client-side JavaScript is added, nothing hydrates, and there is no per-fragment HTTP endpoint. A page with stream scripts renders progressively in a browser even with JavaScript disabled.

## Start from the template

For a new site, let `create-bascik` set this up:

```sh
npm create bascik@rc my-site -- --template netlify
```

The `--` is required: npm keeps flags placed before it for itself. That is the standard starter with the adapter and Netlify CLI installed, `npm run dev` left as `bascik`, `npm run dev:netlify` set to `bascik --target netlify`, `npm run build` set to `bascik --build --target netlify && bascik-netlify-install`, a `netlify.toml` that publishes `publish/` and uses Netlify's `URL` as the site URL unless `BASCIK_SITE_URL` is set, `npm run preview` and `npm run deploy` running the Netlify CLI through `npx`, and a demo page (`src/pages/edge.html`) and API route (`src/api/hello.ts`) that run in the function. The manual steps below are for adding the adapter to an existing project.

## Prerequisites

- Node.js 24.21 or newer for the build.
- `@bascik/adapter-netlify` installed in your project:

```sh
npm install --save-dev @bascik/adapter-netlify
```

- Netlify CLI for local development, preview, and deployment:

```sh
npm install --save-dev netlify-cli
```

## Build

```sh
bascik --build --target netlify && bascik-netlify-install
```

`bascik --build --target netlify` writes the normal `dist/` and, beside it, `dist/.bascik/netlify/` with `publish/` and `functions/bascik-pages.mjs`. Bascik only lets an adapter write inside that folder, so `bascik-netlify-install` is a second step: it replaces `publish/` in the project root with the static files and writes the function to `.netlify/v1/functions/bascik-pages.mjs`, where Netlify's [Frameworks API](https://docs.netlify.com/build/frameworks/frameworks-api/) picks it up next to any functions of your own in `netlify/functions/`.

The installer honors the build configuration's `directory.out` instead of assuming `dist/`. If you build with `--config <path>`, pass the same flag to `bascik-netlify-install`; a missing custom output or invalid configuration is an error, not a fallback to an older build. Before changing either destination, the installer refuses overlap with configured pages, component roots, API sources, `scripts.importRoot`, or its own adapter build, including symlink aliases. Keep `publish/` and the generated function outside your source roots.

Put both commands in `package.json` and point `netlify.toml` at them:

```json
{
  "scripts": {
    "build": "bascik --build --target netlify && bascik-netlify-install"
  }
}
```

```toml
[build]
  command = "npm run build"
  publish = "publish"

[build.environment]
  BASCIK_SITE_URL = "https://example.com"
```

Add `publish/` and `.netlify/` to `.gitignore`; both are build output.

## Deploy

Connect the repository in the Netlify UI, or deploy from your machine with the Netlify CLI after a build:

```sh
npx netlify deploy --build          # a draft deploy
npx netlify deploy --build --prod   # production
```

## Develop locally

Run Netlify Dev with source watching and browser live reload:

```sh
bascik --target netlify
# or, in the Netlify starter: npm run dev:netlify
```

Keep `npm run dev` as plain `bascik` for everyday editing, and give Netlify Dev its own script, such as `"dev:netlify": "bascik --target netlify"`. Do not point `dev` at `netlify dev`: on its own it serves output that is already built, so it neither watches your source nor reloads the browser.

Open `http://127.0.0.1:8888`. Use `--port <n>` and `--host <name>` to override the public address. Bascik performs a full production build with the adapter, installs the generated output for Netlify, and starts Netlify Dev from the project root behind a local HTTP proxy. Source changes rebuild the complete bundle and reload connected browsers, including changes to request-time scripts and API routes.

The proxy is HTTP only; the Node server's TLS setting does not enable HTTPS here. Requests may receive 503 while a build is running or after a build fails. The watcher stays alive and retries on the next edit. Live reload is injected into local HTML responses only, not production artifacts. Bare `bascik` still starts the Node development server.

## Preview locally

`netlify dev` can serve the built output with the function, its routes, and your own functions, as Netlify does:

```sh
npm run build
npx netlify dev --dir publish
```

This previews the production output without Bascik's source watcher or browser live reload. Rebuild after a change, or use `bascik --target netlify` for watched development.

## What runs where

| Request                                                                              | Served by                      |
| ------------------------------------------------------------------------------------ | ------------------------------ |
| A static page, asset, or anything else Bascik did not mark dynamic                   | Netlify's CDN, from `publish/` |
| A page with `data-bascik-server` or `data-bascik-stream` scripts, at any of its URLs | `bascik-pages`                 |
| An API route in `src/api/`                                                           | `bascik-pages`                 |
| `netlify/functions/*` and other Netlify features                                     | Netlify, as usual              |

A page answers `GET` and `HEAD`; any other method is a `405` with `Allow: GET, HEAD`. API routes get every method, as on Node.

## The request context on Netlify

Server scripts, stream scripts, and API routes get `context.platform` as `{ name: "netlify", context, waitUntil }`. `context` is Netlify's own request [Context](https://docs.netlify.com/build/functions/api/) (geo, cookies, site, deploy), and `waitUntil` keeps the function alive for background work after the response. `context.remoteIp` is the client address Netlify reports. Environment variables stay in `process.env`.

```ts
// src/api/where.ts (illustrative)
export const GET = (request: Request, { platform }) => {
  const country = platform.context.geo?.country?.code ?? "unknown";
  return Response.json({ country });
};
```

## Security headers and Content-Security-Policy

The function sends `security.headers`, `security.hsts`, and the opt-in `contentSecurityPolicy` on everything it renders, exactly as `bascik --server` does. For static files, which the CDN serves without the function, the adapter writes `publish/_headers`: one `/*` rule with `security.headers`, and one rule per URL of each static page with that page's Content-Security-Policy. Netlify already sends `Strict-Transport-Security` on HTTPS sites, so the file leaves it out.

Netlify combines the values of a header that several matching rules set and cannot remove one, so the adapter never edits an authored `_headers`. If your site ships its own (`src/pages/_headers`), it is published as written and the build warns: add the headers you want to it. Headers in `netlify.toml` combine the same way, so do not repeat a header there that the adapter writes.

## Logs and diagnostics

`netlify logs --function bascik-pages` shows one JSON line per step, and none of them contain cookie values, query strings, or credentials:

| `event`                           | When                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| `module.loaded`                   | The function starts cold.                                                   |
| `request.start`                   | The first statement of every invocation, before anything else runs.         |
| `script.start`, `script.complete` | Each server, stream, and component script, with its id, mode, and duration. |
| `script.error`, `request.error`   | A failure, with the message and stack.                                      |

A summary line per request (no `event` field) records the method, path, status, duration, mode (`buffered`, `stream`, or `api`), the `x-nf-request-id`, and each cookie's name and size. Every response the function produces carries `X-Bascik-Handler: bascik-pages`.

> **Log text arrives late.** Netlify can deliver a log line's text several minutes after the request; until then `netlify logs` shows the record with an empty message. Wait before treating a blank message as missing logs.

To trace a failed request, take its `x-nf-request-id` (also shown on an `Internal Error. ID: ...` page) and look for its `request.start`. If it remains absent after logs arrive, verify the selected deploy and time window. Failure before invocation is one possibility, but missing logs alone do not prove it. Netlify support can investigate the request id.

## Netlify Identity: keep tokens small

Netlify decodes Identity tokens (the `nf_jwt` cookie or an `Authorization` header) into function context. Large metadata has been associated with platform `Internal Error. ID: ...` responses across functions. The observation below does not establish an exact Netlify token-size limit or the underlying platform mechanism; AWS Lambda's context limit is not a verified Netlify token limit.

Google sign-in is the usual cause: it stores a long `avatar_url` (often over 1 kB) in `user_metadata`, and the token carries all of `user_metadata`. On one deployed site, an account created through Google failed on every function with 1,171 bytes of `user_metadata`, while email accounts with 29 bytes worked, and dropping the avatar fixed it.

If you do not display the avatar, drop it on signup and on every login with Identity event functions. `null`, not a missing key, removes it: Identity deletes `null` keys when it merges the metadata a function returns.

```ts
// netlify/functions/identity-login.ts (illustrative)
export default async (request: Request): Promise<Response> => {
  const { user } = await request.json();
  if (user.user_metadata?.avatar_url == null)
    return new Response(null, { status: 200 });
  return Response.json({
    user_metadata: { ...user.user_metadata, avatar_url: null },
  });
};
```

Return the same `user_metadata` from `identity-signup` for new users. An affected user is fixed after signing out and back in. Keep other large data out of `app_metadata` and `user_metadata` too.

## Adapter acceptance site

Adapter development uses a dedicated [Netlify acceptance site](https://netlify-adapter.bascik.dev),
not an application's production project. Its permanent fixture and Playwright suite
live in `adapters/netlify/e2e/`; from the Bascik monorepo root, run
`yarn adapter:nf:e2e` for offline Netlify Dev, or `yarn adapter:nf:demo:test`
against the hosted site. `yarn adapter:nf:demo:deploy` builds and deploys only that
dedicated project.

Tests cover static/CDN routing, SSR, streaming without JavaScript, runtime components,
APIs, cookies/context, native functions, CSP/security headers, and error diagnostics.
The exact foreign-origin 403 assertion runs hosted only because Netlify Dev 27.14.2
retries function 403s as static paths and returns 404 instead. Identity, OAuth,
database and payments are separate application integrations and are not enabled
or claimed as covered by this fixture.

## Limits

- Netlify's function limits apply to `bascik-pages`: execution time, response size, and memory. See [Netlify Functions](https://docs.netlify.com/build/functions/overview/).
- A streamed page's static prefix and each fragment reach the browser as they resolve. A buffered page (no stream scripts, or a `HEAD` request) is sent whole with a `content-length`.
- Dynamic pages are `cache-control: private, no-store` by default (`security.privateDynamicPages`), so Netlify's CDN does not cache them.
