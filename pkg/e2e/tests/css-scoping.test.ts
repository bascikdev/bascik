/**
 * e2e tests for CSS scoping on the css-scope-test fixture page.
 *
 * Two instances of <css-scope-test> are rendered on the page alongside an
 * unscoped <p> outside any component. Tests verify:
 *   - scoped class rules apply only to elements with the scoped class
 *   - scoped element-type selectors (p {}) apply only inside the component
 *   - toggling a class on instance A does not affect instance B
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable: e.g. `bascik__css-scope-test__active`.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__css-scope-test__wrapper").nth(0),
    b: page.locator(".bascik__css-scope-test__wrapper").nth(1),
  };
}

function box(inst: Locator) {
  return inst.locator('[id$="__box"]');
}

function toggleBtn(inst: Locator) {
  return inst.locator('[id$="__toggle-btn"]');
}

function scopedP(inst: Locator) {
  return inst.locator("p");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-scope-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-scope-test");
  });

  test("box starts with default background color", async ({ page }) => {
    const { a } = getInstances(page);
    const bg = await box(a).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(34, 34, 34)");
  });

  test("clicking toggle-btn changes box background color", async ({ page }) => {
    const { a } = getInstances(page);
    await toggleBtn(a).click();
    await expect(box(a)).toHaveClass(/bascik__css-scope-test__active/);
    const bg = await box(a).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(22, 101, 52)");
  });

  test("clicking toggle-btn twice restores default color", async ({ page }) => {
    const { a } = getInstances(page);
    await toggleBtn(a).click();
    await toggleBtn(a).click();
    await expect(box(a)).not.toHaveClass(/active/);
    const bg = await box(a).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(34, 34, 34)");
  });

  test("instance A toggle does not change instance B box color", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await toggleBtn(a).click();
    await expect(box(a)).toHaveClass(/bascik__css-scope-test__active/);
    await expect(box(b)).not.toHaveClass(/active/);
    const bgB = await box(b).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bgB).toBe("rgb(34, 34, 34)");
  });

  test("scoped p element styles do not apply to p elements outside the component", async ({
    page,
  }) => {
    const outsideP = page.locator("#outside-p");
    const color = await outsideP.evaluate((el) => getComputedStyle(el).color);
    // Should be the browser default (white/near-white from body color) — not rgb(34, 197, 94)
    expect(color).not.toBe("rgb(34, 197, 94)");
  });

  test("scoped p element styles apply to p elements inside the component", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    const color = await scopedP(a).evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(34, 197, 94)");
  });
});
