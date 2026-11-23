/**
 * @module templates/reports/site
 *
 * The pages, the global stylesheet, the config, the CSV exec script and the Playwright spec of the `reports`
 * template's site.
 */

import type { TemplateFile } from "../../scaffold.js";

/** `bascik.config.ts` */
const BASCIK_CONFIG_TS = (
  staticReports: boolean,
) => `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  assets: { inlineStyles: ["src/pages/css/styles.css"] },
  pipeline: {
    // Rebuild pages in dev when a data file or a shared helper changes.
    watchPaths: ["data/reports/", "src/lib/"],
    exec: [
      // Writes a CSV file per report into the build output, after the pages are built.
      {
        script: "scripts/write-csv.ts",
        phase: "post",
        watch: ["data/reports/", "src/lib/"],
      },
    ],
  },
${
  staticReports
    ? `  scripts: {
    cache: {
      // These two components list the data folder. The build script cache keys on files a script names, so it
      // cannot see a new or edited data file: keep them out of it. The report pages need no entry, because each
      // gets its data through its route, and the route is part of the cache key.
      exclude: [
        "src/components/report-list/**",
        "src/components/period-comparison/**",
      ],
    },
  },\n`
    : ""
}\
});
`;

/** `scripts/write-csv.ts` */
const WRITE_CSV_TS = `// scripts/write-csv.ts: write the CSV downloads into the build output: reports/<period>.csv for each report and
// reports/all.csv for all of them. bascik.config.ts runs it as a post-phase exec script, after the pages exist:
//
//   pipeline: { exec: [{ script: "scripts/write-csv.ts", phase: "post", watch: ["data/reports/", "src/lib/"] }] }
//
// Exec scripts are plain Node modules, so they import helpers with relative paths (the @/ alias only works inside
// <script> tags), and they write to BASCIK_OUT_DIR, never into src/.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { csvPath, reportsCsv } from "../src/lib/csv.ts";
import { loadReports } from "../src/lib/reports.ts";

const outDir = process.env.BASCIK_OUT_DIR ?? "dist";
const reports = await loadReports();
const files: [path: string, text: string][] = [
  [csvPath(), reportsCsv(reports)],
  ...reports.map((report): [string, string] => [
    csvPath(report.period),
    reportsCsv([report]),
  ]),
];

await mkdir(join(outDir, "reports"), { recursive: true });
await Promise.all(
  files.map(([path, text]) => writeFile(join(outDir, path), text)),
);
console.log(\`[csv] wrote \${files.length} files to reports/\`);
`;

