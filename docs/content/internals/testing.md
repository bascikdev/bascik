# Testing Internals

Bascik organizes verification across three distinct levels: **unit tests** that verify isolated functions and modules, **integration tests** that exercise real process boundaries, compilers, and cross-subsystem compositions, and **end-to-end tests** (Playwright) that build and browser-test the full transpilation pipeline against a live server.

## Testing Levels and Architecture

The codebase distinguishes test runners from testing levels:

- **Unit tests (Vitest):** Run with `yarn unit:all` or per-workspace commands. Verify isolated functions, AST manipulation, and CSS scoping transforms using deterministic inputs and minimal mocks where isolation is required.
- **Integration tests (Vitest):** Run separately with `yarn integration:all` or per-package `integration` commands. Rather than isolating units, these exercise real subsystems collaborating across real boundaries. Key examples include real CLI child-process builds (`worker-serial-parity.integration.test.ts`), real worker thread lifecycles (`worker-pool.real.integration.test.ts`), real dev server module invalidation (`dev-module-reload.integration.test.ts`), real project scaffolding to compiler execution (`scaffold.integration.test.ts`), and serverless runtime parity (`serverless-parity.integration.test.ts`).
- **End-to-end tests (Playwright):** Run via `yarn pkg:e2e`, `yarn pkg:e2e:dev`, or `yarn pkg:e2e:prod`. These boot actual servers (static file server, live dev server with SSE, HTTP/1.1 cleartext, or HTTP/2 TLS production server) and navigate headless browsers to verify real DOM rendering, script execution, and user interaction.

### The Real versus Mocked Boundary Rule

Integration tests in Bascik follow an explicit boundary contract: they do not mock away the primary boundary being verified. When testing worker thread lifecycle, real Node.js `worker_threads` run. When testing targeted-build persistence, real child processes invoke `bascik --build` against isolated disk fixtures. When testing scaffold output, the real `scaffold()` creates directory structures and files, and the real compiler parses and builds them into emitted artifacts. Mocks are reserved for external environment control (such as clock injection or network limits) rather than internal subsystem borders.

## Running Unit Tests

Commands can be run per-package or across the workspace from the repository root:

```sh
# Workspace-wide unit tests
yarn unit:all

# Package-specific unit tests (single run)
yarn pkg:unit         # @bascik/bascik
yarn create:unit      # create-bascik
yarn ext:unit         # bascik-vscode
yarn adapter:cf:unit  # @bascik/adapter-cloudflare

# Interactive watch mode (pkg)
yarn pkg:unit:watch

# Single run with coverage
yarn pkg:coverage
yarn create:coverage
yarn ext:coverage
yarn adapter:cf:coverage
yarn coverage:all     # update coverage across all packages

# Benchmarks
yarn pkg:bench
```

## Running Integration Tests

Integration tests spawn real processes, servers, and worker threads and are
long-running, so they run in their own Vitest project and their own CI job,
separate from the fast unit suite.

```sh
# Workspace-wide integration tests
yarn integration:all

# Package-specific integration tests (single run)
yarn pkg:integration  # @bascik/bascik

# Interactive watch mode (pkg)
yarn pkg:integration:watch

# Run both unit and integration suites for the package
yarn pkg:test:all
```

## Running E2E Tests

End-to-end tests are run via:

```sh
# Static production server suite
yarn pkg:e2e

# Dev server suite (runs full E2E test suite + live-reload tests against bascik --dev)
yarn pkg:e2e:dev

# Production server suite (runs both HTTP/1.1 cleartext and HTTP/2 TLS server script tests against bascik --server)
yarn pkg:e2e:prod

# Or run HTTP/1.1 and HTTP/2 prod server suites individually:
yarn pkg:e2e:prod:http1
yarn pkg:e2e:prod:http2

# Cloudflare adapter suite in @bascik/adapter-cloudflare workspace (emitted Pages bundle in local workerd)
yarn adapter:cf:e2e
```

