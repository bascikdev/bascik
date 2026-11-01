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
- It reads the build state, the server-script sidecar and the component manifest from the private build folder `.bascik/dist/`, beside `dist/`. A deploy copies both folders from the same build. A page in `dist/` that differs from the build's record (a deploy step that edited it) is served as it is, with one startup warning that names the pages and ends with how to avoid it: make the change in a `post` [exec script](/exec-scripts), which runs before the build records its pages and takes their CSP hashes. The warning compares page HTML only, so a `.bascik/dist/` from a build that changed only server-script source is not detected, and its scripts run. With `contentSecurityPolicy` set, the warning also names changed pages whose inline scripts or styles no longer match the build's hashes, counting only the kinds the policy restricts. Browsers block that code (or report it, with `reportOnly`); a `post` script that makes the same change ships with matching hashes. The server refuses to start only when it cannot run a page: a page names a server script the sidecar does not hold, or a page lost a placeholder the sidecar holds for it. A `post` script that removes a placeholder fails `bascik --build` with the same message, so this refusal catches a `dist/` edited after the build. See [What a static host receives](/deployment#what-a-static-host-receives).
- It executes `data-bascik-server` and `data-bascik-stream` scripts in-process per request.
- It bypasses disk I/O for HTML pages by serving directly from memory.
- For local development with file watching and live reload, run the [Development Server](/development-server) with `bascik` instead.

## CLI Flags

| Flag                | Description                         | Default                               |
| :------------------ | :---------------------------------- | :------------------------------------ |
| `--server`          | Start the production server runtime | `false`                               |
| `--port <number>`   | Port to listen on                   | `8080` (HTTP) or `8443` (HTTPS/HTTP2) |
| `--host <name>`     | Interface to bind                   | `localhost`                           |
| `--config <path>`   | Path to explicit config file        | `bascik.config.js`, `.mjs`, or `.ts`  |
| `--env-file <path>` | Custom environment file path        | `./.env`                              |

```sh
# Run on port 3000 bound to all interfaces
bascik --server --port 3000 --host 0.0.0.0
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

### Rate Limiting

`http.rateLimit` counts requests per client in a sliding window (500 per 10 seconds by default) and answers `429 Too Many Requests` with a `Retry-After` of the window in seconds. An IPv4 address is one client; an IPv6 address counts by its `/64` prefix, because one host or network is usually handed a whole `/64`. The limiter tracks at most 10,000 clients at once (`http.rateLimit.maxTrackedIps`). When the table is full, a new client evicts the one seen least recently, whose count starts over; a full table never refuses a request. A flood from many distinct addresses can therefore reset other clients' counts but cannot lock anyone out. While it lasts, the server logs `rate limiter table full: N identities, evicting the least recently seen` once per window (unless `logging.level` is `error` or `silent`); raise `maxTrackedIps` or rate limit in front of the server. Behind a proxy, set `http.trustProxy` so clients are told apart by `X-Forwarded-For`; for protection against distributed floods, rate limit at the CDN or load balancer as well.

### Server Configuration Options

| Option                         | Type                | Default                       | Description                                                                                                            |
| :----------------------------- | :------------------ | :---------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `http.port`                    | `number`            | `8080` / `8443`               | TCP port to listen on                                                                                                  |
| `http.hostname`                | `string`            | `'localhost'`                 | Network interface to bind                                                                                              |
| `http.compression`             | `boolean`           | `true`                        | Enables automatic Gzip and Brotli compression                                                                          |
| `http.trustProxy`              | `boolean`           | `false`                       | Trust `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` proxy headers                                     |
| `http.rateLimit`               | `boolean \| object` | `true`                        | In-memory sliding-window IP rate limiter (500 requests per 10 s per IP)                                                |
| `http.rateLimit.maxTrackedIps` | `number`            | `10000`                       | Clients the limiter tracks at once; a full table evicts the least recently seen client                                 |
| `http.cacheControl`            | `string \| object`  | `'public, max-age=3600'`      | `Cache-Control` for static files; an object maps file extensions to values                                             |
| `http.timeouts.request`        | `number`            | `30000`                       | Milliseconds to receive a whole request, body included; then `408`. Responses are not limited                          |
| `http.timeouts.headers`        | `number`            | `10000`                       | Milliseconds to receive a request's headers; then `408`. At most `http.timeouts.request` (unset: the lower of the two) |
| `http.timeouts.keepAlive`      | `number`            | `5000`                        | Milliseconds an idle connection waits for its next request before it closes (HTTP/2: no open stream)                   |
| `http.timeouts.drain`          | `number`            | `5000`                        | Milliseconds in-flight requests get to finish on shutdown                                                              |
| `http.maxBodySize`             | `number`            | `1048576` (1MB)               | Maximum request body size in bytes for API routes; a larger body gets `413`                                            |
| `http.apiTimeout`              | `number`            | `10000`                       | Maximum run time of an API route handler in milliseconds                                                               |
| `http.tls`                     | `object`            | `{ enabled: false }`          | TLS / HTTPS and HTTP/2 certificate configuration                                                                       |
| `security.headers`             | `boolean \| object` | `true`                        | The five security headers on every response; an object changes or removes one                                          |
| `security.hsts`                | `boolean \| object` | `true`                        | `Strict-Transport-Security: max-age=31536000` over HTTPS                                                               |
| `security.privateDynamicPages` | `boolean`           | `true`                        | `cache-control: private, no-store` on pages with server or stream scripts                                              |
| `security.hideDotfiles`        | `boolean`           | `true`                        | 404 for paths with a dot segment such as `/.env`, except `/.well-known/`                                               |
| `scripts.renderLimits`         | `object`            | `{ maxInstances: 1000, ... }` | Limits on what one script output may render (see [Configuration](/configuration#scriptsrenderlimits))                  |

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
- `http.timeouts.request` and `http.timeouts.headers` apply to HTTP/1.1 clients. An HTTP/2 connection is closed with `GOAWAY` once it has had no open request for `http.timeouts.keepAlive`; an open request, however quiet, keeps it open. See [`http`](/configuration#http).
- Without `keyFile` and `certFile`, the server creates a certificate for `localhost` on first start, with `mkcert` when it is installed and `openssl` otherwise, saved as `bascik-privkey.pem` and `bascik-cert.pem` in the directory Bascik runs from (the project folder when you start it there). The mkcert certificate covers `localhost`, `127.0.0.1`, and `::1` and is trusted once mkcert's local CA is installed (`mkcert -install`). The openssl certificate is self-signed, with SubjectAltName (SAN) entries for `localhost`, `*.localhost`, `127.0.0.1`, and `::1`; browsers still warn until you trust it.
- Existing `bascik-privkey.pem` and `bascik-cert.pem` files are reused, not regenerated, while the certificate is valid. Delete them after installing mkcert to get a trusted certificate. When the certificate has expired (the openssl one lasts 365 days) or is not valid yet, the server says so and generates a new pair in their place.
- A `certFile` you configured is never replaced: when it has expired or is not valid yet, the server warns, naming the file, and starts with it anyway.
- Keep both files out of version control. `npm create bascik` ignores `*.pem` and `bascik init` adds the two file names to `.gitignore`; a project set up another way needs them added by hand.
- If `keyFile` or `certFile` is set, Bascik never generates a certificate. A configured path that does not exist fails [configuration validation](/configuration#configuration-validation) at startup (`http.tls.keyFile ... file does not exist or is not readable`). If you set only one of the two, the other falls back to the default `bascik-privkey.pem` or `bascik-cert.pem`, and when that default file is missing the server stops with `Custom TLS certificate files are configured but could not be found.`
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

- **Built-in Health Checks:** Point readiness probes at `/_health` (or `/_health/ready`) and liveness probes at `/_health/live`. Readiness answers 503 while the server boots and drains; liveness stays 200 while the process is up.
- **Connection Draining:** In-flight streaming scripts and requests complete within `http.timeouts.drain` before connections close. Forced socket termination only occurs if the deadline expires.

> **Next:** See [Deployment Overview](/deployment) for deployment guides on Node servers, Docker, PM2, and systemd.