/** `e2e/app.spec.ts` */
const APP_SPEC_TS = (
  staticReports: boolean,
) => `import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

// These tests read the racing data in data/reports/ (July to October 2026). When you replace the data, change the
// periods and cars named here to ones of your own.
const MONEY = /\\$[\\d,]+\\.\\d{2}/;

test.describe("Reports site", () => {
${
  staticReports
    ? ""
    : `
  test("report HTML is rendered by the server, while the CSV stays a download", async ({ request }) => {
    for (const path of ["/", "/compare", "/reports/2026-08"]) {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toContain("no-store");
    }
    const csv = await request.get("/reports/2026-08.csv");
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain("period,title,author,format,channel,units,revenue");
  });`
}

  test("home lists the reports newest first with their headline figures", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/^Racing reports - /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Racing reports",
    );

    const list = page.getByTestId("report-list");
    const periods = await list
      .locator("time")
      .evaluateAll((times) =>
        times.map((time) => time.getAttribute("datetime")),
      );
    expect(periods.length).toBeGreaterThanOrEqual(4);
    expect(periods).toEqual([...periods].sort().reverse());

    const card = (period: string) =>
      list
        .getByRole("article")
        .filter({ has: page.getByRole("link", { name: period }) });
    const latest = card("October 2026");
    await expect(latest).toContainText(MONEY);
    await expect(latest).toContainText(/(Up|Down) [\\d.]+% from September 2026/);
    await expect(card("July 2026")).toContainText("n/a: first report");

    await latest.getByRole("link").click();
    await expect(page).toHaveURL("/reports/2026-10");
  });

  test("report rows stack at every viewport and pages do not overflow", async ({
    page,
  }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 600 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const list = page.getByTestId("report-list");
      const card = (name: string) =>
        list.getByRole("article").filter({
          has: page.getByRole("link", { name, exact: true }),
        });
      const latest = card("October 2026");
      const previous = card("September 2026");
      const latestBox = await latest.boundingBox();
      const previousBox = await previous.boundingBox();
      expect(latestBox).not.toBeNull();
      expect(previousBox).not.toBeNull();
      if (!latestBox || !previousBox) throw new Error("Report cards are not visible");
      expect(Math.abs(previousBox.x - latestBox.x)).toBeLessThan(1);
      expect(previousBox.y).toBeGreaterThanOrEqual(latestBox.y + latestBox.height - 1);

      for (const path of ["/", "/reports/2026-08", "/compare"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      }
    }
  });

  test("a report shows its figures, and every table adds up to them", async ({
    page,
  }) => {
    await page.goto("/reports/2026-08");
    await expect(page).toHaveTitle(/^August 2026 racing report - /);
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("August 2026 racing report");
    await expect(heading.locator("time")).toHaveAttribute(
      "datetime",
      "2026-08",
    );

    // The change is said in words, with the period it compares against.
    const summary = page.getByTestId("report-summary");
    await expect(summary).toContainText(/(Up|Down) [\\d.]+% from July 2026/);
    const revenue = (await summary.textContent())?.match(MONEY)?.[0] ?? "";
    expect(revenue).toMatch(MONEY);

    for (const table of [
      "report-charts-format",
      "report-charts-channel",
      "report-tables-titles",
      "report-tables-authors",
      "report-tables-lines",
    ])
      await expect(
        page.getByTestId(table).getByRole("row", { name: /^Total/ }),
      ).toContainText(revenue);

    await expect(page.getByTestId("report-notes")).toContainText(
      "No race entries were filed in August",
    );
  });

  test("charts and tables adapt to light and dark mode", async ({ page }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1440, 768, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/reports/2026-10");
        const figures = page.getByTestId("report-charts").getByRole("figure");
        const format = figures.filter({ hasText: "Revenue by format" });
        const channel = figures.filter({ hasText: "Revenue by channel" });
        const formatBox = await format.boundingBox();
        const channelBox = await channel.boundingBox();
        if (!formatBox || !channelBox) throw new Error("Charts are not visible");
        if (width > 700) {
          expect(channelBox.x).toBeGreaterThanOrEqual(formatBox.x + formatBox.width);
          expect(Math.abs(channelBox.y - formatBox.y)).toBeLessThan(1);
        } else {
          expect(channelBox.y).toBeGreaterThanOrEqual(formatBox.y + formatBox.height);
        }
        for (const figure of await figures.all()) {
          await expect(figure.getByRole("img")).toBeVisible();
          await expect(figure.getByRole("table")).toBeVisible();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("dark mode gives every headline figure the same quiet treatment", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/reports/2026-10");
    const surfaces = await page.getByTestId("report-summary").locator("dl > div").evaluateAll(
      (items) => items.map((item) => {
        const style = getComputedStyle(item);
        return {
          background: style.backgroundImage,
          shadow: style.boxShadow,
          border: style.borderTopColor,
          borderStyle: style.borderTopStyle,
        };
      }),
    );
    expect(surfaces).toHaveLength(4);
    expect(new Set(surfaces.map((surface) => surface.background)).size).toBe(1);
    expect(surfaces.every((surface) => surface.background === "none")).toBe(true);
    expect(surfaces.every((surface) => surface.shadow === "none")).toBe(true);
    expect(new Set(surfaces.map((surface) => surface.border)).size).toBe(1);
    expect(surfaces.every((surface) => surface.borderStyle === "solid")).toBe(true);
    expect(await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundImage)).toBe("none");
  });

  test("chart surfaces keep their depth while bars remain flat", async ({ page }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto("/reports/2026-08");
      const treatments = await page.getByTestId("chart-explorer").evaluateAll((figures) =>
        figures.map((figure) => {
          const plot = figure.querySelector('svg[role="img"]')!;
          return {
            panel: getComputedStyle(figure).backgroundImage,
            plot: getComputedStyle(plot).backgroundImage,
            panelColor: getComputedStyle(figure).backgroundColor,
            plotColor: getComputedStyle(plot).backgroundColor,
            panelShadow: getComputedStyle(figure).boxShadow,
            plotShadow: getComputedStyle(plot).boxShadow,
            bars: Array.from(plot.querySelectorAll("path"), (bar) => {
              const style = getComputedStyle(bar);
              return { fill: style.fill, filter: style.filter, stroke: style.stroke };
            }),
          };
        }),
      );
      expect(treatments).toHaveLength(3);
      for (const treatment of treatments) {
        expect(treatment.panel).toBe("none");
        expect(treatment.plot).toBe("none");
        expect(treatment.panelColor).not.toBe(treatment.plotColor);
        expect(treatment.panelShadow).not.toBe("none");
        expect(treatment.plotShadow).toBe("none");
        expect(treatment.bars.length).toBeGreaterThan(0);
        expect(new Set(treatment.bars.map((bar) => bar.fill)).size).toBeLessThanOrEqual(2);
        for (const bar of treatment.bars) {
          expect(bar.fill).toMatch(/^rgb\\(/);
          expect(bar.filter).toBe("none");
          expect(bar.stroke).toBe("none");
        }
      }
    }
  });

  test("report navigation links have visible surfaces and interaction states", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto("/reports/2026-08");
      const previous = page.getByTestId("report-pager-previous");
      const before = await previous.evaluate((link) => {
        const style = getComputedStyle(link);
        return { background: style.backgroundColor, border: style.borderColor };
      });
      expect(before.background).not.toBe("rgba(0, 0, 0, 0)");
      await previous.hover();
      expect(await previous.evaluate((link) => getComputedStyle(link).borderColor)).not.toBe(before.border);
      await previous.focus();
      await expect(previous).toBeFocused();
      expect(await previous.evaluate((link) => getComputedStyle(link).outlineStyle)).toBe("solid");
      await previous.click();
      await expect(page).toHaveURL("/reports/2026-07");
    }
  });

  test("the compare button stays opaque throughout hover transitions", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.mouse.move(0, 0);
      await page.goto("/");
      const button = page.getByRole("link", { name: "Compare all periods", exact: true });
      for (const hovering of [true, false]) {
        const [colors] = await Promise.all([
          button.evaluate((element) => new Promise<string[]>((resolve) => {
            const colors: string[] = [];
            const until = performance.now() + 220;
            const sample = () => {
              colors.push(getComputedStyle(element).backgroundColor);
              if (performance.now() < until) requestAnimationFrame(sample);
              else resolve(colors);
            };
            sample();
          })),
          hovering ? button.hover() : page.mouse.move(0, 0),
        ]);
        expect(colors.length).toBeGreaterThan(1);
        expect(colors.every((color) => /^rgb\\(/.test(color))).toBe(true);
      }
    }
  });

  test("each chart is an image with a caption and a table of the same figures", async ({
    page,
  }) => {
    await page.goto("/reports/2026-08");
    const figures = page.getByTestId("report-charts").getByRole("figure");
    await expect(figures).toHaveCount(3);

    const byFormat = figures.filter({ hasText: "Revenue by format" });
    const chart = byFormat.getByRole("img", {
      name: "Revenue by format, August 2026",
    });
    await expect(chart).toBeVisible();
    const table = byFormat.getByRole("table");
    await expect(table).toBeVisible();

    // Every bar's tooltip reads "Format: $amount"; the table has a row with the same two.
    const bars = await chart.locator("title").allTextContents();
    expect(bars.length).toBeGreaterThan(1);
    for (const bar of bars) {
      const [format, amount] = bar.split(": ");
      await expect(
        table.getByRole("row", { name: new RegExp(\`^\${format}\`) }),
      ).toContainText(amount);
    }
  });

  test("chart inspection links bars and rows without affecting other charts", async ({ page }) => {
    await page.goto("/reports/2026-08");
    const formats = page.getByTestId("chart-explorer").filter({ hasText: "Revenue by format" });
    const channels = page.getByTestId("chart-explorer").filter({ hasText: "Revenue by channel" });
    const bar = formats.locator("svg > g").first();
    const label = await bar.locator("title").textContent();
    const button = formats.getByRole("button", { name: label + " (inspect)", exact: true });
    const row = formats.getByRole("row").filter({
      has: page.getByRole("button", { name: label + " (inspect)", exact: true }),
    });
    await bar.locator("path").hover();
    await expect(formats.getByTestId("chart-explorer-inspection")).toHaveText(label!);
    await expect(bar).toHaveAttribute("data-active", "true");
    await expect(formats.locator('tbody tr[data-active="true"]')).toHaveCount(1);
    await expect(channels).not.toHaveAttribute("data-inspecting", "true");
    await page.keyboard.press("Escape");
    await expect(formats).toHaveAttribute("data-inspecting", "false");

    await button.focus();
    await expect(bar).toHaveAttribute("data-active", "true");
    await button.press("Space");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    expect(await row.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    await page.getByRole("heading", { level: 1 }).hover();
    await expect(bar).toHaveAttribute("data-active", "true");
    await page.keyboard.press("Escape");
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(formats).toHaveAttribute("data-inspecting", "false");

    await row.hover();
    await expect(bar).toHaveAttribute("data-active", "true");
    expect(await row.getByRole("cell").last().evaluate((element) => getComputedStyle(element).cursor)).toBe("pointer");
    await expect(row.getByRole("rowheader")).toHaveText((await bar.getAttribute("data-chart-key"))!);
    const bounds = (await row.boundingBox())!;
    await row.click({ position: { x: bounds.width - 12, y: bounds.height / 2 } });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await row.click({ position: { x: bounds.width - 12, y: bounds.height / 2 } });
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await page.emulateMedia({ media: "print" });
    await expect(button).toBeHidden();
    await expect(formats.getByTestId("chart-explorer-inspection")).toBeHidden();
    expect(await bar.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  });

  test("touch chart months pin while linked table rows navigate", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/compare");
    const chart = page.getByTestId("chart-explorer");
    const button = chart.getByRole("button", { name: /^Sep 2026:/ });
    const row = chart.getByRole("row", { name: /^September 2026/ });
    const bounds = (await row.boundingBox())!;
    const position = { x: Math.min(bounds.width - 12, 250), y: bounds.height / 2 };
    await button.tap();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(chart.locator('svg > g[data-active="true"]')).toHaveAttribute("data-chart-key", "2026-09");
    await button.tap();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(row.getByRole("button")).toHaveCount(0);
    await row.tap({ position });
    await expect(page).toHaveURL("/reports/2026-09");
    await context.close();
  });

  test("inspection matches period keys rather than table row positions", async ({ page }) => {
    await page.route("**/compare", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "<tbody>",
        '<tbody><tr><th scope="row"><time datetime="2020-01">January 2020</time></th><td>0</td><td>$0.00</td><td>$0.00</td><td>n/a</td></tr>',
      );
      await route.fulfill({ response, body });
    });
    await page.goto("/compare");
    const chart = page.getByTestId("chart-explorer");
    await expect(chart.getByRole("row", { name: /^January 2020/ }).getByRole("button")).toHaveCount(0);
    await chart.getByRole("button", { name: /^Sep 2026:/ }).click();
    await expect(chart.locator('svg > g[data-active="true"]')).toHaveAttribute("data-chart-key", "2026-09");
    await expect(chart.getByRole("row", { name: /^September 2026/ })).toHaveAttribute("data-active", "true");
  });

  test("charts and tables remain complete without JavaScript", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/reports/2026-08");
    const charts = page.getByTestId("chart-explorer");
    await expect(charts).toHaveCount(3);
    await expect(charts.getByRole("img")).toHaveCount(3);
    await expect(charts.getByRole("table")).toHaveCount(3);
    await expect(charts.getByRole("button")).toHaveCount(0);
    await expect(charts.getByTestId("chart-explorer-inspection").first()).toBeHidden();
    await page.getByTestId("report-pager-previous").click();
    await expect(page).toHaveURL("/reports/2026-07");
    await context.close();
  });

  test("previous and next links walk through the periods", async ({ page }) => {
    await page.goto("/reports/2026-08");
    await page.getByTestId("report-pager-previous").click();
    await expect(page).toHaveURL("/reports/2026-07");
    await expect(page.getByTestId("report-pager-previous")).toHaveCount(0);
    await expect(page.getByTestId("report-pager")).toContainText(
      "This is the first report",
    );
    await page.getByTestId("report-pager-next").click();
    await expect(page).toHaveURL("/reports/2026-08");
    await page.getByTestId("report-pager-all").click();
    await expect(page).toHaveURL("/");
  });

  test("the comparison page adds every period up", async ({ page }) => {
    await page.goto("/compare");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Period comparison",
    );
    const comparison = page.getByTestId("period-comparison");
    await expect(
      comparison.getByRole("group", { name: /^Revenue by period/ }),
    ).toBeVisible();

    const periods = page.getByTestId("period-comparison-periods");
    for (const period of ["July", "August", "September", "October"])
      await expect(
        periods.getByRole("row", { name: new RegExp(\`^\${period} 2026\`) }),
      ).toContainText(MONEY);
    const total = periods.getByRole("row", { name: /^Total/ });
    const revenue = (await total.textContent())?.match(MONEY)?.[0] ?? "";
    for (const table of ["titles", "authors", "formats", "channels"])
      await expect(
        page
          .getByTestId(\`period-comparison-\${table}\`)
          .getByRole("row", { name: /^Total/ }),
      ).toContainText(revenue);

    const periodLink = periods.getByRole("link", { name: "September 2026" });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.mouse.move(0, 0);
      for (const hovering of [false, true]) {
        if (hovering) await periodLink.hover();
        await expect(periodLink).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(periodLink).toHaveCSS("border-top-width", "0px");
        await expect(periodLink).toHaveCSS("padding", "0px");
        await expect(periodLink).toHaveCSS("text-decoration-line", "underline");
      }
    }
    await periodLink.click();
    await expect(page).toHaveURL("/reports/2026-09");
  });

  test("the CSV download has every sales line of the report", async ({
    page,
  }) => {
    await page.goto("/reports/2026-08");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("report-actions-csv").click(),
    ]);
    expect(download.suggestedFilename()).toBe("2026-08.csv");
    const csv = await readFile(await download.path(), "utf8");
    const [header, ...rows] = csv.trimEnd().split("\\r\\n");

    expect(header).toBe("period,title,author,format,channel,units,revenue");
    expect(rows[0]).toMatch(
      /^2026-08,Bascik Prototype 17,Bascik Racing,Vintage,Sebring,\\d+,\\d+\\.\\d{2}$/,
    );
    // A title with a comma is one quoted field.
    expect(
      rows.some((row) => row.startsWith('2026-08,"Bascik GT 35, Long Tail",')),
    ).toBe(true);

    // One row per line of the report's last table, and the units add up to the headline figure.
    await expect(
      page.getByTestId("report-tables-lines").getByRole("row"),
    ).toHaveCount(rows.length + 2);
    const units = rows.reduce(
      (sum, row) => sum + Number(row.split(",").at(-2)),
      0,
    );
    await expect(page.getByTestId("report-summary")).toContainText(
      new RegExp(\`Units sold\\\\s*\${units.toLocaleString("en-US")}\\\\D\`),
    );
  });

  test("the comparison page links to a CSV file of every period", async ({
    page,
  }) => {
    await page.goto("/compare");
    const link = page.getByTestId("report-actions-csv");
    await expect(link).toHaveAttribute("href", "/reports/all.csv");
    const response = await page.request.get("/reports/all.csv");
    expect(response.ok()).toBe(true);
    const periods = new Set(
      (await response.text())
        .trimEnd()
        .split("\\r\\n")
        .slice(1)
        .map((row) => row.split(",")[0]),
    );
    expect([...periods]).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
  });

  test("the print button is a real button that prints", async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => document.body.setAttribute("data-printed", "");
    });
    await page.goto("/reports/2026-08");
    await page.getByRole("button", { name: "Print or save as PDF" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-printed", "");
  });

  test("print styles drop the navigation and the buttons, and keep the report", async ({
    page,
  }) => {
    await page.goto("/reports/2026-08");
    const chrome = [
      "site-header",
      "site-header-nav",
      "report-actions-print",
      "report-actions-csv",
      "report-pager",
      "site-footer-nav",
    ];
    for (const id of chrome) await expect(page.getByTestId(id)).toBeVisible();

    await page.emulateMedia({ media: "print" });
    for (const id of chrome) await expect(page.getByTestId(id)).toBeHidden();
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();
    expect(await heading.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(0, 0, 0)");
    await expect(page.getByTestId("report-summary")).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Revenue by channel, August 2026" }),
    ).toBeVisible();
    await expect(page.getByTestId("report-tables-lines")).toBeVisible();
    const fills = await page.getByTestId("report-charts").locator("svg path").evaluateAll(
      (bars) => bars.map((bar) => getComputedStyle(bar).fill),
    );
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((fill) => fill === "rgb(34, 34, 34)" || fill === "rgb(255, 255, 255)")).toBe(true);
  });

  test("the report list remains readable when printed", async ({ page }) => {
    await page.goto("/");
    await page.emulateMedia({ media: "print" });
    const latest = page.getByTestId("report-list").getByRole("article").first();
    for (const element of [
      latest,
      latest.getByRole("link"),
      latest.locator("dt").first(),
      latest.locator("dd").first(),
    ]) {
      expect(["rgb(0, 0, 0)", "rgb(51, 51, 51)"]).toContain(
        await element.evaluate((node) => getComputedStyle(node).color),
      );
    }
  });

  test("phone navigation opens from the menu button and ends with the theme switch", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    const toggle = page.getByTestId("site-header-nav-toggle");
    const menu = page.getByTestId("site-header-nav-menu");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();

    // At phone width the theme switch is the last row of the menu and names the theme it switches to.
    await expect(page.getByTestId("site-header-theme")).toBeHidden();
    const themeRow = page.getByTestId("site-header-mobile-theme");
    const before = await themeRow.innerText();
    await themeRow.click();
    await expect(themeRow).not.toHaveText(before);

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await page.getByTestId("site-header-compare").click();
    await expect(page).toHaveURL("/compare");
  });

  test("phone navigation stays visible without JavaScript", async ({ browser, baseURL }) => {
    const page = await browser.newPage({ baseURL, javaScriptEnabled: false, viewport: { width: 375, height: 667 } });
    try {
      await page.goto("/");
      await expect(page.getByTestId("site-header-nav-toggle")).toBeHidden();
      await page.getByTestId("site-header-compare").click();
      await expect(page).toHaveURL("/compare");
    } finally {
      await page.close();
    }
  });

  test("the skip link is the first stop and leads to the content", async ({
    page,
  }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByTestId("site-header-skip-link");
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute("href", "#main");
    await expect(page.getByRole("main")).toHaveAttribute("id", "main");
  });

  test("an unknown address gets the 404 page", async ({ page }) => {
    const response = await page.goto("/reports/1999-01");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Page not found",
    );
    await page.getByRole("link", { name: "See all reports" }).click();
    await expect(page).toHaveURL("/");
  });
});
`;

