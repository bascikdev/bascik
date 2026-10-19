/**
 * e2e tests for CSS transition scoping on the css-transition-test fixture page.
 *
 * Two instances of <css-transition> are rendered side by side. The component
 * toggles an `.active` class on a box element via buttons. bascik scopes:
 *   - class names:        `.box`, `.active` → `.bascik__css-transition__box`, etc.
 *   - compound selector:  `.box.active`     → `.bascik__css-transition__box.bascik__css-transition__active`
 *   - classList mutation: `classList.add("active")` → `classList.add("bascik__css-transition__active")`
 *   - transition property is preserved as-is (no scoping needed)
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable (e.g. `bascik__css-transition__wrapper`).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number) {
  return page.locator(".bascik__css-transition__wrapper").nth(n);
}

const bx = (inst: Locator) => inst.locator('[id$="__box"]');
const btn = (inst: Locator, suffix: string) =>
  inst.locator(`[id$="__${suffix}"]`);
const statusEl = (inst: Locator) => inst.locator('[id$="__status"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-transition-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-transition-test");
  });

  // ── 1. Initial background ────────────────────────────────────────────────

  test("box starts with default background", async ({ page }) => {
    const a = getInstance(page, 0);
    const box = bx(a);

    const bg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(30, 30, 30)");
  });

  // ── 2. Activate adds scoped .active class ────────────────────────────────

  test("clicking activate-btn applies .active class", async ({ page }) => {
    const a = getInstance(page, 0);

    await btn(a, "activate-btn").click();

    await expect(bx(a)).toHaveClass(/bascik__css-transition__active/);
  });

  // ── 3. Active state background ───────────────────────────────────────────

  test("after activation, box has green background", async ({ page }) => {
    const a = getInstance(page, 0);
    await btn(a, "activate-btn").click();
    // Wait for CSS transition (0.1s) to finish via transitionend, with 300ms fallback
    await bx(a).evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          el.addEventListener("transitionend", () => resolve(), { once: true });
          setTimeout(resolve, 300);
        }),
    );
    const bg = await bx(a).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(22, 101, 52)");
  });

  // ── 4. Deactivate removes .active class ──────────────────────────────────

  test("clicking deactivate-btn removes .active class", async ({ page }) => {
    const a = getInstance(page, 0);

    await btn(a, "activate-btn").click();
    await expect(bx(a)).toHaveClass(/bascik__css-transition__active/);

    await btn(a, "deactivate-btn").click();

    await expect(bx(a)).not.toHaveClass(/bascik__css-transition__active/);
  });

  // ── 5. Default background restored after deactivation ───────────────────

  test("after deactivation, box returns to default background", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await btn(a, "activate-btn").click();
    await expect(statusEl(a)).toHaveText("active");
    await btn(a, "deactivate-btn").click();
    await expect(statusEl(a)).toHaveText("idle");
    // Wait for transition back to default to complete
    await bx(a).evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          el.addEventListener("transitionend", () => resolve(), { once: true });
          setTimeout(resolve, 300);
        }),
    );
    const bg = await bx(a).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(30, 30, 30)");
  });

  // ── 6. Instance isolation ────────────────────────────────────────────────

  test("instance A toggle does not affect instance B", async ({ page }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await btn(a, "activate-btn").click();

    // A is active, B remains in idle state
    await expect(bx(a)).toHaveClass(/bascik__css-transition__active/);
    await expect(bx(b)).not.toHaveClass(/bascik__css-transition__active/);
    await expect(statusEl(b)).toHaveText("idle");
  });
});
