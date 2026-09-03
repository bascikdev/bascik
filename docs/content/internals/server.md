# Server Architecture

Bascik's server infrastructure powers both local development (`bascik`) and per-request production serving (`bascik --server`). Designed as a modular 4-tier pipeline, the server handles request routing, static file serving, `data-bascik-server` request script execution, live reload SSE streams, in-memory caching, port environment overrides, and security hardening.

## Modular Architecture (`server.ts`, `http.ts`, `http2.ts`, `pki.ts`)

Bascik separates protocol management from request routing using a 4-tier architecture:

```text
       [transpile.ts (Dev) / serve.ts (Prod)]
                          │
                          ▼ (startServer)
                 [server.ts Orchestrator]
                          │
                 ┌────────┴────────┐
                 │ (enableTls:     │ (enableTls:
                 │  false)         │  true)
                 ▼                 ▼
             [http.ts]          [pki.ts Cert Gen]
          (HTTP/1.1 Server)        │
                 │                 ▼
                 │             [http2.ts]
                 │          (HTTP/2 Server)
                 │                 │
                 └────────┬────────┘
                          ▼
           [server.ts: createRequestHandler]
                          │
         ┌────────────────┴────────────────┐
         ▼ (HTML pages, both modes)         ▼ (non-HTML static assets, both modes)
  [In-Memory Store (mem.ts)]        [Disk Filesystem (dist/ or on-the-fly)]
         │                                 │
         └────────────────┬────────────────┘
                          ▼
         [data-bascik-server Execution]
                          │
                          ▼
                  [HTTP Response]
```

1. **`server.ts`**: Central server orchestrator. Defines the unified `createRequestHandler()` routing pipeline, `startServerInstance()` port binder, rate limiter, security header handler, and top-level `startServer()` dispatcher.
2. **`http.ts`**: Plaintext HTTP/1.1 server (`node:http`). Wraps `http.IncomingMessage` and `http.ServerResponse` into Bascik's request context.
3. **`http2.ts`**: Opt-in encrypted HTTP/2 server (`node:http2`). Wraps `ServerHttp2Stream` into Bascik's request context.
4. **`pki.ts`**: Generates self-signed TLS certificates when `enableTls: true` is configured and certificate files are missing on disk.

## Plaintext HTTP/1.1 Default vs HTTP/2 TLS

Plaintext HTTP/1.1 is active by default because it works instantly across all local development tools and integrated browsers without untrusted certificate warnings or platform trust setup.

For production HTTP/2 protocol parity during local development, enable TLS in `bascik.config.ts`:

```ts
export default {
  http: {
    tls: {
      enabled: true, // Server boots over https://localhost:8443 (HTTP/2)
    },
  },
};
```

When `enableTls: true` is active, `pki.ts` looks for local `bascik-cert.pem` and `bascik-privkey.pem` files. If missing, it attempts to generate CA-trusted certificates using `mkcert` (if available) or falls back to OpenSSL self-signed certificates.

## Development Server Mode (`bascik`)

During local development, `bascik` compiles pages into memory and starts the watch and live-reload systems.

### In-memory page store (`mem.ts`)

The `MemoryStore` class manages rendered pages during development without writing intermediate files to disk on every edit:

- `#files`: Maps HTTP paths (such as `/getting-started`) to `StoredPage` objects containing raw HTML buffers, pre-compressed Brotli buffers, and component usage lists. `getPageExact` performs `O(1)` exact lookups and handles trailing-slash path resolution (`/blog` vs `/blog/`) directly without redundant Map queries.
- `#components`: Inverted index mapping each component name to the `Set<string>` of page paths using it. This index enables selective re-transpilation when a single component changes.
- `#openPages`: Tracks active SSE live-reload connections by HTTP path. Pages currently open in a browser tab are transpiled first during batch rebuilds (`processPageBatch` and `processAllPages`) so visible tabs refresh immediately without waiting for background pages.

Brotli compression during development uses minimum quality (`BROTLI_MIN_QUALITY = 1`) for instant background compression without clogging Node.js C++ threadpool workers. Under `--build` and `--server`, Brotli compression uses maximum quality (`BROTLI_MAX_QUALITY = 11`) to ensure optimal payload sizes.

### Error page handling

