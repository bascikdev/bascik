/**
 * e2e tests for sourceURL and component stack trace source attribution.
 */
import { test, expect } from '@playwright/test';

test.describe('source-map-test page', () => {
  test('component runtime error stack trace contains source component path', async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (err) => errors.push(err));

    await page.goto('/source-map-test');
    await page.getByTestId('trigger-error-btn').click();

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('test component error');
    expect(errors[0].stack).toContain('source-map-test');
  });

  // This fixture minifies JS in every lane, which joins lines, so only the URL is checked here.
  // base-serving.test.ts checks the line number on the unminified dev server.
  for (const [testId, url] of [
    ['source-line-first', 'src/components/source-line-test/source-line-test.html'],
    ['source-line-second', 'src/components/source-line-test/source-line-test.html?instance=2'],
  ] as const) {
    test(`each instance has its own sourceURL in the stack trace (${testId})`, async ({ page }) => {
      const errors: Error[] = [];
      page.on('pageerror', (err) => errors.push(err));
      await page.goto('/source-map-test');

      await page.getByTestId(testId).click();

      expect(errors).toHaveLength(1);
      // Chromium reports the sourceURL as written: `(src/components/...html?instance=2:1:122)`.
      const frame = new RegExp(`\\(${url.replace(/[.?]/g, '\\$&')}:\\d+:\\d+\\)`);
      expect(errors[0].stack).toMatch(frame);
    });
  }
});
