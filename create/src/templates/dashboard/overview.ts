/**
 * The components of the dashboard template's overview page: the stat tiles,
 * the live tile (the one part rendered per request), the two SVG charts in
 * their shared figure, the recent orders, and the status badge every table
 * uses.
 *
 * Each entry is one file of the generated project, as it is written: its
 * path from the project root, then its content.
 */

import type { TemplateFile } from "../../scaffold.js";

export const OVERVIEW_FILES: TemplateFile[] = [
  [
    "src/components/stat-tile/stat-tile.html",
    `<!-- @bascik
One figure: its name, its value, and how it changed. The change is written in words; the arrow and color only repeat its direction.
@prop label - What the figure measures.
@prop value - The figure, already formatted.
@prop change - The change in words, such as "Up 4.2% from the previous 30 days".
@prop trend - "up", "down" or "flat": picks the arrow and color.
-->
<style>
  .tile {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    background: var(--color-surface) var(--surface-panel);
    box-shadow: var(--surface-sheen), 0 16px 36px -24px light-dark(rgb(36 53 89 / 32%), rgb(0 0 0 / 45%));
  }

  .label {
    color: var(--color-muted);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .value {
    font-size: 1.75rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }

  .change {
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .tile[data-trend="up"] .change {
    color: var(--color-up);
  }

  .tile[data-trend="down"] .change {
    color: var(--color-down);
  }

  .tile[data-trend="up"] .arrow::before {
    content: "▲ ";
  }

  .tile[data-trend="down"] .arrow::before {
    content: "▼ ";
  }
</style>
<article
  class="tile"
  data-bascik-attr-data-trend="trend"
  data-testid="stat-tile"
>
  <h3 class="label" data-bascik-prop-label>Figure</h3>
  <p class="value" data-bascik-prop-value>0</p>
  <p class="change">
    <span class="arrow" aria-hidden="true"></span
    ><span data-bascik-prop-change>No change</span>
  </p>
</article>
`,
  ],

  [
    "src/components/stat-tile/stat-tile.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/stat-tile/stat-tile.html"),
    "utf8",
  );

describe("stat-tile component", () => {
  it("takes its label, value and change as props, and its trend as a data attribute", async () => {
    const html = await source();
    expect(html).toContain("data-bascik-prop-label");
    expect(html).toContain("data-bascik-prop-value");
    expect(html).toContain("data-bascik-prop-change");
    expect(html).toContain('data-bascik-attr-data-trend="trend"');
    expect(html).toContain('data-testid="stat-tile"');
  });

  it("shows the direction with an arrow as well as a color, and hides the arrow from screen readers", async () => {
    const html = await source();
    expect(html).toContain('.tile[data-trend="up"] .arrow::before');
    expect(html).toContain('.tile[data-trend="down"] .arrow::before');
    expect(html).toContain('<span class="arrow" aria-hidden="true">');
  });
});
`,
  ],

  [
    "src/components/key-figures/key-figures.html",
    `<!-- @bascik
The overview's stat tiles: revenue, orders, average order value and units sold for the reporting period, each compared with the period before. Built once, at build time.
-->
<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
    gap: var(--space-3);
  }
</style>
<section aria-labelledby="heading" data-testid="key-figures">
  <h2 id="heading" class="visually-hidden">Key figures</h2>
  <div class="tiles">
    <script data-bascik-build-once type="text/typescript">
      import { figureTiles } from "./figures.ts";
      export default () => figureTiles();
    </script>
  </div>
