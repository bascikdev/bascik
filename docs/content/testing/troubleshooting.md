# Troubleshooting

This page is organized by what you saw, not by feature.Most entries end with a link to the page that covers the rule in depth, and the [FAQ](/faq) covers the "why does Bascik work this way" questions.

Not sure where the problem is reported? Bascik tells you in one of four places:

- **The terminal.** Every message starts with `[bascik]` and names the file, and where one exists the line and column. The dev server logs a failed page and keeps serving the rest; `bascik --build` collects every failure and exits nonzero. See [Transpilation and build errors](/cli#transpilation-and-build-errors).
- **The browser, in development.** A build script failure, a syntax error, or an invalid component reference opens a full-screen overlay that names the source file and line and dismisses itself when you save a fix. See [Browser Error Overlay](/development-server#browser-error-overlay).
- **`bascik --check`.** A static pass over pages, components, config, and API routes that reports everything at once. See [Static analysis with `bascik --check`](/cli#static-analysis-with-bascik-check).
- **Your editor.** The [linter](/tools/linter) underlines typos in `data-bascik-*` attributes, unknown props and slots, unclosed component tags, and CSS or JavaScript that cannot be scoped as you type.

## Start here

1. **Check the Node version.** Bascik needs Node 22.18 or newer; the message is `[bascik] Node.js 22.18.0 or newer is required. Detected <version>.`
2. **Run `bascik --check`.** Most "it builds but looks wrong" problems are an unresolved tag, an unknown directive, or a config typo, and the report names each one.
3. **Restart after a config change.** The dev server prints `[bascik] Config file changed: <path>. Restart the server to apply configuration changes.` and keeps the old config until you do.
4. **Run a full `bascik --build` before `bascik --server` or a deploy.** A targeted `--only` build, or a `dist/` left by an older Bascik version, is the usual cause of a stale-artifact message.
5. **Follow the file and line.** Build and server script errors are remapped to your source file; the dev overlay and most terminals make the location clickable. See [Source Maps](/testing/source-maps).

## Installing and scaffolding

### `[bascik] Node.js 22.18.0 or newer is required.`

The CLI refuses to start on an older Node. Install Node 22.18 or newer (Node 24 is recommended) and re-run. Every Bascik package declares the same floor in its `engines` field, so a package manager that enforces engines reports it at install time instead.

### `npm create bascik` ignored my `--template`

npm keeps flags that come before `--` for itself. If you ran `npm create bascik@rc my-site --template cloudflare`, the scaffolder sees no template and reports:

```text
npm kept --template for itself and dropped its value. Put flags after "--": npm create bascik@rc my-site -- --template cloudflare
```

Put every scaffolder flag after `--`. `yarn create` and `pnpm create` pass flags through without it. See [Scaffold a new project](/cli#scaffold-a-new-project).

### `Unknown template "..."` or `--template needs a value`

The template name is misspelled or missing. The message lists the valid names. See [Scaffold a new project](/cli#scaffold-a-new-project).

## Configuration

### `Configuration errors in bascik.config.ts`

Bascik validates `bascik.config.ts` at startup and refuses to run on an invalid configuration, so a mistake surfaces immediately with a clear message instead of a confusing runtime failure later. The report lists every problem at once: each entry names the key, shows the value it received, and states what was expected.

```text
  scripts.onBuildScriptErr unknown key
                           did you mean "scripts.onBuildScriptError"?
```

Common causes:

- **A typo in a key name**, such as `directroy:` or `minfy:`. Unknown keys are rejected, with a "did you mean" suggestion when the key is a near miss of a real option.
- **A value of the wrong type or range**, such as `http.port: 70000` or `scripts.timeout: 0`.
- **A path that does not exist**, such as a `pipeline.exec[].script`, a `pipeline.watchPaths` entry, or a TLS certificate file.
- **An invalid `BASCIK_SITE_URL`**, which must be an absolute `http` or `https` URL.

Fix each listed key and re-run. See [Configuration Validation](/configuration#configuration-validation).

### My config changes have no effect

Check for a `bascik.config.js` in the same directory. When both files exist in the project root, the `.js` file takes precedence, so a stale or accidental `.js` file shadows your `.ts` config. Delete the `.js` file, or pass `--config bascik.config.ts` to load a specific file explicitly.

Two other things to rule out: only the project root is searched (a config in a subdirectory or parent directory is never picked up), and only the `.js` and `.ts` extensions are supported (`.mjs`, `.cjs`, `.mts`, and `.cts` files are not discovered). See [Config file discovery](/configuration#config-file-discovery).

If the file is found but an edit is not taking effect, the dev server is still running with the old configuration. It prints `[bascik] Config file changed: ... Restart the server to apply configuration changes.` and does not hot-reload configuration on purpose. See [Why do I need to restart after changing my config?](/faq#why-do-i-need-to-restart-after-changing-my-config).

### `` `siteUrl` is not a bascik.config option ``

The site URL changes per deployment, so it is not a config key. Set it with the `--site-url` flag, the `BASCIK_SITE_URL` environment variable, or a `.env` file. See [The site URL](/configuration#the-site-url).

### `--config "..." does not exist`

The path passed to `--config` is relative to the directory you ran the command from. Fix the path or run from the project root.

## Components

### `[bascik] Unresolved component tag in "pages/about.html": <my-mistyped>`

A hyphenated tag has no matching file under `src/components/`. The tag ships to the browser unchanged and the build does not fail. Causes, in order of likelihood:

- **A typo in the tag or the filename.** Tag names come from the filename, lowercased, without the extension: `site-nav.html` is `<site-nav>`.
- **The component file does not exist yet.** Create it; the dev server picks it up without a restart.
- **The tag belongs to a third-party custom element** such as `<model-viewer>`. Declare it in [`components.external`](/configuration#componentsexternal) so neither the build warning nor `--check` reports it.

Run `bascik --check` for the full list. See [What happens if I reference a component that doesn't exist?](/faq#what-happens-if-i-reference-a-component-that-doesnt-exist).

### `bascik --check` lists my third-party web components

Same cause as the previous entry: Bascik has no allowlist of custom element names, so anything hyphenated without a file is reported under "Components with no matching file". Declare the ones you use in [`components.external`](/configuration#componentsexternal). See [Third-Party Web Components](/how-to/third-party-web-components).

### `warning: Component "nav" has the same name as a native HTML element.`

A file such as `nav.html` or `div.html` replaces every `<nav>` or `<div>` on your pages with the component. Rename it to a hyphenated name like `site-nav.html`. The sibling warning `Component "card" is not hyphenated.` means the same thing one step earlier: custom elements need a hyphen. See [Component Naming and Hyphens](/components#component-naming-and-hyphens).

### Two component files define the same tag name

The build fails with both file paths and the note that "Component names come from the filename, so neither subfolders nor the roots listed in directory.components create separate namespaces." `marketing/card.html` and `admin/card.html` are both `<card>`. Rename one, for example `marketing-card.html`. See [Subfolder Layout](/components#subfolder-layout).

### `components directory "..." does not exist`

A directory listed in `directory.components` is missing or is a file. A missing default `src/components/` is fine and means "no components yet"; any other listed path must exist, because a typo there would otherwise silently drop every component in it. Create the directory or fix the entry. See [`directory`](/configuration#directory).

### My component tag is unclosed and the layout is wrong

`<my-card>` with no `</my-card>` is treated as self-closing with empty content, so any children you wrote land outside the component. The linter and `bascik --check` warn with `Component tag <my-card> is unclosed.` Add the closing tag, or write `<my-card />` when the component takes no children. See [Void / Self-Closing Component Tags](/components#void-self-closing-component-tags).

### `validate markup: Page does not contain a non-empty <body> element`

A page needs a `<body>` with content to produce output. In dev the page is skipped and retried when you save; in `bascik --build` it is a hard error. A component file is not a page: keep components out of `src/pages/`.

### `Transpilation failed for component <site-nav> during css-scoping`

A component's CSS or JavaScript could not be parsed during scoping. The message names the page, the line and column of the usage, and the component file. Fix the syntax error it quotes; the error line under it comes from the parser. See [Transpilation and build errors](/cli#transpilation-and-build-errors).

### Runaway component expansion

A component that uses itself, directly or through another component, expands until the safety limit and fails that page. Break the cycle; `bascik --check` reports circular component references.

### `TypeScript syntax found in an ordinary <script> block`

An inline `<script>` in a component contains type annotations. Mark it `<script type="text/typescript">`, or move it to a `.ts` companion file referenced with `<script src="...">`, and Bascik strips the types at build time. See [Companion CSS and Script Files](/components#companion-css-and-script-files).

### My edit to a component does not show up

The dev server watches component `.html` files, companion `.css` and script files, and files imported by build scripts, and rebuilds every page that uses the component. If the stale part is build-script output, the script cache is answering from an earlier run: see [Build script output is stale](#build-script-output-is-stale) below. If nothing reloads at all, see [Live reload stopped working](#live-reload-stopped-working).

## Props, slots, and scoping

### My prop shows up as escaped text

Props are text. Bascik HTML-escapes them so markup from a CMS or an API cannot become an element or a script. Pass markup through a [slot](/slots) instead. See [Why is my prop value showing as escaped text?](/faq#why-is-my-prop-value-showing-as-escaped-text).

### `Component <my-card> does not declare prop "titles"`

The usage passes `data-bascik-prop-titles` but the component reads `data-bascik-prop-title`. The linter reports the mismatch on the usage; the build leaves the fallback text in place. The companion messages are `Component <my-card> does not declare slot "..."` for a misspelled `data-bascik-slot`, `data-bascik-attr-href references prop "link", but no <my-card> usage supplies data-bascik-prop-link` for a binding nothing feeds, and `Pass it with the data-bascik-prop-title prefix instead of "title"` when the prefix was forgotten. See [Props](/props) and [Slots](/slots).

### `data-bascik-build is only valid on <script> tags`

A directive attribute landed on a `<div>` or another element, where it does nothing. Move it to the `<script>` tag. The same rule covers `data-bascik-server`, `data-bascik-stream`, `data-bascik-routes`, and `data-bascik-build-once`. An unknown `data-bascik-*` name (a typo such as `data-bascik-porp-title`) is reported by the linter and `bascik --check` as an unknown attribute.

### `<label for>` stopped matching its input

Bascik rewrites `<label for>` automatically when the matching `id` is declared in the same component. The label and control receive the same per-instance scoped identifier, including when identifier minification is enabled. A reference to an ID in another component is left unchanged because Bascik cannot choose that component's instance at build time; the linter reports it as `ID reference "email" is not declared in this component and will be left unscoped.` Keep the label and control together or target a literal page-shell ID. See [HTML ID references](/scoped-javascript#html-id-references).

### Form field names are hashed

`name` is scoped per instance so repeated radio groups stay independent. For a form that posts to a service expecting literal keys, add `data-bascik-preserve="name"` to the form. `Unknown data-bascik-preserve token "..."` means the token was not one of `id`, `name`, or `class`. See [Preserve Scoping](/preserve).

### A third-party widget cannot find its mount element by ID

The ID was scoped. Add a bare `data-bascik-preserve` to the mount element so its literal ID and subtree stay unscoped. See [Preserve Scoping](/preserve).

### An inline SVG gradient, mask, or filter is not showing

Declare the gradient ID and its CSS `url(#id)` reference in the same component. Bascik rewrites the fragment to the instance-scoped ID and automatically emits per-instance CSS for that component. Cross-document fragments such as `url(sprite.svg#icon)` are intentionally untouched. For an SVG ID graph owned by another tool, use [Preserve Scoping](/preserve). See [CSS fragment references](/scoped-styles#css-fragment-references).

### The linter says my CSS or JavaScript cannot be scoped

Rules such as `js-dynamic-id-lookup` or `css-id-attribute-selector` flag patterns Bascik cannot rewrite safely, for example an ID built from a string at runtime. Each rule's message says what to write instead; the [Compatibility](/compatibility) page has the full table.

### The same `<script>` appears once per component instance

By design: each instance carries its own scoped script in an IIFE, so no runtime registry is needed. See [Why do I see multiple identical script tags in my page output?](/faq#why-do-i-see-multiple-identical-script-tags-in-my-page-output).

## Build scripts

### `[bascik] build script error in "src/pages/index.html" at (line 12, column 5)`

The script threw. The stack below the message is remapped to your source file, so the first frame is the line to fix. By default the page fails (in dev, with the overlay; in `bascik --build`, the build exits nonzero). `scripts.onBuildScriptError: 'warn'` logs and emits an empty string instead. See [Error Handling & Stack Remapping](/build-scripts#error-handling-stack-remapping).

### Nothing appears where my build script is

The script printed with `console.log()` instead of returning. Build scripts export a default function whose return value becomes the HTML; console output goes to the terminal only. See [Handler Contract & Console Logging](/build-scripts#handler-contract-console-logging).

### `Script execution timed out after 30000ms`

The script ran longer than `scripts.timeout` (30 seconds by default). Raise the limit, or move slow work such as a remote fetch into a `pipeline.exec` step that writes a file the script reads. See [`scripts`](/configuration#scripts).

### Build script output is stale

The build script cache keys on the script body and its statically scanned local dependencies. It cannot detect runtime dependencies such as network API calls, `readdir` directory reads, or computed file paths, so a script whose output depends on a remote API is served from cache with stale data across builds. Configure `scripts.cache.exclude` in `bascik.config.ts` to exclude that script from caching. If the stale data comes from an environment variable, declare the variable in `scripts.cache.environment` so its value becomes part of the cache key; the warning `build script reads process.env.X but "X" is not declared in scripts.cache.environment` names any you missed. See [Invalidation Limits & Cache Exclusions](/build-scripts#invalidation-limits-cache-exclusions) for the full cache key and invalidation limits.

### `<script> tag has both data-bascik-build and data-bascik-server`

One script cannot run at build time and at request time. Remove one directive; split the work into two scripts if you need both. See [Directive Conflicts](/build-scripts#directive-conflicts).

### `build script output ... contained <script data-bascik-build>. Printed directive scripts never run; they were removed.`

HTML returned by a build script is expanded like page markup, but a directive script inside it is removed rather than executed. Write directives in source files, and sanitize HTML that comes from a CMS or an API before printing it. See [Printing HTML You Did Not Write](/build-scripts#printing-html-you-did-not-write).

### A build script reads the wrong `process.env` values

Build scripts receive `BASCIK_SITE_URL`, `BASCIK_BASE`, and the page-context variables; your own `.env` values are loaded from the project root. A variable that changes the output must also be listed in `scripts.cache.environment`, or the cached output from the previous value is reused. See [Environment Variables](/build-scripts#environment-variables).

## Server and stream scripts

### The server script section is empty on my static host

Server and stream scripts run only in `bascik --server` or through a deployment adapter. A static host serves the placeholder, which the browser ignores. Deploy with the [production server](/production-server) or the [Cloudflare adapter](/deployment/cloudflare), or move the work to a build script if it does not need the request.

### `Inline server script must export default a function`

Like build scripts, server scripts export a default function; it receives the request and returns HTML. See [Handler Signature](/server-scripts#handler-signature).

### `[bascik] server script error at "/pricing":`

The handler threw during a request. Under the default `scripts.onServerScriptError: 'error'` the response is a 500; `'warn'` logs and renders an empty section; `'ignore'` renders the empty section silently. The stack is remapped to the component or page file. See [Rules and Behavior](/server-scripts#rules-and-behavior).

### `Script execution timed out` on a request

The handler exceeded `scripts.timeout`. Pass the `signal` the handler receives to `fetch()` and database clients so the work is canceled with the request, and keep synchronous CPU work out of handlers. See [Timeouts and Cancellation](/server-scripts#timeouts-and-cancellation-abortsignal).

### `Server script placeholder "..." could not be resolved from sidecar`

`dist/` was produced by a different build than `dist/.bascik/server-scripts.json`, usually a targeted `--only` build on top of an older full build, a hand-edited `dist/`, or a `dist/` built by an older Bascik version. The related messages are `is marked stream in the HTML but server in the sidecar (stale sidecar)`, `uses schema N, expected M`, and `production startup validation failed`. Run a full `bascik --build` with the installed version and start the server again.

### `--server: dist/.bascik/server-scripts.json has server-script entries but dist/.bascik/components.json is missing`

Same family: a build that has server or stream scripts also writes a component manifest, and this `dist/` predates it. Run `bascik --build` again. See [What is `dist/.bascik/`?](/faq#what-is-distbascik).

### One slow server script delays every request

Synchronous work in a handler blocks Node's event loop. Use asynchronous APIs, await them, and offload CPU-heavy work. See [Can a server script slow down other requests?](/faq#can-a-server-script-slow-down-other-requests).

## Dynamic routes

### `Bracket filename "blog/[slug].html" has no <script data-bascik-routes> tag. Skipping template.`

A page whose filename has bracket parameters needs exactly one routes script that returns the parameter list. Add it, or rename the file if the brackets were a mistake. The reverse message, `<script data-bascik-routes> found in "about.html" which has no bracket parameters`, means the script is on a page with nothing to expand. See [data-bascik-routes](/dynamic-routes#data-bascik-routes).

### `routes template "..." produced 0 routes.`

The routes script returned an empty array, so no pages were written. Usually the data source returned nothing, or the script returned the wrong shape (an array of `{ params }` objects is expected). See [Route Object Format](/dynamic-routes#route-object-format).

### A generated route returns 404

Dynamic route parameters must be URL-safe tokens. Characters like `#`, `%`, `&`, `'`, `+`, spaces, leading dots, and Windows device names are disallowed. Also ensure your template's routes script returned an array containing valid `params` objects matching the bracket names in the filename. See [Route Object Format](/dynamic-routes#route-object-format).

### `[bascik] routes script error`

The routes script threw or returned something that is not an array of route objects. The message names the page and line; `scripts.onRoutesScriptError` chooses between failing the build and skipping the template. See [Error Handling and Diagnostics](/dynamic-routes#error-handling-and-diagnostics).

## API routes

### My API route returns 404

Handlers live under `src/api/` and are served only by `bascik --server` (or an adapter); a static build does not include them. Check the file path maps to the URL you request. See [Static Builds vs Production Server](/api-routes#static-builds-vs-production-server).

### 405 Method Not Allowed

The file exports no handler for that method, or the export is not uppercase. The linter reports `API route method export "get" must be uppercase ("GET")` and `API route file does not export any recognized HTTP method handler`. See [Method Exports and Automatic Allow Headers](/api-routes#method-exports-and-automatic-allow-headers).

### 413 Payload Too Large

The request body exceeded `http.maxBodySize` (1 MB by default). Raise it in `bascik.config.ts` if the payload is legitimate. See [Request Body Handling and Streaming](/api-routes#request-body-handling-and-streaming).

### 504 Gateway Timeout

API route execution is guarded by `http.apiTimeout` (default: 10,000 ms). If your handler does not return a `Response` before this timeout elapses, Bascik aborts the request and responds with `504 Gateway Timeout`, and the terminal shows `API route handler timed out in <file> (<method>) after <ms>ms`. Handlers receive a cooperative `AbortSignal` in their context to cancel long-running database queries or external fetch requests; raise the limit only if the work genuinely needs it. See [Timeouts and Cooperative Cancellation](/api-routes#timeouts-and-cooperative-cancellation).

### 500 from an API route

The terminal line `[bascik] API route handler error in <file> (<method>):` carries the stack. A common cause is `await request.json()` on a malformed body without a `try/catch`; the linter flags that pattern. See [Error Handling and Information Protection](/api-routes#error-handling-and-information-protection).

## Exec scripts and watch paths

### `exec "scripts/gen.ts" timed out after 30000ms` or `exited with code 1`

A `pipeline.exec` script failed or overran. The script's own output is printed above the message. Fix the script, or raise its `timeout`. See [Exec Scripts](/exec-scripts).

### My `parallel` exec script's output is missing from the build

In `bascik --build`, `parallel` lifecycle scripts are spawned concurrently and joined before page transpilation begins. However, if transpilation requires generated content from a script, configure that script with `phase: 'pre'` to guarantee it finishes before page compilation starts. See [Exec Scripts](/exec-scripts).

### `exec script "..." is located inside source directories`

Exec scripts under `src/pages/` or `src/components/` would be treated as source. Keep them in `scripts/` or the project root.

### Editing a data file does not rebuild

The dev server watches pages, components, and files imported by build scripts. A file a script reads at runtime (a JSON it `readFile`s, a Markdown directory) must be listed in `pipeline.watchPaths`. See [Watch Paths](/watch-paths).

## Dev server

### `Port 8080 is in use, trying 8081…`

Another process holds the port. In development Bascik moves to the next free port and prints the URL it chose; set `http.port` to pin one. See [Starting the Dev Server](/development-server#starting-the-dev-server).

### Live reload stopped working

If live reload previously disconnected behind a corporate proxy or VPN, Bascik now sends automatic comment heartbeats every 20 seconds to prevent proxy idle timeouts. If you are developing with multiple tabs open or experiencing a build error, an in-browser overlay will display the exact error location until corrected. If the page still does not reload, make sure the tab is on the dev server's origin and not a cached copy, and restart the server if the config changed. See [Live Reload via Server-Sent Events](/development-server#live-reload-via-server-sent-events-sse).

### The browser rejects the dev TLS certificate

Self-signed certificates include the SubjectAltName entries modern browsers require (`localhost`, `*.localhost`, `127.0.0.1`, `::1`); install `mkcert` and Bascik uses it to issue a locally trusted certificate instead. See [HTTP/2 & TLS Support](/production-server#http2-tls-support).

### `could not create static-asset symlinks; copying assets instead.`

`assets.symlink: true` needs permission to create symlinks. On Windows, enable Developer Mode or grant the symlink privilege; otherwise Bascik copies the files, which is slower but correct. See [Linked Static Assets](/development-server#linked-static-assets).

### A deleted page is still served

Current Bascik versions clean `directory.out` at the start of every dev and build run, before pre-phase lifecycle scripts execute. A page, renamed asset, or removed dynamic route from an earlier run should therefore not remain in the new output. `bascik --server` is intentionally read-only: it starts the production runtime from output previously generated by `bascik --build`, so it neither builds nor cleans files. For local development, plain `bascik` transpiles, serves, watches, and reloads the site in one command.

If stale output remains, confirm that the command is running from the expected project root and that `directory.out` points to the directory you are inspecting.

## Production server

### `--server: could not read dist/ directory` or `no HTML pages found in dist/`

`bascik --server` serves a finished build and never builds. Run `bascik --build` first, from the same project root, with the same `directory.out`. See [Starting the Production Server](/production-server#starting-the-production-server).

### `Port 8080 is already in use. Under --server, specify a free port with --port or http.port.`

Under `bascik --server`, encountering `EADDRINUSE` fails fast with an explicit error rather than silently incrementing to another port. This ensures traffic intended for your configured port is not routed to an unmonitored port. Free the port, or choose another with `--port` or `http.port`. In local development mode (`bascik`), auto-incrementing remains active.

### The server exited with `Fatal uncaught exception` or `Fatal unhandled promise rejection`

If `bascik --server` exited unexpectedly, check the process log for `[bascik] Fatal uncaught exception:` or `[bascik] Fatal unhandled promise rejection:`. Bascik captures unhandled errors and deliberately terminates with code `1` rather than continuing in an unsafe memory state. Ensure your deployment environment has a process supervisor configured to restart the server on failure. See [Do I need a process supervisor?](/faq#do-i-need-a-process-supervisor).

### The rate limit blocks every user

If `bascik --server` runs behind a CDN or load balancer without `http.trustProxy: true`, all incoming connections share the CDN's socket IP address. One active user will exhaust the rate limit budget for all users. Enable `trustProxy: true` under `http` or `export const server` in `bascik.config.ts` so client IPs are resolved from the trusted reverse proxy headers. See [`http`](/configuration#http).

### Deploys drop requests

Point the orchestrator's readiness probe at `GET /_health`. On `SIGTERM` the server reports 503 there while it drains in-flight requests for `http.timeouts.drain`, so the balancer moves traffic before the process exits. See [Graceful Shutdown & Health Checks](/production-server#graceful-shutdown-health-checks).

### Requests are missing from the logs

In earlier releases, static asset streams logged before the file descriptor finished opening. Bascik now logs static asset and page requests when the response finishes transmission, capturing the HTTP status and total transfer time. Set `logging.requests: false` if you prefer to suppress request logs, and check that setting first if requests you expect never appear. See [`logging`](/configuration#logging).

## Build output and deployment

### Pages are missing from the sitemap after a build

A targeted `bascik --build --only "<glob>"` leaves other pages in place but skips sitemap and robots generation so nothing is delisted. Run a full build before deploying. See [Targeted builds](/cli#targeted-builds-only).

### My hand-written `robots.txt` or `sitemap.xml` was replaced

In earlier versions of Bascik, generated files could overwrite authored ones. Bascik now checks the source tree (`src/pages/robots.txt` or `src/pages/sitemap.xml`) before generating files. If an authored file exists, Bascik preserves it and emits a warning with steps to configure `generate.robots: false` or delete the authored file. See [Sitemap & robots.txt](/sitemap).

### Requests under `base` return 404 or `fetch('/api/x')` fails

With `base: '/docs/'` the site is served only below `/docs/`, matching a static subdirectory host, so a request without the prefix returns 404. See [Subdirectory deploys](/deployment#subdirectory-deploys).

A `fetch('/api/x')` in client code fails under `base` because Bascik cannot safely infer URLs assembled or used inside JavaScript, so it does not rewrite them. Emit `process.env.BASCIK_BASE` into a data attribute from a build script, read that value from the DOM, and prefix the request path in client code. This keeps the deployment value build-time and adds no Bascik runtime. See [`BASCIK_BASE`](/build-scripts#bascik_base) for an illustrative pattern.

### Part of the page disappeared after minification

Current Bascik versions shield scripts, `<pre>`, and `<textarea>` before stripping HTML comments, so a literal `<!--` inside JavaScript or JSON-LD cannot consume the rest of the document. Scripts nested inside a container also remain in that container. If output still disappears, check for an unclosed ordinary HTML comment outside those raw-text regions and compare with `minify.html: false`, which disables page and component HTML minification. See [`minify` (BYOMinifier)](/configuration#minify-byominifier).

### `HTML minification failed for "..."` or `CSS minification failed for ...`

A `minify.html`, `minify.css`, or `minify.js` function you supplied threw. In dev the page or asset is emitted unminified with a warning; in `bascik --build` the error is reported. Fix or remove the minifier. See [`minify` (BYOMinifier)](/configuration#minify-byominifier).

### Browser assets re-download after every deploy

In earlier versions, static asset ETags were derived from file modification times (`mtime`), which differed across CI checkouts and server replicas. Bascik now uses deterministic SHA-256 content hashes for all static and page ETags, computed once and cached in memory. Identical bytes produce identical ETags across separate server instances and deploys. If assets still re-download, a CDN or proxy in front of the server is stripping or rewriting the headers. See [In-Memory Caching & ETags](/production-server#in-memory-caching-etags).

### Inline scripts are blocked by my Content Security Policy

Bascik inlines component scripts and styles and sets no CSP header itself. Turn on `generate.cspHashes: true` and feed `dist/.bascik/csp-hashes.json` to the host or CDN that sets the header. See [Content Security Policy](/how-to/content-security-policy).

### Cloudflare: `"node:fs" (imported by ...) is not available in the Cloudflare Workers runtime`

A server script or API route imports a Node module the Workers runtime does not provide. The message lists the supported `node:*` modules; replace the import with a Web standard API or a pure JavaScript package. `authored file "..." collides with a generated control file` means a file in `src/pages/` has the same name as a file the adapter writes (such as `_routes.json`); rename it. See [Cloudflare Adapter](/deployment/cloudflare).