Custom 404 and 500 error pages are supported by filesystem convention:
- `/404`: Rendered from `src/pages/404.html`.
- `/500`: Rendered from `src/pages/500.html`. When an unhandled error occurs during request processing, `onError` serves `/500` with status 500. If missing, it falls back to a clean built-in HTML document. Server stack traces are sent to stderr only and never leaked to response payloads.

### Boot page during startup (`boot-page.ts`)

The development server binds its port immediately while page transpilation runs asynchronously. Requests arriving before a page finishes transpiling receive a lightweight boot page displaying a spinner and status message.

The boot page connects to `/bascik-live-reload`. When the requested page finishes transpiling, the `"transpiled"` event fires, the SSE connection receives a reload signal, and the browser fetches the actual page automatically. Once `watchFiles()` completes the initial build, the `isBooting` flag is cleared and unmatched paths fall through to 404 handling. The boot page is never used in production mode.

> **Developer Experience (DX) & Startup Logging:** Although `startServer()` binds the HTTP port immediately in the background so developers can open the URL at any time (with the boot page serving pending requests), `transpile.ts` delays printing `Server running at http://...` until after all initial tasks (`watchFiles()` and `exec`) finish. This DX design choice ensures the clickable server URL appears as the final line in the terminal output without being scrolled up by page transpilation logs.

### Watch system (`watch.ts`)

Three native filesystem watchers (chokidar) handle source file updates:

1. **Static assets watcher:** Copies non-HTML files in `pages/` to `dist/` on `add` or `change`, deletes them on `unlink`, and triggers a live-reload event.
2. **Page HTML watcher:** Listens for `.html` file changes in `pages/`. Triggers full or single-page transpilation and updates `MemoryStore`.
3. **Component watcher:** Listens for changes in `components/`. On change or deletion, uses the inverted component index (`#components`) to selectively rebuild only affected pages.

### Live reload (`live-reload.ts`, `sse.ts`)

Live reload uses Server-Sent Events (SSE) via `GET /bascik-live-reload`. Bascik injects a lightweight SSE client script into HTML pages in development mode. The SSE system features:
- **Monotonic Generation Counter:** Reload events include an incrementing integer generation counter (`data: reload <gen>`). The client-side script tracks `lastGeneration` and ignores stale, duplicate, or out-of-order reload messages.
- **Reload Coordination:** Reload notifications across asset updates, watched custom paths, exec script completions, and page transpilation are coordinated through SSE generation tracking, ensuring clients reload once on complete batch cycles rather than multiple times.
- **Periodic Heartbeats:** Sends `: ping\n\n` comments every 20 seconds, preventing proxy/VPN idle disconnection.
- **Backpressure Handling:** Honors `res.write()` return values, draining stalled writes and terminating persistently wedged clients.
- **Connection Cap & Cleanup:** Bounded at 200 concurrent SSE streams (`DEFAULT_MAX_SSE_CONNECTIONS`).
- **Build Error Overlay:** Broadcasts `event: build-error` containing file, line, and stack info to display an overlay in the browser, clearing on subsequent successful builds.
- **Auto-reconnection:** Auto-reconnects on browser tab focus or visibility change, and cleanly closes streams on page unload.
- **HEAD Handling:** Responds to `HEAD /bascik-live-reload` with headers only and terminates without holding an open stream.
- **Production Guard:** Stripped completely from `--build` output, returns `404` on `--server`, and runtime-stripped in `serve.ts` as defense in depth.

### Open-page priority transpilation (`partitionByOpenPages`)

When multiple pages must be re-transpiled at once (for example, when modifying a shared component used across many pages, editing an inlined stylesheet, or running `processAllPages()`), compiling every page sequentially before notifying the browser could introduce visible latency on large sites.

Bascik solves this with open-page priority batching (`partitionByOpenPages` in `processing.ts`):

1. **Active tab tracking:** Each active browser tab connected to `GET /bascik-live-reload` registers its normalized HTTP route in `mem.openPages` (derived from the HTTP `Referer` header).
2. **Queue partitioning:** When a batch transpilation begins, the page list is split into `openPages` (pages currently open in at least one browser tab) and `restPages` (all other pages).
3. **Immediate reload emission:** The dev server transpiles all `openPages` first, commits them into `MemoryStore`, and emits the `"transpiled"` event immediately. Connected browser tabs reload in milliseconds.
4. **Background completion:** Once the active tabs have been updated, the remaining pages are transpiled and cached in the background.