/** `src/pages/css/styles.css` */
const CSS_STYLES_CSS = `/* ── Tokens ── */
*,
*::before,
*::after {
  box-sizing: border-box;
}

:root {
  color-scheme: light dark;
  --bg: light-dark(#f5f2ea, #151a16);
  --surface: light-dark(#fffdf8, #202720);
  --surface-soft: light-dark(#f0eee7, #252d26);
  --text: light-dark(#282d28, #e8ece6);
  --text-muted: light-dark(#697168, #b0b9ae);
  --border: light-dark(#d9d8ce, #3c463c);
  --link: light-dark(#315f45, #b2d0ad);
  --link-wash: light-dark(#edf3e9, #2c3b2e);
  --chart: light-dark(#537b56, #a5c79e);
  --chart-muted: light-dark(#b6c5b2, #526650);
  --highlight: light-dark(#315f45, #b2d0ad);
  --panel: var(--surface);
  --plot: var(--surface-soft);
  --shadow: 0 12px 28px -22px light-dark(rgb(35 45 38 / 34%), rgb(0 0 0 / 62%));
  /* The skip link's background; its text is always dark. */
  --accent: #dce8d9;
  --mono: "SF Mono", "Fira Code", Menlo, monospace;
  --serif: "Iowan Old Style", "Baskerville", "Times New Roman", serif;
  --r: 14px;
  --r-sm: 8px;
  --page: 1200px;
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
.theme-switching * { transition: none !important; }

/* ── Base ── */
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.6;
}

main {
  flex: 1;
  width: 100%;
  max-width: var(--page);
  margin: 0 auto;
  padding: 40px 32px 72px;
}

h1,
h2,
h3 {
  line-height: 1.25;
  margin: 0 0 12px;
}
h1 {
  font-family: var(--serif);
  font-size: clamp(2.2rem, 4.5vw, 3.8rem);
  font-weight: 500;
  letter-spacing: -0.035em;
}
h2 {
  font-family: var(--serif);
  font-size: 1.35rem;
  font-weight: 500;
  letter-spacing: -0.02em;
  margin-top: 32px;
}
h3 {
  font-family: var(--serif);
  font-size: 1.15rem;
  margin-top: 24px;
}
p {
  margin: 0 0 12px;
}

a {
  color: var(--link);
  text-decoration-color: light-dark(#b6c0e8, #65749e);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
a:hover {
  text-decoration-color: currentColor;
}

:focus-visible {
  outline: 3px solid var(--link);
  outline-offset: 3px;
}

code {
  font-family: var(--mono);
  font-size: 0.88em;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 1px 6px;
}

cite {
  font-style: italic;
}

/* ── Page heading ── */
.masthead {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 40px;
  align-items: start;
  margin-bottom: 40px;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--border);
}
.masthead > * {
  grid-column: 1;
  min-width: 0;
}
.masthead > :last-child {
  grid-column: 2;
  grid-row: 1 / span 3;
  justify-self: end;
  margin: 4px 0 0;
}
.masthead h1 {
  margin-bottom: 8px;
}
.eyebrow {
  margin-bottom: 8px;
  color: var(--link);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.lede {
  max-width: 64ch;
  color: var(--text-muted);
  font-size: 1rem;
  line-height: 1.7;
  margin-bottom: 0;
}

.button {
  display: inline-block;
  padding: 11px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.button:hover {
  background: var(--surface-soft);
  border-color: var(--link);
  color: var(--link);
}
.masthead a.button {
  border-color: light-dark(#315f45, #a7c7a2);
  background: light-dark(#315f45, #cfe0ca);
  color: light-dark(#fff, #202a21);
}
.masthead a.button:hover {
  background: light-dark(#274d37, #e0eadc);
  color: light-dark(#fff, #202a21);
}

/* ── Headline figures ── */
.figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
  gap: 20px;
  margin: 24px 0 0;
}
.figure-item {
  min-width: 0;
  padding: 14px 0 0;
  border: 0;
  border-top: 2px solid var(--link);
  border-radius: 0;
  background: none;
  box-shadow: none;
}
.figure-item dt {
  color: var(--text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.045em;
  text-transform: uppercase;
}
.figure-item dd {
  margin: 0;
}
.figure-item .figure-value {
  margin: 10px 0 6px;
  font-family: var(--serif);
  font-size: clamp(1.8rem, 3vw, 2.5rem);
  font-weight: 500;
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.figure-note {
  color: var(--text-muted);
  font-size: 0.75rem;
  line-height: 1.4;
}

/* ── Report list ── */
.report-cards {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
  margin: 16px 0 0;
  padding: 0;
  border-top: 1px solid var(--border);
  list-style: none;
}
.report-card {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  align-items: center;
  gap: 32px;
  padding: 24px 0;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: none;
}
.report-card h3 {
  margin: 0;
  font-size: 1.45rem;
  font-weight: 500;
  letter-spacing: -0.02em;
}
.report-card h3 a {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  color: var(--text);
  text-decoration: none;
}
.report-card h3 a::after {
  content: "";
  flex: 0 0 8px;
  height: 8px;
  margin: 0 6px 0 0;
  border-top: 1.5px solid;
  border-right: 1.5px solid;
  transform: rotate(45deg);
  color: var(--highlight);
}
.report-card h3 a:hover {
  color: var(--link);
  text-decoration: none;
}
.report-card .figures {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  margin-top: 0;
  border: 0;
  background: none;
}
.report-card .figure-item {
  padding: 12px 0 0;
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0;
  box-shadow: none;
}
.report-card .figure-item .figure-value {
  font-size: clamp(1.25rem, 2vw, 1.65rem);
}

/* ── Charts ── */
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.chart-grid > h2,
.chart-grid > .chart-figure:first-of-type {
  grid-column: 1 / -1;
}
.chart-grid > h2 {
  margin-bottom: -4px;
}
.chart-figure {
  position: relative;
  min-width: 0;
  margin: 20px 0 0;
  padding: 22px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: var(--shadow);
}
.chart-grid > .chart-figure {
  margin: 0;
}
.chart-figure figcaption {
  margin-bottom: 20px;
  font-family: var(--serif);
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.chart {
  display: block;
  width: 100%;
  max-width: 720px;
  height: auto;
  padding: 16px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--plot);
  box-shadow: none;
}
@media (min-width: 701px) {
  .chart-grid > .chart-figure:not(:first-of-type) > .chart {
    min-height: 180px;
  }
}
.chart-bar {
  fill: var(--chart);
  stroke: none;
}
@media screen {
  .chart-figure[data-inspecting="true"] .chart g[data-active="false"] .chart-bar {
    opacity: 0.4;
  }
  .chart g[data-active="true"] .chart-bar {
    opacity: 1;
    stroke: var(--text);
    stroke-width: 1.5;
  }
  .chart-figure .data-table tr[data-active="true"] {
    background: var(--link-wash);
    box-shadow: inset 3px 0 var(--link);
  }
  .chart-figure .data-table tr:has(.chart-inspect:focus-visible) {
    outline: 2px solid var(--link);
    outline-offset: -2px;
  }
    .chart g:has(.chart-inspect:focus-visible) .chart-bar {
      stroke: var(--text);
      stroke-width: 3;
    }
}
.chart-bar-muted {
  fill: var(--chart-muted);
  opacity: 0.65;
}
.chart-axis {
  stroke: var(--border);
  stroke-width: 1;
}
.chart-label {
  fill: var(--text);
  font-size: 13px;
}
.chart-sublabel {
  fill: var(--text-muted);
  font-size: 12px;
}
.chart-value {
  fill: var(--text);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.chart-inspection {
  grid-column: 1 / -1;
  margin: 16px 0 0;
  padding: 14px 0 0;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.chart-figure .data-table tr:has(.chart-inspect),
.chart-figure .data-table tr:has(.period-link) {
  position: relative;
  cursor: pointer;
}
.chart-inspect {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  opacity: 0;
  cursor: pointer;
}
.chart-figure .data-table .period-link::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
}

/* ── Tables ── */
/* A wide table scrolls inside its own box on a narrow screen, so the page never scrolls sideways. */
.table-scroll {
  margin-top: 20px;
  padding: 16px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: none;
}
.chart-figure > .table-scroll {
  padding: 8px 0 0;
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
}
.chart-figure .data-table caption {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.table-scroll:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.data-table caption {
  padding-bottom: 16px;
  color: var(--text-muted);
  font-weight: 600;
  text-align: left;
}
.data-table th,
.data-table td {
  padding: 12px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.data-table thead th {
  border-bottom: 1px solid var(--border);
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-muted);
}
.data-table tbody tr:nth-child(even) {
  background: var(--surface-soft);
}
.data-table tbody th {
  font-weight: 500;
}
.data-table tfoot th,
.data-table tfoot td {
  border-top: 1px solid var(--border);
  border-bottom: 0;
  font-weight: 700;
}
.data-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.data-table a {
  white-space: nowrap;
}

/* A long address must not push the page wider than the paper or a phone. */
.url {
  display: inline-block;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  overflow-wrap: anywhere;
}

.pager > a {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text);
  font-size: 0.82rem;
  font-weight: 600;
  text-decoration: none;
}
.pager > a:hover {
  border-color: var(--link);
  color: var(--link);
}
.pager > a[rel="prev"]::before,
.pager > a[rel="next"]::after {
  content: "";
  width: 6px;
  height: 6px;
  border-top: 1.5px solid;
  border-right: 1.5px solid;
  transform: rotate(45deg);
}
.pager > a[rel="prev"]::before {
  transform: rotate(-135deg);
}
.pager > span {
  align-self: center;
  color: var(--text-muted);
  font-size: 0.8rem;
}

@media screen and (prefers-reduced-motion: no-preference) {
  a,
  button {
    transition:
      color 160ms ease,
      background-color 160ms ease,
      border-color 160ms ease,
      scale 150ms ease-out;
  }
  button:active,
  .button:active {
    scale: 0.97;
  }
}

@media (min-width: 1000px) {
  .chart-grid > .chart-figure:first-of-type {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: 0 32px;
    align-items: center;
  }
  .chart-grid > .chart-figure:first-of-type > figcaption {
    grid-column: 1 / -1;
  }
  .chart-grid > .chart-figure:first-of-type > .table-scroll {
    margin: 0;
  }
}

@media (max-width: 700px) {
  main {
    padding: 28px 16px 48px;
  }
  .masthead {
    display: block;
  }
  .masthead > :last-child {
    margin-top: 16px;
  }
  .chart-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .report-card {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .chart-figure {
    padding: 18px;
  }
  .report-card .figures {
    gap: 14px;
  }
}

/* ── Print: the report as a document ── */
@page {
  margin: 16mm 14mm;
}

@media print {
  .chart-inspection,
  .chart-inspect {
    display: none;
  }
  /* Paper is light, whatever the reader's screen is set to. */
  :root {
    color-scheme: light;
    --bg: #fff;
    --surface: #fff;
    --surface-soft: #fff;
    --text: #000;
    --text-muted: #333;
    --border: #888;
    --link: #000;
    --chart: #222;
    --shadow: none;
  }

  body {
    display: block;
    min-height: 0;
    background: #fff;
    font-size: 10.5pt;
  }
  main {
    max-width: none;
    padding: 0;
  }
  .masthead {
    display: block;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    color: #000;
  }
  .masthead .eyebrow,
  .masthead .lede,
  .masthead a {
    color: #000;
  }
  .masthead code {
    background: none;
    border-color: #888;
  }
  h1 {
    font-size: 22pt;
    letter-spacing: normal;
  }
  h2 {
    margin-top: 20pt;
    padding-top: 10pt;
  }
  a {
    text-decoration: none;
  }

  /* A link to another site is only useful on paper with its address. The permanent link already shows its own. */
  main a[href^="http"]:not(.url)::after {
    content: " (" attr(href) ")";
    overflow-wrap: anywhere;
  }

  /* Keep a heading with what it introduces, and never cut a figure, a table row or a card in two. */
  h1,
  h2,
  h3,
  figcaption,
  caption {
    break-after: avoid;
  }
  figure,
  tr,
  .figure-item,
  .report-card {
    break-inside: avoid;
  }
  thead {
    display: table-header-group;
  }
  .table-scroll {
    overflow: visible;
  }
  tfoot {
    display: table-row-group;
  }

  .figures {
    grid-template-columns: repeat(4, 1fr);
    gap: 8pt;
  }
  .figure-item .figure-value,
  .report-card .figure-item .figure-value {
    font-size: 14pt;
  }
  .report-cards {
    grid-template-columns: 1fr;
  }
  .figure-item,
  .report-card .figure-item,
  .report-card,
  .chart-figure {
    background: none;
    color: #000;
    box-shadow: none;
    border-radius: 0;
  }
  .chart {
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    box-shadow: none;
  }
  .chart-grid > .chart-figure:not(:first-of-type) > .chart {
    min-height: 0;
  }
  .chart-figure > .table-scroll {
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    box-shadow: none;
  }
  .chart-figure .data-table caption {
    position: static;
    width: auto;
    height: auto;
    padding-bottom: 16px;
    overflow: visible;
    clip-path: none;
    white-space: normal;
  }
  .table-scroll,
  .data-table a,
  .url {
    background: none;
    box-shadow: none;
  }
  .data-table a,
  .url {
    padding: 0;
    border: 0;
    border-radius: 0;
  }
  .chart-grid,
  .chart-grid > .chart-figure:first-of-type {
    display: block;
  }
  .chart-figure {
    padding: 10pt;
  }

  /* Charts without color: the current period solid, the others outlined, every value written out. */
  .chart > g .chart-bar {
    fill: #222;
    stroke: #222;
  }
  .chart > g .chart-bar-muted {
    fill: #fff;
    opacity: 1;
    stroke: #222;
    stroke-width: 1.5;
  }
}
`;

