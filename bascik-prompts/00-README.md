# Bascik pre-release hardening: prompt index

This folder contains an ordered set of small implementation prompts. Run them **in numeric
order**, and **open a fresh chat for each one**. They are deliberately sized so a single prompt
plus the files it touches fits comfortably in a model's context window.

**Read this README at the start of every prompt.** It carries all shared context, so the
individual prompts stay short and do not repeat it.

---

## Non-negotiable working method

### Test-driven, every time

Every prompt follows the same loop:

1. **Write the failing test first.** Run it. Confirm it fails for the _right reason_.
2. Implement the smallest change that makes it pass.
3. Re-run. Move to the next test.

When fixing a bug, the first thing you write is a test that **pins the current wrong behavior
as failing**. That is your regression anchor. Without it you cannot tell a fix from a
coincidence, and most bugs in this codebase are silent.

Do not batch steps. Do not write the implementation and then backfill tests.

### Both unit and end-to-end tests

Every prompt that changes behavior needs **unit tests** and, where the change is observable in
a running site, **E2E tests**.

There are four E2E configurations. Each prompt states which apply, and **you must state your
reasoning if you skip one**:

| Config                                      | Mode                                            |
| ------------------------------------------- | ----------------------------------------------- |
| `pkg/e2e/playwright.config.ts`              | Static production build output, served as files |
| `pkg/e2e/playwright.dev.config.ts`          | Live dev server                                 |
| `pkg/e2e/playwright.server.config.ts`       | Production server over HTTP/1.1                 |
| `pkg/e2e/playwright.server-http2.config.ts` | Production server over HTTP/2                   |

Environment parity is a stated design property. Past bugs came from dev and build diverging, so
"it works in dev" is not evidence.

E2E assertion rules:

- Use `data-testid` and `page.getByTestId()` **only**. Production builds hash class names and
  IDs, so never assert on a raw class or ID.
- Never use `.nth(N)` or relative DOM traversal such as `.locator('../..')`.

**You cannot run Playwright in the agent sandbox.** It binds ports and hangs. Write the tests,
then ask the user to run `yarn e2e:all` in a normal terminal and report results. Do not retry a
hanging command with variations.

### Branching

**Do not discuss branching, and do not create branches.** The user manages all branches. Start
from whatever is checked out.

---

## The order

Run top to bottom. Later prompts assume earlier ones have landed.

### Docs and skill corrections

| #   | Prompt                   | Focus                                     |
| --- | ------------------------ | ----------------------------------------- |
| 01  | `01-docs-math-rendering` | Literal `$...$` in rendered docs          |
| 02  | `02-skill-corrections`   | SKILL.md contradictions and guidance gaps |

### Configuration and CLI

| #   | Prompt                       | Focus                                                     |
| --- | ---------------------------- | --------------------------------------------------------- |
| 03  | `03-config-shape`            | Restructure by concern, mode named exports                |
| 04  | `04-config-env-and-site-url` | `BASCIK_SITE_URL`, `.env`, precedence                     |
| 05  | `05-config-validation`       | Actionable errors for bad config                          |
| 06  | `06-config-loading-fixes`    | ENOENT swallowing, `deepFreeze`, duplicate `defineConfig` |
| 07  | `07-cli-parsing`             | One parser, conflicting flags, `--flag=value`, new flags  |
| 08  | `08-public-api-and-init`     | Package exports, `bin` guard, `bascik init`               |

### Data safety

| #   | Prompt                     | Focus                                           |
| --- | -------------------------- | ----------------------------------------------- |
| 09  | `09-path-safety`           | Source-deletion bug, unified path to URL        |
| 10  | `10-asset-filtering`       | `.env` leakage, `directory.public`, dotfile 404 |
| 11  | `11-dist-lifecycle`        | Clean output, restore dev page writes           |
| 12  | `12-build-failure-honesty` | Swallowed write errors, dev server survival     |

### Transpiler correctness

