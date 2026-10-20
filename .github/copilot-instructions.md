# Bascik: Copilot Instructions

Repository-wide instructions are labeled accordingly.

**Docs work:** the rules for creating or editing anything under `/docs/` live in `.github/instructions/docs.instructions.md` (scoped with `applyTo: "docs/**"`). Read that file before touching docs pages, `docs/content/*.md`, the public agent skills in `skills/`, or any docs image or diagram.

## Keeping the Changelog Up to Date

`CHANGELOG.md` is not actively maintained during pre-1.0 development: the 1.0.0 release entry will be written as a high-level announcement. **Once 1.0.0 ships**, resume normal changelog discipline: add an entry to `[Unreleased]` whenever you add a feature, fix a bug, or make any user-visible change to `pkg/src/`. One bullet per change, grouped under `### Added`, `### Fixed`, or `### Changed`.

## Keeping the Compatibility Doc Up to Date

`docs/content/compatibility.md` tracks which CSS and JavaScript patterns Bascik's scoping engine handles. **Whenever a CSS or JS scoping capability is added, changed, or fixed**, update the relevant table row (or add a new one) in that file before finishing the task.

- New capability: add a row with ✅ and a concise Notes entry.
- Fixed or improved: update the Status and/or Notes of the existing row.
- Intentionally unsupported: add a row with 🚫 and an explanation.
- If the change affects a rule summarized in `skills/bascik-compatibility/SKILL.md` (its list of surprises and its lint rule table), update the skill too. A new rule in `compatibility-rules.json` must get a row in the skill's lint rule table; `docs/scripts/skill-compat-monorepo.test.ts` fails otherwise. The skill's `lookup.mjs` parses the built `/compatibility` page, and `docs/e2e/skill-compat-lookup.spec.ts` fails if the page's table markup changes in a way the script cannot read.

After editing `compatibility.md`, do not run `#pre-push.prompt.md` or pre-push scripts automatically. The user handles running pre-push steps.

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

## Keeping Docs Visuals in Sync

Docs visuals have three kinds, each with one home. Do not add a second mechanism for the same job.

- **Recordings** (real editor, browser, or terminal) are WebP or animated WebP produced by the single script `docs/scripts/capture-demos.ts`, and shown as Markdown images. Run from `docs/`: `node scripts/capture-demos.ts <scene>`. Use Node 24 (`~/.nvm/versions/node/v24.17.0/bin`). Images are only for things that must be a picture of a real program.
- **Diagrams** (flows, file trees, "you write / Bascik emits" comparisons) are the `diagram-*` Bascik components placed in the page shell. Their code lives in `<!-- demo:id -->` blocks in `docs/src/diagrams/<page>.md`, not in `docs/content/`.
- **Live examples** that must run in the page are `<component-demo>` blocks.

**Whenever you change behavior or wording that a diagram or recording restates**, update it in the same task: the diagram's props or its demo blocks in `docs/src/diagrams/`, or re-render the recording scene. A diagram that disagrees with the prose is worse than none. Examples: exec phases, stream ordering, preserve reference rules, scoped output names, the `Allow` header in the API routes recording. Full rules, including where a diagram goes in a shell, are in `.github/instructions/docs.instructions.md` under "Visuals".

## Tests and Coverage

**When adding, removing, or significantly changing tests in `pkg/src/` or `pkg/e2e/`:**

- The testing docs (`docs/content/internals/testing.md`) describe the test approach, not an enumerated list of files. The "Test Files" section links to GitHub which is always current. You only need to update the prose if the testing _patterns_ change (e.g. a new mock strategy, a new test runner, new helpers, or a new E2E server mode).
- `pkg/` has two Vitest projects configured in `pkg/vite.config.js`: `unit` (fast, excludes `*.integration.test.ts`) and `integration` (only `*.integration.test.ts`). Integration tests spawn real processes, servers, and worker threads, so they run in their own project, their own command (`yarn pkg:integration`), and their own CI job. Run `yarn integration:all` (currently `pkg` only) when a change touches a real process, server, or worker boundary.
- E2E tests support four Bascik server modes: static production (`playwright.config.ts`), HTTP/1.1 production server (`playwright.server.config.ts`), HTTP/2 production server (`playwright.server-http2.config.ts` via `yarn pkg:e2e:prod`), and live dev server (`playwright.dev.config.ts` via `yarn pkg:e2e:dev`). Two additional `pkg` lanes cover exec lifecycle ownership: `playwright.dev-exec.config.ts` plus `playwright.dev-exec-gated.config.ts` (via `yarn pkg:e2e:dev:exec`) and `playwright.exec-build.config.ts`. `playwright.exec-policy.config.ts` (via `yarn pkg:e2e:exec:policy`) covers `pipeline.onExecError` by spawning the CLI in temporary projects. The Cloudflare adapter lane lives in the `@bascik/adapter-cloudflare` workspace (`yarn adapter:cf:e2e`), not in `pkg/e2e/`.
- The coverage numbers shown on the testing page are read from `pkg/test-coverage.json` (unit tests) and `pkg/e2e-test-coverage.json` (E2E build-step coverage) at docs build time. `pkg/test-coverage.json` is generated from the `unit` project only, so it must never include integration coverage. Do not run `#pre-push.prompt.md` or pre-push scripts automatically after adding tests. The user handles running pre-push steps.

