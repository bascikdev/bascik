/**
 * e2e tests for CSS view-transition-name scoping.
 *
 * Verifies that view-transition-name values are scoped in the compiled output,
 * preventing name collisions between components.
 */
import { test, expect } from "@playwright/test";

test.describe("css-view-transition-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-view-transition-test");
  });

  test("view-transition-name is scoped in the style tag", async ({ page }) => {
    const styleContent = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n"),
    );
    expect(styleContent).toContain(
      "view-transition-name: bascik__css-view-transition__vtn__my-card",
    );
    expect(styleContent).not.toMatch(/view-transition-name:\s*my-card\b/);
  });

  test("::view-transition-old pseudo-element reference is scoped", async ({
    page,
  }) => {
    const styleContent = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n"),
    );
    expect(styleContent).toContain(
      "view-transition-old(bascik__css-view-transition__vtn__my-card)",
    );
    expect(styleContent).not.toContain("view-transition-old(my-card)");
  });

  test("::view-transition-new pseudo-element reference is scoped", async ({
    page,
  }) => {
    const styleContent = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n"),
    );
    expect(styleContent).toContain(
      "view-transition-new(bascik__css-view-transition__vtn__my-card)",
    );
  });

  test("card element renders with correct background", async ({ page }) => {
    const card = page.locator(".bascik__css-view-transition__card").first();
    await expect(card).toBeVisible();
    const bg = await card.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(74, 222, 128)");
  });
});
