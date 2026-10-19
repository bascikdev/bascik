/**
 * e2e tests for runtime CSS custom property scoping on the runtime-vars-test fixture page.
 *
 * Two instances of <runtime-vars> are rendered. Tests verify:
 *   - CSS custom properties are scoped at build time (--theme-color → --bascik__runtime-vars__theme-color)
 *   - The default blue color is applied via the scoped custom property
 *   - Runtime setProperty("--theme-color", ...) sets an inline unscoped property —
 *     it does NOT affect the box color because the CSS reads the scoped var name
 *   - getPropertyValue("--theme-color") reads back the inline value set via setProperty
 *   - reset-btn removes the inline property
 *   - Instance isolation: each instance has independent inline styles and state
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inst(page: Page, n: number): Locator {
  return page.locator(".bascik__runtime-vars__wrapper").nth(n);
}

function themedBox(i: Locator) {
  return i.locator(".bascik__runtime-vars__themed-box");
}

function resultEl(i: Locator) {
  return i.locator(".bascik__runtime-vars__result");
}

function setScopedBtn(i: Locator) {
  return i.locator('[id$="__set-scoped-btn"]');
}

function setUnscopedBtn(i: Locator) {
  return i.locator('[id$="__set-unscoped-btn"]');
}

function readVarBtn(i: Locator) {
  return i.locator('[id$="__read-var-btn"]');
}

function resetBtn(i: Locator) {
  return i.locator('[id$="__reset-btn"]');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("runtime-vars-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/runtime-vars-test");
  });

  test("initial themed-box has default blue color from scoped CSS custom property", async ({
    page,
  }) => {
    const i = inst(page, 0);
    const color = await themedBox(i).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  test("initial themed-box border color matches default blue", async ({
    page,
  }) => {
    const i = inst(page, 0);
    const border = await themedBox(i).evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    expect(border).toBe("rgb(96, 165, 250)");
  });

  test("set-scoped-btn sets --theme-color inline but CSS uses scoped name — no visual change", async ({
    page,
  }) => {
    const i = inst(page, 0);
    await setScopedBtn(i).click();
    // CSS uses --bascik__runtime-vars__theme-color, not --theme-color, so color is unchanged
    const color = await themedBox(i).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  test("read-var-btn reads --theme-color value after set-scoped-btn", async ({
    page,
  }) => {
    const i = inst(page, 0);
    await setScopedBtn(i).click();
    await readVarBtn(i).click();
    const text = await resultEl(i).textContent();
    expect(text).toContain("rgb(74, 222, 128)");
  });

  test("set-unscoped-btn sets --unscoped-color which is not used by CSS — no visual change", async ({
    page,
  }) => {
    const i = inst(page, 0);
    await setUnscopedBtn(i).click();
    const color = await themedBox(i).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  test("reset-btn removes inline --theme-color property", async ({ page }) => {
    const i = inst(page, 0);
    await setScopedBtn(i).click();
    await resetBtn(i).click();
    // After reset, result shows "reset"
    await expect(resultEl(i)).toHaveText("reset");
    // Box color still reads from scoped CSS var — unchanged
    const color = await themedBox(i).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  test("instance isolation: setting inline var in instance A does not affect instance B", async ({
    page,
  }) => {
    const a = inst(page, 0);
    const b = inst(page, 1);

    await setScopedBtn(a).click();

    // Instance B result text is still the initial value
    await expect(resultEl(b)).toHaveText("No change yet");

    // Both boxes still show the same color (CSS reads scoped var, inline var has no effect on CSS)
    const colorA = await themedBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    const colorB = await themedBox(b).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(colorA).toBe("rgb(96, 165, 250)");
    expect(colorB).toBe("rgb(96, 165, 250)");
  });
});
