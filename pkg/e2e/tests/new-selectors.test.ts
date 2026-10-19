/**
 * e2e tests for new CSS selector scoping on the new-selectors-test fixture page.
 *
 * Two instances of <new-selectors> are rendered. Tests verify:
 *   - CSS @scope arguments are scoped (class names in @scope(...) and @scope(...) to (...))
 *   - CSS @scope inner rules are scoped
 *   - @scope "to" clause excludes elements inside the boundary element
 *   - Pass 4: descendant element selectors (.card p, .list > li, .article > h2)
 *     are scoped by injecting bascik__...__el__<tag> onto matching HTML elements
 *   - Both instances render correctly (instance isolation)
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inst(page: Page, n: number): Locator {
  return page.locator(".bascik__new-selectors__wrapper").nth(n);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("new-selectors-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/new-selectors-test");
  });

  // --- @scope tests ---

  test("@scope: .title inside .container has blue color", async ({ page }) => {
    const title = inst(page, 0).locator(".bascik__new-selectors__title");
    const color = await title.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(96, 165, 250)");
  });

  test("@scope: .body inside .container has gray color", async ({ page }) => {
    const body = inst(page, 0).locator(".bascik__new-selectors__body");
    const color = await body.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(180, 180, 180)");
  });

  test('@scope "to": .label inside .widget but outside .boundary has green color', async ({
    page,
  }) => {
    const widget = inst(page, 0).locator(".bascik__new-selectors__widget");
    // The first .label is a direct child of .widget, outside .boundary
    const label = widget.locator(".bascik__new-selectors__label").first();
    const color = await label.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(74, 222, 128)");
  });

  test('@scope "to": .label inside .boundary is excluded (not green)', async ({
    page,
  }) => {
    const boundary = inst(page, 0).locator(".bascik__new-selectors__boundary");
    const label = boundary.locator(".bascik__new-selectors__label");
    const color = await label.evaluate((el) => getComputedStyle(el).color);
    // Inside the boundary the @scope rule does not apply; color inherits from body (#eee)
    expect(color).not.toBe("rgb(74, 222, 128)");
  });

  // --- Pass 4: descendant element selector tests ---

  test("Pass 4: p inside .card has scoped green color", async ({ page }) => {
    const card = inst(page, 0).locator(".bascik__new-selectors__card");
    const p = card.locator("p");
    const color = await p.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(74, 222, 128)");
  });

  test("Pass 4: li direct children of .list have purple color", async ({
    page,
  }) => {
    const li = inst(page, 0)
      .locator(".bascik__new-selectors__list > .bascik__new-selectors__el__li")
      .first();
    const color = await li.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(167, 139, 250)");
  });

  test("Pass 4: h2 inside .article has yellow color", async ({ page }) => {
    const h2 = inst(page, 0).locator(
      ".bascik__new-selectors__article > .bascik__new-selectors__el__h2",
    );
    const color = await h2.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(251, 191, 36)");
  });

  // --- Instance isolation ---

  test("instance isolation: both instances render @scope title correctly", async ({
    page,
  }) => {
    for (const n of [0, 1]) {
      const title = inst(page, n).locator(".bascik__new-selectors__title");
      const color = await title.evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe("rgb(96, 165, 250)");
    }
  });

  test("instance isolation: both instances render .card p correctly", async ({
    page,
  }) => {
    for (const n of [0, 1]) {
      const p = inst(page, n).locator(".bascik__new-selectors__card p");
      const color = await p.evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe("rgb(74, 222, 128)");
    }
  });
});
