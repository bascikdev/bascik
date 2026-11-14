/**
 * @module templates/reports/site
 *
 * The pages, the global stylesheet, the config, the CSV exec script and the Playwright spec of the `reports`
 * template's site.
 */

import type { TemplateFile } from "../../scaffold.js";

/** `bascik.config.ts` */
const BASCIK_CONFIG_TS = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // Rebuild pages in dev when a data file or a shared helper changes.
    watchPaths: ["data/", "src/lib/"],
    exec: [
      // Writes a CSV file per report into the build output, after the pages are built.
      {
        script: "scripts/write-csv.ts",
        phase: "post",
        watch: ["data/", "src/lib/"],
      },
    ],
  },
  scripts: {
    cache: {
      // These two components list the data folder. The build script cache keys on files a script names, so it
      // cannot see a new or edited data file: keep them out of it. The report pages need no entry, because each
      // gets its data through its route, and the route is part of the cache key.
      exclude: [
        "src/components/report-list/**",
        "src/components/period-comparison/**",
      ],
    },
  },
});
`;

/** `scripts/write-csv.ts` */
const WRITE_CSV_TS = `// scripts/write-csv.ts: write the CSV downloads into the build output: reports/<period>.csv for each report and
// reports/all.csv for all of them. bascik.config.ts runs it as a post-phase exec script, after the pages exist:
//
//   pipeline: { exec: [{ script: "scripts/write-csv.ts", phase: "post", watch: ["data/", "src/lib/"] }] }
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
const APP_SPEC_TS = `import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

// These tests read the demo data in data/reports/ (July to October 2026). When you replace the data, change the
// periods and titles named here to ones of your own.
const MONEY = /\\$[\\d,]+\\.\\d{2}/;

test.describe("Reports site", () => {
  test("home lists the reports newest first with their headline figures", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/^Sales reports - /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Sales reports",
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

  test("a report shows its figures, and every table adds up to them", async ({
    page,
  }) => {
    await page.goto("/reports/2026-08");
    await expect(page).toHaveTitle(/^August 2026 sales report - /);
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("August 2026 sales report");
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
      "No events were held in August",
    );
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
      comparison.getByRole("img", { name: /^Revenue by period/ }),
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

    await periods.getByRole("link", { name: "September 2026" }).click();
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
      /^2026-08,The Salt Cartographer,Imogen Vale,Hardcover,In store,\\d+,\\d+\\.\\d{2}$/,
    );
    // A title with a comma is one quoted field.
    expect(
      rows.some((row) => row.startsWith('2026-08,"Bread, Smoke & Ash",')),
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
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("report-summary")).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Revenue by channel, August 2026" }),
    ).toBeVisible();
    await expect(page.getByTestId("report-tables-lines")).toBeVisible();
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
  --bg: light-dark(#f6f5f1, #16181b);
  --surface: light-dark(#ffffff, #1e2125);
  --text: light-dark(#1b1d21, #ecedee);
  --text-muted: light-dark(#565c66, #a4aab5);
  --border: light-dark(#d8d5cc, #383c43);
  --link: light-dark(#1a4f8f, #9cc4f5);
  /* Charts: one hue. The period a report is about is drawn in --chart, the others in --chart-muted. */
  --chart: light-dark(#1f4e86, #8fbdf0);
  --chart-muted: light-dark(#6f97c4, #4f7099);
  /* The skip link's background; its text is always dark. */
  --accent: #d3ff8d;
  --mono: "SF Mono", "Fira Code", Menlo, monospace;
  --r: 8px;
  --r-sm: 6px;
  --page: 960px;
}

/* ── Base ── */
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.6;
}

main {
  flex: 1;
  width: 100%;
  max-width: var(--page);
  margin: 0 auto;
  padding: 40px 24px 64px;
}

h1,
h2,
h3 {
  line-height: 1.25;
  margin: 0 0 12px;
}
h1 {
  font-size: clamp(1.8rem, 4vw, 2.5rem);
}
h2 {
  font-size: 1.35rem;
  margin-top: 48px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}
h3 {
  font-size: 1.05rem;
  margin-top: 24px;
}
p {
  margin: 0 0 12px;
}

a {
  color: var(--link);
  text-underline-offset: 3px;
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
.eyebrow {
  margin-bottom: 4px;
  color: var(--text-muted);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.lede {
  max-width: 68ch;
  font-size: 1.05rem;
}

.button {
  display: inline-block;
  padding: 8px 16px;
  border: 1px solid var(--text);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.92rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.button:hover {
  background: var(--bg);
}

/* ── Headline figures ── */
.figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  margin: 16px 0 0;
}
.figure-item {
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r);
}
.figure-item dt {
  color: var(--text-muted);
  font-size: 0.85rem;
}
.figure-item dd {
  margin: 0;
}
.figure-value {
  font-size: 1.5rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.figure-note {
  color: var(--text-muted);
  font-size: 0.85rem;
}

/* ── Report list ── */
.report-cards {
  display: grid;
  gap: 16px;
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
}
.report-card h3 {
  margin: 0;
  font-size: 1.2rem;
}

/* ── Charts ── */
.chart-figure {
  margin: 24px 0 0;
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r);
}
.chart-figure figcaption {
  margin-bottom: 12px;
  font-weight: 700;
}

.chart {
  display: block;
  width: 100%;
  max-width: 640px;
  height: auto;
}
.chart-bar {
  fill: var(--chart);
}
.chart-bar-muted {
  fill: var(--chart-muted);
}
.chart-axis {
  stroke: var(--text-muted);
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

/* ── Tables ── */
/* A wide table scrolls inside its own box on a narrow screen, so the page never scrolls sideways. */
.table-scroll {
  margin-top: 28px;
  overflow-x: auto;
}
.table-scroll:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
}
.data-table caption {
  padding-bottom: 8px;
  color: var(--text-muted);
  font-weight: 600;
  text-align: left;
}
.data-table th,
.data-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.data-table thead th {
  border-bottom: 2px solid var(--text);
  font-size: 0.82rem;
}
.data-table tbody th {
  font-weight: 500;
}
.data-table tfoot th,
.data-table tfoot td {
  border-top: 2px solid var(--text);
  border-bottom: 0;
  font-weight: 700;
}
.data-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* A long address must not push the page wider than the paper or a phone. */
.url {
  overflow-wrap: anywhere;
}

/* ── Print: the report as a document ── */
@page {
  margin: 16mm 14mm;
}

@media print {
  /* Paper is light, whatever the reader's screen is set to. */
  :root {
    color-scheme: light;
    --bg: #fff;
    --surface: #fff;
    --text: #000;
    --text-muted: #333;
    --border: #888;
    --link: #000;
    --chart: #222;
  }

  body {
    display: block;
    min-height: 0;
    font-size: 10.5pt;
  }
  main {
    max-width: none;
    padding: 0;
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
  .figure-value {
    font-size: 14pt;
  }
  .chart-figure {
    padding: 10pt;
  }

  /* Charts without color: the current period solid, the others outlined, every value written out. */
  .chart-bar {
    fill: #222;
  }
  .chart-bar-muted {
    fill: #fff;
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
          title: "Sales reports",
          description:
            "Monthly sales reports: revenue, units, top titles and authors, with charts, tables and CSV downloads.",
        });
    </script>
  </head>
  <body>
    <site-header />
    <main id="main" data-testid="home-main">
      <header class="masthead">
        <p class="eyebrow">Reports</p>
        <h1>Sales reports</h1>
        <p class="lede">
          One report per month, built from the files in
          <code>data/reports/</code>. Open a report to read it, print it or save
          it as a PDF, or download its figures as CSV.
        </p>
        <p><a href="/compare">Compare all periods</a></p>
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
    <!-- One page per data file, at /reports/<period>. The routes script reads every report once and hands each page
       its own report, the one before it, and the revenue of the periods so far. The components below read that
       from the route, so nothing here is passed down by hand. -->
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
          title: \`\${period} sales report\`,
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
            "Every sales report side by side: revenue and units per period, and sales by title, author, format and channel.",
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
export const SITE_FILES: TemplateFile[] = [
  ["bascik.config.ts", BASCIK_CONFIG_TS],
  ["scripts/write-csv.ts", WRITE_CSV_TS],
  ["e2e/app.spec.ts", APP_SPEC_TS],
  ["src/pages/css/styles.css", CSS_STYLES_CSS],
  ["src/pages/index.html", INDEX_HTML],
  ["src/pages/reports/[period].html", REPORTS_PERIOD_HTML],
  ["src/pages/compare.html", COMPARE_HTML],
  ["src/pages/404.html", PAGE_404_HTML],
];