This prioritization operates identically whether running on the main thread or across multi-threaded workers via `WorkerPool` (`useWorkers: true`).

## Production Server Mode (`bascik --server`)

When launched with `bascik --server` or `BASCIK_SERVER=1`, Bascik runs as a production HTTP server (`serve.ts`).

### Boot-Time Loading: Pages in Memory, Assets on Disk

Production mode skips file watchers and live-reload injection, but it does **not** skip in-memory page storage. `serve.ts#loadDistIntoMemory` walks the built `dist/` directory at boot and reads every `.html` file into the same `MemoryStore` (`mem.ts`) that dev mode uses, so page lookups and `data-bascik-server` execution are served from memory on every request, identical to dev mode.

Only non-HTML static assets, images, fonts, favicons, the webmanifest, and any other file copied verbatim from `src/pages/`, are read from the `dist/` filesystem per request via `createReadStream`. Component CSS and JavaScript are always inlined into the HTML at build time, so they are already in memory as part of the page buffer; there is no separate in-memory cache for them to miss.

At boot time, `serve.ts` also checks for `dist/.bascik/server-scripts.json`. When present, it registers the sidecar entries into memory. Page HTML templates in `dist/` contain inert placeholder script tags (`<script type="text/bascik-server" data-bascik-server-id="..."></script>`) that reference these entries. On each incoming request, `executeServerScripts` resolves each placeholder by ID, runs the corresponding script with the request context in-process via `ScriptRegistry`, and injects the returned markup into the response.

### Per-request `data-bascik-server` execution (`server-scripts.ts`)

Pages containing `<script data-bascik-server>` blocks are executed on every request:

1. **Request context packaging:** Bascik provides explicit `{ req }` context (`path`, `method`, `headers`, `searchParams`) and `{ signal }` for timeout/cancellation to the script function.
2. **In-process ScriptRegistry execution:** Server scripts run in-process as Node.js ESM modules via `ScriptRegistry`, avoiding the overhead and concurrency limits of child processes. Top-level `await` and `import` are fully supported.
3. **Markup injection:** The script's returned markup replaces the `<script data-bascik-server>` tag in the response HTML.
4. **Source remapping:** Exceptions and stack traces are remapped back to source HTML filenames and line numbers (`stack-trace.ts`).

### Caching and performance (`http.httpCache`)

Production mode enables `http.httpCache: true` by default:

- **ETag support:** Generates strong ETag hashes for HTML responses and returns `304 Not Modified` when the client's `if-none-match` header matches.
- **Cache-Control headers:** Adds `Cache-Control: public, max-age=3600` to static assets.
- **Max-quality Brotli compression:** Uses `BROTLI_MAX_QUALITY = 11` for optimal bandwidth savings.

### Production rate limiting

Production mode enforces a sliding-window rate limit per IP address (by default **500 requests per 10-second window**). Clients exceeding the limit receive `429 Too Many Requests` with a `Retry-After` header.

- **Sliding Sub-Windows:** Uses a ring of 10 sub-buckets per window to smooth boundary bursts and prevent double-budget attacks at window edges.
- **Trust Proxy Support:** When `http.trustProxy: true` is configured, client IP derivation reads the rightmost entry of `X-Forwarded-For` (the address appended by the immediate trusted proxy). When `false` (default), forwarded headers are ignored to prevent spoofing.
- **Bounded Tracking Map:** The internal IP tracking Map is capped (`MAX_TRACKED_IPS = 10_000`). If capacity is saturated by flood attacks, the limiter fails closed to preserve server memory. Periodic cleanup reaps stale entries.
- **Configurable:** Accepts `boolean` or `{ window?: number, max?: number }` in `bascik.config.ts`.
- **SSE Streams:** Excluded from page rate limit checks.
- **Development Mode:** Rate limiting is inactive during development mode.

## Development vs Production Comparison

