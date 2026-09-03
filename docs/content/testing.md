# Overview

Bascik supports automated testing and debugging across every layer of your application, from pure TypeScript utilities and component markup contracts to build-time scripts, request-time server scripts, browser component interactivity, and multi-environment end-to-end workflows.

Because Node 24 and Node 22.18+ natively execute TypeScript files by erasing type annotations, test runners and build scripts import `.ts` modules directly with zero compilation delay and zero build tooling overhead.

## Testing Architecture & Tiers

Testing a Bascik application is structured into six core tiers:

| Tier | Primary Tool | Key Responsibility | Execution Speed |
| --- | --- | --- | --- |
| **[Unit Testing](/testing/unit-testing)** | Vitest | Validates pure functions, calculations, algorithms, and data transformations. | Sub-second (~10ms) |
| **[Component Testing](/testing/component-testing)** | Vitest | Validates `.html` component contracts, slot placeholders, prop substitutions, and compiled `dist/` HTML output. | Sub-second (~100ms) |
| **[Build Scripts](/testing/build-scripts)** | Vitest | Validates compile-time `<script data-bascik-build>` logic, page-aware helpers, and data pipelines. | Sub-second (~30ms) |
| **[Server Scripts](/testing/server-scripts)** | Vitest | Validates request-time `<script data-bascik-server>` logic, database integrations, and dynamic routing. | Sub-second (~20ms) |
| **[Exec Scripts](/testing/exec-scripts)** | Vitest | Validates build configuration lifecycle scripts (XML sitemaps, search indexes, RSS feeds). | Sub-second (~20ms) |
| **[End-to-End Testing](/testing/e2e-testing)** | Playwright | Validates full browser interactions, DOM event handling, CSS `:has()` rules, and multi-page routing across static, dev, and production servers. | Seconds |

## Quick Start with `create-bascik`

Projects created with `npm create bascik@latest` include a pre-configured testing environment powered by Vitest, Playwright, V8 code coverage, and VS Code debug launchers.

Execute test suites directly from your project root:

```sh
# Run unit, component contract, and script tests
npm test

# Run tests in interactive watch mode
npm run test:watch

# Run tests with V8 code coverage summaries and HTML reports
npm run test:coverage

# Run Playwright end-to-end browser tests
npm run e2e
```

## Layer-by-Layer Testing Strategy

### 1. Unit Testing Pure Logic

Isolate core business logic, calculations, and data formatting in pure TypeScript modules (`src/lib/` or `src/utils/`). Testing pure functions directly eliminates test runner overhead and provides instant feedback during development.

```ts
// src/utils/pricing.test.ts
import { describe, it, expect } from 'vitest';
import { calculateTax } from './pricing.ts';

describe('calculateTax', () => {
  it('calculates state sales tax accurately', () => {
    expect(calculateTax(10000, 0.0825)).toBe(825);
  });
});
```

### 2. Component Contract & Output Testing

Component testing in Bascik operates in two distinct phases:

1. **Source Template Contracts**: Reads component `.html` files before compilation to verify mandatory accessibility roles (`role="alert"`), aria attributes, slot declarations (`data-bascik-slot`), and absence of disallowed inline runtime scripts.
2. **Compiled Output Verification**: Reads compiled HTML files in `dist/` to verify that custom component tags expanded completely, props were replaced, slots were populated, and internal compiler markers (`data-bascik-*`) were stripped.

```ts
// src/components/card/card.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Card component', () => {
  it('preserves slot structure in source template', async () => {
    const html = await readFile(join(process.cwd(), 'src/components/card/card.html'), 'utf8');
    expect(html).toContain('data-bascik-slot="header"');
    expect(html).toContain('data-bascik-slot="body"');
  });

  it('compiles without leftover compiler attributes in dist', async () => {
    const distHtml = await readFile(join(process.cwd(), 'dist/index.html'), 'utf8');
    expect(distHtml).not.toContain('<my-card');
    expect(distHtml).not.toContain('data-bascik-prop-');
    expect(distHtml).not.toContain('data-bascik-slot');
  });
});
```

### 3. Build-Time Scripts (`data-bascik-build`)

