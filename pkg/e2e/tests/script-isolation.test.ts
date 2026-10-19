/**
 * e2e tests for script IIFE isolation on the script-isolation-test fixture page.
 *
 * Every <script> block in a bascik component is wrapped in an IIFE at build
 * time, so `var`, `let`, and `const` declared at the script top level are
 * contained within that closure and never reach the global `window` object.
 *
 * Two instances of <script-isolation> are rendered side by side. Tests cover:
 *   - `var leakVar` does not appear on `window` (IIFE containment)
 *   - local `var` is still readable within its own instance
 *   - `let counter` increments independently per instance
 *   - counter state in instance B is unaffected by instance A's increments
 *   - setting leakVar in instance A does not bleed into instance B
 *   - `window.leakVar` remains undefined even after local mutation in instance A
 *
 * The fixture is built with `minify.identifiers: false` so scoped class
 * names are readable (e.g. `bascik__script-isolation__wrapper`).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__script-isolation__wrapper").nth(0),
    b: page.locator(".bascik__script-isolation__wrapper").nth(1),
  };
}

const display = (inst: Locator) => inst.locator('[id$="__display"]');
const btn = (inst: Locator, suffix: string) =>
  inst.locator(`[id$="__${suffix}"]`);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("script-isolation-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/script-isolation-test");
  });

  // ── 1. var leakVar does not leak to window ────────────────────────────────
  //
  // The script block is wrapped in an IIFE, so `var leakVar` is local to the
  // closure — `window.leakVar` must be undefined.

  test("var leakVar does not leak to window", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "check-global-btn").click();

    await expect(display(a)).toHaveText("window.leakVar = undefined");
  });

  // ── 2. local var is accessible within its own instance ───────────────────
  //
  // Even though leakVar is inside the IIFE, it is still readable and writable
  // from the event listeners defined in the same closure.

  test("local var is accessible within its own instance", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "set-local-btn").click();
    await btn(a, "read-local-btn").click();

    await expect(display(a)).toHaveText("local leakVar = set-by-click");
  });

  // ── 3. counter increments independently in instance A ────────────────────

  test("counter increments independently in instance A", async ({ page }) => {
    const { a } = getInstances(page);

    await btn(a, "increment-btn").click();
    await btn(a, "increment-btn").click();
    await btn(a, "increment-btn").click();
    await btn(a, "read-counter-btn").click();

    await expect(display(a)).toHaveText("counter = 3");
  });

  // ── 4. counter in instance B is independent from instance A ──────────────
  //
  // Incrementing A's counter must not affect B's counter because each instance
  // has its own IIFE with its own `let counter` binding.

  test("counter in instance B is independent from instance A", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);

    // Increment A three times
    await btn(a, "increment-btn").click();
    await btn(a, "increment-btn").click();
    await btn(a, "increment-btn").click();

    // B's counter should still be 0
    await btn(b, "read-counter-btn").click();

    await expect(display(b)).toHaveText("counter = 0");
  });

  // ── 5. setting leakVar in instance A does not affect instance B ──────────
  //
  // Each IIFE captures its own `var leakVar` binding. Mutating leakVar in A
  // must not change the value seen by B's closure.

  test("setting leakVar in instance A does not affect instance B", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);

    await btn(a, "set-local-btn").click();
    await btn(b, "read-local-btn").click();

    await expect(display(b)).toHaveText("local leakVar = instance-local-value");
  });

  // ── 6. window.leakVar is undefined even after local mutation in instance A ─
  //
  // Clicking set-local-btn in A mutates A's local `var leakVar` inside the
  // IIFE. Because it is inside the function scope, it still cannot escape to
  // `window`. Checking window.leakVar in B (which also uses the global check)
  // must still report undefined.

  test("window.leakVar is undefined even after local mutation in instance A", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);

    // Mutate leakVar inside instance A's IIFE
    await btn(a, "set-local-btn").click();

    // Check the global from instance B's button — still should be undefined
    await btn(b, "check-global-btn").click();

    await expect(display(b)).toHaveText("window.leakVar = undefined");
  });
});
