/**
 * e2e tests for nested CSS var() fallbacks.
 *
 * Two instances of <nested-vars> are rendered side by side. Tests verify:
 *   - Single var() with a defined prop resolves to the declared color
 *   - Nested var() fallback: outer prop defined → inner fallback unused
 *   - Double-nested var() fallback: both custom props undefined → hardcoded color
 *   - Undeclared custom props are left unscoped (no --bascik__ prefix)
 *   - Instance isolation: Instance A and B are independent
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number): Locator {
  return page.locator(".bascik__nested-vars__wrapper").nth(n);
}

const primaryBox = (inst: Locator) => inst.locator('[id$="__box-primary"]');
const secondaryBox = (inst: Locator) => inst.locator('[id$="__box-secondary"]');
const fallbackBox = (inst: Locator) => inst.locator('[id$="__box-fallback"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("nested-vars-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/nested-vars-test");
  });

  // ── 1. Single var() with defined prop ─────────────────────────────────────
  //
  // --primary is declared on .wrapper and scoped to
  // --bascik__nested-vars__primary. The var() reference is scoped to match,
  // so the computed color is the declared green.

  test("box-primary: single var() with defined prop resolves to green", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const color = await primaryBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(74, 222, 128)");
  });

  // ── 2. Nested var(): outer prop defined → inner fallback unused ───────────
  //
  // var(--secondary, var(--primary, rgb(200, 200, 200))) is scoped to
  // var(--bascik__nested-vars__secondary, var(--bascik__nested-vars__primary, …)).
  // --secondary IS defined on .wrapper, so it resolves immediately to the blue.

  test("box-secondary: nested var() resolves to outer defined prop (blue)", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const color = await secondaryBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  // ── 3. Inner fallback not used when outer is defined ──────────────────────
  //
  // If the inner fallback were bleeding through, the color would be the green
  // (--primary) or the rgb(200,200,200). It should be the blue.

  test("box-secondary: inner var() fallback is not applied when outer resolves", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const color = await secondaryBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).not.toBe("rgb(74, 222, 128)"); // not green (--primary)
    expect(color).not.toBe("rgb(200, 200, 200)"); // not hardcoded fallback
  });

  // ── 4. Double-nested fallback: undeclared props → hardcoded color ─────────
  //
  // var(--undefined1, var(--undefined2, rgb(251, 191, 36))). Neither
  // --undefined1 nor --undefined2 are declared in the component CSS, so bascik
  // leaves them unscoped. Since they are never defined anywhere, the browser
  // falls all the way through to the hardcoded rgb(251, 191, 36).

  test("box-fallback: undeclared props fall to hardcoded yellow", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const color = await fallbackBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(251, 191, 36)");
  });

  // ── 5. Instance B: same colors apply independently ────────────────────────

  test("instance B: all three boxes resolve to the same colors as instance A", async ({
    page,
  }) => {
    const b = getInstance(page, 1);
    const [primary, secondary, fallback] = await Promise.all([
      primaryBox(b).evaluate((el) => getComputedStyle(el).color),
      secondaryBox(b).evaluate((el) => getComputedStyle(el).color),
      fallbackBox(b).evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(primary).toBe("rgb(74, 222, 128)");
    expect(secondary).toBe("rgb(96, 165, 250)");
    expect(fallback).toBe("rgb(251, 191, 36)");
  });

  // ── 6. Instance isolation: two distinct wrapper elements ──────────────────

  test("two independent wrapper instances are rendered", async ({ page }) => {
    await expect(page.locator(".bascik__nested-vars__wrapper")).toHaveCount(2);
  });
});
