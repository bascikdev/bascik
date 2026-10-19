/**
 * e2e tests for @supports scoping and multi-script-block IIFE isolation
 * on the css-supports-test fixture page.
 *
 * Two instances of <css-supports> are rendered. Tests verify:
 *   - @supports (display: grid) applies scoped selectors inside the rule
 *   - @supports not (display: masonry) applies scoped selectors inside the rule
 *   - The @supports condition itself is NOT scoped (it's a feature query)
 *   - Multiple <script> blocks are each wrapped in their own IIFE
 *   - Variables declared in block 1 are NOT accessible from block 2
 *   - Both instances are independent of each other
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number): Locator {
  return page.locator(".bascik__css-supports__wrapper").nth(n);
}

const result = (inst: Locator) => inst.locator('[id$="__script-result"]');
const btn = (inst: Locator, suffix: string) =>
  inst.locator(`[id$="__${suffix}"]`);
const fallback = (inst: Locator) =>
  inst.locator(".bascik__css-supports__fallback");
const gridLayout = (inst: Locator) =>
  inst.locator(".bascik__css-supports__grid-layout");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-supports-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-supports-test");
  });

  // ── 1. @supports (display: grid) ─────────────────────────────────────────
  //
  // All modern browsers support CSS grid, so the @supports block should apply
  // and the grid-layout element should have display: grid.

  test("@supports(display:grid): grid-layout uses CSS grid", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    const display = await gridLayout(inst).evaluate(
      (el) => getComputedStyle(el).display,
    );
    expect(display).toBe("grid");
  });

  // ── 2. @supports not (display: masonry) ──────────────────────────────────
  //
  // CSS masonry display is not yet supported in stable browsers, so
  // `@supports not (display: masonry)` should apply and the fallback element
  // should have the correct green color.

  test("@supports not (display:masonry): fallback has correct color", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    const color = await fallback(inst).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(74, 222, 128)");
  });

  // ── 3. Block 1 var accessible within block 1 ─────────────────────────────
  //
  // Script block 1 declares `block1Var` and wires a click handler that reads
  // it. Clicking the block1 button should show the value from block 1's IIFE.

  test("block1 script var is accessible in block1", async ({ page }) => {
    const inst = getInstance(page, 0);
    await btn(inst, "check-block1-btn").click();
    await expect(result(inst)).toHaveText("block1: from-block-1");
  });

  // ── 4. Block 2 var accessible within block 2 ─────────────────────────────
  //
  // Script block 2 declares `block2Var` and wires a click handler that reads
  // it. Clicking the block2 button should show the value from block 2's IIFE.

  test("block2 script var is accessible in block2", async ({ page }) => {
    const inst = getInstance(page, 0);
    await btn(inst, "check-block2-btn").click();
    await expect(result(inst)).toHaveText("block2: from-block-2");
  });

  // ── 5. Block 1 var NOT accessible from block 2 ───────────────────────────
  //
  // Each <script> block is wrapped in its own IIFE. `block1Var` declared in
  // block 1 is scoped to that closure; `typeof block1Var` in block 2 returns
  // "undefined" (no ReferenceError because typeof is used safely).

  test("block1 var is NOT accessible from block2 (IIFE isolation)", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    await btn(inst, "check-cross-btn").click();
    const text = await result(inst).textContent();
    // Either "cross: undefined" (typeof guard) or "cross: ReferenceError" —
    // both are acceptable; the critical assertion is it does NOT show "from-block-1".
    expect(text).toMatch(/^cross: (undefined|ReferenceError)$/);
    expect(text).not.toContain("from-block-1");
  });

  // ── 6. Instance A and B are independent ──────────────────────────────────
  //
  // Clicking block1 in instance A should update A's result but leave B untouched.

  test("instance A and B are independent", async ({ page }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await btn(a, "check-block1-btn").click();

    await expect(result(a)).toHaveText("block1: from-block-1");
    await expect(result(b)).toHaveText("No result");
  });

  // ── 7. Both instances render @supports styles ────────────────────────────

  test("instance A and B both have grid display from @supports", async ({
    page,
  }) => {
    const displayA = await gridLayout(getInstance(page, 0)).evaluate(
      (el) => getComputedStyle(el).display,
    );
    const displayB = await gridLayout(getInstance(page, 1)).evaluate(
      (el) => getComputedStyle(el).display,
    );
    expect(displayA).toBe("grid");
    expect(displayB).toBe("grid");
  });

  // ── 8. CSS is injected exactly once on the page ──────────────────────────

  test("CSS is injected exactly once on the page", async ({ page }) => {
    const styleCount = await page.evaluate((scopedClass) => {
      const styles = Array.from(document.querySelectorAll("style"));
      return styles.filter((s) => s.textContent?.includes(scopedClass)).length;
    }, "bascik__css-supports__wrapper");

    expect(styleCount).toBe(1);
  });
});
