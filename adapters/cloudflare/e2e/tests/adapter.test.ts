/**
 * Browser acceptance for the Cloudflare adapter (prompts 134/135), against the
 * emitted `_worker.js` running in local workerd with the asset layer in front.
 *
 * Only runs under `playwright.cloudflare.config.ts`. Every assertion uses
 * data-testid; ordering is observed with `waitUntil: 'commit'` and locator
 * expectations, never `waitForTimeout`. JavaScript is disabled in the browser
 * for the paint test so nothing but streamed HTML can produce the result.
 */
import { test, expect } from '@playwright/test';

test.describe('cloudflare adapter: static bypass', () => {
  test('the static home page is served by the asset layer', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId('cf-static-heading')).toBeVisible();
    // A static page carries no dynamic cache policy.
    expect(res?.headers()['cache-control']).not.toBe('private, no-store');
  });

  test('an unknown path is a 404 without any placeholder markup', async ({ page }) => {
    const res = await page.request.get('/does-not-exist');
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain('text/bascik-server');
  });
});

test.describe('cloudflare adapter: request-time pages', () => {
  test('a server script composes per request with the platform context', async ({ page }) => {
    const res = await page.goto('/stream?name=Jane');
    expect(res?.status()).toBe(200);
    expect(res?.headers()['cache-control']).toBe('private, no-store');
    await expect(page.getByTestId('cf-greeting')).toHaveText('Hello Jane on cloudflare');
    const html = await page.content();
    expect(html).not.toContain('text/bascik-server');
  });

  test('an API route dispatches inside the worker', async ({ page }) => {
    const res = await page.request.get('/api/ping');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ pong: true, platform: 'cloudflare' });
    const options = await page.request.fetch('/api/ping', { method: 'OPTIONS' });
    expect(options.status()).toBe(204);
    expect(options.headers()['allow']).toBe('GET, HEAD, OPTIONS');
  });
});

test.describe('cloudflare adapter: streamed paint order', () => {
  test.use({ javaScriptEnabled: false });

  test('the skeleton paints before the slow stream job resolves, with JS disabled', async ({ page }) => {
    const t0 = Date.now();
    await page.goto('/stream?delay=1500', { waitUntil: 'commit' });
    await expect(page.getByTestId('cf-skeleton')).toBeVisible();
    const tSkeleton = Date.now() - t0;
    expect(await page.getByTestId('cf-result').count()).toBe(0);
    await expect(page.getByTestId('cf-greeting')).toHaveText('Hello Guest on cloudflare');

    await expect(page.getByTestId('cf-result')).toBeVisible();
    const tResult = Date.now() - t0;

    expect(tSkeleton).toBeLessThan(1000);
    expect(tResult).toBeGreaterThanOrEqual(1500);
    await expect(page.getByTestId('cf-footer')).toHaveText('footer');
  });
});
