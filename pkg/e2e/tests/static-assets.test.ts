/**
 * E2E tests for static asset copying, exclusions, and inlined stylesheet handling.
 *
 * Verifies:
 *   1. Non-HTML static assets in pages/ (e.g. static-asset-test.css) ARE copied to dist/ and served
 *   2. TypeScript files (helper.ts) and test files (sample.test.ts) in pages/ ARE NOT copied to dist/
 *   3. Configured inlineStyles (src/css/inlined-global.css) ARE inlined into page <head> blocks
 *   4. Configured inlineStyles ARE NOT copied as standalone static files to dist/
 */
import { test, expect } from '@playwright/test';

test.describe('Static Assets & Inlined Styles handling', () => {

  test('serves static assets copied from src/pages/ with HTTP 200 and proper content-type', async ({ request }) => {
    const res = await request.get('/static-asset-test.css');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/css');

    const text = await res.text();
    expect(text).toContain('.static-asset-box');
  });

  test('does NOT serve TypeScript source files (.ts) from src/pages/', async ({ request }) => {
    const res = await request.get('/helper.ts');
    expect(res.status()).toBe(404);
  });

  test('does NOT serve test files (*.test.ts) from src/pages/', async ({ request }) => {
    const res = await request.get('/sample.test.ts');
    expect(res.status()).toBe(404);
  });

  test('inlines configured inlineStyles into HTML page <head>', async ({ page }) => {
    await page.goto('/scope-test');

    const hasInlinedStyles = await page.evaluate(() => {
      const styles = Array.from(document.querySelectorAll('head style'));
      return styles.some((s) => s.textContent?.includes('--e2e-inlined-var'));
    });
    expect(hasInlinedStyles).toBe(true);
  });

  test('does NOT copy inlined stylesheets as standalone static files to dist/', async ({ request }) => {
    const res1 = await request.get('/src/css/inlined-global.css');
    expect(res1.status()).toBe(404);

    const res2 = await request.get('/css/inlined-global.css');
    expect(res2.status()).toBe(404);

    const res3 = await request.get('/inlined-global.css');
    expect(res3.status()).toBe(404);
  });
});
