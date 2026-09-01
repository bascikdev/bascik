/**
 * e2e tests for `data-bascik-server` script blocks.
 *
 * These tests exercise request-time script execution via the Bascik HTTP/2
 * production server.  They require `playwright.server.config.ts` (not the
 * default config) because the static file server used by the rest of the e2e
 * suite cannot execute server scripts.
 *
 * Run with:
 *   npx playwright test --config playwright.server.config.ts
 *
 * The fixture page `src/pages/server-scripts-test.html` contains five server
 * script blocks that:
 *   1. Read a custom request header (`x-test-name`) and output it
 *   2. Read a query parameter (`?color=`) and output it
 *   3. Output the request path
 *   4. Use top-level `await` (async server script)
 *   5. Throw an intentional error to test graceful degradation
 */
import { test, expect } from '@playwright/test';

test.describe('data-bascik-server — request-time script execution', () => {

  // ─── Static baseline ─────────────────────────────────────────────────────

  test('static content before and after server scripts is preserved and logs no browser console error', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    await page.goto('/server-scripts-test');
    await expect(page.locator('#static-before')).toHaveText('static-before');
    await expect(page.locator('#static-after')).toHaveText('static-after');
    expect(consoleErrors).toHaveLength(0);
  });

  // ─── Request headers ─────────────────────────────────────────────────────

  test('reads a custom request header and injects it into the page', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-test-name': 'Alice' });
    await page.goto('/server-scripts-test');
    await expect(page.locator('#from-header')).toHaveText('Alice');
  });

  test('falls back gracefully when the custom header is absent', async ({ page }) => {
    await page.goto('/server-scripts-test');
    await expect(page.locator('#from-header')).toHaveText('guest');
  });

  // ─── Query parameters ────────────────────────────────────────────────────

  test('reads a query parameter and injects it into the page', async ({ page }) => {
    await page.goto('/server-scripts-test?color=blue');
    await expect(page.locator('#from-query')).toHaveText('blue');
  });

  test('falls back gracefully when the query parameter is absent', async ({ page }) => {
    await page.goto('/server-scripts-test');
    await expect(page.locator('#from-query')).toHaveText('none');
  });

  test('handles multiple query parameters correctly', async ({ page }) => {
    await page.goto('/server-scripts-test?color=red&foo=bar');
    await expect(page.locator('#from-query')).toHaveText('red');
  });

  // ─── Request path ────────────────────────────────────────────────────────

  test('provides the URL path (without query string) to the script', async ({ page }) => {
    await page.goto('/server-scripts-test?color=green');
    await expect(page.locator('#from-path')).toHaveText('/server-scripts-test');
  });

  // ─── Async scripts ───────────────────────────────────────────────────────

  test('supports top-level await in server scripts', async ({ page }) => {
    await page.goto('/server-scripts-test');
    await expect(page.locator('#from-async')).toHaveText('async-ok');
  });

  // ─── Error handling ──────────────────────────────────────────────────────

  test('continues rendering when a server script throws', async ({ page }) => {
    await page.goto('/server-scripts-test');
    // Static bookends must still be present even though one script threw.
    await expect(page.locator('#static-before')).toHaveText('static-before');
    await expect(page.locator('#static-after')).toHaveText('static-after');
  });

  test('removes the erroring script tag (no trace in the DOM)', async ({ page }) => {
    await page.goto('/server-scripts-test');
    // The erroring script had no stdout — its tag slot should be empty.
    // The combined other scripts still render, so the count of <p> elements
    // under <body> is: static-before, from-header, from-query, from-path,
    // from-async, static-after = 6 (not 7, because the error script is gone).
    const ps = await page.locator('body > p').count();
    expect(ps).toBe(6);
  });

  // ─── Per-request freshness ───────────────────────────────────────────────

  test('executes fresh on each request — different headers produce different output', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-test-name': 'Bob' });
    await page.goto('/server-scripts-test');
    await expect(page.locator('#from-header')).toHaveText('Bob');

    await page.setExtraHTTPHeaders({ 'x-test-name': 'Carol' });
    await page.goto('/server-scripts-test');
    await expect(page.locator('#from-header')).toHaveText('Carol');
  });

  // ─── Advanced Server Script Capabilities ─────────────────────────────────

  test('supports Node.js ESM imports and provides HTTP method', async ({ page }) => {
    await page.goto('/server-scripts-advanced-test');
    await expect(page.locator('#esm-import-output')).toHaveText('ESM Import: server-scripts-advanced-test | Method: GET');
  });

  test('executes data-bascik-server scripts inside custom components at request time', async ({ page }) => {
    await page.goto('/server-scripts-advanced-test');
    await expect(page.locator('[class*="server-comp-static"]')).toHaveText('Component Static');
    await expect(page.locator('[id$="__comp-server-output"]')).toHaveText('Comp Server: GET');
  });

  test('strips ANSI escape codes from script output before injecting into HTML', async ({ page }) => {
    await page.goto('/server-scripts-advanced-test');
    await expect(page.locator('#ansi-output')).toHaveText('Clean HTML');
  });

  // ─── Resilience, Error Recovery & High Load ────────────────────────────────

  test('survives process.exit(1) and syntax errors in server scripts without crashing', async ({ page }) => {
    await page.goto('/server-scripts-resilience-test');

    // Page static bookends must remain intact
    await expect(page.locator('#resilience-before')).toHaveText('start');
    await expect(page.locator('#resilience-after')).toHaveText('end');
  });

  test('handles large stdout payloads generated by server scripts', async ({ page }) => {
    await page.goto('/server-scripts-resilience-test');
    const largeElem = page.locator('#large-payload');
    await expect(largeElem).toHaveText('LargePayload');
    await expect(largeElem).toHaveAttribute('data-len', '50000');
  });

  test('parses multiple custom headers passed to server scripts', async ({ page }) => {
    const extraHeaders: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) {
      extraHeaders[`x-stress-${i}`] = `value-${i}`;
    }
    await page.setExtraHTTPHeaders(extraHeaders);
    await page.goto('/server-scripts-resilience-test');

    await expect(page.locator('#custom-headers-count')).toHaveText('10');
  });

  test('handles 30 concurrent requests to pages with server scripts without crashing or temp-file collisions', async ({ request }) => {
    const requests = Array.from({ length: 30 }, (_, i) =>
      request.get('/server-scripts-resilience-test', {
        headers: { 'x-test-name': `ConcurrentUser-${i}` },
      }),
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status()).toBe(200);
      const text = await res.text();
      expect(text).toContain('id="resilience-before"');
      expect(text).toContain('id="resilience-after"');
    }
  });

  // ─── Real-World HTTP & Async Integration ───────────────────────────────────

  test('parses Cookie request headers and outputs personalized session content', async ({ page }) => {
    await page.setExtraHTTPHeaders({
      Cookie: 'session_id=sess_prod_9988; theme=dark; logged_in=true',
    });
    await page.goto('/server-scripts-realworld-test');

    await expect(page.locator('#user-session')).toHaveText('Session: sess_prod_9988');
    await expect(page.locator('#user-theme')).toHaveText('Theme: dark');
  });

  test('handles simulated laggy database/async microservice calls inside server scripts', async ({ page }) => {
    const start = Date.now();
    await page.goto('/server-scripts-realworld-test');
    const elapsed = Date.now() - start;

    await expect(page.locator('#db-status')).toHaveText('DB Status: active (admin)');
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  test('gracefully recovers when a server script encounters a failing external API call', async ({ page }) => {
    await page.goto('/server-scripts-realworld-test');
    await expect(page.locator('#api-status')).toHaveText('API Offline Fallback');
  });

  test('decodes complex URL search parameters with spaces and special characters', async ({ page }) => {
    await page.goto('/server-scripts-realworld-test?filter=active%20users&tag=node%2Bjs');

    await expect(page.locator('#query-filter')).toHaveText('Filter: active users');
    await expect(page.locator('#query-tag')).toHaveText('Tag: node+js');
  });
});
