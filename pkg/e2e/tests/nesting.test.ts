/**
 * e2e tests for bascik nested component rendering and self-closing tags on the
 * nesting-test fixture page.
 *
 * Two instances of <nesting-test> are rendered.  Each <nesting-test> contains
 * three <inner-badge> child components declared with self-closing syntax:
 *
 *   <inner-badge data-bascik-prop-label="featured" />
 *   <inner-badge data-bascik-prop-label="active" />
 *   <inner-badge />                                 ← fallback "Default"
 *
 * Tests verify:
 *   - Parent component props are injected into the nesting-test card
 *   - Child component props are threaded through to inner-badge spans
 *   - Self-closing <inner-badge /> tags resolve identically to paired tags
 *   - Parent CSS is scoped to nesting-test (bascik__nesting-test__*)
 *   - Child CSS is scoped to inner-badge (bascik__inner-badge__*)
 *   - Each card is independent (no prop bleed-through between instances)
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable: e.g. `bascik__nesting-test__card`.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function card(page: Page, n: number): Locator {
  return page.locator(".bascik__nesting-test__card").nth(n);
}

function cardTitle(inst: Locator): Locator {
  return inst.locator(".bascik__nesting-test__card-title");
}

function cardBody(inst: Locator): Locator {
  return inst.locator(".bascik__nesting-test__card-body");
}

function badges(inst: Locator): Locator {
  return inst.locator(".bascik__inner-badge__badge");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("nesting-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/nesting-test");
  });

  // -------------------------------------------------------------------------
  // Card 1 — parent props
  // -------------------------------------------------------------------------

  test("card 1: title prop is injected", async ({ page }) => {
    await expect(cardTitle(card(page, 0))).toHaveText("First Card");
  });

  test("card 1: body prop is injected", async ({ page }) => {
    await expect(cardBody(card(page, 0))).toHaveText("Body of the first card.");
  });

  // -------------------------------------------------------------------------
  // Card 2 — parent props + independence
  // -------------------------------------------------------------------------

  test("card 2: title prop is injected", async ({ page }) => {
    await expect(cardTitle(card(page, 1))).toHaveText("Second Card");
  });

  test("card 2: title is independent from card 1", async ({ page }) => {
    await expect(cardTitle(card(page, 1))).not.toHaveText("First Card");
  });

  // -------------------------------------------------------------------------
  // Nested badges — count
  // -------------------------------------------------------------------------

  test("card 1: contains 3 inner-badge instances", async ({ page }) => {
    await expect(badges(card(page, 0))).toHaveCount(3);
  });

  test("card 2: contains 3 inner-badge instances", async ({ page }) => {
    await expect(badges(card(page, 1))).toHaveCount(3);
  });

  // -------------------------------------------------------------------------
  // Child props threaded through self-closing tags
  // -------------------------------------------------------------------------

  test('card 1: first badge shows "featured" (self-closing with prop)', async ({
    page,
  }) => {
    await expect(badges(card(page, 0)).nth(0)).toHaveText("featured");
  });

  test('card 1: second badge shows "active" (self-closing with prop)', async ({
    page,
  }) => {
    await expect(badges(card(page, 0)).nth(1)).toHaveText("active");
  });

  test('card 1: third badge shows "Default" (self-closing, no prop — fallback)', async ({
    page,
  }) => {
    await expect(badges(card(page, 0)).nth(2)).toHaveText("Default");
  });

  // -------------------------------------------------------------------------
  // CSS scoping — parent component
  // -------------------------------------------------------------------------

  test("parent CSS applied: card has correct background color", async ({
    page,
  }) => {
    const bg = await card(page, 0).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(20, 20, 20)");
  });

  // -------------------------------------------------------------------------
  // CSS scoping — child component
  // -------------------------------------------------------------------------

  test("child CSS applied: badge has correct background color", async ({
    page,
  }) => {
    const bg = await badges(card(page, 0))
      .nth(0)
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(30, 58, 95)");
  });
});
