/**
 * E2E tests for W3C & Web Standards Conformance on the w3c-conformance-test page.
 *
 * Verifies in live browser runtime:
 *   - W3C CSS Media Queries (@media (max-width: 600px) dynamic evaluation across viewports)
 *   - W3C CSS3/4 Structural Pseudo-Classes (:first-child, :nth-child(2))
 *   - WHATWG HTML & DOM Slot Semantics (default fallback vs custom named slot distribution)
 *   - TC39 JavaScript & DOM Query Rewriting (per-instance independent state and event handling)
 */
import { test, expect } from '@playwright/test';

test.describe('w3c-conformance-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/w3c-conformance-test');
  });

  // ── 1. CSS Media Queries ──────────────────────────────────────────────────

  test('media queries: applies desktop green background on wide viewport (>600px)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const mqBox = page.getByTestId('w3c-mq-box').first();
    const bgColor = await mqBox.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #10b981 -> rgb(16, 185, 129)
    expect(bgColor).toBe('rgb(16, 185, 129)');
  });

  test('media queries: applies mobile amber background on narrow viewport (<=600px)', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 768 });
    const mqBox = page.getByTestId('w3c-mq-box').first();
    const bgColor = await mqBox.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #f59e0b -> rgb(245, 158, 11)
    expect(bgColor).toBe('rgb(245, 158, 11)');
  });

  // ── 2. CSS Structural Pseudo-Classes ──────────────────────────────────────

  test('selectors: structural pseudo-classes :first-child and :nth-child(2) apply expected styles', async ({ page }) => {
    const section1 = page.getByTestId('instance-1-section');
    const item1 = section1.getByTestId('w3c-item-1');
    const item2 = section1.getByTestId('w3c-item-2');
    const item3 = section1.getByTestId('w3c-item-3');

    const item1Color = await item1.evaluate((el) => getComputedStyle(el).color);
    const item1Weight = await item1.evaluate((el) => getComputedStyle(el).fontWeight);
    // #3b82f6 -> rgb(59, 130, 246), bold / 700
    expect(item1Color).toBe('rgb(59, 130, 246)');
    expect(Number(item1Weight) >= 700 || item1Weight === 'bold').toBe(true);

    const item2Color = await item2.evaluate((el) => getComputedStyle(el).color);
    const item2Style = await item2.evaluate((el) => getComputedStyle(el).fontStyle);
    // #8b5cf6 -> rgb(139, 92, 246), italic
    expect(item2Color).toBe('rgb(139, 92, 246)');
    expect(item2Style).toBe('italic');

    const item3Color = await item3.evaluate((el) => getComputedStyle(el).color);
    // item3 has no special pseudo-class styling (inherits default color)
    expect(item3Color).not.toBe('rgb(59, 130, 246)');
  });

  // ── 3. WHATWG HTML Template & Slot Semantics ──────────────────────────────

  test('slots: instance 1 displays default fallback slots', async ({ page }) => {
    const section1 = page.getByTestId('instance-1-section');
    await expect(section1.getByTestId('w3c-default-header')).toHaveText('Default W3C Header');
    await expect(section1.getByTestId('w3c-default-body')).toHaveText('Default Body Content');
  });

  test('slots: instance 2 displays custom injected named and default slot content', async ({ page }) => {
    const section2 = page.getByTestId('instance-2-section');
    await expect(section2.getByTestId('w3c-custom-header')).toHaveText('Custom Injected Header');
    await expect(section2.getByTestId('w3c-custom-body')).toHaveText('Custom Slotted Body Paragraph');
    await expect(section2.getByTestId('w3c-default-header')).toHaveCount(0);
    await expect(section2.getByTestId('w3c-default-body')).toHaveCount(0);
  });

  // ── 4. JavaScript IIFE & DOM Query Isolation ─────────────────────────────

  test('javascript: instance 1 and instance 2 maintain independent isolated counter states', async ({ page }) => {
    const section1 = page.getByTestId('instance-1-section');
    const section2 = page.getByTestId('instance-2-section');

    const btn1 = section1.getByTestId('w3c-btn');
    const display1 = section1.getByTestId('w3c-display');
    const btn2 = section2.getByTestId('w3c-btn');
    const display2 = section2.getByTestId('w3c-display');

    // Initial state
    await expect(display1).toHaveText('Count: 0');
    await expect(display2).toHaveText('Count: 0');

    // Click button on instance 1 twice
    await btn1.click();
    await btn1.click();

    // Instance 1 updated; Instance 2 untouched
    await expect(btn1).toHaveText('Clicked 2 times');
    await expect(display1).toHaveText('Count: 2');
    await expect(btn2).toHaveText('Clicked 0 times');
    await expect(display2).toHaveText('Count: 0');

    // Click button on instance 2 once
    await btn2.click();
    await expect(btn2).toHaveText('Clicked 1 times');
    await expect(display2).toHaveText('Count: 1');
    await expect(display1).toHaveText('Count: 2');
  });
});