Build scripts run in Node.js during compilation to generate static HTML before pages are saved to `dist/`. Keep `<script data-bascik-build>` tags thin by importing pure helper functions from `src/lib/`.

This allows testing Markdown parsers, navigation generators, and page-aware helpers (which read `BASCIK_SOURCE_FILE`, `BASCIK_PAGE_FILE`, `BASCIK_PAGES_DIR`, and `BASCIK_SITE_URL`) by mocking environment variables in Vitest:

```ts
// src/lib/canonical.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCanonicalUrl } from './canonical.ts';

describe('getCanonicalUrl', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    process.env.BASCIK_PAGES_DIR = '/app/src/pages';
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('computes correct canonical tag from page file path', () => {
    process.env.BASCIK_SOURCE_FILE = '/app/src/pages/about.html';
    expect(getCanonicalUrl()).toBe('<link rel="canonical" href="https://example.com/about" />');
  });
});
```

### 4. Request-Time Server Scripts (`data-bascik-server`)

Server scripts execute dynamically on incoming HTTP/1.1 and HTTP/2 requests when running `bascik --server`. Isolate request processing, query parameter parsing, and backend database integrations in pure TypeScript services so they can be unit-tested without launching an active HTTP server:

```ts
// src/components/weather-widget/weather-service.test.ts
import { describe, it, expect } from 'vitest';
import { formatWeatherCard } from './weather-service.ts';

describe('formatWeatherCard', () => {
  it('renders dynamic weather HTML with temperature and conditions', () => {
    const html = formatWeatherCard({ city: 'Phoenix', temp: 88, condition: 'Sunny' });
    expect(html).toContain('<h4>Phoenix</h4>');
    expect(html).toContain('88°F');
  });
});
```

### 5. End-to-End Browser Testing (Playwright)

Playwright tests run against real browser engines (Chromium, Firefox, WebKit) across four server environments:

- **Static Production**: `bascik --build` served via static web server.
- **Dev Server**: `bascik --dev` testing live-reload and SSE connection stability.
- **HTTP/1.1 Production Server**: `bascik --server` testing cleartext request-time server scripts.
- **HTTP/2 Production Server**: `bascik --server` testing TLS-encrypted server scripts and multiplexed streaming.

Because production builds compress and minify class names and element IDs when `minify.identifiers: true`, always use explicit `data-testid` attributes and `page.getByTestId(...)` selectors in application E2E tests:

```ts
// e2e/theme-toggle.spec.ts
import { test, expect } from '@playwright/test';

test('theme toggle switches dark mode class on html root', async ({ page }) => {
  await page.goto('/');

  const toggle = page.getByTestId('theme-toggle');
  await toggle.click();

  await expect(page.locator('html')).toHaveClass(/dark-theme/);
});
```

## Testing & Tooling Guides

Explore specialized guides for each testing topic:

- **[Unit Testing](/testing/unit-testing)**: Configure Vitest, write pure business logic tests, and generate V8 coverage reports.
- **[Component Testing](/testing/component-testing)**: Validate source template accessibility contracts and verify compiled `dist/` HTML output.
- **[Build Scripts](/testing/build-scripts)**: Test compile-time `<script data-bascik-build>` build modules and page-aware environment helpers.
- **[Server Scripts](/testing/server-scripts)**: Test request-time `<script data-bascik-server>` handlers, query parsers, and API integrations.
- **[Exec Scripts](/testing/exec-scripts)**: Test build configuration lifecycle scripts (sitemaps, search indexes, RSS feeds) writing to `dist/`.
- **[End-to-End Testing](/testing/e2e-testing)**: Author Playwright suites across static, dev, HTTP/1.1, and HTTP/2 servers using `data-testid` strategies.
- **[Debugging & VS Code](/testing/debugging)**: Configure VS Code launch profiles for stepping through dev servers, unit tests, and browser components.
- **[Source Maps & Location Attribution](/testing/source-maps)**: Learn how Bascik uses `//# sourceURL` directives and remapped terminal stack traces.
- **[Linting & Web Standards](/testing/linting)**: Configure `.hintrc` and Webhint for accessibility auditing, valid markup, and cross-browser checks.
