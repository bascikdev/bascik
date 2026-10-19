/**
 * e2e tests for component composability via slots on the slot-component-test
 * fixture page.
 *
 * Three instances of <slot-card> are rendered:
 *   - Usage 1: default slot contains a <status-badge> component + plain text;
 *              named header and footer slots are filled with plain text.
 *   - Usage 2: all three slots filled with vanilla HTML only (no nested component).
 *   - Usage 3: no slot content at all — all three slots use fallback content.
 *
 * Tests verify:
 *   - A component used as slot content (<status-badge>) is transpiled correctly
 *   - The slotted component's CSS namespace (bascik__status-badge__*) is
 *     independent of the host's namespace (bascik__slot-card__*)
 *   - Props passed to the slotted component are applied
 *   - Fallback content renders when no slot content is provided
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCard(page: Page, n: number): Locator {
  return page.locator(".bascik__slot-card__card").nth(n);
}

function header(card: Locator): Locator {
  return card.locator(".bascik__slot-card__card-header");
}

function body(card: Locator): Locator {
  return card.locator(".bascik__slot-card__card-body");
}

function footer(card: Locator): Locator {
  return card.locator(".bascik__slot-card__card-footer");
}

function badge(container: Locator): Locator {
  return container.locator(".bascik__status-badge__badge");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("slot-component-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/slot-component-test");
  });

  // -------------------------------------------------------------------------
  // Usage 1 — component in default slot
  // -------------------------------------------------------------------------

  test("usage 1: header slot shows text content", async ({ page }) => {
    const card = getCard(page, 0);
    await expect(header(card)).toContainText("Card with Component Slot");
  });

  test("usage 1: default slot contains rendered status-badge", async ({
    page,
  }) => {
    const card = getCard(page, 0);
    await expect(badge(body(card))).toHaveCount(1);
  });

  test('usage 1: status-badge shows prop "online"', async ({ page }) => {
    const card = getCard(page, 0);
    await expect(badge(body(card))).toHaveText("online");
  });

  test("usage 1: status-badge has correct background color", async ({
    page,
  }) => {
    const card = getCard(page, 0);
    await expect(badge(body(card))).toHaveCSS(
      "background-color",
      "rgb(22, 101, 52)",
    );
  });

  test("usage 1: slot-card body has correct background color", async ({
    page,
  }) => {
    const card = getCard(page, 0);
    await expect(card).toHaveCSS("background-color", "rgb(16, 16, 16)");
  });

  test("usage 1: slot-card and status-badge namespaces coexist", async ({
    page,
  }) => {
    const card = getCard(page, 0);
    // Both scoped class namespaces must be present in the same DOM subtree
    await expect(card.locator(".bascik__slot-card__card-body")).toHaveCount(1);
    await expect(badge(card)).toHaveCount(1);
  });

  test("usage 1: footer slot shows text content", async ({ page }) => {
    const card = getCard(page, 0);
    await expect(footer(card)).toContainText("Footer text");
  });

  // -------------------------------------------------------------------------
  // Usage 2 — plain content only, no nested component
  // -------------------------------------------------------------------------

  test("usage 2: plain content renders in body", async ({ page }) => {
    const card = getCard(page, 1);
    await expect(body(card)).toContainText("Just plain content here.");
  });

  test("usage 2: header slot shows plain text", async ({ page }) => {
    const card = getCard(page, 1);
    await expect(header(card)).toContainText("Plain Text Card");
  });

  test("usage 2: status-badge is NOT present in this card", async ({
    page,
  }) => {
    const card = getCard(page, 1);
    await expect(badge(card)).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Usage 3 — all fallbacks
  // -------------------------------------------------------------------------

  test("usage 3: fallback header appears", async ({ page }) => {
    const card = getCard(page, 2);
    await expect(header(card)).toContainText("No header");
  });

  test("usage 3: fallback body appears", async ({ page }) => {
    const card = getCard(page, 2);
    await expect(body(card)).toContainText("No content provided.");
  });

  test("usage 3: fallback footer appears", async ({ page }) => {
    const card = getCard(page, 2);
    await expect(footer(card)).toContainText("No footer");
  });
});