**The VS Code extension is a thin client of `@bascik/language-server`** (`extensions/vscode-bascik/build.mjs` bundles the server from `lsp/src` into the VSIX). Every diagnostic, completion, hover, and definition is implemented once, in `lsp/src/`; never add analysis code to the extension. When you change `lsp/src/server.ts` (project discovery, file watching, workspace folders, publishing), also run `yarn ext:unit` (starts the real server bundle) and `yarn ext:e2e` (real VS Code); fakes do not reproduce editor timing. See the `bascik-vscode-extension` skill.

**When changing server components in `pkg/src/lib/` (or adding to the live-reload / SSE / watch / request script systems):**
Update `docs/content/internals/server.md` to reflect the change. This page is the source of truth for how the server architecture works across dev and production modes.

**General principle:** the files that must stay in sync are `llms.txt`, the public agent skills in `skills/`, the relevant `docs/content/internals/*.md`, and the coverage JSON files. The copilot-instructions file is the enforcement mechanism: add notes here when a new sync relationship is created.

### Coverage JSON Files

Five coverage files feed the testing page (`docs/src/pages/internals/testing.html`), each read at docs build time:

| File                                          | Generated by                                  |
| --------------------------------------------- | --------------------------------------------- |
| `pkg/test-coverage.json`                      | `yarn pkg:coverage` (unit project only)       |
| `pkg/e2e-test-coverage.json`                  | `yarn pkg:coverage` (E2E build-step coverage) |
| `create/test-coverage.json`                   | `yarn create:coverage`                        |
| `extensions/vscode-bascik/test-coverage.json` | `yarn ext:coverage`                           |
| `adapters/cloudflare/test-coverage.json`      | `yarn adapter:cf:coverage`                    |
| `lsp/test-coverage.json`                      | `yarn lsp:coverage`                           |

`yarn coverage:all` regenerates all seven. `pkg/test-coverage.json` is generated from the `unit` project only, so it must never include integration coverage.

### Public Agent Skills (`skills/`)

The repo-root `skills/` folder is the source of truth for the user-facing agent skills (`bascik`, `bascik-components`, `bascik-compatibility`, `bascik-scripts`, `bascik-seo`, `bascik-config`, `bascik-testing`, `bascik-migrate`) and their `scripts/`. Skills hold rules and route to docs pages; they hold no reference copies of the docs. Example code lives once, in the repo-root `examples/` folder, rendered on `/example-components/*` docs pages and published as `/assets/examples.json` for `skills/bascik/scripts/add-example.mjs` (see `.github/instructions/docs.instructions.md`, "Examples"). It is distributed these ways: `npx skills add bascikdev/bascik` (reads GitHub), `npx skills add https://bascik.dev` (reads `/.well-known/agent-skills/index.json`), `https://bascik.dev/assets/skills.tar.gz` and `https://bascik.dev/assets/SKILL.md` (all three published by `docs/scripts/publish-agent-skill.ts`), and the `create-bascik` scaffold.

