/**
 * /how-to/agent-migration in the browser.
 *
 * - The page loads with no CSP violation and no console error.
 * - The grid demo box: the Preview renders the press section, styled by the component's scoped CSS (one centered
 *   section no wider than 1200 px); the Source and Output tabs carry the component and the compiled, scoped result.
 * - No horizontal scroll at 375 px.
 */
import { test, expect, type Page } from "@playwright/test";

const PATH = "/how-to/agent-migration";

/** The demo box after the "Collapse framework grid wrappers" heading. */
const gridBox = (page: Page) =>
  page
    .locator(
      `h3:has-text("grid wrappers") ~ *:has([data-testid="demo-pane-code"])`,
    )
    .first();

test.describe("Migrating with Coding Agents", () => {
  test("loads without CSP violations or console errors", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(msg.text());
    });
    page.on("pageerror", (err) => problems.push(err.message));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(200);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Migrating with Coding Agents",
      }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });

  test("the grid demo Preview renders one scoped, centered press section", async ({
    page,
  }) => {
    await page.goto(PATH);
    const box = gridBox(page);
    await expect(box).toBeVisible();
    const preview = box.getByTestId("demo-pane-preview");
    await expect(preview).toBeVisible();
    const section = preview.locator("section").first();
    await expect(section).toBeVisible();
    await expect(section.locator("li").first()).toBeVisible();
    const layout = await section.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const p = el.parentElement!.getBoundingClientRect();
      return {
        width: r.width,
        left: r.left - p.left,
        right: p.right - r.right,
        className: el.className,
      };
    });
    expect(layout.width).toBeLessThanOrEqual(1200);
    expect(Math.abs(layout.left - layout.right)).toBeLessThanOrEqual(2);
    // Scoped: the authored class name is rewritten.
    expect(layout.className).not.toBe("press");
  });

  test("Source and Output tabs show the component and the compiled result", async ({
    page,
  }) => {
    await page.goto(PATH);
    const box = gridBox(page);
    const code = (
      await box.getByTestId("demo-pane-code").allTextContents()
    ).join("\n");
    expect(code).toContain("src/components/press-list/press-list.html");
    expect(code).toMatch(/min\(100%,\s*1200px\)/);
    // The Output's class attribute is the scoped form, not the bare authored name.
    expect(code).toMatch(/class="[^"]*press[^"]*"/);
  });

  test("no horizontal scroll at 375 px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(PATH);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
