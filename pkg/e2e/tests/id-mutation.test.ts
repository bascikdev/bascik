/**
 * e2e tests for id mutation behavior in bascik.
 *
 * Two instances of <id-mutation> are rendered side by side. Tests document
 * bascik's actual build-time and runtime behavior for element ID assignment:
 *
 *   - Static `id` attributes ARE scoped at build time. Each element receives
 *     a unique scoped id like `bascik__id-mutation__<hash>__<original-id>`.
 *
 *   - `element.id = value` setter at runtime is NOT scoped — bascik cannot
 *     pattern-match a property assignment to a known id value. The literal
 *     string is written to the DOM as-is.
 *
 *   - `element.setAttribute('id', value)` at runtime is NOT scoped either —
 *     unlike `setAttribute('class', …)` (which IS scoped), the id argument
 *     is left as the literal value.
 *
 *   - Page-level scripts (in the page HTML, not component HTML) are NOT
 *     processed by bascik's JS scoper. They must use scoped names explicitly
 *     or use attribute suffix selectors like `[id$="__my-id"]`.
 *
 *   - Instance isolation: A and B receive different hash segments so their
 *     scoped IDs are distinct and don't collide.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number): Locator {
  return page.locator(".bascik__id-mutation__wrapper").nth(n);
}

const box = (inst: Locator) => inst.locator('[id$="__my-id"]');
const display = (inst: Locator) => inst.locator('[id$="__id-display"]');
const result = (inst: Locator) => inst.locator('[id$="__result"]');
const setIdBtn = (inst: Locator) => inst.locator('[id$="__set-id-btn"]');
const setAttrBtn = (inst: Locator) => inst.locator('[id$="__set-attr-btn"]');
const readIdBtn = (inst: Locator) => inst.locator('[id$="__read-id-btn"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("id-mutation-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/id-mutation-test");
  });

  // ── 1. Initial id is scoped ───────────────────────────────────────────────
  //
  // Static `id="my-id"` in the component HTML is scoped at build time.
  // The element receives an id like `bascik__id-mutation__<hash>__my-id`.
  // The component's own `getElementById("my-id")` is also scoped so it finds
  // the element and immediately writes the scoped id into the display element.

  test("initial id is scoped: display shows bascik__id-mutation__ prefix", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await expect(display(a)).toContainText("bascik__id-mutation__");
  });

  test("initial id ends with __my-id", async ({ page }) => {
    const a = getInstance(page, 0);
    await expect(display(a)).toContainText("__my-id");
  });

  // ── 2. element.id setter: sets id to the literal value ────────────────────
  //
  // `box.id = "new-id"` is a plain property assignment — bascik does NOT
  // scope it. After clicking set-id-btn, box.id is the literal string "new-id"
  // and the result element reflects that.

  test('element.id setter: result shows literal "new-id" (not scoped)', async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await setIdBtn(a).click();
    await expect(result(a)).toHaveText("id set to: new-id");
  });

  test("element.id setter: box.id is the literal string after assignment", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await setIdBtn(a).click();
    await readIdBtn(a).click();
    await expect(result(a)).toHaveText("current id: new-id");
  });

  // ── 3. setAttribute("id", value): sets id to the literal value ────────────
  //
  // `box.setAttribute("id", "attr-id")` is also NOT scoped by bascik — the
  // id argument is written as the literal "attr-id". This differs from
  // setAttribute("class", …) which IS scoped.

  test('setAttribute("id"): result shows literal "attr-id" (not scoped)', async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await setAttrBtn(a).click();
    await expect(result(a)).toHaveText("id via setAttribute: attr-id");
  });

  // ── 4. Instance isolation: A and B have different scoped IDs ──────────────
  //
  // Each instance gets a unique hash segment. The two box elements are
  // distinct DOM nodes with distinct scoped id values.

  test("instance isolation: A and B boxes have different scoped IDs", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);
    const idA = await box(a).getAttribute("id");
    const idB = await box(b).getAttribute("id");
    expect(idA).not.toEqual(idB);
    expect(idA).toMatch(/^bascik__id-mutation__/);
    expect(idB).toMatch(/^bascik__id-mutation__/);
  });

  // ── 5. Page-level query: unscoped .box returns null ───────────────────────
  //
  // Page-level scripts are not processed by bascik's JS scoper. A plain
  // document.querySelector('.box') finds nothing because all class names
  // inside the component are scoped to .bascik__id-mutation__box.

  test("page-level query: unscoped .box returns null", async ({ page }) => {
    const queryResult = page.locator("#page-query-result");
    await expect(queryResult).toContainText("unscoped .box: null");
  });

  // ── 6. Page-level query: scoped class finds both instances ────────────────
  //
  // Using the explicit scoped class name finds both rendered box elements.

  test("page-level query: scoped class finds 2 instances", async ({ page }) => {
    const queryResult = page.locator("#page-query-result");
    await expect(queryResult).toContainText(
      "scoped .bascik__id-mutation__box: 2 found",
    );
  });

  // ── 7. Page-level query: [id$="__my-id"] finds both instances ─────────────
  //
  // The CSS attribute suffix selector [id$="__my-id"] matches both scoped
  // ids (…__afab902c__my-id and …__bc39af10__my-id) without knowing the hash.

  test('page-level query: [id$="__my-id"] finds 2 instances', async ({
    page,
  }) => {
    const queryResult = page.locator("#page-query-result");
    await expect(queryResult).toContainText('[id$="__my-id"]: 2 found');
  });
});