/** `src/pages/index.html` */
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <site-meta />
    <script data-bascik-build type="text/typescript">
      import { pageHead } from "@/lib/seo.ts";
      export default () =>
        pageHead({
          title: "Racing reports",
          description:
            "Monthly racing reports: revenue, units, top titles and authors, with charts, tables and CSV downloads.",
        });
    </script>
  </head>
  <body>
    <site-header />
    <main id="main" data-testid="home-main">
      <header class="masthead">
        <p class="eyebrow">Reports</p>
        <h1>Racing reports</h1>
        <p class="lede">
          Your monthly performance, at a glance. Explore revenue and sales,
          compare periods, or open a report for the full picture.
        </p>
        <p><a class="button" href="/compare">Compare all periods</a></p>
      </header>
      <report-list />
    </main>
    <site-footer />
  </body>
</html>
`;

/** `src/pages/reports/[period].html` */
const REPORTS_PERIOD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <site-meta />
    <!-- The fixture lists the /reports/<period> URLs and supplies their build-time metadata. -->
    <script data-bascik-routes type="text/typescript">
      import { loadReports, reportRoutes } from "@/lib/reports.ts";
      export default async () =>
        reportRoutes(await loadReports()).map((route) => ({
          params: { period: route.report.period },
          data: route,
        }));
    </script>
    <script data-bascik-build type="text/typescript">
      import { periodLabel } from "@/lib/format.ts";
      import { reportRoute } from "@/lib/reports.ts";
      import { pageHead } from "@/lib/seo.ts";
      export default () => {
        const period = periodLabel(reportRoute(process.env.BASCIK_ROUTE).report.period);
        return pageHead({
          title: \`\${period} racing report\`,
          description: \`Sales report for \${period}: revenue, units, top titles and authors, by format and by channel.\`,
        });
      };
    </script>
  </head>
  <body>
    <site-header />
    <main id="main" data-testid="report-main">
      <report-masthead />
      <report-summary />
      <report-charts />
      <report-tables />
      <report-notes />
      <report-pager />
    </main>
    <site-footer />
  </body>
</html>
`;

