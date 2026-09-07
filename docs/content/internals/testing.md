# Testing Internals

Bascik has two separate test suites: **unit tests** (Vitest) that verify individual library modules, and **end-to-end tests** (Playwright) that build and browser-test the full transpilation pipeline against a fixture site.

## Exec Lifecycle Boundaries

`source-cycle.test.ts` uses injected clocks and promise gates to pin phase ordering, overlapping edits, retained changes, failure recovery, and nonblocking parallel work. `watch-source.integration.test.ts` exercises the source observer with the real cycle coordinator, including glob roots, output exclusion, and dependency routing. Compilation publication tests verify async-scoped reload buffering and disk-write joins.

The dedicated exec Playwright configurations use HTTP release gates rather than arbitrary delays to hold pre and parallel children. Real CLI build fixtures use temporary project directories and an event-driven artifact gate to prove that post sees compiled pages while parallel still runs. Both serial and worker builds must join parallel completion before success. Fixtures write generated artifacts only to `dist/`, and watch source inputs rather than generated files.

## Running Unit Tests

Commands can be run per-package or across the workspace from the repository root:

```sh
# Workspace-wide unit tests
yarn unit:all

# Package-specific unit tests (single run)
yarn pkg:unit       # @bascik/bascik
yarn create:unit    # create-bascik
yarn ext:unit       # bascik-vscode

# Interactive watch mode (pkg)
yarn pkg:test

# Single run with coverage
yarn pkg:coverage
yarn create:coverage
yarn ext:coverage
yarn coverage:all   # update coverage across all packages

# Benchmarks
yarn pkg:bench
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
```

This builds the fixture site (using the current `dist/`) and then runs Playwright against it. The first run requires the package to be built first:

```sh
yarn pkg:build && yarn pkg:e2e
```

To run a specific test file or use the Playwright UI:

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

The E2E suite supports four execution modes:

1. **Static production suite (`playwright.config.ts`)**: builds the fixture site with `bascik --build` and serves static files via `server.ts` on port 4200.
2. **HTTP/1.1 production server suite (`playwright.server.config.ts`)**: boots cleartext `bascik --server` over HTTP/1.1 on port 9443 to test `data-bascik-server` request-time script execution and cleartext server behavior.
3. **HTTP/2 production server suite (`playwright.server-http2.config.ts`)**: boots TLS-enabled `bascik --server` over HTTP/2 on port 9444 to test `data-bascik-server` request-time script execution and encrypted server behavior.
4. **Dev server watch suite (`playwright.dev.config.ts`)**: boots the live dev server on port 9443 (configured via `BASCIK_SERVER_PORT=9443`) to run the full test suite and live-reload watcher tests directly against the live dev server with SSE tracking and open-page priority re-transpilation.

Each configuration owns its mode-specific `testIgnore` list on the `default` project. Playwright project arrays replace matching top-level arrays rather than extending them, so splitting exclusions across both levels can silently run server-only tests in the wrong mode. For example, `server-scripts.test.ts` and `server-scripts-stream.test.ts` run under dev, HTTP/1.1, and HTTP/2 configs, and are ignored under the static config because the static file server cannot execute server scripts. A unit regression test imports all four configs and pins their project exclusions before any browser starts.

Tests navigate to pages on the active server and assert against the live browser DOM.

## Fixture Design

`minify.identifiers` is kept at `false` in the fixture config so Playwright selectors can use readable scoped names like `bascik__my-comp__btn`. The site URL is supplied per run through the `BASCIK_SITE_URL` environment variable in each Playwright `webServer` command, and the production server port is set via a `server` mode override:

```ts
// pkg/e2e/bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  pipeline: { workers: true },
  minify: { identifiers: false },
});

export const server = defineConfig({
  http: { port: 9443 },
});
```

Each fixture page renders two or more instances of the component under test so isolation can be verified, changes to instance A must not affect instance B.

### Testing philosophy: scoping engine verification

