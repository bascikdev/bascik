/**
 * e2e tests for CSS @counter-style scoping.
 *
 * Verifies that @counter-style names are scoped in the compiled output,
 * preventing name collisions across components.
 */
import { test, expect } from "@playwright/test";

test.describe("css-counter-style-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-counter-style-test");
  });

  test("@counter-style name is scoped in the style tag", async ({ page }) => {
    const styleContent = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n"),
    );
    expect(styleContent).toContain(
      "@counter-style bascik__css-counter-style__counter__thumbs",
    );
    expect(styleContent).not.toContain("@counter-style thumbs");
  });

  test("list-style reference is scoped to match the @counter-style name", async ({
    page,
  }) => {
    const styleContent = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n"),
    );
    expect(styleContent).toContain(
      "list-style: bascik__css-counter-style__counter__thumbs",
    );
    expect(styleContent).not.toMatch(/list-style:\s*thumbs\b/);
  });

  test("custom list renders with scoped counter style", async ({ page }) => {
    const list = page
      .locator(".bascik__css-counter-style__custom-list")
      .first();
    await expect(list).toBeVisible();
    const items = list.locator(".bascik__css-counter-style__item");
    await expect(items).toHaveCount(3);
  });
});
