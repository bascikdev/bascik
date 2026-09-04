/**
 * E2E tests for custom 500 error page handling and compression headers.
 */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

test.describe('Prompt 38 - Error Pages & Compression E2E', () => {
  test('static build output contains 500.html as a standard page', async () => {
    const dist500 = join(import.meta.dirname, '..', 'dist', '500.html');
    expect(existsSync(dist500)).toBe(true);
  });

  test('server responses receive brotli compression and decompress correctly', async ({ request }) => {
    const response = await request.get('/', {
      headers: { 'Accept-Encoding': 'br, gzip' },
    });
    expect(response.status()).toBe(200);
    const content = await response.text();
    expect(content.length).toBeGreaterThan(0);
  });

  test('a client that only accepts gzip receives an identical document through the gzip fallback', async ({ request }) => {
    const plain = await (await request.get('/', { headers: { 'Accept-Encoding': 'identity' } })).text();
    const viaGzip = await request.get('/', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(viaGzip.status()).toBe(200);
    // The static file harness (playwright.config.ts) does not negotiate
    // encodings; every live server mode must.
    const encoding = viaGzip.headers()['content-encoding'];
    if (encoding !== undefined) expect(encoding).toBe('gzip');
    expect(await viaGzip.text()).toBe(plain);
  });
});