/** `src/pages/compare.html` */
const COMPARE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <site-meta />
    <script data-bascik-build type="text/typescript">
      import { pageHead } from "@/lib/seo.ts";
      export default () =>
        pageHead({
          title: "Period comparison",
          description:
            "Every racing report side by side: revenue and units per period, and sales by title, author, format and channel.",
        });
    </script>
  </head>
  <body>
    <site-header />
    <main id="main" data-testid="compare-main">
      <header class="masthead">
        <p class="eyebrow">All periods</p>
        <h1>Period comparison</h1>
        <p class="lede">Every report added up and set side by side.</p>
        <report-actions data-bascik-prop-csv="/reports/all.csv" />
      </header>
      <period-comparison />
    </main>
    <site-footer />
  </body>
</html>
`;

/** `src/pages/404.html` */
const PAGE_404_HTML = `<!doctype html>
<html lang="en">
  <head>
    <site-meta />
    <script data-bascik-build type="text/typescript">
      import { pageHead } from "@/lib/seo.ts";
      export default () =>
        pageHead({
          title: "Page not found",
          description: "There is no page at this address. The list of reports has every period.",
          noindex: true,
        });
    </script>
  </head>
  <body>
    <site-header />
    <main id="main" data-testid="not-found-main">
      <header class="masthead">
        <p class="eyebrow">Error 404</p>
        <h1>Page not found</h1>
        <p class="lede">
          There is no page at this address. A report's address ends in its
          period, such as <code>/reports/2026-07</code>.
        </p>
        <p><a class="button" href="/">See all reports</a></p>
      </header>
    </main>
    <site-footer />
  </body>