- `create/assets/skills/` is a byte-identical copy enforced by `create/src/skill-sync.test.ts`. After editing `skills/`, run `yarn create:prepack` in the same task or `yarn unit:all` fails.
- `pkg/src/lib/agent-skill-config-defaults.test.ts` checks the defaults table in `skills/bascik-config/scripts/audit-config.mjs` against `pkg/src/lib/config.ts`. When a config default changes, update that table.
- When a `pkg/src/` change alters user-facing behavior that a skill describes, update the skill in the same task. Authoring rules are in `.github/instructions/docs.instructions.md` under "Updating the Agent Skills".

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
   - Identifier minification in production (`bascik --build` with `minify.identifiers: true`) hashes and compresses scoped element IDs and class names. Split assertions by intent:
     - **Compiler tests (`pkg/e2e/`)** deliberately target the exact scoped output (for example `.bascik__scope-test__wrapper` or `[id$="__btn"]`) to prove the scoping and transpilation engine actually rewrote the markup. Do not replace these with `data-testid`, which would bypass the behavior under test. The `pkg/e2e` fixture keeps `minify.identifiers: false` so these names stay readable.
     - **Application and site tests (`docs/e2e/`, `create/`, `extensions/`)** must use explicit `data-testid` attributes located with Playwright's native `page.getByTestId(...)` API, because production builds hash raw classes and IDs.
   - Never use fragile relative DOM traversal (`.nth(N)` or `.locator('../..')`) to reach a target element.

4. **Resilience & Fault Tolerance by Design:**
   - Test recovery from invalid user input, syntax errors, rapid file edits, and unexpected client disconnects (`ECONNRESET`, `EPIPE`, `ERR_HTTP2_STREAM_CANCEL`). The watcher and server must stay alive and recover automatically.
   - Unit tests must be strictly isolated: never mutate package source directories or leave un-gitignored files on disk (`bascik.config.js`, `pages/index.html`). Run filesystem tests in isolated temp directories or mock system calls cleanly.

## License Source of Truth

All first-party Bascik packages are licensed under MIT. The root `LICENSE` is the source of truth for `@bascik/bascik` and `@bascik/adapter-cloudflare`; their committed package `LICENSE` files are copies for npm tarballs. `create-bascik`, `@bascik/language-server`, and the VS Code extension keep their own committed MIT `LICENSE` files.

- `docs/content/license.md`: the web-formatted MIT license rendered at `https://bascik.dev/license`
- `LICENSE` (repo root): plain-text MIT license; **required** for GitHub license detection and as the `prepack` source
- `pkg/LICENSE` and `adapters/cloudflare/LICENSE`: copies for npm tarballs; synced automatically on publish via the `prepack` script in each `package.json`

**When updating the license terms:**

1. Update the root `LICENSE` and mirror the terms in `docs/content/license.md`
2. Run `cp LICENSE pkg/LICENSE && cp LICENSE adapters/cloudflare/LICENSE` to sync the package copies immediately

Do **not** delete the root `LICENSE`: GitHub reads it for repo-level license detection. Do not edit `pkg/LICENSE` or `adapters/cloudflare/LICENSE` directly; they are derived files.

## Node 24: Native TypeScript Support

This project runs on **Node 24**. Node natively strips TypeScript types, with no transpiler or extra flags needed for erasable syntax.

- `node example.ts` works directly (Node 22.18+ with only erasable syntax, no flags required).
- Erasable syntax: type annotations, interfaces, type aliases, `import type`. These are stripped at runtime.
- Non-erasable syntax (`enum`, parameter properties, namespaces with runtime code) is **not** supported: a separate transpile step is required for those.
- Node does **not** type-check. Run `npx tsc --noEmit` separately for type checking.
- No `tsconfig.json` is needed for Node to run `.ts` files.

**Practical implication:** `data-bascik-build` and `data-bascik-server` scripts can import `.ts` helper files and Node handles them natively. Bascik does not need to add its own type-stripping layer for server-side or build-time scripts.

## Agent Environment Notes

### Finding Code in pkg

When locating behavior or tracing dependencies in `pkg/`, use the `bascik-code-navigation` skill before repeated broad searches. `yarn pkg:build` refreshes a gitignored module map in the background at `.code-map/pkg.json`. Run `yarn pkg:map` to refresh it synchronously when missing or after imports change; run `yarn pkg:map <path-fragment>` to print matching modules with their imports and importers. The map includes source tests, not function calls or runtime worker/script connections. Use it to choose nearby implementation and tests, then read those files.

### Customization Surface

This repo ships its own agent customizations. Know which is which before editing:

- `.github/copilot-instructions.md` (this file): repo-wide rules, always loaded.
- `.github/skills/<name>/SKILL.md`: 12 project skills (Bascik-specific domain knowledge such as `bascik-css-scoping`, `bascik-server-architecture`, `bascik-playwright-e2e`). These are authored in-repo and safe to edit.
- `.github/agents/*.agent.md`: 8 agent definitions (developer, docs, planner, PR reviewer, pre-push, profiler, regression, supervisor).
- `.agents/skills/<name>/SKILL.md`: 3 externally sourced skills (`playwright-cli`, `specmap`, `vitest`) tracked by `skills-lock.json` with a `computedHash`. Do not hand-edit these; the lock file records their upstream source and hash.
- `skills/<name>/SKILL.md`: 8 public, user-facing skills for people building with Bascik (not for working on this repo). See "Public Agent Skills" above.
- Contributor skills in `.github/skills/` carry `metadata: internal: true` so `npx skills add bascikdev/bascik` does not offer them. Keep that on any new contributor skill.
- `create/` copies the public skills into a new project at `.agents/skills/` and `.claude/skills/`.

When a skill's guidance conflicts with this file, this file wins. When you change a skill, check whether the corresponding `docs/content/*.md` page needs the same change.

### Use Root Scripts or `yarn workspace <pkg> <script>`

Commands can be run directly from the root using helper scripts (`yarn test:all`, `yarn unit:all`, `yarn typecheck:all`, `yarn pkg:build`, `yarn docs:dev`, etc.) or using `yarn workspace <pkg> <script>`.

The repo uses **Modern Yarn 4** (`yarn@4.18.0`) with `nodeLinker: node-modules`. Ctrl+C on interactive watch mode commands exits cleanly with code 0/130 and zero `ELIFECYCLE` error messages.

The root `package.json` is private and defines **no bare `test`, `dev`, or `build` scripts**. Always use a namespaced root script or `yarn workspace <pkg> <script>`:

```sh
yarn pkg:test        # vitest watch mode (@bascik/bascik)
yarn pkg:unit:watch  # unit project watch mode
yarn docs:dev        # docs dev server (bascik-docs)
```

Root script prefixes map to workspaces:

| Prefix        | Workspace                    |
| ------------- | ---------------------------- |
| `pkg:`        | `@bascik/bascik`             |
| `create:`     | `create-bascik`              |
| `docs:`       | `bascik-docs`                |
| `ext:`        | `bascik-vscode`              |
| `adapter:cf:` | `@bascik/adapter-cloudflare` |

Aggregators (`unit:all`, `integration:all`, `e2e:all`, `coverage:all`, `typecheck:all`, `check:all`, `test:all`) fan out across all workspaces.

### Formatting (Prettier)

