# Bascik Docs: Copilot Instructions

This file applies to all work inside `/docs/`. Read it before creating or editing docs pages.

## Content Lives in Markdown

**All docs page content must be written in `docs/content/*.md` files, not directly in the HTML page.**

The Markdown files serve three purposes simultaneously:
1. They are the canonical source for the rendered docs page (via `data-bascik-build`)
2. They feed `llms.txt` (generated automatically via `exec` in `docs/bascik.config.ts`)
3. They feed `SKILL.md` (the Copilot skill file at `docs/src/pages/assets/SKILL.md`, served at `/assets/SKILL.md`)

**When adding or updating docs content:**
- Write the prose and code examples in the appropriate `docs/content/topic.md` file
- The HTML page is a shell: edit it only for page-specific chrome (custom styles, decorative UI, score grids, etc.)
- Never duplicate prose between the MD file and the HTML file

## How Pages Render from MD

Each docs page that has a corresponding MD file uses a `<script data-bascik-build>` block inside `<main class="docs-content">`:

```html
<!-- Content rendered from docs/content/topic.md at build time.
     To update page content, edit the MD file, not this file. -->
<script data-bascik-build>
  import { join } from 'node:path';
  import { pathToFileURL } from 'node:url';
  const { renderMd } = await import(
    pathToFileURL(join(process.cwd(), 'src/lib/md-renderer.ts')).href
  );
  console.log(await renderMd('./content/topic.md'));
</script>
```

