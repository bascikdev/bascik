/**
 * @module templates/reports/components
 *
 * The components of the `reports` template's site. Each one that shows data keeps its markup in a `render.ts`
 * beside it, which its test calls directly. `site-meta` is not here: `reports.ts` derives it from the default
 * template's. The header's skip link styles come from the default template too.
 */

import type { TemplateFile } from "../../scaffold.js";
import { SKIP_LINK_CSS } from "./derived.js";

const CHART_EXPLORER_HTML = `<!-- @bascik
An SVG and its data table, with lightweight linked inspection. The complete chart and table work without scripts.
-->
<figure id="chart" class="chart-figure" data-testid="chart-explorer">
  <div data-bascik-slot></div>
  <p id="inspection" class="chart-inspection" data-testid="chart-explorer-inspection" hidden></p>
</figure>
<script type="text/typescript" src="chart-explorer.ts"></script>
`;

const CHART_EXPLORER_TS = `const root = document.getElementById("chart")!;
const inspection = document.getElementById("inspection")!;
const rows = new Map(
  Array.from(root.querySelectorAll<HTMLTableRowElement>("tbody tr"), (row) => [
    row.querySelector("time")?.getAttribute("datetime") ?? row.cells[0].textContent!.trim(),
    row,
  ]),
);
const entries = Array.from(root.querySelectorAll<SVGGElement>("svg > g"), (bar) => {
  const row = rows.get(bar.dataset.chartKey!);
  if (!row) throw new Error("Chart item has no matching table row: " + bar.dataset.chartKey);
  const label = bar.querySelector("title")!.textContent!;
  const header = row.cells[0];
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chart-inspect";
  button.setAttribute("aria-label", label + " (inspect)");
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("data-testid", "chart-explorer-inspect");
  header.append(button);
  return { bar, row, button, label };
});

type Entry = (typeof entries)[number];
let hovered: Entry | undefined;
let focused: Entry | undefined;
let pinned: Entry | undefined;
const hint = "Hover bars. Select a row to pin; Escape to clear.";
const render = () => {
  const active = pinned ?? hovered ?? focused;
  root.dataset.inspecting = String(Boolean(active));
  inspection.textContent = active ? active.label : hint;
  for (const entry of entries) {
    entry.bar.dataset.active = String(entry === active);
    entry.row.dataset.active = String(entry === active);
    entry.button.setAttribute("aria-pressed", String(entry === pinned));
  }
};
for (const entry of entries) {
  for (const target of [entry.bar, entry.row]) {
    target.addEventListener("pointerenter", () => {
      hovered = entry;
      render();
    });
  }
  entry.row.addEventListener("focusin", () => {
    focused = entry;
    hovered = undefined;
    render();
  });
  entry.row.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && entry.row.contains(event.relatedTarget)) return;
    focused = undefined;
    render();
  });
  entry.button.addEventListener("click", () => {
    pinned = pinned === entry ? undefined : entry;
    render();
  });
}
root.addEventListener("pointerleave", () => {
  hovered = undefined;
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  pinned = hovered = focused = undefined;
  render();
});
if (entries.length > 0) {
  inspection.hidden = false;
  render();
}
`;

const CHART_EXPLORER_TEST_TS = `import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the SVG and table in a semantic figure with inspection hidden until enhancement", () => {
  const markup = readFileSync(new URL("./chart-explorer.html", import.meta.url), "utf8");
  expect(markup).toMatch(/<figure\\s+id="chart"\\s+class="chart-figure"\\s+data-testid="chart-explorer"/);
  expect(markup).toContain("data-bascik-slot");
  expect(markup).toContain('data-testid="chart-explorer-inspection" hidden');
});
`;

/** `src/components/period-comparison/period-comparison.html` */
const PERIOD_COMPARISON_PERIOD_COMPARISON_HTML = `<!-- @bascik
Every period side by side: totals, a chart and a table of revenue per period with the change from one to the next,
and sales by title, author, format and channel over all periods.
Like <report-list>, it reads the whole data folder, so bascik.config.ts keeps it out of the build script cache.
-->
<section data-testid="period-comparison">
  <h2>All periods together</h2>
  <script data-bascik-build-once type="text/typescript">
    import { loadReports } from "@/lib/reports.ts";
    import { comparison } from "./render.ts";
    export default async () => comparison(await loadReports());
  </script>
</section>
`;

/** `src/components/period-comparison/period-comparison.test.ts` */
const PERIOD_COMPARISON_PERIOD_COMPARISON_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AWKWARD, flat, report, sale, twoReports } from "../../lib/testing.ts";
import { comparison } from "./render.ts";

const html = flat(
  readFileSync(new URL("./period-comparison.html", import.meta.url), "utf8"),
);

describe("period-comparison component", () => {
  it("is a section with a heading whose content is built once, from every report", () => {
    expect(html).toMatch(
      /<section data-testid="period-comparison">\\s*<h2>All periods together<\\/h2>/,
    );
    expect(html).toContain(
      '<script data-bascik-build-once type="text/typescript">',
    );
    expect(html).toContain("comparison(await loadReports())");
  });
});

