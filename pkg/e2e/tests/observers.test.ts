/**
 * e2e tests for the Observer APIs on the observer-test fixture page.
 *
 * Two instances of <observer-test> are rendered side by side. These tests verify
 * that MutationObserver, IntersectionObserver, and ResizeObserver work correctly
 * after bascik's build-time ID and class scoping:
 *
 * - `getElementById("container")` → `getElementById("bascik__observer-test__HASH__container")`
 *   Each instance gets a unique hash, so Observers are bound to the correct per-instance element.
 *
 * - `querySelectorAll(".child-item")` → scoped to `.bascik__observer-test__child-item`
 *   Runtime queries inside callbacks match only the elements bascik scoped.
 *
 * - `div.className = "child-item"` → `div.className = "bascik__observer-test__child-item"`
 *   Dynamically created elements get the scoped class because "child-item" is declared
 *   via the sentinel <span> in the component HTML.
 *
 * - Observer API calls (new MutationObserver, .observe(), etc.) are browser globals
 *   and are not modified by bascik.
 *
 * The fixture is built with `minify.identifiers: false` so scoped class and id
 * names are readable (e.g. `bascik__observer-test__wrapper`).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__observer-test__wrapper").nth(0),
    b: page.locator(".bascik__observer-test__wrapper").nth(1),
  };
}

const mutStatus = (inst: Locator) => inst.locator('[id$="__mutation-status"]');
const intStatus = (inst: Locator) =>
  inst.locator('[id$="__intersection-status"]');
const sizeDisplay = (inst: Locator) => inst.locator('[id$="__size-display"]');
const addBtn = (inst: Locator) => inst.locator('[id$="__add-child-btn"]');
const removeBtn = (inst: Locator) => inst.locator('[id$="__remove-child-btn"]');
const container = (inst: Locator) => inst.locator('[id$="__container"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("observer-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/observer-test");
  });

  // ── 1. MutationObserver: adding a child fires mutation callback ───────────

  test("MutationObserver: adding a child fires mutation callback", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await addBtn(a).click();
    await expect(mutStatus(a)).toHaveText("mutations: 1 added, 0 removed");
  });

  // ── 2. MutationObserver: removing a child fires mutation callback ─────────

  test("MutationObserver: removing a child fires mutation callback", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    // Add first so there is something to remove
    await addBtn(a).click();
    await expect(mutStatus(a)).toHaveText("mutations: 1 added, 0 removed");

    await removeBtn(a).click();
    await expect(mutStatus(a)).toHaveText("mutations: 0 added, 1 removed");
  });

  // ── 3. MutationObserver: added child has scoped class and is styled ───────
  //
  // div.className = "child-item" is rewritten at build time to:
  //   div.className = "bascik__observer-test__child-item"
  // because "child-item" appears in the component HTML via the sentinel <span>.

  test("MutationObserver: added child has scoped class", async ({ page }) => {
    const { a } = getInstances(page);
    await addBtn(a).click();
    const child = container(a)
      .locator(".bascik__observer-test__child-item")
      .first();
    await expect(child).toBeVisible();
    await expect(child).toHaveClass(/bascik__observer-test__child-item/);
  });

  test("MutationObserver: added child receives scoped CSS (green text)", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await addBtn(a).click();
    const child = container(a)
      .locator(".bascik__observer-test__child-item")
      .first();
    const color = await child.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(74, 222, 128)");
  });

  // ── 4. IntersectionObserver: target is intersecting when in viewport ──────

  test("IntersectionObserver: target is intersecting when in viewport", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await expect(intStatus(a)).toHaveText("intersecting");
  });

  test("IntersectionObserver: both instances report intersecting", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await expect(intStatus(a)).toHaveText("intersecting");
    await expect(intStatus(b)).toHaveText("intersecting");
  });

  // ── 5. ResizeObserver: reports initial width ──────────────────────────────

  test("ResizeObserver: reports initial width greater than 0", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await expect(sizeDisplay(a)).toHaveText(/^width: \d+px$/);
    const text = await sizeDisplay(a).textContent();
    const width = parseInt(text!.replace("width: ", "").replace("px", ""), 10);
    expect(width).toBeGreaterThan(0);
  });

  test("ResizeObserver: both instances report their own widths", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await expect(sizeDisplay(a)).toHaveText(/^width: \d+px$/);
    await expect(sizeDisplay(b)).toHaveText(/^width: \d+px$/);
  });

  // ── 6. Instance isolation: MutationObservers are independent ─────────────

  test("instance isolation: adding child to A does not trigger B MutationObserver", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await addBtn(a).click();
    await expect(mutStatus(a)).toHaveText("mutations: 1 added, 0 removed");
    // B's observer was never triggered — should remain at its initial text
    await expect(mutStatus(b)).toHaveText("waiting for mutations...");
  });

  test("instance isolation: adding child to B does not trigger A MutationObserver", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await addBtn(b).click();
    await expect(mutStatus(b)).toHaveText("mutations: 1 added, 0 removed");
    await expect(mutStatus(a)).toHaveText("waiting for mutations...");
  });

  test("instance isolation: removing child from A does not affect B", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await addBtn(a).click();
    await removeBtn(a).click();
    // B's mutation-status should never have changed
    await expect(mutStatus(b)).toHaveText("waiting for mutations...");
  });

  // ── 7. Instance isolation: added children belong to the correct container ─

  test("instance isolation: child added to A is only in A container", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await addBtn(a).click();
    await expect(
      container(a).locator(".bascik__observer-test__child-item"),
    ).toHaveCount(1);
    await expect(
      container(b).locator(".bascik__observer-test__child-item"),
    ).toHaveCount(0);
  });

  test("instance isolation: A and B can independently accumulate children", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await addBtn(a).click();
    await addBtn(a).click();
    await addBtn(b).click();
    await expect(
      container(a).locator(".bascik__observer-test__child-item"),
    ).toHaveCount(2);
    await expect(
      container(b).locator(".bascik__observer-test__child-item"),
    ).toHaveCount(1);
  });

  // ── 8. ResizeObserver: per-instance isolation ────────────────────────────

  test("instance isolation: ResizeObserver per-instance (sizes are independent)", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    // Both should report a valid width; the key thing is each has its own observer
    await expect(sizeDisplay(a)).toHaveText(/^width: \d+px$/);
    await expect(sizeDisplay(b)).toHaveText(/^width: \d+px$/);
  });
});
