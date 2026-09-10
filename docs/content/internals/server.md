# Server Architecture

Bascik's server infrastructure powers both local development (`bascik`) and per-request production serving (`bascik --server`). Designed as a modular 4-tier pipeline, the server handles request routing, static file serving, `data-bascik-server` request script execution, live reload SSE streams, in-memory caching, port environment overrides, and security hardening.

## Modular Architecture (`server.ts`, `http.ts`, `http2.ts`, `pki.ts`)

Bascik separates protocol management from request routing using a 4-tier architecture:

```text
  [server-dev.ts (Dev) / server-prod.ts (Prod)]
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

- `#files`: Maps HTTP paths (such as `/getting-started`) to `StoredPage` objects containing raw HTML buffers, pre-compressed Brotli and Gzip buffers, and component usage lists. `getPageExact` performs `O(1)` exact lookups and handles trailing-slash path resolution (`/blog` vs `/blog/`) directly without redundant Map queries.
- `#components`: Inverted index mapping each component name to the `Set<string>` of page paths using it. This index enables selective re-transpilation when a single component changes.
- `#openPages`: Tracks active SSE live-reload connections by HTTP path. Pages currently open in a browser tab are transpiled first during batch rebuilds (`processPageBatch` and `processAllPages`) so visible tabs refresh immediately without waiting for background pages.

Brotli compression during development uses minimum quality (`BROTLI_MIN_QUALITY = 1`) for instant background compression without clogging Node.js C++ threadpool workers. Under `--build` and `--server`, Brotli compression uses maximum quality (`BROTLI_MAX_QUALITY = 11`) to ensure optimal payload sizes.

Every stored page is also gzip-compressed in the background (`Z_BEST_SPEED` in dev, `Z_BEST_COMPRESSION` in build and production) as a fallback for clients whose `Accept-Encoding` does not include `br`: older browsers, some corporate proxies, and many crawlers. On each request the server picks the best encoding the client accepts that is already computed: `br`, then `gzip`, then identity. A page is servable immediately after store; if a client asks for `br` before the Brotli job finishes, it receives gzip (if ready) or the raw bytes rather than waiting. Each background job checks that the page has not been re-stored in the meantime before attaching its result, so a stale compression result never shadows newer content.

### Error page handling

Custom 404 and 500 error pages are supported by filesystem convention:

- `/404`: Rendered from `src/pages/404.html`.
- `/500`: Rendered from `src/pages/500.html`. When an unhandled error occurs during request processing, `onError` serves `/500` with status 500. If missing, it falls back to a clean built-in HTML document. Server stack traces are sent to stderr only and never leaked to response payloads.

### Boot page during startup (`boot-page.ts`)

The development server binds its port immediately while page transpilation runs asynchronously. Requests arriving before a page finishes transpiling receive a lightweight boot page displaying a spinner and status message.

The boot page connects to `/bascik-live-reload`. When the requested page finishes transpiling, the `"transpiled"` event fires, the SSE connection receives a reload signal, and the browser fetches the actual page automatically. Once `watchFiles()` completes the initial build, the `isBooting` flag is cleared and unmatched paths fall through to 404 handling. The boot page is never used in production mode.

> **Startup logging:** After the awaited `pre` phase, `startServer()` binds while page compilation runs. The server URL is printed after the initial compilation and `post` phase finish. Parallel exec tasks are not awaited in dev and may log completion later.

### Watch system (`watch.ts`)

Without watched exec entries, separate native filesystem watchers (chokidar) handle source file updates:

1. **Static assets watcher:** Copies non-HTML files in `pages/` to `dist/` on `add` or `change`, deletes them on `unlink`, and triggers a live-reload event.
2. **Page HTML watcher:** Listens for `.html` file changes in `pages/`. Triggers full or single-page transpilation and updates `MemoryStore`.
3. **Component watcher:** Listens for changes in every configured `directory.components` root. This is the only watcher with `followSymlinks: true`, so a symlinked directory inside a root triggers rebuilds; chokidar reports the link path, which is what the inverted component index expects. On change or deletion, uses the inverted component index (`#components`) to selectively rebuild only affected pages.
4. **Import-root watcher:** Listens under `scripts.importRoot` and advances request-time module identities so an edited `src=` server script reloads on the next request. It does not compile pages. `directory.pages` and every `directory.components` root are excluded when nested inside it.

With watched exec entries, `watch-source.ts` replaces the asset, page, component, and extra-path observers with one source observer. It watches the union of source roots and literal roots extracted from globs, filters events using the configured patterns, and excludes `directory.out`. Runtime import-root and API observers remain separate. Overlapping page, content, and exec watches therefore cannot race into duplicate compilation.

`source-cycle.ts` debounces source paths into one serialized phase cycle. Matching pre scripts run sequentially before compilation; matching parallel scripts start alongside compilation; matching post scripts run after compilation and disk writes finish. The dependency graph and component index select a deduplicated page batch. External inputs with no known dependents fall back to all pages, but never rerun unmatched exec entries. Edits received during a cycle or initial compilation are retained. Failed paths are retried on a later source edit, not automatically in a loop.

