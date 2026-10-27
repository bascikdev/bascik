# FAQ

Answers to common questions about Bascik. For error messages and things that stopped working, see [Troubleshooting](/testing/troubleshooting).

## How do you pronounce Bascik? Where does the name come from?

Just like "basic." The idea is basic, the implementation is basic in theory, and the usage is basic. It felt like the right word.

The spelling comes from my maternal grandmother's maiden name. So the name is unique and means something personal.

## Isn't BASIC already a programming language?

Yes. In fact some of my earliest exposure to programming was to TI-Basic on my friend's calculator. BASIC is an old programming language and enough time has passed. It can take on new meaning.

## What is Bascik?

Bascik is a build tool for HTML components with automatically scoped CSS and JS. Zero runtime. The code that ships is the code you wrote. You write reusable components in vanilla HTML, CSS, and JavaScript. At build time, Bascik resolves your custom tags to their component source, scopes CSS and JavaScript so they never collide across instances, and outputs a directory of vanilla HTML files.

By default the output is fully static and can be hosted anywhere. If you need per-request dynamic content, the [production server](/production-server) lets you run [server scripts](/server-scripts) that inject into specific sections of a page at request time, while everything else stays static.

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

Similarly, `bascik --check` reports unmatched hyphenated tags as warnings (exit code 0). This allows third-party web components like `<model-viewer>` or `<ion-icon>` to pass without causing validation errors.

To silence the warning for a tag you own on purpose, list it in [`components.external`](/configuration#componentsexternal), for example `components: { external: ['model-viewer', 'ion-icon', 'vendor-*'] }`. Typos stay reported. `scoping.preserve` does not do this: it only controls attribute scoping.

## What does Bascik output?

A directory of plain `.html` files (and your assets). No client-side JavaScript framework, no special server required. Any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages, S3, or a plain Nginx server) can serve it.

## Does Bascik add any JavaScript to my pages?

No. Bascik is a build-time tool. The output is vanilla HTML, CSS, and exactly the JavaScript you wrote. No runtime script is injected into your pages.

## Can I use Bascik with JavaScript libraries like Alpine.js or HTMX?

Yes. Bascik's output is vanilla HTML. Any library that works with HTML works with Bascik. Drop a `<script>` tag in and it loads like it always has. See the [JavaScript Libraries](/libraries) page for examples.

## Can I use an npm package with no CDN build?

Yes, by bundling it yourself. Bascik does not rewrite bare specifiers in client-side scripts, so `import x from 'some-package'` in a `<script type="module">` fails in the browser. Run esbuild as a `pipeline.exec` step with `phase: 'pre'`, write the bundle into `dist/assets/js/`, and import it from the page with a root-relative URL. See [Bundling npm Packages](/how-to/bundling-npm-packages) for the full recipe.

## Which templating library should I use with Bascik?

**Handlebars** is the recommended option. It is small, its logic-less design fits a build-time system where the template is evaluated once and the result is static HTML, and it escapes values by default. For a single interpolated value on a single page, a roughly fifteen-line dependency-free helper is enough; when it grows past about twenty lines, that is the signal to reach for Handlebars. If your team already knows EJS or Nunjucks, keep using it. See [Templating](/how-to/templating) for the full guide.

## Does Bascik run on Windows?

Windows is a supported platform, and Bascik's own tests run on it in CI. Two things differ from macOS and Linux:

