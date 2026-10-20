import { test, expect } from "@playwright/test";

test.describe("Component build scripts", () => {
  test("renders current page path for every component use on page 1", async ({
    page,
  }) => {
    await page.goto("/page-aware-1-test");
    const badge = page.getByTestId("page-aware-badge");
    await expect(badge).toHaveCount(2);
    await expect(badge.getByTestId("current-page-path")).toHaveText([
      "/page-aware-1-test",
      "/page-aware-1-test",
    ]);
  });

  test("renders current page path on page 2", async ({ page }) => {
    await page.goto("/page-aware-2-test");
    const badge = page.getByTestId("page-aware-badge");
    await expect(badge.getByTestId("current-page-path")).toHaveText(
      "/page-aware-2-test",
    );
  });

  test("shares build-once output across uses without page context", async ({
    page,
  }) => {
    await page.goto("/page-aware-1-test");
    const once = page.getByTestId("build-once-output");
    await expect(once).toHaveText(["no page context", "no page context"]);
    // The shared markup still goes through scoping and per-use expansion.
    await expect(once.first()).toHaveClass(
      /bascik__shared-build-badge__once-label/,
    );
    await expect(once.first()).toHaveCSS("color", "rgb(0, 0, 255)");
    const [firstId, secondId] = await once.evaluateAll((nodes) =>
      nodes.map((node) => node.id),
    );
    expect(firstId).toMatch(/once-anchor$/);
    expect(secondId).toMatch(/once-anchor$/);
    expect(firstId).not.toBe(secondId);
  });

  test("runs a component build script loaded with src= per use", async ({
    page,
  }) => {
    await page.goto("/page-aware-1-test");
    await expect(page.getByTestId("build-src-output")).toHaveText([
      "/page-aware-1-test",
      "/page-aware-1-test",
    ]);
    expect(await page.content()).not.toContain("export default");
  });

  // Markup returned by an imported helper is scoped like the component template.
  test("scopes markup returned by an imported helper", async ({ page }) => {
    await page.goto("/page-aware-2-test");
    const label = page.getByTestId("page-aware-label");
    await expect(label).toHaveText("/page-aware-2-test");
    await expect(label).toHaveClass(/bascik__page-aware-badge__badge-label/);
    await expect(label).toHaveCSS("color", "rgb(0, 128, 0)");
    const em = page.getByTestId("page-aware-em");
    await expect(em).toHaveClass(/bascik__page-aware-badge__el__em/);
    await expect(em).toHaveCSS("font-weight", "700");
    expect(await page.content()).not.toContain("data-bascik-output-scope");
  });
});
