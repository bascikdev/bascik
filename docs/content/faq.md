# FAQ

Answers to common questions about Bascik.

## How do you pronounce Bascik? Where does the name come from?

Just like "basic." The idea is basic, the implementation is basic in theory, and the usage is basic. It felt like the right word.

The spelling comes from my maternal grandmother's maiden name. So the name is unique and means something personal.

## Isn't BASIC already a programming language?

Yes. In fact some of my earliest exposure to programming was to TI-Basic on my friend's calculator. BASIC is an old programming language and enough time has passed. It can take on new meaning.

## What is Bascik?

Bascik is a build tool for HTML components with automatically scoped CSS and JS. Zero runtime. The code that ships is the code you wrote. You write reusable components in vanilla HTML, CSS, and JavaScript. At build time, Bascik resolves your custom tags to their component source, scopes CSS and JavaScript so they never collide across instances, and outputs a directory of vanilla HTML files.

By default the output is fully static and can be hosted anywhere. If you need per-request dynamic content, the [production server](/server) lets you run server-side scripts that inject into specific sections of a page at request time, while everything else stays static.

For a deeper look: [Getting Started](/getting-started), [Scoped CSS](/scoped-styles), [Scoped JavaScript](/scoped-javascript), [Switch to Bascik](/switch).

## Who made Bascik?

