/**
 * e2e tests for bascik slot rendering on the slots-test fixture page.
 *
 * Three instances of <slot-host> are rendered with different slot content:
 *   - Usage 1: all three slots (header, default, footer) filled with custom content
 *   - Usage 2: only the default slot filled; named slots fall back to component defaults
 *   - Usage 3: no slot content at all; all three slots use fallback content
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable: e.g. `bascik__slot-host__host-wrapper`.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number) {
  return page.locator(".bascik__slot-host__host-wrapper").nth(n);
}

function headerArea(inst: Locator) {
  return inst.locator(".bascik__slot-host__header-area");
}

function contentArea(inst: Locator) {
  return inst.locator(".bascik__slot-host__content-area");
}

function footerArea(inst: Locator) {
  return inst.locator(".bascik__slot-host__footer-area");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("slots-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/slots-test");
  });

  // -------------------------------------------------------------------------
  // Usage 1 — all slots filled
  // -------------------------------------------------------------------------

  test("usage 1: header slot shows custom content", async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(headerArea(inst)).toContainText("Custom Header");
  });

  test("usage 1: default slot shows custom content", async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(contentArea(inst)).toContainText(
      "Custom default slot content",
    );
  });

  test("usage 1: footer slot shows custom content", async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(footerArea(inst)).toContainText("Custom Footer");
  });

  test("usage 1: fallback header is NOT shown when slot is filled", async ({
    page,
  }) => {
    const inst = getInstance(page, 0);
    await expect(headerArea(inst)).not.toContainText("Default Header");
  });

  // -------------------------------------------------------------------------
  // Usage 2 — only default slot filled; named slots use fallback
  // -------------------------------------------------------------------------

  test("usage 2: header named slot falls back to default content", async ({
    page,
  }) => {
    const inst = getInstance(page, 1);
    await expect(headerArea(inst)).toContainText("Default Header");
  });

  test("usage 2: default slot shows provided content", async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(contentArea(inst)).toContainText("Only default content");
  });

  test("usage 2: footer named slot falls back to default content", async ({
    page,
  }) => {
    const inst = getInstance(page, 1);
    await expect(footerArea(inst)).toContainText("Default Footer");
  });

  // -------------------------------------------------------------------------
  // Usage 3 — no slot content; all fallbacks render
  // -------------------------------------------------------------------------

  test("usage 3: header area shows fallback", async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(headerArea(inst)).toContainText("Default Header");
  });

  test("usage 3: content area shows fallback", async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(contentArea(inst)).toContainText("Default content goes here.");
  });

  test("usage 3: footer area shows fallback", async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(footerArea(inst)).toContainText("Default Footer");
  });
});
