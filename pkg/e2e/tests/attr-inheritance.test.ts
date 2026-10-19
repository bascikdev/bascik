/**
 * e2e tests for bascik attribute inheritance on the attr-inherit-test fixture page.
 *
 * Seven instances of <attr-inherit> are rendered, each exercising a different
 * aspect of attribute inheritance:
 *   - Usage 1: no extra attrs (baseline)
 *   - Usage 2: class passthrough — appended to existing scoped class
 *   - Usage 3: data-* passthrough
 *   - Usage 4: aria-label passthrough
 *   - Usage 5: style passthrough
 *   - Usage 6: id passthrough when the template root does not already define an id
 *   - Usage 7: multiple attrs combined
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable: e.g. `bascik__attr-inherit__card`.
 */
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the root element of the nth <attr-inherit> instance (0-based). */
function getRoot(page: Page, n: number) {
  return page.locator(".bascik__attr-inherit__card").nth(n);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("attr-inherit-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/attr-inherit-test");
  });

  // -------------------------------------------------------------------------
  // Usage 1 — baseline (no extra attrs)
  // -------------------------------------------------------------------------

  test("usage 1: root element has scoped class only", async ({ page }) => {
    const root = getRoot(page, 0);
    await expect(root).toHaveAttribute("class", "bascik__attr-inherit__card");
  });

  test("usage 1: root element has no data-theme attribute", async ({
    page,
  }) => {
    const root = getRoot(page, 0);
    await expect(root).not.toHaveAttribute("data-theme");
  });

  // -------------------------------------------------------------------------
  // Usage 2 — class passthrough
  // -------------------------------------------------------------------------

  test("usage 2: inherited class is appended to scoped class", async ({
    page,
  }) => {
    const root = getRoot(page, 1);
    await expect(root).toHaveClass(/bascik__attr-inherit__card/);
    await expect(root).toHaveClass(/extra-class/);
  });

  test("usage 2: full class attribute contains both scoped and inherited class", async ({
    page,
  }) => {
    const root = getRoot(page, 1);
    await expect(root).toHaveAttribute(
      "class",
      "bascik__attr-inherit__card extra-class",
    );
  });

  // -------------------------------------------------------------------------
  // Usage 3 — data-* passthrough
  // -------------------------------------------------------------------------

  test("usage 3: data-theme is inherited onto root element", async ({
    page,
  }) => {
    const root = getRoot(page, 2);
    await expect(root).toHaveAttribute("data-theme", "dark");
  });

  test("usage 3: root element retains scoped class", async ({ page }) => {
    const root = getRoot(page, 2);
    await expect(root).toHaveClass(/bascik__attr-inherit__card/);
  });

  // -------------------------------------------------------------------------
  // Usage 4 — aria-label passthrough
  // -------------------------------------------------------------------------

  test("usage 4: aria-label is inherited onto root element", async ({
    page,
  }) => {
    const root = getRoot(page, 3);
    await expect(root).toHaveAttribute("aria-label", "test card");
  });

  // -------------------------------------------------------------------------
  // Usage 5 — style passthrough
  // -------------------------------------------------------------------------

  test("usage 5: style attribute is inherited onto root element", async ({
    page,
  }) => {
    const root = getRoot(page, 4);
    await expect(root).toHaveAttribute("style", /^border-color: blue;?$/);
  });

  // -------------------------------------------------------------------------
  // Usage 6 — id passthrough
  // -------------------------------------------------------------------------

  test("usage 6: id attribute is inherited onto root element", async ({
    page,
  }) => {
    const root = getRoot(page, 5);
    await expect(root).toHaveAttribute("id", "should-not-appear-on-root");
  });

  // -------------------------------------------------------------------------
  // Usage 7 — multiple attrs combined
  // -------------------------------------------------------------------------

  test("usage 7: inherited class is appended alongside other attrs", async ({
    page,
  }) => {
    const root = getRoot(page, 6);
    await expect(root).toHaveAttribute(
      "class",
      "bascik__attr-inherit__card featured",
    );
  });

  test("usage 7: data-testid is inherited", async ({ page }) => {
    const root = getRoot(page, 6);
    await expect(root).toHaveAttribute("data-testid", "combined-card");
  });

  test("usage 7: aria-label is inherited", async ({ page }) => {
    const root = getRoot(page, 6);
    await expect(root).toHaveAttribute("aria-label", "combined card");
  });

  // -------------------------------------------------------------------------
  // Inner element — scoped class on non-root element
  // -------------------------------------------------------------------------

  test("card-label inside each instance has scoped class", async ({ page }) => {
    const labels = page.locator(".bascik__attr-inherit__card-label");
    await expect(labels).toHaveCount(7);
  });
});