`compilation-events.ts` uses async-local publication scopes to hold page reloads and join dev disk writes through post. Each scope retires only its own store, so nested or overlapping compilations cannot disable one another's buffered writes, reloads, or page-error policy. In dev boot, that scope wraps only the initial compile callback. The legacy `watch.ts` branch installs its component and `watchPaths` compilation watchers after that initial boot compile finishes, so their callbacks execute outside the boot publisher. The `watch-source.ts` path retains the same startup safety through its deferred source queue. Subsequent edits publish directly from the legacy watchers or through a fresh per-edit scope in `source-cycle.ts`. A pre, compile, write, or post failure reports a build-error and discards success reloads for that cycle. Boot page errors are published to the overlay instead of exiting the dev process, while build mode and edit cycles still throw honestly. Memory pages are not transactionally rolled back; a manual request may see newly compiled HTML before post finishes. Exec completion never schedules another compilation. Build helpers and external inlined stylesheets need `watchPaths` or exec input patterns; neither `scripts.importRoot` nor `assets.inlineStyles` adds a compilation watch.

Exec artifacts must go only to `dist/`, never source or watched paths. Do not watch generated files. Chokidar events do not identify the writer, so distinguishing a legitimate edit from an accidental exec write is unsafe. No time-window, self-script, or repeat-count suppression hides edits; scripts that write watched sources can still loop and must be corrected.

When a page's build fails because a helper does not exist yet, Bascik records that dependency in a failed-dependency index. If a compilation watch covers the helper, creating or repairing it routes through that index so the page can recover. The index selects pages but does not create watchers. It is drained on deletion and when the page's import set changes.

### Live reload (`live-reload.ts`, `sse.ts`)

Live reload uses Server-Sent Events (SSE) via `GET /bascik-live-reload`. Bascik injects a lightweight SSE client script into HTML pages in development mode. The SSE system features:

- **Monotonic Generation Counter:** Reload events include an incrementing integer generation counter (`data: reload <gen>`). The client-side script tracks `lastGeneration` and ignores stale, duplicate, or out-of-order reload messages.
- **Reload Coordination:** Reload notifications from asset updates, explicitly watched paths, and page transpilation use SSE generation tracking. Exec completion never requests a reload.
- **Phase-ordered Exec Lifecycle:** `exec.watch` selects matching scripts for the source-owned cycle described above. `transpile.ts` starts parallel tasks without awaiting them in dev; `startExecDev` observes each outcome. `exec-publication.ts` maps startup parallel failures to located build-errors, with no completion listener. The source cycle reports watched failures directly. Parallel completion never requests a reload and cannot retract reloads already delivered before a later failure. Build runs parallel alongside compilation and joins both branches before reporting success.
- **Monotonic Publication:** Every compilation entrypoint assigns the page a monotonic generation and only applies side effects (memory, disk, dependency index, sidecar, reload event) if that generation is still latest. A stale batch that finishes after a newer direct edit cannot overwrite it; a deleted page cannot be resurrected by late work. See [Generation Ownership](/internals/transpilation-pipeline#generation-ownership-monotonic-dev-publication).
- **Periodic Heartbeats:** Sends `: ping\n\n` comments every 20 seconds, preventing proxy/VPN idle disconnection.
- **Bounded Backpressure:** Honors `res.write()` return values. Each connection owns exactly one drain subscription, so a burst of backpressured writes cannot accumulate listeners; writes stop until the watcher drains, and the single listener is removed on client removal or manager destroy. Persistently wedged clients are terminated after a heartbeat threshold.
- **Connection Cap & Cleanup:** Bounded at 200 concurrent SSE streams (`DEFAULT_MAX_SSE_CONNECTIONS`). Stream close immediately removes the client from the manager and keeps open-page tracking balanced, rather than waiting for the next heartbeat.
- **Build Error Overlay:** The `SseManager` owns exactly one `build-error` subscription on the event bus and routes a located failure (file, line, column) to every live client exactly once, so N connections never produce N broadcasts. Errors clear on subsequent successful builds. Because production has no SSE bus or browser overlay, this channel never leaks into `--build` or `--server` output.
- **Auto-reconnection:** Auto-reconnects on browser tab focus or visibility change, and cleanly closes streams on page unload.
- **HEAD Handling:** Responds to `HEAD /bascik-live-reload` with headers only and terminates without holding an open stream.
- **Production Guard:** Stripped completely from `--build` output, returns `404` on `--server`, and runtime-stripped in `server-prod.ts` as defense in depth.

### Open-page priority transpilation (`partitionByOpenPages`)

When multiple pages must be re-transpiled at once (for example, when modifying a shared component used across many pages, editing an inlined stylesheet, or running `processAllPages()`), compiling every page sequentially before notifying the browser could introduce visible latency on large sites.

Bascik solves this with open-page priority batching (`partitionByOpenPages` in `processing.ts`):

1. **Active tab tracking:** Each active browser tab connected to `GET /bascik-live-reload` registers its normalized HTTP route in `mem.openPages` (derived from the HTTP `Referer` header).
2. **Queue partitioning:** When a batch transpilation begins, the page list is split into `openPages` (pages currently open in at least one browser tab) and `restPages` (all other pages).
3. **Immediate reload emission:** The dev server transpiles all `openPages` first, commits them into `MemoryStore`, and emits the `"transpiled"` event immediately. Connected browser tabs reload in milliseconds.
4. **Background completion:** Once the active tabs have been updated, the remaining pages are transpiled and cached in the background.

This prioritization operates identically whether running on the main thread or across multi-threaded workers via `WorkerPool` (`useWorkers: true`).

Lifecycle publication scopes preserve compilation priority but defer reload delivery through post. Both main-thread and worker results join their disk writes before post scripts inspect `dist/`.

## Production Server Mode (`bascik --server`)

When launched with `bascik --server` or `BASCIK_SERVER=1`, Bascik runs as a production HTTP server (`server-prod.ts`). It is the same `server.ts` core that dev mode uses; `server-prod.ts` only adds the boot-time `dist/` load, and `server-dev.ts` only adds watching, live reload, and the boot page.

### Boot-Time Loading: Pages in Memory, Assets on Disk

Production mode skips file watchers and live-reload injection, but it does **not** skip in-memory page storage. `server-prod.ts#loadDistIntoMemory` walks the built `dist/` directory at boot and reads every `.html` file into the same `MemoryStore` (`mem.ts`) that dev mode uses, so page lookups and `data-bascik-server` execution are served from memory on every request, identical to dev mode.

Only non-HTML static assets, images, fonts, favicons, the webmanifest, and any other file copied verbatim from `src/pages/`, are read from the `dist/` filesystem per request. Component CSS and JavaScript are always inlined into the HTML at build time, so they are already in memory as part of the page buffer; there is no separate in-memory cache for them to miss.

#### Static representation snapshot integrity

A static response is one selected representation delivered as an immutable owner. The server acquires the file bytes once, then derives the body, `Content-Length`, and ETag from that exact buffer, so a response never advertises a validator that describes different bytes. It does not separately `stat`, hash, and re-open the pathname across independent acquisition lifetimes, and it does not stream a second read whose bytes could drift from the hashed ones after an atomic rename or in-place write. Precompressed `.br`/`.gz` sidecars are bound to verified raw content identity: a sidecar is served only when its provenance stamp matches the current raw content hash and it decompresses cleanly at representation creation, so stale or corrupt sidecars are never served under the current asset's ETag. A sidecar's provenance is a sibling `.br.bmeta` or `.gz.bmeta` JSON file recording `{"rawHash": "<quoted content-hash etag>"}`; without it a sidecar is treated as unverified and ignored. On-demand compression otherwise follows the bounded asynchronous representation owner (section below).

**Delivery is two-tier, decided by file size.** `getStaticDelivery` in `caching.ts` is the single owner of that decision, and the bound is the constant `MAX_BUFFERED_ASSET_BYTES` (2 MiB, equal to `MAX_CACHED_REPRESENTATION_BYTES` so "buffered" and "cacheable" describe the same set of assets). It is not configurable.

- **At or under the bound: buffered immutable representation.** One read produces one buffer; the strong content-hash ETag, `Content-Length`, and body all derive from that buffer. This tier is compressible (Brotli or gzip by negotiation) and retained in the bounded representation cache. It guarantees that validator and body describe the same bytes, and that a `304` means the client already holds exactly those bytes.
- **Above the bound: streamed identity.** The file is opened once with `fs.promises.open`; `fstat` on that handle supplies `Content-Length` and the validator, and the body is `fd.createReadStream()` piped to the transport, so memory per in-flight request is bounded by the stream's high-water mark rather than the file size. The validator is deliberately weak, `W/"<size>-<mtimeMs>-<ino>"` in base36, because the bytes are never hashed before they are sent and a strong validator would be a claim the server cannot back. Body and validator still describe the same inode and length: the pathname is not re-opened between deciding what to advertise and reading what to send. This tier is never compressed and never cached. `HEAD` and a matching weak `If-None-Match` are answered before any read stream exists. A read error before headers is a `500`; a read error after headers destroys the transport rather than leaving a truncated body that looks complete. The handle is closed on every path, including client abort.

What the streamed tier does not guarantee: a weak validator cannot distinguish two in-place writes that preserve size, mtime, and inode, so a `304` on this tier means "probably unchanged", per the HTTP definition of weak validators. Immutable release directories (below) make this moot in production. Operational guidance still applies: very large media (video, large archives) is better served from a CDN or object store, but a large asset in `dist/` behind `bascik --server` no longer costs a full copy per request.

**Precompressed sidecars require a provenance stamp, and the build can produce them.** A `.br` or `.gz` file next to an asset is served only when a sibling `.bmeta` file records the current raw content hash. With `http.precompress: true`, `bascik --build` emits `<asset>.br`, `<asset>.br.bmeta`, `<asset>.gz`, and `<asset>.gz.bmeta` for every compressible static asset it produced whose size is at least `COMPRESSION_MIN_BYTES` (512 bytes); pages, `.bascik/*` metadata, already-compressed formats, and files already carrying a sidecar suffix are skipped. The emitter (`precompress.ts`) runs inside `finalizeOwnedArtifacts`, reads each asset once, derives the hash, both encodings (Brotli max quality, gzip level 9), and both stamps from that single read, writes each file to a temp sibling and renames it into place, and records every emitted file in the build manifest. The hash written to `.bmeta` is `getContentHashEtag(rawBytes)`, the same function the server compares against, so a sidecar produced by the build can never be served under an ETag describing different bytes. The option is off by default because it costs two max-quality codec passes per asset at build time and roughly doubles the on-disk footprint of compressible assets.

The `.bmeta` format is a stable external interface: an external pipeline that produces its own sidecars must write `<asset>.br.bmeta` / `<asset>.gz.bmeta` containing `{"rawHash": "<quoted SHA-256 hex of the raw bytes>"}` (the same string the server sends as the identity ETag, including the surrounding double quotes). Sidecars without a matching stamp are ignored and the server compresses on the fly.

The operational default for production is immutable release directories: `dist/` contents are not rewritten in place while being served. This lets the server rely on single-read snapshot consistency. Mutable-dev behavior is explicit and also safe: dev serves the in-memory page buffers produced by the transpiler, and static assets are re-read through the same single-ownership path on every change, so validator and body always agree even when files are written in place during development.

At boot time, `server-prod.ts` also checks for `dist/.bascik/server-scripts.json`. A missing sidecar is optional only when no stored page references a server script: a genuinely static release with no server scripts and no placeholders remains valid and is served normally. If any page carries a `data-bascik-server-id` placeholder and the sidecar is absent, startup fails (see readiness validation below). When present, it is parsed and validated before the socket binds; a malformed, schema-incompatible, or stale sidecar aborts startup with an actionable rebuild message. Each entry retains the authored HTML source path alongside the script source and optional external module path. Page HTML templates in `dist/` contain inert placeholder script tags (`<script type="text/bascik-server" data-bascik-server-id="..."></script>`) that reference these entries. On each incoming request, `executeServerScripts` resolves each placeholder by ID, rewrites relative imports from the authored source directory and import-root (`@/`) imports from `scripts.importRoot`, runs the corresponding script with the request context in-process via `ScriptRegistry`, and injects the returned markup into the response.

#### Readiness validation (`/_health/ready`)

Boot is one production readiness boundary. Before `bascik --server` advertises readiness, every stored page's precomputed server-script plan must resolve: a stored `{ error }` plan (an unresolvable or stale placeholder ID, a stale `stream`/`server` mode marker, or a conflicting directive) proves the release's required runtime artifacts cannot be resolved, so startup fails with an actionable diagnostic rather than binding a socket that would return 200 on `/_health/ready` and 500 on the page. The check runs regardless of sidecar presence: a placeholder page with no sidecar records an unresolvable plan and fails startup with a message naming the missing sidecar. Liveness (`/_health/live`) stays a process-up signal and remains distinct from readiness. Only a release with no sidecar and no placeholders skips this check and is always ready at boot. If validation or binding fails, readiness state resets to `booting` so a later probe never observes a stale ready answer.

### Per-request `data-bascik-server` and `data-bascik-stream` execution (`server-scripts.ts`)

During memory store indexing (`mem.ts#storePage`), Bascik precomputes a `serverScriptPlan` containing alternating static byte chunks and script segment descriptors with their configured execution mode (`server` or `stream`). In production boot, `loadSidecar` runs before the store loop so sidecar metadata (including schema version 2 with script `mode`) is registered in memory. A stored `{ error }` plan is surfaced by the readiness boundary before the socket binds, so a required runtime artifact that cannot be resolved never becomes a per-request 500 behind a ready health check.

When a request arrives:

1. **Plan evaluation and buffered path:** If the page plan contains no script segments, or only `server` scripts, or if the HTTP method is `HEAD`, the request handler takes the buffered execution path. All `server` scripts execute concurrently in-process via `ScriptRegistry`. If any script throws under `scripts.onServerScriptError: 'error'`, execution halts and the server responds with an HTTP 500 error page. When all scripts resolve, the full document is assembled, headers (including `Content-Length` and `ETag`) are set, compression is applied if eligible, and the complete buffered response is sent.
2. **Two-phase stream execution:** If the plan contains at least one `stream` script segment and the method is not `HEAD`:
   - **Phase 1 (Server script resolution):** All `server` scripts on the page resolve first via `ScriptRegistry`. If any `server` script fails under `scripts.onServerScriptError: 'error'`, the response aborts with an HTTP 500 before any byte reaches the network.
   - **Phase 2 (Header commit and ordered chunk delivery):** Once all `server` scripts succeed, the server commits response headers (`transfer-encoding: chunked` on HTTP/1.1 or DATA frames on HTTP/2, `cache-control: private, no-store`, without `Content-Length`, `ETag`, or Brotli `Content-Encoding`). Static HTML bytes prior to the first stream tag are flushed immediately. `stream` script jobs are dispatched through a bounded lookahead window (`STREAM_LOOKAHEAD = 1`): the job the write cursor is waiting on plus the next adjacent stream job may run concurrently, and later jobs start only as the cursor advances. Resulting chunks are written to the response sink in exact source document order.
3. **Backpressure and disconnect handling:** Chunk writes check the return value of `res.write()`. If a write returns `false`, production pauses until the underlying socket emits `drain`. Because job dispatch is tied to the write cursor, a stalled socket also stops new `stream` jobs from starting, so unwritten script output held in heap per connection stays bounded by the lookahead window rather than growing with the number of stream tags on the page. If the client disconnects before streaming completes (`close` event), all pending script jobs are aborted immediately via their passed `AbortSignal` (`{ signal }`), and `res.end()` is never called on a destroyed stream.
4. **Post-commit errors:** Because response headers are already committed before `stream` output begins, a runtime error in a `data-bascik-stream` script cannot return an HTTP 500. Instead, the error is logged at the configured severity (`scripts.onServerScriptError`), an empty string is emitted for that slot, and the rest of the document streams to completion. The author's placeholder markup remains in the DOM.

#### Host-neutral execution core (`request-execution.ts`)

The scheduler described above is not Node code. `pkg/src/lib/request-execution.ts` implements buffered composition (`composeBufferedResponse`), the two-phase streamer with its bounded lookahead (`streamComposedResponse`), deadline-bounded invocation (`invokeWithDeadline`), and API method dispatch (`dispatchApiHandler`) against Web platform primitives only: `Uint8Array`, `ReadableStream`, `AbortController`, `Request`, and `Response`. It never imports `node:*`, the config, the filesystem, or the module registry; `serverless-contract.test.ts` bundles it for `platform: "browser"` and fails on any Node resolution error.

Hosts adapt onto it:

- The Node server (`server-scripts.ts`, `api-runtime.ts`) supplies a `ScriptJobRunner` that resolves each job through `ScriptRegistry`, a `StreamWriter` over the backpressure-aware response sink, and a `classifyError` hook that maps Node transport failures (`PayloadTooLargeError` to 413, socket resets to 499) before the generic 500. The pure route matcher lives in `route-matching.ts`; `api-routes.ts` re-exports it and adds only the filesystem scanner.
- The Cloudflare adapter (`pkg/src/adapters/cloudflare-runtime.ts`) supplies a runner over the compiled module graph, returns `streamComposedResponse(...).toReadableStream()` as a `Response` body before the body completes (the stream is demand-gated, so returning early is required, not optional), and maps `env` and `ctx.waitUntil` onto `context.platform`.

Every handler receives `context.platform` (`{ name: "node" }` on the built-in server; `{ name: "cloudflare", env, waitUntil }` in a Worker). It is additive: a handler that never reads it runs unchanged on both.

#### Serverless adapter contract and runtime exports

`bascik --build --target <name>` orchestrates hosting adapter builds through a typed contract (`HostingAdapter` in `@bascik/bascik/adapter`). Core exposes two dedicated package exports:

- `@bascik/bascik/runtime`: the host-neutral request execution engine (`request-execution.ts`, `web-response.ts`, `route-matching.ts`). It is the same code the built-in Node server runs, bundled with zero Node builtins.
- `@bascik/bascik/adapter`: the adapter contract (`SiteGraph`, `AdapterBuildContext`, `AdapterBuildResult`, `defineAdapter`, and `readSiteGraph`).

Core reads the finalized `dist/` output and sidecar into a `SiteGraph`, stages inline scripts with module specifiers rewritten, resolves the target to an adapter package or local module, and calls `adapter.build(context)`. Core validates that all outputs stay within `dist/.bascik/<target>/`, writes `build-info.json`, and removes staging files. `--target` is rejected with `--only` because a deployment bundle must describe one consistent release.

#### Why stream pages skip ETag, Brotli, and `content-length`

HTTP chunked streaming delivers bytes incrementally as they are produced. Calculating a `Content-Length` or `ETag` requires buffering the entire response in memory first, which defeats the purpose of early flushing. Similarly, max-quality Brotli compression (`BROTLI_MAX_QUALITY = 11`) requires large sliding lookahead buffers that prevent immediate chunk delivery. Consequently, pages with active `stream` scripts omit `Content-Length`, `ETag`, and Brotli `Content-Encoding` headers and emit `Cache-Control: private, no-store`.

### Caching and performance (`http.httpCache`)

Production mode enables `http.httpCache: true` by default:

- **ETag support:** Generates strong ETag hashes for static assets and buffered HTML responses (pages without `data-bascik-stream` scripts), returning `304 Not Modified` when the client's `if-none-match` header matches.
- **Cache-Control headers:** Adds `Cache-Control: public, max-age=3600` to static assets.
- **Max-quality Brotli compression with Gzip fallback:** Uses `BROTLI_MAX_QUALITY = 11` for static assets and buffered HTML responses for optimal bandwidth savings. Clients that do not advertise `br` in `Accept-Encoding` receive `Z_BEST_COMPRESSION` Gzip instead, with its own `"hash-gzip"` ETag variant. Streaming responses bypass compression to preserve real-time chunk delivery.

### Production rate limiting

Production mode enforces a sliding-window rate limit per IP address (by default **500 requests per 10-second window**). Clients exceeding the limit receive `429 Too Many Requests` with a `Retry-After` header.

- **Sliding Sub-Windows:** Uses a ring of 10 sub-buckets per window to smooth boundary bursts and prevent double-budget attacks at window edges.
- **Trust Proxy Support:** When `http.trustProxy: true` is configured, client IP derivation reads the rightmost entry of `X-Forwarded-For` (the address appended by the immediate trusted proxy). When `false` (default), forwarded headers are ignored to prevent spoofing.
- **Bounded Tracking Map & Expiry Lifecycle:** The internal IP tracking Map is capped (`MAX_TRACKED_IPS = 10_000`). When capacity pressure occurs, the limiter automatically reclaims expired identities before admitting new clients. If capacity remains fully occupied by active identities within the window, the limiter fails closed to preserve server memory. A background sweep timer periodically cleans up stale identities during active server operation and shuts down cleanly during server exit.
- **Configurable:** Accepts `boolean` or `{ window?: number, max?: number }` in `bascik.config.ts`.
- **SSE Streams:** Excluded from page rate limit checks.
- **Development Mode:** Rate limiting is inactive during development mode.

## Development vs Production Comparison

| Capability | Development (`bascik`) | Production (`bascik --server`) |
| --- | --- | --- |
| Entry Module | `transpile.ts` via `server-dev.ts` | `server-prod.ts` |
| Shared Core | `server.ts` | `server.ts` |
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

1. Server health state changes to `draining`, causing `/_health` readiness checks to immediately return `503 Service Unavailable` while `/_health/live` continues returning `200 OK`.
2. Idle keepalive connections are closed with `closeIdleConnections()`, and HTTP/2 sessions receive `session.close()` (GOAWAY) to prevent new streams without resetting active work.
3. The server stops accepting new TCP connections and drains in-flight requests during `http.timeouts.drain` (default 5000 ms).
4. Registered shutdown handlers (watchers, exec child processes) are executed concurrently and awaited; errors are caught and recorded.
5. Once all in-flight requests finish and shutdown handlers settle, the process exits cleanly with code 0. If the combined barrier exceeds the drain deadline, remaining active sockets and sessions are forcibly destroyed and the process exits with code 1.

### Port conflict policy

Under `bascik --server`, binding to an occupied port (`EADDRINUSE`) is a fatal error that exits immediately to prevent serving from an unexpected port. Under development mode (`bascik`), port conflicts increment automatically up to 20 attempts.

### Path traversal protection

Static asset requests are normalized and validated to ensure the resolved path remains strictly within the `dist/` directory. Requests attempting path traversal via `/../` receive an immediate `400 Bad Request` response before file I/O occurs.

### Content-Hash ETags and Caching Layer

Static assets and dynamic pages use deterministic SHA-256 content hashes for ETags rather than fragile timestamp-based or mtime-based ETags. Strong validators are derived from the exact bytes of the selected representation, so the advertised ETag and `Content-Length` always describe the delivered body. Distinct ETags are emitted for compressed representations (`"hash-br"`, `"hash-gzip"`), so a `304` is only returned when the client's cached representation matches the encoding it would receive now. The in-memory `STATIC_CACHE_METADATA` cache keys ETags per file path and invalidates on file metadata change.

Compression negotiation follows RFC 9110 Section 12.5.3, parsing quality weights (`q`), wildcards (`*`), and explicit exclusions (`q=0`) to select between Brotli (`br`), Gzip (`gzip`), and uncompressed (`identity`) representations. Static assets respect a size threshold and skip already-compressed formats (images, videos, WOFF2); assets above `MAX_BUFFERED_ASSET_BYTES` are streamed as identity with a weak validator and are never compressed (see "Static representation snapshot integrity" above). On-demand static compression uses a shared single-flight representation owner with bounded in-memory caching, so concurrent requests for the same un-precompressed asset share one asynchronous compression task without blocking the event loop or duplicating work. In-memory representations are bounded per item and by cache size, and are invalidated immediately when underlying file metadata changes. Precompressed `.br`/`.gz` sidecars are served only when justified by the representation owner: their provenance must match the raw content's current hash and they must decompress correctly at creation, which prevents stale or corrupt bytes from being labeled as the current content. Conditional requests (`If-None-Match`) support comma-separated validator lists and weak comparison according to RFC 9110 Section 13.1.2 and RFC 9111. 304 Not Modified responses preserve `Vary` and `Cache-Control` headers for downstream proxy compliance.

### Crash Net & Stream Error Handling

Both HTTP/1.1 and HTTP/2 adapters register stream error handlers that identify client disconnects and network resets via `isNetworkResetError`. Errors such as `ECONNRESET`, `EPIPE`, `ECANCELED`, `ERR_HTTP2_STREAM_CANCEL`, `ERR_HTTP2_INVALID_STREAM`, `ERR_HTTP2_INVALID_SESSION`, `ERR_STREAM_WRITE_AFTER_END`, `ERR_STREAM_DESTROYED`, and `ERR_STREAM_ALREADY_FINISHED` are filtered out so client disconnects do not trigger spurious error logs or unhandled stream errors.

Process-level handlers for `unhandledRejection` and `uncaughtException` log full error context and exit with a non-zero code (`1`) to allow external process supervisors (systemd, Docker container restart policies) to restart the process cleanly.

### API response stream and disconnect ownership

API route execution (`server-api.ts`) enforces strict backpressure and lifecycle ownership across WHATWG `Response` streams and underlying network sockets:

- **Socket capacity gates consumption:** Streamed response bodies are consumed chunk-by-chunk using a response sink. When `res.write()` returns `false`, reading from the stream pauses until the underlying transport emits `drain`. Socket backpressure governs chunk consumption rather than buffering unbounded chunks in memory.
- **Request-lifetime abort ownership:** Each dispatch creates a request-lifetime `AbortController` connected to transport close events (`close`). If a client disconnects while a handler or stream read is pending, the controller immediately aborts. Disconnect propagates into the handler's `signal` option and cancels active WHATWG body readers.
- **Independent settlement and resource cleanup:** Reader cancellation and handler settlement resolve independently so cleanup never hangs on noncooperative user code. On clean completion, stream error, or client disconnect, reader locks and drain/close listeners are released exactly once.
- **Distinct producer failure vs. network cancellation:** If a producer stream fails before headers are committed, the server sends a 500 error response. If a producer stream fails after headers have already been committed, the transport is destroyed immediately as truncated rather than ended as a successful complete response, preventing silent corruption and never emitting duplicate headers.

### In-Process Script Module Registry

Dynamic server-side execution (`data-bascik-server` scripts and API routes) uses an in-process module registry (`pkg/src/lib/script-registry.ts`) powered by native dynamic `import()`.

#### Rationale: In-Process vs. Child Process vs. Worker Threads

- **Rejected: Child process per request.** Spawning a fresh Node interpreter plus disk I/O per request per script block incurs 30 to 80 ms of overhead, eliminates caching, and risks fork-bomb resource exhaustion under concurrent load.
- **Rejected: Worker threads pool.** A worker pool requires structured-clone serialization of every request and payload, introduces pool lifecycle overhead, and complicates response streaming without solving event-loop starvation within workers.
- **Adopted: In-process module cache.** Dynamic `import()` leverages Node's native module cache and V8 optimizations, executing request handlers with sub-millisecond dispatch overhead.

#### Module Identity

Every specifier the registry receives is canonicalized to one identity key before loading:

- A filesystem path (absolute or relative to the project root) is resolved, realpath'd when the file exists, and converted with `pathToFileURL`, which percent-encodes spaces, `#`, `%`, and non-ASCII characters correctly.
- A `file:` URL is parsed as a URL, never re-encoded as a path, and its filesystem path is realpath'd the same way. An authored query string or fragment is part of the identity on purpose: Node treats `mod.ts?variant=a` and `mod.ts?variant=b` as distinct modules, and the registry preserves that distinction.
- Inline source uses a `data:` URL. Its load state belongs to the page's script job, through a weak owner, rather than a permanent registry entry for each historical source. In development, the URL also reflects the generations of its literal file imports.

The identity key is the URL without the framework's own generation marker, so a path, its `file:` URL, a symlinked spelling, and a relative form of the same file all share one module instance. The realpath rule matters because Node's resolver reports realpaths (`/private/tmp/...` on macOS), and the development module graph below is keyed by what the resolver reports.

#### Mode Ownership

The process-wide registry decides its mode once, at construction, from the frozen configuration: `bascik --build` and `bascik --server` are production, everything else is development. `config.ts` imports only the user config, environment, and CLI parser, so reading it from the registry creates no import cycle, and because the mode is fixed there is no mutable global to reconfigure or race against. Tests construct their own `ScriptRegistry` instances with an explicit mode.

#### Caching and Invalidation

- **Production (`bascik --server`):** Modules load once on first request and the loaded identity is retained for the lifetime of the process. `invalidate()` is a deliberate no-op: editing a source file under a running production server changes nothing until the next deploy.
- **Development (`bascik`):** Generations live in the module graph described under Dependency Generations below; the registry and the resolve hook share that one owner. `invalidate()` advances the generation of the identity and of every module that transitively imports it, and unpublishes each advanced entry; the next load imports the entry under `?bascik-gen=N`, which is a new module identity for Node's ESM loader. Stack traces from any generation remap to the authored source. A generation exists only for identities the registry has loaded or attempted, or that the hook has resolved, so watcher events for unrelated files allocate nothing.
- **What invalidation does not do:** It never evicts anything from Node's module cache. Clearing the registry's own maps does not reclaim a loaded module; a previous generation stays in memory until the process exits. A request that already holds an entry finishes on that generation, and a load that completes after a newer invalidation is handed to its caller but never published, so no later request observes a superseded module.
- **Error Containment:** A module that throws during load is never published. Node caches the failed evaluation under that URL, so in development the attempt is recorded and the fixed file is imported under a fresh generation; in production the next request retries the same identity.

#### Watcher Ownership of Runtime Modules

Request-time modules (API routes, `src=` server scripts, and the helpers they import at any depth) are imported by the runtime registry, not by the build, so the page dependency graph knows nothing about them. Inline scripts consult the generations of their literal file imports on invocation. The watchers advance runtime identities directly:

- The API route watcher calls `apiRouteRegistry.invalidateFile`, which invalidates the module identity and rescans the route table before `api-route-changed` is emitted.
- The import-root and components watchers advance the runtime identity for every changed `.js`/`.ts`/`.mjs` path under their roots before deciding whether any page needs a rebuild. When the changed file is a helper, the module graph advances every entry that imports it, and the log line names them: `module invalidated: src/lib/helper.ts (reloads src/lib/src-script.ts)`. The pages watcher only observes `.html` files, so a script module placed under `directory.pages` is covered only when that directory is nested inside the import root.

**Watcher coverage boundary:** the watchers observe `scripts.importRoot`, `directory.components`, and `directory.api`. A helper imported from outside those roots (for example a sibling directory of the import root, or a path reached through `..`) is tracked by the module graph if it lies under the project root, but no watcher reports its edits, so the served output does not update until a watched member of its import chain is edited or the dev server restarts.

#### Dependency Generations

A generation query on an entry module gives Node a new entry identity, but the `import "./helper.ts"` specifier inside it is unchanged text: Node resolves it to the same `file:` URL already in its module map and reuses the evaluated helper. The registry cannot reach dependencies by rewriting the entry URL alone, so development installs a resolve hook that owns generations for the whole import graph (`module-graph.ts`).

- **The hook.** `startDevServer` calls `installModuleGraphHook` before the port is bound. It registers a synchronous, in-thread `node:module` `registerHooks({ resolve })` hook exactly once per process; a second call returns the existing handle. The function is a no-op outside development: `bascik --server` and `bascik --build` never install it, and `server-prod.ts` does not reference the module. `?bascik-gen` therefore never appears in production URLs or logs.
- **Edges.** On every resolution the hook calls the default resolver first, then records `child -> Set<parent>` from `context.parentURL` for resolved `file:` URLs in scope. Keys are the generation-stripped resolved href, which is a realpath because that is what Node's resolver returns; watcher paths are realpath'd through the same identity rule before they are looked up.
- **Generation URLs.** When a child's generation is above 0 the hook returns the resolved URL with `?bascik-gen=<generation>` appended (authored query parameters are preserved). A generation-0 child is returned untouched, so first loads have clean URLs and stack traces. A URL that already carries the marker is left alone: the registry imports an entry under the exact generation it decided on, and an in-flight request finishes on the generation it started with.
- **Invalidation.** `invalidateModule(key)` advances the key's generation and, transitively, every recorded parent's, with a visited set guarding import cycles. It returns the advanced keys and the registry unpublishes each of them. The next request re-imports the entry under its new generation; Node resolves `./helper.ts` from it, the hook hands back the helper's new generation URL, and the edited helper is evaluated fresh. Only invalidated generations change: every other module keeps its identity and its module-level state.
- **Scope.** Only resolved `file:` URLs whose realpath is under the project root (or `scripts.importRoot`, when it lies outside the project) and not under any `node_modules` segment are tracked. Bare package specifiers, `node:` builtins, `data:` URLs, and files outside every tracked root pass through unchanged and are never recorded. A key the hook has never seen allocates nothing, so a watcher event for an unrelated file does not grow the graph.
- **Inline scripts.** Inline `server` and `stream` jobs include the generations of literal file imports in their development module identity. An edit to a tracked transitive helper advances its direct importer's generation, so the next invocation loads a fresh inline module even when the inline body is unchanged or reverted. Unrelated helper edits do not reset that module's singleton state. The graph does not retain `data:` parent edges. Computed import expressions cannot be identified by this literal-import analysis and do not gain the same inline reload guarantee. Watcher coverage and tracked-root limits still apply.
- **What still does not reload.** Bare packages (`import x from "pkg"`) keep their identity until restart. Files outside the tracked roots are not tracked. Node's module map is never evicted: every previous generation, including its module-level state (connection pools, memoized caches, timers it started), stays alive until the process exits, so a long dev session that edits a stateful module many times accumulates those instances. A reloaded helper's `import.meta.url` carries the `?bascik-gen=N` marker in development, so code that derives paths from it should strip the query (or use `import.meta.dirname` / `import.meta.filename`). Build-time scripts (`data-bascik-build`) are unaffected by all of this; they run in a child process that starts with an empty module map.

#### Module Lifetime

Request handlers run in-process. Node retains evaluated ESM identities, including earlier development generations, until the process exits. Clearing framework caches does not evict Node's loader state. Memory is therefore not bounded by the current page count during unlimited request-module edits.

Inline load promises are cached under weak script-job owners. Replacing a page does not keep its old inline sources in a global history map. Accepted requests retain their existing plan and can finish suspended handlers or start delayed stream jobs after a replacement; those old jobs cannot publish loads into the current page or the global registry. File and API modules retain their existing registry cache behavior.

Module-level state, timers, and resources belong to the authored module. Keep request-specific data in handler arguments and release resources explicitly. Matching source bytes alone do not establish that an earlier evaluated module is safe to reuse: its linked dependencies and singleton state may differ.

Production uses stable module identities and immutable releases. Bascik does not automatically restart the process or migrate request handlers into workers to reclaim development generations.

#### Concurrency and State Isolation

Because modules run in-process, handlers receive request data via an explicit context argument rather than process-global state like `process.env`. Concurrently running requests execute asynchronously without leaking per-request context.

#### Timeout, Cancellation, and Limitations

- **Cancellation and Deadline Ordering:** Invocations accept an optional upstream `AbortSignal` and a configurable timeout deadline. Cancellation is observed at each execution boundary: before module load, during deferred module loading, and before handler invocation. If an upstream signal is already aborted or the deadline expires before a handler starts, the handler is never called.
- **Single Settlement State:** Each invocation settles exactly once across success, load failure, handler failure, upstream abort, or deadline timeout. Once settled, subsequent timer firings, late rejections, or late handler resolutions cannot mutate the result or trigger unhandled rejections.
- **Deadline Boundary:** The invocation deadline timer starts before module loading begins, ensuring that sluggish module imports or cold-start disk I/O cannot exceed the configured time budget. While native `import()` cannot be preempted synchronously mid-flight, a deadline expired during import aborts invocation immediately upon import completion and prevents handler execution.
- **Upstream Cancellation Independence:** Upstream transport cancellation (client disconnect) operates independently of whether a deadline timeout is configured. In API routes, client disconnect resolves cleanly to a 499 Client Closed Request status rather than being treated as a handler defect or unhandled error.
- **Cleanup:** Timeout handles, internal race listeners, and upstream abort listeners are always removed on every completion path (success, failure, abort, or deadline).
- **Synchronous CPU Limitation:** In Node's single-threaded event loop, synchronous blocking loops (such as `while(true)`) cannot be forcibly preempted by an in-process timer. Authors must structure long-running tasks asynchronously.

For the full cross-subsystem time model, ownership boundaries, and deterministic testing strategy, see [Time Boundaries](/internals/time-boundaries).

### Graceful shutdown

The server registers signal handlers for `SIGTERM` and `SIGINT`. Upon receiving a signal, it marks readiness as draining, stops accepting new connections, closes idle keepalive sockets, initiates graceful close on HTTP/2 sessions, and awaits registered cleanup handlers for resources such as watchers and exec children. If all requests drain and cleanup succeeds before `http.timeouts.drain` (default 5000 ms), the process exits with code 0. If the deadline expires, Bascik force-destroys remaining sockets and sessions and exits with code 1.

## E2E Server Testing

Server behavior is validated through Playwright E2E suites across five environment configurations:

- `playwright.dev.config.ts`: Dev server (`bascik`) live reload, watchers, and boot page.
- `playwright.server.config.ts`: Production server (`bascik --server`) over HTTP/1.1.
- `playwright.server-http2.config.ts`: Production server over encrypted HTTP/2 (HTTPS).
- `playwright.config.ts`: Static build output serving.
- `playwright.cloudflare.config.ts`: The emitted Cloudflare Pages bundle running in local workerd (Miniflare) with the asset layer in front, including a paint-order test with JavaScript disabled.

Request-level parity between the Node server and the Worker is covered by `src/lib/serverless-parity.integration.test.ts`, which serves one build both ways and compares pages, streams, APIs, methods, cookies, errors, and source leakage. Deliberate platform differences are enumerated in that test rather than excluded silently.