Use locator strategy based on test intent:

- **Behavior-oriented E2E tests:** Prefer resilient user-facing locators like `page.getByRole(...)`, `page.getByLabel(...)`, and explicit `page.getByTestId(...)`, so assertions survive identifier minification and style refactors.
- **Compiler-output verification tests:** When the transformed selector or identifier is the behavior under test, deliberately assert transform-aware selectors (for example generated scoped class names or rewritten IDs).

This keeps ordinary feature tests robust while still verifying compiler transforms directly when required.

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

> **Rebuild before testing.** Playwright tests run against `e2e/dist/`, which is built from the current `pkg/dist/`. If you change `pkg/src/`, run `yarn build` before `yarn e2e` so the fixture picks up the latest transpiler.

## Test Configuration

Vitest is configured in `pkg/vite.config.js`:

```js
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.js"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
```

Coverage is collected via V8 and written to `pkg/coverage/`. The CI script uses `text-summary` only. The full HTML report at `coverage/index.html` is useful locally.

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

## Benchmarks

### Verified Runtime Profiling

The bounded profiling runner is separate from Vitest throughput benchmarks. Run it from the repository root with a new, empty, absolute private report directory. The path below is illustrative; choose a private directory outside the repository and any served, watched, or cleaned output tree.

```sh
yarn workspace @bascik/bascik profile:workload --report-dir /private/tmp/bascik-profile-run
```

The default matrix runs unprofiled controls, Clinic Doctor, top-level 0x, and Node CPU sampling across HTTP/1.1, HTTP/2 with TLS, static file serving, live development, serial builds, and worker builds. Use `--tools control,cpu`, `--scenarios http1,workers`, or `--rounds 20` to select a bounded subset. Rounds must be between 1 and 100. Every capture command has a two-minute deadline; failed commands, missing output, invalid response bytes, incomplete tasks, and missing required profiles invalidate the run. On POSIX systems, interruption sends termination to the command's process group, allows 500ms to exit, then force-kills surviving descendants and bounds reaping to one second. Cancellation stops the capture loop. This does not cover uncatchable parent termination or descendants that deliberately leave the process group. Existing report roots must belong to the current user and have mode `0700`; unsafe roots are rejected before report writes. There are no automatic retries.

The fixture uses seed 128, a deterministic 128 KiB ASCII asset without compressed sidecars, four client lanes, and paired asset/readiness requests. Separate cold-application-cache and warm-cache phases each perform 80 asset requests at the default round count. Identity and Brotli runs use fresh projects with identical asset bytes. Additional phases check API and complete streamed response bytes over HTTP/1.1 and HTTP/2. Static hosting checks file delivery, not API or stream execution. The dev capture checks assets, readiness, API responses, and one source edit reaching complete disk output; browser stream behavior remains covered by the dev E2E suite.

HTTP/1.1 and HTTP/2 also run a distinct-asset phase. Four lanes each request two assets and readiness concurrently, for eight distinct deterministic assets and up to twelve client requests in flight. A concurrent, byte-checked filesystem read loop in the subject measures competing libuv work, recording completed reads and mean/maximum latency. The manifest records the configured libuv pool size. This is a finite contention probe, not a native-thread CPU profile or a demonstrated global compression concurrency limit. Its timings include the probe's own overhead and do not establish a release budget.

Serial and worker builds each validate eight pages with 64 expanded components and one build-script result per page, before accepting cold/warm build timings. These are application and script-cache states, not proof of a physically cold disk. The runner does not evict OS caches, disable Bascik caches, force garbage collection, or establish release budgets. Until the separately owned validated release-baseline fixtures are available, this self-contained profiling fixture must not be cited as their replacement.

