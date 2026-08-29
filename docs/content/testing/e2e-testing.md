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
    command: 'npx bascik --build && npx bascik --serve',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
  },
});
```

## Identifier Minification & Locator Strategy

In production builds (`bascik --build`), identifier minification (`minify.identifiers: true`) hashes and compresses element IDs and class names (for example, `.card` becomes `.b1a2`). Consequently, using CSS class locators like `page.locator('.search-box')` will fail in production.

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

## Running E2E Tests

Execute your Playwright test suite:

```sh
npx playwright test --config e2e/playwright.config.ts
```