This builds the fixture site (using the current `dist/`) and then runs Playwright against it. The first run requires the package to be built first:

```sh
yarn pkg:build && yarn pkg:e2e
```

To run a specific test file or use the Playwright UI, run Playwright from `pkg/`:

```sh
# Run only CSS scoping tests against static server
npx playwright test --config e2e/playwright.config.ts e2e/tests/css-scoping.test.ts

# Run dev server live-reload tests against bascik --dev
npx playwright test --config e2e/playwright.dev.config.ts e2e/tests/dev-server-reload.test.ts

# Run HTTP/1.1 prod server tests against bascik --server
npx playwright test --config e2e/playwright.server.config.ts e2e/tests/prod-server.test.ts

# Run HTTP/2 prod server tests against bascik --server
npx playwright test --config e2e/playwright.server-http2.config.ts e2e/tests/prod-server.test.ts

# Open the Playwright UI for interactive debugging
npx playwright test --config e2e/playwright.config.ts --ui
```

## How the E2E Suite Works

The e2e fixture is a small but complete Bascik project at `pkg/e2e/`:

```text
pkg/e2e/
  bascik.config.ts                ← fixture config (minify.identifiers: false)
  playwright.config.ts            ← static build test runner
  playwright.server.config.ts      ← HTTP/1.1 cleartext prod server runner
  playwright.server-http2.config.ts← HTTP/2 TLS prod server runner
  playwright.dev.config.ts        ← dev server runner for live-reload and open-page priority
  server.ts                       ← minimal static HTTP server for dist/
  src/
    pages/                        ← one HTML page per feature under test
    components/                   ← components used by those pages
  tests/                          ← Playwright test files
```

The E2E suite supports four Bascik server modes plus three exec lanes and one adapter lane:

1. **Static production suite (`playwright.config.ts`)**: builds the fixture site with `bascik --build` and serves static files via `server.ts` on port 4200.
2. **HTTP/1.1 production server suite (`playwright.server.config.ts`)**: boots cleartext `bascik --server` over HTTP/1.1 on port 9443 to test `data-bascik-server` request-time script execution and cleartext server behavior.
3. **HTTP/2 production server suite (`playwright.server-http2.config.ts`)**: boots TLS-enabled `bascik --server` over HTTP/2 on port 9444 to test `data-bascik-server` request-time script execution and encrypted server behavior.
4. **Dev server watch suite (`playwright.dev.config.ts`)**: boots the live dev server on port 9443 (configured via `BASCIK_SERVER_PORT=9443`) to run the full test suite and live-reload watcher tests directly against the live dev server with SSE tracking and open-page priority re-transpilation.
5. **Exec lifecycle lanes (`playwright.dev-exec.config.ts`, `playwright.dev-exec-gated.config.ts`, `playwright.exec-build.config.ts`)**: run against a dedicated `e2e/exec-fixture/` project to prove exec producer/consumer lifecycle ownership. The dev lanes run via `yarn pkg:e2e:dev:exec`; the gated variant holds a `phase: 'parallel'` producer behind an HTTP gate to prove the dev server serves before the parallel entry finishes.
6. **Exec failure policy lane (`playwright.exec-policy.config.ts`)**: spawns the real CLI in temporary projects and checks `pipeline.onExecError`: exit codes, output, the build-error frame an open browser receives, and that a dev session survives a failing script and recovers on the next edit. It covers the dev default (`'warn'`), the build default (`'error'`), the option set explicitly, and the `dev` and `build` config exports. It runs via `yarn pkg:e2e:exec:policy` and is excluded from the four fixture-serving configs.
7. **Cloudflare adapter suite (`adapters/cloudflare/e2e/playwright.config.ts`)**: builds the small fixture with `--target cloudflare-pages` and serves the emitted `_worker.js` and public tree inside local workerd (Miniflare) with the asset layer in front, on port 9876. It covers static bypass, worker-side pages and APIs, and a stream paint-order test with JavaScript disabled. Request-level Node-versus-Worker parity is a Vitest integration test (`serverless-parity.integration.test.ts`), which runs one build under both `bascik --server` and workerd and compares them. This lane lives in the `@bascik/adapter-cloudflare` workspace (`yarn adapter:cf:e2e`), not in `pkg/e2e/`.

