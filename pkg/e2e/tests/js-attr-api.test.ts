/**
 * e2e tests for JS DOM attribute API scoping on the attr-api-test fixture page.
 *
 * Two instances of <attr-api> are rendered side by side. Tests cover:
 *   - classList.contains correctly reflects adds (scoped class name rewritten)
 *   - removeAttribute("class") removes the class attribute entirely (not scoped)
 *   - toggleAttribute("hidden") adds/removes a boolean attribute (not scoped)
 *   - dataset.theme is readable and data-* values are not scoped
 *   - Instance A and B operate independently
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator(".bascik__attr-api__wrapper").nth(0),
    b: page.locator(".bascik__attr-api__wrapper").nth(1),
  };
}

function target(inst: Locator) {
  return inst.locator('[id$="__target"]');
}
function status(inst: Locator) {
  return inst.locator('[id$="__status"]');
}
function btn(inst: Locator, idSuffix: string) {
  return inst.locator(`[id$="__${idSuffix}"]`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("attr-api page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/attr-api-test");
  });

  // ── 1. classList.contains reports false before class is added ────────────

  test("classList.contains reports false before class is added", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "has-class-btn").click();
    await expect(status(a)).toHaveText("has highlighted: false");
  });

  // ── 2. classList.contains correctly reports when class is present ─────────

  test("classList.contains correctly reports true after class is added", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "add-class-btn").click();
    await btn(a, "has-class-btn").click();
    await expect(status(a)).toHaveText("has highlighted: true");
  });

  // ── 3. removeAttribute removes the class attribute entirely ──────────────

  test('removeAttribute("class") removes the class attribute entirely', async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "add-class-btn").click();
    await expect(target(a)).toHaveClass(/bascik__attr-api__highlighted/);
    await btn(a, "remove-attr-btn").click();
    expect(await target(a).getAttribute("class")).toBeNull();
  });

  test("after removeAttribute, target has no class attribute", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "remove-attr-btn").click();
    expect(await target(a).getAttribute("class")).toBeNull();
  });

  // ── 4. toggleAttribute("hidden") ─────────────────────────────────────────

  test('toggleAttribute("hidden") hides the target element', async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "toggle-hidden-btn").click();
    await expect(target(a)).toBeHidden();
  });

  test('toggleAttribute("hidden") twice shows the element again', async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await btn(a, "toggle-hidden-btn").click();
    await btn(a, "toggle-hidden-btn").click();
    await expect(target(a)).toBeVisible();
  });

  // ── 5. dataset.theme is readable and not scoped ───────────────────────────

  test("dataset.theme is readable and not scoped", async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, "dataset-btn").click();
    await expect(status(a)).toHaveText("data-theme = dark");
  });

  // ── 6. Instance A and B operate independently ────────────────────────────

  test("instance A and B operate independently", async ({ page }) => {
    const { a, b } = getInstances(page);

    // Add class to A only
    await btn(a, "add-class-btn").click();
    await expect(target(a)).toHaveClass(/bascik__attr-api__highlighted/);
    await expect(target(b)).not.toHaveClass(/highlighted/);

    // Toggle hidden on B only
    await btn(b, "toggle-hidden-btn").click();
    await expect(target(b)).toBeHidden();
    await expect(target(a)).toBeVisible();

    // removeAttribute on B does not affect A's class
    await btn(b, "remove-attr-btn").click();
    expect(await target(b).getAttribute("class")).toBeNull();
    await expect(target(a)).toHaveClass(/bascik__attr-api__highlighted/);
  });
});
