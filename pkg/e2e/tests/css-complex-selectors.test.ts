/**
 * e2e tests for CSS complex pseudo-class selector scoping on the
 * css-complex-test fixture page.
 *
 * Two instances of <css-complex> are rendered. Tests verify:
 *   - :is() argument class names are scoped
 *   - :where() argument class names are scoped
 *   - :not() argument class names are scoped
 *   - Both instances render correctly (instance isolation)
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number): Locator {
  return page.locator(".bascik__css-complex__wrapper").nth(n);
}

function card(inst: Locator) {
  return inst.locator(".bascik__css-complex__card");
}

function panel(inst: Locator) {
  return inst.locator(".bascik__css-complex__panel");
}

function highlight(inst: Locator) {
  return inst.locator(".bascik__css-complex__highlight");
}

function featured(inst: Locator) {
  return inst.locator(".bascik__css-complex__featured");
}

function activeItem(inst: Locator) {
  return inst.locator(".bascik__css-complex__item").first();
}

function disabledItem(inst: Locator) {
  return inst.locator(
    ".bascik__css-complex__item.bascik__css-complex__disabled",
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-complex-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-complex-test");
  });

  // :is() tests
  test(".card gets border-radius via :is()", async ({ page }) => {
    const inst = getInstance(page, 0);
    const borderRadius = await card(inst).evaluate(
      (el) => getComputedStyle(el).borderRadius,
    );
    expect(borderRadius).toBe("10px");
  });

  test(".panel gets same border-radius via :is()", async ({ page }) => {
    const inst = getInstance(page, 0);
    const borderRadius = await panel(inst).evaluate(
      (el) => getComputedStyle(el).borderRadius,
    );
    expect(borderRadius).toBe("10px");
  });

  // :where() tests
  test(".highlight is bold via :where()", async ({ page }) => {
    const inst = getInstance(page, 0);
    const fontWeight = await highlight(inst).evaluate(
      (el) => getComputedStyle(el).fontWeight,
    );
    expect(fontWeight).toBe("700");
  });

  test(".featured is bold via :where()", async ({ page }) => {
    const inst = getInstance(page, 0);
    const fontWeight = await featured(inst).evaluate(
      (el) => getComputedStyle(el).fontWeight,
    );
    expect(fontWeight).toBe("700");
  });

  // :not() tests
  test("active .item has green color via :not(.disabled)", async ({ page }) => {
    const inst = getInstance(page, 0);
    const color = await activeItem(inst).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(74, 222, 128)");
  });

  test("disabled .item does NOT have green color", async ({ page }) => {
    const inst = getInstance(page, 0);
    const color = await disabledItem(inst).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).not.toBe("rgb(74, 222, 128)");
  });

  // Instance isolation
  test("instance A and B both render .card with border-radius via :is()", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);
    const radiusA = await card(a).evaluate(
      (el) => getComputedStyle(el).borderRadius,
    );
    const radiusB = await card(b).evaluate(
      (el) => getComputedStyle(el).borderRadius,
    );
    expect(radiusA).toBe("10px");
    expect(radiusB).toBe("10px");
  });

  test("instance A and B both render active .item with green color via :not()", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);
    const colorA = await activeItem(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    const colorB = await activeItem(b).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(colorA).toBe("rgb(74, 222, 128)");
    expect(colorB).toBe("rgb(74, 222, 128)");
  });
});
