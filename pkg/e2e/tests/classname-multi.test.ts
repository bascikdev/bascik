/**
 * e2e tests for className multi-class rewriting.
 *
 * Two instances of <classname-multi> are rendered side by side. Tests cover:
 *   1. Multi-class className setter  — all space-separated known classes scoped
 *   2. className += append           — the appended literal class is scoped
 *   3. Template literal className    — bascik does NOT scope template literals;
 *                                      the assignment is left as-is so scoped
 *                                      CSS rules never fire
 *   4. Cross-instance isolation      — Instance A changes must not affect B
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__classname-multi__wrapper").nth(0),
    b: page.locator(".bascik__classname-multi__wrapper").nth(1),
  };
}

function bx(inst: Locator) {
  return inst.locator('[id$="__target-box"]');
}
function btn(inst: Locator, idSuffix: string) {
  return inst.locator(`[id$="__${idSuffix}"]`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("classname-multi page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/classname-multi-test");
  });

  // ── 1. Multi-class className setter ──────────────────────────────────────

  test("multi-class setter: all known classes are scoped (active + highlighted applied)", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "multi-class-btn").click();
    await expect(bx(a)).toHaveClass(/bascik__classname-multi__active/);
    await expect(bx(a)).toHaveClass(/bascik__classname-multi__highlighted/);
  });

  test("multi-class setter: correct active background color", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "multi-class-btn").click();
    await expect(bx(a)).toHaveCSS("background-color", "rgb(22, 101, 52)");
  });

  test("multi-class setter: highlighted border width applied", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "multi-class-btn").click();
    await expect(bx(a)).toHaveCSS("border-top-width", "3px");
  });

  // ── 2. Reset ──────────────────────────────────────────────────────────────

  test("reset restores box to single scoped class only", async ({ page }) => {
    const { a } = getInstances(page);
    // Add classes first.
    await btn(a, "multi-class-btn").click();
    await expect(bx(a)).toHaveClass(/bascik__classname-multi__active/);
    // Reset.
    await btn(a, "reset-btn").click();
    await expect(bx(a)).not.toHaveClass(/active/);
    await expect(bx(a)).not.toHaveClass(/highlighted/);
    await expect(bx(a)).toHaveClass(/bascik__classname-multi__box/);
  });

  // ── 3. className += ───────────────────────────────────────────────────────

  test("className += appends the scoped active class", async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, "append-btn").click();
    await expect(bx(a)).toHaveClass(/bascik__classname-multi__active/);
  });

  test("className +=: box has correct active background after append", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "append-btn").click();
    await expect(bx(a)).toHaveCSS("background-color", "rgb(22, 101, 52)");
  });

  // ── 4. Template literal ───────────────────────────────────────────────────

  /**
   * Bascik does NOT scope template literal className assignments.
   * The JS is left verbatim:  box.className = `box featured ${extra}`;
   * So the box ends up with the raw unscoped class "featured" (not
   * "bascik__classname-multi__featured"). The scoped CSS rule
   * `.bascik__classname-multi__box.bascik__classname-multi__featured`
   * therefore never matches — the border-color style is NOT applied.
   *
   * This test documents the limitation rather than asserting ideal behavior.
   */
  test("template literal: featured class is NOT scoped (known limitation)", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "template-btn").click();
    // The box should NOT have the scoped featured class.
    await expect(bx(a)).not.toHaveClass(/bascik__classname-multi__featured/);
    // The scoped CSS rule does not match, so the featured border color is absent.
    await expect(bx(a)).not.toHaveCSS("border-color", "rgb(167, 139, 250)");
  });

  // ── 5. Cross-instance isolation ───────────────────────────────────────────

  test("instance A multi-class change does not affect instance B", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await btn(a, "multi-class-btn").click();
    await expect(bx(a)).toHaveClass(/bascik__classname-multi__active/);
    await expect(bx(b)).not.toHaveClass(/active/);
    await expect(bx(b)).not.toHaveClass(/highlighted/);
  });

  test("instance A className += change does not affect instance B", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await btn(a, "append-btn").click();
    await expect(bx(a)).toHaveClass(/bascik__classname-multi__active/);
    await expect(bx(b)).not.toHaveClass(/active/);
  });
});
