/**
 * e2e tests for cross-component CSS isolation on the isolation-test fixture page.
 *
 * Two components — red-card and blue-card — both define `.card`, `.title`,
 * `.body`, and `.badge` in their CSS. Without bascik's scoping these class
 * names would collide in the global CSS namespace. These tests verify that
 * each component's styles are fully isolated via unique scoped prefixes:
 *   - red-card  → bascik__red-card__*
 *   - blue-card → bascik__blue-card__*
 *
 * The fixture page renders two instances of each component so multi-instance
 * behaviour can also be confirmed.
 */
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const redCard = (page: Page, n: number) =>
  page.locator(".bascik__red-card__card").nth(n);

const blueCard = (page: Page, n: number) =>
  page.locator(".bascik__blue-card__card").nth(n);

const redTitle = (page: Page, n: number) =>
  page.locator(".bascik__red-card__title").nth(n);

const blueTitle = (page: Page, n: number) =>
  page.locator(".bascik__blue-card__title").nth(n);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("cross-component CSS isolation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/isolation-test");
  });

  // --- Background colours ---------------------------------------------------

  test("red card has red background", async ({ page }) => {
    const bg = await redCard(page, 0).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(69, 10, 10)");
  });

  test("blue card has blue background", async ({ page }) => {
    const bg = await blueCard(page, 0).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(8, 28, 69)");
  });

  // --- Title colours --------------------------------------------------------

  test("red title has red color", async ({ page }) => {
    const color = await redTitle(page, 0).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(239, 68, 68)");
  });

  test("blue title has blue color", async ({ page }) => {
    const color = await blueTitle(page, 0).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(59, 130, 246)");
  });

  // --- Scoped class names ---------------------------------------------------

  test("red card class name includes red-card scope", async ({ page }) => {
    const classList = await redCard(page, 0).evaluate((el) => [
      ...el.classList,
    ]);
    expect(classList).toContain("bascik__red-card__card");
  });

  test("blue card class name includes blue-card scope", async ({ page }) => {
    const classList = await blueCard(page, 0).evaluate((el) => [
      ...el.classList,
    ]);
    expect(classList).toContain("bascik__blue-card__card");
  });

  test("red card does NOT have blue-card class", async ({ page }) => {
    const classList = await redCard(page, 0).evaluate((el) => [
      ...el.classList,
    ]);
    expect(classList).not.toContain("bascik__blue-card__card");
  });

  test("blue card does NOT have red-card class", async ({ page }) => {
    const classList = await blueCard(page, 0).evaluate((el) => [
      ...el.classList,
    ]);
    expect(classList).not.toContain("bascik__red-card__card");
  });

  // --- Multiple instances ---------------------------------------------------

  test("second red card is also red", async ({ page }) => {
    const bg = await redCard(page, 1).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(69, 10, 10)");
  });

  test("second blue card is also blue", async ({ page }) => {
    const bg = await blueCard(page, 1).evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(bg).toBe("rgb(8, 28, 69)");
  });

  // --- Badge text -----------------------------------------------------------

  test('red badge text is "red"', async ({ page }) => {
    const text = await page
      .locator(".bascik__red-card__badge")
      .nth(0)
      .textContent();
    expect(text?.trim()).toBe("red");
  });

  test('blue badge text is "blue"', async ({ page }) => {
    const text = await page
      .locator(".bascik__blue-card__badge")
      .nth(0)
      .textContent();
    expect(text?.trim()).toBe("blue");
  });

  // --- Prop content ---------------------------------------------------------

  test("prop content shows in red card", async ({ page }) => {
    const text = await page
      .locator(".bascik__red-card__body")
      .nth(0)
      .textContent();
    expect(text?.trim()).toBe("Red card custom content");
  });

  test("prop content shows in blue card", async ({ page }) => {
    const text = await page
      .locator(".bascik__blue-card__body")
      .nth(0)
      .textContent();
    expect(text?.trim()).toBe("Blue card custom content");
  });
});