Each configuration owns its mode-specific `testIgnore` list on the `default` project. Playwright project arrays replace matching top-level arrays rather than extending them, so splitting exclusions across both levels can silently run server-only tests in the wrong mode. For example, `server-scripts.test.ts` and `server-scripts-stream.test.ts` run under dev, HTTP/1.1, and HTTP/2 configs, and are ignored under the static config because the static file server cannot execute server scripts. A unit regression test imports the four Bascik-server configs and pins their project exclusions before any browser starts; the Cloudflare config selects its single test file with `testMatch` and is excluded from the other four.

Tests navigate to pages on the active server and assert against the live browser DOM.

## Fixture Design

`minify.identifiers` is kept at `false` in the fixture config so Playwright selectors can use readable scoped names like `bascik__my-comp__btn`. The site URL is supplied per run through the `BASCIK_SITE_URL` environment variable in each Playwright `webServer` command, and the server port is set via a `server` mode override that each lane can change with `BASCIK_SERVER_PORT`. The fixture config also exercises other features (multiple component roots, exec scripts, custom minifiers), so this is an excerpt:

```ts
// pkg/e2e/bascik.config.ts (excerpt)
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  pipeline: { workers: true },
  minify: { identifiers: false },
});

export const server = defineConfig({
  http: { port: Number(process.env.BASCIK_SERVER_PORT) || 9443 },
});
```

Each fixture page renders two or more instances of the component under test so isolation can be verified, changes to instance A must not affect instance B.

### Testing philosophy: scoping engine verification

Use locator strategy based on test intent:

- **Behavior-oriented E2E tests:** Prefer resilient user-facing locators like `page.getByRole(...)`, `page.getByLabel(...)`, and explicit `page.getByTestId(...)`, so assertions survive identifier minification and style refactors.
- **Compiler-output verification tests:** When the transformed selector or identifier is the behavior under test, deliberately assert transform-aware selectors (for example generated scoped class names or rewritten IDs).

This keeps ordinary feature tests robust while still verifying compiler transforms directly when required.

### Repeated-instance scoping verification

The Vitest projects in `pkg/` and `docs/`, and every Playwright config, set `BASCIK_VERIFY_SCOPING_TEMPLATES=1`. With it, each scoping result reused for a repeated component instance is also recomputed by the full pipeline, and any difference throws. `scoping-parametricity.test.ts` checks the underlying property directly: on random components (fast-check) and on every component in `docs/` and `pkg/e2e/`, renaming one instance's generated names must give exactly the full pipeline's output for another instance ID, with and without identifier minification. Set `SCOPING_PROPERTY_RUNS` to raise the number of random cases for a deeper local run. `scoping-template.test.ts` pins the component fields and config the pipeline reads and writes with recording proxies, so a new input fails a test instead of being left out of the reuse key.

## E2E Test Files

