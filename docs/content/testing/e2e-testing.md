# End-to-End Testing

End-to-end (E2E) testing with Playwright verifies full application workflows, browser DOM event handling, CSS `:has()` pseudo-class rendering, and multi-page routing in real browser engines (Chromium, Firefox, WebKit).

## Playwright Setup

If your project was scaffolded with `create-bascik`, Playwright is pre-configured. To install Playwright manually:

```sh
npm install -D @playwright/test
```

## Configuration (`e2e/playwright.config.ts`)

Configure Playwright to build and serve your compiled Bascik application before running tests:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  webServer: {
    command: 'npx bascik --build && npx bascik --server',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
  },
});
```

## Identifier Minification & Locator Strategy

In production builds (`bascik --build`), identifier minification (`minify.identifiers: true`) hashes and compresses element IDs and class names (for example, `.card` becomes `.b1a2`). Behavior-oriented E2E tests should avoid depending on raw compiled class or ID selectors.

### Recommended Pattern: `data-testid` Attributes

Add `data-testid` attributes to interactive elements and target them using Playwright's native `page.getByTestId(...)` API:

```html
<!-- src/components/search/search.html -->
<div data-testid="search-overlay" class="overlay">
  <input data-testid="search-input" type="search" placeholder="Search docs..." />
  <button data-testid="search-submit" type="submit">Search</button>
</div>
```

```ts
// e2e/search.spec.ts
import { test, expect } from '@playwright/test';

test('search modal opens and filters results', async ({ page }) => {
  await page.goto('/');

  const modal = page.getByTestId('search-overlay');
  const input = page.getByTestId('search-input');

  await page.keyboard.press('Control+k');
  await expect(modal).toBeVisible();

  await input.fill('scoped styles');
  await expect(page.getByTestId('search-result').first()).toContainText('Scoped Styles');
});
```

For accessibility-oriented flows, role and label queries are equally strong defaults:

- `page.getByRole('button', { name: 'Search' })`
- `page.getByLabel('Email')`

### When Transform-Aware Selectors Are Correct

If your test intent is compiler-output verification, selector assertions may intentionally target transformed output. For example, in Bascik's compiler fixture suite, tests may assert generated scoped class tokens or rewritten IDs to verify the transpiler itself.

Use this only when transformed identifiers are the explicit subject under test. For ordinary behavior tests, keep the resilient user-facing locator strategy above.

## Running E2E Tests

Execute your Playwright test suite:

```sh
npx playwright test --config e2e/playwright.config.ts
```

## Multi-Environment Testing Matrix

Depending on the features under test, configure Playwright to run against the appropriate execution mode:

| Environment Mode | Command | What to Verify |
| --- | --- | --- |
| **Static Production** | `bascik --build` | Static HTML rendering, slot replacement, compiled assets, client JS interactivity |
| **Dev Server (Live)** | `bascik --dev` | SSE live-reload connection, fast recompilation, open-page prioritization |
| **HTTP/1.1 Production** | `bascik --server` | Request-time `<script data-bascik-server>` scripts, query parameters, cookies |
| **HTTP/2 Production** | `bascik --server` (TLS) | TLS termination, HTTP/2 multiplexed streaming, encrypted server scripts |

### Example: Testing Live Dev Server Reloading

```ts
// e2e/dev-reload.spec.ts
import { test, expect } from '@playwright/test';

test('dev server establishes Server-Sent Events stream for live reload', async ({ page }) => {
  await page.goto('/');

  // Verify SSE live reload client script injected in dev mode
  const sseScript = page.locator('script[data-bascik-live-reload]');
  await expect(sseScript).toBeAttached();
});
```

