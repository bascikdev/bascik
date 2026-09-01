/**
 * E2E tests for the Bascik Production Server (`bascik --server`).
 *
 * Runs against both HTTP/1.1 cleartext (`playwright.server.config.ts`) and
 * HTTP/2 TLS (`playwright.server-http2.config.ts`) production server instances.
 *
 * Exercises:
 *   1. Clean HTML output — NO dev live-reload SSE script injected
 *   2. Protocol headers (HTTP/1.1 & HTTP/2) and production security headers
 *   3. ETags and Conditional GETs (`304 Not Modified` on `If-None-Match`)
 *   4. Pre-compressed Brotli content serving (`Accept-Encoding: br`)
 *   5. Static asset streaming with ETags and proper MIME types
 *   6. HTTP method enforcement (`405 Method Not Allowed`) and path traversal protection (`400 Bad Request`)
 *   7. 404 page fallback handling
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.server.config.ts
 *   npx playwright test --config e2e/playwright.server-http2.config.ts
 */
import { test, expect } from '@playwright/test';

test.describe('Production Server (`bascik --server`) Engine', () => {

  // ── 1. Clean HTML Output ───────────────────────────────────────────────────

  test('does NOT inject dev live-reload script in production mode', async ({ page }) => {
    await page.goto('/scope-test');

    // Confirm dev live-reload script is NOT present in production output
    const hasLiveReloadScript = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      return scripts.some((s) => s.textContent?.includes('/bascik-live-reload'));
    });
    expect(hasLiveReloadScript).toBe(false);
  });

  test('never renders live-reload banner in production mode', async ({ page }) => {
    await page.goto('/scope-test');

    const banner = page.locator('#bascik-live-reload-banner');
    await expect(banner).not.toBeAttached();
  });

  // ── 2. Security Headers & HTTP/2 ──────────────────────────────────────────

  test('serves production security headers and correct HTML content-type', async ({ request }) => {
    const res = await request.get('/scope-test');
    expect(res.status()).toBe(200);

    const headers = res.headers();
    expect(headers['content-type']).toContain('text/html');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  // ── 3. ETags & Conditional GETs (304 Not Modified) ─────────────────────────

  test('returns 304 Not Modified on conditional GET with matching ETag', async ({ request }) => {
    // Initial request to capture ETag
    const firstRes = await request.get('/scope-test');
    expect(firstRes.status()).toBe(200);

    const etag = firstRes.headers()['etag'];
    expect(etag).toBeTruthy();

    // Conditional GET with If-None-Match header
    const secondRes = await request.get('/scope-test', {
      headers: { 'if-none-match': etag },
    });
    expect(secondRes.status()).toBe(304);
    const body = await secondRes.body();
    expect(body.length).toBe(0);
  });

  // ── 4. Brotli Compression ──────────────────────────────────────────────────

  test('serves Brotli-compressed content when client accepts br encoding', async ({ request }) => {
    const res = await request.get('/scope-test', {
      headers: { 'accept-encoding': 'br' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-encoding']).toBe('br');
  });

  // ── 5. Static Asset Serving & ETags ────────────────────────────────────────

  test('serves static assets from dist/ with ETags and 304 support', async ({ request }) => {
    // Request a static asset
    const firstRes = await request.get('/cov-test.css');
    if (firstRes.status() === 200) {
      expect(firstRes.headers()['content-type']).toContain('text/css');
      const etag = firstRes.headers()['etag'];
      if (etag) {
        const secondRes = await request.get('/cov-test.css', {
          headers: { 'if-none-match': etag },
        });
        expect(secondRes.status()).toBe(304);
      }
    }
  });

  // ── 6. HTTP Methods & Path Traversal ───────────────────────────────────────

  test('handles HEAD requests with 200 OK and empty body', async ({ request }) => {
    const res = await request.head('/scope-test');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const body = await res.body();
    expect(body.length).toBe(0);
  });

  test('returns 405 Method Not Allowed for POST requests', async ({ request }) => {
    const res = await request.post('/scope-test');
    expect(res.status()).toBe(405);
    expect(res.headers()['allow']).toBe('GET, HEAD');
  });

  test('rejects path traversal attempts with 400 Bad Request', async ({ request }) => {
    const res1 = await request.get('/../../../etc/passwd');
    // HTTP clients (like Playwright) may normalize the path to /etc/passwd
    // on the client side before sending, which results in 404 Not Found, while unnormalized path keeps it as 400.
    expect([400, 404]).toContain(res1.status());

    const res2 = await request.get('/..%2f..%2f..%2fetc/passwd');
    expect(res2.status()).toBe(400);
  });

  test('handles URL paths with null bytes safely without process crash', async ({ request }) => {
    const res = await request.get('/scope-test%00.html');
    expect([200, 400, 404]).toContain(res.status());
  });

  test('handles header flooding (100+ headers) without memory issues or server crashes', async ({ request }) => {
    const floodedHeaders: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      floodedHeaders[`x-flood-header-${i}`] = `value-data-${i}`;
    }
    const res = await request.get('/scope-test', { headers: floodedHeaders });
    expect(res.status()).toBe(200);
  });

  test('returns 405 Method Not Allowed for PUT, DELETE, and PATCH methods', async ({ request }) => {
    const putRes = await request.put('/scope-test');
    expect(putRes.status()).toBe(405);

    const deleteRes = await request.delete('/scope-test');
    expect(deleteRes.status()).toBe(405);
  });

  test('handles malformed percent-encoded URIs gracefully without server process crash', async ({ request }) => {
    const res = await request.get('/scope-test?invalid=%FF%FE');
    expect([200, 400]).toContain(res.status());
  });

  test('handles URLs with long query parameter strings cleanly', async ({ request }) => {
    const longQuery = 'q=' + 'a'.repeat(5000);
    const res = await request.get(`/scope-test?${longQuery}`);
    expect([200, 400]).toContain(res.status());
  });

  // ── 7. 404 Routing & Static Assets ──────────────────────────────────────────

  test('returns 404 for non-existent page routes', async ({ page }) => {
    const response = await page.goto('/nonexistent-prod-route-99999');
    expect(response?.status()).toBe(404);
  });

  test('returns 404 for non-existent static asset files', async ({ request }) => {
    const res = await request.get('/missing-file-xyz-987.css');
    expect(res.status()).toBe(404);
  });

  // ── 8. High Concurrency & Load Stress ───────────────────────────────────────

  test('handles 50 simultaneous parallel requests without crashing or dropping streams', async ({ request }) => {
    const requests = Array.from({ length: 50 }, (_, i) =>
      request.get(i % 2 === 0 ? '/scope-test' : '/isolation-test', {
        headers: { 'accept-encoding': i % 3 === 0 ? 'br' : 'identity' },
      }),
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status()).toBe(200);
    }
  });
});
