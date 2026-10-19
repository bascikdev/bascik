/**
 * e2e tests for JS/CSS scoping design decisions & HTML parsing boundaries.
 *
 * Verifies runtime behavior for:
 *   - JS DOM query scoping via regex (querySelector, getElementById)
 *   - JS comments and dynamic variable queries in template literals
 *   - Component tags inside HTML comments and script string literals
 *   - Code block preservation
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

function getInstance(page: Page, index: number): Locator {
  return page.locator(".bascik__scoping-boundary__boundary-wrapper").nth(index);
}

test.describe("scoping-boundary-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/scoping-boundary-test");
  });

  test("both component instances render button and output", async ({
    page,
  }) => {
    const inst0 = getInstance(page, 0);
    const inst1 = getInstance(page, 1);

    await expect(inst0.locator("button")).toHaveText("Click Me");
    await expect(inst1.locator("button")).toHaveText("Click Me");
  });

  test("clicking button updates output text via scoped selector and adds active class", async ({
    page,
  }) => {
    const inst0 = getInstance(page, 0);
    const btn = inst0.locator("button");
    const out = inst0.locator('[id$="__boundary-output"]');

    await expect(out).toHaveText("Ready");
    await btn.click();

    await expect(out).toHaveText("Clicked Successfully");
    await expect(btn).toHaveClass(/boundary-active/);
    await expect(out).toHaveAttribute("data-dynamic-unscoped", "true");
  });

  test("both instances operate independently without interfering with each other", async ({
    page,
  }) => {
    const inst0 = getInstance(page, 0);
    const inst1 = getInstance(page, 1);

    const btn0 = inst0.locator("button");
    const out0 = inst0.locator('[id$="__boundary-output"]');
    const out1 = inst1.locator('[id$="__boundary-output"]');

    await btn0.click();

    await expect(out0).toHaveText("Clicked Successfully");
    await expect(out1).toHaveText("Ready");
  });

  test("script literal containing custom tag is preserved without expanding into HTML", async ({
    page,
  }) => {
    const tagVal = await page.evaluate(
      () =>
        (window as unknown as { scriptLiteralTag: string }).scriptLiteralTag,
    );
    expect(tagVal).toBe("<scoping-boundary></scoping-boundary>");
  });

  test("code element inner content is preserved shielded", async ({ page }) => {
    const inst0 = getInstance(page, 0);
    const code = inst0.locator("code");
    await expect(code).toHaveText('data-bascik-prop-sample="literal"');
  });

  test("textarea raw text content is not rewritten by element/id/class/prop passes", async ({
    page,
  }) => {
    const inst0 = getInstance(page, 0);
    const textarea = inst0.locator("textarea");
    await expect(textarea).toHaveValue(
      '<button id="boundary-btn" class="boundary-box" data-bascik-prop-sample="x"></button>',
    );
  });

  test("short and prefix-overlapping class and CSS custom property names scope without clobbering", async ({
    page,
  }) => {
    const inst0 = getInstance(page, 0);
    const multi = inst0.getByTestId("boundary-multi-tokens");
    await expect(multi).toHaveAttribute(
      "class",
      "bascik__scoping-boundary__a bascik__scoping-boundary__b bascik__scoping-boundary__a-b",
    );
    await expect(multi).toHaveCSS("padding-left", "10px");
    await expect(multi).toHaveCSS("padding-right", "24px");
    await expect(multi).toHaveCSS("font-style", "italic");

    await inst0.locator("button").click();
    await expect(inst0.locator('[id$="__boundary-output"]')).toHaveAttribute(
      "data-multi-class-count",
      "2",
    );
  });

  test("root class/style merging preserves data-class and data-style attributes", async ({
    page,
  }) => {
    const inst0 = getInstance(page, 0);
    await expect(inst0).toHaveAttribute("data-class", "preserve-data-class");
    await expect(inst0).toHaveAttribute("data-style", "preserve-data-style");
    await expect(inst0).toHaveClass(
      /bascik__scoping-boundary__boundary-wrapper/,
    );
    await expect(inst0).toHaveClass(/passed-root-class/);
    await expect(inst0).toHaveAttribute("style", /outline-width:\s*2px/);
  });
});
