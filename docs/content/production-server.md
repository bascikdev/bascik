# Production Server

Bascik includes a high-performance, read-only production HTTP/1.1 and HTTP/2 server. `bascik --server` boots directly against the pre-compiled `dist/` directory, loading all HTML documents, inlined styles, and scoped scripts into an in-memory store for instant sub-millisecond page delivery.

## Starting the Production Server

Build your static assets first, then start the production server:

```sh
bascik --build   # compile HTML, CSS, assets to dist/
bascik --server  # launch production HTTP server
```

The production server is read-only and designed for deployment:

- It requires the completed output marker written by `bascik --build`; development output is rejected.
- It loads pre-compiled output from `dist/` and never recompiles source files or deletes output.
- It reads the build state, the server-script sidecar and the component manifest from the private build folder `.bascik/dist/`, beside `dist/`. A deploy copies both folders from the same build. A page in `dist/` that differs from the build's record (a deploy step that edited it, or a `.bascik/dist/` from another build) is served as it is, with one startup warning that names the pages; the server refuses to start only when a page names a server script the sidecar does not hold. See [What a static host receives](/deployment#what-a-static-host-receives).
- It executes `data-bascik-server` and `data-bascik-stream` scripts in-process per request.
- It bypasses disk I/O for HTML pages by serving directly from memory.
- For local development with file watching and live reload, run the [Development Server](/development-server) with `bascik` instead.

## CLI Flags

| Flag                  | Description                         | Default                               |
| :-------------------- | :---------------------------------- | :------------------------------------ |
| `--server`            | Start the production server runtime | `false`                               |
| `--port <number>`     | Port to listen on                   | `8080` (HTTP) or `8443` (HTTPS/HTTP2) |
| `--hostname <string>` | Interface to bind                   | `localhost`                           |
| `--base <path>`       | Deployment path prefix              | `/`                                   |
| `--config <path>`     | Path to explicit config file        | `bascik.config.ts`                    |
| `--env-file <path>`   | Custom environment file path        | `./.env`                              |

```sh
# Run on port 3000 bound to all interfaces
bascik --server --port 3000 --hostname 0.0.0.0
```

## Configuration (`http`)

