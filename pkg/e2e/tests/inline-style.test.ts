/**
 * e2e tests for inline <style> tag scoping on the inline-style-test fixture page.
 *
 * Two instances of <inline-style> are rendered plus a bare <p> outside the
 * component.  Tests verify:
 *   - The component's <style> block stays inline in the body (not hoisted to <head>)
 *   - No <style> tag appears inside the .card div itself (it precedes it as a sibling)
 *   - Class-scoped rules (.bascik__inline-style__card etc.) apply correct colours
 *   - Bare element selectors inside the inline <style> block are scoped too
 *   - Prop values are injected correctly
 *   - Both instances share the same scoped class names and styles
 *   - Class-scoped rules do not bleed to elements outside the component
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator('.bascik__inline-style__card').nth(0),
    b: page.locator('.bascik__inline-style__card').nth(1),
  };
}

function cardTitle(card: Locator) {
  return card.locator('.bascik__inline-style__card-title');
}

function highlightBox(card: Locator) {
  return card.locator('.bascik__inline-style__highlight-box');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('inline-style-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inline-style-test');
  });

  test('no component <style> tags remain in <body>', async ({ page }) => {
    const bodyStyles = page.locator('body style');
    await expect(bodyStyles).toHaveCount(0);
  });

  test('component <style> tags are extracted to <head> and deduplicated', async ({ page }) => {
    const headStyleContent = await page.locator('head style').last().textContent();
    expect(headStyleContent).not.toBeNull();
    const matches = headStyleContent!.match(/\.bascik__inline-style__card\b(?!-)/g);
    expect(matches).not.toBeNull();
    expect(matches!).toHaveLength(1);
  });

  test('card has correct background color', async ({ page }) => {
    const { a } = getInstances(page);
    const bg = await a.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(14, 30, 14)');
  });

  test('card title has correct color', async ({ page }) => {
    const { a } = getInstances(page);
    const color = await cardTitle(a).evaluate(el => getComputedStyle(el).color);
    expect(color).toBe('rgb(74, 222, 128)');
  });

  test('paragraph inside component has inline-style p rule applied', async ({ page }) => {
    const { a } = getInstances(page);
    const p = a.locator('p');
    const color = await p.evaluate(el => getComputedStyle(el).color);
    expect(color).toBe('rgb(120, 180, 120)');
  });

  test('inline-style element selectors do not bleed to outside <p> elements', async ({ page }) => {
    const outsideP = page.locator('body > p');
    const color = await outsideP.evaluate(el => getComputedStyle(el).color);
    expect(color).not.toBe('rgb(120, 180, 120)');
  });

  test('highlight-box has correct background color', async ({ page }) => {
    const { a } = getInstances(page);
    const bg = await highlightBox(a).evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(74, 222, 128)');
  });

  test('highlight-box text color is black', async ({ page }) => {
    const { a } = getInstances(page);
    const color = await highlightBox(a).evaluate(el => getComputedStyle(el).color);
    expect(color).toBe('rgb(0, 0, 0)');
  });

  test('prop title is injected into card A', async ({ page }) => {
    const { a } = getInstances(page);
    await expect(cardTitle(a)).toHaveText('Card A');
  });

  test('prop title is injected into card B', async ({ page }) => {
    const { b } = getInstances(page);
    await expect(cardTitle(b)).toHaveText('Card B');
  });

  test('instance A and B both have the same card background', async ({ page }) => {
    const { a, b } = getInstances(page);
    const bgA = await a.evaluate(el => getComputedStyle(el).backgroundColor);
    const bgB = await b.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bgA).toBe('rgb(14, 30, 14)');
    expect(bgB).toBe('rgb(14, 30, 14)');
  });

  test('instance A and B both have the same card title color', async ({ page }) => {
    const { a, b } = getInstances(page);
    const colorA = await cardTitle(a).evaluate(el => getComputedStyle(el).color);
    const colorB = await cardTitle(b).evaluate(el => getComputedStyle(el).color);
    expect(colorA).toBe('rgb(74, 222, 128)');
    expect(colorB).toBe('rgb(74, 222, 128)');
  });
});
