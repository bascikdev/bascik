# Architecture

Bascik is a Node.js CLI tool written in TypeScript. Its source lives entirely in `pkg/src/`. This page maps every module to its responsibility and explains how they fit together.

## Entry Point

`pkg/src/index.ts` is the CLI entry point, declared as the `bascik` bin in `package.json`. It resolves arguments using `cli.ts` and dispatches action requests accordingly:

```ts
// index.ts (entry point)
const args = process.argv.slice(2);
const decision = resolveCliAction(args);

switch (decision.action) {
  case "init": {
    const { initProject } = await import("./lib/init.js");
    await initProject();
    process.exit(0);
  }
  case "check": {
    const { checkProject } = await import("./lib/check.js");
    const ok = await checkProject();
    process.exit(ok ? 0 : 1);
  }
  case "prodServer": {
    const { serveProduction } = await import("./lib/serve.js");
    await serveProduction();
    break;
  }
  default:
    await import("./transpile.js");
}
```

`transpile.ts` handles the normal dev and build flow. In build mode it awaits `watchFiles()` and exits. In dev mode it starts `server.ts` concurrently with `watchFiles()`, so the server is already bound to its port by the time transpilation finishes (requests arriving before page transpilation completes receive an in-memory boot page). `startServer()` orchestrates loading either `http.ts` or `http2.ts` based on `BascikConfig.http.tls.enabled` and returns the origin URL. As a deliberate developer experience (DX) choice, `transpile.ts` delays printing `Server running at …` until after all initial tasks (`watchFiles()` and `exec`) complete, ensuring the clickable URL is displayed as the final line in the terminal output.

The dynamic `import()` calls are intentional: they avoid loading modules when not needed (`init` and `--check` exit before reaching `transpile.ts`; `--build` never starts the server).

## Library Modules

All logic lives in `pkg/src/lib/`. Each file has a single, well-defined responsibility:

| Module | Responsibility |
| --- | --- |
| `boot-page.ts` | In-memory dev-server boot page shown during initial transpile. Connects to live reload and refreshes once the build finishes. |
| `build-scripts.ts` | Executes `<script data-bascik-build>` blocks as Node.js ESM modules at transpile time, batching uncached scripts per page in a single harness process, caching results on disk, cleaning child-process stack traces, and appending sourceURL comments for debugging. |
| `check.ts` | Static analysis for `bascik --check`. Scans all pages and components for unresolved custom tags (errors) and unused component files (warnings). Exits with code 1 when errors are found so it can gate CI pipelines. |
| `cli.ts` | Command-line argument parser for the `bascik` binary, resolving CLI flags into actions that `index.ts` can execute. |
| `components.ts` | Loads component HTML and CSS files from disk, detects component tags in HTML strings, extracts props/slots/attributes, and injects resolved content back. Directory discovery uses byte-wise sorted traversal for deterministic registration and throws build errors on duplicate tag collisions. Tag detection masks `<script>`/`<style>`/`<textarea>` content so literal tag text is never resolved. |
| `config.ts` | Loads and merges `bascik.config.ts`, default config, and build overrides into a single frozen `BascikConfig` object consumed everywhere else. |
| `css-minifier.ts` | Built-in CSS minifier that collapses whitespace, strips comments, and compresses component `<style>` blocks and global `.css` files. |
| `defineConfig.ts` | Provides the `defineConfig` helper function to offer autocomplete and type safety when writing `bascik.config.ts`. |
| `environment.ts` | Loads `.env` files (default `./.env` plus repeatable `--env-file`) without clobbering real environment variables, and resolves the site URL from `--site-url`, `BASCIK_SITE_URL`, or `.env`. |
| `events.ts` | A simple Node.js `EventEmitter` shared between the watch system, processing pipeline, and HTTP servers to signal live-reload and build events. |
| `exec.ts` | Runs commands from the `exec` configuration list sequentially on build or during file-watching changes. |
| `file-system.ts` | File-system helpers: recursive directory listing, path resolution between source and dist, copying static assets. |
| `html-minifier.ts` | Built-in HTML minifier that strips HTML comments and collapses unnecessary whitespace between tags in production builds. |
| `http.ts` | Plaintext HTTP/1.1 server (`node:http`) used by default in development and cleartext environments. |
| `http2.ts` | TLS-enabled HTTP/2 server (`node:http2`) used when `enableTls: true` is configured. |
| `init.ts` | Bootstraps a new Bascik project via `bascik init`. Creates `src/pages/index.html` and `src/components/`, ensures `.gitignore` includes `dist/` and `node_modules/.cache/bascik/`, and patches `package.json` with `"type": "module"` (when absent), an `@bascik/bascik` dependency, and dev/build scripts. |
| `javascript.ts` | The scoping transforms: `prefixElementAttribute` (rewrites HTML attributes, JS DOM selectors, and CSS) and `namespaceScriptTags` (wraps scripts in IIFEs with `sourceURL` annotations and line positioning). |
| `js-minifier.ts` | Lightweight, built-in JavaScript minifier that strips comments and collapses safe whitespace without breaking statement boundaries (ASI). |
| `live-reload.ts` | Injected client-side script that establishes an EventSource connection to the dev server to reload pages when they are updated. |
| `manifest.ts` | Collects written file metadata (forward-slash path, SHA-256 hash, byte size) as writes occur and writes `dist/.bascik/manifest.json` when `generate.manifest` is enabled. |
| `mem.ts` | In-memory page store. Stores brotli-compressed page buffers keyed by HTTP path, and maintains a reverse index mapping each component name to the set of pages that use it. |
| `mime.ts` | A static MIME type map used by the HTTP/2 server and the watch system's file-type filter. |
| `names.ts` | Generates unique instance IDs (`getUniqueId`) and hashes long scoped names to short alphanumeric strings (`minifyAttributeName` via SHA-256 with Base62 encoding) when identifier minification is enabled. |
| `page-worker.ts` | Worker thread entry point. Receives a page path, calls `transpilePage()` (pure computation, no side effects), and posts the result back to the pool. |
| `paths.ts` | Converts file-system paths to HTTP paths (stripping the `src/pages` prefix, removing `.html` extensions). |
| `pki.ts` | Generates a self-signed TLS certificate (`bascik-cert.pem` / `bascik-privkey.pem`) via OpenSSL or PowerShell on Windows. |
| `processing.ts` | The core transpilation pipeline. Contains `pageProcessing` (page phase) and `recursivelyTranspile` (component phase), plus pipeline utility types. |
| `serve.ts` | Production server entrypoint (`bascik --server`). Pre-loads pre-rendered `dist/` HTML into `mem.ts` and boots `server.ts`. |
| `server-scripts.ts` | Loads and executes `<script data-bascik-server>` blocks at request time, cleaning child-process stack traces and appending sourceURL comments before injecting stdout into the page. |
| `server.ts` | Server orchestrator. Dispatches requests to `http.ts` or `http2.ts` based on `BascikConfig.http.tls.enabled`, runs shared request handlers, and manages server instances. |
| `sitemap.ts` | Generates `dist/sitemap.xml` and `dist/robots.txt` at the end of a build when `generate.sitemap` / `generate.robots` are enabled (both default to `true`). Fails the build when enabled but no site URL is available. |
| `stack-trace.ts` | Cleans and remaps stack traces from temporary script files back to original source template files and line offsets. |
| `styles.ts` | All CSS transformations: element selector conversion, class prefixing, `@keyframes` / `@layer` / container scoping, custom property prefixing, CSS deduplication. |
| `types.ts` | Central TypeScript type definitions: `BascikComponent`, `ComponentList`, `TranspileResult`, `TranspilePageResult`, `BascikConfigOptions`, `StoredPage`. |
| `userConfig.ts` | Dynamically imports the user's `bascik.config` from `process.cwd()`, exporting `config` and `buildConfig`. |
| `watch.ts` | Set up chokidar watchers for pages, components, and static assets. Triggers full or selective re-transpilation on file events. |
| `worker-pool.ts` | Generic fixed-size thread pool. Spawns N workers once, dispatches tasks via a queue, and reuses workers across calls to avoid per-task spawn overhead. |

## Dependency Graph

The data flow at a high level:

