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
         ▼ (Dev: mem.ts)                   ▼ (Prod: dist/)
  [In-Memory Store]                [Disk Filesystem]
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
  prodServer: {
    enableTls: true, // Server boots over https://localhost:8443 (HTTP/2)
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

Brotli compression during development uses minimum quality (`BROTLI_MIN_QUALITY = 1`) for instant background compression without clogging Node.js C++ threadpool workers.

### Boot page during startup (`boot-page.ts`)

The development server binds its port immediately while page transpilation runs asynchronously. Requests arriving before a page finishes transpiling receive a lightweight boot page displaying a spinner and status message.

The boot page connects to `/bascik-live-reload`. When the requested page finishes transpiling, the `"transpiled"` event fires, the SSE connection receives a reload signal, and the browser fetches the actual page automatically. Once `watchFiles()` completes the initial build, the `isBooting` flag is cleared and unmatched paths fall through to 404 handling. The boot page is never used in production mode.

> **Developer Experience (DX) & Startup Logging:** Although `startServer()` binds the HTTP port immediately in the background so developers can open the URL at any time (with the boot page serving pending requests), `transpile.ts` delays printing `Server running at http://...` until after all initial tasks (`watchFiles()` and `exec`) finish. This DX design choice ensures the clickable server URL appears as the final line in the terminal output without being scrolled up by page transpilation logs.

### Watch system (`watch.ts`)

Three native filesystem watchers (chokidar) handle source file updates:

1. **Static assets watcher:** Copies non-HTML files in `pages/` to `dist/` on `add` or `change`, deletes them on `unlink`, and triggers a live-reload event.
2. **Page HTML watcher:** Listens for `.html` file changes in `pages/`. Triggers full or single-page transpilation and updates `MemoryStore`.
3. **Component watcher:** Listens for changes in `components/`. On change or deletion, uses the inverted component index (`#components`) to selectively rebuild only affected pages.

### Live reload (`live-reload.ts`)

Live reload uses Server-Sent Events (SSE) via `GET /bascik-live-reload`. Bascik injects a lightweight SSE client script into HTML pages in development mode. The script listens for `reload` messages, auto-reconnects instantly when disconnected on browser tab focus or visibility changes (so restarting the dev server reloads your browser as soon as you re-focus the window without manual refresh, while remaining connected without unneeded reloads when active), and cleanly closes streams on page unload. Production builds strip this script entirely. If the dev server is offline, a status banner indicates that auto-reconnection will happen automatically when the server is restarted.

### Open-page priority transpilation (`partitionByOpenPages`)

When multiple pages must be re-transpiled at once (for example, when modifying a shared component used across many pages, editing an inlined stylesheet, or running `processAllPages()`), compiling every page sequentially before notifying the browser could introduce visible latency on large sites.

Bascik solves this with open-page priority batching (`partitionByOpenPages` in `processing.ts`):

1. **Active tab tracking:** Each active browser tab connected to `GET /bascik-live-reload` registers its normalized HTTP route in `mem.openPages` (derived from the HTTP `Referer` header).
2. **Queue partitioning:** When a batch transpilation begins, the page list is split into `openPages` (pages currently open in at least one browser tab) and `restPages` (all other pages).
3. **Immediate reload emission:** The dev server transpiles all `openPages` first, commits them into `MemoryStore`, and emits the `"transpiled"` event immediately. Connected browser tabs reload in milliseconds.
4. **Background completion:** Once the active tabs have been updated, the remaining pages are transpiled and cached in the background.

This prioritization operates identically whether running on the main thread or across multi-threaded workers via `WorkerPool` (`useWorkers: true`).

## Production Server Mode (`bascik --server`)

When launched with `bascik --server` or `BASCIK_PROD_SERVER=1`, Bascik runs as a production HTTP server (`serve.ts`).

### Serving from `dist/`

Production mode skips file watchers, live-reload injection, and in-memory page storage. Instead, it serves static files and HTML directly from the `dist/` directory generated by `bascik --build`.

### Per-request `data-bascik-server` execution (`server-scripts.ts`)

Pages containing `<script data-bascik-server>` blocks are executed on every request:

1. **Request context packaging:** Bascik packages request details (`path`, `method`, `headers`, `searchParams`) into a JSON object set as `process.env.BASCIK_REQUEST`.
2. **Isolated child process execution:** Server scripts run as Node.js ESM modules in isolated child processes with top-level `await` and `import` support.
3. **Stdout injection:** The script's `stdout` output replaces the `<script data-bascik-server>` tag in the response HTML.
4. **Source remapping:** Exceptions and stack traces are remapped back to source HTML filenames and line numbers (`stack-trace.ts`).

### Caching and performance (`cacheHttp`)

Production mode enables `cacheHttp: true` by default:

- **ETag support:** Generates strong ETag hashes for HTML responses and returns `304 Not Modified` when the client's `if-none-match` header matches.
- **Cache-Control headers:** Adds `Cache-Control: public, max-age=3600` to static assets.
- **Max-quality Brotli compression:** Uses `BROTLI_MAX_QUALITY = 11` for optimal bandwidth savings.

### Production rate limiting

Production mode enforces a rate limit of **500 requests per 10-second window per IP address** by default. Clients exceeding the limit receive `429 Too Many Requests` with a `Retry-After` header. Rate limiting is inactive during development mode, and can be disabled via `prodServer: { rateLimit: false }` in `bascik.config.ts`.

## Development vs Production Comparison

| Capability | Development (`bascik`) | Production (`bascik --server`) |
| --- | --- | --- |
| Entry Module | `transpile.ts` | `serve.ts` |
| Page Storage | `MemoryStore` in memory (`mem.ts`) | Pre-built files in `dist/` |
| Brotli Quality | `BROTLI_MIN_QUALITY = 1` | `BROTLI_MAX_QUALITY = 11` |
| HTTP Caching | Disabled (`cacheHttp: false`) | Enabled (`cacheHttp: true` with ETags & 304s) |
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
2. **Percent-Encoding and Traversal Sanitation:** Paths are decoded using `decodeURIComponent()`. Malformed percent-encoding or paths containing `..` traversal patterns immediately yield a `400 Bad Request`.
3. **Referer Normalization for SSE Open-Page Tracking:** When browser tabs establish live-reload connections to `/bascik-live-reload`, the server extracts `new URL(req.headers.referer).pathname` before calling `getHttpPath()`. Query strings in the address bar (such as `/faq?tab=settings`) are stripped out so `mem.trackOpenPage()` tracks `/faq` accurately and selective reload filtering matches correctly.
4. **Page Route Resolution Order:** For page requests, lookup follows a strict priority chain:
   - Exact literal path match (`mem.getPageExact(pathname)`)
   - Strip `.html` extension if present
   - Alternate trailing-slash variant (`/blog` vs `/blog/`)
   - Fallback to full `mem.getPage()` lookup (which returns `/404` if unmapped)
5. **Server Script Parameter Parsing:** For pages containing `<script data-bascik-server>`, the original query string is isolated (`req.path.indexOf("?")`) and parsed via `URLSearchParams` into `searchParams` on the request context object.

### Security response headers

Every response includes standard security headers:

| Header | Value |
| --- | --- |
| `x-content-type-options` | `nosniff` |
| `x-frame-options` | `SAMEORIGIN` |
| `referrer-policy` | `strict-origin-when-cross-origin` |
| `permissions-policy` | `interest-cohort=()` |

### Path traversal protection

Static asset requests are normalized and validated to ensure the resolved path remains strictly within the `dist/` directory. Requests attempting path traversal via `/../` receive an immediate `400 Bad Request` response before file I/O occurs.

### Graceful shutdown

The server registers signal handlers for `SIGTERM` and `SIGINT`. Upon receiving a signal, it stops accepting new connections, closes active SSE streams, destroys HTTP/2 sessions, shuts down filesystem watchers, and exits cleanly within a 10-second grace period.

## E2E Server Testing

Server behavior is validated through Playwright E2E suites across four environment configurations:

- `playwright.dev.config.ts`: Dev server (`bascik`) live reload, watchers, and boot page.
- `playwright.server.config.ts`: Production server (`bascik --server`) over HTTP/1.1.
- `playwright.server-http2.config.ts`: Production server over encrypted HTTP/2 (HTTPS).
- `playwright.config.ts`: Static build output serving.
