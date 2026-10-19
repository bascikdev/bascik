/**
 * e2e tests for CSS :has() pseudo-class scoping on the css-has-test fixture page.
 *
 * Two instances of <css-has> are rendered. Tests verify:
 *   - CSS class names inside :has() are scoped (e.g. :has(.selected) → :has(.bascik__css-has__selected))
 *   - :has() changes background of .list when a .selected item is present
 *   - :has() changes border of .card when a .error-msg is present
 *   - Dynamic class toggles via buttons work correctly with scoped names
 *   - Instance isolation: each instance has independent state
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inst(page: Page, n: number): Locator {
  return page.locator(".bascik__css-has__wrapper").nth(n);
}

function list(i: Locator) {
  return i.locator(".bascik__css-has__list");
}

function cardA(i: Locator) {
  return i.locator(".bascik__css-has__card").nth(0);
}

function cardB(i: Locator) {
  return i.locator(".bascik__css-has__card").nth(1);
}

function selectABtn(i: Locator) {
  return i.locator('[id$="__select-a-btn"]');
}

function deselectBtn(i: Locator) {
  return i.locator('[id$="__deselect-btn"]');
}

function addErrorBtn(i: Locator) {
  return i.locator('[id$="__add-error-btn"]');
}

function removeErrorBtn(i: Locator) {
  return i.locator('[id$="__remove-error-btn"]');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("css-has-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/css-has-test");
  });

  test("list:has(.selected) changes background when item-b is selected (initially)", async ({
    page,
  }) => {
    const i = inst(page, 0);
    const bg = await list(i).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(14, 30, 14)");
  });

  test("list:has(.selected) background goes away when all items deselected", async ({
    page,
  }) => {
    const i = inst(page, 0);
    await deselectBtn(i).click();
    const bg = await list(i).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    // No selected item — should not have the green background
    expect(bg).not.toBe("rgb(14, 30, 14)");
  });

  test("clicking select-a-btn: list still has :has(.selected) background", async ({
    page,
  }) => {
    const i = inst(page, 0);
    await deselectBtn(i).click();
    await selectABtn(i).click();
    const bg = await list(i).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(14, 30, 14)");
  });

  test("card-b has error border color (contains .error-msg from start)", async ({
    page,
  }) => {
    const i = inst(page, 0);
    const border = await cardB(i).evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    expect(border).toBe("rgb(239, 68, 68)");
  });

  test("card-a does NOT have error border initially", async ({ page }) => {
    const i = inst(page, 0);
    const border = await cardA(i).evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    expect(border).not.toBe("rgb(239, 68, 68)");
  });

  test("add-error-btn: card-a gains error border", async ({ page }) => {
    const i = inst(page, 0);
    await addErrorBtn(i).click();
    const border = await cardA(i).evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    expect(border).toBe("rgb(239, 68, 68)");
  });

  test("remove-error-btn: card-a loses error border after add then remove", async ({
    page,
  }) => {
    const i = inst(page, 0);
    await addErrorBtn(i).click();
    await removeErrorBtn(i).click();
    const border = await cardA(i).evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    expect(border).not.toBe("rgb(239, 68, 68)");
  });

  test("instance isolation: deselecting in instance A does not affect instance B", async ({
    page,
  }) => {
    const a = inst(page, 0);
    const b = inst(page, 1);

    // Both start with item-b selected
    const bgBefore = await list(b).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bgBefore).toBe("rgb(14, 30, 14)");

    // Deselect in instance A only
    await deselectBtn(a).click();

    const bgAAfter = await list(a).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const bgBAfter = await list(b).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    expect(bgAAfter).not.toBe("rgb(14, 30, 14)");
    expect(bgBAfter).toBe("rgb(14, 30, 14)");
  });
});
