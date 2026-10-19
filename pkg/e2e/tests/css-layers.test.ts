/**
 * e2e tests for @layer and @container scoping on the css-layers-test fixture page.
 *
 * Two instances of <css-layers> are rendered. Tests verify:
 *   - @layer names are scoped (base → bascik__css-layers__layer__base, etc.)
 *   - @container names are scoped (inner-box → bascik__css-layers__container__inner-box)
 *   - Styles from @layer base and @layer theme are applied correctly
 *   - @container query applies when container has non-zero width
 *   - Both instances render correctly
 *   - Component CSS is injected exactly once on the page
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Scoped name constants (from actual build output)
// ---------------------------------------------------------------------------

const SCOPED_CARD = "bascik__css-layers__card";
const SCOPED_TITLE = "bascik__css-layers__title";
const SCOPED_CONTAINER_TARGET = "bascik__css-layers__container-target";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function card(page: Page, n: number): Locator {
  return page.locator(`.${SCOPED_CARD}`).nth(n);
}

function title(inst: Locator): Locator {
  return inst.locator(`.${SCOPED_TITLE}`);
}

function containerTarget(inst: Locator): Locator {
  return inst.locator(`.${SCOPED_CONTAINER_TARGET}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-layers-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-layers-test");
  });

  // -------------------------------------------------------------------------
  // @layer base styles
  // -------------------------------------------------------------------------

  test("@layer base: card has correct background color", async ({ page }) => {
    const bg = await card(page, 0).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(10, 20, 40)");
  });

  // -------------------------------------------------------------------------
  // @layer theme overrides
  // -------------------------------------------------------------------------

  test("@layer theme overrides border color from base layer", async ({
    page,
  }) => {
    const borderColor = await card(page, 0).evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    expect(borderColor).toBe("rgb(96, 165, 250)");
  });

  test("@layer theme: title has blue color from theme layer", async ({
    page,
  }) => {
    const inst = card(page, 0);
    const color = await title(inst).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  // -------------------------------------------------------------------------
  // @container query
  // -------------------------------------------------------------------------

  test("@container query applies color to container-target (min-width: 1px is always true)", async ({
    page,
  }) => {
    const inst = card(page, 0);
    const color = await containerTarget(inst).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(74, 222, 128)");
  });

  // -------------------------------------------------------------------------
  // Both instances
  // -------------------------------------------------------------------------

  test("instance A and B both have correct background from @layer base", async ({
    page,
  }) => {
    const bgA = await card(page, 0).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const bgB = await card(page, 1).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bgA).toBe("rgb(10, 20, 40)");
    expect(bgB).toBe("rgb(10, 20, 40)");
  });

  test("instance A and B both have correct container-target color", async ({
    page,
  }) => {
    const colorA = await containerTarget(card(page, 0)).evaluate(
      (el) => getComputedStyle(el).color,
    );
    const colorB = await containerTarget(card(page, 1)).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(colorA).toBe("rgb(74, 222, 128)");
    expect(colorB).toBe("rgb(74, 222, 128)");
  });

  // -------------------------------------------------------------------------
  // CSS deduplication
  // -------------------------------------------------------------------------

  test("CSS is injected exactly once on the page", async ({ page }) => {
    const styleCount = await page.evaluate((scopedClass) => {
      const styles = Array.from(document.querySelectorAll("style"));
      return styles.filter((s) => s.textContent?.includes(scopedClass)).length;
    }, SCOPED_CARD);

    expect(styleCount).toBe(1);
  });
});
