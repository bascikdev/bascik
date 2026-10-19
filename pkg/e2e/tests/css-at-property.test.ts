/**
 * e2e tests for CSS @property scoping.
 *
 * Verifies that @property --brand-color is scoped in the compiled CSS
 * output, and that the custom property value is applied correctly at runtime.
 */
import { test, expect } from "@playwright/test";

test.describe("css-at-property-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-at-property-test");
  });

  test("@property scoped name appears in page style tag", async ({ page }) => {
    const styleContent = await page.evaluate(() => {
      const styles = Array.from(document.querySelectorAll("style"));
      return styles.map((s) => s.textContent).join("\n");
    });
    // The @property --brand-color should be scoped
    expect(styleContent).toContain(
      "@property --bascik__css-at-property__brand-color",
    );
    expect(styleContent).not.toContain("@property --brand-color");
  });

  test("box has background color from the scoped @property", async ({
    page,
  }) => {
    const box = page.locator(".bascik__css-at-property__box").first();
    const bg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(74, 222, 128)");
  });

  test("both instances share the same scoped @property", async ({ page }) => {
    const boxes = page.locator(".bascik__css-at-property__box");
    const count = await boxes.count();
    expect(count).toBe(2);
    for (let i = 0; i < count; i++) {
      const bg = await boxes
        .nth(i)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe("rgb(74, 222, 128)");
    }
  });
});