| #   | Prompt                             | Focus                                               |
| --- | ---------------------------------- | --------------------------------------------------- |
| 13  | `13-props-correctness`             | Prop leakage, collisions, escaping                  |
| 14  | `14-class-tokens-and-tag-matching` | Empty class token, `<card-header>` over-match       |
| 15  | `15-html-minifier`                 | Comment stripping order, config gating              |
| 16  | `16-structural-regexes`            | Root attribute merge, body reassembly, self-closing |
| 17  | `17-prop-attribute-binding`        | `data-bascik-attr-*`                                |
| 18  | `18-shielding-consolidation`       | Five shielding implementations into one             |

### Preserve and ID references

| #   | Prompt                  | Focus                                         |
| --- | ----------------------- | --------------------------------------------- |
| 19  | `19-preserve`           | `scoping.preserve` and `data-bascik-preserve` |
| 20  | `20-id-references-html` | `for`, `aria-*`, fragments, `usemap`          |
| 21  | `21-id-references-css`  | `url(#id)` and the shielding carve-out        |

### Base path

| #   | Prompt                   | Focus                                     |
| --- | ------------------------ | ----------------------------------------- |
| 22  | `22-base-path-transform` | Rewriting root-relative URLs in output    |
| 23  | `23-base-path-serving`   | Serving under `base`, generated artifacts |

### Determinism and build artifacts

| #   | Prompt                      | Focus                                          |
| --- | --------------------------- | ---------------------------------------------- |
| 24  | `24-deterministic-ids`      | Reproducible instance IDs                      |
| 25  | `25-component-discovery`    | Sorted traversal, duplicate name error         |
| 26  | `26-build-manifest`         | Emitted-file manifest                          |
| 27  | `27-server-script-sidecar`  | Keep server script source out of static output |
| 28  | `28-sitemap-and-robots`     | Authored-file precedence, exclusion, race      |
| 29  | `29-csp-hashes`             | Inline script and style hash manifest          |
| 30  | `30-dynamic-routes`         | Collisions, URL safety, shared runner          |
| 31  | `31-build-script-execution` | Cache config, batch fallback, error wrapping   |
| 32  | `32-exec-improvements`      | `cwd`, `env`, `args`, failure handling         |
| 33  | `33-targeted-build`         | `bascik --build --only <glob>`                 |

### Performance

| #   | Prompt               | Focus                                   |
| --- | -------------------- | --------------------------------------- |
| 34  | `34-transpile-loop`  | Quadratic scanning                      |
| 35  | `35-css-memoization` | Per-instance CSS re-scoping             |
| 36  | `36-regex-and-boot`  | Attribute dedup, server boot allocation |

### Server

| #   | Prompt                           | Focus                                          |
| --- | -------------------------------- | ---------------------------------------------- |
| 37  | `37-crash-net`                   | Client abort crashes the process               |
| 38  | `38-compression-and-error-pages` | Brotli regression, 500 page                    |
| 39  | `39-caching-layer`               | Content-hash ETags, cache-control, 304         |
| 40  | `40-trust-proxy-and-rate-limit`  | Behind a CDN                                   |
| 41  | `41-shutdown-and-health`         | Real drain, health endpoint, port conflict     |
| 42  | `42-sse`                         | Heartbeat, backpressure, error overlay         |
| 43  | `43-pipeline-and-logging`        | Null bytes, realpath, unlogged static requests |
| 44  | `44-watch-mode`                  | Atomic saves, debounce, symlinks               |
| 45  | `45-tls-and-headers`             | SubjectAltName, key permissions, COOP/COEP     |

### Script runtime and API routes

| #   | Prompt                        | Focus                                      |
| --- | ----------------------------- | ------------------------------------------ |
| 46  | `46-script-registry`          | In-process module registry                 |
| 47  | `47-server-scripts-migration` | Retire the child-process-per-request model |
| 48  | `48-api-routes-core`          | Routing, contract, method dispatch         |
| 49  | `49-api-routes-security`      | Body limits, timeouts, source protection   |

### Check and cleanup

| #   | Prompt                 | Focus                                          |
| --- | ---------------------- | ---------------------------------------------- |
| 50  | `50-check-output`      | Findings model, sections, `--json`, `--strict` |
| 51  | `51-check-validations` | The checks it should perform                   |
| 52  | `52-cleanup-sweep`     | Dead code, duplication, naming                 |

