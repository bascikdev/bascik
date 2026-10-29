/// <reference lib="dom" />

// Behavior the docs performance work must not break: below-the-fold rendering is skipped with
// content-visibility, code is highlighted at build time, the sidebar scrolls its active link into view
// without forcing layout before first paint, and pages may be prerendered before they are shown.

import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Where the docs put a heading after an anchor jump: below the sticky header and the section label. */
const anchorOffset = (page: Page) =>
  page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--anchor-scroll-offset",
      ),
    ),
  );

/** Distance from the viewport top to the element, once the page has finished moving. */
async function settledTop(page: Page, selector: string): Promise<number> {
  let previous = Number.NaN;
  // The docs scroll smoothly, so wait for the jump to finish.
  for (let attempt = 0; attempt < 50; attempt++) {
    const top = await page
      .locator(selector)
      .evaluate((element) => element.getBoundingClientRect().top);
    if (Math.abs(top - previous) < 0.5 && Math.abs(top) < 2000) return top;
    previous = top;
    await page.waitForTimeout(100);
  }
  return previous;
}

test.describe("long pages with content below the fold", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a deep #hash link lands on its heading", async ({ page }) => {
    await page.goto("/cli#production-server");
    const top = await settledTop(page, "#production-server");
    expect(Math.abs(top - (await anchorOffset(page)))).toBeLessThan(4);
  });

  test("a deep #hash link on a page of tables lands on its heading", async ({
    page,
  }) => {
    await page.goto("/compatibility#javascript-scoping");
    const top = await settledTop(page, "#javascript-scoping");
    expect(Math.abs(top - (await anchorOffset(page)))).toBeLessThan(4);
  });

  test("the table of contents follows scrolling past content that was never rendered", async ({
    page,
  }) => {
    await page.goto("/cli");
    const toc = page.getByRole("navigation", { name: "On this page" });
    const target = toc.getByRole("link", {
      name: "Production server",
      exact: true,
    });
    await expect(target).not.toHaveAttribute("aria-current", "location");
    // Jump straight there, skipping everything in between, the way a scrollbar drag does.
    await page.locator("#production-server").evaluate((heading) => {
      const offset = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--anchor-scroll-offset",
        ),
      );
      window.scrollTo({
        top: heading.getBoundingClientRect().top + window.scrollY - offset + 12,
        behavior: "instant",
      });
    });
    await expect(target).toHaveAttribute("aria-current", "location");
    await expect(toc.locator('[aria-current="location"]')).toHaveCount(1);
  });

  test("find in page reaches text far below the fold", async ({ page }) => {
    await page.goto("/cli");
    // Text inside the last code block on the page, which starts out off screen.
    const needle = await page
      .locator("main [data-cblock-code]")
      .last()
      .evaluate((code) =>
        (code.textContent ?? "")
          .split("\n")
          .map((line) => line.trim())
          .reduce(
            (longest, line) => (line.length > longest.length ? line : longest),
            "",
          ),
      );
    expect(needle.length).toBeGreaterThan(3);
    const found = await page.evaluate(
      (text) =>
        (
          window as unknown as {
            find: (text: string, caseSensitive: boolean) => boolean;
          }
        ).find(text, true),
      needle,
    );
    expect(found).toBe(true);
    const selected = await page.evaluate(() => {
      const selection = window.getSelection();
      const node = selection?.anchorNode;
      const element = node instanceof Element ? node : node?.parentElement;
      return {
        text: selection?.toString() ?? "",
        inCode: Boolean(element?.closest("[data-cblock-code]")),
      };
    });
    expect(selected.text).toBe(needle);
    expect(selected.inCode).toBe(true);
  });
});

test.describe("code blocks", () => {
  test("arrive highlighted in the HTML, with no highlighter script", async ({
    page,
    request,
  }) => {
    const html = await (await request.get("/components")).text();
    expect(html).toContain('data-code-token="kw"');
    expect(html).not.toContain("function hlHtml");
    await page.goto("/components");
    const keyword = page
      .locator('main .prose-codeblock [data-code-token="kw"]')
      .first();
    await expect(keyword).toBeVisible();
    // The token colors in code-block.css reach the spans the build wrote into the slot.
    const colors = await keyword.evaluate((span) => ({
      token: getComputedStyle(span).color,
      code: getComputedStyle(span.parentElement!.closest("code")!).color,
    }));
    expect(colors.token).not.toBe(colors.code);
  });

  test("the copy button copies the plain code text, not markup", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "clipboard permissions");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/components");
    const block = page
      .locator("main .prose-codeblock")
      .filter({ has: page.locator("[data-code-token]") })
      .first();
    const code = block.locator("[data-cblock-code]");
    const expected = await code.evaluate((element) => element.textContent);
    expect(await code.locator("[data-code-token]").count()).toBeGreaterThan(0);
    await code.hover();
    await block.getByRole("button", { name: "Copy code" }).click();
    await expect(block.getByRole("button", { name: "Copied!" })).toBeVisible();
    await expect(block.getByRole("status")).toHaveText(
      "Code copied to clipboard",
    );
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(expected);
    expect(copied).not.toContain("data-code-token");
    expect(copied).not.toContain("&lt;");
  });

  test("each copy button copies its own block", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "clipboard permissions");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/cli");
    const second = page.locator("main .prose-codeblock").nth(1);
    const text = await second
      .locator("[data-cblock-code]")
      .evaluate((element) => element.textContent);
    await second.hover();
    await second.getByRole("button", { name: "Copy code" }).click();
    await expect(second.getByRole("status")).toHaveText(
      "Code copied to clipboard",
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      text,
    );
    // Only the block that was copied announces it.
    await expect(
      page.getByRole("status").filter({ hasText: "Code copied to clipboard" }),
    ).toHaveCount(1);
  });
});

