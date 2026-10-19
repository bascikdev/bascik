/**
 * e2e tests for event delegation scoping on the event-delegate-test fixture page.
 *
 * Two instances of <event-delegate> are rendered side by side. Each instance
 * attaches delegated click listeners to its own container element (by ID), using
 * e.target.matches('.btn') and e.target.closest('.item'). bascik scopes those
 * class selectors to their per-component equivalents at build time:
 *   - '.btn'  → '.bascik__event-delegate__btn'
 *   - '.item' → '.bascik__event-delegate__item'
 *
 * Because each instance's listener is bound to its own container DOM element
 * (looked up by scoped per-instance ID), clicks in instance A never trigger
 * instance B's handlers — true isolation without any runtime class-name trickery.
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable (e.g. `bascik__event-delegate__btn`).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__event-delegate__container").nth(0),
    b: page.locator(".bascik__event-delegate__container").nth(1),
  };
}

const result = (inst: Locator) => inst.locator('[id$="__result"]');
const listBtns = (inst: Locator) =>
  inst.locator(".bascik__event-delegate__btn");
const directBtn = (inst: Locator) => inst.locator('[id$="__direct-btn"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("event-delegate-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/event-delegate-test");
  });

  // ── 1. Delegated matches('.btn') — first button ─────────────────────────

  test('clicking first list button fires delegated handler with "alpha"', async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await listBtns(a).nth(0).click();

    await expect(result(a)).toHaveText("delegated btn: alpha");
  });

  // ── 2. Delegated matches('.btn') — second button ────────────────────────

  test('clicking second list button fires delegated handler with "beta"', async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await listBtns(a).nth(1).click();

    await expect(result(a)).toHaveText("delegated btn: beta");
  });

  // ── 3. Delegated matches('.btn') — third button ─────────────────────────

  test('clicking third list button fires delegated handler with "gamma"', async ({
    page,
  }) => {
    const { a } = getInstances(page);

    await listBtns(a).nth(2).click();

    await expect(result(a)).toHaveText("delegated btn: gamma");
  });

  // ── 4. Direct (non-delegated) listener ──────────────────────────────────

  test("direct button listener works", async ({ page }) => {
    const { a } = getInstances(page);

    await directBtn(a).click();

    await expect(result(a)).toHaveText("direct-btn clicked");
  });

  // ── 5. Instance isolation — clicking in A leaves B untouched ───────────

  test("clicking button in instance A does not affect instance B result", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);

    await listBtns(a).nth(0).click();

    await expect(result(a)).toHaveText("delegated btn: alpha");
    await expect(result(b)).toHaveText("No event yet");
  });

  // ── 6. Instance B delegated handler works independently ─────────────────

  test("instance B delegated handler works independently", async ({ page }) => {
    const { a, b } = getInstances(page);

    await listBtns(b).nth(1).click();

    await expect(result(b)).toHaveText("delegated btn: beta");
    await expect(result(a)).toHaveText("No event yet");
  });
});
