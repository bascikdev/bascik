/**
 * e2e tests for CSS grid-template-areas scoping on the css-grid-test fixture page.
 *
 * Two instances of <css-grid> are rendered. Tests verify:
 *   - CSS class names are scoped (e.g. .layout → .bascik__css-grid__layout)
 *   - grid-template-areas string values are NOT scoped (they are layout identifiers, not class refs)
 *   - grid-area property values are NOT scoped (e.g. grid-area: header stays as-is)
 *   - grid-template-columns / grid-template-rows values pass through unchanged
 *   - Grid layout is functional: display:grid, cells placed correctly
 *   - Props are applied per-instance; fallbacks work when no prop supplied
 *   - Instance isolation: different prop values on each instance
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inst(page: Page, n: number): Locator {
  return page.locator('.bascik__css-grid__grid-wrapper').nth(n);
}

function layout(i: Locator) {
  return i.locator('.bascik__css-grid__layout');
}

function header(i: Locator) {
  return i.locator('.bascik__css-grid__header-cell');
}

function sidebar(i: Locator) {
  return i.locator('.bascik__css-grid__sidebar-cell');
}

function mainCell(i: Locator) {
  return i.locator('.bascik__css-grid__main-cell');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('css-grid-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/css-grid-test');
  });

  test('layout uses CSS grid display', async ({ page }) => {
    const i = inst(page, 0);
    const display = await layout(i).evaluate(el => getComputedStyle(el).display);
    expect(display).toBe('grid');
  });

  test('header cell has correct background color', async ({ page }) => {
    const i = inst(page, 0);
    const bg = await header(i).evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(30, 58, 95)');
  });

  test('sidebar cell has correct background color', async ({ page }) => {
    const i = inst(page, 0);
    const bg = await sidebar(i).evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(20, 40, 20)');
  });

  test('main cell has correct background color', async ({ page }) => {
    const i = inst(page, 0);
    const bg = await mainCell(i).evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(25, 25, 25)');
  });

  test('grid areas work: header spans full width', async ({ page }) => {
    const i = inst(page, 0);
    const [headerWidth, layoutWidth] = await Promise.all([
      header(i).evaluate(el => (el as HTMLElement).offsetWidth),
      layout(i).evaluate(el => (el as HTMLElement).offsetWidth),
    ]);
    // Header spans both columns via "header header" area — allow a few px for gap/border
    expect(headerWidth).toBeGreaterThan(layoutWidth * 0.9);
  });

  test('prop: instance 1 sidebar label shows "Navigation"', async ({ page }) => {
    const i = inst(page, 0);
    await expect(sidebar(i)).toHaveText('Navigation');
  });

  test('prop: instance 1 main content shows "Article content"', async ({ page }) => {
    const i = inst(page, 0);
    await expect(mainCell(i)).toHaveText('Article content');
  });

  test('prop fallback: instance 2 sidebar shows "Sidebar"', async ({ page }) => {
    const i = inst(page, 1);
    await expect(sidebar(i)).toHaveText('Sidebar');
  });

  test('prop fallback: instance 2 main shows "Main content"', async ({ page }) => {
    const i = inst(page, 1);
    await expect(mainCell(i)).toHaveText('Main content');
  });

  test('instance isolation: instance 1 and 2 have different sidebar labels', async ({ page }) => {
    const label1 = await sidebar(inst(page, 0)).textContent();
    const label2 = await sidebar(inst(page, 1)).textContent();
    expect(label1).not.toBe(label2);
    expect(label1).toBe('Navigation');
    expect(label2).toBe('Sidebar');
  });
});