test.describe("sidebar", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("marks the current page and scrolls it into view on a deep page", async ({
    page,
  }) => {
    await page.goto("/testing/unit-testing");
    const sidebar = page.getByRole("complementary", {
      name: "Documentation navigation",
    });
    const active = sidebar.locator('a[aria-current="page"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute("href", "/testing/unit-testing");
    await expect
      .poll(() =>
        active.evaluate((link) => {
          const nav = link.closest("aside") as HTMLElement;
          const box = link.getBoundingClientRect();
          const area = nav.getBoundingClientRect();
          return (
            nav.scrollTop > 0 &&
            box.top >= area.top &&
            box.bottom <= area.bottom
          );
        }),
      )
      .toBe(true);
  });

  test("scrolls the current page into view after growing from a phone layout", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto("/testing/unit-testing");
    await page.setViewportSize({ width: 1440, height: 900 });
    const active = page
      .getByRole("complementary", { name: "Documentation navigation" })
      .locator('a[aria-current="page"]');
    await expect
      .poll(() =>
        active.evaluate((link) => {
          const nav = link.closest("aside") as HTMLElement;
          const box = link.getBoundingClientRect();
          const area = nav.getBoundingClientRect();
          return (
            area.height > 0 && box.top >= area.top && box.bottom <= area.bottom
          );
        }),
      )
      .toBe(true);
  });

  test("prefetches a page on hover", async ({ page }) => {
    await page.goto("/cli");
    const link = page
      .getByRole("complementary", { name: "Documentation navigation" })
      .locator('a[href="/testing/unit-testing"]');
    const prefetch = page.locator(
      'head link[rel="prefetch"][href="/testing/unit-testing"]',
    );
    await expect(prefetch).not.toBeAttached();
    await link.hover();
    await expect(prefetch).toBeAttached();
  });
});

test.describe("phone menu", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("builds its section links on first open and marks the current page", async ({
    page,
  }) => {
    await page.goto("/testing/unit-testing");
    const menu = page.getByRole("navigation", { name: "Main" });
    // Not in the document until the menu opens.
    await expect(menu.locator('a[href="/cli"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await expect(
      menu.getByRole("link", { name: "Unit Testing" }),
    ).toBeVisible();
    await expect(
      menu.getByRole("link", { name: "Unit Testing" }),
    ).toHaveAttribute("aria-current", "page");
    // Closing and opening again does not add a second copy.
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await expect(menu.locator('a[href="/cli"]')).toHaveCount(1);
    await menu.getByRole("link", { name: "Command Line Interface" }).click();
    await expect(page).toHaveURL(/\/cli$/);
  });
});

// Cloudflare Pages sends a Speculation-Rules header, so Chromium may prerender a page while the pointer rests
// on a link to it. Playwright cannot run a real prerender (Chromium turns prerendering off while DevTools
// is attached), so this test emulates one: the page loads with document.prerendering true and is activated
// later, after the visitor switched the theme on the page they came from.
test.describe("prerendered pages", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("show the theme chosen after prerendering started, with the sidebar in place", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      let prerendering = true;
      Object.defineProperty(Document.prototype, "prerendering", {
        configurable: true,
        get: () => prerendering,
      });
      (window as unknown as { activate: () => void }).activate = () => {
        prerendering = false;
        document.dispatchEvent(new Event("prerenderingchange"));
      };
    });
    await page.goto("/testing/unit-testing");
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-theme",
      "light",
    );
    await expect(
      page.getByRole("button", { name: "Switch to light theme" }),
    ).toBeVisible();

    // The visitor switches to light on the page they are leaving, which shares this tab's sessionStorage.
    await page.evaluate(() => sessionStorage.setItem("theme", "light"));
    await page.evaluate(() =>
      (window as unknown as { activate: () => void }).activate(),
    );

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(
      page.getByRole("button", { name: "Switch to dark theme" }),
    ).toBeVisible();
    const active = page
      .getByRole("complementary", { name: "Documentation navigation" })
      .locator('a[aria-current="page"]');
    await expect(active).toHaveAttribute("href", "/testing/unit-testing");
    await expect(active).toBeInViewport();
    // The toggle still works after activation.
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("a page that was never prerendered ignores activation events", async ({
    page,
  }) => {
    await page.goto("/cli");
    await page.evaluate(() => sessionStorage.setItem("theme", "light"));
    await page.evaluate(() =>
      document.dispatchEvent(new Event("prerenderingchange")),
    );
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-theme",
      "light",
    );
  });
});