The manifest records Node/V8 and profiler versions, hardware, runtime and harness source hashes, fixture seed, fixture configuration, commands, working directories, task counts, response hashes, latency percentiles, process CPU time, memory, event-loop-delay samples, and artifact hashes. Profiler and target use the same stable project working directory. Reports remain in a private sibling directory, never in the fixture output or active docs tree. The old docs profiling wrappers have been removed because their reports could be cleaned by builds or publicly served.

Server startup records listening time separately from completion of observed startup codec jobs. Those jobs are joined before resetting steady-state counters, so late startup callbacks cannot appear as request compression time in an identity control. Dev-edit precompression is also accounted for separately from request phases. The load generator waits for acknowledgment of its complete result before disconnecting, including payloads larger than the IPC buffer.

Workload correctness requires status 200, the requested negotiated asset encoding, byte-identical decoded bodies, valid timings, and exactly one completion for every expected task. Identity fallback cannot satisfy a Brotli capture. Request-phase codec acceptance requires zero synchronous calls, no pending or active compression at completion, zero asynchronous calls for identity, and exactly one Brotli call per distinct asset across cold and warm requests. The original same-asset phases require one call total; the final distinct-asset phase raises the cumulative expected count to nine. The separate load-generator process removes inherited profiler flags and test-runner environment variables and uses empty Node execution arguments. CPU profiles must decode to a valid sampled tree. Doctor requires all three nonempty datasets and successful decoding through its renderer; 0x requires processed data and its rendered flamegraph. Failed or partial datasets are not successful captures.

Main-isolate CPU profiles include startup, so consult the separately recorded startup and workload phase timings before attributing a wide stack to request handling. Page workers and build-script children get separately labeled Node inspector profiles with process/thread IDs, task identities, and timestamps. Bench-only observers strip inherited parent profilers from these subjects to avoid mixed datasets and flush each page-worker task before forwarding its original completion. This adds instrumentation overhead. Node child coverage must match observed process identities. Worker task IDs and dispatch/completion timestamps are recorded independently by the main-thread observer. Each expected task requires a matching isolate profile within that time window, with CPU timestamps matching its metadata companion. Startup-only profiles cannot substitute for page work, and deleting both a task profile and its metadata still fails validation against the independent task ledger. Native helpers such as certificate generators are explicitly marked uncovered; no kernel or DTrace capture is implied. Do not add per-process CPU percentages into a wall-time percentage.

Interpret inclusive samples as ancestry and self samples as the sampled leaf. Cross-check ambiguous 0x native or bytecode labels with Node CPU sampling, useful-work counts, and measured codec calls. The same-asset workload can demonstrate asynchronous single-flight compression and warm-cache reuse, but does not establish a global concurrency bound for arbitrary distinct assets or attribute native libuv worker CPU. Historical synchronous-compression numbers without a decoded-body oracle are diagnostic evidence only, not a byte-validated before/after release comparison. Runtime changes require a retained causal regression test and the owning runtime prompt.

Performance benchmarks live in `pkg/bench/` and use Vitest's built-in `bench` API. They measure the transpilation pipeline on fixed, repeatable inputs:

```ts
import { bench, describe } from "vitest";
import { recursivelyTranspile } from "../src/lib/processing.ts";

describe("recursivelyTranspile", () => {
  bench("simple page - one component", () => {
    recursivelyTranspile(simpleHtml, componentList);
  });

  bench("complex page - nested components", () => {
    recursivelyTranspile(complexHtml, componentList);
  });
});
```

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
- `yarn e2e:all`: runs Playwright E2E suites across the workspace
- `yarn coverage:all`: generates and updates coverage reports across all packages
- `yarn test:all`: runs typechecks, spelling/standards checks, unit tests, and E2E suites in sequence (coverage excluded)

## Contributing a Fix

1. Fork the repository and create a branch.
2. Make your changes in `pkg/src/`.
3. Add or update tests in the paired `*.test.ts` file.
4. Run `yarn pkg:unit` and ensure all tests pass.
5. Run `yarn pkg:typecheck` to confirm there are no TypeScript errors.
6. Open a pull request against `main`.
