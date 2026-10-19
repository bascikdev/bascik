/**
 * e2e tests for bascik 3-level deep nested component rendering.
 *
 * The fixture uses a chain: level-a > level-b > level-c.
 *
 * Two instances of <level-a> are rendered on the page.
 * Each <level-a> contains two <level-b> panels (one with a prop, one fallback).
 * Each <level-b> contains two <level-c> chips (one with a prop, one fallback).
 *
 * Tests verify:
 *   - All three scoped namespaces exist independently (level-a, level-b, level-c)
 *   - Props are threaded at every level of the nesting chain
 *   - Self-closing tags work at each level
 *   - Fallback content is rendered when no prop is passed
 *   - CSS scoping is applied at each level (background colors)
 *   - Instances at the same level are independent (no prop bleed-through)
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function levelA(page: Page, n: number): Locator {
  return page.locator(".bascik__level-a__page-section").nth(n);
}

function levelB(a: Locator): Locator {
  return a.locator(".bascik__level-b__panel");
}

function levelC(b: Locator): Locator {
  return b.locator(".bascik__level-c__chip");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("deep-nesting-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/deep-nesting-test");
  });

  // -------------------------------------------------------------------------
  // Level-a structure
  // -------------------------------------------------------------------------

  test("two level-a sections exist", async ({ page }) => {
    await expect(page.locator(".bascik__level-a__page-section")).toHaveCount(2);
  });

  test('level-a section 1: heading prop "First Section"', async ({ page }) => {
    await expect(
      levelA(page, 0).locator(".bascik__level-a__section-title"),
    ).toHaveText("First Section");
  });

  test('level-a section 2: heading prop "Second Section"', async ({ page }) => {
    await expect(
      levelA(page, 1).locator(".bascik__level-a__section-title"),
    ).toHaveText("Second Section");
  });

  test("level-a sections have independent headings", async ({ page }) => {
    const title1 = levelA(page, 0).locator(".bascik__level-a__section-title");
    const title2 = levelA(page, 1).locator(".bascik__level-a__section-title");
    await expect(title1).not.toHaveText("Second Section");
    await expect(title2).not.toHaveText("First Section");
  });

  // -------------------------------------------------------------------------
  // Level-b structure inside level-a
  // -------------------------------------------------------------------------

  test("level-a section 1 contains 2 level-b panels", async ({ page }) => {
    await expect(levelB(levelA(page, 0))).toHaveCount(2);
  });

  test("level-a section 2 contains 2 level-b panels", async ({ page }) => {
    await expect(levelB(levelA(page, 1))).toHaveCount(2);
  });

  test('first panel in level-a[0] has label prop "Panel from A"', async ({
    page,
  }) => {
    const panel = levelB(levelA(page, 0)).nth(0);
    await expect(panel.locator(".bascik__level-b__panel-header")).toHaveText(
      "Panel from A",
    );
  });

  test('second panel in level-a[0] has fallback label "Panel Label"', async ({
    page,
  }) => {
    const panel = levelB(levelA(page, 0)).nth(1);
    await expect(panel.locator(".bascik__level-b__panel-header")).toHaveText(
      "Panel Label",
    );
  });

  // -------------------------------------------------------------------------
  // Level-c structure inside level-b
  // -------------------------------------------------------------------------

  test("each level-b panel contains 2 level-c chips", async ({ page }) => {
    const panels = levelB(levelA(page, 0));
    await expect(levelC(panels.nth(0))).toHaveCount(2);
    await expect(levelC(panels.nth(1))).toHaveCount(2);
  });

  test('first chip in first panel shows "chip-from-b" (prop from level-b)', async ({
    page,
  }) => {
    const firstPanel = levelB(levelA(page, 0)).nth(0);
    await expect(levelC(firstPanel).nth(0)).toHaveText("chip-from-b");
  });

  test('second chip in first panel shows "default-c" (fallback)', async ({
    page,
  }) => {
    const firstPanel = levelB(levelA(page, 0)).nth(0);
    await expect(levelC(firstPanel).nth(1)).toHaveText("default-c");
  });

  test('first chip in second panel shows "chip-from-b" (prop from level-b)', async ({
    page,
  }) => {
    const secondPanel = levelB(levelA(page, 0)).nth(1);
    await expect(levelC(secondPanel).nth(0)).toHaveText("chip-from-b");
  });

  test('second chip in second panel shows "default-c" (fallback)', async ({
    page,
  }) => {
    const secondPanel = levelB(levelA(page, 0)).nth(1);
    await expect(levelC(secondPanel).nth(1)).toHaveText("default-c");
  });

  // -------------------------------------------------------------------------
  // CSS scoping — level-a
  // -------------------------------------------------------------------------

  test("level-a CSS applied: page-section has correct background color", async ({
    page,
  }) => {
    const bg = await levelA(page, 0).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(5, 15, 5)");
  });

  // -------------------------------------------------------------------------
  // CSS scoping — level-b
  // -------------------------------------------------------------------------

  test("level-b CSS applied: panel has correct background color", async ({
    page,
  }) => {
    const panel = levelB(levelA(page, 0)).nth(0);
    const bg = await panel.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(8, 28, 69)");
  });

  // -------------------------------------------------------------------------
  // CSS scoping — level-c
  // -------------------------------------------------------------------------

  test("level-c CSS applied: chip has correct background color", async ({
    page,
  }) => {
    const chip = levelC(levelB(levelA(page, 0)).nth(0)).nth(0);
    const bg = await chip.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(74, 4, 78)");
  });
});
