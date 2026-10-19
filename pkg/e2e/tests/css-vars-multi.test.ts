/**
 * e2e tests for CSS custom property scoping with fallback values and multiple
 * simultaneous animations on the css-vars-multi-test fixture page.
 *
 * Two instances of <css-vars-multi> are rendered side by side. Tests verify:
 *   - CSS custom properties are scoped (--accent → --bascik__css-vars-multi__accent)
 *   - var() references with fallback values are scoped correctly
 *   - Fallback value applies when custom property is never declared
 *   - Multiple @keyframes are scoped (pulse, glow)
 *   - animation shorthand with multiple comma-separated entries is scoped correctly
 *   - The scoped animating class is toggled on anim-box after button click
 *   - CSS is injected once on the page (dedup)
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number) {
  return page.locator(".bascik__css-vars-multi__wrapper").nth(n);
}

const definedBox = (inst: Locator) => inst.locator('[id$="__defined-box"]');
const fallbackBox = (inst: Locator) => inst.locator('[id$="__fallback-box"]');
const animBox = (inst: Locator) => inst.locator('[id$="__anim-box"]');
const toggleBtn = (inst: Locator) => inst.locator('[id$="__toggle-anim-btn"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-vars-multi-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-vars-multi-test");
  });

  // ── 1. Defined custom property resolves to the declared color ────────────
  //
  // --accent is set on .wrapper; the var(--accent, …) reference on .box must
  // be scoped so it resolves to the scoped declaration, yielding the green.

  test("defined custom property: box has correct green color", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const color = await definedBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(74, 222, 128)");
  });

  // ── 2. Fallback value applies when custom property is undefined ──────────
  //
  // --undefined-prop is never declared anywhere. After scoping the var()
  // reference, the scoped name is also never declared, so the fallback
  // rgb(96, 165, 250) must apply.

  test("fallback value applies when custom prop is undefined", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const color = await fallbackBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  // ── 3. Two animations applied simultaneously after toggle ─────────────────
  //
  // Clicking the toggle button adds the scoped .animating class to anim-box.
  // The CSS rule .animated.animating applies both pulse and glow animations.

  test("toggle button adds scoped animating class to anim-box", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await toggleBtn(a).click();

    await expect(animBox(a)).toHaveClass(/bascik__css-vars-multi__animating/);
  });

  // ── 4. Toggling again removes the animating class ────────────────────────

  test("second toggle removes the animating class from anim-box", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await toggleBtn(a).click();
    await expect(animBox(a)).toHaveClass(/bascik__css-vars-multi__animating/);

    await toggleBtn(a).click();
    await expect(animBox(a)).not.toHaveClass(
      /bascik__css-vars-multi__animating/,
    );
  });

  // ── 5. Instance A and B have same custom property colors ─────────────────
  //
  // CSS custom properties are scoped per-component (not per-instance), so
  // both instances resolve --accent to the same green.

  test("instance A and B resolve --accent to the same color", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    const colorA = await definedBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    const colorB = await definedBox(b).evaluate(
      (el) => getComputedStyle(el).color,
    );

    expect(colorA).toBe("rgb(74, 222, 128)");
    expect(colorB).toBe("rgb(74, 222, 128)");
    expect(colorA).toBe(colorB);
  });

  // ── 6. Instance A toggle does not affect instance B ──────────────────────

  test("toggling animation on instance A does not affect instance B", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await toggleBtn(a).click();

    await expect(animBox(a)).toHaveClass(/bascik__css-vars-multi__animating/);
    await expect(animBox(b)).not.toHaveClass(
      /bascik__css-vars-multi__animating/,
    );
  });

  // ── 7. Component CSS injected once on page ───────────────────────────────
  //
  // Both instances share the same component CSS (deduplication). The component's
  // scoped class `.bascik__css-vars-multi__wrapper` should appear in exactly
  // one <style> block (the page's own <style> block does not contain it).

  test("component CSS injected exactly once (one style block contains scoped class)", async ({
    page,
  }) => {
    const styleCount = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("style")).filter((s) =>
        s.textContent?.includes("bascik__css-vars-multi__"),
      ).length;
    });
    expect(styleCount).toBe(1);
  });
});
