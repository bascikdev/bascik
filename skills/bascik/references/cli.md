# CLI and Development Workflow Reference

## Start a project

```sh
npm create bascik@latest my-site -y
```

Scaffolds the project, installs dependencies, and starts the dev server at http://localhost:8080. The name is used for the directory and the site title; omit it to be prompted (default `bascik-app`). Drop `-y` to answer the install and dev-server prompts yourself.

The starter includes pages, components with unit tests, Playwright E2E tests, global CSS, `.vscode/extensions.json` (recommends the Bascik extension), a `lint` script powered by `@bascik/language-server`, and these agent skills in `.agents/skills/` and `.claude/skills/`. It has no `bascik.config.ts` because the defaults suffice.

Add Bascik to an existing project:

```sh
npm install @bascik/bascik
npx bascik init
```

`bascik init` scaffolds `src/pages/index.html` and `src/components/`, appends `dist/` and `node_modules/.cache/bascik/` to `.gitignore`, and patches `package.json` (`"type": "module"` when missing, standard scripts, and the dependency). The manual equivalent:

```json
{
  "type": "module",
  "scripts": {
    "dev": "bascik",
    "build": "bascik --build",
    "check": "bascik --check"
  }
}
```

## Commands

```sh
bascik                        # dev: transpile, serve http://localhost:8080, watch, live reload
bascik --build                # production build to dist/
bascik --build --log [path]   # also write build output to a log file (default .bascik/build.log)
bascik --build --only <glob>  # rebuild matching pages only, without cleaning dist/ (repeatable)
bascik --build --target <name># also emit a serverless bundle under dist/.bascik/<name>/
bascik --server               # production server for a built dist/
bascik --check                # static analysis, no output written
bascik add <package>          # copy components from an installed npm package
bascik init                   # add starter files and scripts to an existing project
```

Flags: `--config <path>`, `--port <n>`, `--host <name>`, `--log-level <silent|error|warn|info|debug>`, `--site-url <url>`, `--env-file <path>` (repeatable, later files win), `--force`, `--dry-run`, and `--yes`/`-y` (the last three for `add`). Value flags accept `--flag value` and `--flag=value`.

Precedence: a flag beats its environment variable (`BASCIK_SERVER_PORT`, `BASCIK_SERVER_HOST`, `BASCIK_LOG_LEVEL`, `BASCIK_SITE_URL`), which beats the config file.

The parser rejects `--build` with `--server`, `--only` without `--build`, `--target` with `--only`, unknown flags, and stray words. `bascik build` (no dashes) errors with `Did you mean "--build"?` instead of starting the dev server.

### `--only` gotchas

- Globs are relative to `directory.pages`; several `--only` flags union.
- `dist/` is not cleaned, so other compiled pages survive.
- `sitemap.xml` and `robots.txt` are skipped with a warning so unbuilt pages are not delisted.
- `dist/.bascik/manifest.json` and `dist/.bascik/csp-hashes.json` merge the updated entries.
- Static assets are still copied.

### `bascik add`

Copies components from an installed npm package into the first component root. The files become project files that you commit. `bascik-lock.json` stores file hashes: unmodified files update on re-add, locally modified files need `--force`, and a name collision with an existing component aborts without writing anything. `--dry-run` previews the copy.

## Dev server behavior

```text
Starting transpiling...
transpiled: pages/index.html in 0.6ms
transpiled: pages/about.html in 0.3ms

✓ 2 pages transpiled in 45ms
Server running at http://localhost:8080
```

- Pages are served from memory at their path without `.html` (`dist/blog/post.html` is `/blog/post`, `index.html` is `/`). Unknown paths fall back to `404.html` when it exists.
- If port 8080 is taken, the next free port is used (8081, 8082, ...).
- `dist/` is cleaned on startup; compiled pages are then written to it asynchronously, so `dist/` is always available for inspection.
- Pages transpile sequentially by default; `pipeline.workers: true` uses a worker pool (worth it only for large or CPU-heavy sites).
- Live reload uses Server-Sent Events. Build errors appear in an in-browser overlay and clear on the next successful build. None of this ships to production.
- Changes to `bascik.config.ts` need a restart; Bascik prints a hint.

Watch mode rebuilds incrementally:

- Editing or adding a page rebuilds that page.
- Editing a component rebuilds only the pages that use it. Open pages are rebuilt and reloaded first.
- Static assets in `src/pages/` are copied (`copied: pages/css/custom.css`).
- Deleting a page deletes its output (`deleted file: pages/old-page.html`).
- Files outside pages and components (helpers in `src/lib/`, `content/`) trigger rebuilds only when listed in `pipeline.watchPaths`.

## Failures

Dev logs a failed page, keeps serving healthy pages, and retries on the next save. `bascik --build` waits for every page, reports all failures together, and exits nonzero.

```text
Build failed with 2 page errors:
  src/pages/about.html
    validate markup: Page does not contain a non-empty <body> element
  src/pages/blog/post.html
    write output: EACCES: permission denied
```

Hard failures: a missing or unreadable pages directory or listed component root, a page without a non-empty `<body>`, runaway component expansion, and output write failures. A missing default `src/components/` is fine.

Common messages:

```text
[bascik] Transpilation failed for component <site-nav> during css-scoping in "pages/about.html" at (line 22, column 8)
  Defined in component template: "components/site-nav/site-nav.html"
  Error: ParseError: CSS Selector is invalid or could not be parsed.

[bascik] build script error in "src/pages/index.html" at (line 12, column 5):
ReferenceError: marked is not defined

[bascik] Unresolved component tag in "pages/about.html": <my-mistyped> - no matching component file found. Run `bascik --check` for a full report.
```

## `bascik --check`

Validates pages, components, config, and API routes without starting a server or writing output.

- **Warnings (exit 0):** unmatched hyphenated tags (typos or third-party custom elements), unused component files, unknown `data-bascik-*` attributes, and ordering conventions (`<style>` above markup, `<script>` below).
- **Errors (exit 1):** config validation failures, a missing site URL while sitemap or robots generation is on, duplicate component names, circular component references, combined script directives, duplicate routes, API route files without method handlers, API route collisions, and WHATWG parse errors in `dist/` HTML (only when `parse5` is installed as a dev dependency; otherwise a one-line install hint).
- `--strict` turns warnings into errors. `--json` prints structured findings (including `distHtmlChecked` and `distHtmlSpecHintNeeded`).
- A component that only a build script prints is reported as unused; that is expected.

CI gate:

```sh
bascik --check && bascik --build
```

`bascik --check` does not lint CSS or JavaScript syntax. Pair it with:

| Tool | Catches |
|---|---|
| `npx @bascik/language-server --check` | Scoping patterns Bascik cannot rewrite, unclosed tags, misplaced directives, undeclared props |
| Stylelint | CSS syntax and invalid properties |
| ESLint | JavaScript errors in `<script>` blocks |
| HTMLHint | HTML structure in source files |
| `parse5` (dev dependency) | WHATWG parse errors in compiled `dist/` HTML, through `bascik --check` |

## Editor setup

Install the Bascik VS Code extension (`bascik.bascik-vscode`) for component completions, hovers, go-to-definition, and live scoping diagnostics. Other editors use `@bascik/language-server` over LSP.

Editors validate every `<script>` in an HTML file as one scope and report false "already declared" errors. Bascik wraps each block in its own IIFE, so silence it:

```json
// .vscode/settings.json
{ "html.validate.scripts": false }
```

## Inspecting `dist/`

```text
src/pages/about.html       ->  dist/about.html
src/pages/blog/post.html   ->  dist/blog/post.html
```

Check:

- **Components resolved:** no hyphenated custom tag left over (unless it is a declared external element).
- **Scoped names:** `class="bascik__site-nav__nav"` (or a short hash when `minify.identifiers` is on, the default for `--build`).
- **Styles:** one combined `<style>` in `<head>` with the CSS of every component on the page.
- **Build script output:** the `<script data-bascik-build>` tag is replaced by its returned HTML. If it is missing, look for `[bascik] build script error` in the terminal.
- **Server script output:** replaced only at request time under the dev server or `bascik --server`; static `dist/` keeps an inert `<script type="text/bascik-server">` placeholder.
- **Slots and props:** fallback or injected text in the right place.

The browser's View Source shows the same HTML and is often faster during development. For a readable, unminified view of a single snippet or page, use `scripts/preview.mjs`.