- **Symlinked assets.** `assets.symlink` needs permission to create symlinks. Without it, Bascik warns once and copies the files instead. See [How can I speed up development when my site has many static assets?](#how-can-i-speed-up-development-when-my-site-has-many-static-assets).
- **Line endings.** Source files saved with Windows (CRLF) line endings build to the same output as LF files, so you do not need to convert them. If you keep your project in Git, add `* text=auto eol=lf` to `.gitattributes` so every contributor gets the same bytes.

If something behaves differently on Windows than this page says, please [open an issue](https://github.com/bascikdev/bascik/issues).

## Can Bascik components be nested?

Yes. Components can use other components inside their markup. Bascik resolves nested components recursively at build time.

## Can I organize components into subfolders?

Yes. You can organize `src/components/` however you prefer: completely flat, grouped by feature or section (e.g. `src/components/marketing/promo-card.html`), or in dedicated per-component directories (e.g. `src/components/alert-box/alert-box.html`).

Tag names come from the filename only, so subfolders do not create separate namespaces. `src/components/marketing/promo-card.html` registers `<promo-card>`. Choose whichever folder structure fits your project, ensuring each component file has a unique name.

## What happens if two components have the same name?

If two component files define the same tag name (such as `src/components/marketing/card.html` and `src/components/admin/card.html`, or `card.html` and `card.v2.html`), Bascik throws a build error naming both colliding file paths. Duplicate component names are not allowed because tag names come from the filename alone.

## Do I need to restart the dev server when I add a new component?

No. The dev server watches the components directory. Drop a new `.html` (or paired `.css`) file in and all pages that use that tag are automatically re-transpiled and reloaded. No restart required.

## How do I share components between projects?

A components directory is plain files, so sharing means using `bascik add` from an npm package, copying files directly, or using a git submodule. Component names derive from filenames regardless of subfolder nesting, so a copied component that collides with a local one fails the build by design; rename with a prefix on the way in. See [Sharing Components](/how-to/sharing-components).

## Is there a component registry?

No. Bascik does not host a centralized component registry or index. Instead, Bascik uses standard npm packages as the distribution mechanism via the `bascik.components` field in `package.json`. You install packages using standard package managers (npm, yarn, pnpm) and copy components in with `bascik add`. This avoids a proprietary registry ecosystem, lets you inspect installed files directly, and keeps the build independent of remote network registries.

## What happens if I edit a component I added?

The copied files belong to your project and are meant to be customized. When you edit a copied component, `bascik-lock.json` detects the content modification via its recorded SHA-256 hash. If you later re-run `bascik add <package>`, Bascik protects your work by refusing to overwrite your modified files unless you explicitly pass the `--force` flag.

## What happens if I place other files or helper modules in my component directory?

Nothing gets copied to `dist/`.

The `src/components/` directory is treated strictly as source-only files:

- Component `.html` templates are resolved and inlined into pages at build time.
- Companion `.css` files are scoped and deduplicated into page `<style>` blocks.
- Client `.ts`, `.js`, or `.mjs` scripts referenced via `<script src="...">` are inlined and scoped into page `<script>` blocks.
- Build-time (`data-bascik-build`) and server-time (`data-bascik-server`) scripts run in Node.js, and their returned markup replaces the script tag.
- Any other files (helper modules, JSON data files, tests, READMEs) stay in `src/components/` and are never copied to `dist/`.

Static assets intended to be served directly as public URLs should be placed in `src/pages/` instead.

## How do local script references (`<script src="...">`) work inside a component?

When a component `.html` file includes a `<script src="counter.ts"></script>` tag pointing to a local file in its component directory, Bascik resolves and inlines that script at build time.

A `.ts` or `.mts` companion is stripped to JavaScript first (erasable syntax only, no configuration needed). Bascik then wraps the script in an isolated IIFE, rewrites DOM selector calls for scoping, runs any `minify.js` step, and attaches a DevTools `//# sourceURL` directive on its own final line, mapping directly back to your source `.ts`/`.js` file. Inline blocks can opt in with `<script type="text/typescript">`; an ordinary unmarked `<script>` stays JavaScript, and Bascik warns when it finds TypeScript syntax there.

Unreferenced local files are ignored so Node build/server helpers are never accidentally bundled into client code. External `<script src="...">` links pointing to CDNs or global assets are left untouched and passed through to the page output.

## Why is my prop value showing as escaped text?

Props are text values. Bascik HTML-escapes them during injection so markup from a CMS, database, or API cannot become an executable element or script. If you need rich HTML or a nested component, pass it through a default or named [slot](/slots) instead. Slot content remains markup and participates in component scoping.

## How do I put a prop into an attribute?

Add `data-bascik-attr-{attribute}="{propName}"` to the target element in the component template. For example, `<a data-bascik-attr-href="link">` reads `data-bascik-prop-link="/about"` from the component usage and emits `<a href="/about">`. This works on non-root elements, unlike attribute inheritance. It is a build-time `data-*` directive, not a variable or templating expression. See [Props](/props#put-a-prop-in-an-attribute).

## Why do I see multiple identical script tags in my page output?

This is by design and is how Bascik's component scoping works.

When you use a component multiple times on a page, each instance of that component includes its corresponding `<script>` block in the expanded output. Because class names are scoped to the component name rather than an individual instance ID (which allows CSS rules to be deduplicated into a single `<style>` block), component scripts that query elements by class name or use DOM traversal produce identical JavaScript code for every instance.

Each script tag is isolated in its own IIFE so variables never leak into the global scope. Having one script tag per component instance guarantees that every instance receives its behavior without requiring a runtime framework, component registry, or bundling step.

## Why are my form field names hashed?

Bascik scopes `name` per component instance so repeated radio groups remain independent. For a form that posts to an external service requiring literal keys, add `data-bascik-preserve="name"` to the form. This deliberately gives up radio-group isolation inside that preserved subtree, so do not disable name scoping site-wide. See [Preserve Scoping](/preserve).

## How do I use a third-party widget that looks up an element by ID?

Add a bare `data-bascik-preserve` directive to the widget mount point. Its literal ID and subtree remain unscoped, so calls such as `turnstile.render('widget-mount')` can find it. Bascik removes the directive from compiled output. See [Preserve Scoping](/preserve).

## Where should I put images and fonts?

Put them under `directory.pages`, either beside the page that uses them or in a shared folder such as `src/pages/assets/`, `src/pages/images/`, or `src/pages/fonts/`. For example, `src/pages/fonts/site.woff2` becomes `dist/fonts/site.woff2`.

Keep tests and source-only helpers outside `directory.pages`. For project-specific exceptions, add page-relative glob patterns to `assets.exclude`. If assets must come from a separate source tree, use a `pipeline.exec` script to copy intentionally selected files into `directory.out`.

## Which files in `src/pages/` are copied to `dist/` and which are excluded?

Eligible static assets placed in `src/pages/` are copied to `dist/` with their directory structure preserved. This makes `src/pages/` the publish tree for both routes and their browser assets.

The following files are **excluded** from static asset copying:

- **`.html` page templates**: compiled into output HTML pages in `dist/`.
- **Source and documentation files**: `.ts`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.map`, and `.md`.
- **Test files**: any file matching `*.test.*` or `*.spec.*` (such as `styles.test.ts` or `api.spec.js`).
- **Hidden paths**: any dotfile or file inside a dot-directory. The exception is a top-level `src/pages/.well-known/` directory, which is published to `/.well-known/` (see [Well-Known URIs](/deployment#well-known-uris)).
- **Dependencies**: any file inside a `node_modules` directory.
- **Inlined stylesheets**: global CSS files configured in `assets.inlineStyles` (injected directly into page `<head>` blocks).
- **Component directory files**: everything in `src/components/` is source-only and never copied directly to `dist/`.

`assets.exclude` adds project-specific glob exclusions matched relative to `directory.pages`. The built-in exclusions always apply.

## How do I add a custom error page?

Add `src/pages/404.html` for not found errors or `src/pages/500.html` for server errors.

Bascik supports custom error pages by convention without needing any configuration. In production server mode, `src/pages/500.html` is transpiled at boot and served whenever an internal error occurs. If absent, a minimal built-in document is served instead. For static sites, `dist/404.html` and `dist/500.html` are standard files ready for your static host or CDN.

## How do I generate pages dynamically from a CMS, database, or API?

Use [Dynamic Routes](/dynamic-routes). Create a template file with bracket parameter syntax in its filename (such as `src/pages/blog/[slug].html` or `src/pages/products/[id].html`) and add a `<script data-bascik-routes>` script.

The script runs in Node.js at build time, queries your headless CMS, database, or REST API, and exports a default callable function returning an array of `{ params, data? }` route objects. Bascik expands the single template into concrete static HTML pages in `dist/`. Inside the template, `<script data-bascik-build>` blocks read the route params and data from `process.env.BASCIK_ROUTE`.

## Should I fingerprint my assets?

Probably not. Bascik inlines component CSS and JavaScript, so fingerprinting only matters for images, fonts, and other copied page assets. The production server already sends content-hash `ETag` headers, and `http.cacheControl` tunes per-extension caching with no build step. Fingerprinting is for immutable, far-future caching on a CDN, and it will not improve a Lighthouse score (`uses-long-cache-ttl` is unweighted in Lighthouse 10 and later). See [Asset Fingerprinting](/how-to/asset-fingerprinting).

## How can I speed up development when my site has many static assets?

For a site with many large images, PDFs, fonts, media files, or downloads, enable development asset symlinks:

```ts
export default defineConfig({
  assets: { symlink: true },
});
```

Bascik then links unchanged assets from `src/pages/` into `dist/` instead of copying their bytes on each development startup. It still copies files that Bascik transforms, such as minified CSS or JavaScript and rewritten web manifests. Production builds always create regular files, never symlinks.

Restart the dev server after changing configuration. Each dev startup clears `dist/`, so previously copied assets are recreated as links. On Windows, if symlink permissions are unavailable, Bascik warns once and falls back to copying. Enable Developer Mode or grant symlink permission to use the faster path.

## Why do build scripts export a function instead of using console.log()?

Build scripts (`<script data-bascik-build>`) and dynamic route scripts (`<script data-bascik-routes>`) run as standard ECMAScript modules outside the browser. They export a callable default function that returns their result: an HTML string for build scripts, or an array of route entries for dynamic route scripts.

Standard console methods (`console.log()`, `console.error()`) write diagnostic logs to the terminal for debugging only. By separating the result channel from standard output, diagnostic messages from user code and third-party dependencies never leak into generated HTML markup or corrupt route payloads. If you need request-time server rendering with access to the incoming request, server scripts (`<script data-bascik-server>`) export a default request handler function (`export default function(request) { return ... }`). See [Build Scripts](/build-scripts#handler-contract--console-logging).

## Can I rebuild only part of my site?

Yes. Run `bascik --build --only "<glob>"` to selectively transpile matching pages (e.g. `bascik --build --only "blog/**"`). Targeted builds do not clean the output directory, so your other compiled pages remain intact in `dist/`. Note that sitemap and robots generation is skipped during targeted builds to prevent delisting pages that were not rebuilt; run a full build before deploying to production.

## Can I see the transpiled HTML during development?

Yes. Dev mode stores the updated page in memory first so it can be served immediately, then writes the same transpiled HTML to `directory.out` asynchronously. You can inspect `dist/index.html` or the corresponding nested output file while the dev server runs without adding disk latency to page serving.

## Why do I need to restart after changing my config?

Bascik deep-freezes configuration at server boot to guarantee consistency across worker threads, routers, and watchers. When `bascik.config.ts` changes during development, Bascik logs a restart hint. Hot config reload is intentionally avoided to prevent state desynchronization.

## Why does my browser reject the dev TLS certificate?

Modern browsers require SubjectAltName (SAN) extensions on certificates. When generating self-signed certificates (`http.tls.enabled: true`), Bascik creates certificates with SAN extensions covering `localhost`, `*.localhost`, `127.0.0.1`, and `::1`. If you have `mkcert` installed, Bascik uses it to create locally-trusted certificates automatically.

## What does `bascik --check` actually check?

`bascik --check` validates pages, components, config, and API route files in one pass. It does this in two halves, and each rule lives in exactly one of them.

**Project checks**, which `bascik` runs itself because they need the whole project:

- Config and path validation issues (including missing script paths and unreadable TLS files)
- Missing site URL when sitemap/robots generation is enabled
- Duplicate component tag names and circular component references
- Two pages, or two API route files, that resolve to the same URL
- Unmatched or unused components
- WHATWG HTML5 parse errors in every compiled `dist/` HTML file (requires [parse5](https://parse5.js.org/) as a dev dependency; if not installed, `--check` prints a one-line install hint instead)

**Per-file checks**, which need only one file and come from the [linter](/tools/linter) (`@bascik/language-server`, which projects created with `npm create bascik` already have):

- Unknown `data-bascik-*` attribute names (likely typos)
- Script mode conflicts such as one tag containing both `data-bascik-build` and `data-bascik-server`
- API route files with no method handler, or with a method export that is not uppercase
- CSS and JavaScript in components that cannot be scoped
- Advisory conventions such as component `<style>` placement and `<script>` placement ordering

If the linter is not installed, the project checks still run and the report says the per-file checks were skipped.

Run `bascik --check --json` for machine-readable results, and `bascik --check --strict` if you want warnings to fail CI.

## Why does `--check` list my third-party web components?

Bascik does not maintain a hardcoded allowlist of third-party custom element names. When you run `bascik --check`, any custom hyphenated tag without a matching file in `src/components/` is listed under "Components with no matching file" as a warning. Bascik passes these tags through to the output HTML unchanged so the browser or custom element library can handle them. Declare the ones you use in [`components.external`](/configuration#componentsexternal) to remove them from the report. If you want `--check` to fail whenever warnings are reported, pass `--strict`.

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
- **Missing Components Directory:** A project without `src/components/` builds as a site with no components; create the directory when you add the first one, and the dev server picks it up without a restart. Any other directory listed in `directory.components` that does not exist is an error naming that path, because it is usually a typo.

## Why do two builds of the same source produce byte-identical output?

Bascik builds are fully deterministic. Component instance IDs (used for scoped `id` and `name` DOM attributes) are derived deterministically from the page path, component name, and ordinal index of each instance on the page. Under the default configuration, class names omit instance IDs entirely and were already deterministic. This design guarantees that identical source input produces byte-identical output across repeated runs, worker threads, and different machines.

## What is `dist/.bascik/`?

`dist/.bascik/` is a build-internal directory that holds artifacts generated for deployment tools and runtime servers. For example, `generate.manifest: true` writes `dist/.bascik/manifest.json`, `generate.cspHashes: true` writes `dist/.bascik/csp-hashes.json`, and static builds with server scripts write `dist/.bascik/server-scripts.json`. Because the directory starts with a dot, Bascik's built-in servers and request guards 404 all requests to `/.bascik/*` to prevent exposing build inventory.

## Why is `siteUrl` an environment variable and not a config option?

Because the site URL changes per deployment, not per project. Staging, production, and preview deploys of the same checked-in source need different values, and putting the URL in `bascik.config.ts` would force CI to mutate a tracked file (or maintain per-branch forks of it) just to build for a different origin.

Bascik follows the standard precedence chain instead: `--site-url` flag, then the `BASCIK_SITE_URL` environment variable, then a `.env` file. Each environment sets its own value and the config file stays untouched. See [Configuration precedence](/configuration#configuration-precedence).

## How do I deploy to `example.com/docs` instead of `example.com`?

Set `base: '/docs/'` in `bascik.config.ts`. Bascik prefixes root-relative HTML and CSS URLs during the build, serves dev and production-server requests below `/docs/`, and includes the prefix in generated sitemap, robots, and canonical URLs. Requests without the prefix return `404`, matching a static subdirectory host. See [Subdirectory deploys](/deployment#subdirectory-deploys).

## How do I use a strict Content Security Policy with Bascik?

List the hash of each inline script in the policy. Enable `generate.cspHashes: true` in `bascik.config.ts` and Bascik writes the SHA-256 hashes of all inlined component scripts and stylesheets to `dist/.bascik/csp-hashes.json`, or hash the built pages yourself in a `post` exec script. See [Content Security Policy](/how-to/content-security-policy) for a worked recipe.

## Does Bascik set a Content Security Policy header?

No. Bascik inlines styles and component scripts for performance and scoping isolation. Setting a CSP header directly in Bascik would require `'unsafe-inline'`, which defeats the purpose of CSP. Instead, Bascik generates SHA-256 hash manifests (`generate.cspHashes: true`) so your host or CDN edge can serve a strict policy.

## Do I need a process supervisor?

Yes, when running `bascik --server` in production, a process supervisor such as systemd, Docker container restart policy, or Kubernetes pod supervisor is expected.

Bascik provides process-level crash safety handlers for unexpected rejections or exceptions. Instead of attempting ungraceful recovery in an indeterminate state, it logs full diagnostic context and exits with a non-zero code (`1`). A supervisor restarts the process cleanly.

## How do I do a zero-downtime deploy?

Configure your orchestrator or reverse proxy to use `GET /_health` as the readiness probe. When a deployment replaces existing containers, sending `SIGTERM` makes Bascik report `503` on `/_health` immediately while draining existing requests within `http.timeouts.drain` (default 5 seconds). Once the load balancer shifts traffic to the new instances, the old process exits cleanly.

## Can a server script slow down other requests?

Yes, if it executes long-running synchronous code or blocks Node's event loop.

Server scripts (`<script data-bascik-server>`) execute in-process within the same Node.js runtime to eliminate fork overhead and process starvation. Because Node runs JavaScript on a single thread, synchronous computations (such as heavy regex matching or CPU loops) block the event loop while they run, delaying concurrent requests. Always use asynchronous APIs with `await`, pass `signal` to `fetch()` or database clients to respect `scripts.timeout`, and offload intensive CPU tasks to worker threads.

## Can Bascik handle form submissions and API requests?

Yes. Define API route handlers in TypeScript or JavaScript under `src/api/` (such as `src/api/contact.ts` or `src/api/users/[id].ts`). Handlers take a standard WHATWG `Request` and return a standard `Response`. You can accept POST JSON, parse form bodies, set custom status codes, and issue cookies directly without external backend dependencies. Run `bascik --server` to serve API routes in production.

## Do I need a separate backend server for my API?

No. If you run Bascik with `bascik --server`, API routes run in-process on the same port and server as your pages and assets. If you prefer static CDN hosting for pages, you can also lift your `src/api/` handlers directly to Cloudflare Workers, Netlify Edge Functions, or AWS Lambda since they use standard web `Request` and `Response` interfaces.

## Why does Bascik not include middleware chains or interceptors?

Bascik favors explicit, standard TypeScript composition over implicit framework middleware. Because handlers take a standard `Request` and return a `Response`, you can compose auth guards, logging, or input validators using plain functions: `export const POST = withAuth(async (req) => ...);`. This keeps handlers transparent, portable, and easily testable without mocking framework internals.

## How big a request body can an API route accept?

By default, Bascik limits API route request bodies to `1048576` bytes (1 MB). You can configure this with `http.maxBodySize` in `bascik.config.ts`. Bascik counts bytes on the fly as they stream from the client and immediately terminates oversized requests with `413 Payload Too Large` without buffering the entire body into memory.
