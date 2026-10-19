/**
 * e2e tests for CSS pseudo-element/class scoping on the css-pseudo-test fixture page.
 *
 * Two instances of <css-pseudo> are rendered. Tests verify:
 *   - ::before pseudo-element has correct content and color
 *   - :first-child / :last-child pseudo-classes apply correct colors
 *   - Middle item has the default (non-pseudo-class) color
 *   - @media query rule applies to the highlight element
 *   - CSS & nesting: .title inside .card has correct scoped color
 *   - Instance A and B both receive correct styles independently
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__css-pseudo__card").nth(0),
    b: page.locator(".bascik__css-pseudo__card").nth(1),
  };
}

function box(inst: Locator) {
  return inst.locator(".bascik__css-pseudo__box");
}

function items(inst: Locator) {
  return inst.locator(".bascik__css-pseudo__item");
}

function highlight(inst: Locator) {
  return inst.locator(".bascik__css-pseudo__highlight");
}

function title(inst: Locator) {
  return inst.locator(".bascik__css-pseudo__title");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-pseudo-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-pseudo-test");
  });

  test("::before pseudo-element color is correct", async ({ page }) => {
    const { a } = getInstances(page);
    const color = await box(a).evaluate(
      (el) => getComputedStyle(el, "::before").color,
    );
    expect(color).toBe("rgb(74, 222, 128)");
  });

  test("::before pseudo-element content is set", async ({ page }) => {
    const { a } = getInstances(page);
    const content = await box(a).evaluate(
      (el) => getComputedStyle(el, "::before").content,
    );
    expect(content).toContain("→");
  });

  test("first item has yellow color", async ({ page }) => {
    const { a } = getInstances(page);
    const color = await items(a)
      .nth(0)
      .evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(251, 191, 36)");
  });

  test("last item has red color", async ({ page }) => {
    const { a } = getInstances(page);
    const color = await items(a)
      .nth(2)
      .evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(248, 113, 113)");
  });

  test("middle item has default color (not yellow or red)", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    const color = await items(a)
      .nth(1)
      .evaluate((el) => getComputedStyle(el).color);
    expect(color).not.toBe("rgb(251, 191, 36)");
    expect(color).not.toBe("rgb(248, 113, 113)");
    expect(color).toBe("rgb(150, 150, 150)");
  });

  test("@media rule applies to highlight element", async ({ page }) => {
    const { a } = getInstances(page);
    const outlineColor = await highlight(a).evaluate(
      (el) => getComputedStyle(el).outlineColor,
    );
    expect(outlineColor).toBe("rgb(74, 222, 128)");
  });

  test("CSS nesting: card title has correct scoped color", async ({ page }) => {
    const { a } = getInstances(page);
    const color = await title(a).evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(200, 200, 200)");
  });

  test("instance A and B both have correct ::before color", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    const colorA = await box(a).evaluate(
      (el) => getComputedStyle(el, "::before").color,
    );
    const colorB = await box(b).evaluate(
      (el) => getComputedStyle(el, "::before").color,
    );
    expect(colorA).toBe("rgb(74, 222, 128)");
    expect(colorB).toBe("rgb(74, 222, 128)");
  });

  test("instance A and B both have correct first-item color", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    const colorA = await items(a)
      .nth(0)
      .evaluate((el) => getComputedStyle(el).color);
    const colorB = await items(b)
      .nth(0)
      .evaluate((el) => getComputedStyle(el).color);
    expect(colorA).toBe("rgb(251, 191, 36)");
    expect(colorB).toBe("rgb(251, 191, 36)");
  });
});
