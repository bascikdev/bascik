/**
 * e2e tests for dynamic DOM creation on the dynamic-dom-test fixture page.
 *
 * Two instances of <dynamic-dom> are rendered side by side. These tests verify
 * bascik's class-scoping behavior for elements created at runtime via
 * document.createElement:
 *
 * - `li.className = "item"` IS scoped: bascik rewrites the string literal
 *   because "item" is a known class (declared via the sentinel <span>).
 *   Result: li.className = "bascik__dynamic-dom__item"
 *
 * - `li.setAttribute("class", "item unscoped-item")` scopes known classes and
 *   preserves unknown global classes: "item" is in the component CSS so it is
 *   rewritten to "bascik__dynamic-dom__item", while "unscoped-item" is not in
 *   the component CSS and stays literal.
 *
 * - `list.innerHTML = ""` is NOT rewritten — innerHTML clears work as-is.
 *
 * The fixture is built with `minify.identifiers: false` so scoped class
 * and id names are readable (e.g. `bascik__dynamic-dom__item`).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator('.bascik__dynamic-dom__wrapper').nth(0),
    b: page.locator('.bascik__dynamic-dom__wrapper').nth(1),
  };
}

const list = (inst: Locator) => inst.locator('[id$="__dynamic-list"]');
const status = (inst: Locator) => inst.locator('[id$="__status"]');
const btn = (inst: Locator, suffix: string) => inst.locator(`[id$="__${suffix}"]`);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('dynamic-dom-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dynamic-dom-test');
  });

  // ── 1. Initial state ─────────────────────────────────────────────────────

  test('initial list is empty', async ({ page }) => {
    const { a, b } = getInstances(page);
    await expect(list(a)).toBeEmpty();
    await expect(list(b)).toBeEmpty();
  });

  test('status starts at "0 items"', async ({ page }) => {
    const { a, b } = getInstances(page);
    await expect(status(a)).toHaveText('0 items');
    await expect(status(b)).toHaveText('0 items');
  });

  // ── 2. Scoped className setter ────────────────────────────────────────────
  //
  // li.className = "item" is rewritten at build time to:
  //   li.className = "bascik__dynamic-dom__item"
  // because "item" appears in the component HTML (via the sentinel <span>).

  test('add-scoped-btn appends one child to the list', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-scoped-btn').click();
    await expect(list(a)).toHaveCount(1);
    await expect(list(a).locator('li')).toHaveCount(1);
  });

  test('dynamically added item has scoped class (className setter)', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-scoped-btn').click();
    const li = list(a).locator('li').first();
    await expect(li).toHaveClass(/bascik__dynamic-dom__item/);
  });

  test('status updates to "1 items" after adding one item', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-scoped-btn').click();
    await expect(status(a)).toHaveText('1 items');
  });

  test('add-scoped-btn twice produces two children', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-scoped-btn').click();
    await btn(a, 'add-scoped-btn').click();
    await expect(list(a).locator('li')).toHaveCount(2);
    await expect(status(a)).toHaveText('2 items');
  });

  // ── 3. Scoped CSS applies to dynamically added scoped items ──────────────

  test('scoped item receives .item CSS (color: rgb(74, 222, 128))', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-scoped-btn').click();
    const li = list(a).locator('li').first();
    const color = await li.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(74, 222, 128)');
  });

  // ── 4. Multi-class setAttribute (scoped + global token) ───────────────────
  //
  // li.setAttribute("class", "item unscoped-item") rewrites known component
  // classes ("item" -> "bascik__dynamic-dom__item") while leaving unknown
  // global classes ("unscoped-item") untouched.

  test('add-unscoped-btn appends one child to the list', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-unscoped-btn').click();
    await expect(list(a).locator('li')).toHaveCount(1);
  });

  test('setAttribute("class", ...) scopes known class and preserves unscoped class', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-unscoped-btn').click();
    const li = list(a).locator('li').first();
    await expect(li).toHaveAttribute('class', 'bascik__dynamic-dom__item unscoped-item');
  });

  // ── 5. clear-btn (innerHTML = "") ─────────────────────────────────────────

  test('clear-btn empties the list', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-scoped-btn').click();
    await btn(a, 'add-scoped-btn').click();
    await expect(list(a).locator('li')).toHaveCount(2);

    await btn(a, 'clear-btn').click();
    await expect(list(a)).toBeEmpty();
  });

  test('status updates to "0 items" after clear', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-scoped-btn').click();
    await btn(a, 'clear-btn').click();
    await expect(status(a)).toHaveText('0 items');
  });

  // ── 6. Instance isolation ─────────────────────────────────────────────────

  test('instance A additions do not affect instance B list', async ({ page }) => {
    const { a, b } = getInstances(page);
    await btn(a, 'add-scoped-btn').click();
    await btn(a, 'add-scoped-btn').click();

    await expect(list(a).locator('li')).toHaveCount(2);
    await expect(list(b)).toBeEmpty();
    await expect(status(b)).toHaveText('0 items');
  });

  test('instance B can independently add items', async ({ page }) => {
    const { a, b } = getInstances(page);
    await btn(b, 'add-scoped-btn').click();

    await expect(list(b).locator('li')).toHaveCount(1);
    const li = list(b).locator('li').first();
    await expect(li).toHaveClass(/bascik__dynamic-dom__item/);
    // instance A unaffected
    await expect(list(a)).toBeEmpty();
  });
});