### Documentation structure

| #   | Prompt                | Focus                                           |
| --- | --------------------- | ----------------------------------------------- |
| 53  | `53-docs-naming`      | h1 equals sidebar label, with a regression test |
| 54  | `54-how-to-rename`    | Recipes becomes How-to                          |
| 55  | `55-templating-guide` | Handlebars first, fetch-once pattern            |
| 56  | `56-how-to-guides`    | Bundling, fingerprinting, sharing, micro sites  |

### Component distribution

| #   | Prompt          | Focus                     |
| --- | --------------- | ------------------------- |
| 57  | `57-bascik-add` | Copy-in component command |

### Articles

| #   | Prompt                       | Focus                       |
| --- | ---------------------------- | --------------------------- |
| 58  | `58-articles-infrastructure` | The Articles section itself |
| 59  | `59-article-micro-sites`     | Write the article           |
| 60  | `60-article-docs-search`     | Write the article           |
| 61  | `61-article-scoping-engine`  | Write the article           |
| 62  | `62-article-zero-runtime`    | Write the article           |

---

## Decisions already made: do not re-litigate

If a prompt seems to contradict one of these, the decision here wins and the prompt has a bug
worth reporting.

### Project posture

| Topic              | Decision                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renaming           | Rename anything ambiguous freely. **No deprecation aliases.** Bascik is unreleased. "No 2.0 ever" means contracts freeze _at release_, not now.           |
| Production server  | `bascik --server` is a real deploy target and gets full hardening.                                                                                        |
| Performance claims | Do not justify work with the Lighthouse score unless the audit is actually weighted. `uses-long-cache-ttl` is an unweighted diagnostic in Lighthouse 10+. |

### Configuration

| Topic                | Decision                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Organization         | By concern, not by lifecycle. Mode variance via named exports `dev`, `build`, `server`.                |
| `siteUrl`            | **Not a config key.** Three sources: `--site-url` flag, `BASCIK_SITE_URL` env var, `.env` file.        |
| `errorPages`         | **Not a config key.** Convention: `src/pages/404.html`, `src/pages/500.html`, with built-in fallbacks. |
| `stripServerScripts` | **Not a config key.** Sidecar file, always.                                                            |
| `assets.fingerprint` | **Not a config key.** Documented recipe only.                                                          |
| Scopable options     | `boolean \| { enabled?, include?, exclude? }` is the repo-wide convention.                             |
| `onScriptError`      | Split into `onBuildScriptError`, `onRoutesScriptError`, `onServerScriptError`.                         |
| `--serve`            | Renamed to `--server`. Config key, function names, and env var all follow.                             |

### Authoring model

| Topic                | Decision                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prop escaping        | HTML-escape prop values by default. Slots are the documented raw-markup path.                                                                                      |
| Prop to attribute    | `data-bascik-attr-{attribute}="{propName}"`. Same idea as props, different destination. Spec-compliant `data-*`, no templating, no variables.                      |
| Preserve             | ONE concept, two scopes: config `scoping.preserve: ['code']` by tag name, attribute `data-bascik-preserve` per element. Replaces `skipTranspilingElementContents`. |
| Component subfolders | Allowed for organization. Tag names still come from the filename. **Duplicate names are an error.** Docs recommend staying flat.                                   |
| Data injection       | Recipes only. No templating feature. Handlebars is the recommended library.                                                                                        |
| Component sharing    | Documented recipe plus a real `bascik add` command (copy-in, shadcn model).                                                                                        |

### Explicitly rejected: do not build these

- Scheduled rebuilds, webhook rebuild endpoints, an MCP server.
- Multiple component directories (subfolders of the one directory are supported instead).
- Automatic asset URL fingerprinting.
- A templating or interpolation syntax.
- Middleware, CORS config, auth, ORM integration, or a typed RPC client for API routes.
- Deprecation aliases for any renamed option.

---

## The agreed config shape

