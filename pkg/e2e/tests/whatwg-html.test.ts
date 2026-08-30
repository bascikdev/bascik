/**
 * E2E tests for WHATWG HTML & DOM Conformance.
 *
 * Verifies slot projection, default fallback behavior, and pre/code formatting preservation.
 */
import { test, expect } from '@playwright/test';

test.describe('whatwg-html-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/whatwg-html-test');
  });

  test('slot projection: instance 1 renders default fallback content in top, main, and bottom slots', async ({ page }) => {
    const inst1 = page.getByTestId('html-instance-1');

    await expect(inst1.getByTestId('fallback-top')).toHaveText('Default Top Header Slot Content');
    await expect(inst1.getByTestId('fallback-main')).toHaveText('Default Main Body Slot Content');
    await expect(inst1.getByTestId('fallback-bottom')).toHaveText('Default Bottom Footer Slot Content');
  });

  test('slot projection: instance 2 replaces all slots with custom provided slot content', async ({ page }) => {
    const inst2 = page.getByTestId('html-instance-2');

    await expect(inst2.getByTestId('custom-top')).toHaveText('Custom Top Slot Content');
    await expect(inst2.getByTestId('custom-main')).toHaveText('Custom Main Slot Paragraph Content');
    await expect(inst2.getByTestId('custom-bottom')).toHaveText('Custom Bottom Slot Content');

    await expect(inst2.getByTestId('fallback-top')).toHaveCount(0);
    await expect(inst2.getByTestId('fallback-main')).toHaveCount(0);
    await expect(inst2.getByTestId('fallback-bottom')).toHaveCount(0);
  });

  test('rawtext preservation: preserves exact multiline indentation inside <pre>', async ({ page }) => {
    const preElement = page.getByTestId('raw-pre').first();
    const preText = await preElement.textContent();

    expect(preText).toContain('line 1: indented text');
    expect(preText).toContain('line 2:   triple space');
    expect(preText).toContain('line 3: <safe-entity>');
  });
});
