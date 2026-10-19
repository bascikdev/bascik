/**
 * e2e tests for JS scoping of innerHTML and insertAdjacentHTML.
 *
 * Two instances of <js-limitations> are rendered side by side. Tests document
 * bascik's actual build-time scoping behaviour for dynamic HTML injection:
 *
 *   - bascik DOES scope class names inside innerHTML string literals when the
 *     class is declared in the component CSS (or present in an HTML sentinel).
 *     The scoped class in the string and the scoped querySelector therefore
 *     stay consistent — querySelector finds the injected element.
 *
 *   - bascik DOES scope class names inside insertAdjacentHTML string literals
 *     under the same conditions.
 *
 *   - The real limitation is classes that are NOT declared in CSS and NOT
 *     listed in an HTML sentinel: those are left unscoped in injected strings,
 *     creating a mismatch with scoped CSS rules. That case is intentionally
 *     out of scope for this fixture (no unknown classes are used).
 *
 *   - Instance isolation: A and B are independent DOM trees.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number): Locator {
  return page.locator(".bascik__js-limitations__wrapper").nth(n);
}

const area = (inst: Locator) => inst.locator('[id$="__dynamic-area"]');
const result = (inst: Locator) => inst.locator('[id$="__result"]');
const setHtmlBtn = (inst: Locator) =>
  inst.locator('[id$="__set-inner-html-btn"]');
const adjacentBtn = (inst: Locator) =>
  inst.locator('[id$="__insert-adjacent-btn"]');
const checkInnerBtn = (inst: Locator) =>
  inst.locator('[id$="__check-inner-btn"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("js-limitations-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/js-limitations-test");
  });

  // ── 1. innerHTML setter updates the result text ───────────────────────────

  test('innerHTML setter: result text updates to "innerHTML set"', async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await setHtmlBtn(a).click();
    await expect(result(a)).toHaveText("innerHTML set");
  });

  // ── 2. innerHTML setter: injected element carries scoped class ─────────────
  //
  // bascik scopes the literal string '<div class="box">…</div>' inside the
  // innerHTML setter to '<div class="bascik__js-limitations__box">…</div>'
  // because "box" is declared in the component CSS. The injected element
  // therefore gets the scoped class name.

  test("innerHTML setter: injected div carries the scoped box class", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await setHtmlBtn(a).click();
    const injected = area(a).locator('[class*="js-limitations__box"]');
    await expect(injected).toBeVisible();
    await expect(injected).toHaveText("Injected via innerHTML");
  });

  // ── 3. querySelector finds the injected element ────────────────────────────
  //
  // Because both the innerHTML class and the querySelector selector are scoped
  // consistently, area.querySelector(".box") (scoped at build time to
  // ".bascik__js-limitations__box") DOES find the injected element.
  // result text shows "querySelector(.box) found: true".

  test("check-inner-btn: querySelector finds the scoped injected box (true)", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await setHtmlBtn(a).click();
    await checkInnerBtn(a).click();
    await expect(result(a)).toHaveText("querySelector(.box) found: true");
  });

  // ── 4. insertAdjacentHTML: result text updates ─────────────────────────────

  test('insertAdjacentHTML: result text updates to "insertAdjacentHTML done"', async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await adjacentBtn(a).click();
    await expect(result(a)).toHaveText("insertAdjacentHTML done");
  });

  // ── 5. insertAdjacentHTML: appended element carries scoped injected class ──
  //
  // The "injected" class in the insertAdjacentHTML string literal is scoped to
  // "bascik__js-limitations__injected" because it is declared in the CSS.

  test("insertAdjacentHTML: appended div carries the scoped injected class", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await adjacentBtn(a).click();
    const injected = area(a).locator('[class*="js-limitations__injected"]');
    await expect(injected).toBeVisible();
    await expect(injected).toHaveText("Adjacent HTML");
  });

  // ── 6. Instance isolation ─────────────────────────────────────────────────
  //
  // Clicking buttons in instance A must not affect instance B's result text.

  test("instance isolation: instance A actions do not affect instance B", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await setHtmlBtn(a).click();
    await expect(result(a)).toHaveText("innerHTML set");
    await expect(result(b)).toHaveText("No change");
  });

  // ── 7. Two independent wrapper instances ──────────────────────────────────

  test("two independent wrapper instances are rendered", async ({ page }) => {
    await expect(page.locator(".bascik__js-limitations__wrapper")).toHaveCount(
      2,
    );
  });
});
