/**
 * The dashboard template's Playwright spec. The web server it runs against
 * is `bascik --server`, so the live tile is rendered per request there.
 *
 * Each entry is one file of the generated project, as it is written: its
 * path from the project root, then its content.
 */

import type { TemplateFile } from "../../scaffold.js";

export const E2E_FILES: TemplateFile[] = [
  [
    "e2e/app.spec.ts",
    `import { test, expect, type Locator, type Page } from "@playwright/test";

// Locators use roles and data-testid, never class names or ids: the production
// build hashes those. The web server is \`bascik --server\`, so the live tile is
// rendered per request here.

/** The order rows the table is showing, in order. */
const shownRows = (page: Page): Locator =>
  page.getByTestId("orders-table-rows").locator("tr:visible");

/** One data-* value from each shown row. */
const shownValues = (page: Page, name: string): Promise<string[]> =>
  shownRows(page).evaluateAll(
    (rows, key) => rows.map((row) => (row as HTMLElement).dataset[key] ?? ""),
    name,
  );

test.describe("Overview", () => {
  test("shows the stat tiles, each with its change in words", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/^Overview - /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Overview",
    );

    const tiles = page.getByTestId("key-figures").getByTestId("stat-tile");
    await expect(tiles).toHaveCount(4);
    await expect(tiles.filter({ hasText: "Revenue" })).toContainText("$");
    for (const tile of await tiles.all())
      await expect(tile).toContainText(
        /(Up|Down|No change) .*previous 30 days/,
      );
  });

  test("draws both charts as labeled SVG and offers each as a table", async ({
    page,
  }) => {
    await page.goto("/");
    for (const id of ["revenue-chart", "top-titles"]) {
      const chart = page.getByTestId(id);
      await expect(chart.getByRole("img")).toBeVisible();
      await expect(chart.getByRole("img")).toHaveAttribute(
        "aria-label",
        /table below/,
      );
      await expect(chart.locator("figcaption")).toBeVisible();

      await expect(chart.getByRole("table")).toBeHidden();
      await chart.getByTestId("chart-figure-data-toggle").click();
      await expect(chart.getByRole("table")).toBeVisible();
    }
    await expect(
      page.getByTestId("revenue-chart").getByRole("row"),
    ).toHaveCount(31);
  });

  test("lists the five newest orders and links to the rest", async ({
    page,
  }) => {
    await page.goto("/");
    const recent = page.getByTestId("recent-orders");
    await expect(recent.getByRole("rowheader")).toHaveCount(5);
    await expect(recent.getByTestId("status-badge").first()).toHaveText(/\\S/);
    await recent.getByRole("link", { name: "All orders" }).click();
    await expect(page).toHaveURL("/orders");
  });

  test("renders the live tile per request in place of the build-time snapshot", async ({
    page,
  }) => {
    await page.goto("/");
    const reading = page.getByTestId("live-orders-reading");
    await expect(reading).toContainText("Open orders right now");
    await expect(reading).toContainText(
      /rendered for this request at \\d\\d:\\d\\d:\\d\\d UTC/,
    );
    // The snapshot the build printed is still in the page, hidden by CSS once the live tile arrives.
    await expect(page.getByTestId("live-orders-snapshot")).toBeHidden();
    await expect(page.getByTestId("live-orders-snapshot")).toContainText(
      "Build-time snapshot",
      {
        useInnerText: false,
      },
    );
  });
});

test.describe("App shell", () => {
  test("puts the skip link first and marks the current page in the sidebar", async ({
    page,
  }) => {
    await page.goto("/orders");
    await page.keyboard.press("Tab");
    const skip = page.getByTestId("app-header-skip-link");
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute("href", "#main");

    const nav = page.getByTestId("app-sidebar");
    await expect(nav.getByRole("link", { name: "Orders" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.locator("[aria-current]")).toHaveCount(1);

    await nav.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL("/settings");
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("collapses the sidebar behind the Menu button at phone width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    const toggle = page.getByTestId("app-sidebar-toggle");
    const links = page.getByTestId("app-sidebar-links");

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(links).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(links).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(links).toBeHidden();

    // Nothing is wider than the phone: tables and charts scroll inside their own boxes.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
  });

  test("shows the sidebar without a Menu button at desktop width", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("app-sidebar-toggle")).toBeHidden();
    await expect(page.getByTestId("app-sidebar-links")).toBeVisible();
  });

  test("theme toggle switches the theme and keeps it across a reload", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const lightBackground = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    ).not.toBe(lightBackground);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The choice follows the reader to other pages.
    await page.goto("/orders");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test.describe("Orders table", () => {
  test("sorts a column both ways and says so with aria-sort", async ({
    page,
  }) => {
    await page.goto("/orders");
    const total = page.getByRole("columnheader", { name: "Total" });
    const date = page.getByRole("columnheader", { name: "Date" });
    await expect(date).toHaveAttribute("aria-sort", "descending");
    await expect(total).toHaveAttribute("aria-sort", "none");

    await page.getByTestId("orders-table-sort-total").click();
    await expect(total).toHaveAttribute("aria-sort", "ascending");
    await expect(date).toHaveAttribute("aria-sort", "none");
    const ascending = (await shownValues(page, "total")).map(Number);
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));

    await page.getByTestId("orders-table-sort-total").click();
    await expect(total).toHaveAttribute("aria-sort", "descending");
    const descending = (await shownValues(page, "total")).map(Number);
    expect(descending).toEqual([...descending].sort((a, b) => b - a));
    expect(descending[0]).toBeGreaterThan(ascending[0]);

    await page.getByTestId("orders-table-sort-customer").click();
    await expect(
      page.getByRole("columnheader", { name: "Customer" }),
    ).toHaveAttribute("aria-sort", "ascending");
    const customers = await shownValues(page, "customer");
    expect(customers).toEqual(
      [...customers].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("filters by text and by status", async ({ page }) => {
    await page.goto("/orders");
    const [customer] = await shownValues(page, "customer");
    await page.getByTestId("orders-table-query").fill(customer.toUpperCase());
    await expect(page.getByTestId("orders-table-summary")).toContainText(
      "filtered from",
    );
    for (const name of await shownValues(page, "customer"))
      expect(name).toBe(customer);

    await page.getByTestId("orders-table-query").fill("");
    await page.getByTestId("orders-table-status").selectOption("Shipped");
    const statuses = await shownValues(page, "status");
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(["Shipped"]));
  });

  test("shows an empty state when nothing matches, and clears the filters from it", async ({
    page,
  }) => {
    await page.goto("/orders");
    const empty = page.getByTestId("orders-table-empty");
    await expect(empty).toBeHidden();

    await page.getByTestId("orders-table-query").fill("no order says this");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No orders match these filters.");
    await expect(shownRows(page)).toHaveCount(0);
    await expect(page.getByTestId("orders-table-summary")).toContainText(
      "No orders shown",
    );
    await expect(page.getByTestId("orders-table-next")).toBeDisabled();

    await page.getByTestId("orders-table-clear").click();
    await expect(empty).toBeHidden();
    await expect(shownRows(page)).toHaveCount(10);
    await expect(page.getByTestId("orders-table-query")).toHaveValue("");
  });

  test("pages through the rows ten at a time", async ({ page }) => {
    await page.goto("/orders");
    const label = page.getByTestId("orders-table-page");
    const previous = page.getByTestId("orders-table-previous");
    const next = page.getByTestId("orders-table-next");

    await expect(shownRows(page)).toHaveCount(10);
    await expect(label).toHaveText(/^Page 1 of \\d+$/);
    await expect(previous).toBeDisabled();
    await expect(page.getByTestId("orders-table-summary")).toContainText(
      "Showing 1 to 10 of",
    );
    const firstPage = await shownValues(page, "order");

    await next.click();
    await expect(label).toHaveText(/^Page 2 of \\d+$/);
    await expect(previous).toBeEnabled();
    await expect(page.getByTestId("orders-table-summary")).toContainText(
      "Showing 11 to 20 of",
    );
    const secondPage = await shownValues(page, "order");
    expect(secondPage.some((order) => firstPage.includes(order))).toBe(false);

    await previous.click();
    await expect(label).toHaveText(/^Page 1 of \\d+$/);
    expect(await shownValues(page, "order")).toEqual(firstPage);

    // Sorting starts again from the first page.
    await next.click();
    await page.getByTestId("orders-table-sort-order").click();
    await expect(label).toHaveText(/^Page 1 of \\d+$/);
  });

  test("opens with the status from the address, and ignores one it does not know", async ({
    page,
  }) => {
    await page.goto("/orders?status=Processing");
    await expect(page.getByTestId("orders-table-status")).toHaveValue(
      "Processing",
    );
    expect(new Set(await shownValues(page, "status"))).toEqual(
      new Set(["Processing"]),
    );

    await page.goto("/orders?status=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E");
    await expect(page.getByTestId("orders-table-status")).toHaveValue("");
    await expect(shownRows(page)).toHaveCount(10);
    await expect(page.locator("img")).toHaveCount(0);
  });
});

test.describe("Without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("has every order row in the page, and no controls that would do nothing", async ({
    page,
  }) => {
    await page.goto("/orders");
    expect(await shownRows(page).count()).toBeGreaterThan(10);
    await expect(page.getByTestId("orders-table-search")).toBeHidden();
    await expect(page.getByTestId("orders-table-pager")).toBeHidden();
    await expect(page.getByTestId("orders-table-sort-total")).toBeDisabled();
    await expect(
      page.getByRole("columnheader", { name: "Date" }),
    ).toHaveAttribute("aria-sort", "descending");
    // The sidebar stays open: only its script collapses it.
    await expect(page.getByTestId("app-sidebar-links")).toBeVisible();
  });

  test("says why the settings form cannot save", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-form-save")).toBeDisabled();
    await expect(page.getByTestId("settings-form-needs-script")).toBeVisible();
    await expect(page.getByTestId("theme-toggle")).toBeHidden();
  });
});

test.describe("Titles", () => {
  test("lists every title and opens the page built for one", async ({
    page,
  }) => {
    await page.goto("/titles");
    const table = page.getByTestId("stock-table");
    await expect(
      table
        .getByTestId("status-badge")
        .filter({ hasText: "Low stock" })
        .first(),
    ).toBeVisible();

    await table.getByRole("link", { name: "The Lighthouse Ledger" }).click();
    await expect(page).toHaveURL("/titles/the-lighthouse-ledger");
    await expect(page).toHaveTitle(/^The Lighthouse Ledger - /);

    const detail = page.getByTestId("title-detail");
    await expect(detail.getByRole("heading", { level: 1 })).toHaveText(
      "The Lighthouse Ledger",
    );
    await expect(detail).toContainText("by Mara Ellison");
    await expect(detail.getByRole("img")).toBeVisible();
    await expect(detail.getByRole("rowheader").first()).toHaveText(/^BK-\\d+$/);

    await detail.getByRole("link", { name: "All titles" }).click();
    await expect(page).toHaveURL("/titles");
  });

  test("shows written empty states for a title with no orders", async ({
    page,
  }) => {
    await page.goto("/titles/harbor-songs-for-late-arrivals");
    const detail = page.getByTestId("title-detail");
    await expect(detail.getByTestId("status-badge")).toHaveText("Preorder");
    await expect(detail).toContainText("No copies sold in the last 8 weeks.");
    await expect(detail).toContainText("No orders include this title yet.");
    await expect(detail.getByRole("img")).toHaveCount(0);
  });
});

test.describe("Settings form", () => {
  test("refuses invalid values with a message beside the field", async ({
    page,
  }) => {
    await page.goto("/settings");
    const email = page.getByTestId("settings-form-email");
    await expect(page.getByTestId("settings-form-save")).toBeEnabled();
    await expect(page.getByTestId("settings-form-needs-script")).toBeHidden();

    await email.fill("not an email");
    await page.getByTestId("settings-form-low-stock").fill("0");
    await page.getByTestId("settings-form-save").click();

    // Each message is tied to its field with aria-describedby, so it is the field's description.
    await expect(email).toHaveAccessibleDescription(/Enter an email address/);
    await expect(
      page.getByTestId("settings-form-low-stock"),
    ).toHaveAccessibleDescription(/from 1 to 500/);
    await expect(
      page.getByText("Enter a whole number from 1 to 500."),
    ).toBeVisible();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toBeFocused();
    await expect(page.getByTestId("settings-form-saved")).toHaveText("");
    expect(
      await page.evaluate(() => localStorage.getItem("dashboard-settings")),
    ).toBeNull();
  });

  test("saves valid settings to this browser, confirms it, and shows them after a reload", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-form-demo-note")).toContainText(
      "saved in this browser only",
    );
    await page.getByLabel("Shop name").fill("Second Story Books");
    await page.getByLabel("Low stock threshold").fill("12");
    await page.getByLabel("Currency").selectOption("EUR");
    await page.getByLabel("Email a weekly sales digest").uncheck();
    await page.getByTestId("settings-form-save").click();

    const saved = page.getByTestId("settings-form-saved");
    await expect(saved).toHaveText("Saved in this browser.");
    await expect(saved).toHaveAttribute("role", "status");
    await expect(page).toHaveURL("/settings");

    await page.reload();
    await expect(page.getByLabel("Shop name")).toHaveValue(
      "Second Story Books",
    );
    await expect(page.getByLabel("Low stock threshold")).toHaveValue("12");
    await expect(page.getByLabel("Currency")).toHaveValue("EUR");
    await expect(
      page.getByLabel("Email a weekly sales digest"),
    ).not.toBeChecked();

    await page.getByTestId("settings-form-reset").click();
    await expect(page.getByLabel("Shop name")).toHaveValue("Corner Bookshop");
    await expect(saved).toHaveText("Defaults restored.");
  });

  test("shows an error, and the defaults, when the saved settings cannot be read", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-form-problem")).toBeHidden();
    await page.evaluate(() =>
      localStorage.setItem("dashboard-settings", "{broken"),
    );
    await page.reload();

    const problem = page.getByTestId("settings-form-problem");
    await expect(problem).toBeVisible();
    await expect(problem).toHaveAttribute("role", "alert");
    await expect(problem).toContainText("could not be read");
    await expect(page.getByLabel("Shop name")).toHaveValue("Corner Bookshop");

    // Saving replaces the broken value and clears the error.
    await page.getByTestId("settings-form-save").click();
    await expect(problem).toBeHidden();
    await expect(page.getByTestId("settings-form-saved")).toHaveText(
      "Saved in this browser.",
    );
  });
});

test.describe("Not found", () => {
  test("answers an unknown address with the 404 page", async ({ page }) => {
    const response = await page.goto("/no-such-page");
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle(/^Page not found - /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Page not found",
    );
    await page.getByRole("link", { name: "Back to the overview" }).click();
    await expect(page).toHaveURL("/");
  });

  test("answers a title that does not exist with the 404 page", async ({
    page,
  }) => {
    const response = await page.goto("/titles/no-such-book");
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("not-found-main")).toBeVisible();
  });
});
`,
  ],
];