Each test file is paired with a fixture page. See the full list on [GitHub](https://github.com/bascikdev/bascik/tree/main/pkg/e2e/tests).

## Writing a New E2E Test

1. **Add a fixture component** in `pkg/e2e/src/components/my-feature/` with an HTML file (and CSS/JS as needed).
2. **Add a fixture page** in `pkg/e2e/src/pages/my-feature-test.html` that renders two or more instances of the component.
3. **Add a test file** at `pkg/e2e/tests/my-feature.test.ts`.

A typical test file:

```ts
import { test, expect, type Locator } from '@playwright/test';

function getInstance(page, n: number): Locator {
  return page.locator('.bascik__my-feature__wrapper').nth(n);
}

test.describe('my-feature-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/my-feature-test');
  });

  test('instances are isolated', async ({ page }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);
    // assert that state in A does not affect B
  });
});
```

> **Rebuild before testing.** Playwright tests run against `e2e/dist/`, which is built from the current `pkg/dist/`. If you change `pkg/src/`, run `yarn pkg:build` before `yarn pkg:e2e` so the fixture picks up the latest transpiler.

## Test Configuration

Vitest is configured in `pkg/vite.config.js` with two projects: `unit` (fast, excludes `*.integration.test.ts`) and `integration` (only `*.integration.test.ts`):

```js
export default defineConfig({
  test: {
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
        },
      },
    ],
  },
});
```

Coverage is collected via V8 and written to `pkg/coverage/`. The CI unit script uses `text-summary` only. The full HTML report at `coverage/index.html` is useful locally.

## Unit Test Files

Each library module has a paired test file. See the full list on [GitHub](https://github.com/bascikdev/bascik/tree/main/pkg/src/lib).

## Writing Tests

Tests use the standard Vitest `describe` / `it` / `expect` API. Because library modules depend on `BascikConfig` (a module-level singleton), tests that need a specific configuration use `vi.mock` to stub it:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../config.ts", () => ({
  BascikConfig: {
    scoping: {
      scriptBlocks: true,
      attributes: { class: true, id: true, name: true },
    },
    isBuild: false,
    minify: { css: false, identifiers: false },
  },
}));

// Import the module under test AFTER mocking its dependencies
import { prefixElementAttribute } from "./javascript.js";