| Capability | Development (`bascik`) | Production (`bascik --server`) |
| --- | --- | --- |
| Entry Module | `transpile.ts` | `serve.ts` |
| Page Storage | `MemoryStore` in memory (`mem.ts`) | Pre-built files in `dist/` |
| Brotli Quality | `BROTLI_MIN_QUALITY = 1` | `BROTLI_MAX_QUALITY = 11` |
| HTTP Caching | Disabled (`http.httpCache: false`) | Enabled (`http.httpCache: true` with ETags & 304s) |
| Rate Limiting | Disabled | Active (500 req / 10s per IP) |
| Live Reload SSE | Injected & active | Stripped & inactive |
| File Watchers | Active for assets, pages, components | Inactive |
| Boot Page | Active during initial build | Disabled |
| `data-bascik-server` Execution | On-demand per request | Per request |

## Shared Security & Reliability

Both development and production server modes share core security and lifecycle mechanisms:

### Request routing and path normalization

Every incoming request (`req.path`) passes through a deterministic normalization sequence before reaching the static asset or in-memory page resolver:

1. **URL Decomposition (`?` and `#` stripping):** The raw request URI is split on `?` and `#` (`req.path.split(/[?#]/)[0]`) so query parameters and fragments never alter static asset paths or page lookup keys. For example, `/style.css?v=1` or `/about#section` resolve directly to `/style.css` and `/about`.
2. **Percent-Encoding and Control Character Sanitation:** Paths are decoded using `decodeURIComponent()`. Malformed percent-encoding, null bytes (`%00`), control characters (`\r`, `\n`, `\t`), or paths containing `..` traversal patterns immediately yield a `400 Bad Request` with `content-type: text/plain; charset=utf-8`.
3. **Dot-Segment Rejection:** After decoding and traversal validation, any path segment beginning with `.` yields `404 Not Found` before static file lookup. This catches literal and encoded paths such as `/.env`, `/.git/config`, and `/%2Egit/config`, and protects internal output directories such as `dist/.bascik/`.
4. **Base Prefix Stripping:** After security guards pass, the normalized `base` prefix is removed before static assets, live reload, or pages are resolved. Requests outside a non-root base return `404`.
5. **API Route Dispatching:** Matching requests are dispatched to in-process WHATWG `Request`/`Response` handlers loaded via the `ScriptRegistry` before the GET/HEAD method guard. Unexported methods return `405` with `Allow`.
6. **Referer Normalization for SSE Open-Page Tracking:** When browser tabs establish live-reload connections through `/bascik-live-reload`, the server extracts `new URL(req.headers.referer).pathname`, strips the base, and calls `getHttpPath()` to track active tabs accurately.
7. **Page Route Resolution Order:** For page requests, lookup follows a strict priority chain:
   - Exact literal path match (`mem.getPageExact(pathname)`)
   - Strip `.html` extension if present
   - Alternate trailing-slash variant (`/blog` vs `/blog/`)
   - Fallback to full `mem.getPage()` lookup (which returns `/404` if unmapped)
8. **Access Logging Lifecycle:** Requests log when the response completes (`close` or `finish`), capturing full transfer duration. Static asset requests and page responses log status and elapsed duration; `/_health` probes and SSE pings are excluded from access logs.

### Security response headers

Every response includes standard security headers:

| Header | Value |
| --- | --- |
| `x-content-type-options` | `nosniff` |
| `x-frame-options` | `SAMEORIGIN` |
| `referrer-policy` | `strict-origin-when-cross-origin` |
| `cross-origin-opener-policy` | `same-origin-allow-popups` |
| `cross-origin-resource-policy` | `cross-origin` |

### Graceful shutdown sequence and health checks

When receiving `SIGTERM` or `SIGINT`:
1. Server health state changes to `draining`, causing `/_health` readiness checks to immediately return `503 Service Unavailable`.
2. Idle keep-alive connections are closed with `closeIdleConnections()`.
3. The server drains in-flight requests during `http.timeouts.drain` (default 5000 ms).
4. All registered shutdown handlers (watchers, exec child processes) are completed.
5. Sockets and sessions are closed and the process terminates cleanly.

### Port conflict policy

Under `bascik --server`, binding to an occupied port (`EADDRINUSE`) is a fatal error that exits immediately to prevent serving from an unexpected port. Under development mode (`bascik`), port conflicts increment automatically up to 20 attempts.

### Path traversal protection