```text
index.ts
  ├── (init only)
  │     └── init.ts
  ├── (--check only)
  │     └── check.ts ← components.ts, file-system.ts
  ├── (--server / prod server)
  │     └── serve.ts → server.ts
  └── transpile.ts
        ├── config.ts ← userConfig.ts ← bascik.config.ts / bascik.config.js
        ├── watch.ts
        │     └── processing.ts
        │           ├── components.ts ← file-system.ts
        │           ├── javascript.ts
        │           │     ├── styles.ts
        │           │     └── names.ts
        │           ├── styles.ts
        │           ├── html-minifier.ts, css-minifier.ts, js-minifier.ts
        │           ├── build-scripts.ts
        │           ├── worker-pool.ts → page-worker.ts
        │           │     └── (transpilePage - no side effects)
        │           ├── mem.ts ← paths.ts
        │           └── events.ts
        └── (dev server, concurrent with watch.ts)
              └── server.ts
                    ├── (if enableTls: true)
                    │     ├── pki.ts
                    │     └── http2.ts ← server-scripts.ts, mem.ts, events.ts, paths.ts, mime.ts
                    └── (default HTTP/1.1)
                          └── http.ts ← server-scripts.ts, mem.ts, events.ts, paths.ts, mime.ts
```

## Key Design Decisions

### Frozen config singleton

`BascikConfig` is initialized once at startup via `config.ts` and frozen with `Object.freeze()`. Every module imports this singleton directly. There is no dependency injection, configuration is a module-level constant that is immutable at runtime.

### No runtime framework

