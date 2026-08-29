---
name: bascik-playwright-e2e
description: Multi-environment End-to-End (E2E) testing patterns for Bascik across static build, dev server, HTTP/1.1, and HTTP/2 production servers. Use when authoring or debugging E2E tests, verifying live-reload, or testing minified production builds.
---

# Multi-Environment Playwright E2E Testing in Bascik

Bascik validates runtime behavior against four distinct server and compilation environments to ensure complete environment parity across dev, static hosting, and production servers.

---

## 1. Server Environment Modes

| Config File | Target Environment | Key Mechanics |
| :--- | :--- | :--- |
| `pkg/e2e/playwright.config.ts` | **Static Production** | Tests static HTML file serving from `dist/` |
| `pkg/e2e/playwright.dev.config.ts` | **Dev Server (Watch/SSE)** | Tests live reload, file watcher triggers, dev SSE stream |
| `pkg/e2e/playwright.server.config.ts` | **Production HTTP/1.1** | Tests `bascik --serve` over HTTP/1.1 |
| `pkg/e2e/playwright.server-http2.config.ts` | **Production HTTP/2** | Tests `bascik --serve` over secure HTTP/2 with TLS |

---

## 2. Production Identifier Minification & Locators

In production builds (`bascik --build` with `minify.identifiers: true`), class names and scoped element IDs are hashed and compressed (e.g., `.my-card` $\rightarrow$ `.a`).

### Invariant: Never Target Minified Classes or IDs
* 🚫 **Do NOT use raw classes:** `page.locator('.search-overlay')`
* 🚫 **Do NOT use scoped IDs:** `page.locator('#btn-123')`
* 🚫 **Do NOT use fragile relative DOM walks:** `page.locator('div > div:nth-child(2)')`
* ✅ **Always use explicit test IDs:**
  ```html
  <button data-testid="submit-button">Submit</button>
  ```
  ```ts
  await page.getByTestId('submit-button').click();
  ```

---

## 3. Testing Live Reloading

When testing dev server live-reload behavior:
1. Load page and assert initial state using `page.getByTestId(...)`.
2. Mutate a fixture file on disk in a temporary test directory.
3. Wait for the SSE reload event or poll for updated DOM content:
   ```ts
   await expect(page.getByTestId('dynamic-text')).toHaveText('Updated Content');
   ```
4. Restore fixture files in `finally` / `afterEach` hooks.

---

## 4. Execution Commands

```sh
# Run static build E2E tests
yarn --cwd pkg e2e

# Run live dev server E2E tests
yarn --cwd pkg e2e:dev

# Run HTTP/1.1 & HTTP/2 prod server tests
yarn --cwd pkg e2e:prod

# Run all E2E test suites
yarn --cwd pkg e2e:all
```
