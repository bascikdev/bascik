/**
 * E2E tests for W3C Media Queries Conformance.
 *
 * Verifies live browser layout responses to viewport resizes, prefers-color-scheme,
 * and prefers-reduced-motion media features.
 */
import { test, expect } from '@playwright/test';

test.describe('w3c-mediaqueries-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/w3c-mediaqueries-test');
  });

  test('range syntax: responds to viewport width changes (<=600px mobile red, 601-900px amber, >900px desktop green)', async ({ page }) => {
    const box = page.getByTestId('mq-viewport-box');

    // Mobile: <= 600px
    await page.setViewportSize({ width: 500, height: 800 });
    let bg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #ef4444 -> rgb(239, 68, 68)
    expect(bg).toBe('rgb(239, 68, 68)');

    // Tablet: 601px - 900px
    await page.setViewportSize({ width: 750, height: 800 });
    bg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #f59e0b -> rgb(245, 158, 11)
    expect(bg).toBe('rgb(245, 158, 11)');

    // Desktop: > 900px
    await page.setViewportSize({ width: 1200, height: 800 });
    bg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #10b981 -> rgb(16, 185, 129)
    expect(bg).toBe('rgb(16, 185, 129)');
  });

  test('user preference: prefers-color-scheme dark applies dark background', async ({ page }) => {
    const themeBox = page.getByTestId('mq-theme-box');

    await page.emulateMedia({ colorScheme: 'dark' });
    const darkBg = await themeBox.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #0f172a -> rgb(15, 23, 42)
    expect(darkBg).toBe('rgb(15, 23, 42)');

    await page.emulateMedia({ colorScheme: 'light' });
    const lightBg = await themeBox.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #ffffff -> rgb(255, 255, 255)
    expect(lightBg).toBe('rgb(255, 255, 255)');
  });

  test('user preference: prefers-reduced-motion suppresses CSS transitions/transforms', async ({ page }) => {
    const toggleBtn = page.getByTestId('mq-toggle-btn');
    const motionBox = page.getByTestId('mq-motion-box');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await toggleBtn.click();

    const transition = await motionBox.evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(transition === 'none' || transition === 'all 0s ease 0s').toBe(true);
  });
});
