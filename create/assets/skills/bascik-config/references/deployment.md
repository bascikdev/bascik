# Deployment Reference

## Static hosting

```sh
BASCIK_SITE_URL=https://example.com npx bascik --build
```

Upload `dist/` to any static host (Cloudflare Pages, Netlify, Vercel, GitHub Pages, S3). `dist/404.html` is picked up by those hosts automatically. `dist/` is never committed; build it in CI.

Static hosting supports pages, components, build scripts, dynamic routes, and exec scripts. It cannot run `data-bascik-server`, `data-bascik-stream`, or API routes.

## `bascik --server`

Serves a pre-built `dist/` and runs server scripts, stream scripts, and API routes per request.

```sh
bascik --build && bascik --server
```

- HTTP/1.1 by default; HTTP/2 when `http.tls.enabled` is `true`. Without `keyFile`/`certFile`, TLS certificates are generated (mkcert, then openssl). Use certificates from a public CA in production.
- No watching or live reload.
- `GET /_health` returns 200 when ready and 503 while booting or draining.
- A port conflict (`EADDRINUSE`) fails fast instead of choosing another port.
- `src/pages/500.html` is served with status 500 for unhandled errors, with a built-in fallback when absent.

### Automatic hardening

- Security headers on every response: `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`, `permissions-policy: interest-cohort=()`. HSTS (`max-age=31536000; includeSubDomains`) when served over TLS or `x-forwarded-proto: https`.
- Rate limit: 500 requests per 10 seconds per IP, then 429 with `Retry-After`. Behind a proxy the limit applies to the proxy IP unless `http.trustProxy` is on; use the proxy's own limiter for per-client control.
- Path traversal returns 400. Any path segment starting with `.` returns 404 before file lookup, which also keeps `dist/.bascik/` private. The exception is a leading `/.well-known/` (below `base`), served from `dist/.well-known/`; dot segments inside it still return 404.
- Graceful shutdown on SIGTERM and SIGINT: readiness switches to draining, connections stop, cleanup runs, and the process force-exits nonzero if `http.timeouts.drain` (5000 ms) passes.
- Unhandled process errors exit nonzero on purpose; always run under a supervisor.

### Caching and compression

- `http.httpCache` (on under `--server`): strong SHA-256 content-hash `ETag`s, identical across replicas, and `304 Not Modified`. Turn it off when a CDN manages caching.
- `http.cacheControl`: one string, or a per-extension map such as `{ '.woff2': 'public, max-age=31536000, immutable' }`. Unmapped extensions use `public, max-age=3600`. Use `immutable` only for URLs whose content can never change (fingerprinted names or content-hash queries).
- `http.compression`: Brotli or gzip by `Accept-Encoding`. HTML is pre-compressed in the background at startup; assets negotiate on demand (up to 2 MiB) or use `.br`/`.gz` sidecars written by `http.precompress`. Already-compressed formats are skipped. Each encoding gets its own ETag.

### Reverse proxies and CDNs

Set `http.trustProxy: true` behind a CDN or load balancer so rate limiting, request URL origins, and HSTS use `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host`. Never enable it when the server is exposed directly. Forward `X-Real-IP` and any auth headers that server scripts read.

### Hosting patterns

- **VPS:** bind `hostname: '0.0.0.0'`, enable TLS with Let's Encrypt `keyFile`/`certFile`, run as a systemd service with `Restart=on-failure`.
- **Docker:** multi-stage build (`npx bascik --build`, then `npx bascik --server`) with `--restart=unless-stopped`.
- **PaaS (Railway, Render, Fly.io, Heroku):** start command `bascik --build && bascik --server`, port 8080. The platform terminates TLS and forwards cleartext HTTP.

## Serverless bundles (`--target`)

```sh
npm install --save-dev @bascik/adapter-cloudflare
BASCIK_SITE_URL=https://example.com npx bascik --build --target cloudflare
```

- Targets: `cloudflare`, `cloudflare-workers`, `cloudflare-pages`, an installed adapter package, or a local adapter path.
- Output: `dist/.bascik/<name>/` with a `public/` upload tree (static files, the generated Worker, and routing) plus `build-info.json`. The normal `dist/` is unchanged.
- Server scripts, stream scripts, API routes, and dynamic page templates compile into the Worker. Templates are never in `public/`, so a routing miss is a 404.
- Unsupported `node:*` imports (for example `node:child_process`) fail the build with the import chain.
- Streamed pages use `Content-Encoding: identity` so the edge does not buffer them.
- Cannot be combined with `--only`.
- Handlers receive `context.platform = { name: 'cloudflare', env, waitUntil }`.

Read the current guide before deploying: `node <skills-dir>/bascik/scripts/read-doc.mjs /deployment/cloudflare`. Other hosts need a custom adapter (`/deployment/custom-adapters`) built on `@bascik/bascik/adapter` and `@bascik/bascik/runtime`.
