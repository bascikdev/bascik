/**
 * e2e test: recursion guard — self-referencing component.
 *
 * The recursion-guard component contains its own tag, which triggers
 * Bascik's MAX_SUBSTITUTIONS / MAX_OUTPUT_BYTES safety guard.
 *
 * The guard must:
 *   - Not crash the build
 *   - Produce a page that the server can serve (HTTP 200)
 *   - Return some HTML body (even if partial)
 *
 * Note: this test intentionally triggers the guard, so it will
 * log a [bascik] Transpilation aborted error during the build.
 * That is expected and correct behaviour.
 */
import { test, expect } from '@playwright/test';

test.describe('recursion-guard-test page', () => {
  test('page loads with HTTP 200 and has an html element', async ({ page }) => {
    const response = await page.goto('/recursion-guard-test');
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toBeAttached();
  });

  test('page body is non-empty and contains no raw sentinel tokens', async ({ page }) => {
    await page.goto('/recursion-guard-test');
    const body = await page.locator('body').innerHTML();
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain('\x00BASCIK_SHIELD');
    expect(body).not.toContain('bascik-source-file');
  });
});
