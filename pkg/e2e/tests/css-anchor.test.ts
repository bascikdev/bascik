/**
 * e2e tests for CSS anchor-name / @position-try scoping.
 *
 * Verifies that anchor names declared with anchor-name are scoped in the
 * compiled output, preventing collision between component instances.
 * Tests focus on CSS string output rather than visual anchor rendering.
 */
import { test, expect } from "@playwright/test";

test.describe("css-anchor-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-anchor-test");
  });

  test("anchor-name declaration is scoped in the style tag", async ({
    page,
  }) => {
    const styleContent = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n"),
    );
    expect(styleContent).toContain(
      "anchor-name: --bascik__css-anchor__anchor__my-anchor",
    );
    expect(styleContent).not.toMatch(/anchor-name:\s*--my-anchor\b/);
  });

  test("position-anchor reference is scoped to match the declaration", async ({
    page,
  }) => {
    const styleContent = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n"),
    );
    expect(styleContent).toContain(
      "position-anchor: --bascik__css-anchor__anchor__my-anchor",
    );
    expect(styleContent).not.toMatch(/position-anchor:\s*--my-anchor\b/);
  });

  test("@position-try name is scoped to match the declaration", async ({
    page,
  }) => {
    const styleContent = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent)
        .join("\n"),
    );
    expect(styleContent).toContain(
      "@position-try --bascik__css-anchor__anchor__my-anchor",
    );
    expect(styleContent).not.toContain("@position-try --my-anchor");
  });

  test("anchor button element is present with scoped class", async ({
    page,
  }) => {
    const btn = page.locator(".bascik__css-anchor__anchor-btn").first();
    await expect(btn).toBeVisible();
  });
});
