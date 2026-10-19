/**
 * e2e tests for :nth-child(An+B of .selector) CSS scoping.
 *
 * Verifies that class names in :nth-child() 'of' arguments are scoped.
 */
import { test, expect } from "@playwright/test";

test.describe("css-nth-child-of-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-nth-child-of-test");
  });

  test("style tag contains scoped :nth-child(of .item) selector", async ({
    page,
  }) => {
    const styleContent = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n");
    });
    expect(styleContent).toContain(
      "nth-child(odd of .bascik__css-nth-child-of__item)",
    );
    expect(styleContent).not.toMatch(/nth-child\(odd of \.item\b/);
  });

  test("odd .item elements have the highlighted background color", async ({
    page,
  }) => {
    const firstInstance = page
      .locator(".bascik__css-nth-child-of__list")
      .first();
    const items = firstInstance.locator(".bascik__css-nth-child-of__item");
    // Items 1, 3, 5 (0-indexed: 0, 2, 4) should be highlighted
    const bg1 = await items
      .nth(0)
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg1).toBe("rgb(74, 222, 128)");
    const bg2 = await items
      .nth(1)
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg2).toBe("rgb(30, 30, 30)");
  });
});
