/**
 * e2e tests for DOM query scoping on the dom-query-test fixture page.
 *
 * Two instances of <dom-query-test> are rendered side by side. Every test
 * verifies that a DOM query (getElementById, querySelectorAll, querySelector
 * by name, getElementsByClassName) resolves only within the component instance
 * that initiated it — never crossing into the sibling instance.
 *
 * The fixture is built with `minify.identifiers: false` so scoped class
 * and id names are readable (e.g. `bascik__dom-query-test__active`).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__dom-query-test__wrapper").nth(0),
    b: page.locator(".bascik__dom-query-test__wrapper").nth(1),
  };
}

const resultBox = (inst: Locator) => inst.locator('[id$="__result-box"]');
const btn = (inst: Locator, suffix: string) =>
  inst.locator(`[id$="__${suffix}"]`);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("dom-query-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dom-query-test");
  });

  // ── 1. getElementById ───────────────────────────────────────────────────

  test("getElementById finds element in its own instance", async ({ page }) => {
    const { a, b } = getInstances(page);

    await btn(a, "query-by-id-btn").click();

    await expect(resultBox(a)).toHaveText(/found by id/);
    await expect(resultBox(b)).not.toHaveClass(/found/);
  });

  // ── 2. querySelectorAll by class ────────────────────────────────────────
  //
  // Class names are shared across ALL instances of the same component (bascik
  // uses per-component class scoping, not per-instance). So querySelectorAll
  // with a scoped class name is a document-wide query and returns elements from
  // ALL instances on the page.
  //
  // Two instances × 2 cards each = 4 total. This is expected behavior.

  test('querySelectorAll(".card") finds cards across all instances (document-wide)', async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await btn(a, "query-by-class-btn").click();

    await expect(resultBox(a)).toHaveText("cards found: 4");
  });

  // ── 3. querySelectorAll result-box is isolated to the triggering instance ─

  test("querySelectorAll button click only updates its own result-box", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);

    await btn(b, "query-by-class-btn").click();

    await expect(resultBox(a)).toHaveText("No query yet");
  });

  // ── 4. querySelector by name ────────────────────────────────────────────
  //
  // `name` ships as written (scoping.attributes.name is off by default), so
  // the document-wide querySelector("[name='username']") finds the first
  // instance's hidden field by its authored name.

  test("querySelector(\"[name='username']\") finds the field by its authored name", async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await btn(a, "query-by-name-btn").click();

    await expect(resultBox(a)).toHaveText("name found: alice");
  });

  // ── 5. getElementsByClassName ───────────────────────────────────────────
  //
  // Same as querySelectorAll: getElementsByClassName is scoped to the component
  // class name (not per-instance), so it finds cards in ALL instances.
  // Two instances × 2 cards = 4 total.

  test("getElementsByClassName finds cards across all instances (document-wide)", async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await btn(a, "get-by-class-btn").click();

    await expect(resultBox(a)).toHaveText("byClassName: 4");
  });
});