</section>
`,
  ],

  [
    "src/components/key-figures/figures.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";
import {
  changeFrom,
  currentOrders,
  formatMoney,
  previousOrders,
  revenueOf,
  unitsOf,
  type Change,
  type Order,
} from "../../lib/shop.ts";

export interface Figure {
  label: string;
  value: string;
  change: Change;
}

const average = (orders: readonly Order[]): number =>
  orders.length === 0 ? 0 : Math.round(revenueOf(orders) / orders.length);

/** The figures for one period, each compared with the period before it. */
export function keyFigures(
  current: readonly Order[] = currentOrders(),
  previous: readonly Order[] = previousOrders(),
): Figure[] {
  return [
    {
      label: "Revenue",
      value: formatMoney(revenueOf(current)),
      change: changeFrom(revenueOf(current), revenueOf(previous)),
    },
    {
      label: "Orders",
      value: String(current.length),
      change: changeFrom(current.length, previous.length),
    },
    {
      label: "Average order value",
      value: formatMoney(average(current)),
      change: changeFrom(average(current), average(previous)),
    },
    {
      label: "Units sold",
      value: String(unitsOf(current)),
      change: changeFrom(unitsOf(current), unitsOf(previous)),
    },
  ];
}

/** One <stat-tile> per figure. Bascik renders each tag into the component. */
export const figureTiles = (figures: Figure[] = keyFigures()): SafeHtml =>
  html\`\${figures.map(
    (figure) =>
      html\`<stat-tile
        data-bascik-prop-label="\${figure.label}"
        data-bascik-prop-value="\${figure.value}"
        data-bascik-prop-change="\${figure.change.text}"
        data-bascik-prop-trend="\${figure.change.direction}"
      ></stat-tile>\`,
  )}\`;
`,
  ],

  [
    "src/components/key-figures/key-figures.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORDERS } from "../../lib/shop.ts";
import { figureTiles, keyFigures } from "./figures.ts";

describe("key-figures component", () => {
  it("is a labeled section whose tiles are built once, at build time", async () => {
    const html = await readFile(
      join(process.cwd(), "src/components/key-figures/key-figures.html"),
      "utf8",
    );
    expect(html).toMatch(/<section[^>]*aria-labelledby="heading"/);
    expect(html).toContain("<script data-bascik-build-once");
    expect(html).toContain("figureTiles()");
  });
});

describe("keyFigures", () => {
  it("gives revenue, orders, average order value and units sold, each with a change in words", () => {
    const figures = keyFigures();
    expect(figures.map((figure) => figure.label)).toEqual([
      "Revenue",
      "Orders",
      "Average order value",
      "Units sold",
    ]);
    for (const figure of figures) {
      expect(figure.value).not.toMatch(/NaN|Infinity|undefined/);
      expect(figure.change.text).toMatch(/^(Up|Down|No change)/);
    }
  });

  it("misuse: with no orders at all every figure is zero and nothing is NaN", () => {
    const figures = keyFigures([], []);
    expect(figures.map((figure) => figure.value)).toEqual([
      "$0.00",
      "0",
      "$0.00",
      "0",
    ]);
    for (const figure of figures) {
      expect(figure.change.direction).toBe("flat");
      expect(figure.change.text).not.toMatch(/NaN|Infinity/);
    }
  });

  it("says a figure is up from zero when the period before had no orders", () => {
    const [revenue] = keyFigures(ORDERS.slice(0, 5), []);
    expect(revenue.change).toEqual({
      direction: "up",
      text: "Up from zero in the previous 30 days",
    });
  });
});

describe("figureTiles", () => {
  it("prints one <stat-tile> per figure, with the direction as its trend", () => {
    const markup = String(figureTiles());
    expect(markup.match(/<stat-tile\\b/g)).toHaveLength(4);
    expect(markup).toContain('data-bascik-prop-label="Revenue"');
    expect(markup).toMatch(/data-bascik-prop-trend="(up|down|flat)"/);
  });

  it("escapes a figure that holds markup", () => {
    const markup = String(
      figureTiles([
        {
          label: '"><script>alert(1)</script>',
          value: "1",
          change: { direction: "flat", text: "No change" },
        },
      ]),
    );
    expect(markup).not.toContain("<script>");
    expect(markup.match(/<stat-tile\\b/g)).toHaveLength(1);
  });
});
`,
  ],

  [
    "src/components/live-orders/live-orders.html",
    `<!-- @bascik
The one part of the dashboard rendered per request. The build prints a snapshot tile. Where a server answers (bascik --server, the dev server, or a Cloudflare or Netlify adapter), the stream script below sends a live tile after the rest of the page, and the CSS hides the snapshot. On a static host the stream script never runs, so the snapshot stays.
-->
<style>
  .live {
    display: grid;
    gap: var(--space-2);
  }

  .note {
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  /* The live tile carries data-live. When it has arrived, the snapshot gives way to it. */
  .panel:has([data-live]) .snapshot {
    display: none;
  }
</style>
<section class="live" aria-labelledby="heading" data-testid="live-orders">
  <h2 id="heading">Open orders</h2>
  <div class="panel">
    <div class="snapshot" data-testid="live-orders-snapshot">
      <script data-bascik-build-once type="text/typescript">
        import { snapshotTile } from "./live.ts";
        export default () => snapshotTile();
      </script>
    </div>
    <script data-bascik-stream type="text/typescript">
      import { liveReading, liveTile, pause } from "./live.ts";

      // Runs on every request, after the page above it has been sent.
      // No authentication: a real dashboard checks the session cookie in
      // \`request\` here, before it reads or returns anything.
      export default async (
        _request: Request,
        _context: unknown,
        { signal }: { signal: AbortSignal },
      ) => {
        // Stands in for a slow query. The snapshot is on screen meanwhile.
        await pause(300, signal);
        return liveTile(liveReading(new Date()));
      };
    </script>
  </div>
  <p class="note">
    Simulated. The rest of this page is built once; this tile is rendered per
    request where a server answers, and stays a build-time snapshot on a static
    host.
  </p>
</section>
`,
  ],

  [
    "src/components/live-orders/live.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";
import {
  formatDate,
  openOrders,
  seededRandom,
  PERIOD_END,
} from "../../lib/shop.ts";

/** The tile the build prints: the open orders in the demo data, as of its last day. */
export const snapshotTile = (): SafeHtml =>
  html\`<stat-tile
    data-bascik-prop-label="Open orders"
    data-bascik-prop-value="\${openOrders().length}"
    data-bascik-prop-change="Build-time snapshot from \${formatDate(PERIOD_END)}"
    data-bascik-prop-trend="flat"
  ></stat-tile>\`;

export interface LiveReading {
  open: number;
  /** The time the reading was taken, as HH:MM:SS in UTC. */
  time: string;
}

/**
 * The open orders "right now". This starter has no database, so the number is
 * simulated: it starts from the demo data and drifts with the minute of
 * \`now\`, the same for every request in that minute. Replace the body with a
 * query to your order system and keep the shape.
 */
export function liveReading(now: Date): LiveReading {
  const minute = Math.floor(now.getTime() / 60_000);
  const drift = Number.isFinite(minute)
    ? Math.floor(seededRandom(minute)() * 5)
    : 0;
  return {
    open: openOrders().length + drift,
    time: Number.isFinite(minute) ? now.toISOString().slice(11, 19) : "unknown",
  };
}

/**
 * The tile a request gets. \`data-live\` lands on the tile's root element, and
 * <live-orders> hides the build-time snapshot when it is there.
 */
export const liveTile = (reading: LiveReading): SafeHtml =>
  html\`<stat-tile
    data-live="true"
    data-testid="live-orders-reading"
    data-bascik-prop-label="Open orders right now"
    data-bascik-prop-value="\${reading.open}"
    data-bascik-prop-change="Live: rendered for this request at \${reading.time} UTC"
    data-bascik-prop-trend="flat"
  ></stat-tile>\`;

/** Waits like a slow order system would, and stops waiting when the request is abandoned. */
export const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
`,
  ],

  [
    "src/components/live-orders/live-orders.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openOrders } from "../../lib/shop.ts";
import { liveReading, liveTile, pause, snapshotTile } from "./live.ts";

describe("live-orders component", () => {
  const source = (): Promise<string> =>
    readFile(
      join(process.cwd(), "src/components/live-orders/live-orders.html"),
      "utf8",
    );

  it("prints a snapshot at build time and streams the live tile per request", async () => {
    const html = await source();
    expect(html).toContain("<script data-bascik-build-once");
    expect(html).toContain("snapshotTile()");
    expect(html).toContain("<script data-bascik-stream");
    expect(html).toContain("liveTile(liveReading(new Date()))");
  });

  it("puts the snapshot before the stream script, so it is on screen first and stays on a static host", async () => {
    const html = await source();
    expect(html.indexOf("data-bascik-build-once")).toBeLessThan(
      html.indexOf("data-bascik-stream"),
    );
    expect(html).toContain(".panel:has([data-live]) .snapshot");
  });
});

describe("snapshotTile", () => {
  it("is a tile labeled as a build-time snapshot, with no live marker", () => {
    const markup = String(snapshotTile());
    expect(markup).toContain(\`data-bascik-prop-value="\${openOrders().length}"\`);
    expect(markup).toContain("Build-time snapshot from Oct 31, 2026");
    expect(markup).not.toContain("data-live");
  });
});

describe("liveReading", () => {
  it("gives the same reading for the same minute, with the time of the request", () => {
    const now = new Date("2026-11-02T09:15:42Z");
    expect(liveReading(now)).toEqual(liveReading(new Date(now)));
    expect(liveReading(now).time).toBe("09:15:42");
    expect(liveReading(now).open).toBeGreaterThanOrEqual(openOrders().length);
  });

  it("misuse: a date that is not a date gives a reading with no NaN in it", () => {
    const reading = liveReading(new Date("not a date"));
    expect(reading).toEqual({ open: openOrders().length, time: "unknown" });
  });
});

describe("liveTile", () => {
  it("is a tile marked data-live, which hides the snapshot, and says it was rendered for this request", () => {
    const markup = String(liveTile({ open: 12, time: "09:15:42" }));
    expect(markup).toContain('data-live="true"');
    expect(markup).toContain('data-bascik-prop-value="12"');
    expect(markup).toContain("rendered for this request at 09:15:42 UTC");
  });

  it("escapes a reading that holds markup", () => {
    const markup = String(liveTile({ open: 1, time: '"><b>now</b>' }));
    expect(markup).not.toContain("<b>");
  });
});

describe("pause", () => {
  it("stops waiting when the request is abandoned", async () => {
    const abandoned = new AbortController();
    const waiting = pause(60_000, abandoned.signal);
    abandoned.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});
`,
  ],

  [
    "src/components/chart-figure/chart-figure.html",
    `<!-- @bascik
A chart with its caption and the same numbers as a table: the frame every chart on the site sits in. The chart is drawn by src/lib/charts.ts and passed in.
@prop caption - What the chart shows, in a sentence.
@slot default - The chart: the <svg> from lineChart() or barChart().
@slot table - The same data as a <table>, from chartTable().
-->
<style>
  .figure {
    display: grid;
    gap: var(--space-2);
    margin: 0;
  }

  /* A wide chart keeps a readable size and scrolls sideways on a narrow screen. */
  .chart {
    overflow-x: auto;
  }

  .caption {
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .toggle {
    cursor: pointer;
  }
</style>
<figure class="figure" data-testid="chart-figure">
  <div class="chart"><div data-bascik-slot></div></div>
  <figcaption class="caption" data-bascik-prop-caption></figcaption>
  <details data-testid="chart-figure-data">
    <summary class="toggle" data-testid="chart-figure-data-toggle">
      Show the data as a table
    </summary>
    <div class="table-scroll"><div data-bascik-slot="table"></div></div>
  </details>
</figure>
`,
  ],

  [
    "src/components/chart-figure/chart-figure.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/chart-figure/chart-figure.html"),
    "utf8",
  );

describe("chart-figure component", () => {
  it("is a <figure> with a caption prop, a slot for the chart, and a slot for the table", async () => {
    const html = await source();
    expect(html).toMatch(/<figure[^>]*data-testid="chart-figure"/);
    expect(html).toMatch(/<figcaption[^>]*data-bascik-prop-caption/);
    expect(html).toContain("<div data-bascik-slot></div>");
    expect(html).toContain('<div data-bascik-slot="table"></div>');
  });

  it("offers the data as a table in a <details>, with no script", async () => {
    const html = await source();
    expect(html).toContain('<details data-testid="chart-figure-data">');
    expect(html).toContain('data-testid="chart-figure-data-toggle"');
    expect(html).not.toContain("<script");
  });
});
`,
  ],

  [
    "src/components/revenue-chart/revenue-chart.html",
    `<!-- @bascik
Revenue per day for the reporting period, as a line chart drawn in SVG at build time, with the same numbers in a table. No chart library and no client script.
-->
<section class="card" aria-labelledby="heading" data-testid="revenue-chart">
  <h2 id="heading">Revenue</h2>
  <chart-figure
    data-bascik-prop-caption="Revenue per day over the last 30 days, in US dollars. Refunded orders are left out."
  >
    <script data-bascik-build-once type="text/typescript">
      import { revenueChart } from "./revenue.ts";
      export default () => revenueChart();
    </script>
    <div data-bascik-slot="table">
      <script data-bascik-build-once type="text/typescript">
        import { revenueTable } from "./revenue.ts";
        export default () => revenueTable();
      </script>
    </div>
  </chart-figure>
</section>
`,
  ],

  [
    "src/components/revenue-chart/revenue.ts",
    `import type { SafeHtml } from "@bascik/bascik/html";
import { chartTable, lineChart, type ChartPoint } from "../../lib/charts.ts";
import {
  dailyRevenue,
  formatDate,
  formatMoney,
  formatShortDate,
  formatWholeMoney,
} from "../../lib/shop.ts";

type Day = { date: string; cents: number };

const points = (
  days: readonly Day[],
  label: (date: string) => string,
): ChartPoint[] =>
  days.map((day) => ({ label: label(day.date), value: day.cents }));

/** The line chart of revenue per day. */
export const revenueChart = (days: readonly Day[] = dailyRevenue()): SafeHtml =>
  lineChart(points(days, formatShortDate), {
    label:
      days.length === 0
        ? "Revenue per day"
        : \`Revenue per day from \${formatDate(days[0].date)} to \${formatDate(
            days[days.length - 1].date,
          )}. The table below has each day's figure.\`,
    format: formatWholeMoney,
    emptyText: "No revenue in this period yet.",
  });

/** The same days as a table. */
export const revenueTable = (days: readonly Day[] = dailyRevenue()): SafeHtml =>
  chartTable(points(days, formatDate), {
    caption: "Revenue per day",
    labelHeading: "Day",
    valueHeading: "Revenue",
    format: formatMoney,
  });
`,
  ],

  [
    "src/components/revenue-chart/revenue-chart.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { revenueChart, revenueTable } from "./revenue.ts";

describe("revenue-chart component", () => {
  it("puts the chart and its table in a <chart-figure>, both built once at build time", async () => {
    const html = await readFile(
      join(process.cwd(), "src/components/revenue-chart/revenue-chart.html"),
      "utf8",
    );
    expect(html).toContain("<chart-figure");
    expect(html).toContain("data-bascik-prop-caption=");
    expect(html).toContain('<div data-bascik-slot="table">');
    expect(html.match(/<script data-bascik-build-once/g)).toHaveLength(2);
    expect(html).toContain('<h2 id="heading">Revenue</h2>');
  });
});

describe("revenueChart", () => {
  it("draws the period as one SVG line chart, labeled with its dates", () => {
    const markup = String(revenueChart());
    expect(markup).toMatch(/^<svg\\b[^>]*viewBox=/);
    expect(markup).toContain("<polyline");
    expect(markup).toContain("from Oct 2, 2026 to Oct 31, 2026");
    expect(markup).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("misuse: with no days it says there is no revenue yet", () => {
    const markup = String(revenueChart([]));
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("No revenue in this period yet.");
  });
});

describe("revenueTable", () => {
  it("has one row per day, in dollars", () => {
    const markup = String(
      revenueTable([
        { date: "2026-10-30", cents: 12345 },
        { date: "2026-10-31", cents: 0 },
      ]),
    );
    expect(markup.match(/scope="row"/g)).toHaveLength(2);
    expect(markup).toContain("Oct 30, 2026");
    expect(markup).toContain("$123.45");
    expect(markup).toContain("$0.00");
  });
});
`,
  ],

  [
    "src/components/top-titles/top-titles.html",
    `<!-- @bascik
The best-selling titles of the reporting period, as a bar chart drawn in SVG at build time, with the same numbers in a table that links to each title.
-->
<section class="card" aria-labelledby="heading" data-testid="top-titles">
  <h2 id="heading">Top titles</h2>
  <chart-figure
    data-bascik-prop-caption="Units sold per title over the last 30 days."
  >
    <script data-bascik-build-once type="text/typescript">
      import { topTitlesChart } from "./top.ts";
      export default () => topTitlesChart();
    </script>
    <div data-bascik-slot="table">
      <script data-bascik-build-once type="text/typescript">
        import { topTitlesTable } from "./top.ts";
        export default () => topTitlesTable();
      </script>
    </div>
  </chart-figure>
</section>
`,
  ],

  [
    "src/components/top-titles/top.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";
import { barChart } from "../../lib/charts.ts";
import { topTitles, type Title } from "../../lib/shop.ts";

type Entry = { title: Title; units: number };

const copies = (units: number): string =>
  \`\${units} \${units === 1 ? "copy" : "copies"}\`;

/** The bar chart of the best-selling titles. */
export const topTitlesChart = (
  entries: readonly Entry[] = topTitles(),
): SafeHtml =>
  barChart(
    entries.map((entry) => ({ label: entry.title.title, value: entry.units })),
    {
      label: \`The \${entries.length} best-selling titles by units sold. The table below has each figure.\`,
      format: copies,
      emptyText: "Nothing sold in this period yet.",
    },
  );

/** The same titles as a table, with the author and a link to each title's page. */
export const topTitlesTable = (
  entries: readonly Entry[] = topTitles(),
): SafeHtml =>
  html\`<table class="data-table">
    <caption>
      Units sold per title
    </caption>
    <thead>
      <tr>
        <th scope="col">Title</th>
        <th scope="col">Author</th>
        <th scope="col" class="number">Units sold</th>
      </tr>
    </thead>
    <tbody>
      \${
        entries.length === 0
          ? html\`<tr class="empty-row">
              <td colspan="3">Nothing sold in this period yet.</td>
            </tr>\`
          : entries.map(
              (entry) =>
                html\`<tr>
                  <td>
                    <a href="/titles/\${entry.title.slug}"
                      >\${entry.title.title}</a
                    >
                  </td>
                  <td>\${entry.title.author}</td>
                  <td class="number">\${entry.units}</td>
                </tr>\`,
            )
      }
    </tbody>
  </table>\`;
`,
  ],

  [
    "src/components/top-titles/top-titles.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TITLES } from "../../lib/shop.ts";
import { topTitlesChart, topTitlesTable } from "./top.ts";

const entries = [
  { title: TITLES[0], units: 12 },
  { title: TITLES[1], units: 1 },
];

describe("top-titles component", () => {
  it("puts the chart and its table in a <chart-figure>, both built once at build time", async () => {
    const html = await readFile(
      join(process.cwd(), "src/components/top-titles/top-titles.html"),
      "utf8",
    );
    expect(html).toContain("<chart-figure");
    expect(html).toContain('<div data-bascik-slot="table">');
    expect(html.match(/<script data-bascik-build-once/g)).toHaveLength(2);
    expect(html).toContain('<h2 id="heading">Top titles</h2>');
  });
});

describe("topTitlesChart", () => {
  it("draws one bar per title, with the title and the number of copies as text", () => {
    const markup = String(topTitlesChart(entries));
    expect(markup.match(/class="chart-bar"/g)).toHaveLength(2);
    expect(markup).toContain(TITLES[0].title);
    expect(markup).toContain("12 copies");
    expect(markup).toContain("1 copy");
  });

  it("misuse: with nothing sold it says so", () => {
    const markup = String(topTitlesChart([]));
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("Nothing sold in this period yet.");
  });
});

describe("topTitlesTable", () => {
  it("links each title to its page and names its author", () => {
    const markup = String(topTitlesTable(entries));
    expect(markup).toContain(\`href="/titles/\${TITLES[0].slug}"\`);
    expect(markup).toContain(TITLES[0].author);
    expect(markup.match(/scope="col"/g)).toHaveLength(3);
  });

  it("misuse: with nothing sold it keeps its headings and says so in one row", () => {
    const markup = String(topTitlesTable([]));
    expect(markup).toContain("<thead>");
    expect(markup).toContain('colspan="3"');
  });
});
`,
  ],

  [
    "src/components/recent-orders/recent-orders.html",
    `<!-- @bascik
The five newest orders, in a table built at build time, with a link to the orders page.
-->
<section class="card" aria-labelledby="heading" data-testid="recent-orders">
  <h2 id="heading">Recent orders</h2>
  <div class="table-scroll">
    <script data-bascik-build-once type="text/typescript">
      import { orderTable } from "@/lib/order-table.ts";
      import { ORDERS } from "@/lib/shop.ts";
      export default () =>
        orderTable(ORDERS.slice(0, 5), { caption: "The five newest orders" });
    </script>
  </div>
  <p><a href="/orders">All orders</a></p>
</section>
`,
  ],

  [
    "src/components/recent-orders/recent-orders.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/recent-orders/recent-orders.html"),
    "utf8",
  );

describe("recent-orders component", () => {
  it("builds its table once, at build time, from the five newest orders", async () => {
    const html = await source();
    expect(html).toContain("<script data-bascik-build-once");
    expect(html).toContain("orderTable(ORDERS.slice(0, 5)");
    expect(html).toContain('href="/orders"');
  });

  it("is a labeled section whose table scrolls inside its own box", async () => {
    const html = await source();
    expect(html).toMatch(/<section[^>]*aria-labelledby="heading"/);
    expect(html).toContain('<h2 id="heading">Recent orders</h2>');
    expect(html).toContain('<div class="table-scroll">');
  });
});
`,
  ],

  [
    "src/components/status-badge/status-badge.html",
    `<!-- @bascik
A status as a small label: an order's (Paid, Processing, Shipped, Refunded) or a title's stock (In stock, Low stock, Preorder). The status is always written as text; the mark and color only repeat it.
@prop status - The status to show.
-->
<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
    padding: 0.1em 0.6em;
    border: 1px solid currentColor;
    border-radius: 999px;
    color: var(--color-muted);
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }

  /* Each status has its own mark, so two statuses differ without color. */
  .badge::before {
    content: "○";
  }

  .badge[data-status="Processing"]::before {
    content: "◐";
  }

  .badge[data-status="Shipped"],
  .badge[data-status="In stock"] {
    color: var(--color-up);
  }

  .badge[data-status="Shipped"]::before,
  .badge[data-status="In stock"]::before {
    content: "●";
  }

  .badge[data-status="Paid"] {
    color: var(--color-accent);
  }

  .badge[data-status="Refunded"] {
    color: var(--color-down);
  }

  .badge[data-status="Refunded"]::before {
    content: "↩";
  }

  .badge[data-status="Low stock"] {
    color: var(--color-warn);
  }

  .badge[data-status="Low stock"]::before {
    content: "▲";
  }
</style>
<span
  class="badge"
  data-bascik-attr-data-status="status"
  data-bascik-prop-status
  data-testid="status-badge"
  >Unknown</span
>
`,
  ],

  [
    "src/components/status-badge/status-badge.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/status-badge/status-badge.html"),
    "utf8",
  );

describe("status-badge component", () => {
  it("writes the status as text and repeats it in a data attribute for its styles", async () => {
    const html = await source();
    expect(html).toContain("data-bascik-prop-status");
    expect(html).toContain('data-bascik-attr-data-status="status"');
    expect(html).toContain('data-testid="status-badge"');
  });

  it("gives every status the site uses a mark of its own", async () => {
    const html = await source();
    for (const status of ["Processing", "Shipped", "Refunded", "Low stock"])
      expect(html).toContain(\`.badge[data-status="\${status}"]::before\`);
  });
});
`,
  ],
];