describe("prefixElementAttribute", () => {
  it("scopes class attributes in HTML", () => {
    const component = {
      name: "my-comp",
      fileContent: '<div class="btn">Click</div>',
    };
    const result = prefixElementAttribute(component, "class", "abc123");
    expect(result.fileContent).toContain("bascik__my-comp__btn");
  });
});
```

> **Important.** Always import the module under test *after* calling `vi.mock`. Vitest hoists mock calls to the top of the file, but the import order still matters for ensuring the mock is in place when the module initializes its dependencies.

## Boundary Test Patterns

### Real-Filesystem Watch Testing

In addition to mocked chokidar tests, watch mode includes real-filesystem tests in isolated temporary directories (`watch-fs.test.ts`). These verify real-world filesystem event sequences, atomic editor saves (temp file write followed by rename), stability thresholds (`awaitWriteFinish`), and debounce behavior without false-confidence gaps.

### Time-Boundary Testing Model

Bascik uses five test mechanics for time-sensitive behavior. This keeps framework timing deterministic in unit tests while preserving real runtime boundaries in integration tests:

1. **Framework internals with fake timers:** Modules that own semantic time accept `FrameworkClock` and are tested with Vitest fake timers (`vi.useFakeTimers()`).
2. **Static architectural enforcement:** `time-boundary.test.ts` prevents direct ambient timer usage in designated semantic-time modules.
3. **Cross-process E2E deadlines with real time:** Playwright runs Bascik in a separate process, so E2E timeout assertions use short real deadlines to verify `AbortSignal` propagation and HTTP timeout responses.
4. **Browser context timing with `page.clock`:** Browser-only scheduling behavior is tested with Playwright clock controls in the browser runtime.
5. **External watchdogs on wall clock:** Startup, sockets, and filesystem event flows use real time to match production boundaries.

For architecture ownership, cancellation rules, and timeout surfaces, see [Time Boundaries](/internals/time-boundaries).

### Exec Lifecycle

Exec scripts run in `pre`, `parallel`, and `post` phases around compilation. The tests pin that ordering with explicit gates rather than fixed delays:

- `source-cycle.test.ts` drives the source cycle with injected clocks and promise gates to verify phase ordering, overlapping edits, retained changes, failure recovery, and nonblocking `parallel` work.
- `watch-source.integration.test.ts` runs the source observer against the real cycle coordinator, covering glob roots, output exclusion, and dependency routing.
- Compilation publication tests verify that page reloads are buffered per async scope and that dev disk writes are joined before `post` runs.
- The exec Playwright lanes hold `pre` and `parallel` children behind HTTP release gates. Real CLI build fixtures run in temporary project directories and use an event-driven artifact gate to prove that `post` sees compiled pages while `parallel` is still running. Serial and worker builds both wait for `parallel` to finish before reporting success.
- Fixture scripts write generated artifacts only to `dist/`, and watchers observe source inputs, never generated files.

### Runtime Resource and Retention Tests

Some integration tests measure the runtime itself rather than a single feature:

- `module-retention.integration.test.ts` and its siblings check what stays in memory as request modules are edited and reloaded, using changing-source and stable-source controls and heap retainer paths. They pin the behavior described under [Module Lifetime](/internals/server#module-lifetime): clearing framework caches does not evict Node's ESM cache.
- `profile-resource-boundaries.integration.test.ts` verifies that timers, descriptors, streams, child processes, and worker transfers are released at each boundary, using explicit producer and consumer gates and event-loop checkpoints.
- `profile-workload.integration.test.ts` and `profile-fixture-tls.integration.test.ts` validate the profiling harness itself.

These tests run isolated native processes. A failing run keeps its private report directory and prints the path, and a passing run cleans up after itself.

## Benchmarks and Profiling

`yarn pkg:bench` runs Vitest throughput benchmarks from `pkg/bench/` on fixed, repeatable inputs. The same directory contains a bounded profiling harness for deeper investigation:

- `profile:workload` captures runtime behavior (HTTP/1.1, HTTP/2 with TLS, static serving, live development, serial and worker builds) with Clinic, 0x, or Node CPU sampling on a synthetic fixture.
- `profile:compiler` times complete dev and build runs of a real project, defaulting to the docs site.
- `profile:compare` alternates a baseline and a candidate compiler on the same fixture and stops if their emitted HTML differs, so a performance change can be checked for byte-identical output.

Each capture validates the work it measured (response bytes, task counts, decoded artifacts) and is rejected if anything is incomplete, so a run that merely exits successfully is not accepted. Captures write to a private report directory you choose. Commands, options, report directory rules, and known platform limitations are documented in the [benchmarks and profiling README](https://github.com/bascikdev/bascik/blob/main/pkg/bench/README.md).

## TypeScript Checking

Run type checking across all packages or for individual packages from the repository root:

```sh
# Type check all packages
yarn typecheck:all

# Package-specific type checks
yarn pkg:typecheck
yarn create:typecheck
yarn ext:typecheck
```

## Monorepo Aggregator Commands

The root `package.json` provides aggregated tasks across all projects:

- `yarn typecheck:all`: runs typechecks across all packages in the workspace
- `yarn check:all`: runs spelling (`check:spelling`) and web standards (`check:standards`)
- `yarn unit:all`: runs unit test suites across all packages
- `yarn integration:all`: runs the long-running integration test suite
- `yarn e2e:all`: runs Playwright E2E suites across the workspace
- `yarn coverage:all`: generates and updates coverage reports across all packages
- `yarn test:all`: runs typechecks, spelling/standards checks, unit tests, integration tests, and E2E suites in sequence (coverage excluded)

## Contributing a Fix

1. Fork the repository and create a branch.
2. Make your changes in `pkg/src/`.
3. Add or update tests in the paired `*.test.ts` file.
4. Run `yarn pkg:unit` and ensure all tests pass.
5. Run `yarn pkg:integration` if your change touches a real process, server, or worker boundary.
6. Run `yarn pkg:typecheck` to confirm there are no TypeScript errors.
7. Open a pull request against `main`.
