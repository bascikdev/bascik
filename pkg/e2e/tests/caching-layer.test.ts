/**
 * E2E tests for caching layer, 304 headers, compression and etags.
 */
import { test, expect } from '@playwright/test';

test.describe('Prompt 39 - Caching Layer & 304 Headers', () => {
  test('static CSS asset is served with ETag and cache-control', async ({ request }) => {
    const res = await request.get('/static-asset-test.css');
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers['etag']).toBeDefined();
    expect(headers['cache-control']).toBeDefined();
    expect(headers['vary']).toContain('Accept-Encoding');
  });

  test('304 response carries vary and cache-control headers on conditional GET', async ({ request }) => {
    const initialRes = await request.get('/static-asset-test.css');
    const etag = initialRes.headers()['etag'];
    expect(etag).toBeDefined();

    const condRes = await request.get('/static-asset-test.css', {
      headers: { 'If-None-Match': etag },
    });
    expect(condRes.status()).toBe(304);
    const condHeaders = condRes.headers();
    expect(condHeaders['vary']).toContain('Accept-Encoding');
    expect(condHeaders['cache-control']).toBeDefined();
  });
});
