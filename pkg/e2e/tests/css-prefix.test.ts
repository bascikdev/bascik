/**
 * e2e tests for custom CSS minifiers/transformers (e.g. PostCSS / Autoprefixer vendor prefixing).
 *
 * Verifies that custom `minify.css` functions configured in `bascik.config.ts`:
 *   - process component styles (both .css files and inline <style> tags)
 *   - process page-level <style> tags in <head>
 *   - properly inject transformed CSS (such as -webkit- prefixes) into the final HTML output
 */
import { test, expect } from "@playwright/test";

test.describe("css-prefix-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-prefix-test");
  });

  test("custom minify.css transformer transforms page-level <style> tags in <head>", async ({
    page,
  }) => {
    const headStyles = await page.locator("head style").allInnerTexts();
    const joinedHeadStyles = headStyles.join("\n");
    expect(joinedHeadStyles).toContain("-webkit-user-select: none");
    expect(joinedHeadStyles).toContain("user-select: none");
  });

  test("custom minify.css transformer transforms component CSS", async ({
    page,
  }) => {
    const headStyles = await page.locator("head style").allInnerTexts();
    const joinedHeadStyles = headStyles.join("\n");
    expect(joinedHeadStyles).toContain(".bascik__css-prefix__no-select");
    expect(joinedHeadStyles).toContain("-webkit-user-select: none");
  });

  test("element styled with vendor prefix has userSelect CSS property applied in browser", async ({
    page,
  }) => {
    const el = page.locator(".bascik__css-prefix__no-select");
    const userSelect = await el.evaluate(
      (node) =>
        getComputedStyle(node).userSelect ||
        getComputedStyle(node).webkitUserSelect,
    );
    expect(userSelect).toBe("none");
  });

  test("custom BYOMinifier minify.js (esbuild) minifies inline scripts and executes cleanly", async ({
    page,
  }) => {
    const scriptContent = await page.locator("script").last().allInnerTexts();
    const joinedScript = scriptContent.join("\n");
    expect(joinedScript).not.toContain("// Comment that should be stripped");
    const attr = await page.locator("body").getAttribute("data-byo-js");
    expect(attr).toBe("BYOMinifier JS Active");
  });
});
