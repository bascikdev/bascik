/**
 * e2e tests for CSS @starting-style scoping.
 *
 * Verifies that class names inside @starting-style blocks are scoped
 * in the compiled output.
 */
import { test, expect } from "@playwright/test";

test.describe("css-starting-style-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-starting-style-test");
  });

  test("@starting-style block class names are scoped in the style tag", async ({
    page,
  }) => {
    const styleContent = await page.evaluate(() => {
      const styles = Array.from(document.querySelectorAll("style"));
      return styles.map((s) => s.textContent).join("\n");
    });
    expect(styleContent).toContain("@starting-style");
    expect(styleContent).toContain(".bascik__css-starting-style__box");
    expect(styleContent).not.toMatch(/@starting-style[^}]*\.box(?![\w-])/);
  });

  test("box element is present with scoped class", async ({ page }) => {
    const box = page.locator(".bascik__css-starting-style__box").first();
    await expect(box).toBeVisible();
  });

  test("both instances have scoped class", async ({ page }) => {
    const boxes = page.locator(".bascik__css-starting-style__box");
    await expect(boxes).toHaveCount(2);
  });
});
