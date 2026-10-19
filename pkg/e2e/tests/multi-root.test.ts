/**
 * E2E tests for multiple root elements and multiple style tags in components.
 */
import { test, expect } from "@playwright/test";

test.describe("multi-root-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/multi-root-test");
  });

  test("renders multiple root elements directly under body", async ({
    page,
  }) => {
    const header = page.locator("header.bascik__multi-root-card__multi-header");
    const bodyDiv = page.locator("div.bascik__multi-root-card__multi-body");
    const footer = page.locator("footer.bascik__multi-root-card__multi-footer");

    await expect(header).toBeVisible();
    await expect(bodyDiv).toBeVisible();
    await expect(footer).toBeVisible();
  });

  test("merges inherited attributes onto the first root element only", async ({
    page,
  }) => {
    const header = page.locator("header.bascik__multi-root-card__multi-header");
    await expect(header).toHaveAttribute("id", "card-1-root");
    await expect(header).toHaveClass(/custom-usage-class/);
    await expect(header).toHaveAttribute("data-testid", "multi-root-1");

    const bodyDiv = page.locator("div.bascik__multi-root-card__multi-body");
    await expect(bodyDiv).not.toHaveAttribute("data-testid", "multi-root-1");
  });

  test("resolves props and slots across multiple root elements", async ({
    page,
  }) => {
    const title = page.locator("header h3");
    await expect(title).toHaveText("First Card Title");

    const slotContent = page.locator("#slot-p");
    await expect(slotContent).toHaveText("Custom slotted paragraph");
  });

  test("executes scoped script attached to element in multiple root component", async ({
    page,
  }) => {
    const button = page.locator("footer button");
    const status = page.locator("footer span");

    await expect(status).toHaveText("Active");
    await button.click();
    await expect(status).toHaveText("Paused");
  });

  test("extracts and applies CSS from multiple style tags in a component", async ({
    page,
  }) => {
    const styleBox = page.locator("#style-card-root");
    await expect(styleBox).toBeVisible();
    await expect(styleBox).toHaveCSS("background-color", "rgb(239, 246, 255)");
    await expect(styleBox).toHaveCSS("color", "rgb(30, 64, 175)");
    await expect(styleBox).toHaveCSS("border-top-width", "2px");
    await expect(styleBox).toHaveCSS("border-top-style", "solid");
  });
});