Configure production server runtime behavior under the `http` key in `bascik.config.ts`:

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  http: {
    port: 8080,
    hostname: "0.0.0.0",
    compression: true,
    trustProxy: true,
    rateLimit: {
      window: 60000,
      max: 1000,
    },
    cacheControl: {
      ".woff2": "public, max-age=31536000, immutable",
      ".png": "public, max-age=86400",
    },
    tls: {
      enabled: false,
      keyFile: "./certs/key.pem",
      certFile: "./certs/cert.pem",
    },
  },
});
```

### Server Configuration Options

| Option                         | Type                     | Default                       | Description                                                                                           |
| :----------------------------- | :----------------------- | :---------------------------- | :---------------------------------------------------------------------------------------------------- |
| `http.port`                    | `number`                 | `8080` / `8443`               | TCP port to listen on                                                                                 |
| `http.hostname`                | `string`                 | `'localhost'`                 | Network interface to bind                                                                             |
| `http.compression`             | `boolean`                | `true`                        | Enables automatic Gzip and Brotli compression                                                         |
| `http.trustProxy`              | `boolean`                | `false`                       | Trust `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` proxy headers                    |
| `http.rateLimit`               | `boolean \| object`      | `true`                        | In-memory sliding-window IP rate limiter (500 requests per 10 s per IP)                               |
| `http.cacheControl`            | `Record<string, string>` | `{}`                          | Custom `Cache-Control` headers matched by file extension                                              |
| `http.timeouts`                | `object`                 | `{}`                          | Socket request, headers, and keep-alive timeout values                                                |
| `http.maxBodySize`             | `number`                 | `1048576` (1MB)               | Maximum payload byte size for API route requests                                                      |
| `http.tls`                     | `object`                 | `{ enabled: false }`          | TLS / HTTPS and HTTP/2 certificate configuration                                                      |
| `security.headers`             | `boolean \| object`      | `true`                        | The five security headers on every response; an object changes or removes one                         |
| `security.hsts`                | `boolean \| object`      | `true`                        | `Strict-Transport-Security: max-age=31536000` over HTTPS                                              |
| `security.privateDynamicPages` | `boolean`                | `true`                        | `cache-control: private, no-store` on pages with server or stream scripts                             |
| `security.hideDotfiles`        | `boolean`                | `true`                        | 404 for paths with a dot segment such as `/.env`, except `/.well-known/`                              |
| `scripts.renderLimits`         | `object`                 | `{ maxInstances: 1000, ... }` | Limits on what one script output may render (see [Configuration](/configuration#scriptsrenderlimits)) |

The server reads its own config, including the `server` export, for every row above. See [`security`](/configuration#security) for what each protection does and what turning it off means.

## Security headers

Every response from `bascik --server`, static files and errors included, carries five headers: `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`, `cross-origin-opener-policy: same-origin-allow-popups` and `cross-origin-resource-policy: cross-origin`. Change or remove one with [`security.headers`](/configuration#securityheaders), for example `{ "x-frame-options": "DENY" }`; an API route's own headers still win.

Over HTTPS the server adds `strict-transport-security: max-age=31536000`. That means a TLS server, or `http.trustProxy` with a proxy that sends `x-forwarded-proto: https`. The default no longer includes `includeSubDomains`; opt in with `security.hsts: { includeSubDomains: true }` only when every subdomain serves HTTPS. See [`security.hsts`](/configuration#securityhsts).

```sh
curl -sI https://localhost:8443/ | grep -i -E 'strict-transport|x-frame|x-content'
```

## Content-Security-Policy

The server sends no CSP by default. Set [`contentSecurityPolicy`](/configuration#contentsecuritypolicy) to send one on every HTML response, built from your directives and each route's hashes from the build; `curl -I` shows it. See [Content Security Policy](/how-to/content-security-policy) for the recipe on this server and on other hosts.

## HTTP/2 & TLS Support

Bascik supports native HTTP/2 over TLS with automatic fallback to HTTP/1.1:

```ts
// bascik.config.ts
export default defineConfig({
  http: {
    port: 8443,
    tls: {
      enabled: true,
      keyFile: "./certs/privkey.pem",
      certFile: "./certs/fullchain.pem",
    },
  },
});
```

When TLS is enabled:

- ALPN negotiation enables HTTP/2 for modern clients and HTTP/1.1 for legacy agents.
- TLS session tickets and SNI routing are configured automatically.
- Development certificates (e.g. generated with `mkcert`) work seamlessly for local HTTPS testing.

## Compression: Brotli & Gzip

When `http.compression: true` is enabled (the default):

- Static HTML pages are pre-compressed with both Brotli and Gzip in the background at startup.
- The server reads each request's `Accept-Encoding` header and picks the best match: Brotli for modern browsers, Gzip for legacy clients, proxies, and crawlers that do not advertise `br`, and uncompressed bytes otherwise. Each variant carries its own `ETag`.
- Fast Brotli and Gzip streams compress static assets based on client `Accept-Encoding`.
- Responses containing streaming scripts (`data-bascik-stream`) skip compression to preserve incremental chunk delivery.

## In-Memory Caching & ETags

On boot, `bascik --server` reads all compiled HTML documents from `dist/` into an in-memory lookup table:

- Page lookups, routing, and header computation take place in memory with zero filesystem access.
- SHA-256 content hashes generate deterministic `ETag` headers, responding with `304 Not Modified` for unchanged client caches.
- Pages are sent with `cache-control: public, max-age=0, must-revalidate`, on the `200` and the `304` alike: the browser keeps the page but asks before each use, so a new deploy shows at once and an unchanged page costs only a `304`. Pages with server or stream scripts get `private, no-store` instead (see `security.privateDynamicPages`). `http.cacheControl` sets the policy for static files, not pages.
- Standalone static assets (images, fonts, downloads) stream from disk using high-speed non-blocking streams.

## Graceful Shutdown & Health Checks

The production server responds to `SIGTERM` and `SIGINT` process signals by stopping acceptance of new TCP connections, closing idle keepalive connections, gracefully waiting for in-flight requests and registered cleanup tasks to finish, and exiting cleanly:

- **Built-in Health Checks:** Deploy `src/api/health.ts` or query `/_health` for orchestrator liveness and readiness probes. Readiness transitions to 503 during draining while liveness remains 200.
- **Connection Draining:** In-flight streaming scripts and requests complete within `http.timeouts.drain` before connections close. Forced socket termination only occurs if the deadline expires.

> **Next:** See [Deployment Overview](/deployment) for deployment guides on Node servers, Docker, PM2, and systemd.