The `renderMd` helper (`docs/src/lib/md-renderer.ts`) applies these transformations:
- Fenced code blocks (` ``` `) → `<code-block data-bascik-prop-lang="…">` component
- Blockquotes (`>`) → `<div class="callout">`

## HTML Page Shell Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <!-- title, styles.css, any page-specific <style> -->
</head>
<body>
  <docs-nav></docs-nav>
  <div class="container">
    <div class="docs-layout">
      <docs-sidebar></docs-sidebar>
      <main class="docs-content">
        <script data-bascik-build>
          import { join } from 'node:path';
          import { pathToFileURL } from 'node:url';
          const { renderSectionLabel } = await import(
            pathToFileURL(join(process.cwd(), 'src/lib/render-nav.ts')).href
          );
          console.log(renderSectionLabel('/topic'));
        </script>
        <!-- h1, page-intro p, and all content come from MD -->
        <script data-bascik-build>…</script>

        <!-- Any page-specific summary UI (technique grids, etc.) -->

        <div class="callout">
          <p><strong>Next:</strong> …</p>
        </div>
      </main>
    </div>
  </div>
  <docs-footer></docs-footer>
</body>
</html>
```

## Markdown File Conventions

- First lines: `# Page Title` (h1), then a plain intro paragraph (styled as page-intro via CSS)
- Prose: plain Markdown paragraphs
- Section headings: `##` (h2), sub-sections: `###` (h3)
- Code examples: fenced code blocks with a language tag (` ```html `, ` ```css `, ` ```js `, etc.)
- Callout/tip boxes: Markdown blockquote (`> **Label.** body text`)
- No inline HTML in MD files: keep MD pure Markdown

## Updating SKILL.md and create/assets/SKILL.md

**Do not run `#pre-push.prompt.md` or pre-push scripts automatically.** The user handles running pre-push steps.

Note: `llms.txt` and search index are generated automatically when running `yarn docs:build` (or during dev server via `exec` in `docs/bascik.config.ts`). **Lifecycle/generation scripts executed by `exec` must write their generated output files directly to the output directory (`dist/`), never to the source directories (`src/`), to avoid polluting the source tree with build-time artifacts.**

If manually updating or propagating `SKILL.md` when specifically requested:

```sh
yarn create:prepack
```

These files must stay in sync. A content change that lands in `docs/content/*.md` but not `SKILL.md` (or vice versa) means Copilot is working from stale guidance, which is how bugs like "use `querySelector` for per-instance elements" go undetected.

### Skill Authoring & Best Practices (agentskills.io)

When updating `SKILL.md`, follow the official Agent Skills best practices (https://agentskills.io/skill-creation/best-practices):

- **Illustrative vs. Literal Code Examples:** Frame code blocks and configuration options (such as `exec` script arrays, BYOMinifier custom transformers, or page-aware canonical helpers) with explicit commentary indicating they are illustrative examples. AI agents must understand what capabilities exist without copying example script paths or filenames literally.
- **Add What the Agent Lacks, Omit What It Knows:** Focus on Bascik-specific mechanics, transforms, scoping rules, and gotchas. Omit generic explanations of HTML, CSS, JavaScript, or standard web concepts.
- **Provide Defaults, Not Menus:** Always highlight the primary default pattern first (e.g. `getElementById` for per-instance DOM selection, or `deduplicateCss: true` in `bascik.config.ts`), and list alternative options concisely as escape hatches.
- **Calibrate Control:** Be prescriptive where operations are fragile or critical (e.g. using `getElementById` for per-instance script isolation, writing `exec` outputs to `dist/`, placing `<style>` above and `<script>` below HTML), and explain the rationale when providing procedural steps.
- **Gotchas and Constraints:** Keep non-obvious traps upfront and explicit (e.g. `querySelector('.cls')` targeting only the first instance under shared scoping, `innerHTML` class scanning limitations, or `data-bascik-build` and `data-bascik-server` being mutually exclusive).
- **Writing Style:** Keep entries concise, structured, and free of em-dashes. Use standard American English.

## Sidebar

Add new pages to `docs/src/components/docs-sidebar/docs-sidebar.html`. Group under the appropriate `<p class="sidebar-heading">` section.

## Code in HTML Slots (component-demo pattern)

Interactive demos use `<component-demo>` with named slots. **Code examples inside those slots must come from MD files**, not written inline as `&lt;`/`&gt;` entities in the HTML page.

### Why MD-first

MD files feed `llms.txt` and `SKILL.md`. If code examples only exist in HTML slots, LLMs never see them. Write example code in the relevant `docs/content/topic.md` file first; the HTML slot reads from there.

### How to add a demo code block to an MD file

Place an HTML comment marker immediately before the fenced code block:

```markdown
<!-- demo:source-html -->
` ` `html
<div class="fcard">
  <p class="fcard-label" data-bascik-prop-label></p>
</div>
` ` `
```

Marker IDs are arbitrary strings (e.g. `source-html`, `output-css`, `code`, `output`).

### How to use it in an HTML slot

Use `extractDemoBlock` from `src/lib/md-renderer.ts` inside a `data-bascik-build` script. Bascik trims slot content at build time, so normal indentation around the `<script>` tag is fine: no collapsed one-liner is needed.

```html
<div data-bascik-slot="source-html">
  <code-block data-bascik-prop-lang="html">
    <script data-bascik-build>
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const { extractDemoBlock } = await import(
        pathToFileURL(join(process.cwd(), 'src/lib/md-renderer.ts')).href
      );
      console.log(await extractDemoBlock('./content/03-scoped-css.md', 'source-html'));
    </script>
  </code-block>
</div>
```

## Fix Bugs in the Package, Not the Docs

This repo is the **bascik package itself** (`pkg/`). When a rendering or build issue (e.g. minification stripping newlines, whitespace collapsing, HTML output mangled) would otherwise require a workaround in the docs content or build scripts, **fix it in `pkg/src/` instead**. Do not paper over bascik bugs with hacks in the docs layer.

## Keeping SEO Meta in Sync with Content

Each docs page has a `<title>` and `<meta name="description">` hardcoded in its HTML file. These are **not** generated from the Markdown; they are maintained manually.

**When editing a `docs/content/*.md` file**, check whether the h1 or intro paragraph changed in a way that should be reflected in the corresponding HTML page's `<title>` or `<meta name="description">`. If so, update both together.

The mapping is straightforward: `docs/content/topic.md` corresponds to `docs/src/pages/topic.html`. The `<title>` should reflect the page's h1 (with ` - Bascik Docs` suffix for non-homepage pages), and the description should be a concise search-optimised summary drawn from the intro paragraph.

## Keeping the Changelog Up to Date

`CHANGELOG.md` is not actively maintained during pre-1.0 development: the 1.0.0 release entry will be written as a high-level announcement. **Once 1.0.0 ships**, resume normal changelog discipline: add an entry to `[Unreleased]` whenever you add a feature, fix a bug, or make any user-visible change to `pkg/src/`. One bullet per change, grouped under `### Added`, `### Fixed`, or `### Changed`.

## Keeping the Compatibility Doc Up to Date

`docs/content/compatibility.md` tracks which CSS and JavaScript patterns Bascik's scoping engine handles. **Whenever a CSS or JS scoping capability is added, changed, or fixed**, update the relevant table row (or add a new one) in that file before finishing the task.

- New capability: add a row with ✅ and a concise Notes entry.
- Fixed or improved: update the Status and/or Notes of the existing row.
- Intentionally unsupported: add a row with 🚫 and an explanation.

After editing `compatibility.md`, run `#pre-push.prompt.md` is NOT required. The user handles running pre-push steps.

## Keeping Docs in Sync with the Package

The repo uses **Yarn workspaces**. `node_modules/@bascik/bascik` is a symlink to `pkg/`, so the docs always resolve the live source, with no pack, copy, or lock-file deletion needed.

Whenever `pkg/src/` is changed, propagate the change to the docs in two steps:

### 1. Rebuild the package
```sh
yarn pkg:build
```

### 2. Rebuild and check the docs
```sh
yarn docs:build
```

Then inspect the relevant `docs/dist/` output to confirm the pkg change has the intended effect.

## Tests and Coverage

**When adding, removing, or significantly changing tests in `pkg/src/` or `pkg/e2e/`:**

- The testing docs (`docs/content/internals/testing.md`) describe the test approach, not an enumerated list of files. The "Test Files" section links to GitHub which is always current. You only need to update the prose if the testing *patterns* change (e.g. a new mock strategy, a new test runner, new helpers, or new E2E server modes like `playwright.dev.config.ts`).
- E2E tests support four server modes: static production (`playwright.config.ts`), HTTP/1.1 production server (`playwright.server.config.ts`), HTTP/2 production server (`playwright.server-http2.config.ts` via `yarn pkg:e2e:prod`), and live dev server (`playwright.dev.config.ts` via `yarn pkg:e2e:dev`).
- The coverage numbers shown on the testing page are read from `pkg/test-coverage.json` (unit tests) and `pkg/e2e-test-coverage.json` (E2E build-step coverage) at docs build time. Do not run `#pre-push.prompt.md` or pre-push scripts automatically after adding tests. The user handles running pre-push steps.

**When changing server components in `pkg/src/lib/` (or adding to the live-reload / SSE / watch / request script systems):**
Update `docs/content/internals/server.md` to reflect the change. This page is the source of truth for how the server architecture works across dev and production modes.

**General principle:** the three files that must stay in sync are `llms.txt`, `SKILL.md`, and the relevant `docs/content/internals/*.md`. The copilot-instructions file is the enforcement mechanism: add notes here when a new sync relationship is created.

### Testing Philosophy & Bug Prevention

High unit test coverage numbers can create false confidence if tests only exercise happy-path functions in isolation with ideal inputs. Bascik's testing philosophy focuses on real-world system boundaries, environment parity, and edge-case resilience:

1. **Test Boundaries, Not Just Isolated Functions (Coverage ≠ Resilience):**
   - High line coverage does not prove system resilience. Bugs hide at boundary intersections: Main Thread ↔ Worker Thread, Dev Server SSE ↔ Browser EventSource, and Build Scripts ↔ Disk Cache.
   - Always pair unit tests with E2E integration tests running against active dev (`bascik`), production HTTP/2 (`bascik --server`), and static build output (`bascik --build`).

2. **Test the Full Real-World Input Spectrum:**
   - Functions rarely receive clean ideal inputs in production. Test path utilities, route lookups, and watchers against the full spectrum of environment inputs: absolute filesystem paths (`/abs/.../src/pages/x.html`), relative paths (`src/pages/x.html`, `pages/x.html`), bare filenames (`x.html`), subfolder routes, Windows backslashes, and trailing slash URL variants.
   - Test string replacements with special regex tokens (`$1`, `$2`, `$&`, ``$` ``) such as SQL parameter placeholders or JSON strings containing HTML tags. Core pipeline replacements must use function replacements `() => value` to prevent infinite loops and process OOMs.

3. **Enforce Environment Parity in Tests:**
   - Worker threads (`worker-pool.ts`, `page-worker.ts`) do not inherit `process.argv` from the main thread. Always test worker execution explicitly and verify that disk side-effects (`dist/` outputs) occur as expected, not just in-memory return values.
   - Identifier minification in production (`bascik --build` with `minify.identifiers: true`) hashes and compresses scoped element IDs and class names. Consequently, E2E assertions must never target raw classes or IDs (such as `.search-overlay` or `[id$="detail"]`). Instead, always use explicit `data-testid` attributes and locate them using Playwright's native `page.getByTestId(...)` API. Never use fragile relative DOM traversal (`.nth(N)` or `.locator('../..')`).

4. **Resilience & Fault Tolerance by Design:**
   - Test recovery from invalid user input, syntax errors, rapid file edits, and unexpected client disconnects (`ECONNRESET`, `EPIPE`, `ERR_HTTP2_STREAM_CANCEL`). The watcher and server must stay alive and recover automatically.
   - Unit tests must be strictly isolated: never mutate package source directories or leave un-gitignored files on disk (`bascik.config.js`, `pages/index.html`). Run filesystem tests in isolated temp directories or mock system calls cleanly.

## License Source of Truth

The license lives in **three places** that must stay in sync:

- `docs/content/license.md`: the web-formatted version rendered at `https://bascik.dev/license`
- `LICENSE` (repo root): plain-text version; **required** for GitHub license detection and as the `prepack` source
- `pkg/LICENSE` and `create/LICENSE`: copies for the npm tarballs; synced automatically on publish via the `prepack` script in each `package.json`

**When updating the license terms:**
1. Edit `docs/content/license.md` (the human-readable web version)
2. Mirror those changes to the root `LICENSE` (same terms, plain-text format)
3. Run `cp LICENSE pkg/LICENSE && cp LICENSE create/LICENSE` to sync the package copies immediately

Do **not** delete the root `LICENSE`: GitHub reads it for repo-level license detection. Do not edit `pkg/LICENSE` or `create/LICENSE` directly; they are derived files.

## Node 24: Native TypeScript Support

This project runs on **Node 24**. Node natively strips TypeScript types, with no transpiler or extra flags needed for erasable syntax.

- `node example.ts` works directly (Node 22.18+ with only erasable syntax, no flags required).
- Erasable syntax: type annotations, interfaces, type aliases, `import type`. These are stripped at runtime.
- Non-erasable syntax (`enum`, parameter properties, namespaces with runtime code) is **not** supported: a separate transpile step is required for those.
- Node does **not** type-check. Run `npx tsc --noEmit` separately for type checking.
- No `tsconfig.json` is needed for Node to run `.ts` files.

**Practical implication:** `data-bascik-build` and `data-bascik-server` scripts can import `.ts` helper files and Node handles them natively. Bascik does not need to add its own type-stripping layer for server-side or build-time scripts.

## Agent Environment Notes

### Use Root Scripts or `yarn workspace <pkg> <script>`

Commands can be run directly from the root using helper scripts (`yarn test:all`, `yarn unit:all`, `yarn typecheck:all`, `yarn pkg:build`, `yarn docs:dev`, etc.) or using `yarn workspace <pkg> <script>`.

The repo uses **Modern Yarn 4** (`yarn@4.6.0`) with `nodeLinker: node-modules`. Ctrl+C on interactive watch mode commands exits cleanly with code 0/130 and zero `ELIFECYCLE` error messages.

```sh
yarn test       # vitest watch mode (@bascik/bascik)
yarn docs:dev   # docs dev server (bascik-docs)
```

### VS Code Sandbox and Command Permissions

The agent can run all project commands, including commands that bind to ports or make outbound connections, such as Playwright E2E tests, `yarn dev`, and `curl`.

If one of these commands hangs or cannot access the required resource, the command may be running with sandbox restrictions instead of full permissions. Stop the command and ask the user for permission to rerun it with the required access. Do not retry the same command or minor variations inside the sandbox.

### Token-Efficient Test Execution & Output Parsing

- **Unit tests, typechecks, checks, E2E, and Lighthouse**: To run all tests across all monorepo packages (`pkg`, `docs`, `create`, `extensions/vscode-bascik`), use `yarn test:all`. For unit tests only, use `yarn unit:all`.
- **E2E tests**: Playwright E2E tests are configured in package scripts (`yarn pkg:e2e`, `yarn pkg:e2e:prod`, `yarn e2e:all`) with `--reporter=line` output to preserve context tokens.
- **Efficient output parsing**:
  - Always check the overall status first: **Did it pass or fail?**
  - If all tests pass, stop immediately: do NOT read or print out lists of passing test names.
  - If a test fails, parse and inspect ONLY the specific failure stack trace, expected vs received values, and error line numbers. Ignore all preceding passing output.

### Test Framework: Vitest 4

The project uses **Vitest 4** (`"vitest": "^4.1.10"`). Vitest 4 introduced breaking changes to mock behavior:

- `vi.clearAllMocks()`, `vi.resetAllMocks()`, and `vi.restoreAllMocks()` now also clear/reset/restore **module-level mocks** created via `vi.mock()`. In earlier versions only instance-level (`vi.spyOn`) mocks were affected.
- If `vi.mock()` factories return `vi.fn()` created inline (e.g. `() => ({ exec: vi.fn() })`), those instances are recreated on each reset, severing the reference stored in test-file variables like `const mockExec = exec`.
- The fix is `vi.hoisted()`: declare shared `vi.fn()` instances there, then reference them in both the factory and the test body. The `vi.hoisted()` callback runs before the hoisted `vi.mock()` factories, so the same instance is always used.
- When mocking a module whose functions are captured via `promisify()` (or any closure), the mock must use `vi.hoisted()` so the promisified wrapper always closes over the same `vi.fn()` instance, not a stale one from a previous factory run.
- Use `mfn.mockReset()` in `beforeEach` instead of `vi.clearAllMocks()` / `vi.resetAllMocks()` to avoid module-mock recreation.
- Read the Vitest 4 migration guide before writing or debugging tests: https://vitest.dev/guide/migration

## Naming Conventions

Always choose clear, unambiguous names. When something could be confused with another concept, add the disambiguating word rather than abbreviating. Examples:

- `isProdServer` (there is both a dev server and a prod server)
- `BASCIK_PROD_SERVER` (the env var mirrors the concept)
- Prefer the full word over a contraction when the shorter form is ambiguous in context

## TypeScript Type Checking

```sh
npx --prefix pkg tsc -p pkg/tsconfig.json --noEmit
```

`create/`, `docs/`, and `extensions/vscode-bascik/` have their own tsconfigs; check them when editing files in those packages:

```sh
npx --prefix create tsc -p create/tsconfig.json --noEmit
npx --prefix pkg tsc -p docs/tsconfig.json --noEmit
npx --prefix extensions/vscode-bascik tsc -p extensions/vscode-bascik/tsconfig.json --noEmit
```

(`docs/` does not have its own typescript package, so use `pkg`'s tsc for it.)

Fix all errors before finishing. Do not suppress errors with `// @ts-ignore` or `as any` when a proper type fix is straightforward.

## Docs Writing Guide

Favor the term vanilla HTML/JavaScript/CSS over plain HTML/JavaScript/CSS.

## Spelling and Quality Check Extensions

- This repository uses standard **American English** spelling rather than British English spelling (e.g., use `color`, `behavior`, `initialize`, `recognize`, `defense`, `gray`, `centered`, etc.).
- Maintain clean source code and documentation by running `codespell` to check for spelling errors.
- Web standards are checked using `webhint`.
- Recommended extensions are configured in `.vscode/extensions.json`. Install both `Codespell.ai` (`codespellai.codespellai-vscode`) and `webhint` (`webhint.vscode-webhint`) in VS Code for automated spelling and web quality checks.
- Code spelling, quality, and static analysis checks are integrated into the pre-push workspace checklist `.github/prompts/pre-push.prompt.md`. Running `yarn check:spelling` (`codespell`), `yarn check:standards` (`webhint`), and static analysis (Jelly and Semgrep if installed) via CLI is part of the required pre-push routine.