describe("comparison", () => {
  const markup = flat(comparison(twoReports()));

  it("adds the periods up", () => {
    expect(markup).toContain(
      '<dt>Periods</dt><dd class="figure-value">2</dd><dd class="figure-note">July 2026 to August 2026</dd>',
    );
    expect(markup).toContain(
      '<dt>Revenue</dt><dd class="figure-value">$433.97</dd>',
    );
    expect(markup).toContain(
      '<dt>Best period</dt><dd class="figure-value">August 2026</dd><dd class="figure-note">$263.97</dd>',
    );
  });

  it("charts revenue per period, with a table that links each period and totals them", () => {
    expect(markup).toContain(
      "<figcaption>Revenue by period, July 2026 to August 2026</figcaption>",
    );
    expect(markup).toContain('<svg class="chart" viewBox');
    expect(markup).toContain(
      '<a href="/reports/2026-08"><time datetime="2026-08">August 2026</time></a>',
    );
    expect(markup).toContain(
      '<td class="num">$263.97</td><td class="num">$17.60</td><td>Up 55.3%</td>',
    );
    expect(markup).toContain(
      '<td class="num">$170.00</td><td class="num">$17.00</td><td>n/a: first report</td>',
    );
    expect(markup).toContain(
      '<th scope="row">Total</th><td class="num">25</td><td class="num">$433.97</td><td class="num">$17.36</td>',
    );
  });

  it("adds sales up by title, author, format and channel over all periods", () => {
    for (const id of ["titles", "authors", "formats", "channels"])
      expect(markup).toContain(\`data-testid="period-comparison-\${id}"\`);
    expect(markup).toContain(
      '<th scope="row">Porsche 911 RSR</th><td>Jordan Taylor</td><td class="num">22</td><td class="num">$374.00</td>',
    );
  });

  it("says how to add a report when there are none", () => {
    expect(flat(comparison([]))).toContain("There are no reports yet.");
  });

  it("handles one period, empty periods and awkward text with no NaN", () => {
    for (const reports of [
      [report("2026-07")],
      [report("2026-07", []), report("2026-08", [])],
      [report("2026-07", []), report("2026-08", [sale({ title: AWKWARD })])],
    ])
      expect(flat(comparison(reports))).not.toMatch(
        /NaN|Infinity|undefined|<b>/,
      );
    expect(flat(comparison([report("2026-07")]))).toContain(
      '<dd class="figure-note">July 2026</dd>',
    );
    expect(
      flat(comparison([report("2026-07", []), report("2026-08", [sale()])])),
    ).toContain("<td>New</td>");
  });

  it("charts only the last periods of a long history, and says so", () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      report(\`20\${10 + index}-01\`),
    );
    expect(flat(comparison(many))).toContain(
      "(the chart shows the last 12)</figcaption>",
    );
  });
});
`;

/** `src/components/period-comparison/render.ts` */
const PERIOD_COMPARISON_RENDER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { chartFigure, columnChart, periodColumns } from "../../lib/charts.ts";
import { figureList } from "../../lib/figures.ts";
import {
  averagePrice,
  changeText,
  count,
  money,
  periodLabel,
} from "../../lib/format.ts";
import {
  change,
  totals,
  TREND_PERIODS,
  type Report,
} from "../../lib/reports.ts";
import { dataTable, salesTable } from "../../lib/tables.ts";

/** The comparison of every report. \`reports\` is oldest first, as loadReports() returns it. */
export function comparison(reports: readonly Report[]): SafeHtml {
  if (reports.length === 0)
    return html\`<p>
      There are no reports yet. Add a file such as
      <code>data/reports/2026-07.json</code> and build again.
    </p>\`;
  const periods = reports.map((report) => ({
    period: report.period,
    ...totals(report.sales),
  }));
  const sales = reports.flatMap((report) => report.sales);
  const total = totals(sales);
  const first = periodLabel(periods[0].period);
  const last = periodLabel(periods[periods.length - 1].period);
  const span = first === last ? first : \`\${first} to \${last}\`;
  const best = periods.reduce((top, period) =>
    period.revenueCents > top.revenueCents ? period : top,
  );
  const caption = \`Revenue by period, \${span}\`;
  const charted = periods.slice(-TREND_PERIODS);
  return html\`\${figureList([
    { label: "Periods", value: count(periods.length), note: span },
    { label: "Revenue", value: money(total.revenueCents) },
    { label: "Units sold", value: count(total.units) },
    {
      label: "Best period",
      value: periodLabel(best.period),
      note: money(best.revenueCents),
    },
  ])}\${chartFigure(
    charted.length < periods.length
      ? \`\${caption} (the chart shows the last \${TREND_PERIODS})\`
      : caption,
    columnChart(caption, periodColumns(charted)),
    dataTable({
      caption: \`\${caption}: the figures\`,
      testId: "period-comparison-periods",
      columns: [
        { header: "Period" },
        { header: "Units", numeric: true },
        { header: "Revenue", numeric: true },
        { header: "Average price", numeric: true },
        { header: "Change in revenue" },
      ],
      rows: periods.map((period, index) => [
        html\`<a href="/reports/\${period.period}"
          ><time datetime="\${period.period}"
            >\${periodLabel(period.period)}</time
          ></a
        >\`,
        count(period.units),
        money(period.revenueCents),
        averagePrice(period.revenueCents, period.units),
        changeText(
          change(period.revenueCents, periods[index - 1]?.revenueCents ?? null),
        ),
      ]),
      totals: [
        "Total",
        count(total.units),
        money(total.revenueCents),
        averagePrice(total.revenueCents, total.units),
        "",
      ],
    }),
  )}\${(["title", "author", "format", "channel"] as const).map((by) =>
    salesTable(
      sales,
      by,
      \`Sales by \${by}, \${span}\`,
      \`period-comparison-\${by}s\`,
    ),
  )}\`;
}
`;

/** `src/components/report-actions/report-actions.html` */
const REPORT_ACTIONS_REPORT_ACTIONS_HTML = `<!-- @bascik
What a reader can do with a report: print it (or save it as a PDF from the print dialog) and download its data.
@prop csv - Path of the CSV file to download, such as /reports/2026-07.csv
-->
<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin: 20px 0 0;
  }

  /* Neither control means anything on paper. */
  @media print {
    .actions {
      display: none;
    }
  }
</style>
<p class="actions" data-testid="report-actions">
  <button
    id="print"
    type="button"
    class="button"
    data-testid="report-actions-print"
    hidden
  >
    Print or save as PDF
  </button>
  <a
    class="button"
    data-bascik-attr-href="csv"
    download
    data-testid="report-actions-csv"
    >Download CSV</a
  >
</p>
<script type="text/typescript">
  // Printing needs a script, so the button stays hidden until this one runs.
  const print = document.getElementById("print") as HTMLButtonElement;
  print.hidden = false;
  print.addEventListener("click", (): void => window.print());
</script>
`;

/** `src/components/report-actions/report-actions.test.ts` */
const REPORT_ACTIONS_REPORT_ACTIONS_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flat } from "../../lib/testing.ts";

const html = flat(
  readFileSync(new URL("./report-actions.html", import.meta.url), "utf8"),
);

describe("report-actions component", () => {
  it("has a real button that prints, hidden until its script runs", () => {
    expect(html).toMatch(
      /<button id="print" type="button" class="button" data-testid="report-actions-print" hidden>\\s*Print or save as PDF\\s*<\\/button>/,
    );
    expect(html).toContain('<script type="text/typescript">');
    expect(html).toContain("print.hidden = false");
    expect(html).toContain("window.print()");
  });

  it("links to the CSV file named by its csv prop, as a download", () => {
    expect(html).toContain(
      '<a class="button" data-bascik-attr-href="csv" download data-testid="report-actions-csv">',
    );
  });

  it("is left out of a printed report", () => {
    expect(html).toMatch(/@media print \\{\\s*\\.actions \\{ display: none; \\}/);
  });
});
`;

/** `src/components/report-charts/render.ts` */
const REPORT_CHARTS_RENDER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import {
  barChart,
  chartFigure,
  columnChart,
  periodColumns,
} from "../../lib/charts.ts";
import { money, periodLabel } from "../../lib/format.ts";
import { groupBy, type ReportRoute, type Sale } from "../../lib/reports.ts";
import { dataTable, salesTable } from "../../lib/tables.ts";

const breakdown = (
  sales: readonly Sale[],
  by: "format" | "channel",
  period: string,
): SafeHtml => {
  const caption = \`Revenue by \${by}, \${period}\`;
  const items = groupBy(sales, by).map((group) => ({
    label: group.label,
    value: group.revenueCents,
    valueLabel: money(group.revenueCents),
  }));
  return chartFigure(
    caption,
    barChart(caption, items),
    salesTable(sales, by, \`\${caption}: the figures\`, \`report-charts-\${by}\`),
  );
};

/** The three figures of a report page. */
export function charts({ report, trend }: ReportRoute): SafeHtml {
  const period = periodLabel(report.period);
  const trendCaption = \`Revenue by period, up to \${period}\`;
  return html\`\${chartFigure(
    trendCaption,
    columnChart(trendCaption, periodColumns(trend, true)),
    dataTable({
      caption: \`\${trendCaption}: the figures\`,
      testId: "report-charts-trend",
      columns: [{ header: "Period" }, { header: "Revenue", numeric: true }],
      rows: trend.map(({ period, revenueCents }) => [
        html\`<time datetime="\${period}">\${periodLabel(period)}</time>\`,
        money(revenueCents),
      ]),
    }),
  )}\${breakdown(report.sales, "format", period)}\${breakdown(
    report.sales,
    "channel",
    period,
  )}\`;
}
`;

/** `src/components/report-charts/report-charts.html` */
const REPORT_CHARTS_REPORT_CHARTS_HTML = `<!-- @bascik
The charts of a report: revenue over the periods so far, by format and by channel. Each is an inline SVG drawn at
build time, in a <figure> with a caption and a table of the same figures.
Only for src/pages/reports/[period].html: it reads the report from the route.
-->
<section class="chart-grid" data-testid="report-charts">
  <h2>Charts</h2>
  <script data-bascik-build type="text/typescript">
    import { reportRoute } from "@/lib/reports.ts";
    import { charts } from "./render.ts";
    export default () => charts(reportRoute(process.env.BASCIK_ROUTE));
  </script>
</section>
`;

/** `src/components/report-charts/report-charts.test.ts` */
const REPORT_CHARTS_REPORT_CHARTS_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AWKWARD,
  flat,
  report,
  routeOf,
  sale,
  twoReports,
} from "../../lib/testing.ts";
import { charts } from "./render.ts";

const html = flat(
  readFileSync(new URL("./report-charts.html", import.meta.url), "utf8"),
);
const figures = (markup: string): string[] => markup.split("<chart-explorer>").slice(1);

describe("report-charts component", () => {
  it("is a section with a heading that reads the report from the page's route", () => {
    expect(html).toMatch(
      /<section class="chart-grid" data-testid="report-charts">\\s*<h2>Charts<\\/h2>/,
    );
    expect(html).toContain("charts(reportRoute(process.env.BASCIK_ROUTE))");
  });
});

describe("charts", () => {
  const markup = flat(charts(routeOf(twoReports())));

  it("draws three figures, each with a caption, an SVG chart and a table of the same figures", () => {
    const parts = figures(markup);
    expect(parts).toHaveLength(3);
    for (const [index, caption] of [
      "Revenue by period, up to August 2026",
      "Revenue by format, August 2026",
      "Revenue by channel, August 2026",
    ].entries()) {
      expect(parts[index]).toContain(\`<figcaption>\${caption}</figcaption>\`);
      expect(parts[index]).toContain(\`<svg class="chart" viewBox\`);
      expect(parts[index]).toContain(\`aria-label="\${caption}"\`);
      expect(parts[index]).toContain(
        \`<caption>\${caption}: the figures</caption>\`,
      );
    }
  });

  it("writes each charted value in the chart and in its table", () => {
    const [trend, formats, channels] = figures(markup);
    for (const value of ["$170.00", "$263.97"]) {
      expect(trend).toContain(\`>\${value}</text>\`);
      expect(trend).toContain(\`<td class="num">\${value}</td>\`);
    }
    for (const value of ["$204.00", "$59.97"]) {
      expect(formats).toContain(\`>\${value}</text>\`);
      expect(formats).toContain(\`<td class="num">\${value}</td>\`);
      expect(channels).toContain(\`>\${value}</text>\`);
    }
    expect(trend).toContain('<time datetime="2026-07">July 2026</time>');
  });

  it("draws a first report's single column, and an empty period, with no NaN", () => {
    for (const reports of [
      [twoReports()[0]],
      [report("2026-07", [])],
      [...twoReports(), report("2026-09", [])],
    ]) {
      const drawn = flat(charts(routeOf(reports)));
      expect(figures(drawn)).toHaveLength(3);
      expect(drawn).not.toMatch(/NaN|Infinity|undefined/);
    }
    expect(flat(charts(routeOf([report("2026-07", [])])))).toContain(
      ">No data</text>",
    );
  });

  it("escapes format and channel names in the chart and the table", () => {
    const drawn = flat(
      charts(
        routeOf([
          report("2026-07", [sale({ format: AWKWARD, channel: "<Web>" })]),
        ]),
      ),
    );
    expect(drawn).toContain("&lt;Web&gt;</text>");
    expect(drawn).toContain('<th scope="row">&lt;Web&gt;</th>');
    expect(drawn).not.toContain("<b>");
  });
});
`;

/** `src/components/report-list/render.ts` */
const REPORT_LIST_RENDER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { figureList, headlineFigures } from "../../lib/figures.ts";
import { periodLabel } from "../../lib/format.ts";
import type { Report } from "../../lib/reports.ts";

/** The reports as cards, newest first. \`reports\` is oldest first, as loadReports() returns it. */
export function reportList(reports: readonly Report[]): SafeHtml {
  if (reports.length === 0)
    return html\`<p>
      There are no reports yet. Add a file such as
      <code>data/reports/2026-07.json</code> and build again.
    </p>\`;
  const cards = reports
    .map(
      (report, index) =>
        html\`<li>
          <article class="report-card">
            <h3>
              <a href="/reports/\${report.period}"
                ><time datetime="\${report.period}"
                  >\${periodLabel(report.period)}</time
                ></a
              >
            </h3>
            \${figureList(
              headlineFigures(report, reports[index - 1] ?? null).slice(0, 2),
            )}
          </article>
        </li>\`,
    )
    .reverse();
  return html\`<ul class="report-cards">
    \${cards}
  </ul>\`;
}
`;

/** `src/components/report-list/report-list.html` */
const REPORT_LIST_REPORT_LIST_HTML = `<!-- @bascik
Every report, newest first, with its headline figures and a link to its page.
The list is the same on every page, so its script is data-bascik-build-once. It reads a folder, which the build
script cache cannot see: bascik.config.ts keeps this component out of the cache so a new data file shows up.
-->
<section data-testid="report-list">
  <h2>All reports</h2>
  <script data-bascik-build-once type="text/typescript">
    import { loadReports } from "@/lib/reports.ts";
    import { reportList } from "./render.ts";
    export default async () => reportList(await loadReports());
  </script>
</section>
`;

/** `src/components/report-list/report-list.test.ts` */
const REPORT_LIST_REPORT_LIST_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AWKWARD, flat, report, sale, twoReports } from "../../lib/testing.ts";
import { reportList } from "./render.ts";

const html = flat(
  readFileSync(new URL("./report-list.html", import.meta.url), "utf8"),
);

describe("report-list component", () => {
  it("is a section whose list is built once, from every report", () => {
    expect(html).toContain('<section data-testid="report-list">');
    expect(html).toContain(
      '<script data-bascik-build-once type="text/typescript">',
    );
    expect(html).toContain("reportList(await loadReports())");
  });
});

describe("reportList", () => {
  it("lists the reports newest first, each linked by its period", () => {
    const list = flat(reportList(twoReports()));
    expect(list.indexOf("August 2026")).toBeLessThan(
      list.indexOf("July 2026</time>"),
    );
    expect(list).toContain(
      '<a href="/reports/2026-08"><time datetime="2026-08">August 2026</time></a>',
    );
  });

  it("shows revenue and units with the change against the report before", () => {
    const list = flat(reportList(twoReports()));
    expect(list).toContain(
      '<dd class="figure-value">$263.97</dd><dd class="figure-note">Up 55.3% from July 2026</dd>',
    );
    expect(list).toContain(
      '<dd class="figure-value">10</dd><dd class="figure-note">n/a: first report</dd>',
    );
    expect(list).not.toContain("Titles sold");
  });

  it("says how to add a report when there are none", () => {
    expect(flat(reportList([]))).toContain("There are no reports yet.");
  });

  it("handles a period with no sales and awkward text", () => {
    const list = flat(
      reportList([
        report("2026-07", []),
        report("2026-08", [sale({ title: AWKWARD })]),
      ]),
    );
    expect(list).not.toMatch(/NaN|Infinity|undefined/);
    expect(list).toContain("New: nothing in July 2026");
  });
});
`;

/** `src/components/report-masthead/render.ts` */
const REPORT_MASTHEAD_RENDER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { csvPath } from "../../lib/csv.ts";
import { periodLabel } from "../../lib/format.ts";
import type { ReportRoute } from "../../lib/reports.ts";

/** The heading of a report page. The <report-actions> tag it returns is rendered like one written in a page. */
export function masthead({ report }: ReportRoute): SafeHtml {
  return html\`<p class="eyebrow">Monthly racing report</p>
    <h1>
      <time datetime="\${report.period}">\${periodLabel(report.period)}</time>
      racing report
    </h1>
    <report-actions
      data-bascik-prop-csv="\${csvPath(report.period)}"
    ></report-actions>\`;
}
`;

/** `src/components/report-masthead/report-masthead.html` */
const REPORT_MASTHEAD_REPORT_MASTHEAD_HTML = `<!-- @bascik
The top of a report page: the period as the page's <h1>, with the print button and the CSV download.
Only for src/pages/reports/[period].html: it reads the report from the route.
-->
<header class="masthead" data-testid="report-masthead">
  <script data-bascik-build type="text/typescript">
    import { reportRoute } from "@/lib/reports.ts";
    import { masthead } from "./render.ts";
    export default () => masthead(reportRoute(process.env.BASCIK_ROUTE));
  </script>
</header>
`;

/** `src/components/report-masthead/report-masthead.test.ts` */
const REPORT_MASTHEAD_REPORT_MASTHEAD_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flat, routeOf, twoReports } from "../../lib/testing.ts";
import { masthead } from "./render.ts";

const html = flat(
  readFileSync(new URL("./report-masthead.html", import.meta.url), "utf8"),
);

describe("report-masthead component", () => {
  it("is a header that reads the report from the page's route", () => {
    expect(html).toContain(
      '<header class="masthead" data-testid="report-masthead">',
    );
    expect(html).toContain("masthead(reportRoute(process.env.BASCIK_ROUTE))");
  });
});

describe("masthead", () => {
  const markup = flat(masthead(routeOf(twoReports())));

  it("makes the period the page's one <h1>, as a <time>", () => {
    expect(markup).toContain(
      '<h1><time datetime="2026-08">August 2026</time>racing report</h1>',
    );
    expect(markup.split("<h1")).toHaveLength(2);
  });

  it("places the actions with the period's CSV file", () => {
    expect(markup).toContain(
      '<report-actions data-bascik-prop-csv="/reports/2026-08.csv"></report-actions>',
    );
  });
});
`;

/** `src/components/report-notes/render.ts` */
const REPORT_NOTES_RENDER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import type { Report } from "../../lib/reports.ts";

/**
 * The period's notes and, when the site URL is known, the report's permanent link. The link's text is the URL
 * itself, so it is still there on paper.
 */
export function notes(report: Report, url: string | undefined): SafeHtml {
  return html\`<h3>This period</h3>
    \${
      report.notes.length > 0
        ? html\`<ul>
            \${report.notes.map((note) => html\`<li>\${note}</li>\`)}
          </ul>\`
        : html\`<p>There are no notes for this period.</p>\`
    }
    \${
      url
        ? html\`<p>Permanent link: <a class="url" href="\${url}">\${url}</a></p>\`
        : ""
    }\`;
}
`;

/** `src/components/report-notes/report-notes.html` */
const REPORT_NOTES_REPORT_NOTES_HTML = `<!-- @bascik
The notes of a report: the period's own notes from its data file, the report's permanent link, and how the figures
are calculated. Only for src/pages/reports/[period].html: it reads the report from the route.
-->
<style>
  section {
    margin-top: 32px;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: var(--r);
    background: var(--panel);
    box-shadow: var(--sheen), var(--shadow);
  }

  h2 {
    margin-top: 0;
  }

  @media print {
    section {
      padding: 0;
      border: 0;
      background: none;
      box-shadow: none;
    }
  }
</style>
<section data-testid="report-notes">
  <h2>Notes and methodology</h2>
  <script data-bascik-build type="text/typescript">
    import { reportRoute } from "@/lib/reports.ts";
    import { pageUrl } from "@/lib/seo.ts";
    import { notes } from "./render.ts";
    export default () =>
      notes(reportRoute(process.env.BASCIK_ROUTE).report, pageUrl());
  </script>
  <h3>How the figures are calculated</h3>
  <ul>
    <li>
      Revenue is the amount charged for each sale, recorded in whole cents and
      added up without rounding.
    </li>
    <li>Units are copies sold. Returns are not subtracted.</li>
    <li>
      A change compares a figure with the report before it. When that figure was
      zero the change reads "New", and the first report has no change to show.
    </li>
    <li>
      Shares are rounded to one decimal, so a column of shares may not add up to
      exactly 100%.
    </li>
  </ul>
</section>
`;

/** `src/components/report-notes/report-notes.test.ts` */
const REPORT_NOTES_REPORT_NOTES_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AWKWARD, flat, report, twoReports } from "../../lib/testing.ts";
import { notes } from "./render.ts";

const html = flat(
  readFileSync(new URL("./report-notes.html", import.meta.url), "utf8"),
);

describe("report-notes component", () => {
  it("is a section with the period's notes, then how the figures are calculated", () => {
    expect(html).toMatch(
      /<section data-testid="report-notes">\\s*<h2>Notes and methodology<\\/h2>/,
    );
    expect(html).toContain(
      "notes(reportRoute(process.env.BASCIK_ROUTE).report, pageUrl())",
    );
    expect(html).toContain("<h3>How the figures are calculated</h3>");
    expect(html).toContain("whole cents");
  });
});

describe("notes", () => {
  it("lists the period's notes under a heading one level below the section's", () => {
    const markup = flat(notes(twoReports()[1], undefined));
    expect(markup).toContain(
      "<h3>This period</h3><ul><li>No events were held in August.</li></ul>",
    );
    expect(markup).not.toContain("Permanent link");
  });

  it("says so when the period has no notes", () => {
    expect(flat(notes(twoReports()[0], undefined))).toContain(
      "There are no notes for this period.",
    );
  });

  it("writes the permanent link as its own text, so it survives printing", () => {
    const url = "https://example.com/reports/2026-08";
    expect(flat(notes(twoReports()[1], url))).toContain(
      \`<p>Permanent link:<a class="url" href="\${url}">\${url}</a></p>\`,
    );
  });

  it("escapes a note", () => {
    const markup = flat(notes(report("2026-07", [], [AWKWARD]), undefined));
    expect(markup).toContain(
      "<li>Porsche &lt;b&gt;&amp; 963, $&amp; &#39;n&#39; more</li>",
    );
  });
});
`;

/** `src/components/report-pager/render.ts` */
const REPORT_PAGER_RENDER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { periodLabel } from "../../lib/format.ts";
import type { ReportRoute } from "../../lib/reports.ts";

/** The previous and next report, where there is one, around a link to the list. */
export function pager({ previous, nextPeriod }: ReportRoute): SafeHtml {
  return html\`\${
      previous
        ? html\`<a
            rel="prev"
            href="/reports/\${previous.period}"
            data-testid="report-pager-previous"
            >Previous: \${periodLabel(previous.period)}</a
          >\`
        : html\`<span>This is the first report</span>\`
    }
    <a href="/" data-testid="report-pager-all">All reports</a>
    \${
      nextPeriod
        ? html\`<a
            rel="next"
            href="/reports/\${nextPeriod}"
            data-testid="report-pager-next"
            >Next: \${periodLabel(nextPeriod)}</a
          >\`
        : html\`<span>This is the latest report</span>\`
    }\`;
}
`;

/** `src/components/report-pager/report-pager.html` */
const REPORT_PAGER_REPORT_PAGER_HTML = `<!-- @bascik
Links to the report before and after this one. Only for src/pages/reports/[period].html: it reads the neighbors
from the route.
-->
<style>
  nav {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px 24px;
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }

  @media print {
    nav {
      display: none;
    }
  }
</style>
<nav class="pager" aria-label="Other reports" data-testid="report-pager">
  <script data-bascik-build type="text/typescript">
    import { reportRoute } from "@/lib/reports.ts";
    import { pager } from "./render.ts";
    export default () => pager(reportRoute(process.env.BASCIK_ROUTE));
  </script>
</nav>
`;

/** `src/components/report-pager/report-pager.test.ts` */
const REPORT_PAGER_REPORT_PAGER_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flat, report, routeOf, twoReports } from "../../lib/testing.ts";
import { pager } from "./render.ts";

const html = flat(
  readFileSync(new URL("./report-pager.html", import.meta.url), "utf8"),
);

describe("report-pager component", () => {
  it("is a named <nav> that reads its neighbors from the page's route", () => {
    expect(html).toContain(
      '<nav class="pager" aria-label="Other reports" data-testid="report-pager">',
    );
    expect(html).toContain("pager(reportRoute(process.env.BASCIK_ROUTE))");
  });

  it("is left out of a printed report", () => {
    expect(html).toMatch(/@media print \\{\\s*nav \\{ display: none; \\}/);
  });
});

describe("pager", () => {
  const reports = [...twoReports(), report("2026-09")];

  it("links to the report before and the report after", () => {
    const markup = flat(pager(routeOf(reports, 1)));
    expect(markup).toContain(
      '<a rel="prev" href="/reports/2026-07" data-testid="report-pager-previous">Previous: July 2026</a>',
    );
    expect(markup).toContain(
      '<a rel="next" href="/reports/2026-09" data-testid="report-pager-next">Next: September 2026</a>',
    );
    expect(markup).toContain(
      '<a href="/" data-testid="report-pager-all">All reports</a>',
    );
  });

  it("has no previous link on the first report and no next link on the latest", () => {
    const first = flat(pager(routeOf(reports, 0)));
    expect(first).toContain("This is the first report");
    expect(first).not.toContain('rel="prev"');
    const latest = flat(pager(routeOf(reports)));
    expect(latest).toContain("This is the latest report");
    expect(latest).not.toContain('rel="next"');
  });

  it("has neither on the only report", () => {
    const only = flat(pager(routeOf([report("2026-07")])));
    expect(only).not.toMatch(/rel="(prev|next)"/);
  });
});
`;

/** `src/components/report-summary/render.ts` */
const REPORT_SUMMARY_RENDER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { figureList, headlineFigures } from "../../lib/figures.ts";
import { money, periodLabel, plural, share } from "../../lib/format.ts";
import { groupBy, totals, type ReportRoute } from "../../lib/reports.ts";

/** The summary paragraph and the headline figures of a report. */
export function summary({ report, previous }: ReportRoute): SafeHtml {
  const total = totals(report.sales);
  const titles = groupBy(report.sales, "title");
  const [best] = titles;
  const lead = best
    ? html\`<p class="lede">
        \${periodLabel(report.period)} brought in \${money(total.revenueCents)}
        from \${plural(total.units, "unit")} across
        \${plural(titles.length, "title")}. The best seller was
        <cite>\${best.label}</cite> by \${best.author}, with
        \${money(best.revenueCents)}
        (\${share(best.revenueCents, total.revenueCents)} of revenue).
      </p>\`
    : html\`<p class="lede">
        No sales were recorded in \${periodLabel(report.period)}.
      </p>\`;
  return html\`\${lead}\${figureList(headlineFigures(report, previous))}\`;
}
`;

/** `src/components/report-summary/report-summary.html` */
const REPORT_SUMMARY_REPORT_SUMMARY_HTML = `<!-- @bascik
The executive summary of a report: one paragraph and the headline figures, each with its change against the
previous period in words. Only for src/pages/reports/[period].html: it reads the report from the route.
-->
<section data-testid="report-summary">
  <h2>Summary</h2>
  <script data-bascik-build type="text/typescript">
    import { reportRoute } from "@/lib/reports.ts";
    import { summary } from "./render.ts";
    export default () => summary(reportRoute(process.env.BASCIK_ROUTE));
  </script>
</section>
`;

/** `src/components/report-summary/report-summary.test.ts` */
const REPORT_SUMMARY_REPORT_SUMMARY_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AWKWARD,
  flat,
  report,
  routeOf,
  sale,
  twoReports,
} from "../../lib/testing.ts";
import { summary } from "./render.ts";

const html = flat(
  readFileSync(new URL("./report-summary.html", import.meta.url), "utf8"),
);

describe("report-summary component", () => {
  it("is a section with a heading that reads the report from the page's route", () => {
    expect(html).toMatch(
      /<section data-testid="report-summary">\\s*<h2>Summary<\\/h2>/,
    );
    expect(html).toContain("summary(reportRoute(process.env.BASCIK_ROUTE))");
  });
});

describe("summary", () => {
  it("sums the period up in a sentence and names the best seller", () => {
    const markup = flat(summary(routeOf(twoReports())));
    expect(markup).toContain(
      "August 2026 brought in $263.97 from 15 units across 2 titles.",
    );
    expect(markup).toContain(
      "<cite>Porsche 911 RSR</cite>by Jordan Taylor, with $204.00 (77.3% of revenue).",
    );
  });

  it("shows the four headline figures with their change in words", () => {
    const markup = flat(summary(routeOf(twoReports())));
    for (const label of [
      "Revenue",
      "Units sold",
      "Titles sold",
      "Average price per unit",
    ])
      expect(markup).toContain(\`<dt>\${label}</dt>\`);
    expect(markup).toContain("Up 55.3% from July 2026");
  });

  it("writes singular nouns for one unit of one title", () => {
    const markup = flat(
      summary(routeOf([report("2026-07", [sale({ units: 1 })])])),
    );
    expect(markup).toContain("from 1 unit across 1 title.");
  });

  it("says so when the period has no sales, with no NaN", () => {
    const markup = flat(
      summary(routeOf([...twoReports(), report("2026-09", [])])),
    );
    expect(markup).toContain("No sales were recorded in September 2026.");
    expect(markup).toContain("Down 100.0% from August 2026");
    expect(markup).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("escapes the best seller's title and author", () => {
    const markup = flat(
      summary(
        routeOf([
          report("2026-07", [sale({ title: AWKWARD, author: "<i>A&B</i>" })]),
        ]),
      ),
    );
    expect(markup).toContain(
      "<cite>Porsche &lt;b&gt;&amp; 963, $&amp; &#39;n&#39; more</cite>by &lt;i&gt;A&amp;B&lt;/i&gt;",
    );
  });
});
`;

/** `src/components/report-tables/render.ts` */
const REPORT_TABLES_RENDER_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { count, money, periodLabel } from "../../lib/format.ts";
import { totals, type ReportRoute } from "../../lib/reports.ts";
import { dataTable, salesTable } from "../../lib/tables.ts";

/** Sales by title and by author, then every line of the period's data file. */
export function tables({ report }: ReportRoute): SafeHtml {
  const period = periodLabel(report.period);
  const total = totals(report.sales);
  return html\`\${salesTable(
    report.sales,
    "title",
    \`Sales by title, \${period}\`,
    "report-tables-titles",
  )}\${salesTable(
    report.sales,
    "author",
    \`Sales by author, \${period}\`,
    "report-tables-authors",
  )}\${dataTable({
    caption: \`Every sales line, \${period}\`,
    testId: "report-tables-lines",
    columns: [
      { header: "Title" },
      { header: "Author" },
      { header: "Format" },
      { header: "Channel" },
      { header: "Units", numeric: true },
      { header: "Revenue", numeric: true },
    ],
    rows: report.sales.map((sale) => [
      sale.title,
      sale.author,
      sale.format,
      sale.channel,
      count(sale.units),
      money(sale.revenueCents),
    ]),
    totals: [
      "Total",
      "",
      "",
      "",
      count(total.units),
      money(total.revenueCents),
    ],
  })}\`;
}
`;

/** `src/components/report-tables/report-tables.html` */
const REPORT_TABLES_REPORT_TABLES_HTML = `<!-- @bascik
The detailed tables of a report: sales by title, by author, and every line of the data file. Each has a caption,
scoped headers, right-aligned numbers and a total row.
Only for src/pages/reports/[period].html: it reads the report from the route.
-->
<section data-testid="report-tables">
  <h2>Detailed tables</h2>
  <script data-bascik-build type="text/typescript">
    import { reportRoute } from "@/lib/reports.ts";
    import { tables } from "./render.ts";
    export default () => tables(reportRoute(process.env.BASCIK_ROUTE));
  </script>
</section>
`;

/** `src/components/report-tables/report-tables.test.ts` */
const REPORT_TABLES_REPORT_TABLES_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AWKWARD,
  flat,
  report,
  routeOf,
  sale,
  twoReports,
} from "../../lib/testing.ts";
import { tables } from "./render.ts";

const html = flat(
  readFileSync(new URL("./report-tables.html", import.meta.url), "utf8"),
);

describe("report-tables component", () => {
  it("is a section with a heading that reads the report from the page's route", () => {
    expect(html).toMatch(
      /<section data-testid="report-tables">\\s*<h2>Detailed tables<\\/h2>/,
    );
    expect(html).toContain("tables(reportRoute(process.env.BASCIK_ROUTE))");
  });
});

describe("tables", () => {
  const markup = flat(tables(routeOf(twoReports())));

  it("has a table by title, by author, and of every sales line", () => {
    for (const [id, caption] of [
      ["report-tables-titles", "Sales by title, August 2026"],
      ["report-tables-authors", "Sales by author, August 2026"],
      ["report-tables-lines", "Every sales line, August 2026"],
    ]) {
      expect(markup).toContain(\`data-testid="\${id}"\`);
      expect(markup).toContain(\`<caption>\${caption}</caption>\`);
    }
  });

  it("ends every table with the same total, which is the report's headline figure", () => {
    expect(markup.split("<tfoot>")).toHaveLength(4);
    expect(
      markup.split('<td class="num">15</td><td class="num">$263.97</td>'),
    ).toHaveLength(4);
  });

  it("lists each line with its format and channel", () => {
    expect(markup).toContain(
      '<th scope="row">Porsche 962C</th><td>Hurley Haywood</td><td>LMDh</td><td>Daytona</td><td class="num">3</td><td class="num">$59.97</td>',
    );
  });

  it("handles an empty period and awkward text", () => {
    const empty = flat(tables(routeOf([report("2026-07", [])])));
    expect(empty.split("No sales recorded.")).toHaveLength(4);
    expect(empty).not.toMatch(/NaN|Infinity|undefined/);
    const awkward = flat(
      tables(routeOf([report("2026-07", [sale({ title: AWKWARD })])])),
    );
    expect(awkward).toContain(
      '<th scope="row">Porsche &lt;b&gt;&amp; 963, $&amp; &#39;n&#39; more</th>',
    );
    expect(awkward).not.toContain("<b>");
  });
});
`;

/** `src/components/site-footer/site-footer.html` */
const SITE_FOOTER_SITE_FOOTER_HTML = `<style>
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px 24px;
    width: 100%;
    max-width: var(--page);
    margin: 0 auto;
    padding: 24px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  p {
    margin: 0;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  a {
    display: inline-block;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-weight: 500;
    text-decoration: none;
  }

  a:hover {
    border-color: var(--border);
    background: var(--surface);
    color: var(--link);
  }

  @media print {
    nav {
      display: none;
    }
  }
</style>
<footer data-testid="site-footer">
  <p>
    <script data-bascik-build-once type="text/typescript">
      import { html } from "@bascik/bascik/html";
      import { siteName } from "@/lib/site.ts";
      export default () => html\`<strong>\${siteName}</strong>\`;
    </script>
    Every figure is built from the files in <code>data/reports/</code>.
  </p>
  <nav aria-label="Footer" data-testid="site-footer-nav">
    <a href="/" data-testid="site-footer-reports">Reports</a>
    <a href="/compare" data-testid="site-footer-compare">Compare periods</a>
  </nav>
</footer>
`;

/** `src/components/site-footer/site-footer.test.ts` */
const SITE_FOOTER_SITE_FOOTER_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flat } from "../../lib/testing.ts";

const html = flat(
  readFileSync(new URL("./site-footer.html", import.meta.url), "utf8"),
);

describe("site-footer component", () => {
  it("prints the site name through html and links to both lists", () => {
    expect(html).toContain('<footer data-testid="site-footer">');
    expect(html).toContain("html\`<strong>\${siteName}</strong>\`");
    expect(html).toContain('<a href="/" data-testid="site-footer-reports">');
    expect(html).toContain(
      '<a href="/compare" data-testid="site-footer-compare">',
    );
  });

  it("prints no date, so the same data always builds the same page", () => {
    expect(html).not.toContain("new Date");
  });

  it("drops its links from a printed report", () => {
    expect(html).toMatch(/@media print \\{\\s*nav \\{ display: none; \\}/);
  });
});
`;

/** `src/components/site-header/site-header.html` */
const SITE_HEADER_SITE_HEADER_HTML = `<style>
${SKIP_LINK_CSS}
  header {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    box-shadow: var(--sheen), 0 2px 12px light-dark(rgb(45 57 86 / 3%), rgb(0 0 0 / 8%));
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 24px;
    max-width: var(--page);
    margin: 0 auto;
    padding: 16px 32px;
  }

  .brand {
    min-width: 0;
    max-width: 100%;
    font-weight: 650;
    letter-spacing: -0.03em;
    color: var(--text);
    overflow-wrap: anywhere;
    text-decoration: none;
  }
  .brand::before {
    content: "";
    display: inline-block;
    width: 22px;
    height: 22px;
    margin-right: 10px;
    border: 5px solid var(--chart);
    border-radius: 8px;
    vertical-align: middle;
    transform: rotate(-12deg);
    background: var(--lavender);
  }

  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    list-style: none;
    margin: 0 0 0 auto;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-soft);
    box-shadow: inset 0 1px 3px light-dark(rgb(45 57 86 / 4%), rgb(0 0 0 / 15%));
  }

  li a {
    display: inline-block;
    padding: 7px 14px;
    border-radius: 10px;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-weight: 500;
    text-decoration: none;
    border: 1px solid transparent;
  }

  li a:hover {
    background: var(--panel);
    border-color: var(--border);
    color: var(--link);
    box-shadow: var(--sheen), 0 2px 4px rgb(0 0 0 / 5%);
  }

  nav a:focus-visible {
    outline: 3px solid var(--link);
    outline-offset: 3px;
  }

  @media (max-width: 700px) {
    nav {
      padding: 16px;
      gap: 12px;
    }
  }

  /* A printed report has no use for navigation. */
  @media print {
    header {
      display: none;
    }
  }
</style>
<header data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link"
    >Skip to content</a
  >
  <nav aria-label="Main" data-testid="site-header-nav">
    <script data-bascik-build-once type="text/typescript">
      import { html } from "@bascik/bascik/html";
      import { siteName } from "@/lib/site.ts";
      export default () =>
        html\`<a href="/" class="brand" data-testid="site-header-brand">\${siteName}</a>\`;
    </script>
    <ul>
      <li><a href="/" data-testid="site-header-reports">Reports</a></li>
      <li>
        <a href="/compare" data-testid="site-header-compare">Compare periods</a>
      </li>
    </ul>
  </nav>
</header>
`;

/** `src/components/site-header/site-header.test.ts` */
const SITE_HEADER_SITE_HEADER_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flat } from "../../lib/testing.ts";

const html = flat(
  readFileSync(new URL("./site-header.html", import.meta.url), "utf8"),
);

describe("site-header component", () => {
  it('starts with a skip link to the page\\'s <main id="main">', () => {
    expect(html).toMatch(
      /<header data-testid="site-header">\\s*<a href="#main" class="skip-link" data-testid="site-header-skip-link">/,
    );
  });

  it("hides the skip link by clipping until it has focus", () => {
    expect(html).toMatch(
      /\\.skip-link:not\\(:focus\\) \\{[^}]*clip-path: inset\\(50%\\)/,
    );
  });

  it("prints the site name from src/lib/site.ts through html, once for every page", () => {
    expect(html).toContain(
      '<script data-bascik-build-once type="text/typescript">',
    );
    expect(html).toContain('import { siteName } from "@/lib/site.ts"');
    expect(html).toContain('html\`<a href="/" class="brand"');
  });

  it("links to the report list and the comparison", () => {
    expect(html).toContain('<a href="/" data-testid="site-header-reports">');
    expect(html).toContain(
      '<a href="/compare" data-testid="site-header-compare">',
    );
  });

  it("is left out of a printed report", () => {
    expect(html).toMatch(/@media print \\{\\s*header \\{ display: none; \\}/);
  });
});
`;

/** `src/components/site-meta/site-meta.test.ts` */
const SITE_META_SITE_META_TEST_TS = `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flat } from "../../lib/testing.ts";

const html = flat(
  readFileSync(new URL("./site-meta.html", import.meta.url), "utf8"),
);

describe("site-meta component", () => {
  it("has the charset, viewport, icons and stylesheet every page shares", () => {
    for (const part of [
      'charset="UTF-8"',
      'name="viewport"',
      "favicon.ico",
      "favicon.svg",
      "apple-touch-icon.png",
      "/css/styles.css",
    ])
      expect(html).toContain(part);
  });

  it("leaves the title and description to each page's pageHead()", () => {
    expect(html).not.toContain("<title");
    expect(html).not.toContain('name="description"');
  });
});
`;

/** Everything under `src/components/` except `site-meta/site-meta.html`. */
export const COMPONENT_FILES: TemplateFile[] = [
  ["src/components/chart-explorer/chart-explorer.html", CHART_EXPLORER_HTML],
  ["src/components/chart-explorer/chart-explorer.ts", CHART_EXPLORER_TS],
  [
    "src/components/chart-explorer/chart-explorer.test.ts",
    CHART_EXPLORER_TEST_TS,
  ],
  [
    "src/components/period-comparison/period-comparison.html",
    PERIOD_COMPARISON_PERIOD_COMPARISON_HTML,
  ],
  [
    "src/components/period-comparison/period-comparison.test.ts",
    PERIOD_COMPARISON_PERIOD_COMPARISON_TEST_TS,
  ],
  ["src/components/period-comparison/render.ts", PERIOD_COMPARISON_RENDER_TS],
  [
    "src/components/report-actions/report-actions.html",
    REPORT_ACTIONS_REPORT_ACTIONS_HTML,
  ],
  [
    "src/components/report-actions/report-actions.test.ts",
    REPORT_ACTIONS_REPORT_ACTIONS_TEST_TS,
  ],
  ["src/components/report-charts/render.ts", REPORT_CHARTS_RENDER_TS],
  [
    "src/components/report-charts/report-charts.html",
    REPORT_CHARTS_REPORT_CHARTS_HTML,
  ],
  [
    "src/components/report-charts/report-charts.test.ts",
    REPORT_CHARTS_REPORT_CHARTS_TEST_TS,
  ],
  ["src/components/report-list/render.ts", REPORT_LIST_RENDER_TS],
  ["src/components/report-list/report-list.html", REPORT_LIST_REPORT_LIST_HTML],
  [
    "src/components/report-list/report-list.test.ts",
    REPORT_LIST_REPORT_LIST_TEST_TS,
  ],
  ["src/components/report-masthead/render.ts", REPORT_MASTHEAD_RENDER_TS],
  [
    "src/components/report-masthead/report-masthead.html",
    REPORT_MASTHEAD_REPORT_MASTHEAD_HTML,
  ],
  [
    "src/components/report-masthead/report-masthead.test.ts",
    REPORT_MASTHEAD_REPORT_MASTHEAD_TEST_TS,
  ],
  ["src/components/report-notes/render.ts", REPORT_NOTES_RENDER_TS],
  [
    "src/components/report-notes/report-notes.html",
    REPORT_NOTES_REPORT_NOTES_HTML,
  ],
  [
    "src/components/report-notes/report-notes.test.ts",
    REPORT_NOTES_REPORT_NOTES_TEST_TS,
  ],
  ["src/components/report-pager/render.ts", REPORT_PAGER_RENDER_TS],
  [
    "src/components/report-pager/report-pager.html",
    REPORT_PAGER_REPORT_PAGER_HTML,
  ],
  [
    "src/components/report-pager/report-pager.test.ts",
    REPORT_PAGER_REPORT_PAGER_TEST_TS,
  ],
  ["src/components/report-summary/render.ts", REPORT_SUMMARY_RENDER_TS],
  [
    "src/components/report-summary/report-summary.html",
    REPORT_SUMMARY_REPORT_SUMMARY_HTML,
  ],
  [
    "src/components/report-summary/report-summary.test.ts",
    REPORT_SUMMARY_REPORT_SUMMARY_TEST_TS,
  ],
  ["src/components/report-tables/render.ts", REPORT_TABLES_RENDER_TS],
  [
    "src/components/report-tables/report-tables.html",
    REPORT_TABLES_REPORT_TABLES_HTML,
  ],
  [
    "src/components/report-tables/report-tables.test.ts",
    REPORT_TABLES_REPORT_TABLES_TEST_TS,
  ],
  ["src/components/site-footer/site-footer.html", SITE_FOOTER_SITE_FOOTER_HTML],
  [
    "src/components/site-footer/site-footer.test.ts",
    SITE_FOOTER_SITE_FOOTER_TEST_TS,
  ],
  ["src/components/site-header/site-header.html", SITE_HEADER_SITE_HEADER_HTML],
  [
    "src/components/site-header/site-header.test.ts",
    SITE_HEADER_SITE_HEADER_TEST_TS,
  ],
  ["src/components/site-meta/site-meta.test.ts", SITE_META_SITE_META_TEST_TS],
];