Bascik has a single runtime dependency: [chokidar](https://github.com/paulmillr/chokidar) for file watching. Everything else uses Node.js built-ins (`node:fs`, `node:http2`, `node:crypto`, `node:zlib`). This keeps the install footprint minimal and eliminates version-conflict surface area for users.

### Avoiding ASTs and browser emulation

Bascik does not use abstract syntax trees (ASTs), DOM parsers (e.g. `htmlparser2`, `parse5`), or heavy browser emulation environments (such as JSDOM or Puppeteer) during transpilation. Early prototypes explored these paths but quickly hit significant barriers: JSDOM and browser-level emulation added enormous CPU and memory overhead, while full AST construction introduced complex tree-traversal bottlenecks that severely limited performance.

Instead, Bascik uses high-performance, raw-string manipulation powered by targeted regular expressions combined with temporary content masking (e.g. shielding `<script>`, `<style>`, and `<textarea>` tags). Fast `.includes()` string-existence guards skip regex execution when target markers are absent, and HTML tag boundary scans use `O(1)` backwards offset lookups (`lastIndexOf`) rather than full-string slicing to eliminate `O(N^2)` heap allocations. This regex-first strategy keeps compile times down to single-digit milliseconds per page, ensures zero external package bloat, and aligns with the project philosophy of being lightweight and fast. The [Scoping Compatibility](/compatibility) page documents the known limitations and edge cases of this regex approach.

### Native TypeScript and ESM Compilation

Bascik embraces Node 24's native TypeScript support. At runtime, Node 24 natively strips types to execute `.ts` files (such as `bascik.config.ts`, user scripts, and tests) without a separate transpilation step.

For package distribution, the source code in `pkg/src/` is compiled by `tsc` using `tsconfig.build.json` to emit optimized, pure ESM into `pkg/dist/`. This pre-compilation ensures that consumers can run the CLI with minimal startup overhead, while local tests and TypeScript features are supported via `tsconfig.json` and Vitest.

### CPU-aware worker pool (opt-in)

When `useWorkers: true` is set in `bascik.config.ts` (default `false`), `processAllPages()` creates `Math.min(os.cpus().length, pageCount)` worker threads via `worker-pool.ts` instead of transpiling sequentially on the main thread. Each worker is initialized once with the pre-computed `componentList` and `globalStylesHtml`, then reused for every page assigned to it. The main thread dispatches page paths through the pool's task queue and collects results to apply side effects (memory storage, event emission) after all workers complete.

Spinning up the pool has a fixed cost, each worker loads the transpiler's module graph independently before it can process its first page. This pays for itself on larger sites with CPU-heavy per-page work, but for small sites (or sites whose slow parts are I/O-bound, like `<script data-bascik-build>` blocks) sequential transpilation on the main thread is often faster overall. See the [`useWorkers`](/configuration#useworkers) config option.

### Memory-first dev serving

In dev mode, `pageProcessing()` writes the transpiled HTML to the in-memory store and emits the `"transpiled"` event before writing anything to disk. The HTTP/2 server can serve the updated page immediately. Disk writes are skipped entirely in dev, `dist/` is only written during `--build`.

### Canonical page paths

`paths.ts` is the single source of truth for converting page filenames into canonical URL paths. The in-memory server key, `BASCIK_PAGE_PATH` build-script value, and sitemap generator all use the same conversion. Directory indexes use a trailing slash, so `src/pages/blog/index.html` becomes `/blog/`. Sitemap serialization percent-encodes each segment after canonicalization, while the server decodes incoming paths before lookup.

### Process-isolated build scripts vs in-process server scripts

Bascik separates the execution model of build-time scripts from request-time server scripts:

- **Build scripts (`<script data-bascik-build>`):** Executed in complete isolation. Instead of using `eval` or Node's `vm` module, which can leak state or restrict standard Node.js APIs, Bascik writes build script content to a temporary `.mjs` file on disk and runs it as a standalone Node.js subprocess (batched per page and constrained by a memory-aware semaphore). This process-level isolation ensures that user build scripts cannot pollute the memory of the compiler or server, natively supports ES modules, top-level `await`, dynamic imports, and captures stdout cleanly before removing temporary files.
- **Server scripts (`<script data-bascik-server>`):** Executed in-process at request time as Node.js ESM modules via `ScriptRegistry`. During `bascik --build`, the script source is extracted into the sidecar (`dist/.bascik/server-scripts.json`) and replaced in the HTML with an inert placeholder tag (`<script type="text/bascik-server" data-bascik-server-id="...">`). When `bascik --server` boots, it loads the sidecar into memory once. Incoming requests execute the registered module in-process with the `{ req }` context and inject the returned markup into the document flow without subprocess spawn overhead.

To maintain accurate debugging diagnostics across execution boundaries, Bascik appends `//# sourceURL` directives and cleans stack traces (`stack-trace.ts`), mapping temporary paths and line offsets back to the original source HTML file.

### Incremental rebuilds via reverse component index

To keep the development server instantaneous, Bascik avoids full site rebuilds on change. The in-memory store (`mem.ts`) maintains a reverse dependency index mapping each custom component tag to the exact list of pages that consume it. When a component file is modified, the file-system watcher resolves the component's name, checks the reverse index, and schedules only the affected pages for re-transpilation. Unaffected pages remain cached in memory.

### Custom lightweight JS minifier

Rather than bundling heavy engines like Terser, esbuild, or SWC as dependencies to minimize scoped scripts and IIFEs, Bascik includes a custom, regex-based segment minifier (`js-minifier.ts`). It strips comments, collapses redundant whitespace, removes safe operator padding, and respects statement boundaries (ASI) without mutating literal strings or regex patterns. This approach keeps dependencies at zero and avoids any performance impact on transpilation.

### Zero-dependency live reload via Server-Sent Events (SSE)

Instead of pulling in a WebSocket dependency like `ws` or injecting a heavy client library, Bascik implements live reloading via native Server-Sent Events (SSE). The dev server uses a lightweight request handler built on Node's standard `http` and `http2` modules, while pages are injected with a tiny, twenty-line client script that listens via `EventSource`. This ensures that live reloading is reliable and completely dependency-free, and adds zero footprint to development builds.

### Brotli-compressed in-memory cache

To achieve fast response times in both dev and production modes, Bascik keeps transpiled pages in an in-memory store (`mem.ts`). Storing large raw HTML strings in V8 memory can lead to high memory consumption and GC pressure on large sites. To prevent this, Bascik compresses all cached pages using Node's native `node:zlib` Brotli implementation. This reduces the dev server's RAM footprint by up to 90% while allowing production environments to stream pre-compressed buffers directly to modern browsers.

### CLI startup and package manager overhead

Bascik's Node.js CLI runtime (`pkg/dist/index.js`) boots and starts transpilation in under 50ms. When invoking commands through monorepo package managers (such as `yarn <workspace> <script>`), the package manager itself may spend 1.0 to 1.5 seconds loading plugins, parsing configuration files, and resolving workspace dependency graphs before it spawns the Node.js process. The framework's logged completion metrics (e.g. `✓ All tasks completed in Xms` and `✓ Build complete in Xms`) measure total task execution within the running Node process. For instant CLI execution with sub-50ms startup latency, invoke the compiled binary directly via `node` (e.g. `node ./node_modules/.bin/bascik`) or use a lightweight script runner.