```ts
// bascik.config.ts
export default defineConfig({
  base: '/',
  directory: { pages, components, public, out, api },
  scoping:   { attributes: { class, id, name }, scriptBlocks, inheritAttributes,
               deduplicateCss, preserve: ['code'] },
  minify:    { html, css, js, identifiers },
  assets:    { exclude, inlineStyles },
  scripts:   { cache, timeout,
               onBuildScriptError, onRoutesScriptError, onServerScriptError },
  generate:  { sitemap, robots, sitemapLastmod, cspHashes, manifest },
  pipeline:  { workers, watchPaths, exec },
  http:      { port, hostname, tls, trustProxy, rateLimit, cacheControl,
               compression, timeouts, maxBodySize, apiTimeout },
  logging:   { level, requests, copies, deletes, transpiles },
});

export const dev    = { minify: false, http: { port: 3000 } };
export const build  = { minify: true };
export const server = { minify: true, http: { port: 443, tls: { enabled: true } } };
```

Notes:

- `http` is one concern because it is one server. Only the values differ per mode.
- `logging` is top level because `copies`, `deletes`, and `transpiles` were never HTTP concerns.
- The named exports fix an existing bug where `export const build` silently could not override
  dev-server settings.

---

## Configuration precedence

Document in `docs/content/configuration.md` and link from every page that mentions a setting.
Verified against Node, npm, Vite, Astro, Hugo, AWS CLI, kubectl, and Terraform.

```
CLI flag  >  real environment variable  >  .env file  >  config file  >  built-in default
```

Most specific and most ephemeral wins. The config file is checked into git and shared by
everyone, the environment is per-deployment, and a flag is per-invocation.

Citations:

- Node `--env-file`: "If the same variable is defined in the environment and in the file, the
  value from the environment takes precedence." Also: "You can pass multiple `--env-file`
  arguments. Subsequent files override pre-existing variables defined in previous files." Also:
  "An error is thrown if the file does not exist" (`--env-file-if-exists` is tolerant).
- Node CLI: "Options from the command line take precedence over options passed through the
  `NODE_OPTIONS` environment variable."
- Node config file: "The priority in configuration is as follows: 1. NODE_OPTIONS and
  command-line options, 2. Dotenv NODE_OPTIONS, 3. Configuration file."
- npm: CLI flags, then `npm_config_*` env vars, then project `.npmrc`, then user `.npmrc`, then
  global `.npmrc`, then built-in defaults.
- dotenv: `override: false` is the default, so a `.env` file never clobbers a real env var.

---

## Verified facts about the current codebase

Confirmed by reading the source. Do not assume otherwise, and do not "fix" one in a prompt that
does not own it.

- **Class names are already deterministic under the default config.**
  `pkg/src/lib/javascript.ts#L139`:
  `scopeKey = attribute === "class" && deduplicateCss ? component.name : componentInstanceName`.
  With `deduplicateCss: true` (the default), scoped class names contain the component name
  only. The random instance ID reaches scoped `id` and `name` attributes only.
- **Dev mode does not write pages to `dist/` today** (`pkg/src/lib/processing.ts#L1035`, guarded
  by `if (BascikConfig.isBuild)`), but `copyStaticAssets()` DOES run in dev and
  `deleteDistFile` / `deleteDistDir` are watcher-driven. Dev therefore leaves a half-built
  `dist/` with assets but no HTML. **This is a regression, not a design.**
- **`SKILL.md` contradicts itself** on the above: one section says both dev and build write
  compiled HTML to `dist/`, another says no writes happen in dev.
- **`maskRawTextContent` and `skipTranspilingElementContents` are different concerns.**
  `maskRawTextContent` (`components.ts#L319-L340`) blanks `<script>`, `<style>`, `<textarea>`,
  and comments **temporarily during regex scanning**, then discards the mask. It is correctly
  hardcoded and must stay internal. `skipTranspilingElementContents`
  (`javascript.ts#L157-L190`) shields content from scoping transforms **persistently**.
- **Component tag names come from the filename only**:
  `fileName.replace(/^.*[\\/]/, '').split('.')[0].toLowerCase()` (`components.ts#L177`).
  Subdirectory recursion works, so `marketing/card.html` and `admin/card.html` both register
  `<card>` and the `reduce` at `components.ts#L282-L290` silently last-wins with no warning.
- **500 responses send no body at all** (`server.ts#L104-L126`). 404 works by path convention
  (`is404Page`, and `mem.getPage` falls back to `/404`).
