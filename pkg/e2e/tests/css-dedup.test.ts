/**
 * e2e tests for CSS deduplication on the dedup-test fixture page.
 *
 * Four instances of <dedup-box> are rendered on the page. bascik's
 * `deduplicateCss` feature (enabled by default) ensures the component's CSS
 * is injected into the page only once, regardless of how many instances are
 * present.
 *
 * Tests verify:
 *   - The component's scoped CSS appears in exactly one <style> block
 *   - All four instances share the same scoped class names
 *   - Each instance renders its prop label correctly
 *   - The correct background and label colors are applied to every instance
 */
import { test, expect } from "@playwright/test";

const SCOPED_BOX = "bascik__dedup-box__box";
const SCOPED_LABEL = "bascik__dedup-box__label";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("dedup-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dedup-test");
  });

  // -------------------------------------------------------------------------
  // CSS injection count
  // -------------------------------------------------------------------------

  test("CSS for dedup-box is injected exactly once on the page", async ({
    page,
  }) => {
    const styleCount = await page.evaluate((scopedClass) => {
      const styles = Array.from(document.querySelectorAll("style"));
      return styles.filter((s) => s.textContent?.includes(scopedClass)).length;
    }, SCOPED_BOX);

    expect(styleCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Shared class names (deduplication means per-component, not per-instance)
  // -------------------------------------------------------------------------

  test("all 4 instances share the same scoped box class", async ({ page }) => {
    const boxes = page.locator(`.${SCOPED_BOX}`);
    await expect(boxes).toHaveCount(4);

    for (let i = 0; i < 4; i++) {
      await expect(boxes.nth(i)).toHaveClass(new RegExp(SCOPED_BOX));
    }
  });

  test("all 4 instances share the same scoped label class", async ({
    page,
  }) => {
    const labels = page.locator(`.${SCOPED_LABEL}`);
    await expect(labels).toHaveCount(4);

    for (let i = 0; i < 4; i++) {
      await expect(labels.nth(i)).toHaveClass(new RegExp(SCOPED_LABEL));
    }
  });

  // -------------------------------------------------------------------------
  // Visual appearance — CSS is actually applied
  // -------------------------------------------------------------------------

  test("all 4 instances have the correct background color", async ({
    page,
  }) => {
    const boxes = page.locator(`.${SCOPED_BOX}`);

    for (let i = 0; i < 4; i++) {
      const bg = await boxes
        .nth(i)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe("rgb(30, 58, 95)");
    }
  });

  test("all 4 instances have the correct label color", async ({ page }) => {
    const labels = page.locator(`.${SCOPED_LABEL}`);

    for (let i = 0; i < 4; i++) {
      const color = await labels
        .nth(i)
        .evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe("rgb(96, 165, 250)");
    }
  });

  // -------------------------------------------------------------------------
  // Prop rendering
  // -------------------------------------------------------------------------

  test("prop labels are rendered correctly in each instance", async ({
    page,
  }) => {
    const labels = page.locator(`.${SCOPED_LABEL}`);

    await expect(labels.nth(0)).toHaveText("One");
    await expect(labels.nth(1)).toHaveText("Two");
    await expect(labels.nth(2)).toHaveText("Three");
    await expect(labels.nth(3)).toHaveText("Four");
  });
});