Static asset requests are normalized and validated to ensure the resolved path remains strictly within the `dist/` directory. Requests attempting path traversal via `/../` receive an immediate `400 Bad Request` response before file I/O occurs.

### Content-Hash ETags and Caching Layer

Static assets and dynamic pages use deterministic SHA-256 content hashes for ETags (computed once and cached in memory per file path), rather than fragile timestamp-based or mtime-based ETags. This prevents cache thrashing across multi-instance load balancers and deploys. Distinct ETags are emitted for compressed representations (e.g. `"hash-br"`).

Compression negotiation supports Brotli (`br`) and Gzip (`gzip`), respecting a size threshold and skipping already-compressed formats (images, videos, WOFF2). 304 Not Modified responses preserve `Vary` and `Cache-Control` headers for downstream proxy compliance.

### Crash Net & Stream Error Handling

Both HTTP/1.1 and HTTP/2 adapters register stream error handlers that identify client disconnects and network resets via `isNetworkResetError`. Errors such as `ECONNRESET`, `EPIPE`, `ECANCELED`, `ERR_HTTP2_STREAM_CANCEL`, `ERR_HTTP2_INVALID_STREAM`, `ERR_HTTP2_INVALID_SESSION`, `ERR_STREAM_WRITE_AFTER_END`, `ERR_STREAM_DESTROYED`, and `ERR_STREAM_ALREADY_FINISHED` are filtered out so client disconnects do not trigger spurious error logs or unhandled stream errors.

Process-level handlers for `unhandledRejection` and `uncaughtException` log full error context and exit with a non-zero code (`1`) to allow external process supervisors (systemd, Docker container restart policies) to restart the process cleanly.

### In-Process Script Module Registry

Dynamic server-side execution (`data-bascik-server` scripts and API routes) uses an in-process module registry (`pkg/src/lib/script-registry.ts`) powered by native dynamic `import()`.

#### Rationale: In-Process vs. Child Process vs. Worker Threads

- **Rejected: Child process per request.** Spawning a fresh Node interpreter plus disk I/O per request per script block incurs 30 to 80 ms of overhead, eliminates caching, and risks fork-bomb resource exhaustion under concurrent load.
- **Rejected: Worker threads pool.** A worker pool requires structured-clone serialization of every request and payload, introduces pool lifecycle overhead, and complicates response streaming without solving event-loop starvation within workers.
- **Adopted: In-process module cache.** Dynamic `import()` leverages Node's native module cache and V8 optimizations, executing request handlers with sub-millisecond dispatch overhead.

#### Caching and Invalidation

- **Production (`bascik --server`):** Modules load once on first request and are cached by resolved absolute file path for the lifetime of the process.
- **Development (`bascik`):** File updates invalidate the registry entry. Cache-busting query URLs ensure edited modules take effect immediately without restarting the server.
- **Error Containment:** A module that throws during load is contained to its own entry and does not poison the registry for other modules or subsequent retries after fixes.

#### Concurrency and State Isolation

Because modules run in-process, handlers receive request data via an explicit context argument rather than process-global state like `process.env`. Concurrently running requests execute asynchronously without leaking per-request context.

#### Timeout, Cancellation, and Limitations

- **Timeout:** Invocations accept a configurable timeout parameter. When a timeout occurs, the runner aborts an `AbortSignal` passed to the handler and returns a structured failure.
- **Synchronous CPU Limitation:** In Node's single-threaded event loop, synchronous blocking loops (such as `while(true)`) cannot be forcibly preempted by an in-process timer. Authors must structure long-running tasks asynchronously.

### Graceful shutdown

The server registers signal handlers for `SIGTERM` and `SIGINT`. Upon receiving a signal, it stops accepting new connections, closes active SSE streams, destroys HTTP/2 sessions, shuts down filesystem watchers, and exits cleanly within a 10-second grace period.

## E2E Server Testing

Server behavior is validated through Playwright E2E suites across four environment configurations:

- `playwright.dev.config.ts`: Dev server (`bascik`) live reload, watchers, and boot page.
- `playwright.server.config.ts`: Production server (`bascik --server`) over HTTP/1.1.
- `playwright.server-http2.config.ts`: Production server over encrypted HTTP/2 (HTTPS).
- `playwright.config.ts`: Static build output serving.
