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
bascik          # dev: transpile, start plaintext HTTP dev server, watch
bascik --build  # production: transpile to dist/ only
bascik --serve  # production server: serve a pre-built dist/ with HTTP
bascik --check  # static analysis: validate pages and components without building
bascik --build --log [path]  # optional build log; defaults to .bascik/build.log
```

## Build logs

Use `--log` when you want a captured copy of the build output for debugging or CI investigation. The default path is `.bascik/build.log`, and you can override it with any custom path:

```sh
bascik --build --log
bascik --build --log ./logs/build.log
```

The terminal output still stays as the primary log, and the file is an optional diagnostic artifact. If you do not pass `--log`, Bascik does not create a build log file.

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

If you introduce a syntax mistake or a build-script error, Bascik logs the file and location without crashing the dev server.

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

`bascik --serve` starts the same HTTP server used for development, but pointed at a pre-built `dist/` directory. Run `--build` first, then `--serve`:

```sh
bascik --build && bascik --serve
```

The production server:

- Serves pre-compiled pages from `dist/` without watching for source changes.
- Has no live-reload SSE endpoint.
- Executes `data-bascik-server` script blocks on every request, just like the dev server.

### Configuring the server

Use the `prodServer` key in `bascik.config.ts` to customize the server for both dev and production:

```ts
// bascik.config.ts
export default {
  prodServer: {
    port: 8080,
    hostname: '0.0.0.0',   // bind all interfaces (needed in containers)
    enableTls: false,      // set to true to run over encrypted HTTP/2 (HTTPS)
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
bascik --serve
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
