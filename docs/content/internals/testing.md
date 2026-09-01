# Testing Internals

Bascik has two separate test suites: **unit tests** (Vitest) that verify individual library modules, and **end-to-end tests** (Playwright) that build and browser-test the full transpilation pipeline against a fixture site.

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
4. **Dev server watch suite (`playwright.dev.config.ts`)**: boots `bascik --dev` on port 8080 to run the full test suite and live-reload watcher tests directly against the live dev server with SSE tracking and open-page priority re-transpilation.

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

In standard web application testing, best practices dictate using explicit `data-testid` attributes to decouple Playwright tests from visual styling or class name changes.

In Bascik's compiler test suite, however, the primary objective is to verify that the transpilation and scoping engine transforms HTML, CSS, and JavaScript correctly. As a result, E2E tests deliberately target generated scoped class names (such as `.bascik__my-comp__wrapper`) and rewritten element IDs (such as `[id$="__btn"]`). Using `data-testid` attributes in compiler tests would bypass assertions on class name scoping, attribute prefixing, and selector rewrites, leaving compiler regressions undetected.

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
    scopeScriptBlocks: true,
    scopeAttribute: { class: true, id: true, name: true },
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

* `yarn typecheck:all`: runs typechecks across all packages in the workspace
* `yarn check:all`: runs spelling (`check:spelling`) and web standards (`check:standards`)
* `yarn unit:all`: runs unit test suites across all packages
* `yarn e2e:all`: runs Playwright E2E suites across the workspace
* `yarn coverage:all`: generates and updates coverage reports across all packages
* `yarn test:all`: runs typechecks, spelling/standards checks, unit tests, and E2E suites in sequence (coverage excluded)

## Contributing a Fix

1. Fork the repository and create a branch.
2. Make your changes in `pkg/src/`.
3. Add or update tests in the paired `*.test.ts` file.
4. Run `yarn pkg:unit` and ensure all tests pass.
5. Run `yarn pkg:typecheck` to confirm there are no TypeScript errors.
6. Open a pull request against `main`.
