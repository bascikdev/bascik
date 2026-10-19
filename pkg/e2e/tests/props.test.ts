/**
 * e2e tests for bascik prop injection on the props-test fixture page.
 *
 * Three instances of <prop-test> are rendered with different prop values:
 *   - Usage 1: all four props provided (title, description, badge, count)
 *   - Usage 2: only title and count provided; description and badge use fallbacks
 *   - Usage 3: no props at all; all four slots use fallback content
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable: e.g. `bascik__prop-test__title`.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number) {
  return page.locator(".bascik__prop-test__prop-wrapper").nth(n);
}

function title(inst: Locator) {
  return inst.locator(".bascik__prop-test__title");
}

function description(inst: Locator) {
  return inst.locator(".bascik__prop-test__description");
}

function badge(inst: Locator) {
  return inst.locator(".bascik__prop-test__badge");
}

function count(inst: Locator) {
  return inst.locator(".bascik__prop-test__count");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("props-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/props-test");
  });

  // -------------------------------------------------------------------------
  // Usage 1 — all props provided
  // -------------------------------------------------------------------------

  test("usage 1: title prop is injected", async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(title(inst)).toHaveText("My Custom Title");
  });

  test("usage 1: description prop is injected", async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(description(inst)).toHaveText("A custom description.");
  });

  test("usage 1: badge prop is injected", async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(badge(inst)).toHaveText("premium");
  });

  test("usage 1: count prop is injected", async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(count(inst)).toHaveText("42");
  });

  // -------------------------------------------------------------------------
  // Usage 2 — only title and count provided; description and badge use fallback
  // -------------------------------------------------------------------------

  test("usage 2: title prop is injected", async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(title(inst)).toHaveText("Partial Props");
  });

  test("usage 2: count prop is injected", async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(count(inst)).toHaveText("7");
  });

  test("usage 2: description falls back to default", async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(description(inst)).toHaveText("Default description text.");
  });

  test("usage 2: badge falls back to default", async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(badge(inst)).toHaveText("default");
  });

  // -------------------------------------------------------------------------
  // Usage 3 — no props; all slots use fallback content
  // -------------------------------------------------------------------------

  test("usage 3: title falls back to default", async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(title(inst)).toHaveText("Default Title");
  });

  test("usage 3: description falls back to default", async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(description(inst)).toHaveText("Default description text.");
  });

  test("usage 3: badge falls back to default", async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(badge(inst)).toHaveText("default");
  });

  test("usage 3: count falls back to default", async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(count(inst)).toHaveText("0");
  });

  // -------------------------------------------------------------------------
  // Instance isolation — verify instances are independent
  // -------------------------------------------------------------------------

  test("usage 1 title is not the default fallback", async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(title(inst)).not.toHaveText("Default Title");
  });

  test("usage 1 and usage 3 have distinct titles", async ({ page }) => {
    const inst1 = getInstance(page, 0);
    const inst3 = getInstance(page, 2);
    await expect(title(inst1)).toHaveText("My Custom Title");
    await expect(title(inst3)).toHaveText("Default Title");
  });
});