Bascik was created by [Collin Thomas](https://github.com/collin-thomas).

## Why did you build Bascik?

I started building Bascik in late 2022. I wanted to build the fastest websites. As soon as you have more than just a single page, you need components to share elements, like a nav or footer, across pages. I thought modern HTML, CSS, and JavaScript have gotten so good and widely adopted by browsers that I don't need or want any abstraction layer from a framework getting in the way. I definitely didn't want JavaScript as a runtime bottleneck.

Components have always been a JavaScript thing. Web Components tried to make it native but it's still JavaScript. There's always shadow DOM or virtual DOM involved with components. I decided we don't need any of that. Think about it, you can write HTML, CSS, and JavaScript and use it in multiple places on a site, you just need to copy it and scope it. To automate that, at it's core, it's just a bunch of regular expressions.

That might seem like a big undertaking, but the web standards are so well defined that you have an obtainable target. It'll just take some effort. So that's what I did.

Then I saw the rise of AI-assisted coding and thought, this tool I've been building is going to be perfect for that. Web development frameworks and tooling primarily exists to make tasks easier for developers. But when the levels of abstraction start getting in the way, a tool that doesn't impose its own rules and instead uses the fundamental web languages is going to be great for both developers and AI-assisted coding.

## Will there ever be a version 2.0.0 of Bascik?

I don't intend to ever create new major versions of Bascik. There isn't a need to. The web is stable and Bascik is built to adhere to web standards.

I find great satisfaction in providing long term stability and not causing churn for teams trying to keep up with the latest version.

Bascik will advance through minor updates to support new browser capabilities, performance enhancements, and new features.

Then of course, I hope for very few patch updates as stability is a top priority.

## What happens if I name a component after a native HTML element?

If you create a file like `nav.html` or `div.html`, Bascik will print a warning in the terminal when starting the dev server or running a build, and still load it:

```text
warning: Component "nav" has the same name as a native HTML element.
This may cause unexpected behavior, consider a hyphenated name like "my-nav".
```

The component will conflict with every occurrence of that element in your pages. All your `<nav>` tags would be replaced by the component content, most likely breaking your site entirely.

Always use a hyphenated name for components, for example `site-nav.html` instead of `nav.html`. This follows the HTML custom element convention: a hyphen in the tag name is how browsers (and Bascik) distinguish a component from a built-in element.

## What happens if I use uppercase letters in a component filename?

Component names are normalized to lowercase when loaded. `My-Card.html` registers as `my-card` and is used as `<my-card>` in pages.

If you have two files that differ only in case (for example `my-card.html` and `My-Card.html`), they both map to the same `my-card` component key and the last one loaded wins. Avoid this situation by using consistent lowercase filenames.

> **Convention.** Use lowercase, hyphenated filenames for all components: `site-nav.html`, `feature-card.html`, `alert-box.html`. This matches the HTML custom element convention and avoids any case-collision surprises.

## What happens if I reference a component that doesn't exist?

During a build, Bascik emits a warning naming the unresolved tag, and the tag ships to the output unchanged. The build does not fail.

However, `bascik --check` currently treats an unknown hyphenated tag as an error and exits with code 1. This is why third-party web components such as `<model-viewer>` and `<ion-icon>` currently fail `--check` (an upcoming update changes this validation to emit a warning instead).

## Can I use Bascik with JavaScript libraries like Alpine.js or HTMX?

Yes. Bascik's output is vanilla HTML. Any library that works with HTML works with Bascik. Drop a `<script>` tag in and it loads like it always has. See the [JavaScript Libraries](/libraries) page for examples.

## Does Bascik add any JavaScript to my pages?

No. Bascik is a build-time tool. The output is vanilla HTML, CSS, and exactly the JavaScript you wrote. No runtime script is injected into your pages.

## Can I organize components into subfolders?

Yes. You can organize `src/components/` however you prefer: completely flat, grouped by feature or section (e.g. `src/components/marketing/promo-card.html`), or in dedicated per-component directories (e.g. `src/components/alert-box/alert-box.html`).

Tag names come from the filename only, so subfolders do not create separate namespaces. `src/components/marketing/promo-card.html` registers `<promo-card>`. Choose whichever folder structure fits your project, ensuring each component file has a unique name.

## What happens if two components have the same name?

If two component files define the same tag name (such as `src/components/marketing/card.html` and `src/components/admin/card.html`, or `card.html` and `card.v2.html`), Bascik throws a build error naming both colliding file paths. Duplicate component names are not allowed because tag names come from the filename alone.

## Why did my hand-written robots.txt get overwritten?

In earlier versions of Bascik, generated files could overwrite authored ones. Bascik now checks the source tree (`src/pages/robots.txt` or `src/pages/sitemap.xml`) before generating files. If an authored file exists, Bascik preserves it and emits a warning with steps to configure `generate.robots: false` or delete the authored file.

## Why do two builds of the same source produce byte-identical output?

Bascik builds are fully deterministic. Component instance IDs (used for scoped `id` and `name` DOM attributes) are derived deterministically from the page path, component name, and ordinal index of each instance on the page. Under the default configuration, class names omit instance IDs entirely and were already deterministic. This design guarantees that identical source input produces byte-identical output across repeated runs, worker threads, and different machines.

## Do I need a process supervisor?

Yes, when running `bascik --server` in production, a process supervisor such as systemd, Docker container restart policy, or Kubernetes pod supervisor is expected.

Bascik provides process-level crash safety handlers for unexpected rejections or exceptions. Instead of attempting ungraceful recovery in an indeterminate state, it logs full diagnostic context and exits with a non-zero code (`1`). A supervisor restarts the process cleanly.

## Why did my server exit?

If `bascik --server` exited unexpectedly, check the process log for `[bascik] Fatal uncaught exception:` or `[bascik] Fatal unhandled promise rejection:`. Bascik captures unhandled errors and deliberately terminates with code `1` rather than continuing in an unsafe memory state. Ensure your deployment environment has a process supervisor configured to restart the server on failure.

## What is `dist/.bascik/`?

`dist/.bascik/` is a build-internal directory that holds artifacts generated for deployment tools and runtime servers. For example, `generate.manifest: true` writes `dist/.bascik/manifest.json`, `generate.cspHashes: true` writes `dist/.bascik/csp-hashes.json`, and static builds with server scripts write `dist/.bascik/server-scripts.json`. Because the directory starts with a dot, Bascik's built-in servers and request guards 404 all requests to `/.bascik/*` to prevent exposing build inventory.

## How do I use a strict Content Security Policy with Bascik?

Enable `generate.cspHashes: true` in `bascik.config.ts`. Bascik computes SHA-256 hashes for all inlined component scripts and stylesheets and outputs them in `dist/.bascik/csp-hashes.json`. You can then consume this file in a post-build script to emit strict `script-src` and `style-src` hash directives for your hosting platform.

## Why did my dynamic route 404?

Dynamic route parameters must be URL-safe tokens. Characters like `#`, `%`, `&`, `'`, `+`, spaces, leading dots, and Windows device names are disallowed. Also ensure your template's routes script returned an array containing valid `params` objects matching the bracket names in the filename.

## Why is my rate limit blocking everyone behind my CDN?

If `bascik --server` runs behind a CDN or load balancer without `http.trustProxy: true`, all incoming connections share the CDN's socket IP address. One active user will exhaust the rate limit budget for all users. Enable `trustProxy: true` under `http` or `export const server` in `bascik.config.ts` so client IPs are resolved from the trusted reverse proxy headers.

## Why did live reload stop working?

If live reload previously disconnected behind a corporate proxy or VPN, Bascik now sends automatic comment heartbeats every 20 seconds to prevent proxy idle timeouts. If you are developing with multiple tabs open or experiencing a build error, an in-browser overlay will display the exact error location until corrected.

## Why did my deployment fail to bind the port?

Under `bascik --server`, encountering `EADDRINUSE` fails fast with an explicit error rather than silently incrementing to another port. This ensures traffic intended for your configured port is not routed to an unmonitored port. In local development mode (`bascik`), auto-incrementing remains active.

## How do I do a zero-downtime deploy?

Configure your orchestrator or reverse proxy to use `GET /_health` as the readiness probe. When a deployment replaces existing containers, sending `SIGTERM` makes Bascik report `503` on `/_health` immediately while draining existing requests within `http.timeouts.drain` (default 5 seconds). Once the load balancer shifts traffic to the new instances, the old process exits cleanly.

## Why is my build script output stale?

Bascik caches build script executions based on statically scanned local dependencies. If your script fetches data from a remote network API, reads a directory dynamically via `readdir`, or uses computed file paths, configure `scripts.cache.exclude` in `bascik.config.ts` to exclude that path from caching.

## Can I rebuild only part of my site?

Yes. Run `bascik --build --only "<glob>"` to selectively transpile matching pages (e.g. `bascik --build --only "blog/**"`). Targeted builds do not clean the output directory, so your other compiled pages remain intact in `dist/`. Note that sitemap and robots generation is skipped during targeted builds to prevent delisting pages that were not rebuilt; run a full build before deploying to production.

## Why did my `parallel` exec script's output not appear?

In `bascik --build`, `parallel` lifecycle scripts are spawned concurrently and joined before page transpilation begins. However, if transpilation requires generated content from a script, configure that script with `phase: 'pre'` to guarantee it finishes before page compilation starts.

## How do local script references (`<script src="...">`) work inside a component?

When a component `.html` file includes a `<script src="counter.ts"></script>` tag pointing to a local file in its component directory, Bascik resolves and inlines that script at build time.

It automatically wraps the script in an isolated IIFE, rewrites DOM selector calls for scoping, and attaches DevTools `//# sourceURL` directives mapping directly back to your source `.ts`/`.js` file.

Unreferenced local files are ignored so Node build/server helpers are never accidentally bundled into client code. External `<script src="...">` links pointing to CDNs or global assets are left untouched and passed through to the page output.

## What happens if I place other files or helper modules in my component directory?

Nothing gets copied to `dist/`.

The `src/components/` directory is treated strictly as source-only files:
- Component `.html` templates are resolved and inlined into pages at build time.
- Companion `.css` files are scoped and deduplicated into page `<style>` blocks.
- Client `.ts`, `.js`, or `.mjs` scripts referenced via `<script src="...">` are inlined and scoped into page `<script>` blocks.
- Build-time (`data-bascik-build`) and server-time (`data-bascik-server`) scripts run in Node.js, and their stdout replaces the script tag.
- Any other files (helper modules, JSON data files, tests, READMEs) stay in `src/components/` and are never copied to `dist/`.

Static assets intended to be served directly as public URLs should be placed in `src/pages/` instead.

## Which files in `src/pages/` are copied to `dist/` and which are excluded?

Eligible static assets placed in `src/pages/` are copied to `dist/` with their directory structure preserved. This makes `src/pages/` the publish tree for both routes and their browser assets.

The following files are **excluded** from static asset copying:
- **`.html` page templates**: compiled into output HTML pages in `dist/`.
- **Source and documentation files**: `.ts`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.map`, and `.md`.
- **Test files**: any file matching `*.test.*` or `*.spec.*` (such as `styles.test.ts` or `api.spec.js`).
- **Hidden paths**: any dotfile or file inside a dot-directory.
- **Dependencies**: any file inside a `node_modules` directory.
- **Inlined stylesheets**: global CSS files configured in `inlineStyles` (injected directly into page `<head>` blocks).
- **Component directory files**: everything in `src/components/` is source-only and never copied directly to `dist/`.

`assets.exclude` adds project-specific glob exclusions matched relative to `directory.pages`. The built-in exclusions always apply.

## Where should I put images and fonts?

Put them under `directory.pages`, either beside the page that uses them or in a shared folder such as `src/pages/assets/`, `src/pages/images/`, or `src/pages/fonts/`. For example, `src/pages/fonts/site.woff2` becomes `dist/fonts/site.woff2`.

Keep tests and source-only helpers outside `directory.pages`. For project-specific exceptions, add page-relative glob patterns to `assets.exclude`. If assets must come from a separate source tree, use a `pipeline.exec` script to copy intentionally selected files into `directory.out`.

## Do I need to restart the dev server when I add a new component?

No. The dev server watches the components directory. Drop a new `.html` (or paired `.css`) file in and all pages that use that tag are automatically re-transpiled and reloaded. No restart required.

## Can Bascik components be nested?

Yes. Components can use other components inside their markup. Bascik resolves nested components recursively at build time.

## Why is my prop value showing as escaped text?

Props are text values. Bascik HTML-escapes them during injection so markup from a CMS, database, or API cannot become an executable element or script. If you need rich HTML or a nested component, pass it through a default or named [slot](/slots) instead. Slot content remains markup and participates in component scoping.

## How do I put a prop into an attribute?

Add `data-bascik-attr-{attribute}="{propName}"` to the target element in the component template. For example, `<a data-bascik-attr-href="link">` reads `data-bascik-prop-link="/about"` from the component usage and emits `<a href="/about">`. This works on non-root elements, unlike attribute inheritance. It is a build-time `data-*` directive, not a variable or templating expression. See [Props](/props#put-a-prop-in-an-attribute).

## How do I use a third-party widget that looks up an element by ID?

Add a bare `data-bascik-preserve` directive to the widget mount point. Its literal ID and subtree remain unscoped, so calls such as `turnstile.render('widget-mount')` can find it. Bascik removes the directive from compiled output. See [Preserve Scoping](/preserve).

## Why are my form field names hashed?

Bascik scopes `name` per component instance so repeated radio groups remain independent. For a form that posts to an external service requiring literal keys, add `data-bascik-preserve="name"` to the form. This deliberately gives up radio-group isolation inside that preserved subtree, so do not disable name scoping site-wide. See [Preserve Scoping](/preserve).

## Why is my `<label for>` not working?

Bascik rewrites `<label for>` automatically when the matching `id` is declared in the same component. The label and control receive the same per-instance scoped identifier, including when identifier minification is enabled. A reference to an ID in another component is left unchanged because Bascik cannot choose that component's instance at build time. Keep the label and control together or target a literal page-shell ID. See [Scoped JavaScript](/scoped-javascript#html-id-references).

## Why is my inline SVG gradient not showing?

Declare the gradient ID and its CSS `url(#id)` reference in the same component. Bascik rewrites the fragment to the instance-scoped ID and automatically emits per-instance CSS for that component. Cross-document fragments such as `url(sprite.svg#icon)` are intentionally untouched. For an SVG ID graph owned by another tool, use [Preserve Scoping](/preserve). See [Scoped Styles](/scoped-styles#css-fragment-references).

## How do I generate pages dynamically from a CMS, database, or API?

Use [Dynamic Routes](/dynamic-routes). Create a template file with bracket parameter syntax in its filename (such as `src/pages/blog/[slug].html` or `src/pages/products/[id].html`) and add a `<script data-bascik-routes>` script.

The script runs in Node.js at build time, queries your headless CMS, database, or REST API, and prints a JSON array of `{ params, data }` route objects using `console.log()`. Bascik expands the single template into concrete static HTML pages in `dist/`. Inside the template, `<script data-bascik-build>` blocks read the route params and data from `process.env.BASCIK_ROUTE`.

## What does Bascik output?

A directory of plain `.html` files (and your assets). No client-side JavaScript framework, no special server required. Any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages, S3, or a plain Nginx server) can serve it.

## Why did my deleted page keep showing up in `dist/`?

Current Bascik versions clean `directory.out` at the start of every dev and build run, before pre-phase lifecycle scripts execute. A page, renamed asset, or removed dynamic route from an earlier run should therefore not remain in the new output. `bascik --server` is intentionally read-only: it starts the production runtime from output previously generated by `bascik --build`, so it neither builds nor cleans files. For local development, plain `bascik` transpiles, serves, watches, and reloads the site in one command.

If stale output remains, confirm that the command is running from the expected project root and that `directory.out` points to the directory you are inspecting.

## Can I see the transpiled HTML during development?

Yes. Dev mode stores the updated page in memory first so it can be served immediately, then writes the same transpiled HTML to `directory.out` asynchronously. You can inspect `dist/index.html` or the corresponding nested output file while the dev server runs without adding disk latency to page serving.

## How does Bascik handle bad markup or invalid code? Does it crash?

The dev server is resilient to a bad page, while a production build fails rather than shipping incomplete output. During development, Bascik logs the page failure, completes boot, continues serving healthy pages, and retries the failed page when you save a fix. During `bascik --build`, hard failures from all pages are aggregated into one report and the process exits nonzero.

- **Unclosed Component Tags:** If a component tag is unclosed, for example `<my-component>` with no closing `</my-component>` tag, Bascik safely falls back to treating it as a self-closing tag, compiles it with empty inner content, and proceeds. The VS Code extension also issues a warning so you can fix it easily.
- **Unclosed or Invalid Standard HTML:** Bascik does not use a rigid HTML/XML AST parser for standard elements. If you have unclosed or invalid native HTML tags (such as `<div>` or `<p>`), they are passed directly to the output files untouched. This allows the browser's native parser to handle the layout, ensuring that standard markup errors never crash your build processes.
- **Missing Page Body:** A page without a non-empty `<body>` cannot produce a deployable page. It is a hard build error and a recoverable page error in dev mode.
- **Runaway Component Expansion:** Direct or indirect recursive component expansion is a hard page error when it reaches the safety limit. Partial HTML is never reported as a successful build output.
- **Component Transpilation Failures:** Each component transpilation step is wrapped in a `try-catch` block. If a component fails to compile, Bascik logs a detailed error with line and column numbers to `console.error`, removes the failed component tag, and continues compiling the rest of the page.
- **Build-time & Server-side Scripts (`data-bascik-build` / `data-bascik-server`):** If a script block fails to execute due to syntax errors or runtime exceptions, Bascik logs the detailed error to `console.error` and stops by default. You can tune behavior separately with `scripts.onBuildScriptError`, `scripts.onRoutesScriptError`, and `scripts.onServerScriptError` in `bascik.config.ts`.
- **Client-side / Browser-side JavaScript:** Standard scripts are wrapped in an IIFE for scoping, but they are not parsed or executed during the build. If there is a syntax error or a logical bug in your browser-side JavaScript, it is compiled as-is and sent to the client browser, where the error will be printed in the browser's developer console without affecting your server or build processes.
- **CSS Syntax and File-Read Errors:** If a companion `.css` file or style block contains invalid syntax, Bascik's scoping engines skip the invalid patterns, scope the valid rules, and continue compiling. If a companion `.css` file cannot be read from the disk due to permissions or reference issues, Bascik handles the exception gracefully, logs a warning, and continues compilation.
- **Source and Output I/O:** A missing or unreadable configured pages directory, failure to create an output directory, or failure to write a page is fatal in build mode. These errors are never discarded, including `ENOENT` write failures.

## Why did part of my page disappear after HTML minification?

Current Bascik versions shield scripts, `<pre>`, and `<textarea>` before stripping HTML comments, so a literal `<!--` inside JavaScript or JSON-LD cannot consume the rest of the document. Scripts nested inside a container also remain in that container. If output still disappears, check for an unclosed ordinary HTML comment outside those raw-text regions and compare with `minify.html: false`, which disables page and component HTML minification.

## Why do I see multiple identical script tags in my page output?

This is by design and is how Bascik's component scoping works.

When you use a component multiple times on a page, each instance of that component includes its corresponding `<script>` block in the expanded output. Because class names are scoped to the component name rather than an individual instance ID (which allows CSS rules to be deduplicated into a single `<style>` block), component scripts that query elements by class name or use DOM traversal produce identical JavaScript code for every instance.

Each script tag is isolated in its own IIFE so variables never leak into the global scope. Having one script tag per component instance guarantees that every instance receives its behavior without requiring a runtime framework, component registry, or bundling step.

## Why is `siteUrl` an environment variable and not a config option?

Because the site URL changes per deployment, not per project. Staging, production, and preview deploys of the same checked-in source need different values, and putting the URL in `bascik.config.ts` would force CI to mutate a tracked file (or maintain per-branch forks of it) just to build for a different origin.

Bascik follows the standard precedence chain instead: `--site-url` flag, then the `BASCIK_SITE_URL` environment variable, then a `.env` file. Each environment sets its own value and the config file stays untouched. See [Configuration precedence](/configuration#configuration-precedence).

## How do I deploy to `example.com/docs` instead of `example.com`?

Set `base: '/docs/'` in `bascik.config.ts`. Bascik prefixes root-relative HTML and CSS URLs during the build, serves dev and production-server requests below `/docs/`, and includes the prefix in generated sitemap, robots, and canonical URLs. Requests without the prefix return `404`, matching a static subdirectory host. See [Subdirectory deploys](/deploying#subdirectory-deploys).

## Why is my `fetch('/api/x')` broken under `base`?

Bascik cannot safely infer URLs assembled or used inside JavaScript, so it does not rewrite them. Emit `process.env.BASCIK_BASE` into a data attribute from a build script, read that value from the DOM, and prefix the request path in client code. This keeps the deployment value build-time and adds no Bascik runtime. See [`BASCIK_BASE`](/build-scripts#bascik_base) for an illustrative pattern.

## Why is my `bascik.config.ts` being ignored?

Check for a `bascik.config.js` in the same directory. When both files exist in the project root, the `.js` file takes precedence, so a stale or accidental `.js` file shadows your `.ts` config. Delete the `.js` file, or pass `--config bascik.config.ts` to load a specific file explicitly.

Two other things to rule out: only the project root is searched (a config in a subdirectory or parent directory is never picked up), and only the `.js` and `.ts` extensions are supported (`.mjs`, `.cjs`, `.mts`, and `.cts` files are not discovered). See [Config file discovery](/configuration#config-file-discovery).

## How do I add a custom error page?

Add `src/pages/404.html` for not found errors or `src/pages/500.html` for server errors.

Bascik supports custom error pages by convention without needing any configuration. In production server mode, `src/pages/500.html` is transpiled at boot and served whenever an internal error occurs. If absent, a minimal built-in document is served instead. For static sites, `dist/404.html` and `dist/500.html` are standard files ready for your static host or CDN.

## Why are my assets re-downloading after every deploy?

In earlier versions, static asset ETags were derived from file modification times (`mtime`), which differed across CI checkouts and server replicas. Bascik now uses deterministic SHA-256 content hashes for all static and page ETags, computed once and cached in memory. Identical bytes produce identical ETags across separate server instances and deploys.

## Why did my build fail with a configuration error?

Bascik validates `bascik.config.ts` at startup and refuses to run on an invalid configuration, so a mistake surfaces immediately with a clear message instead of a confusing runtime failure later. The report lists every problem at once: each entry names the key, shows the value it received, and states what was expected.

Common causes:

- **A typo in a key name**, such as `directroy:` or `minfy:`. Unknown keys are rejected, with a "did you mean" suggestion when the key is a near miss of a real option.
- **A value of the wrong type or range**, such as `http.port: 70000` or `scripts.timeout: 0`.
- **A path that does not exist**, such as an `exec` script, a `watchPaths` entry, or a TLS certificate file.
- **An invalid `BASCIK_SITE_URL`**, which must be an absolute `http` or `https` URL.

Fix each listed key and re-run. See [Configuration validation](/configuration#configuration-validation).
