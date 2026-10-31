# Command Line Interface (CLI)

Bascik features a simple, fast, and highly informative CLI for both development and production building.

## Scaffold a new project

```sh
npm create bascik@rc
# or: npm create bascik@rc my-project
# or: npm create bascik@rc my-project -- --template cloudflare
```

Scaffolds a complete starter project in a new directory. Prompts for a project name if not passed as an argument. `--template cloudflare` adds the [Cloudflare adapter](/deployment/cloudflare), Wrangler, and an edge demo page to the same starter; it goes after `--` because npm keeps flags placed before it for itself. Creates:

```text
my-project/
  package.json
  vite.config.js
  .gitignore
  .vscode/
    launch.json
    extensions.json
    settings.json
  AGENTS.md              project brief for coding assistants
  CLAUDE.md              imports AGENTS.md for Claude Code
  .agents/skills/        Bascik agent skills, when you answer Y to the skills question
  .claude/skills/        the same skills for Claude Code
  skills-lock.json       where the skills came from
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
      contact-form/
        contact-form.html
        contact-form.test.ts
```

Every scaffolded project includes co-located unit tests for its components, Playwright E2E browser tests in `e2e/`, Vitest configuration in `vite.config.js`, and pre-configured test scripts (`npm test`, `npm run test:watch`, `npm run test:coverage`, and `npm run e2e`).

After scaffolding, the tool prompts you interactively:

```sh
✓ Scaffolded my-project/

Install the Bascik agent skills for coding assistants (Claude Code, Copilot, Cursor, Codex...)? (Y/n)
Install dependencies now? (Y/n)
Start the dev server after install? (Y/n)
```

Select **Y** for all three and you're live at `http://localhost:8080` with no extra commands. The first installs the [agent skills](/agent-skills#new-projects) with the skills CLI; when that fails, such as offline, the project is still created and the command to run later is printed.

| Flag                | Description                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `-y`, `--yes`       | Answer every question with its default: the default template, and yes to the skills, the install and the dev server |
| `--no-skills`       | Do not install the agent skills                                                                                     |
| `--no-install`      | Do not run `npm install`                                                                                            |
| `--no-dev`          | Do not start the dev server                                                                                         |
| `--template <name>` | `default` (alias `static`) or `cloudflare`                                                                          |

A `--no-*` flag wins over `-y` and skips its question. An unknown flag, such as `--no-skill`, is refused with the flag it most likely meant. Without a terminal, such as in CI, answers piped to the command are used in order, and every question after the input ends takes its default.

## Set up an existing project with `bascik init`

```sh
bascik init
bascik init -y           # install the agent skills without asking
bascik init --no-skills  # skip the agent skills
```

