/**
 * e2e test for CSS @import resolution, condition wrapping, and remote hoisting.
 */
import { test, expect } from '@playwright/test';

test.describe('css-import-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/css-import-test');
  });

  test('inlines base imported styles and scopes class names', async ({ page }) => {
    const card = page.locator('.bascik__css-import__import-card');
    await expect(card).toBeVisible();

    const text = page.locator('.bascik__css-import__import-text');
    await expect(text).toBeVisible();

    // Base import rule: font-size: 18px
    const fontSize = await text.evaluate((el) => getComputedStyle(el).fontSize);
    expect(fontSize).toBe('18px');

    // Media query import rule: color: rgb(34, 197, 94)
    const color = await text.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(34, 197, 94)');

    // Supports query import rule: display: grid
    const display = await card.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('grid');

    // Layer query import rule: border-radius: 8px
    const borderRadius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(borderRadius).toBe('8px');
  });
});