</html>
`;

/** The pages and the project files around them. */
const REPORTS_MD = `# Report data and deployment

Edit \`data/reports/*.json\`. These files are the only report fixture: they list
the build-time URLs, supply the CSV downloads, and seed both databases. Keep one
file per period; rebuild when you add or remove a period so links, metadata and
CSV downloads change together.

## Local Node

\`npm run dev\`, \`npm run build\` and \`npm run e2e\` seed \`data/racing.db\` first.
Run \`npm run db:seed\` again after editing the fixture during development, or
before using the Bascik CLI directly. Serve a production build with
\`npx bascik --server\` from the project root. Do not publish the database as
an asset. Visitors only read it, and only the seed command writes it.

The Netlify variant renders reports at build time from the same JSON and does
not require a database in its deployed function.

## Cloudflare Workers

Configure a D1 binding named \`DB\` in the project-root \`wrangler.jsonc\`. Use the
database name and ID provided for the environment by your deployment setup:

\`\`\`jsonc
{
  "d1_databases": [
    { "binding": "DB", "database_name": "YOUR_DATABASE_NAME", "database_id": "YOUR_DATABASE_ID" }
  ]
}
\`\`\`

In CI, build for Cloudflare and generate the SQL snapshot by capturing stdout
from \`node scripts/seed-database.ts --sql\` in a temporary SQL file. Apply it
**only to the dedicated reports database** before deploying the Worker, for
example with \`wrangler d1 execute DB --remote --file <sql-file> --config dist/.bascik/cloudflare/wrangler.jsonc\`.
The SQL creates the schema and replaces the report snapshot. Use \`--local\`
instead of \`--remote\` to seed a local Wrangler preview. Use the same config
and persistence location for the seed and preview. No request seeds or migrates
a database, and a missing D1 binding does not fall back to local SQLite.
`;

export const siteFiles = (staticReports: boolean): TemplateFile[] => [
  ["REPORTS.md", REPORTS_MD],
  ["bascik.config.ts", BASCIK_CONFIG_TS(staticReports)],
  ["scripts/write-csv.ts", WRITE_CSV_TS],
  ["e2e/app.spec.ts", APP_SPEC_TS(staticReports)],
  ["src/pages/css/styles.css", CSS_STYLES_CSS],
  ["src/pages/index.html", INDEX_HTML],
  ["src/pages/reports/[period].html", REPORTS_PERIOD_HTML],
  ["src/pages/compare.html", COMPARE_HTML],
  ["src/pages/404.html", PAGE_404_HTML],
];