`bascik init` creates `src/pages/index.html` and `src/components/`, adds `dist/` to `.gitignore`, adds the `dev` and `build` scripts to `package.json`, sets up VS Code, writes the `AGENTS.md` and `CLAUDE.md` [project brief](/agent-skills#project-brief), and asks whether to install the [agent skills](/agent-skills#new-projects) at the installed Bascik version. It adds to files you already have and never replaces them.

## CLI reference

```sh
bascik           # dev: transpile, start plaintext HTTP dev server, watch
bascik --build   # production: transpile to dist/ only
bascik --server  # production server: serve a pre-built dist/ over HTTP/1.1
                 # (HTTP/2 when http.tls.enabled is set)
bascik --check   # static analysis: validate pages, components, and config without building
bascik add <pkg> # copy components from an installed npm package into src/components/
```

| Flag                  | Description                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--log [path]`        | Also write build output to a log file. Only valid with `--build`. Default: `.bascik/build.log`                                                                                                                                                                                   |
| `--only <glob>`       | Only transpile pages matching the glob pattern (relative to `directory.pages`). Repeatable. Only valid with `--build`                                                                                                                                                            |
| `--target <name>`     | Also emit a serverless deployment bundle under `dist/.bascik/<name>/`. Accepts an official name (`cloudflare`, `cloudflare-workers`, `cloudflare-pages`), an adapter package (`@acme/adapter-foo`), or a local path. Only valid with `--build`; cannot be combined with `--only` |
| `--fix`               | Apply deterministic fixes during `--check` (for example, a missing `data-bascik-prop-` prefix), then report the findings that remain                                                                                                                                             |
| `--strict`            | Treat warnings as errors during `--check` (exits with code 1 if warnings are found)                                                                                                                                                                                              |
| `--json`              | Emit findings as a structured JSON document during `--check`                                                                                                                                                                                                                     |
| `--force`             | Overwrite locally modified components during `bascik add`                                                                                                                                                                                                                        |
| `--yes`, `-y`         | Skip interactive confirmation during `bascik add`, and install the agent skills without asking during `bascik init`                                                                                                                                                              |
| `--no-skills`         | Do not ask about or install the agent skills during `bascik init`                                                                                                                                                                                                                |
| `--dry-run`           | List what `bascik add` would do without writing files to disk                                                                                                                                                                                                                    |
| `--port <n>`          | Override the server port (overrides `BASCIK_SERVER_PORT` and `http.port`)                                                                                                                                                                                                        |
| `--host <name>`       | Override the server hostname (overrides `BASCIK_SERVER_HOST` and `http.hostname`)                                                                                                                                                                                                |
| `--log-level <level>` | Override `logging.level`: `silent`, `error`, `warn`, `info`, or `debug` (overrides `BASCIK_LOG_LEVEL`)                                                                                                                                                                           |
| `--quiet`, `-q`       | The same as `--log-level warn`: hide the per-page, copy, request, and script progress lines. The server address and the transpile summary still print. Cannot be combined with `--log-level`                                                                                     |
| `--no-pin`            | Do not pin the server address to the top row of the terminal. Only valid for the dev server. The same as `BASCIK_PIN_SERVER_URL=0`                                                                                                                                               |
| `--site-url <url>`    | Set the site URL for this run (overrides `BASCIK_SITE_URL` and `.env`)                                                                                                                                                                                                           |
| `--env-file <path>`   | Load env vars from a file (repeatable; later files win)                                                                                                                                                                                                                          |
| `--config <path>`     | Load the config from a specific file instead of `./bascik.config.js`, `.mjs`, or `.ts`                                                                                                                                                                                           |
| `-h`, `--help`        | Show the help text                                                                                                                                                                                                                                                               |
| `-v`, `--version`     | Show the installed Bascik version                                                                                                                                                                                                                                                |

Every value-taking flag accepts both forms:

```sh
bascik --build --port 4321
bascik --build --port=4321
```

Rules the parser enforces:

- `--build` and `--server` cannot be combined. Run the build first, then serve the output.
- Unknown flags are rejected, as are positional arguments other than `init` and `add`. `bascik build` (no dashes) is an error with a `Did you mean "--build"?` suggestion, not a silent dev server. Position does not matter: `bascik --quite --check` is refused with `Did you mean "--quiet"?` too.
- A Node option written before the first Bascik flag, such as `bascik --max-old-space-size=4096 --build`, does nothing, because Node reads its own options before the script name. Bascik runs the command and prints a warning that names the option and says to pass it with `NODE_OPTIONS="--max-old-space-size=4096" bascik --build`.
- `--host` takes a hostname like `localhost` or `0.0.0.0`, by the same rule as `http.hostname`; a URL such as `http://0.0.0.0` is an error.
- A flag that takes a value requires one (`--config` with no path is an error); a flag that takes none rejects one (`--build=yes` is an error).
- Repeating a boolean flag is a no-op. For value flags the last occurrence wins; `--env-file` appends.
- A flag always beats the matching environment variable, which beats the config file. See [Configuration](/configuration#configuration-precedence) for the full precedence chain.

Unrecognized flags that appear before the first Bascik flag are treated as Node.js runtime flags and ignored, so profilers and wrappers (`0x`, `clinic`, `--inspect`) never break the CLI.

## Adding components with `bascik add`

`bascik add` copies components from an installed npm package directly into `src/components/`:

```sh
# Copy all components from a package
bascik add @acme/ui

# Copy a single component
bascik add @acme/ui/card

# Preview what would be copied without writing files
bascik add @acme/ui --dry-run

# Overwrite locally modified components
bascik add @acme/ui --force
```

### The `bascik-lock.json` lockfile

`bascik add` maintains a `bascik-lock.json` file in your project root. Unlike build artifacts in `.bascik/dist/`, `bascik-lock.json` is committed project state that tracks:

- Installed component packages and versions
- The list of copied files
- Per-file SHA-256 content hashes

When re-running `bascik add`:

- Unmodified files are updated cleanly to newer package versions.
- If a copied file was customized locally, `bascik add` detects the content hash mismatch and refuses to overwrite it without `--force`.

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

`--log` is only valid together with `--build`; passing it to the dev server or `--server` is an error. The terminal output still stays as the primary log, and the file is an optional diagnostic artifact. If you do not pass `--log`, Bascik does not create a build log file. The log file never contains color codes.

### Terminal colors

Build and dev output is colored when the terminal supports it: green for finished work, yellow for warnings, red for errors, and dim for labels and timings. Piped output and CI logs without a terminal stay plain. Set `NO_COLOR=1` to turn color off, or `FORCE_COLOR=1` to keep it when output is piped.

## Targeted builds (`--only`)

Use `--only <glob>` to selectively rebuild a subset of pages without compiling the entire site:

```sh
bascik --build --only "blog/**"
bascik --build --only "blog/**" --only "about.html"
bascik --build --only="internals/*"
```

Important rules for targeted builds:

- The glob is matched relative to `directory.pages`: `internals/*` builds `src/pages/internals/*.html`. A glob that starts with the pages folder itself (`src/pages/internals/*`) matches nothing, and the error names the glob to use instead.
- Multiple `--only` flags union together.
- `--only` is only valid with `--build`. Passing `--only` without `--build` is an error.
- A glob that matches zero pages produces an error.
- **The output directory is not cleaned:** existing pages in `dist/` are preserved so a targeted build does not destroy the rest of your site.
- **Pages only:** `--only` scopes page transpilation, not static assets. Static assets are still copied and verified.
- **Production base:** targeted builds require an existing successful full production build. Run `bascik --build` before the first targeted build.
- **Sitemap and robots:** `sitemap.xml` and `robots.txt` generation is skipped with a warning during targeted builds to prevent delisting pages that were not rebuilt. Run a full `bascik --build` to regenerate whole-site sitemaps.
- **Owned artifact transactions:** `manifest.json`, `csp-hashes.json`, and `server-scripts.json` are reconciled from a durable source-to-output ownership inventory (`.bascik/dist/ownership.json`). Pages you rebuild are exactly replaced; pages you do not rebuild are retained untouched (for example, an untouched page's server script keeps resolving); outputs a rebuilt page no longer produces (such as a removed dynamic route) are pruned. All of this happens in one staged transaction, so a failed targeted build never corrupts the previous valid artifact set. Rebuilt-only pruning means a source page deleted without a later targeted build is pruned by a full build.

## Serverless bundles (`--target`)

Use `--target <name>` to emit a deployment bundle for a serverless host in addition to the normal static output:

```sh
bascik --build --target cloudflare-pages
bascik --build --target cloudflare-workers
```

`--target <name>` accepts an official target name, an installed adapter package, or a local file path. The default `dist/` is unchanged. The bundle lands in `dist/.bascik/<name>/` with a `public/` upload tree, the compiled request-time code, and a `build-info.json` describing the release. It is rejected together with `--only`, because a deployment bundle must describe one complete release. See the [Cloudflare Adapter](/deployment/cloudflare) guide for the full workflow.

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

If you explicitly configure the server to run with TLS (`http.tls.enabled: true` in `bascik.config.ts`), Bascik will serve over HTTPS (default port `8443`) and generate local TLS certificates if needed via `mkcert` or `openssl` fallback.

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
  When a change impacts multiple pages (such as an inlined stylesheet or shared component), Bascik checks active live-reload connections and compiles currently open pages first so your visible browser window refreshes immediately before background pages are processed. The home page compiles next, then the rest. The same order applies when the server starts. See [Compile Order](/development-server#compile-order).
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

`bascik --build` treats missing or unreadable configured directories (except a missing default `src/components/`, which means no components), pages without a non-empty `<body>`, runaway component expansion (a page over the [`components.expansionLimits`](/configuration#componentsexpansionlimits) of 10,000 component instances or 50 Mi characters), and output directory or file write failures as hard errors. It waits for all page jobs, reports every failure together, exits nonzero, and does not print `Build complete`.

```terminal
Build failed with 2 page errors:
  src/pages/about.html
    validate markup: Page does not contain a non-empty <body> element
  src/pages/blog/post.html
    write output: EACCES: permission denied
```

Unresolved component tags remain transpilation warnings and never fail a build. `bascik --check` lists them as warnings (exit code 0); pass `--strict` to make them fail, which turns that command into the CI gate for component references. Tags that belong to a custom element or library can be declared in [`components.external`](/configuration#componentsexternal) so neither the build warning nor `--check` reports them, which is what lets `--check --strict` pass on a site that uses them.

Component transpilation failure:

```terminal
[bascik] Transpilation failed for component <site-nav> during css-scoping in "pages/about.html" at (line 22, column 8)
  Defined in component template: "components/site-nav/site-nav.html"
  Error: ParseError: CSS Selector is invalid or could not be parsed.
```

Build script failure:

```terminal
[bascik] build script error in "src/pages/index.html" at (line 12, column 5):
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

Run `bascik --check` from your project root to validate the project without starting the dev server or writing any output files:

```sh
bascik --check
```

`bascik --check` is one command with two halves, and each rule lives in exactly one of them:

- **Project checks** need the whole project: the config, every page and component, the route table. Duplicate routes, unused components, and unmatched tags are examples. `bascik` runs these itself.
- **Per-file checks** need one file: an attribute typo, CSS that cannot be scoped, an API route with no handler. These are the same checks your editor shows as you type, and `bascik --check` runs them through [`@bascik/language-server`](/tools/linter) when it is installed.

Projects created with `npm create bascik` have the language server installed. In a project without it, the project checks still run, and the report says what was skipped:

```terminal
ℹ  per-file checks skipped: install @bascik/language-server to run them (npm install --save-dev @bascik/language-server)
```

The language server also works on its own, with no `bascik` involved, as `npx bascik-language-server --check`. That is the right tool for a shared component library that has no site of its own. See [Linter](/tools/linter) for what it covers and how to suppress a finding.

Findings are grouped by category with every location listed, brief explanations, and near-match suggestions:

```terminal
bascik --check

Components with no matching file (3)
  These are either typos, or third-party web components. Bascik does not
  transpile them; they are passed through to the browser unchanged.
  Declare intentional ones in components.external to hide them.

  <model-viewer>     src/pages/gallery.html:42
  <ion-icon>         src/components/nav/nav.html:8, src/pages/index.html:14
  <my-crd>           src/pages/about.html:31
                     did you mean <my-card>?

Unused components (1)
  Never written as a tag in a page, a component, a build, server or stream
  script, or a local module one imports. Safe to delete, unless a script
  builds the tag name in code, which this check cannot follow (a note says
  where one does).

  src/components/legacy-banner/legacy-banner.html

Per-file checks (2)
  Reported by @bascik/language-server, the engine the editor uses. Run it on its own
  with `npx bascik-language-server --check`.

  src/components/nav/nav.html:3:12 - warning: (unknown-bascik-attribute) Unknown attribute "data-bascik-slott"…
  src/components/nav/nav.html:9:1 - warning: (component-structure-order) Component template convention: place <script> blocks after HTML markup.

✓ 0 errors, 6 warnings
✓ 31 files checked by @bascik/language-server
```

### Check Reference

`bascik --check` runs the following validations. The first table is the project checks, which `bascik` runs itself. The second is the per-file checks, which come from the language server:

| Check                                                                                                  | Category                       | Severity |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ | -------- |
| Configuration key and value validation                                                                 | `config-validation`            | Error    |
| Missing `BASCIK_SITE_URL` when `generate.sitemap` or `generate.robots` is enabled (the build fails)    | `missing-site-url`             | Warning  |
| Pages directory unreadable or empty                                                                    | `pages-directory`              | Error    |
| Duplicate component tag names                                                                          | `duplicate-component-name`     | Error    |
| Circular component references                                                                          | `circular-component-reference` | Error    |
| Duplicate route resolution from page paths                                                             | `duplicate-route-resolution`   | Error    |
| Multiple API route files resolving to one URL, or ambiguous catch-all pairs                            | `route-collision`              | Error    |
| Malformed or non-final API catch-all (`[...]`, `x[...a]`, `[...a]/b.ts`)                               | `invalid-catch-all`            | Error    |
| Unmatched component tag usage                                                                          | `unmatched-tag`                | Warning  |
| Unused component file                                                                                  | `unused-component`             | Warning  |
| WHATWG HTML5 parse errors in compiled `dist/` HTML files                                               | `dist-html-spec`               | Error    |
| Components a server or stream script cannot return (read from the last build)                          | `request-render-unsupported`   | Warning  |
| Components whose request-time CSS or scripts `csp-hashes.json` cannot cover, with `generate.cspHashes` | `request-render-csp-unstable`  | Warning  |

The per-file checks, from `@bascik/language-server`:

| Check                                                                                               | Rule id                     | Severity                 |
| --------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------ |
| Unknown `data-bascik-*` attributes                                                                  | `unknown-bascik-attribute`  | Warning                  |
| A script tag with two directives, such as `data-bascik-build` and `data-bascik-server`              | `script-mode-conflict`      | Error                    |
| A value on `data-bascik-build` or `data-bascik-build-once` (`data-bascik-build="page"`)             | `unknown-directive-value`   | Warning                  |
| A declared component prop passed without the `data-bascik-prop-` prefix (auto-fixable with `--fix`) | `missing-prop-prefix`       | Warning                  |
| API route file with no recognized method export                                                     | `missing-method-handler`    | Error                    |
| Method-like API export with wrong casing (`get`, `Post`)                                            | `invalid-method-case`       | Warning                  |
| A `_middleware.ts` file in the API folder                                                           | `middleware-unsupported`    | Error                    |
| Component template convention (`<style>` above markup, `<script>` below markup)                     | `component-structure-order` | Warning                  |
| CSS or JavaScript in a component that cannot be scoped                                              | `css-*`, `js-*`             | Error or warning by rule |

The language server knows more rules than these, such as undeclared props and slots and unsafe patterns in server scripts. They are all reported by `bascik --check` too. See [Linter](/tools/linter) for the full list and how to suppress one by its rule id. Hints, which are advice for the editor, are not reported by `--check`, so they never fail a CI run.

A component counts as used when its start tag is written anywhere `bascik --check` reads markup: a page, another component, the body of a build, server or stream script, the `src=` module of one, or a local module (`./`, `../` or `@/`) any of those import, followed through their own imports. A tag counts whether it sits on one line or its attributes start on the next (`<cta-band` then a line break), the way a browser reads it, and a tag written in a template literal counts too. A tag in a client-side `<script>`, or in a package, does not. What the check cannot see is a tag name built in code, such as `` `<card-${kind}>` `` or `"<" + tag`: when any script does that, each unused component carries a note that names the file and line, because it may be used there:

```text
Unused components (1)
  ...
  src/components/pick-b/pick-b.html
      may be used: a script builds a tag name in code at src/lib/pick.ts:2, which this check cannot follow
```

The same note is the `note` field of the finding in `--json` output.

The `dist-html-spec` check requires [parse5](https://parse5.js.org/), the reference WHATWG HTML5 parser, to be installed as a dev dependency. When parse5 is present, `--check` parses every compiled HTML file in `dist/` and reports any spec violation with a `file:line:col [error-code]` location. When parse5 is not installed, `--check` prints a one-line hint but does not fail:

```sh
npm install --save-dev parse5
```

`missing-required-prop` is intentionally not emitted. The cheap whole-project heuristic (template has a `data-bascik-prop-*` placeholder, no usage appears to supply it) produced noisy false positives across conditional markup and dynamic content injection paths, so it was removed rather than made misleading.

Every configuration validation finding is an error, because each one also stops `bascik` and `bascik --build` at startup: a missing `pipeline.exec[].script`, an unreadable `http.tls.keyFile` or `http.tls.certFile`, and a missing `pipeline.watchPaths[]` or `assets.inlineStyles[]` path alike. A project that passes `bascik --check` starts without a configuration error.

The rest of the check runs with the configuration minus the rejected settings: a mistyped `http.port` leaves `directory.pages` and every other valid setting in place, so pages and components are checked in the folders you configured. A rejected `directory.pages` is reported once, as a configuration error.

Success exits with code `0` when no errors are found.

### Failing CI on warnings with `--strict`

By default, warnings do not fail the command. Pass `--strict` to treat warnings as errors and exit with code 1:

```sh
bascik --check --strict
```

### Auto-fixing with `--fix`

Pass `--fix` to rewrite the findings that have exactly one correct fix, then report what remains. Fixes are applied by the language server, so `--fix` needs it installed: without it, `bascik --check --fix` exits with code 1 and changes nothing.

Two rules are fixable. `missing-prop-prefix`: a declared prop passed as a plain attribute becomes a `data-bascik-prop-*` attribute. `prefer-self-closing-component`: `<my-card></my-card>` becomes `<my-card />` when the component has no slots.

```sh
bascik --check --fix
```

```html
<!-- before -->
<my-card title="Hello"></my-card>
<!-- after -->
<my-card data-bascik-prop-title="Hello"></my-card>
```

`--fix` edits only the tags that `--check` reports. Component-like text inside comments, `<script>`, `<style>`, and `<textarea>` is left alone.

### JSON output with `--json`

Pass `--json` to emit findings using a stable, documented JSON schema for CI/CD status integrations:

```sh
bascik --check --json
```

Schema:

```json
{
  "errors": 0,
  "warnings": 1,
  "pagesChecked": 8,
  "componentsChecked": 12,
  "distHtmlChecked": 8,
  "distHtmlSpecHintNeeded": false,
  "perFileChecked": 31,
  "perFileHintNeeded": false,
  "fixedFiles": [],
  "findings": [
    {
      "category": "unmatched-tag",
      "severity": "warning",
      "message": "<model-viewer>",
      "locations": [
        {
          "filePath": "src/pages/gallery.html",
          "line": 42
        }
      ],
      "suggestion": "my-viewer"
    },
    {
      "category": "unknown-bascik-attribute",
      "severity": "warning",
      "message": "Unknown attribute \"data-bascik-slott\"…",
      "locations": [
        {
          "filePath": "src/components/nav/nav.html",
          "line": 3,
          "column": 12
        }
      ],
      "source": "language-server"
    }
  ]
}
```

`distHtmlChecked` is the number of `dist/` HTML files parse5 validated, or `null` when `dist/` does not exist or parse5 is not installed. `distHtmlSpecHintNeeded` is `true` when `dist/` has HTML files but parse5 is absent.

`perFileChecked` is the number of files the language server checked, or `null` when it is not installed or too old, in which case `perFileHintNeeded` is `true`. `fixedFiles` lists the files `--fix` rewrote. A finding from the language server has `"source": "language-server"` and a `column`; its `category` is the rule id. An `unused-component` finding has a `note` when a script builds a tag name in code (see [Static analysis](#static-analysis-with-bascik-check) above).

`bascik --check` exits with code `1` when errors are found (or warnings under `--strict`), which makes it suitable for CI:

```sh
bascik --check && bascik --build
```

`bascik --check` does **not** validate CSS or JavaScript syntax. Use those tools immediately around it rather than treating them as a separate, later concern:

| Tool                                  | What it catches                                                    | How to use                                                                     |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **VS Code built-in CSS**              | CSS syntax errors in `.css` files                                  | Enabled by default                                                             |
| **[Stylelint](https://stylelint.io)** | CSS syntax errors, invalid properties, custom conventions          | `npm install -D stylelint && npx stylelint "**/*.css"`                         |
| **[parse5](https://parse5.js.org/)**  | WHATWG HTML5 parse errors in compiled `dist/` output               | `npm install -D parse5` then `bascik --check`                                  |
| **[HTMLHint](https://htmlhint.com)**  | HTML structure errors in page and component `.html` files          | `npm install -D htmlhint && npx htmlhint "src/**/*.html"`                      |
| **[Webhint](https://webhint.io)**     | Web standards, ARIA accessibility, and cross-browser compatibility | `npm install -D hint && npx hint "src/**/*.html"` (with recommended `.hintrc`) |
| **[ESLint](https://eslint.org)**      | JavaScript syntax and logic errors in `.js` files                  | `npm install -D eslint && npx eslint "src/**/*.js"`                            |

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

For guidance on deploying to static hosts or running the production server, see [Deployment Overview](/deployment).

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
    hostname: "0.0.0.0", // bind all interfaces (needed in containers)
    tls: {
      enabled: false, // set to true to run over encrypted HTTP/2 (HTTPS)
    },
  },
};
```

| Option         | Default                        | Description                                    |
| -------------- | ------------------------------ | ---------------------------------------------- |
| `port`         | `8080` (HTTP) / `8443` (HTTPS) | TCP port to listen on                          |
| `hostname`     | `"localhost"`                  | Hostname or IP to bind to                      |
| `tls.enabled`  | `false`                        | Enable TLS (HTTPS) and serve over HTTP/2.      |
| `tls.keyFile`  | auto-generated                 | Path to a PEM private key when TLS is enabled. |
| `tls.certFile` | auto-generated                 | Path to a PEM certificate when TLS is enabled. |

When `tls.enabled` is true and `tls.keyFile` / `tls.certFile` are omitted, Bascik generates certificates automatically using `mkcert` (if installed) or `openssl` as a fallback.

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

**VS Code false positives.** VS Code's built-in HTML checker joins every classic `<script>` (one without `type="module"`) in a file into one JavaScript file, so two Bascik scripts that each `export default` show "A module cannot have multiple default exports." Bascik runs each build and server script on its own, and wraps each component script in its own scope, so that error is false. Plain `<script>` blocks in a page still share the browser's global scope, so the same top-level `const` in two page scripts is a real error. `npm create bascik` and `bascik init` turn this check off in `.vscode/settings.json`, and the [Bascik extension](/tools/vscode-extension#several-scripts-in-one-file) offers to add it in a Bascik workspace that has no value set. For other projects, add this to `.vscode/settings.json`:

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
