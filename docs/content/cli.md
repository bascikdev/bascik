# Command Line Interface (CLI)

Bascik features a simple, fast, and highly informative CLI for both development and production building.

## Scaffold a new project

```sh
npm create bascik@latest
# or: npm create bascik@latest my-project
```

Scaffolds a complete starter project in a new directory. Prompts for a project name if not passed as an argument. Creates:

```text
my-project/
  package.json
  bascik.config.ts
  vite.config.js
  .gitignore
  .vscode/
    launch.json
  .github/skills/bascik/SKILL.md
  .claude/skills/bascik/SKILL.md
  e2e/
    playwright.config.ts
    app.spec.ts
  src/
    pages/
      favicon.ico
      assets/
        favicon-32x32.png
        favicon.svg
        apple-touch-icon.png
      css/
        styles.css
      index.html
      about.html
      contact.html
      404.html
    components/
      site-meta/
        site-meta.html
        site-meta.test.ts
      site-header/
        site-header.html
        site-header.test.ts
      site-footer/
        site-footer.html
        site-footer.test.ts
      feat-card/
        feat-card.html
        feat-card.test.ts
      my-counter/
        my-counter.html
        my-counter.test.ts
```

Every scaffolded project includes co-located unit tests for its components, Playwright E2E browser tests in `e2e/`, Vitest configuration in `vite.config.js`, and pre-configured test scripts (`npm test`, `npm run test:watch`, `npm run test:coverage`, and `npm run e2e`).

After scaffolding, the tool prompts you interactively:

```sh
✓ Scaffolded my-project/

Install dependencies now? (Y/n)
Start the dev server after install? (Y/n)
```

Select **Y** for both and you're live at `http://localhost:8080` with no extra commands.

## CLI reference

```sh
bascik           # dev: transpile, start plaintext HTTP dev server, watch
bascik --build   # production: transpile to dist/ only
bascik --server  # production server: serve a pre-built dist/ over HTTP/1.1
                 # (HTTP/2 when http.tls.enabled is set)
bascik --check   # static analysis: validate pages, components, and config without building
```

| Flag | Description |
| --- | --- |
| `--log [path]` | Also write build output to a log file. Only valid with `--build`. Default: `.bascik/build.log` |
| `--only <glob>` | Only transpile pages matching the glob pattern (relative to `directory.pages`). Repeatable. Only valid with `--build` |
| `--port <n>` | Override the server port (overrides `BASCIK_SERVER_PORT` and `http.port`) |
| `--host <name>` | Override the server hostname (overrides `BASCIK_SERVER_HOST` and `http.hostname`) |
| `--log-level <level>` | Override `logging.level`: `silent`, `error`, `warn`, `info`, or `debug` (overrides `BASCIK_LOG_LEVEL`) |
| `--site-url <url>` | Set the site URL for this run (overrides `BASCIK_SITE_URL` and `.env`) |
| `--env-file <path>` | Load env vars from a file (repeatable; later files win) |
| `--config <path>` | Load the config from a specific file instead of `./bascik.config.js` or `./bascik.config.ts` |
| `-h`, `--help` | Show the help text |
| `-v`, `--version` | Show the installed Bascik version |

Every value-taking flag accepts both forms:

```sh
bascik --build --port 4321
bascik --build --port=4321
```

Rules the parser enforces:

- `--build` and `--server` cannot be combined. Run the build first, then serve the output.
- Unknown flags are rejected, as are positional arguments other than `init`. `bascik build` (no dashes) is an error with a `Did you mean "--build"?` suggestion, not a silent dev server.
- A flag that takes a value requires one (`--config` with no path is an error); a flag that takes none rejects one (`--build=yes` is an error).
- Repeating a boolean flag is a no-op. For value flags the last occurrence wins; `--env-file` appends.
- A flag always beats the matching environment variable, which beats the config file. See [Configuration](/configuration#configuration-precedence) for the full precedence chain.

Unrecognized flags that appear before the first Bascik flag are treated as Node.js runtime flags and ignored, so profilers and wrappers (`0x`, `clinic`, `--inspect`) never break the CLI.

## Environment files and the site URL

Bascik loads `./.env` automatically when it exists and skips it silently when it does not. Pass `--env-file <path>` to load additional or alternative files:

```sh
bascik --build --env-file .env.staging
bascik --build --env-file .env.base --env-file .env.staging  # later files win
```

An explicitly passed `--env-file` that does not exist is an error, mirroring Node's own `--env-file` versus `--env-file-if-exists` distinction. A real environment variable always beats a value from any file.

The site URL (used for `sitemap.xml`, `robots.txt`, and `BASCIK_SITE_URL` in build scripts) follows the precedence chain:

```text
--site-url flag  >  BASCIK_SITE_URL env var  >  .env file
```

See [Configuration](/configuration#configuration-precedence) for details.

## Build logs

Use `--log` when you want a captured copy of the build output for debugging or CI investigation. The default path is `.bascik/build.log`, and you can override it with any custom path:

```sh
bascik --build --log
bascik --build --log ./logs/build.log
```

`--log` is only valid together with `--build`; passing it to the dev server or `--server` is an error. The terminal output still stays as the primary log, and the file is an optional diagnostic artifact. If you do not pass `--log`, Bascik does not create a build log file.

## Targeted builds (`--only`)

Use `--only <glob>` to selectively rebuild a subset of pages without compiling the entire site:

```sh
bascik --build --only "blog/**"
bascik --build --only "blog/**" --only "about.html"
bascik --build --only="docs/pages/internals/*"
```

Important rules for targeted builds:
- The glob is matched relative to `directory.pages`.
- Multiple `--only` flags union together.
- `--only` is only valid with `--build`. Passing `--only` without `--build` is an error.
- A glob that matches zero pages produces an error.
- **The output directory is not cleaned:** existing pages in `dist/` are preserved so a targeted build does not destroy the rest of your site.
- **Pages only:** `--only` scopes page transpilation, not static assets. Static assets are still copied and verified.
- **Sitemap and robots:** `sitemap.xml` and `robots.txt` generation is skipped with a warning during targeted builds to prevent delisting pages that were not rebuilt. Run a full `bascik --build` to regenerate whole-site sitemaps.
- **Manifest & CSP hashes:** When `generate.manifest` or `generate.cspHashes` are enabled, newly generated entries merge cleanly into the existing artifact in `dist/.bascik/`.

## Starting the dev server

When you run `bascik`, Bascik transpiles your pages, starts the built-in HTTP server, and begins watching for changes. By default, it runs over unencrypted plaintext HTTP on port `8080` for zero-friction setup.

Typical output:

```terminal
transpiled: pages/getting-started.html in 0.4ms
transpiled: pages/index.html in 0.6ms
transpiled: pages/about.html in 0.3ms

✓ 3 pages transpiled in 45ms
Server running at http://localhost:8080
```

If port `8080` is already in use, Bascik automatically tries the next available port:

```terminal
Port 8080 is in use, trying 8081…
Server running at http://localhost:8081
```

If you explicitly configure the server to run with TLS (`enableTls: true` in `bascik.config.ts`), Bascik will serve over HTTPS (default port `8443`) and generate local TLS certificates if needed via `mkcert` or `openssl` fallback.

## Watching for file changes

While the dev server is active, Bascik incrementally updates your build as files are added, updated, or removed.

- **Modifying or adding pages** rebuilds just that page:
  ```terminal
  transpiled: pages/about.html in 0.3ms
  ```
- **Modifying components** rebuilds only the pages that use that component:
  ```terminal
  transpiled: pages/index.html in 0.5ms
  transpiled: pages/about.html in 0.3ms
  ```
- **Open-page prioritization** rebuilds active browser tabs first:
  When a change impacts multiple pages (such as an inlined stylesheet or shared component), Bascik checks active live-reload connections and compiles currently open pages first so your visible browser window refreshes immediately before background pages are processed.
- **Static assets** are copied into `dist/`:
  ```terminal
  copied: pages/css/custom.css
  ```
- **Deleting pages** removes the compiled output:
  ```terminal
  deleted file: pages/old-page.html
  ```

> **Automatic Reconnection on Tab Focus:** If the dev server is restarted while editing code, returning focus to your browser window immediately attempts an instant reconnect and updates the page automatically with zero manual refreshes required.

## Transpilation and build errors

Development and production builds handle page failures differently. The dev server logs a failed page, finishes booting, and continues serving every page that compiled successfully. Saving a fix retries that page without requiring a server restart.

`bascik --build` treats missing or unreadable configured directories, pages without a non-empty `<body>`, runaway component expansion, and output directory or file write failures as hard errors. It waits for all page jobs, reports every failure together, exits nonzero, and does not print `Build complete`.

```terminal
Build failed with 2 page errors:
  src/pages/about.html
    validate markup: Page does not contain a non-empty <body> element
  src/pages/blog/post.html
    write output: EACCES: permission denied
```

Unresolved component tags remain transpilation warnings. `bascik --check` reports them as errors, making that command the strict CI gate for component references.

Component transpilation failure:

```terminal
[bascik] Transpilation failed for component <site-nav> during css-scoping in "pages/about.html" at (line 22, column 8)
  Defined in component template: "components/site-nav/site-nav.html"
  Error: ParseError: CSS Selector is invalid or could not be parsed.
```

Build script failure:

```terminal
[bascik] build script error in "pages/index.html" at (line 12, column 5):
ReferenceError: marked is not defined
```

Unknown component tag:

```terminal
[bascik] Unresolved component tag in "pages/about.html": <my-mistyped> - no matching component file found. Run `bascik --check` for a full report.
```

## Custom 404 Page

Create a `404.html` file in your pages directory (e.g. `src/pages/404.html`) and the dev server will automatically serve it as a fallback for any non-existent route with a `404` status code.

When you build for production (`bascik --build`), this file is compiled to `dist/404.html`, which is the standard location recognized by most static hosting providers (GitHub Pages, Netlify, Vercel, Cloudflare Pages) to serve custom 404 pages.

## Static analysis with `bascik --check`

Run `bascik --check` from your project root to validate all pages and component files without starting the dev server or writing any output files:

```sh
bascik --check
```

It reports:

- **Errors:** hyphenated tags that have no matching component file
- **Warnings:** component files that exist but are never referenced
- **Success:** exits with code `0` when no errors are found

Example output:

```terminal
[bascik check] ✓ 8 pages and 12 components checked - no errors
```

`bascik --check` exits with code `1` when errors are found, which makes it suitable for CI:

```sh
bascik --check && bascik --build
```

`bascik --check` does **not** validate CSS or JavaScript syntax. Use those tools immediately around it rather than treating them as a separate, later concern:

| Tool | What it catches | How to use |
| --- | --- | --- |
| **VS Code built-in CSS** | CSS syntax errors in `.css` files | Enabled by default |
| **[Stylelint](https://stylelint.io)** | CSS syntax errors, invalid properties, custom conventions | `npm install -D stylelint && npx stylelint "**/*.css"` |
| **[HTMLHint](https://htmlhint.com)** | HTML structure errors in page and component `.html` files | `npm install -D htmlhint && npx htmlhint "src/**/*.html"` |
| **[Webhint](https://webhint.io)** | Web standards, ARIA accessibility, and cross-browser compatibility | `npm install -D hint && npx hint "src/**/*.html"` (with recommended `.hintrc`) |
| **[ESLint](https://eslint.org)** | JavaScript syntax and logic errors in `.js` files | `npm install -D eslint && npx eslint "src/**/*.js"` |

For most teams, the most useful CI command sequence is:

```sh
npx stylelint "src/**/*.css" && bascik --check && bascik --build
```

## Production builds

Run `bascik --build` to write deployment-ready files to `dist/`:

```sh
bascik --build
```

The output uses root-relative asset paths (for example `/css/styles.css`) and must be served by an HTTP server. Opening files directly with `file://` will break stylesheet and script loading.

For guidance on deploying to static hosts or running the production server, see [Deploying](/deploying).

## Production server

`bascik --server` starts the HTTP server pointed at a pre-built output directory. Run `--build` first, then `--server`:

```sh
bascik --build && bascik --server
```

The production server:

- Serves pre-compiled pages from `dist/` without watching for source changes.
- Has no live-reload SSE endpoint.
- Executes `data-bascik-server` script blocks on every request.

### Configuring the server

Use the `http` key in `bascik.config.ts` to customize the server:

```ts
// bascik.config.ts
export default {
  http: {
    port: 8080,
    hostname: '0.0.0.0',   // bind all interfaces (needed in containers)
    tls: {
      enabled: false,      // set to true to run over encrypted HTTP/2 (HTTPS)
    },
  },
};
```

| Option | Default | Description |
| --- | --- | --- |
| `port` | `8080` (HTTP) / `8443` (HTTPS) | TCP port to listen on |
| `hostname` | `"localhost"` | Hostname or IP to bind to |
| `enableTls` | `false` | Enable TLS (HTTPS) and serve over HTTP/2. |
| `keyFile` | auto-generated | Path to a PEM private key when TLS is enabled. |
| `certFile` | auto-generated | Path to a PEM certificate when TLS is enabled. |

When `enableTls` is true and `keyFile` / `certFile` are omitted, Bascik generates certificates automatically using `mkcert` (if installed) or `openssl` as a fallback.

To preview the production build locally with Bascik's built-in production server:

```sh
bascik --server
```

Or with any third-party HTTP server:

```sh
npx http-server dist
```

Then open the URL printed by `http-server` (default: `http://127.0.0.1:8080`).

## Editor setup and output inspection

**VS Code false positives.** Editors validate multiple `<script>` blocks in an HTML file as if they shared one scope. Bascik wraps each component script block in an IIFE at build time, so those editor warnings can be misleading. In VS Code, disable the project-level script validation:

```json
{
  "html.validate.scripts": false
}
```

**Inspect `dist/` directly.** Both the dev server and `bascik --build` write compiled HTML to `dist/` on disk. This is the fastest way to confirm what Bascik emitted:

- custom component tags should be gone
- scoped class names should be present where component CSS applies
- the page `<head>` should contain injected styles
- build-script output should already be inlined

> **MDN reference.** The CLI helps you build and inspect output, but the resulting HTML, CSS, and JavaScript are still standard web platform files. Keep [MDN's documentation](https://developer.mozilla.org/) close by when you need the canonical reference.
