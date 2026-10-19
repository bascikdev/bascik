/**
 * e2e tests for advanced JS scoping on the js-advanced-test fixture page.
 *
 * Two instances of <js-advanced> are rendered side by side. Tests cover:
 *   - querySelector by #id (scoped to per-instance hashed ID)
 *   - querySelectorAll by #id (scoped to per-instance hashed ID → returns 1)
 *   - element.closest('#id') (scoped to per-instance hashed ID)
 *   - element.closest('.class') (scoped to component-level class)
 *   - element.matches('#id') (scoped to per-instance hashed ID)
 *   - element.matches('.class') (scoped to component-level class)
 *   - element.className setter (scoped to component-level class)
 *   - element.setAttribute('class', ...) (scoped to component-level class)
 *
 * The fixture is built with `minify.identifiers: false` so scoped class
 * names are readable (e.g. `bascik__js-advanced__active`).
 *
 * NOTE: ID-based selectors use the full per-instance scoped ID (with hash),
 * not the [id$=...] pattern. So querySelectorAll('#box') resolves to a
 * per-instance selector and returns 1 element, not 2.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__js-advanced__wrapper").nth(0),
    b: page.locator(".bascik__js-advanced__wrapper").nth(1),
  };
}

const result = (inst: Locator) => inst.locator('[id$="__result"]');
const box = (inst: Locator) => inst.locator('[id$="__box"]');
const btn = (inst: Locator, suffix: string) =>
  inst.locator(`[id$="__${suffix}"]`);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("js-advanced-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/js-advanced-test");
  });

  // ── 1. querySelector by #id ─────────────────────────────────────────────
  //
  // querySelector('#box') is rewritten to querySelector('#bascik__js-advanced__<hash>__box')
  // which resolves the box element within this specific instance.

  test("querySelector('#box') finds the box element", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "qs-id-btn").click();

    await expect(result(a)).toHaveText(/found/);
    await expect(result(a)).not.toHaveText(/null/);
  });

  // ── 2. querySelectorAll by #id ──────────────────────────────────────────
  //
  // querySelectorAll('#box') is rewritten to a per-instance hashed ID selector,
  // so it only matches the one box in this instance — returns 1, not 2.

  test("querySelectorAll('#box') returns 1 (instance-scoped ID)", async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await btn(a, "qsa-id-btn").click();

    await expect(result(a)).toHaveText(/: 1$/);
  });

  // ── 3. element.closest('#id') ───────────────────────────────────────────

  test("closest('#root') finds the wrapper ancestor", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "closest-id-btn").click();

    await expect(result(a)).toHaveText(/found/);
    await expect(result(a)).not.toHaveText(/null/);
  });

  // ── 4. element.closest('.class') ────────────────────────────────────────

  test("closest('.wrapper') finds the wrapper ancestor", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "closest-class-btn").click();

    await expect(result(a)).toHaveText(/found/);
    await expect(result(a)).not.toHaveText(/null/);
  });

  // ── 5. element.matches('#id') ────────────────────────────────────────────

  test("matches('#box') returns true for the box element", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "matches-id-btn").click();

    await expect(result(a)).toHaveText(/: true$/);
  });

  // ── 6. element.matches('.class') ────────────────────────────────────────

  test("matches('.box') returns true for the box element", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "matches-class-btn").click();

    await expect(result(a)).toHaveText(/: true$/);
  });

  // ── 7. className setter scopes the class ────────────────────────────────
  //
  // box.className = 'active' is rewritten to box.className = 'bascik__js-advanced__active'.
  // After clicking, the box element should carry the scoped active class.

  test("className setter applies scoped active class to box", async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await btn(a, "classname-btn").click();

    await expect(box(a)).toHaveClass(/bascik__js-advanced__active/);
  });

  test("className setter result text shows scoped class name", async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await btn(a, "classname-btn").click();

    await expect(result(a)).toHaveText(/bascik__js-advanced__active/);
  });

  // ── 8. setAttribute('class', ...) scopes the class ──────────────────────
  //
  // box.setAttribute('class', 'active') is rewritten to use the scoped class.

  test("setAttribute('class', 'active') applies scoped active class", async ({
    page,
  }) => {
    const { a } = getInstances(page);

    // Reset first to ensure a clean starting state
    await btn(a, "reset-btn").click();
    await btn(a, "set-attr-btn").click();

    await expect(box(a)).toHaveClass(/bascik__js-advanced__active/);
  });

  test("setAttribute result text shows scoped class name", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "set-attr-btn").click();

    await expect(result(a)).toHaveText(/bascik__js-advanced__active/);
  });

  // ── 9. reset restores scoped box class ──────────────────────────────────
  //
  // box.className = 'box' in the reset handler is rewritten to
  // box.className = 'bascik__js-advanced__box'.

  test("reset button restores the scoped box class", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "classname-btn").click();
    await expect(box(a)).toHaveClass(/bascik__js-advanced__active/);

    await btn(a, "reset-btn").click();
    await expect(box(a)).toHaveClass(/bascik__js-advanced__box/);
    await expect(box(a)).not.toHaveClass(/bascik__js-advanced__active/);
  });

  // ── 10. Instance isolation ───────────────────────────────────────────────
  //
  // Clicking a button in instance A must not affect instance B's result display.

  test("instance A actions do not affect instance B result", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);

    await btn(a, "qs-id-btn").click();

    await expect(result(a)).toHaveText(/found/);
    await expect(result(b)).toHaveText("Click a button to test");
  });

  test("instance A className change does not affect instance B box", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);

    await btn(a, "classname-btn").click();

    await expect(box(a)).toHaveClass(/bascik__js-advanced__active/);
    await expect(box(b)).not.toHaveClass(/bascik__js-advanced__active/);
  });
});
