/**
 * e2e tests for SVG class scoping on the svg-test fixture page.
 *
 * Two instances of <svg-test> are rendered side by side. Tests verify:
 *   - Class attributes on SVG root elements are scoped
 *   - Class attributes on SVG child elements (circle, path, rect, text) are scoped
 *   - CSS rules targeting SVG elements via scoped class names are applied
 *   - JS classList.toggle/remove on an SVG element uses scoped class names
 *   - Instance A interactions do not affect Instance B (isolation)
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__svg-test__wrapper").nth(0),
    b: page.locator(".bascik__svg-test__wrapper").nth(1),
  };
}

function icon(inst: Locator) {
  return inst.locator('[id$="__main-icon"]');
}
function bgCircle(inst: Locator) {
  return inst.locator(".bascik__svg-test__bg-circle");
}
function checkPath(inst: Locator) {
  return inst.locator(".bascik__svg-test__check-path");
}
function fillBar(inst: Locator) {
  return inst.locator('[id$="__fill-bar"]');
}
function status(inst: Locator) {
  return inst.locator('[id$="__status"]');
}

function btn(inst: Locator, idSuffix: string) {
  return inst.locator(`[id$="__${idSuffix}"]`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("svg-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/svg-test");
  });

  // ── 1. SVG root element scoping ─────────────────────────────────────────

  test("SVG root element has scoped class", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(icon(a)).toHaveClass(/bascik__svg-test__icon/);
  });

  // ── 2. SVG child element scoping ─────────────────────────────────────────

  test("SVG child circle has scoped class", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(bgCircle(a)).toHaveCount(1);
    await expect(bgCircle(a)).toHaveClass(/bascik__svg-test__bg-circle/);
  });

  test("SVG child path has scoped class", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(checkPath(a)).toHaveCount(1);
    await expect(checkPath(a)).toHaveClass(/bascik__svg-test__check-path/);
  });

  // ── 3. CSS targeting SVG elements by scoped class ────────────────────────

  test("CSS targeting SVG by class: bg-circle has correct fill color", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    const fill = await bgCircle(a).evaluate((el) => getComputedStyle(el).fill);
    expect(fill).toBe("rgb(14, 30, 14)");
  });

  test("CSS targeting SVG by class: check-path has correct stroke color", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    const stroke = await checkPath(a).evaluate(
      (el) => getComputedStyle(el).stroke,
    );
    expect(stroke).toBe("rgb(74, 222, 128)");
  });

  test("CSS targeting SVG by class: indicator-bar has correct fill color", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    const indicatorBar = a.locator(".bascik__svg-test__indicator-bar");
    const fill = await indicatorBar.evaluate((el) => getComputedStyle(el).fill);
    expect(fill).toBe("rgb(96, 165, 250)");
  });

  // ── 4. JS classList.toggle on SVG element ───────────────────────────────

  test("toggle-active-btn: adds scoped active class to SVG icon", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "toggle-active-btn").click();
    await expect(icon(a)).toHaveClass(/bascik__svg-test__active/);
    await expect(status(a)).toHaveText("active: true");
  });

  test("toggle-active-btn: removes scoped active class on second click", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "toggle-active-btn").click();
    await btn(a, "toggle-active-btn").click();
    await expect(icon(a)).not.toHaveClass(/bascik__svg-test__active/);
    await expect(status(a)).toHaveText("active: false");
  });

  // ── 5. fill-btn updates SVG attribute ───────────────────────────────────

  test("fill-btn: updates fill-bar width attribute", async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, "fill-btn").click();
    await expect(fillBar(a)).toHaveAttribute("width", "75");
    await expect(status(a)).toHaveText("filled to 75%");
  });

  // ── 6. reset-btn ────────────────────────────────────────────────────────

  test("reset-btn: clears active class and resets fill-bar width", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    // Set up state first.
    await btn(a, "fill-btn").click();
    await btn(a, "toggle-active-btn").click();
    await expect(icon(a)).toHaveClass(/bascik__svg-test__active/);
    await expect(fillBar(a)).toHaveAttribute("width", "75");
    // Reset.
    await btn(a, "reset-btn").click();
    await expect(icon(a)).not.toHaveClass(/bascik__svg-test__active/);
    await expect(fillBar(a)).toHaveAttribute("width", "0");
    await expect(status(a)).toHaveText("reset");
  });

  // ── 7. Instance isolation ────────────────────────────────────────────────

  test("instance isolation: toggling active on A does not affect B icon", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await btn(a, "toggle-active-btn").click();
    await expect(icon(a)).toHaveClass(/bascik__svg-test__active/);
    await expect(icon(b)).not.toHaveClass(/bascik__svg-test__active/);
  });

  test("instance isolation: filling bar on A does not affect B fill-bar", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await btn(a, "fill-btn").click();
    await expect(fillBar(a)).toHaveAttribute("width", "75");
    await expect(fillBar(b)).toHaveAttribute("width", "0");
  });
});
