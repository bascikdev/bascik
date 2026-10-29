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

### `<link-card> (components/link-card/link-card.html): data-bascik-attr-href="url" received a URL that can run script (such as javascript:), so href is set to about:invalid.`

A prop bound to a URL attribute (`href`, `src`, `srcset`, `action`, `formaction`, `poster`, SVG animation values, and the like) carried one of the script URLs such as `javascript:`, or a non-image `data:` URL, so the link points nowhere. An image slot such as `<img src>` keeps a `data:image/...` URL. Any `http:` or `https:` URL, another site's included, is kept. The value comes from the usage tag: a page at build time, or a server or stream script at request time, where it is often a visitor's input. Pass a relative or `https:` URL, or check it in the script with `safeUrl(value)` from `@bascik/bascik/html` before returning the tag. See [Put a Prop in an Attribute](/props#put-a-prop-in-an-attribute).

### `<my-card> (components/my-card/my-card.html): Ignoring data-bascik-attr-onclick="action": an event handler's value is code, so a prop is never bound to one.`

The template binds a prop to an `on*` event handler. Bascik never does that, at build time or at request time: escaping cannot stop a value from running as code. The related messages are `Ignoring data-bascik-attr-srcdoc="..."` (an `srcdoc` is a whole document), `Ignoring data-bascik-attr-content="...": a <meta http-equiv> value acts on the page`, `Ignoring data-bascik-attr-attributeName="...": a prop never chooses which attribute an SVG animation sets`, and `Ignoring data-bascik-attr-style="...": the value runs script or imports CSS` (a bound `style` with `expression(`, `@import`, a `javascript:` URL, and the like). Bind a `data-*` attribute instead (`data-bascik-attr-data-action="action"`) and act on it from the component's script, bind `src` to a URL instead of `srcdoc`, or style a bound `data-*` attribute from a scoped class.

### `<my-card> (components/my-card/my-card.html): Ignoring data-bascik-prop-config on a <script>: a prop is never written into script or style text.`

The template puts a prop receiver on a `<script>` or `<style>` element. The element keeps the text the template gives it, and the marker is removed. Bind the value to a `data-*` attribute instead (`data-bascik-attr-data-config="config"`) and read it in the script from the element's `dataset`. The [Copy Button](/example-components/copy-button) example does this with its `text` prop.

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

### `Directive script (data-bascik-build) timed out after 60000ms`

The build script ran for 60 seconds and was stopped. The message follows the script's location:

```terminal
[bascik] build script error in "src/pages/index.html" at (line 3, column 13):
Directive script (data-bascik-build) timed out after 60000ms
```

The limit is fixed at 60 seconds for build and routes scripts (a routes script reports `data-bascik-routes`). `scripts.timeout` does not change it: that setting bounds server and stream scripts at request time. The failure follows `scripts.onBuildScriptError`, like a script that throws. Move slow work such as a remote fetch into a `pipeline.exec` step, which has its own `timeout`, and have it write a file the script reads. See [Exec Scripts](/exec-scripts).

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

### My script returned at the deadline but the page still failed with a timeout

Once `scripts.timeout` passes, the result is a timeout even if the script settles afterwards. A script that answers the `abort` event by returning a value, even synchronously inside the listener, is still a timeout, handled by `scripts.onServerScriptError`: under `'error'` a server script gives a 500 and a stream script, whose response has already started, an empty slot with a logged error (see [Error Policy](/stream-scripts#error-policy)); `'warn'` and `'ignore'` give an empty section. API routes follow the same rule with `http.apiTimeout` and a `504`. Return before the deadline, or raise the limit if the work genuinely needs it. Use the `signal` to stop work, not to produce a last-moment result. See [Timeouts and Cancellation](/server-scripts#timeouts-and-cancellation-abortsignal).

### `Server script placeholder "..." could not be resolved from sidecar`

`dist/` was produced by a different build than `dist/.bascik/server-scripts.json`, usually a targeted `--only` build on top of an older full build, a hand-edited `dist/`, or a `dist/` built by an older Bascik version. The related messages are `is marked stream in the HTML but server in the sidecar (stale sidecar)`, `uses schema N, expected M`, and `production startup validation failed`. Run a full `bascik --build` with the installed version and start the server again.

### `--server: dist/.bascik/server-scripts.json has server-script entries but dist/.bascik/components.json is missing`

Same family: a build that has server or stream scripts also writes a component manifest, used to render component tags those scripts return, and this `dist/` predates it or lost it. The related messages are `component manifest at ... uses schema N, but this runtime understands schema 1`, `component manifest at ... is malformed`, for `--target` builds, `the sidecar has server-script entries but dist/.bascik/components.json is missing`, and, at request time, `component script "<id>" is not listed in dist/.bascik/components.json` Each means `dist/` was not written by one full build of the installed version. Run `bascik --build` again. See [What is `dist/.bascik/`?](/faq#what-is-distbascik).

### A component tag in script output reaches the browser as written

A server or stream script returned `<product-card>`, and the HTML the browser receives still contains the tag, so its content shows as unstyled text. In the dev server the terminal names the cause once per route and tag, as long as at least one of the site's components can be rendered at request time:

```terminal
[bascik] Unresolved component tag <prodcut-card> in server-script output at "/search": no matching component file found, so it reaches the client as written.
```

```terminal
[bascik] Component tag <bad-card> in server-script output at "/search" is left unexpanded: components/bad-card/bad-card.html:2 cannot be rendered at request time (attr-binding-to-scoped-attribute: its data-bascik-attr-class binding targets an attribute scoping rewrites).
```

Here `src/components/bad-card/bad-card.html` binds a prop onto `class` on line 2, below its style:

<!-- prettier-ignore -->
```html
<style>.w { color: red; }</style>
<div class="w"><span data-bascik-attr-class="variant">x</span></div>
```

The first is a typo or a missing component file: fix the tag name, or list a third-party element in [`components.external`](/configuration#componentsexternal) to silence it. The second is a component that cannot be rendered at request time; the next entry lists the reasons. A third message, `is left unexpanded: the scoped names computed for instance ... collide with each other`, means the instance's generated ids or names clashed; it is rare, and renaming the colliding ids in the component clears it. The production server and the Cloudflare Worker log none of these. A misspelled tag shows only in the dev server log: `bascik --check` reads the build's component manifest, so it lists unsupported components but never sees the tags a script returns at request time. A site whose components are all unsupported, or that has none, gets no dev log either; use `bascik --check` for the unsupported ones. Also make sure the tag is markup: an escaped tag (`&lt;product-card&gt;`) or one inside a comment, `<script>`, `<style>`, `<textarea>`, or attribute value is text by design. A custom deployment adapter that does not declare `components: true` serves every tag as written and says so at build time. See [Returning component tags](/server-scripts#returning-component-tags).

The demo below is the safe fallback in action. The help page's server script returns a misspelled `<prodcut-card>` and a code sample that shows a `<product-card>` tag. The sample tag is escaped (`&lt;product-card ...&gt;`), so it is text; a raw `<product-card>` inside `<pre>` would be markup and would render. The Output is the body `bascik --server` sent for `GET /help`, byte for byte: both tags arrive as written, with no `<style>` and no request-time ids, in the same site where the [search page](/server-scripts#render-a-card-per-search-result) renders `<product-card>`.

<!-- demo:rtc-passthrough-source-usage -->

```html
<!-- src/pages/help.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Help</title>
  </head>
  <body>
    <div class="help">
      <script data-bascik-server>
        export default function () {
          return `<p>A misspelled tag, then a tag shown as code:</p>
    <prodcut-card data-bascik-prop-name="Milk frother"></prodcut-card>
    <pre><code>&lt;product-card data-bascik-prop-name="Milk frother"&gt;&lt;/product-card&gt;</code></pre>`;
        }
      </script>
    </div>
  </body>
</html>
```

<!-- demo:rtc-passthrough-output-html -->

<!-- prettier-ignore -->
```html
<!-- src/pages/help.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Help</title>
  </head>
  <body>
    <div class="help">
      <p>A misspelled tag, then a tag shown as code:</p>
    <prodcut-card data-bascik-prop-name="Milk frother"></prodcut-card>
    <pre><code>&lt;product-card data-bascik-prop-name="Milk frother"&gt;&lt;/product-card&gt;</code></pre>
    </div>
  </body>
</html>
```

### `Components a server or stream script cannot return`

This `bascik --check` section lists the components a server or stream script cannot return, read from the last build's `dist/.bascik/components.json`, each with its reason, what triggered it, and the file and line:

```terminal
Components a server or stream script cannot return (1)
  ...
  <bad-card> is left unexpanded when a server or stream script returns it: attr-binding-to-scoped-attribute: its data-bascik-attr-class binding targets an attribute scoping rewrites (components/bad-card/bad-card.html:2)
```

A page that uses the component in its own markup still renders it at build time; only script output is affected. Run `bascik --build` first, because the section reads the build's output. The reasons and the usual fix:

- `attr-binding-to-scoped-attribute`: a `data-bascik-attr-*` binding onto `id`, `name`, `class`, `style`, an SVG reference attribute, or an id reference on an element the build does not rewrite. Bind a `data-*` attribute and style it from a scoped class instead.
- `instance-scoped-server-script`: the component's server or stream script names one of its scoped ids or field names, or the component has such a script and its classes are scoped per instance because of `url(#id)` or `scoping.deduplicateCss: false`. Refer to classes in the script, and move the id-dependent markup into the template. A `url(#id)` component with no server or stream script is not affected.
- `build-script-reads-page-context`: a `data-bascik-build` script in the component reads `BASCIK_PAGE_PATH`, `BASCIK_PAGE_FILE`, or `BASCIK_ROUTE`. Use `data-bascik-build-once`, or pass the value in as a prop.
- `attr-src-on-directive-script`: a directive script's `src` is bound with `data-bascik-attr-src`. Give it a fixed `src`.
- `scoping-template-unavailable`: the component's scoping or build-script output cannot be recorded as a template; the detail after the reason says why (an `@import`, a split name, printed prop or slot markup). Move that part into the template or a global stylesheet.

The table in [Request-Time Component Rendering](/compatibility#request-time-component-rendering) has the full trigger for each reason. A neighboring section, `Components without stable CSP hashes at request time`, appears only with `generate.cspHashes: true` and lists components whose request-time CSS or scripts a hash-only policy cannot cover; see [Content Security Policy](/how-to/content-security-policy#server-and-stream-scripts).

### `server-script output at "/search" expands to more than 1000 component instances (...); the limit is 1000 instances per script output.`

A request-time render budget was exceeded. The related messages are `rendered to N characters, over the 4 MiB (4194304 characters) limit per script output`, `grew past N characters while expanding components ..., over the 4 MiB (4194304 characters) limit per script output` (the usual one for a large overrun), `is N characters before rendering, over twice the 4 MiB (4194304 characters) limit per script output, and has component tags in it, so it is refused before they are expanded`, `would run more than 64 nested component scripts in one response`, and `nests component scripts deeper than 4 levels`. Each names the route, and all but the refused-before-rendering one name the component file (`RequestRenderError`). The log is the usual `[bascik] server script error at "/search":` line followed by the message. The failure follows `scripts.onServerScriptError` like a script that throws: under `'error'` (the default) a server script's response is a 500 and a stream script's slot is empty with the error logged, `'warn'` logs it and leaves the slot empty, and `'ignore'` leaves the slot empty without a log. Return fewer results per request (paginate with `?page=`), or render a long list with fewer components per item. Each message ends by naming the [`scripts.renderLimits`](/configuration#scriptsrenderlimits) key to raise if the output is expected. A component whose script returns itself, directly or through another component, hits the depth limit. See the budgets in [Returning component tags](/server-scripts#returning-component-tags).

### `server-script output at "/search" made the renderer rescan more than N characters while expanding components (...)`

The full message ends `over the limit of 16 times the output's N characters plus 33554432. Component tags in it are cut off mid-tag, left unclosed, or nested many levels deep around long content, which usually means text reached the output unescaped.` Component tags in the output were nested hundreds of levels deep around long text, or left unclosed ahead of a closing tag of the same name (`<my-card>` repeated, with one `</my-card>` at the end), so each nested tag made the renderer read the whole output, or everything inside it, again. This is the shape a visitor's unescaped `<` produces, and the budget stops it before it costs seconds per request. It is a `RequestRenderError` and follows `scripts.onServerScriptError` like the budgets above. Escape every value you put into the output (see [Escaping and injection](/server-scripts#escaping-and-injection)) and close every component tag you return. Pages that write their tags whole never come near the limit. See [Security](/server-scripts#security).

### `Rendering <echo-card> (components/echo-card/echo-card.html) from server-script output at "/echo" failed during slot resolution: Invalid string length`

Rendering one instance of a component the script returned threw. The full log line from `bascik --server` and the Cloudflare Worker:

```terminal
[bascik] server script error at "/echo":
Rendering <echo-card> (components/echo-card/echo-card.html) from server-script output at "/echo" failed during slot resolution: Invalid string length
```

The file is `src/components/echo-card/echo-card.html`, named the way `bascik --check` and the build's own diagnostics name it: relative to its component root. The build records that form in `dist/.bascik/components.json`, so `bascik`, `bascik --server`, and the Cloudflare Worker print the same path in this message, in the budget messages above, and in the dev log entries for returned tags.

The stage is one of `prop injection`, `slot resolution`, `attribute scoping`, `attribute inheritance`, or `substitution`, and the text after the colon is the underlying error. Each stage is string work on the component's template and the values on the tag, so the error you can cause is the JavaScript engine's string limit: `Invalid string length` means the instance would be longer than a string can be (about 536 million characters in V8, which Node and Cloudflare Workers both use). Here `echo-card.html` has 80 default slot markers, and the script passed 8 MB of slot content, so the copies outgrow the limit while the instance is built, before the output budgets measure the result. Pass less content to a component that repeats a slot or prop, or repeat it fewer times. Any other error text is a Bascik bug: report it with the tag the script returned.

To reproduce, put the same tag in a page's own markup and run `bascik --build`. The build reports the same stage, followed by the engine's stack trace (shortened here), leaves that instance out of the page and finishes:

```terminal
[bascik] Transpilation failed for component <echo-card> during slot resolution in "pages/echo.html" at (line 1, column 60)
  Defined in component template: "components/echo-card/echo-card.html"
  Error: RangeError: Invalid string length
    at Array.join (<anonymous>)
    at replaceDefaultSlots (file:///.../node_modules/@bascik/bascik/dist/lib/component-slots.js:290:18)
    ...
```

Slot resolution, attribute inheritance, and substitution run the same code in both places. Prop injection does not: the build applies `data-bascik-attr-*` props before scoping and the request renderer after it, so a `prop injection` failure can appear at request time only. Like the budgets above, the failure follows `scripts.onServerScriptError`. See [Returning component tags](/server-scripts#returning-component-tags).

### One slow server script delays every request

Synchronous work in a handler blocks Node's event loop. Use asynchronous APIs, await them, and offload CPU-heavy work. See [Can a server script slow down other requests?](/faq#can-a-server-script-slow-down-other-requests).

## Server script safety

These messages come from `html` and the other helpers in `@bascik/bascik/html`, and from the linter. An `html` error is thrown inside your call, so it reaches the page like any other script error: a 500 under `scripts.onServerScriptError: 'error'` (an empty slot for a stream script), with the message and your file and line in the log. In development the browser shows only a plain `500 Internal Server Error` page; the message is in the terminal that runs `bascik`. Each message starts with `html: hole N in html` and the template's static text with every hole shown as `${…}`; the hole number counts the template's `${...}` from 1. See [HTML Helpers](/html-helpers#errors) and [Security](/security).

### ``html: hole 2 in html`<a class=${…}>` is an unquoted attribute value (class).``

The value would end at the first space and could start a new attribute. Quote it: `class="${value}"`.

### ``html: hole 1 in html`<button onclick="${…}">` is inside the onclick attribute. An event handler's value is JavaScript, which escaping cannot make safe.``

Put the value in a `data-*` attribute (`data-id="${id}"`) and read it from the component's client script.

### ``html: hole 1 in html`<div style="${…}">` is inside a style attribute.``

CSS can load URLs and change the page, and escaping does not make it safe. Choose between fixed classes in code (`class="${dark ? "dark" : "light"}"`), or put the value in a `data-*` attribute and style it with an attribute selector.

### ``html: hole 1 in html`<script>${…}</script>` is inside a <script> element.``

Escaping HTML does not make JavaScript safe. Put the value in a `data-*` attribute, or return `<script type="application/json">${json(value)}<\/script>` and parse it in the client script.

### ``html: hole 1 in html`<style>${…}</style>` is inside a <style> element.``

Escaping HTML does not make CSS safe. Choose between fixed classes in code.

### ``html: hole 1 in html`<${…}>` is a tag name.``

A value never chooses which element to write. Choose between fixed `html` fragments in code, as in [Dynamic components with html fragments](/security#dynamic-components-with-html-fragments).

### ``html: hole 1 in html`<input ${…}>` is where an attribute name goes, inside <input>.``

A value never chooses which attributes an element has. Write each attribute in the template with a quoted value, or choose between fixed `html` fragments in code. Boolean attributes such as `selected`, `checked` and `disabled` are the usual case: write the tag twice in a small helper and pick one in code, as shown in [Boolean attributes](/html-helpers#boolean-attributes). Do not write `checked="${isChecked}"`: a `false` value renders `checked=""`, which is still checked.

### ``html: hole 1 in html`<!-- ${…} -->` is inside an HTML comment (or a <!...> declaration).``

A value in a comment could close it. Move the value out of the comment, or drop the comment. The same message covers `<!DOCTYPE>`, `<?...>` and CDATA sections.

### ``html: hole 1 in html`<iframe srcdoc="${…}">` is inside srcdoc, an HTML document that runs with the page's origin.``

Set `src` to a URL instead, or render the content in the page.

### ``html: hole 1 in html`<meta http-equiv="refresh" content="${…}">` is a <meta http-equiv> value, which acts on the page (a redirect, a policy).``

A `<meta http-equiv>` redirects or sets a policy. Write its value in the template; send a redirect from an [API route](/api-routes) instead.

### ``html: hole 1 in html`<set attributeName="${…}">` chooses which attribute an SVG animation sets.``

Write `attributeName` (and `attributeType`) in the template. An animation that sets an `on*` attribute is refused as an event handler.

### ``html: hole 1 in html`<a href="java${…}">` continues the URL's scheme from the template text "java", so the value could complete javascript:.``

Start the attribute with the value (`href="${url}"`), which `html` checks, or write the scheme and the first `/` in the template (`href="https://example.com/${path}"`).

### ``html: hole 1 in html`<a href="${…}:8080">` is followed by the template text ":8080" before the URL's first /, ? or #, so together they could form a scheme such as javascript:.``

The value starts the URL, and the text after it could finish a scheme (`javascript` plus `:8080`). Build the whole URL in code, check it with `safeUrl`, and use one hole: `` const url = safeUrl(`https://${host}:8080/`); html`<a href="${url}">` ``. Text after the hole that starts with `/`, `?` or `#` is fine (`href="${base}/about"`).

### ``html: hole 1 in html`<a href="${…}${…}">` is followed directly by another hole in the href URL, so together the values could form a scheme such as javascript:.``

Two holes side by side at the start of a URL could form a scheme between them (`java` and `script:alert(1)`). Join the parts in code, check the result with `safeUrl`, and use one hole.

### ``html: hole 1 in html`<a href="javascript:${…}">` is inside a javascript: URL, which runs as script.``

Use a real URL and handle the click in a component script.

### ``html: hole 1 in html`<script><!--</script><p>${…}</p>` follows a <script> whose text contains <!--, which changes where the browser ends the script, so html cannot tell where hole 1 lands.``

A `<!--` inside a script can make the browser end the script later than `</script>`, so `html` cannot tell where a later hole lands. Remove `<!--` from the script (write `"<" + "!--"` if a string needs it).

### ``html: the template html`<script><!--</script>` has a <script> whose text contains <!--, which changes where the browser ends it, so the fragment cannot be nested safely.``

The same problem with no hole after the script: the fragment could leave the page inside the script once it is nested in another template, so the whole template is refused (hole 0). Remove `<!--` from the script.

### ``html: the template html`<a href="${…}` ends inside the href attribute of <a> (the quote is not closed).``

An `html` fragment must end outside any tag, comment, `<script>`, `<style>`, `<textarea>`, `<title>`, `<svg>` or `<math>`, so it can be nested safely. Close the quote, the tag or the element in the same template. An ordinary unclosed element such as `<div>` is fine. The message names where the template ends, for example `ends inside <svg> (the </svg> end tag is missing)`: inside `<svg>` and `<math>` the browser parses the rest of the page differently, so close them in the template that opens them.

### ``html: hole 2 in html`<p>${…}</p>` received a Promise. Await the value before putting it in the template.``

An `async` helper or a `fetch` result went into the template unawaited. `await` it first.

### ``html: hole 3 in html`<a title="${…}">` (the title attribute) received an html`...` or raw() value. An attribute holds text; pass a string, which html escapes.``

Pass the string itself, not an `html` fragment.

### ``html: hole 1 in html`<div class="${…}">` (the class attribute) received an array. An attribute holds one text value.``

Join it in code: `class="${classes.join(" ")}"`.

### ``html: hole 1 in html`<title>${…}</title>` received an html`...` or raw() value, but <title> holds text only.``

`<title>` and `<textarea>` show their content as text. Pass a string.

### ``html: hole 1 in html`<script type="application/json">${…}</script>` received a string. Only json(value) can fill this script, so the data cannot end it early.``

Pass the data through `json(data)` instead of `JSON.stringify(data)`.

### ``html: hole 1 in html`<svg>${…}</svg>` received an html`...` value with a <script> or <style> whose text contains <, inside <svg> or <math>.``

Inside `<svg>` and `<math>`, the browser reads the text of a `<script>` or `<style>` as markup, so a `<` in it can start a tag and move where the element ends. The fragment was checked as HTML, where that text is plain. Move the fragment out of the `<svg>` or `<math>`, or remove `<` from its script or style (`a < b` can be written `b > a`).

### ``html: hole 1 in html`<noscript>${…}</noscript>` received an html`...` or raw() value that contains </noscript, which ends the <noscript> early.``

`<noscript>`, `<xmp>`, `<iframe>`, `<noembed>` and `<noframes>` end at the first `</noscript` (or their own end tag), even inside what looks like a quoted attribute. The nested value contains that end tag, so the browser would close the element there and read the rest of the value as markup, where its holes were checked as attribute text and not as links or event handlers. Remove the end tag from the value (often a `title` or `alt` that quotes markup), or put the value outside the element.

### ``html: hole 1 in html`<p>${…}</p>` received an object that cannot be converted to text (its toString or valueOf is missing, or threw a TypeError).``

The value is an object where a string was expected. Visitor data does this: a JSON body such as `{"name": {"toString": "x"}}`, or a query-string parser that turns `?name[toString]=x` into an object or returns null-prototype objects. Check the field's type in code (`typeof body.name === "string"`) and pass a string. The original `TypeError` is the error's `cause`.

### ``html: hole 1 in html`<ul>${…}</ul>` received an array nested more than 1000 levels deep, or an array that contains itself.``

An array in a text hole is flattened level by level, up to 1000 levels. Deeper data, often a JSON body built to be deep, or an array that contains itself, is refused instead of overflowing the stack. Flatten or validate the data in code first.

### ``html is a tagged template: write html`<p>${value}</p>`, not html(...). To insert trusted markup, use raw(value).``

`html` was called with parentheses. Write it as a tag, or use `raw()` for a string of trusted HTML.

### ``raw() takes a string of trusted HTML, not a template. Use html`...` for templates.``

`raw` was used as a tag. Use `html` for templates.

### ``raw() takes one string of trusted HTML; received an array. Map each item to html`...` or raw(item).``

Wrap the array in `html` instead: `` html`${items.map((item) => raw(item.body))}` ``.

### `raw() received a Promise. Await the value first.`

Await the sanitized HTML before calling `raw`.

### `esc() received an object that cannot be converted to text (its toString or valueOf is missing, or threw a TypeError). Check that the value is a string before you use it.`

The same problem as `unconvertible-value` above, in `esc()`: check that the value is a string first.

### `safeUrl: origins[1] "cdn.example.com" is not an origin. Write it as https://cdn.example.com.`

Each `origins` entry is a scheme, a host and an optional port, with no path. The message suggests the fix.

### `server-script-unescaped-markup`: This markup template interpolates a value without html

The linter found a template literal with tags in a server or stream script, and a value in it that is not a literal, a number, a nested `html` value, or a call to `html`, `raw`, `esc`, `safeUrl` or `json`. Wrap the template in `html` (the editor's quick fix does it), or list your own escaper in `diagnostics.escapeFunctions`. See the [Linter](/tools/linter#server-script-unescaped-markup).

When the value is a call to a hand-written escaper (`${escape(q)}`), the message says so and the editor offers no quick fix, because `html` would escape the escaper's output again. Wrap the template in `html` and pass the value as it is (`${q}`), then delete the escaper.

### `html-escaped-twice`: esc() inside html`...` escapes twice

`html` already escapes each value, so `esc()` inside it shows `&amp;lt;` on the page. Pass the value as it is.

### `html-joined-string`: This hole joins its items into one string, which html escapes

A hole inside `html` is a `.join(...)` call, or a name bound to one. Joining `html` values makes one plain string, and `html` escapes a plain string, so the tags show as text. Pass the array without `.join("")`; `html` inserts each item as it is.

### My page shows &lt;li&gt; as text

The markup was escaped twice. Either a string that already holds markup (a `.join("")` of fragments, or `` html`a` + html`b` ``, which also makes a plain string) went into an `html` hole, or a hand-escaped value (`esc(q)`, a project `escape(q)`) did. Keep `html` at every level and pass arrays and values as they are:

```js
const cards = rows.map((p) => html`<li>${p.name}</li>`); // no .join("")
return html`<ul>
  ${cards}
</ul>`;
```

The linter reports both shapes: `html-joined-string` for the join and `html-escaped-twice` for `esc()`.

### My page shows [object Promise] or commas between cards

`[object Promise]` means an `async` value reached a plain template literal unawaited; await it (inside `html` it is an error instead). Commas between cards mean the script returned an array of `html` fragments directly, which becomes a string with `String(array)`. Return `` html`${cards}` `` instead.

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