test.describe("search index loading", () => {
  test("/search downloads the index only after the page has loaded, then shows results", async ({
    page,
  }) => {
    await page.goto("/search?q=scoped%20styles");
    const results = page.getByRole("listbox", { name: "Search results" });
    // bascik --server compresses a file on its first request, which takes seconds for the 1 MB index.
    await expect(results.locator("li").first()).toContainText("Scoped Styles", {
      timeout: 15_000,
    });
    const timing = await page.evaluate(() => {
      const navigation = performance.getEntriesByType(
        "navigation",
      )[0] as PerformanceNavigationTiming;
      const index = performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("/assets/search-index."));
      return {
        loadEnd: navigation.loadEventEnd,
        indexStart: index?.startTime ?? -1,
        url: index?.name ?? "",
      };
    });
    expect(timing.url).toMatch(/\/assets\/search-index\.[0-9a-f]{10}\.json$/);
    expect(timing.indexStart).toBeGreaterThanOrEqual(timing.loadEnd);
  });

  test("hovering the search button starts the download before the click", async ({
    page,
  }) => {
    await page.goto("/cli");
    const request = page.waitForRequest(
      /\/assets\/search-index\.[0-9a-f]{10}\.json$/,
    );
    await page.getByRole("button", { name: "Search docs" }).first().hover();
    await request;
  });

  // The installed bascik agent skill fetches /assets/search-index.json from the docs site and needs a plain
  // array of entries, whatever format the pages themselves download.
  test("the bascik skill's search-docs.mjs finds sections in the published index", ({
    baseURL,
  }) => {
    const script = fileURLToPath(
      new URL("../../skills/bascik/scripts/search-docs.mjs", import.meta.url),
    );
    const run = spawnSync(
      process.execPath,
      [script, "scoped styles", "--json"],
      {
        encoding: "utf8",
        env: { ...process.env, BASCIK_DOCS_URL: baseURL! },
        timeout: 30_000,
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const results = JSON.parse(run.stdout);
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results)).toContain("/scoped-styles");
  });

  test("a failed download is tried again on the next open", async ({
    page,
  }) => {
    let attempts = 0;
    await page.route(/\/assets\/search-index\./, (route) => {
      attempts++;
      return attempts === 1 ? route.abort() : route.continue();
    });
    await page.goto("/cli");
    const input = page.getByPlaceholder("Search docs…");
    const results = page.getByRole("listbox", { name: "Search results" });
    // The keyboard shortcut, so no hover starts a download first.
    await page.keyboard.press("ControlOrMeta+k");
    await input.fill("scoped styles");
    await expect.poll(() => attempts).toBe(1);
    await expect(results.locator("li")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await input.fill("scoped styles");
    await expect(results.locator("li").first()).toContainText("Scoped Styles", {
      timeout: 15_000,
    });
    expect(attempts).toBe(2);
  });
});

// content-visibility: auto lays a block out at its estimated size in the first frame even when it is on
// screen, and the real size then moves the page. Only blocks well below the fold may use it.
test.describe("layout stability", () => {
  for (const viewport of [
    { width: 1350, height: 940 },
    { width: 412, height: 823 },
  ]) {
    for (const path of [
      "/cli",
      "/getting-started",
      "/sitemap",
      "/components",
      "/libraries",
      "/faq",
    ]) {
      test(`${path} does not shift while loading at ${viewport.width}px`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript(() => {
          const shifts: number[] = [];
          (window as unknown as { shifts: number[] }).shifts = shifts;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as Array<
              PerformanceEntry & { value: number; hadRecentInput: boolean }
            >)
              if (!entry.hadRecentInput) shifts.push(entry.value);
          }).observe({ type: "layout-shift", buffered: true });
        });
        await page.goto(path);
        await page.waitForTimeout(1500);
        const total = await page.evaluate(() =>
          (window as unknown as { shifts: number[] }).shifts.reduce(
            (sum, value) => sum + value,
            0,
          ),
        );
        expect(total).toBeLessThan(0.01);
      });
    }
  }
});
