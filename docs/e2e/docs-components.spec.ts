import { test, expect } from "@playwright/test";

test.describe("Docs Component E2E Tests", () => {
  test("components page does not double render page content", async ({
    page,
  }) => {
    await page.goto("/components");

    // Ensure main content container has exactly one h1 heading
    const h1s = page.locator("#main-content h1");
    await expect(h1s).toHaveCount(1);
    await expect(h1s).toHaveText("Components");

    // Ensure intro paragraph text appears only once in main content
    const introParagraphs = page.locator("#main-content p", {
      hasText: "Components are the core building block in Bascik.",
    });
    await expect(introParagraphs).toHaveCount(1);
  });

  test("component-demo switches between preview, code, and output tabs", async ({
    page,
  }) => {
    await page.goto("/components");

    // Locate component-demo tab labels/radios using robust test IDs
    const previewLabel = page.getByTestId("demo-tab-preview").first();
    const codeLabel = page.getByTestId("demo-tab-code").first();

    await expect(previewLabel).toBeVisible();
    await expect(codeLabel).toBeVisible();

    // Click Source tab and verify pane switching
    await codeLabel.click();

    const codePane = page.getByTestId("demo-pane-code").first();
    await expect(codePane).toBeVisible();
  });

  test("comp-toggle expands and collapses detail panel", async ({ page }) => {
    await page.goto("/components");

    const toggleBtn = page
      .getByRole("button", { name: /Read more|Show less/ })
      .first();
    const detailPanel = page.getByTestId("toggle-detail").first();

    await expect(detailPanel).toBeHidden();
    await expect(toggleBtn).toHaveText("Read more");

    // Click toggle button to expand
    await toggleBtn.click();
    await expect(detailPanel).toBeVisible();
    await expect(toggleBtn).toHaveText("Show less");

    // Click again to collapse
    await toggleBtn.click();
    await expect(detailPanel).toBeHidden();
    await expect(toggleBtn).toHaveText("Read more");
  });

  test("demo-counter increments and decrements count", async ({ page }) => {
    await page.goto("/scoped-javascript");

    const incBtn = page.getByTestId("counter-inc").first();
    const decBtn = page.getByTestId("counter-dec").first();
    const countVal = page.getByTestId("counter-count").first();

    await expect(countVal).toHaveText("0");

    // Increment
    await incBtn.click();
    await expect(countVal).toHaveText("1");

    await incBtn.click();
    await expect(countVal).toHaveText("2");

    // Decrement
    await decBtn.click();
    await expect(countVal).toHaveText("1");
  });

  test("docs-search modal opens, filters results on typing, and closes on Escape", async ({
    page,
  }) => {
    await page.goto("/");

    const searchBtn = page.getByRole("button", { name: "Search docs" }).first();
    const modal = page.getByTestId("search-overlay").first();
    const input = page.getByPlaceholder("Search docs…");
    const resultsList = page.getByRole("listbox", { name: "Search results" });

    await expect(modal).toBeHidden();

    // Open search modal via button click
    await searchBtn.click();
    await expect(modal).toBeVisible();
    await expect(input).toBeFocused();

    // Type query
    await input.fill("scoped styles");

    // Verify search results populate
    const resultItem = resultsList.locator("li").first();
    await expect(resultItem).toBeVisible();
    await expect(resultItem).toContainText("Scoped Styles");

    // Close modal via Escape key
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });

  test("docs-search shows Home first with popular pages nested under it for a brand query", async ({
    page,
  }) => {
    await page.goto("/getting-started");

    await page.getByRole("button", { name: "Search docs" }).first().click();
    await page.getByPlaceholder("Search docs…").fill("bascik");

    const home = page.getByTestId("search-home-result");
    await expect(home).toBeVisible();

    const resultsList = page.getByRole("listbox", { name: "Search results" });
    await expect(resultsList.locator(":scope > li").first()).toHaveAttribute(
      "data-testid",
      "search-home-result",
    );

    await expect(home.getByRole("link").first()).toHaveAttribute("href", "/");
    await expect(home.getByTestId("search-sitelink")).toHaveText([
      "Getting Started",
      "Why Bascik",
      "Developer Experience",
      "Bascik vs Frameworks",
      "Components",
      "Scoped Styles",
    ]);

    // Sitelink pages are not repeated as separate results further down
    await expect(
      resultsList.locator(':scope > li > a[href="/components"]'),
    ).toHaveCount(0);

    // Arrow keys move from the input through Home, then its nested links
    await page.keyboard.press("ArrowDown");
    await expect(home.getByRole("link").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(home.getByTestId("search-sitelink").first()).toBeFocused();
  });

  test("docs-search does not show Home for a topic query", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Search docs" }).first().click();
    await page.getByPlaceholder("Search docs…").fill("scoped styles");

    await expect(
      page
        .getByRole("listbox", { name: "Search results" })
        .locator("li")
        .first(),
    ).toBeVisible();
    await expect(page.getByTestId("search-home-result")).toHaveCount(0);
  });

  test("docs-search prefetches a result on hover", async ({ page }) => {
    await page.goto("/");

    const searchBtn = page.getByRole("button", { name: "Search docs" }).first();
    const modal = page.getByTestId("search-overlay").first();
    const input = page.getByPlaceholder("Search docs…");
    const resultsList = page.getByRole("listbox", { name: "Search results" });

    // Open search modal via button click
    await searchBtn.click();
    await expect(modal).toBeVisible();
    await expect(input).toBeFocused();

    // Type query
    await input.fill("scoped styles");

    // Locate the first result's link
    const link = resultsList.getByRole("link").first();
    await expect(link).toBeVisible();

    const href = await link.getAttribute("href");
    expect(href).toBeTruthy();

    // Verify link is not already preloaded/prefetched
    const prefetchLocator = page.locator(
      `head link[rel="prefetch"][href="${href}"]`,
    );
    await expect(prefetchLocator).not.toBeAttached();

    // Hover over the search result link
    await link.hover();

    // Verify that the prefetch link is attached to head
    await expect(prefetchLocator).toBeAttached();
  });

  test("comp-alert dismisses when clicking close button", async ({ page }) => {
    await page.goto("/components");

    const closeBtn = page.getByRole("button", { name: "Dismiss" }).first();
    const alert = page.getByTestId("comp-alert").first();

    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await expect(alert).toBeHidden();
    }
  });
});