- **Bascik inlines component CSS and JS.** Component `<style>` blocks are hoisted into one
  `<style>` in `<head>` (`processing.ts#L945`); `assets.inlineStyles` inlines global
  stylesheets. The docs site has zero external stylesheet or script requests. Only images,
  fonts, favicons, the webmanifest, `directory.public`, and author-written `<script src>` remain
  external.
- **Pages already get a strong SHA-256 content ETag** (`names.ts#L54-L55`). Static assets get a
  weak mtime-based ETag (`server.ts#L41-L42`), which differs across CI checkouts and replicas.
- **No machinery anywhere rewrites asset URLs in output HTML.** The SHA-256 in
  `copyReplicatePath` (`file-system.ts#L57`, `#L109`) only skips unchanged copies.
- **`renderMd` only transforms fenced code blocks and blockquotes.** There is no KaTeX in the
  docs site, so every `$...$` in a Markdown file renders literally.
- **Targeted builds are mostly existing plumbing.** `selectivelyProcessPages`,
  `selectivelyProcessPagesForWatchPath`, and `processPageBatch` exist, and `mem` already tracks
  `usedComponentsSet` and `fileDependenciesSet`.
- **Slots render raw HTML.** `extractNamedSlotContent` (`components.ts#L731-L742`) and
  `replaceNamedSlots` (`#L751-L771`) splice content with no encoding, the result is recursively
  transpiled at `processing.ts#L807`, and scoping applies. Slot content can contain nested
  components.

---

## Code rules

- No `@ts-ignore`, no `as any`. If a type fix is not straightforward, say so rather than
  suppressing.
- **Use function replacements, never string replacements**, anywhere interpolated user text
  reaches `String.prototype.replace`. Values can contain `$&`, `$1`, and `` $` ``, which have
  caused infinite loops and out-of-memory crashes in this repo. `() => value`, always.
- Comments state only what the code cannot show. One short line. No essays.
- Naming: prefer the unambiguous word over the short one (`isProdServer`, not `isServe`).
- Resilience: warn and continue on malformed user input. Never crash the build or the server on
  bad markup.
- Do not introduce an HTML or CSS AST parser. Resilience to malformed input is a design
  property; the codebase uses regexes with depth counters deliberately.

## Test rules

- Vitest 4. Use `vi.hoisted()` for shared mock instances and `mockReset()` in `beforeEach`.
  `vi.clearAllMocks()` now also resets module mocks created by `vi.mock()`, which will sever
  references captured in test-file variables.
- Never mutate package source directories from a test. Never leave untracked files on disk. Use
  isolated temp directories or clean mocks.

## Commands

```sh
yarn unit:all            # all unit tests, all packages
yarn typecheck:all       # all tsconfigs
yarn check:spelling      # codespell
yarn pkg:build           # rebuild the package
yarn docs:build          # rebuild docs (regenerates llms.txt and the search index)

npx vitest run pkg/src/lib/<file>.test.ts
npx --prefix pkg tsc -p pkg/tsconfig.json --noEmit
```

Check pass/fail first. If everything passes, do **not** print the list of passing test names. If
something fails, read only that failure's trace.

## Environment limits

- **Do not run Playwright, `yarn dev`, `bascik --server`, or `curl` in the agent sandbox.** They
  bind ports or need network and will hang indefinitely.
- **Do not run pre-push scripts.** The user handles those personally.

## Docs rules

Full rules in `.github/copilot-instructions.md`. The load-bearing ones:

- All page content lives in `docs/content/*.md`, never in the HTML shell.
- `SKILL.md` and `create/assets/SKILL.md` are synced by hand and must stay in step.
- Keep each page's `<title>` and `<meta name="description">` aligned with its h1 and intro.
- **A page's h1 must equal its sidebar label** (established in prompt 53; match it from the
  start on any new page).
- American English. **No em-dashes.** Run `codespell`.
- `docs/content/compatibility.md` must be updated whenever a CSS or JS scoping capability is
  added, changed, or fixed. Repo policy.
- `CHANGELOG.md` is skipped: pre-1.0 policy.
