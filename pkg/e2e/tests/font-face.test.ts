/**
 * e2e tests for @font-face in component CSS.
 *
 * Bascik behavior (from compat doc — ⚠️ Partially supported):
 *   - `@font-face` blocks are passed through UNTOUCHED — not scoped.
 *   - The `font-family` name in the declaration stays as-is: "CompFont"
 *     (not renamed to e.g. "bascik__font-face-test__CompFont").
 *   - The `font-family` VALUE in property rules is also left as-is: "CompFont".
 *   - The class SELECTOR is scoped normally:
 *       `.custom-font-text` → `.bascik__font-face-test__custom-font-text`
 *   - Because both the @font-face declaration and the font-family reference
 *     use the same unscoped name "CompFont", the font resolves correctly.
 *   - The font-family name is effectively global — if two components declare
 *     a different @font-face with the same name, they would collide.
 *
 * Component uses `local("Courier New")` as the font source so no network
 * request is required during testing.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__font-face-test__wrapper").nth(0),
    b: page.locator(".bascik__font-face-test__wrapper").nth(1),
  };
}

function customText(inst: Locator) {
  return inst.locator(".bascik__font-face-test__custom-font-text");
}

function regularText(inst: Locator) {
  return inst.locator(".bascik__font-face-test__regular-text");
}

function info(inst: Locator) {
  return inst.locator('[id$="__font-info"]');
}

function checkBtn(inst: Locator) {
  return inst.locator('[id$="__check-font-btn"]');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("@font-face page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/font-face-test");
  });

  // ── 1. Elements exist and have expected text ──────────────────────────────

  test("custom-font-text element exists and has correct text", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await expect(customText(a)).toBeVisible();
    await expect(customText(a)).toHaveText("Text using CompFont");
  });

  test("regular-text element exists and has correct text", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(regularText(a)).toBeVisible();
    await expect(regularText(a)).toHaveText("Regular text for comparison");
  });

  // ── 2. @font-face font resolves and is applied ────────────────────────────

  test("@font-face font resolves: font-family includes CompFont", async ({
    page,
  }) => {
    // Bascik does NOT scope the @font-face font-family name — it stays "CompFont".
    // The .custom-font-text property value also stays "CompFont", so the font
    // resolves successfully.
    const { a } = getInstances(page);
    const el = customText(a);
    const fontFamily = await el.evaluate(
      (node) => getComputedStyle(node).fontFamily,
    );
    // The browser reports the resolved font-family. "CompFont" should appear
    // since the @font-face maps it to a local system font.
    expect(fontFamily.toLowerCase()).toContain("compfont");
  });

  test("@font-face font is monospace: CompFont maps to Courier New", async ({
    page,
  }) => {
    // The @font-face declares CompFont via local("Courier New") / local("Courier").
    // Courier New is a monospace font, so its character advance width should be
    // consistent. We verify by checking that 'i' and 'W' report the same width.
    const { a } = getInstances(page);
    const el = customText(a);
    const isMonospace = await el.evaluate((node) => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      const ff = getComputedStyle(node).fontFamily;
      const fs = getComputedStyle(node).fontSize;
      ctx.font = `${fs} ${ff}`;
      const wI = ctx.measureText("i").width;
      const wW = ctx.measureText("W").width;
      // Monospace fonts have equal advance widths for all characters
      return Math.abs(wI - wW) < 1;
    });
    expect(isMonospace).toBe(true);
  });

  // ── 3. Check-font-btn interaction ────────────────────────────────────────

  test("clicking check-font-btn populates font-info with fontFamily string", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await checkBtn(a).click();
    const infoText = await info(a).textContent();
    expect(infoText).toMatch(/^fontFamily:/);
    // The reported font-family should reference CompFont (unscoped)
    expect(infoText?.toLowerCase()).toContain("compfont");
  });

  test("check-font-btn shows font-family in info div", async ({ page }) => {
    const { a } = getInstances(page);
    // Before click: default text
    await expect(info(a)).toHaveText("Font info");
    await checkBtn(a).click();
    // After click: updated with fontFamily value
    await expect(info(a)).not.toHaveText("Font info");
    const infoText = await info(a).textContent();
    expect(infoText).toContain("fontFamily:");
  });

  // ── 4. CSS class scoping ──────────────────────────────────────────────────

  test("wrapper has scoped class name", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(a).toHaveClass(/bascik__font-face-test__wrapper/);
  });

  test("custom-font-text has scoped class name", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(customText(a)).toHaveClass(
      /bascik__font-face-test__custom-font-text/,
    );
  });

  // ── 5. Instance isolation: A and B both render correctly ─────────────────

  test("instance isolation: both instances exist", async ({ page }) => {
    const { a, b } = getInstances(page);
    await expect(a).toBeVisible();
    await expect(b).toBeVisible();
  });

  test("instance isolation: both instances show custom-font-text", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await expect(customText(a)).toHaveText("Text using CompFont");
    await expect(customText(b)).toHaveText("Text using CompFont");
  });

  test("instance isolation: instances have distinct IDs for font-info", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    const idA = await info(a).getAttribute("id");
    const idB = await info(b).getAttribute("id");
    expect(idA).not.toEqual(idB);
    expect(idA).toMatch(/^bascik__font-face-test__/);
    expect(idB).toMatch(/^bascik__font-face-test__/);
  });

  test("instance isolation: instances have distinct IDs for check-font-btn", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    const idA = await checkBtn(a).getAttribute("id");
    const idB = await checkBtn(b).getAttribute("id");
    expect(idA).not.toEqual(idB);
    expect(idA).toMatch(/^bascik__font-face-test__/);
    expect(idB).toMatch(/^bascik__font-face-test__/);
  });

  test("instance isolation: clicking Instance A button updates Instance A info only", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await checkBtn(a).click();
    // Instance A info should be updated
    await expect(info(a)).not.toHaveText("Font info");
    // Instance B info should remain unchanged
    await expect(info(b)).toHaveText("Font info");
  });
});
