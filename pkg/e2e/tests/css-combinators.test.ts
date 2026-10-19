/**
 * e2e tests for CSS combinator and compound selector scoping on the
 * css-combinators-test fixture page.
 *
 * Two instances of <css-combinators> are rendered. Tests verify:
 *   - Child combinator (>) class names are scoped
 *   - Adjacent sibling (+) class names are scoped
 *   - General sibling (~) class names are scoped
 *   - Descendant (space) class names are scoped
 *   - Compound selectors (.box.active) class names are scoped
 *   - Both instances render correctly (instance isolation)
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number): Locator {
  return page.locator(".bascik__css-combinators__wrapper").nth(n);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-combinators-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-combinators-test");
  });

  // Child combinator (>)
  test("child combinator: direct .list > .item has green color", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    const item = inst
      .locator(
        ".bascik__css-combinators__list > .bascik__css-combinators__item",
      )
      .first();
    const color = await item.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(74, 222, 128)");
  });

  test("child combinator: nested .item (NOT direct child) does NOT have green color", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    const nestedItem = inst.locator(
      ".bascik__css-combinators__nested-wrapper .bascik__css-combinators__item",
    );
    const color = await nestedItem.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(150, 150, 150)");
  });

  // Adjacent sibling (+)
  test("adjacent sibling: first .subtitle after .title has blue color", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    const firstSubtitle = inst
      .locator(".bascik__css-combinators__subtitle")
      .nth(0);
    const color = await firstSubtitle.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  test("adjacent sibling: second .subtitle (not directly adjacent) has default color", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    const secondSubtitle = inst
      .locator(".bascik__css-combinators__subtitle")
      .nth(1);
    const color = await secondSubtitle.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(136, 136, 136)");
  });

  // General sibling (~)
  test("general sibling: content-items after header-label have purple color", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    const contentItems = inst.locator(".bascik__css-combinators__content-item");
    for (let i = 0; i < (await contentItems.count()); i++) {
      const color = await contentItems
        .nth(i)
        .evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe("rgb(167, 139, 250)");
    }
  });

  // Descendant (space)
  test("descendant: .label inside .card has yellow color", async ({ page }) => {
    const inst = getInstance(page, 0);
    const labelInCard = inst.locator(
      ".bascik__css-combinators__card .bascik__css-combinators__label",
    );
    const color = await labelInCard.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(251, 191, 36)");
  });

  test("descendant: .label outside .card has default gray color", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    // The label outside the card is a direct child of .wrapper, not inside .card
    const labelOutsideCard = inst.locator("> .bascik__css-combinators__label");
    const color = await labelOutsideCard.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(102, 102, 102)");
  });

  // Compound selector (.box.active)
  test("compound: .box.active has green background", async ({ page }) => {
    const inst = getInstance(page, 0);
    const activeBox = inst.locator(
      ".bascik__css-combinators__box.bascik__css-combinators__active",
    );
    const bg = await activeBox.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(22, 101, 52)");
  });

  test("compound: plain .box does NOT have green background", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    // First .box (no .active)
    const plainBox = inst.locator(".bascik__css-combinators__box").first();
    const bg = await plainBox.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(30, 30, 30)");
  });

  // Instance isolation
  test("instance isolation: both instances render correctly", async ({
    page,
  }) => {
    for (let i = 0; i < 2; i++) {
      const inst = getInstance(page, i);

      const directItem = inst
        .locator(
          ".bascik__css-combinators__list > .bascik__css-combinators__item",
        )
        .first();
      const itemColor = await directItem.evaluate(
        (el) => getComputedStyle(el).color,
      );
      expect(itemColor).toBe("rgb(74, 222, 128)");

      const firstSubtitle = inst
        .locator(".bascik__css-combinators__subtitle")
        .nth(0);
      const subtitleColor = await firstSubtitle.evaluate(
        (el) => getComputedStyle(el).color,
      );
      expect(subtitleColor).toBe("rgb(96, 165, 250)");

      const activeBox = inst.locator(
        ".bascik__css-combinators__box.bascik__css-combinators__active",
      );
      const activeBoxBg = await activeBox.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(activeBoxBg).toBe("rgb(22, 101, 52)");
    }
  });
});
