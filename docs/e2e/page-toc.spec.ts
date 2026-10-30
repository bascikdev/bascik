/// <reference lib="dom" />

import { test, expect } from "@playwright/test";

test.describe('"On this page" table of contents', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("lists page headings and links resolve to heading ids", async ({
    page,
  }) => {
    await page.goto("/press");
    const toc = page.getByRole("navigation", { name: "On this page" });
    await expect(toc).toBeVisible();

    const hrefs = await toc
      .getByRole("link")
      .evaluateAll((links) => links.map((a) => String(a.getAttribute("href"))));
    expect(hrefs.length).toBeGreaterThan(2);
    for (const href of hrefs) {
      expect(href.startsWith("#"), href).toBe(true);
      await expect(page.locator(`[id="${href.slice(1)}"]`), href).toHaveCount(
        1,
      );
    }
  });

  test("clicking a link updates the URL hash and marks it as the current location", async ({
    page,
  }) => {
    await page.goto("/press");
    const toc = page.getByRole("navigation", { name: "On this page" });
    const links = toc.getByRole("link");
    const target = links.nth(1);
    const href = String(await target.getAttribute("href"));

    await target.click();

    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(target).toHaveAttribute("aria-current", "location");
    await expect(toc.locator('[aria-current="location"]')).toHaveCount(1);
  });

  // Blocks after the fourth h2 use content-visibility: auto and count at an estimated height until they render.
  // A smooth scroll aimed with those estimates lands far from the heading unless the click re-aims after it.
  for (const [path, nth] of [
    ["/configuration", "last"],
    ["/configuration", "middle"],
    ["/stream-scripts", "last"],
  ] as const) {
    test(`a smooth-scrolled click on a late link in ${path} (${nth}) lands on its heading`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(path);
      const toc = page.getByRole("navigation", { name: "On this page" });
      const links = toc.getByRole("link");
      const count = await links.count();
      // Past the fourth h2, so the blocks between here and there are still at their estimated size.
      expect(count).toBeGreaterThan(8);
      const target = links.nth(
        nth === "last" ? count - 2 : Math.floor(count * 0.6),
      );
      const href = String(await target.getAttribute("href"));

      await target.click();

      const heading = page.locator(`[id="${href.slice(1)}"]`);
      await expect
        .poll(
          () =>
            heading.evaluate((el) => {
              const offset = parseFloat(
                getComputedStyle(document.documentElement).getPropertyValue(
                  "--anchor-scroll-offset",
                ),
              );
              return Math.abs(
                Math.round(el.getBoundingClientRect().top - offset),
              );
            }),
          { timeout: 6000 },
        )
        .toBeLessThanOrEqual(3);
      const delta = await heading.evaluate((el) => {
        const offset = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--anchor-scroll-offset",
          ),
        );
        return el.getBoundingClientRect().top - offset;
      });
      expect(Math.abs(delta)).toBeLessThanOrEqual(3);
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      await expect(target).toHaveAttribute("aria-current", "location");
      await expect(toc.locator('[aria-current="location"]')).toHaveCount(1);
    });
  }

  test("tracks the anchor offset after opening a search result", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Search docs" }).first().click();
    await page.getByPlaceholder("Search docs…").fill("@/");
    await page
      .getByRole("listbox", { name: "Search results" })
      .getByRole("link", { name: /Script Imports › Import Root Aliases/ })
      .click();

    await expect(page).toHaveURL(/\/script-imports#import-root-aliases$/);
    const toc = page.getByRole("navigation", { name: "On this page" });
    const target = toc.getByRole("link", {
      name: "Import Root Aliases (@/)",
      exact: true,
    });
    await expect(target).toHaveAttribute("aria-current", "location");

    const destination = await page
      .getByRole("heading", { name: /Import Root Aliases/ })
      .evaluate((heading) => {
        const offset = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--anchor-scroll-offset",
          ),
        );
        return heading.getBoundingClientRect().top + window.scrollY - offset;
      });
    await page.evaluate(
      (top) => window.scrollTo({ top: top - 12, behavior: "instant" }),
      destination,
    );
    await expect(target).not.toHaveAttribute("aria-current", "location");
    await page.evaluate(
      (top) => window.scrollTo({ top: top + 12, behavior: "instant" }),
      destination,
    );
    await expect(target).toHaveAttribute("aria-current", "location");
    await expect(toc.locator('[aria-current="location"]')).toHaveCount(1);
  });

  test("is hidden on narrow viewports", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/press");
    await expect(
      page.getByRole("navigation", { name: "On this page" }),
    ).toBeHidden();
  });
});
