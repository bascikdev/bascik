/**
 * E2E tests for client abort resilience and crash-net protection.
 * Verifies that aborting a request mid-download does not crash the server
 * and subsequent requests continue to succeed.
 */
import { test, expect } from '@playwright/test';

test.describe('Client Abort & Server Crash Net', () => {
  test('server survives client abort during asset download and responds to subsequent requests', async ({ page }) => {
    // 1. Initiate a fetch and abort it immediately via AbortController
    await page.goto('/');

    const aborted = await page.evaluate(async () => {
      const controller = new AbortController();
      const signal = controller.signal;
      const fetchPromise = fetch('/static-asset-test.css', { signal }).catch((err) => {
        return err.name === 'AbortError' ? 'aborted' : 'other-error';
      });
      // Abort immediately
      controller.abort();
      return await fetchPromise;
    });

    expect(aborted).toBe('aborted');

    // 2. Verify server is still healthy and answering subsequent requests
    const subsequentResponse = await page.request.get('/');
    expect(subsequentResponse.status()).toBe(200);

    const assetResponse = await page.request.get('/static-asset-test.css');
    expect(assetResponse.status()).toBe(200);
  });
});
