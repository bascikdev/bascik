/**
 * e2e tests for async JS with scoped DOM queries on the async-query-test fixture page.
 *
 * Two instances of <async-query> are rendered side by side. The component uses
 * DOM queries inside async callbacks (setTimeout, Promise.then, queueMicrotask).
 * bascik scoping is purely static (build-time), so scoped IDs and class names
 * are already baked into the callbacks — they work correctly in all async contexts.
 *
 * Scoping behavior:
 *   - getElementById("result") → getElementById("bascik__async-query__HASH__result")
 *     Per-instance (hash-qualified), so each instance resolves its own element.
 *   - querySelector(".result") → querySelector(".bascik__async-query__result")
 *     Class-scoped but document-wide — resolves the FIRST matching element in the DOM.
 *     Clicking promise-btn on instance B therefore updates instance A's result element.
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable (e.g. `bascik__async-query__wrapper`).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number) {
  return page.locator(".bascik__async-query__wrapper").nth(n);
}

const resultEl = (inst: Locator) => inst.locator('[id$="__result"]');
const btn = (inst: Locator, suffix: string) =>
  inst.locator(`[id$="__${suffix}"]`);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("async-query-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/async-query-test");
  });

  // ── 1. Initial state ─────────────────────────────────────────────────────

  test('result starts with "No result"', async ({ page }) => {
    const a = getInstance(page, 0);
    await expect(resultEl(a)).toHaveText("No result");
  });

  // ── 2. setTimeout callback ───────────────────────────────────────────────
  //
  // getElementById is scoped per-instance (hash-qualified), so the callback
  // finds and updates only this instance's #result element.

  test("setTimeout callback: getElementById finds element", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await btn(a, "timeout-btn").click();

    await expect(resultEl(a)).toHaveText("timeout: found #result", {
      timeout: 3000,
    });
  });

  // ── 3. Promise callback ──────────────────────────────────────────────────
  //
  // querySelector(".bascik__async-query__result") is document-wide and resolves
  // the FIRST matching element in the DOM — instance A's result.

  test("Promise callback: querySelector finds element", async ({ page }) => {
    const a = getInstance(page, 0);

    await btn(a, "promise-btn").click();

    await expect(resultEl(a)).toHaveText("promise: found .result");
  });

  // ── 4. queueMicrotask callback ───────────────────────────────────────────
  //
  // getElementById is scoped per-instance, so the callback finds this
  // instance's #result element even in a microtask queue.

  test("queueMicrotask callback: getElementById finds element", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await btn(a, "microtask-btn").click();

    await expect(resultEl(a)).toHaveText("microtask: found #result");
  });

  // ── 5. Instance isolation (setTimeout) ───────────────────────────────────
  //
  // getElementById is hash-qualified, so instance A's async callback updates
  // only instance A's result. Instance B remains unaffected.

  test("instance A async query does not affect instance B", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await btn(a, "timeout-btn").click();

    await expect(resultEl(a)).toHaveText("timeout: found #result", {
      timeout: 3000,
    });
    await expect(resultEl(b)).toHaveText("No result");
  });
});
