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

test.describe('Pages that mention server scripts versus pages that run them', () => {
  // Brotli and gzip are computed in the background after the server loads its pages, so the first
  // request can arrive before they are ready. Poll until the encoding is negotiated rather than sleeping.
  const compressed = async (request: import('@playwright/test').APIRequestContext, path: string, encoding: 'br' | 'gzip') => {
    await expect
      .poll(async () => (await request.get(path, { headers: { 'Accept-Encoding': encoding } })).headers()['content-encoding'], {
        timeout: 15000,
      })
      .toBe(encoding);
    return request.get(path, { headers: { 'Accept-Encoding': encoding } });
  };

  test('a page that only mentions data-bascik-server is compressed and has an ETag, like any static page', async ({ request }) => {
    const plain = await request.get('/server-script-mention-test', { headers: { 'Accept-Encoding': 'identity' } });
    expect(plain.status()).toBe(200);
    // Nothing runs per request on this page, so it must never be marked personalized.
    expect(plain.headers()['cache-control'] ?? '').not.toContain('no-store');
    expect(plain.headers()['etag']).toBeDefined();

    const brotli = await compressed(request, '/server-script-mention-test', 'br');
    expect(brotli.headers()['etag']).toContain('-br');
    expect(Number(brotli.headers()['content-length'])).toBeLessThan(Number(plain.headers()['content-length']));
    // The prose must survive the round trip untouched.
    expect(await brotli.text()).toContain('data-bascik-server');
  });

  test('a repeat visit to a page that only mentions the directive gets a 304 instead of the whole document', async ({ request }) => {
    const first = await request.get('/server-script-mention-test', { headers: { 'Accept-Encoding': 'identity' } });
    const etag = first.headers()['etag'];
    expect(etag).toBeDefined();

    const again = await request.get('/server-script-mention-test', {
      headers: { 'Accept-Encoding': 'identity', 'If-None-Match': etag },
    });
    expect(again.status()).toBe(304);
  });

  test('a page with a real server script is still personalized: never cached, never given an ETag', async ({ request }) => {
    const res = await request.get('/server-scripts-test', { headers: { 'Accept-Encoding': 'br' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['etag']).toBeUndefined();
    expect(res.headers()['content-encoding']).toBeUndefined();
  });
});