The repo is formatted with Prettier, using its default options (no config file). `yarn format` rewrites every file, `yarn check:format` fails on any unformatted file, and CI runs the check. `.prettierignore` lists the files Prettier must not touch (hash-locked external skills and fixtures Prettier's HTML parser rejects). The root `.vscode/settings.json` formats on save with the Prettier extension (`esbenp.prettier-vscode`), so VS Code may apply formatting shortly after an agent edits or creates a file.

Users format their components with Prettier too, so **Bascik must accept anything Prettier writes**: attributes wrapped one per line, `>` moved onto the next line, `<docs-logo\n/>`, lowercase `<!doctype html>`, `<br />`, double quotes, and selectors split across lines. When Prettier output breaks a build or changes rendered output, fix Bascik, not the formatting. A test that compares source text must not depend on quote style, line wrapping, or doctype case; read the expected value from the fixture or match with a pattern.

- Treat formatter output in files intentionally touched for the current task as part of that task. Do not repeatedly restore those files to the agent's preformatted layout.
- Before final validation, run `npx prettier --write <touched files>` (or `yarn format`), then `yarn check:format`.
- A Markdown code sample that is not valid in its fence language (Svelte or JSX in an `html` fence, front matter after a comment in an `md` fence) gets `<!-- prettier-ignore -->` on the line above the fence, or Prettier rewrites it.
- Inspect `git diff` after formatting. Confirm that formatter changes are mechanical, preserve the intended behavior, and do not include unrelated files.
- Run the task's focused validation after formatting, so tests and typechecks exercise the exact bytes that will be committed.
- Immediately before committing, run `git status --short` and `git diff --check` again. Do not commit until the touched-file diff remains stable after formatting and validation.
- Immediately after committing, run `git status --short`. If a delayed formatter write changed a file from that completed task, inspect it and include the mechanical formatting in that same task before starting the next prompt. Never let known formatter residue drift into a later task's commit.

### VS Code Sandbox and Command Permissions

The agent can run all project commands, including commands that bind to ports or make outbound connections, such as Playwright E2E tests, `yarn docs:dev`, and `curl`.

If one of these commands hangs or cannot access the required resource, the command may be running with sandbox restrictions instead of full permissions. Stop the command and ask the user for permission to rerun it with the required access. Do not retry the same command or minor variations inside the sandbox.

### Token-Efficient Test Execution & Output Parsing

- **Unit tests, typechecks, checks, E2E, and Lighthouse**: To run all tests across all monorepo packages (`pkg`, `docs`, `create`, `extensions/vscode-bascik`, `adapters/cloudflare`), use `yarn test:all`. For unit tests only, use `yarn unit:all`. For the long-running integration suite, use `yarn integration:all` (currently `pkg` only).
- **E2E tests**: Playwright E2E tests are configured in package scripts (`yarn pkg:e2e`, `yarn pkg:e2e:dev`, `yarn pkg:e2e:prod`, `yarn adapter:cf:e2e`, `yarn e2e:all`) with `--reporter=line` output to preserve context tokens. `yarn e2e:all` includes static build, live dev server, production HTTP/1.1, production HTTP/2, docs, and Cloudflare adapter configurations.
- **Efficient output parsing**:
  - Always check the overall status first: **Did it pass or fail?**
  - If all tests pass, stop immediately: do NOT read or print out lists of passing test names.
  - If a test fails, parse and inspect ONLY the specific failure stack trace, expected vs received values, and error line numbers. Ignore all preceding passing output.

### Repeatable Benchmarking & Compiler Comparisons (`pkg/bench/`)

When optimizing the compiler or measuring before-and-after speed differences, use the harness in `pkg/bench/` (documented publicly at `docs/content/internals/benchmarking.md` and internally at `pkg/bench/README.md`):

- **Never use `git stash` to compare against a baseline.** Build an immutable baseline compiler snapshot in a detached `git worktree` under a mode-`0700` `/private/tmp` directory, then remove the worktree.
- **Same-path paired builds are required for HTML byte parity:** `deriveInstanceId` hashes absolute source paths, so comparing two separate fixture directories changes instance IDs. Use `yarn workspace @bascik/bascik profile:compare` to alternate `baseline` and `candidate` compilers on the **same** private fixture path while verifying `byteIdentical: true` across all emitted HTML files.
- **Standard three-tier benchmark matrix:**
  1. **Dedicated pipeline fixture (`--fixture pipeline`):** `yarn workspace @bascik/bascik profile:compare --fixture pipeline --baseline <baseline>/pkg --candidate <candidate>/pkg --mode build --rounds 5 --site-url https://example.com --report-dir "$REPORT_DIR"`. Generates a 25-page, 10-component, 1,000-instance site exercising IDs, element/`#id` CSS rules, `aria-*`/`href="#..."` references, `data-bascik-attr-*`/`data-bascik-prop-*` bindings, and external package build scripts (`marked`).
  2. **Starter site (`create-bascik`):** Scaffold into `/private/tmp` with `node create/dist/index.js starter-site -y --no-install --no-dev`, link workspace `node_modules` entries (keeping `.cache` private and `@bascik/bascik` as a symlink), and run `profile:compare --project <starter-site> --rounds 5`.
  3. **Full `docs` site (build and live dev edits):** Run `yarn workspace @bascik/bascik profile:compiler --tools control --modes dev --edits --seed-cache --rounds 3 --compiler <compiler>/pkg --report-dir "$REPORT_DIR"` for dev live-edit latency (`diskMs`), or `profile:compare` on a private `docs` copy for cold/warm multi-worker builds.
- **Microbenchmarks:** Run `yarn pkg:bench` (`pkg/bench/transpile.bench.ts`) for isolated throughput benchmarks, or import baseline and candidate `dist/lib/*.js` modules into a single Node process for direct interleaved function comparisons.
- **Differential and profile inspection tools:** Use `yarn workspace @bascik/bascik profile:fuzz --baseline <built-pkg>` for seeded, shrinking baseline-versus-candidate checks, and `profile:summary <capture.cpuprofile>` for read-only CPU self/inclusive and hot-line summaries. Keep their options and limitations in `pkg/bench/README.md` rather than duplicating them here.
- **Clean up private directories:** Always remove temporary `/private/tmp` benchmark roots and detached worktrees once measurements are recorded.

### Test Framework: Vitest 5

The project uses **Vitest 5** (`"vitest": "^5.0.3"`). Behavior that affects how tests are written here:

- `clearMocks` defaults to `true`: call history is cleared before every test (implementations are kept). Never assert on calls recorded in a `beforeAll`, a setup file, or at module top level.
- `vi.mock()`, `vi.unmock()`, and `vi.hoisted()` must be at module top level; nested calls throw. Use `vi.doMock()` when a mock must be registered inside a test.
- Unawaited `.resolves` / `.rejects` assertions fail the test. Always `await` them.
- `-t` matches the `>`-joined full name (`-t 'suite > test'`), not a space-joined one.
- Inline projects inherit the root config (arrays merge). `pkg/vite.config.js` excludes `bench/**` from the `integration` project's benchmarks for this reason.
- `vite` is a peer of `vitest` and Yarn does not install peers, so every workspace that runs Vitest lists `vite` in `devDependencies`.
- Benchmarks use the `bench` test-context fixture: `test("name", async ({ bench }) => { await bench.compare(bench("a", fn), bench("b", fn)); })`. The top-level `bench()` import is gone.

These mock rules (from Vitest 4) still apply:

- `vi.clearAllMocks()`, `vi.resetAllMocks()`, and `vi.restoreAllMocks()` also clear/reset/restore **module-level mocks** created via `vi.mock()`.
- If `vi.mock()` factories return `vi.fn()` created inline (e.g. `() => ({ exec: vi.fn() })`), those instances are recreated on each reset, severing the reference stored in test-file variables like `const mockExec = exec`.
- The fix is `vi.hoisted()`: declare shared `vi.fn()` instances there, then reference them in both the factory and the test body. The `vi.hoisted()` callback runs before the hoisted `vi.mock()` factories, so the same instance is always used.
- When mocking a module whose functions are captured via `promisify()` (or any closure), the mock must use `vi.hoisted()` so the promisified wrapper always closes over the same `vi.fn()` instance, not a stale one from a previous factory run.
- Use `mfn.mockReset()` in `beforeEach` instead of `vi.clearAllMocks()` / `vi.resetAllMocks()` to avoid module-mock recreation.
- Read the Vitest 5 migration guide before writing or debugging tests: https://vitest.dev/guide/migration

## Naming Conventions

Always choose clear, unambiguous names. When something could be confused with another concept, add the disambiguating word rather than abbreviating. Examples:

- `isProdServer` (there is both a dev server and a prod server)
- `BASCIK_PROD_SERVER` (the env var mirrors the concept)
- Prefer the full word over a contraction when the shorter form is ambiguous in context

## TypeScript Type Checking

```sh
npx --prefix pkg tsc -p pkg/tsconfig.json --noEmit
```

`create/`, `docs/`, `extensions/vscode-bascik/`, and `adapters/cloudflare/` have their own tsconfigs; check them when editing files in those packages:

```sh
npx --prefix create tsc -p create/tsconfig.json --noEmit
npx --prefix pkg tsc -p docs/tsconfig.json --noEmit
npx --prefix extensions/vscode-bascik tsc -p extensions/vscode-bascik/tsconfig.json --noEmit
npx --prefix adapters/cloudflare tsc -p adapters/cloudflare/tsconfig.json --noEmit
```

(`docs/` does not have its own typescript package, so use `pkg`'s tsc for it.)

Fix all errors before finishing. Do not suppress errors with `// @ts-ignore` or `as any` when a proper type fix is straightforward.

## Spelling and Quality Check Extensions

- This repository uses standard **American English** spelling rather than British English spelling (e.g., use `color`, `behavior`, `initialize`, `recognize`, `defense`, `gray`, `centered`, etc.).
- Maintain clean source code and documentation by running `codespell` to check for spelling errors.
- Web standards are checked using `webhint`.
- Recommended extensions are configured in `.vscode/extensions.json`. Install both `Codespell.ai` (`codespellai.codespellai-vscode`) and `webhint` (`webhint.vscode-webhint`) in VS Code for automated spelling and web quality checks.
- Code spelling, quality, and static analysis checks are integrated into the pre-push workspace checklist `.github/prompts/pre-push.prompt.md`. Running `yarn check:spelling` (`codespell`), `yarn check:standards` (`webhint`), and static analysis (Jelly and Semgrep if installed) via CLI is part of the required pre-push routine.
- `yarn check:spelling` covers `pkg/src`, `docs/content`, `docs/src`, and `create/src` only. It does **not** scan `extensions/vscode-bascik/` or `adapters/cloudflare/`; run codespell directly on those paths if you edit them.
