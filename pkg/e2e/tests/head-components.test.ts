/**
 * e2e tests for head component injection on the head-test fixture page.
 *
 * bascik detects components whose content consists only of head-valid elements
 * (<meta>, <link>, <title>, etc.) and injects them directly into the page
 * <head> instead of the <body>.
 *
 * NOTE: Props on void elements (<meta>, <link>) do not apply, because the
 * bascik prop system replaces an element's *inner text content* — void
 * elements have none. As a result, data-bascik-prop-* markers on <meta> and
 * <link> are stripped from the output but the prop value is NOT substituted
 * into any attribute. The default attribute values defined in the component
 * template are preserved as-is.
 */
import { test, expect } from "@playwright/test";

test.describe("head-test page — head component injection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/head-test");
  });

  test("meta viewport is injected into <head>", async ({ page }) => {
    const meta = page.locator('head meta[name="viewport"]');
    await expect(meta).toHaveAttribute(
      "content",
      "width=device-width, initial-scale=1",
    );
  });

  test("meta author is injected into <head>", async ({ page }) => {
    const meta = page.locator('head meta[name="author"]');
    await expect(meta).toHaveAttribute("content", "Bascik E2E Test");
  });

  test("meta description is injected into <head> with default value (props do not apply to void elements)", async ({
    page,
  }) => {
    const meta = page.locator('head meta[name="description"]');
    // Props on void elements are not applied — the template default is used.
    await expect(meta).toHaveAttribute("content", "Default description");
  });

  test("canonical link is injected into <head> with default href (props do not apply to void elements)", async ({
    page,
  }) => {
    const link = page.locator('head link[rel="canonical"]');
    await expect(link).toHaveAttribute("href", "https://example.com");
  });

  test("component content is not duplicated in <body>", async ({ page }) => {
    // None of the injected meta/link elements should appear inside <body>
    await expect(page.locator('body meta[name="viewport"]')).toHaveCount(0);
    await expect(page.locator('body meta[name="author"]')).toHaveCount(0);
    await expect(page.locator('body meta[name="description"]')).toHaveCount(0);
    await expect(page.locator('body link[rel="canonical"]')).toHaveCount(0);
  });

  test("page body content is present", async ({ page }) => {
    await expect(page.locator("h1")).toHaveText("Head Component Test");
    await expect(page.locator("p")).toHaveText(
      "Testing that head components inject into the document head.",
    );
  });
});
