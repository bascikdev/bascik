/**
 * @module templates/reports/lib
 *
 * The shared modules of the `reports` template's site, with their tests: the data loader and its checks, the number
 * and period formats, the SVG charts, the tables, the CSV writer and the head tags. `src/lib/site.ts` is not here:
 * it carries the site name, so `reports.ts` writes it.
 */

import type { TemplateFile } from "../../scaffold.js";

/** `src/lib/charts.test.ts` */
const CHARTS_TEST_TS = `import { html } from "@bascik/bascik/html";
import { describe, expect, it } from "vitest";
import {
  barChart,
  chartFigure,
  columnChart,
  periodColumns,
  type ChartItem,
} from "./charts.ts";
import { AWKWARD, flat } from "./testing.ts";

const item = (label: string, value: number): ChartItem => ({
  label,
  value,
  valueLabel: Number.isFinite(value) ? \`$\${value}\` : "?",
});
const bars = (svg: string): number => svg.split("<path").length - 1;
const sound = (svg: string): void => {
  expect(svg).not.toMatch(/NaN|Infinity|undefined/);
  expect(svg).toMatch(/^<svg[^>]+viewBox="0 0 640 \\d+"/);
  expect(svg.trim()).toMatch(/<\\/svg>$/);
};

describe.each([
  ["barChart", barChart],
  ["columnChart", columnChart],
])("%s", (_name, chart) => {
  it("draws one bar per item, with its label and its value as text", () => {
    const svg = flat(
      chart("Revenue by format", [item("Vintage", 300), item("GT3", 100)]),
    );
    sound(svg);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Revenue by format"');
    expect(bars(svg)).toBe(2);
    for (const text of ["Vintage", "GT3", "$300", "$100"])
      expect(svg).toContain(\`>\${text}</text>\`);
    expect(svg).toContain("<title>Vintage: $300</title>");
  });

  it("draws a single item", () => {
    const svg = flat(chart("One", [item("Only", 5)]));
    sound(svg);
    expect(bars(svg)).toBe(1);
  });

  it("draws labels and values but no bars when every value is zero", () => {
    const svg = flat(chart("Zero", [item("A", 0), item("B", 0)]));
    sound(svg);
    expect(bars(svg)).toBe(0);
    expect(svg).toContain(">A</text>");
    expect(svg.split(">$0</text>")).toHaveLength(3);
  });

  it('says "No data" for no items', () => {
    const svg = flat(chart("Nothing", []));
    sound(svg);
    expect(svg).toContain('aria-label="Nothing: no data"');
    expect(svg).toContain(">No data</text>");
  });

  it("misuse: treats a value that is not a positive number as zero", () => {
    const svg = flat(
      chart("Odd", [
        item("a", Number.NaN),
        item("b", -5),
        item("c", Infinity),
        item("d", 10),
      ]),
    );
    sound(svg);
    expect(bars(svg)).toBe(1);
  });

  it("escapes labels in SVG text, the tooltip and the name", () => {
    const svg = flat(
      chart(AWKWARD, [{ label: "<i>&", value: 1, valueLabel: '"$&"' }]),
    );
    sound(svg);
    expect(svg).toContain("&lt;i&gt;&amp;</text>");
    expect(svg).toContain("&quot;$&amp;&quot;</text>");
    expect(svg).toContain(
      'aria-label="Porsche &lt;b&gt;&amp; 963, $&amp; &#39;n&#39; more"',
    );
    expect(svg).not.toContain("<i>");
  });
});

describe("barChart", () => {
  it("cuts a long label and keeps the whole of it in the tooltip", () => {
    const label = "Porsche 963 and Other Places";
    const svg = flat(barChart("Long", [item(label, 1)]));
    expect(svg).toContain(">A Field Guide to Qu…</text>");
    expect(svg).toContain(\`<title>\${label}: $1</title>\`);
  });
});

describe("columnChart", () => {
  it("draws the current column at full strength and the others lighter", () => {
    const svg = flat(
      columnChart(
        "Trend",
        periodColumns(
          [
            { period: "2026-07", revenueCents: 100 },
            { period: "2026-08", revenueCents: 200 },
          ],
          true,
        ),
      ),
    );
    expect(svg).toContain('class="chart-bar chart-bar-muted"');
    expect(svg).toContain('class="chart-bar"');
    expect(svg).toContain(">Aug</text>");
    expect(svg).toContain(">2026</text>");
    expect(svg).toContain("<title>Aug 2026: $2.00</title>");
  });

  it("writes a value on every column while they are few, then only on the current one", () => {
    const periods = Array.from({ length: 12 }, (_, index) => ({
      period: \`2026-\${flat(index + 1).padStart(2, "0")}\`,
      revenueCents: (index + 1) * 100,
    }));
    const values = (svg: string): number =>
      svg.split('class="chart-value"').length - 1;
    expect(
      values(flat(columnChart("Few", periodColumns(periods.slice(0, 6))))),
    ).toBe(6);
    expect(
      values(flat(columnChart("Many", periodColumns(periods, true)))),
    ).toBe(1);
    expect(values(flat(columnChart("Many", periodColumns(periods))))).toBe(0);
  });
});

describe("chartFigure", () => {
  it("puts the caption, the chart and its table in one figure", () => {
    const figure = flat(
      chartFigure(AWKWARD, barChart("x", []), html\`<table></table>\`),
    );
    expect(figure).toMatch(
      /^<chart-explorer>\\s*<figcaption>Porsche &lt;b&gt;&amp;/,
    );
    expect(figure).toMatch(/<\\/svg>\\s*<table><\\/table>\\s*<\\/chart-explorer>$/);
  });
});
`;

/** `src/lib/charts.ts` */
const CHARTS_TS = `// src/lib/charts.ts: charts drawn as inline SVG at build time, enhanced by chart-explorer without a chart library.
//
// Each chart has one series, so there is no legend: the figure's caption names it, every bar carries its value as
// text, and the table beside it has the same figures. Colors come from the classes in src/pages/css/styles.css,
// which also has the print version (dark bars on white, readable without color).
import { html, type SafeHtml } from "@bascik/bascik/html";
import { money, shortPeriodLabel } from "./format.ts";

export interface ChartItem {
  /** Matches the table's row label, or a period's datetime. */
  key?: string;
  label: string;
  /** A second line under the label of a column, such as the year. */
  sublabel?: string;
  value: number;
  /** The value as the reader should see it, such as "$1,234.50". */
  valueLabel: string;
  /** Draw this one at full strength and the others lighter, such as the period a report is about. */
  current?: boolean;
}

const WIDTH = 640;
/** The radius of a bar's rounded end. */
const RADIUS = 7;
/** Labels longer than this are cut, with the whole label in the bar's tooltip. */
const LABEL_LENGTH = 20;

const round = (value: number): number => Math.round(value * 100) / 100;

/** A value a bar can be drawn from: anything that is not a positive number counts as zero. */
const drawable = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0;

/** The largest value, or 0 for an empty or all-zero chart, where every bar has no length. */
const largest = (items: readonly ChartItem[]): number =>
  items.reduce((max, item) => Math.max(max, drawable(item.value)), 0);

const cut = (label: string): string =>
  label.length > LABEL_LENGTH ? \`\${label.slice(0, LABEL_LENGTH - 1)}…\` : label;

const barClass = (item: ChartItem, items: readonly ChartItem[]): string =>
  items.some((other) => other.current) && !item.current
    ? "chart-bar chart-bar-muted"
    : "chart-bar";

/** A bar from the baseline with its far end rounded. \`length\` runs right for a bar and up for a column. */
function barPath(
  x: number,
  y: number,
  length: number,
  thickness: number,
  direction: "right" | "up",
): string {
  const r = Math.min(RADIUS, length, thickness / 2);
  const [l, t, rr] = [round(length - r), round(thickness - 2 * r), round(r)];
  return direction === "right"
    ? \`M\${round(x)},\${round(y)}h\${l}a\${rr},\${rr} 0 0 1 \${rr},\${rr}v\${t}a\${rr},\${rr} 0 0 1 -\${rr},\${rr}h-\${l}z\`
    : \`M\${round(x)},\${round(y)}v-\${l}a\${rr},\${rr} 0 0 1 \${rr},-\${rr}h\${t}a\${rr},\${rr} 0 0 1 \${rr},\${rr}v\${l}z\`;
}

const emptyChart = (label: string): SafeHtml =>
  html\`<svg
    class="chart"
    viewBox="0 0 \${WIDTH} 64"
    role="img"
    aria-label="\${label}: no data"
  >
    <text class="chart-label" x="\${WIDTH / 2}" y="38" text-anchor="middle">
      No data
    </text>
  </svg>\`;

/** Horizontal bars, one row per item, for comparing named things such as formats or channels. */
export function barChart(label: string, items: readonly ChartItem[]): SafeHtml {
  if (items.length === 0) return emptyChart(label);
  const [labelWidth, valueWidth, row, thickness] = [150, 110, 44, 26];
  const plot = WIDTH - labelWidth - valueWidth;
  const max = largest(items);
  const height = items.length * row + 12;
  const rows = items.map((item, index) => {
    const length = max === 0 ? 0 : round((drawable(item.value) / max) * plot);
    const y = 6 + index * row + (row - thickness) / 2;
    const middle = round(y + thickness / 2 + 4.5);
    return html\`<g data-chart-key="\${item.key ?? item.label}">
      <title>\${item.label}: \${item.valueLabel}</title>
      <text
        class="chart-label"
        x="\${labelWidth - 10}"
        y="\${middle}"
        text-anchor="end"
        >\${cut(item.label)}</text
      >
      \${
        length > 0
          ? html\`<path
              class="\${barClass(item, items)}"
              d="\${barPath(labelWidth, y, length, thickness, "right")}"
            />\`
          : ""
      }
      <text
        class="chart-value"
        x="\${round(labelWidth + length + 8)}"
        y="\${middle}"
        >\${item.valueLabel}</text
      >
    </g>\`;
  });
  return html\`<svg
    class="chart"
    viewBox="0 0 \${WIDTH} \${height}"
    role="img"
    aria-label="\${label}"
  >
    \${rows}
    <line
      class="chart-axis"
      x1="\${labelWidth}"
      y1="4"
      x2="\${labelWidth}"
      y2="\${height - 4}"
    />
  </svg>\`;
}

/** Vertical columns in the order given, for a figure over time such as revenue per period. */
export function columnChart(
  label: string,
  items: readonly ChartItem[],
): SafeHtml {
  if (items.length === 0) return emptyChart(label);
  const [height, top, bottom, side] = [260, 30, 44, 16];
  const baseline = height - bottom;
  const slot = (WIDTH - 2 * side) / items.length;
  const thickness = Math.min(56, round(slot * 0.6));
  const max = largest(items);
  // A value on every column only while they are few; otherwise only on the current one. The table has them all.
  const labelAll = items.length <= 6;
  const columns = items.map((item, index) => {
    const length =
      max === 0 ? 0 : round((drawable(item.value) / max) * (baseline - top));
    const center = round(side + slot * index + slot / 2);
    const name = item.sublabel ? \`\${item.label} \${item.sublabel}\` : item.label;
    return html\`<g data-chart-key="\${item.key ?? name}">
      <title>\${name}: \${item.valueLabel}</title>
      \${
        length > 0
          ? html\`<path
              class="\${barClass(item, items)}"
              d="\${barPath(center - thickness / 2, baseline, length, thickness, "up")}"
            />\`
          : ""
      }
      \${
        labelAll || item.current
          ? html\`<text
              class="chart-value"
              x="\${center}"
              y="\${round(baseline - length - 8)}"
              text-anchor="middle"
              >\${item.valueLabel}</text
            >\`
          : ""
      }
      <text
        class="chart-label"
        x="\${center}"
        y="\${baseline + 18}"
        text-anchor="middle"
        >\${cut(item.label)}</text
      >
      <text
        class="chart-sublabel"
        x="\${center}"
        y="\${baseline + 34}"
        text-anchor="middle"
        >\${item.sublabel}</text
      >
    </g>\`;
  });
  return html\`<svg
    class="chart"
    viewBox="0 0 \${WIDTH} \${height}"
    role="img"
    aria-label="\${label}"
  >
    \${columns}
    <line
      class="chart-axis"
      x1="\${side}"
      y1="\${baseline}"
      x2="\${WIDTH - side}"
      y2="\${baseline}"
    />
  </svg>\`;
}

/**
 * One column per period for a revenue chart: the month over the year. With \`currentLast\`, the last period is the
 * one the page is about and the others are drawn lighter.
 */
export const periodColumns = (
  periods: readonly { period: string; revenueCents: number }[],
  currentLast = false,
): ChartItem[] =>
  periods.map(({ period, revenueCents }, index) => {
    const [month, year] = shortPeriodLabel(period).split(" ");
    return {
      key: period,
      label: month,
      sublabel: year,
      value: revenueCents,
      valueLabel: money(revenueCents),
      current: currentLast && index === periods.length - 1,
    };
  });

/** A chart with its caption and, under it, a table of the same figures for readers who cannot use the drawing. */
export const chartFigure = (
  caption: string,
  chart: SafeHtml,
  table: SafeHtml,
): SafeHtml =>
  html\`<chart-explorer>
    <figcaption>\${caption}</figcaption>
    \${chart}\${table}
  </chart-explorer>\`;
`;

/** `src/lib/csv.test.ts` */
const CSV_TEST_TS = `import { describe, expect, it } from "vitest";
import { csvField, csvPath, reportsCsv, toCsv } from "./csv.ts";
import { AWKWARD, report, sale, twoReports } from "./testing.ts";

describe("csvField", () => {
  it("leaves plain text and numbers as they are", () => {
    expect(csvField("Porsche 911 RSR")).toBe("Porsche 911 RSR");
    expect(csvField("Tom's <b> & co")).toBe("Tom's <b> & co");
    expect(csvField(12)).toBe("12");
    expect(csvField(0)).toBe("0");
  });

  it("quotes a field with a comma, a quote or a line break, doubling quotes", () => {
    expect(csvField("Porsche 935 Moby Dick")).toBe('"Porsche 935 Moby Dick"');
    expect(csvField('The "Big" One')).toBe('"The ""Big"" One"');
    expect(csvField("two\\nlines")).toBe('"two\\nlines"');
    expect(csvField("two\\r\\nlines")).toBe('"two\\r\\nlines"');
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\\t=1", "\\r=1"])(
    "keeps %j from running as a formula in a spreadsheet",
    (value) => {
      const field = csvField(value);
      expect(field.replace(/^"/, "")).toMatch(/^'/);
      expect(field).toContain(value);
    },
  );

  it("neutralizes and quotes one value that needs both", () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe(
      \`"'=HYPERLINK(""http://x"",""y"")"\`,
    );
  });

  it("leaves a sign that is not at the start alone", () => {
    expect(csvField("Anand-Holt")).toBe("Anand-Holt");
    expect(csvField("a=b")).toBe("a=b");
  });
});

describe("reportsCsv", () => {
  it("writes a header row, then one row per sale, with CRLF line endings", () => {
    expect(reportsCsv(twoReports())).toBe(
      [
        "period,title,author,format,channel,units,revenue",
        "2026-07,Porsche 911 RSR,Jordan Taylor,GTP,Sebring,10,170.00",
        "2026-08,Porsche 911 RSR,Jordan Taylor,GTP,Sebring,12,204.00",
        "2026-08,Porsche 962C,Hurley Haywood,LMDh,Daytona,3,59.97",
        "",
      ].join("\\r\\n"),
    );
  });

  it("writes only the header for no reports or an empty period", () => {
    const header = "period,title,author,format,channel,units,revenue\\r\\n";
    expect(reportsCsv([])).toBe(header);
    expect(reportsCsv([report("2026-07", [])])).toBe(header);
  });

  it("keeps an awkward title in one field", () => {
    const csv = reportsCsv([
      report("2026-07", [
        sale({ title: AWKWARD, author: "=cmd|' /C calc'!A0" }),
      ]),
    ]);
    expect(csv).toContain(
      \`2026-07,"Porsche <b>& 963, $& 'n' more",'=cmd|' /C calc'!A0,GTP\`,
    );
    expect(toCsv([[AWKWARD]])).toBe(\`"Porsche <b>& 963, $& 'n' more"\\r\\n\`);
  });
});

describe("csvPath", () => {
  it("names a period's file, or the file with every period", () => {
    expect(csvPath("2026-07")).toBe("/reports/2026-07.csv");
    expect(csvPath()).toBe("/reports/all.csv");
  });
});
`;

/** `src/lib/csv.ts` */
const CSV_TS = `// src/lib/csv.ts: the CSV files behind the download links. scripts/write-csv.ts writes them into the build output.
import { decimal } from "./format.ts";
import type { Report } from "./reports.ts";

export type CsvValue = string | number;

/**
 * One CSV field. Text that starts with =, +, - or @ (or a tab or carriage return) gets a leading apostrophe, so a
 * spreadsheet shows it as text and does not run it as a formula. A field with a comma, a quote or a line break is
 * quoted, with quotes doubled. Numbers are written as they are.
 */
export function csvField(value: CsvValue): string {
  if (typeof value === "number") return String(value);
  const text = /^[=+\\-@\\t\\r]/.test(value) ? \`'\${value}\` : value;
  return /[",\\r\\n]/.test(text) ? \`"\${text.replaceAll('"', '""')}"\` : text;
}

/** Rows as CSV text, with the line endings RFC 4180 asks for. */
export const toCsv = (rows: readonly (readonly CsvValue[])[]): string =>
  rows.map((row) => \`\${row.map(csvField).join(",")}\\r\\n\`).join("");

export const CSV_HEADER = [
  "period",
  "title",
  "author",
  "format",
  "channel",
  "units",
  "revenue",
] as const;

/** Every sale of the given reports, one row each, under a header row. Revenue is a decimal such as 1234.50. */
export const reportsCsv = (reports: readonly Report[]): string =>
  toCsv([
    CSV_HEADER,
    ...reports.flatMap((report) =>
      report.sales.map((sale) => [
        report.period,
        sale.title,
        sale.author,
        sale.format,
        sale.channel,
        sale.units,
        decimal(sale.revenueCents),
      ]),
    ),
  ]);

/** The site path of one period's CSV file, or of the file with every period. */
export const csvPath = (period: string = "all"): string =>
  \`/reports/\${period}.csv\`;
`;

/** `src/lib/figures.test.ts` */
const FIGURES_TEST_TS = `import { describe, expect, it } from "vitest";
import { figureList, headlineFigures } from "./figures.ts";
import { AWKWARD, flat, report, sale, twoReports } from "./testing.ts";

describe("headlineFigures", () => {
  it("gives revenue, units, titles and average price, each change in words", () => {
    const [july, august] = twoReports();
    expect(headlineFigures(august, july)).toEqual([
      { label: "Revenue", value: "$263.97", note: "Up 55.3% from July 2026" },
      { label: "Units sold", value: "15", note: "Up 50.0% from July 2026" },
      { label: "Titles sold", value: "2", note: "Up 100.0% from July 2026" },
      { label: "Average price per unit", value: "$17.60" },
    ]);
  });

  it("has no change to show for the first report", () => {
    const notes = headlineFigures(twoReports()[0], null).map(
      ({ note }) => note,
    );
    expect(notes).toEqual([
      "n/a: first report",
      "n/a: first report",
      "n/a: first report",
      undefined,
    ]);
  });

  it('says "New" after a period with no sales, and "Down 100.0%" for one', () => {
    const empty = report("2026-06", []);
    const [july] = twoReports();
    expect(headlineFigures(july, empty)[0].note).toBe(
      "New: nothing in June 2026",
    );
    const figures = headlineFigures(report("2026-08", []), july);
    expect(figures[0]).toEqual({
      label: "Revenue",
      value: "$0.00",
      note: "Down 100.0% from July 2026",
    });
    expect(figures[3].value).toBe("n/a");
    expect(JSON.stringify(figures)).not.toMatch(/NaN|Infinity/);
  });

  it("keeps two empty periods in a row free of NaN", () => {
    const figures = headlineFigures(
      report("2026-08", []),
      report("2026-07", []),
    );
    expect(figures.map(({ note }) => note).slice(0, 3)).toEqual(
      Array(3).fill("No change from July 2026"),
    );
    expect(JSON.stringify(figures)).not.toMatch(/NaN|Infinity/);
  });

  it("counts a zero-revenue sale without dividing by it", () => {
    const figures = headlineFigures(
      report("2026-08", [sale({ units: 0, revenueCents: 0 })]),
      null,
    );
    expect(figures.map(({ value }) => value)).toEqual([
      "$0.00",
      "0",
      "1",
      "n/a",
    ]);
  });
});

describe("figureList", () => {
  it("is a description list with the note only where there is one", () => {
    const list = flat(
      figureList([
        { label: "Revenue", value: "$1.00", note: "Up 5.0%" },
        { label: AWKWARD, value: "<3" },
      ]),
    );
    expect(list).toContain(
      '<dt>Revenue</dt><dd class="figure-value">$1.00</dd><dd class="figure-note">Up 5.0%</dd>',
    );
    expect(list).toContain('<dd class="figure-value">&lt;3</dd></div>');
    expect(list).toContain("<dt>Porsche &lt;b&gt;&amp;");
    expect(list.split("figure-note")).toHaveLength(2);
  });
});
`;

/** `src/lib/figures.ts` */
const FIGURES_TS = `// src/lib/figures.ts: the headline figures of a report, and the list that shows them.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { averagePrice, changeText, count, money } from "./format.ts";
import { change, groupBy, totals, type Report } from "./reports.ts";

export interface Figure {
  label: string;
  value: string;
  /** The change against the previous period, in words. */
  note?: string;
}

/** Revenue, units, titles and average price of a report, each with its change against the previous report. */
export function headlineFigures(
  report: Report,
  previous: Report | null,
): Figure[] {
  const now = totals(report.sales);
  const before = previous && totals(previous.sales);
  const titles = (sales: Report["sales"]): number =>
    groupBy(sales, "title").length;
  const note = (current: number, earlier: number | null): string =>
    changeText(change(current, earlier), previous?.period);
  return [
    {
      label: "Revenue",
      value: money(now.revenueCents),
      note: note(now.revenueCents, before?.revenueCents ?? null),
    },
    {
      label: "Units sold",
      value: count(now.units),
      note: note(now.units, before?.units ?? null),
    },
    {
      label: "Titles sold",
      value: count(titles(report.sales)),
      note: note(
        titles(report.sales),
        previous ? titles(previous.sales) : null,
      ),
    },
    {
      label: "Average price per unit",
      value: averagePrice(now.revenueCents, now.units),
    },
  ];
}

/** Figures as a description list: the label, the value, and the change in words (never by color alone). */
export const figureList = (figures: readonly Figure[]): SafeHtml =>
  html\`<dl class="figures">
    \${figures.map(
      (figure) =>
        html\`<div class="figure-item">
          <dt>\${figure.label}</dt>
          <dd class="figure-value">\${figure.value}</dd>
          \${
            figure.note ? html\`<dd class="figure-note">\${figure.note}</dd>\` : ""
          }
        </div>\`,
    )}
  </dl>\`;
`;

/** `src/lib/format.test.ts` */
const FORMAT_TEST_TS = `import { describe, expect, it } from "vitest";
import {
  averagePrice,
  changeText,
  count,
  decimal,
  money,
  percent,
  periodLabel,
  plural,
  share,
  shortPeriodLabel,
} from "./format.ts";

describe("figures", () => {
  it("writes whole cents as money in the fixed locale and currency", () => {
    expect(money(123450)).toBe("$1,234.50");
    expect(money(5)).toBe("$0.05");
    expect(money(0)).toBe("$0.00");
  });

  it("writes whole cents as a plain decimal without rounding", () => {
    expect(decimal(123450)).toBe("1234.50");
    expect(decimal(5)).toBe("0.05");
    expect(decimal(0)).toBe("0.00");
    expect(decimal(9007199254740991)).toBe("90071992547409.91");
  });

  it("writes counts, nouns and percentages", () => {
    expect(count(1234567)).toBe("1,234,567");
    expect(plural(1, "unit")).toBe("1 unit");
    expect(plural(1200, "title")).toBe("1,200 titles");
    expect(percent(12.345)).toBe("12.3%");
    expect(percent(100)).toBe("100.0%");
  });

  it('writes "n/a" where a figure would divide by zero', () => {
    expect(share(25, 200)).toBe("12.5%");
    expect(share(0, 0)).toBe("n/a");
    expect(averagePrice(5000, 3)).toBe("$16.67");
    expect(averagePrice(0, 0)).toBe("n/a");
  });
});

describe("periods", () => {
  it("names a period from its text, with no Date and so no time zone", () => {
    expect(periodLabel("2026-07")).toBe("July 2026");
    expect(periodLabel("2025-12")).toBe("December 2025");
    expect(periodLabel("2026-01")).toBe("January 2026");
    expect(shortPeriodLabel("2026-09")).toBe("Sep 2026");
  });
});

describe("changeText", () => {
  it("says the direction in words", () => {
    expect(changeText({ kind: "up", percent: 12.34 }, "2026-06")).toBe(
      "Up 12.3% from June 2026",
    );
    expect(changeText({ kind: "down", percent: 100 }, "2026-06")).toBe(
      "Down 100.0% from June 2026",
    );
    expect(changeText({ kind: "same" }, "2026-06")).toBe(
      "No change from June 2026",
    );
    expect(changeText({ kind: "up", percent: 5 })).toBe("Up 5.0%");
  });

  it("has words for a zero and a missing previous figure", () => {
    expect(changeText({ kind: "new" }, "2026-06")).toBe(
      "New: nothing in June 2026",
    );
    expect(changeText({ kind: "new" })).toBe("New");
    expect(changeText({ kind: "none" })).toBe("n/a: first report");
  });
});
`;

/** `src/lib/format.ts` */
const FORMAT_TS = `// src/lib/format.ts: how figures and periods are written. The locale and currency are fixed here, not taken from
// the machine that builds the site, so the same data always gives the same pages.
import type { Change } from "./reports.ts";

export const LOCALE = "en-US";
export const CURRENCY = "USD";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const moneyFormat = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
});
const countFormat = new Intl.NumberFormat(LOCALE);
const percentFormat = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Whole cents as money: 123450 is "$1,234.50". */
export const money = (cents: number): string => moneyFormat.format(cents / 100);

/** Whole cents as a plain decimal for a spreadsheet: 123450 is "1234.50". Whole-number math, so it never rounds. */
export const decimal = (cents: number): string =>
  \`\${Math.trunc(cents / 100)}.\${String(cents % 100).padStart(2, "0")}\`;

/** A whole number with thousands separators: 1234 is "1,234". */
export const count = (value: number): string => countFormat.format(value);

/** A count with its noun: "1 unit", "1,234 units". */
export const plural = (value: number, noun: string): string =>
  \`\${count(value)} \${noun}\${value === 1 ? "" : "s"}\`;

/** A percentage with one decimal: 12.345 is "12.3%". */
export const percent = (value: number): string =>
  \`\${percentFormat.format(value)}%\`;

/** \`part\` as a share of \`total\`, or "n/a" when the total is zero. */
export const share = (part: number, total: number): string =>
  total === 0 ? "n/a" : percent((part / total) * 100);

/** Revenue per unit, or "n/a" when nothing was sold. */
export const averagePrice = (revenueCents: number, units: number): string =>
  units === 0 ? "n/a" : money(Math.round(revenueCents / units));

/** "2026-07" as "July 2026". Read from the text itself: no Date, so no time zone. */
export function periodLabel(period: string): string {
  const [year, month] = period.split("-");
  return \`\${MONTHS[Number(month) - 1]} \${year}\`;
}

/** "2026-07" as "Jul 2026", for chart axes. */
export function shortPeriodLabel(period: string): string {
  const [year, month] = period.split("-");
  return \`\${MONTHS[Number(month) - 1].slice(0, 3)} \${year}\`;
}

/** A change in words, so the direction never depends on color: "Up 12.3% from June 2026". */
export function changeText(change: Change, previousPeriod?: string): string {
  const from = previousPeriod ? \` from \${periodLabel(previousPeriod)}\` : "";
  switch (change.kind) {
    case "up":
      return \`Up \${percent(change.percent)}\${from}\`;
    case "down":
      return \`Down \${percent(change.percent)}\${from}\`;
    case "same":
      return \`No change\${from}\`;
    case "new":
      return previousPeriod
        ? \`New: nothing in \${periodLabel(previousPeriod)}\`
        : "New";
    case "none":
      return "n/a: first report";
  }
}
`;

/** `src/lib/reports.test.ts` */
const REPORTS_TEST_TS = `import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  change,
  groupBy,
  loadReports,
  parseReport,
  reportRoute,
  reportRoutes,
  totals,
  TREND_PERIODS,
} from "./reports.ts";
import { report, sale, twoReports } from "./testing.ts";

const text = (data: unknown): string => JSON.stringify(data);
const valid = { period: "2026-07", sales: [sale()] };

describe("parseReport", () => {
  it("reads a period, its notes and its sales", () => {
    expect(
      parseReport(
        "july.json",
        text({ ...valid, notes: ["Closed on July 4."] }),
      ),
    ).toEqual({
      period: "2026-07",
      notes: ["Closed on July 4."],
      sales: [sale()],
    });
  });

  it("allows a period with no sales and no notes", () => {
    expect(
      parseReport("a.json", text({ period: "2026-07", sales: [] })),
    ).toEqual({ period: "2026-07", notes: [], sales: [] });
  });

  it.each([
    ["text that is not JSON", "{ period: 2026-07 }", "is not valid JSON"],
    ["a list instead of an object", "[]", 'must be an object with "period"'],
    ["no period", text({ sales: [] }), '"period" must be a month'],
    [
      "a month that does not exist",
      text({ ...valid, period: "2026-13" }),
      "2026-13",
    ],
    [
      "a period written as a name",
      text({ ...valid, period: "July 2026" }),
      "YYYY-MM",
    ],
    [
      "a period with a day",
      text({ ...valid, period: "2026-07-01" }),
      "YYYY-MM",
    ],
    ["no sales list", text({ period: "2026-07" }), '"sales" must be a list'],
    [
      "notes that are not text",
      text({ ...valid, notes: [1] }),
      '"notes" must be a list of text',
    ],
    [
      "a sale that is not an object",
      text({ ...valid, sales: ["x"] }),
      "sales[0] must be an object",
    ],
    [
      "a missing title",
      text({ ...valid, sales: [{ ...sale(), title: undefined }] }),
      "sales[0].title must be text (got nothing)",
    ],
    [
      "an empty author",
      text({ ...valid, sales: [sale(), { ...sale(), author: " " }] }),
      "sales[1].author must be text",
    ],
    [
      "units written as text",
      text({ ...valid, sales: [{ ...sale(), units: "12" }] }),
      'sales[0].units must be a whole number, 0 or more (got "12")',
    ],
    [
      "a negative amount",
      text({ ...valid, sales: [{ ...sale(), revenueCents: -500 }] }),
      "sales[0].revenueCents must be a whole number, 0 or more, in cents",
    ],
    [
      "an amount in dollars and cents",
      text({ ...valid, sales: [{ ...sale(), revenueCents: 12.5 }] }),
      "(got 12.5)",
    ],
    [
      "an amount that is not a number",
      text({ ...valid, sales: [{ ...sale(), revenueCents: null }] }),
      "(got null)",
    ],
  ])("misuse: refuses %s, naming the file", (_case, source, problem) => {
    expect(() => parseReport("data/reports/bad.json", source)).toThrow(
      /^data\\/reports\\/bad\\.json: /,
    );
    expect(() => parseReport("data/reports/bad.json", source)).toThrow(problem);
  });
});

describe("loadReports", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reports-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("returns every .json file's report, oldest first, whatever the files are called", async () => {
    await writeFile(
      join(dir, "a-latest.json"),
      text({ ...valid, period: "2026-09" }),
    );
    await writeFile(
      join(dir, "b-first.json"),
      text({ ...valid, period: "2025-12" }),
    );
    await writeFile(join(dir, "notes.txt"), "not a report");
    expect((await loadReports(dir)).map(({ period }) => period)).toEqual([
      "2025-12",
      "2026-09",
    ]);
  });

  it("returns nothing for an empty folder", async () => {
    expect(await loadReports(dir)).toEqual([]);
  });

  it("misuse: refuses two files for one period, naming both", async () => {
    await writeFile(join(dir, "2026-07.json"), text(valid));
    await writeFile(join(dir, "july-copy.json"), text(valid));
    await expect(loadReports(dir)).rejects.toThrow(
      \`\${dir}/july-copy.json: period 2026-07 is already in \${dir}/2026-07.json\`,
    );
  });

  it("misuse: names the file that has a mistake in it", async () => {
    await writeFile(join(dir, "2026-07.json"), text(valid));
    await writeFile(join(dir, "2026-08.json"), text({ period: "2026-08" }));
    await expect(loadReports(dir)).rejects.toThrow(
      \`\${dir}/2026-08.json: "sales"\`,
    );
  });

  it("misuse: says so when the data folder is missing", async () => {
    await expect(loadReports(join(dir, "nope"))).rejects.toThrow(
      "the report data folder is missing",
    );
  });
});

describe("adding up", () => {
  it("totals units and revenue, and an empty period is zero", () => {
    expect(totals(twoReports()[1].sales)).toEqual({
      units: 15,
      revenueCents: 26397,
    });
    expect(totals([])).toEqual({ units: 0, revenueCents: 0 });
  });

  it("groups by a field, highest revenue first, and every grouping adds up to the same total", () => {
    const { sales } = twoReports()[1];
    expect(groupBy(sales, "format")).toEqual([
      { label: "GTP", units: 12, revenueCents: 20400 },
      { label: "LMDh", units: 3, revenueCents: 5997 },
    ]);
    for (const key of ["title", "author", "format", "channel"] as const)
      expect(totals(groupBy(sales, key) as never)).toEqual(totals(sales));
  });

  it("keeps two books with one title apart, and orders ties by name", () => {
    const groups = groupBy(
      [
        sale({ author: "Zed" }),
        sale({ author: "Abe" }),
        sale({ author: "Zed" }),
      ],
      "title",
    );
    expect(groups.map(({ author, units }) => [author, units])).toEqual([
      ["Zed", 4],
      ["Abe", 2],
    ]);
    expect(
      groupBy([sale({ channel: "b" }), sale({ channel: "a" })], "channel").map(
        ({ label }) => label,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("change", () => {
  it("gives the direction and the percentage", () => {
    expect(change(150, 100)).toEqual({ kind: "up", percent: 50 });
    expect(change(75, 100)).toEqual({ kind: "down", percent: 25 });
    expect(change(100, 100)).toEqual({ kind: "same" });
  });

  it("never divides by a zero or missing previous figure", () => {
    expect(change(100, 0)).toEqual({ kind: "new" });
    expect(change(0, 0)).toEqual({ kind: "same" });
    expect(change(100, null)).toEqual({ kind: "none" });
    expect(change(0, 100)).toEqual({ kind: "down", percent: 100 });
  });
});

describe("report routes", () => {
  it("gives each report its neighbors and the revenue of the periods so far", () => {
    const [first, second] = reportRoutes(twoReports());
    expect(first.previous).toBeNull();
    expect(first.nextPeriod).toBe("2026-08");
    expect(second.previous?.period).toBe("2026-07");
    expect(second.nextPeriod).toBeNull();
    expect(second.trend).toEqual([
      { period: "2026-07", revenueCents: 17000 },
      { period: "2026-08", revenueCents: 26397 },
    ]);
  });

  it("keeps the trend to the last periods", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      report(\`20\${String(10 + index)}-01\`),
    );
    const last = reportRoutes(many)[29];
    expect(last.trend).toHaveLength(TREND_PERIODS);
    expect(last.trend.at(-1)?.period).toBe("2039-01");
  });

  it("reads the route of the page being built", () => {
    const route = reportRoutes(twoReports())[1];
    expect(
      reportRoute(
        JSON.stringify({ params: { period: "2026-08" }, data: route }),
      ),
    ).toEqual(route);
  });

  it("misuse: a report component on a page that is not a report page says where it belongs", () => {
    expect(() => reportRoute(undefined)).toThrow(
      "src/pages/reports/[period].html",
    );
    expect(() => reportRoute("{}")).toThrow("only works on");
  });
});
`;

/** `src/lib/reports.ts` */
const REPORTS_TS = `// src/lib/reports.ts: the one place that reads, checks, sorts and adds up the report data.
//
// Every page, component and the CSV script call loadReports(), so they always agree. A period is one JSON file in
// data/reports/ (any file name ending in .json), for example data/reports/2026-07.json:
//
//   {
//     "period": "2026-07",
//     "notes": ["The shop was closed on July 3 and July 4."],
//     "sales": [
//       { "title": "Porsche 911 RSR", "author": "Jordan Taylor", "format": "GTP", "channel": "Sebring",
//         "units": 12, "revenueCents": 20400 }
//     ]
//   }
//
// Money is a whole number of cents, so adding it up never rounds. A period is a "YYYY-MM" string and is never turned
// into a Date, so a build gives the same pages in every time zone. A file that breaks a rule fails the build with
// an error that names the file.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPORTS_DIR } from "./site.ts";

/** One line of a period's sales: a title in one format, sold through one channel. */
export interface Sale {
  title: string;
  author: string;
  format: string;
  channel: string;
  units: number;
  revenueCents: number;
}

/** One period's data file. */
export interface Report {
  /** "YYYY-MM". */
  period: string;
  notes: string[];
  sales: Sale[];
}

/** Units and revenue of any group of sales. */
export interface Totals {
  units: number;
  revenueCents: number;
}

/** Sales added up under one label: a format, a channel, an author or a title. */
export interface Group extends Totals {
  label: string;
  /** The author, when the group is one title. */
  author?: string;
}

/** What a report page gets from its route: the period's report and its neighbors. */
export interface ReportRoute {
  report: Report;
  /** The report before this one, or null for the first. */
  previous: Report | null;
  /** The period after this one, or null for the latest. */
  nextPeriod: string | null;
  /** Revenue of this period and the ones before it, oldest first, for the trend chart. */
  trend: { period: string; revenueCents: number }[];
}

/**
 * How a figure moved against the previous period. "new" means the previous figure was zero, so there is no
 * percentage; "none" means there is no previous period.
 */
export type Change =
  { kind: "up" | "down"; percent: number } | { kind: "same" | "new" | "none" };

const PERIOD = /^\\d{4}-(0[1-9]|1[0-2])$/;
const SALE_TEXT = ["title", "author", "format", "channel"] as const;
const SALE_NUMBERS = ["units", "revenueCents"] as const;

/** At most this many periods are drawn in a trend chart. */
export const TREND_PERIODS = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shown = (value: unknown): string =>
  value === undefined ? "nothing" : JSON.stringify(value);

/** Read one data file's text. \`file\` is the name error messages give. */
export function parseReport(file: string, text: string): Report {
  const fail = (problem: string): never => {
    throw new Error(\`\${file}: \${problem}\`);
  };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return fail(\`is not valid JSON (\${(error as Error).message})\`);
  }
  if (!isRecord(data))
    return fail('must be an object with "period" and "sales"');
  const { period, notes = [], sales } = data;
  if (typeof period !== "string" || !PERIOD.test(period))
    return fail(
      \`"period" must be a month written as YYYY-MM, such as "2026-07" (got \${shown(period)})\`,
    );
  if (!Array.isArray(notes) || notes.some((note) => typeof note !== "string"))
    return fail(
      '"notes" must be a list of text, such as ["Closed on July 4."]',
    );
  if (!Array.isArray(sales))
    return fail(
      \`"sales" must be a list, and may be empty: "sales": [] (got \${shown(sales)})\`,
    );
  const checked = sales.map((sale: unknown, index): Sale => {
    const where = \`sales[\${index}]\`;
    if (!isRecord(sale))
      return fail(\`\${where} must be an object (got \${shown(sale)})\`);
    for (const key of SALE_TEXT) {
      const value = sale[key];
      if (typeof value !== "string" || value.trim() === "")
        return fail(\`\${where}.\${key} must be text (got \${shown(value)})\`);
    }
    for (const key of SALE_NUMBERS) {
      const value = sale[key];
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        const unit =
          key === "revenueCents" ? ", in cents (1250 for $12.50)" : "";
        return fail(
          \`\${where}.\${key} must be a whole number, 0 or more\${unit} (got \${shown(value)})\`,
        );
      }
    }
    return {
      title: sale.title as string,
      author: sale.author as string,
      format: sale.format as string,
      channel: sale.channel as string,
      units: sale.units as number,
      revenueCents: sale.revenueCents as number,
    };
  });
  return { period, notes: notes as string[], sales: checked };
}

/** Every report in \`dir\`, oldest first. Two files for one period are an error. */
export async function loadReports(
  dir: string = REPORTS_DIR,
): Promise<Report[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new Error(
      \`\${dir}: the report data folder is missing. Create it and add one JSON file per period.\`,
    );
  }
  const files = new Map<string, string>();
  const reports: Report[] = [];
  for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
    const file = \`\${dir}/\${name}\`;
    const report = parseReport(file, await readFile(join(dir, name), "utf8"));
    const earlier = files.get(report.period);
    if (earlier)
      throw new Error(
        \`\${file}: period \${report.period} is already in \${earlier}. Keep one file per period.\`,
      );
    files.set(report.period, file);
    reports.push(report);
  }
  return reports.sort((a, b) => (a.period < b.period ? -1 : 1));
}

export const totals = (sales: readonly Sale[]): Totals =>
  sales.reduce(
    (sum, sale) => ({
      units: sum.units + sale.units,
      revenueCents: sum.revenueCents + sale.revenueCents,
    }),
    { units: 0, revenueCents: 0 },
  );

/** The routes of the report pages: each report with its neighbors, oldest first. */
export const reportRoutes = (reports: readonly Report[]): ReportRoute[] =>
  reports.map((report, index) => ({
    report,
    previous: reports[index - 1] ?? null,
    nextPeriod: reports[index + 1]?.period ?? null,
    trend: reports
      .slice(Math.max(0, index + 1 - TREND_PERIODS), index + 1)
      .map(({ period, sales }) => ({
        period,
        revenueCents: totals(sales).revenueCents,
      })),
  }));

/**
 * The route of the report page being built, read from the variable Bascik sets for it. The components of a report
 * page call this, so they only work on src/pages/reports/[period].html.
 */
export function reportRoute(route: string | undefined): ReportRoute {
  const data = (JSON.parse(route || "{}") as { data?: ReportRoute }).data;
  if (!data?.report)
    throw new Error(
      "This component shows one report, so it only works on src/pages/reports/[period].html.",
    );
  return data;
}

/** Sales added up per value of \`key\`, highest revenue first, then by name so the order never depends on the file. */
export function groupBy(
  sales: readonly Sale[],
  key: "title" | "author" | "format" | "channel",
): Group[] {
  const groups = new Map<string, Group>();
  for (const sale of sales) {
    // Two books may share a title, so a title group is a title by an author.
    const id = key === "title" ? \`\${sale.title}\\n\${sale.author}\` : sale[key];
    const group = groups.get(id) ?? {
      label: sale[key],
      ...(key === "title" ? { author: sale.author } : {}),
      units: 0,
      revenueCents: 0,
    };
    group.units += sale.units;
    group.revenueCents += sale.revenueCents;
    groups.set(id, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.revenueCents - a.revenueCents ||
      b.units - a.units ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
}

/** How \`current\` moved against \`previous\`. A zero or missing previous figure has its own kind: nothing divides by zero. */
export function change(current: number, previous: number | null): Change {
  if (previous === null) return { kind: "none" };
  if (current === previous) return { kind: "same" };
  if (previous === 0) return { kind: "new" };
  const percent = (Math.abs(current - previous) / previous) * 100;
  return { kind: current > previous ? "up" : "down", percent };
}
`;

/** `src/lib/seo.test.ts` */
const SEO_TEST_TS = `import { afterEach, describe, expect, it, vi } from "vitest";
import { pageHead, pageUrl } from "./seo.ts";
import { siteName } from "./site.ts";
import { AWKWARD } from "./testing.ts";

afterEach(() => vi.unstubAllEnvs());

const page = {
  title: "July 2026 racing report",
  description: "Revenue and units.",
};

describe("pageUrl", () => {
  it("joins the site URL, the base and the page path", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com/");
    vi.stubEnv("BASCIK_BASE", "/shop/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/reports/2026-07");
    expect(pageUrl()).toBe("https://example.com/shop/reports/2026-07");
  });

  it("is undefined when the site URL is not known, as on the dev server", () => {
    vi.stubEnv("BASCIK_SITE_URL", "");
    expect(pageUrl()).toBeUndefined();
  });
});

describe("pageHead", () => {
  it("writes the title with the site name, the description and the social tags", () => {
    vi.stubEnv("BASCIK_SITE_URL", "");
    const head = String(pageHead(page));
    expect(head).toContain("<title>July 2026 racing report - ");
    expect(head).toContain(
      '<meta name="description" content="Revenue and units." />',
    );
    expect(head).toContain(
      '<meta property="og:title" content="July 2026 racing report - ',
    );
    expect(head).toContain('<meta property="og:site_name"');
    expect(head).not.toContain("canonical");
  });

  it("adds the canonical URL when the site URL is known", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    vi.stubEnv("BASCIK_BASE", "/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/compare");
    const head = String(pageHead(page));
    expect(head).toContain(
      '<link rel="canonical" href="https://example.com/compare" />',
    );
    expect(head).toContain(
      '<meta property="og:url" content="https://example.com/compare" />',
    );
  });

  it("keeps a noindex page out of search results and gives it no canonical URL", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    const head = String(pageHead({ ...page, noindex: true }));
    expect(head).toContain('<meta name="robots" content="noindex" />');
    expect(head).not.toContain("canonical");
  });

  it("escapes the title and the description", () => {
    const head = String(pageHead({ title: AWKWARD, description: AWKWARD }));
    expect(head).toContain("<title>Porsche &lt;b&gt;&amp; 963");
    expect(head).toContain(
      'content="Porsche &lt;b&gt;&amp; 963, $&amp; &#39;n&#39; more"',
    );
    expect(head).not.toContain("<b>");
  });

  it("uses the site name from src/lib/site.ts", () => {
    expect(siteName.length).toBeGreaterThan(0);
  });
});
`;

/** `src/lib/seo.ts` */
const SEO_TS = `// src/lib/seo.ts: the head tags that differ per page. Each page calls pageHead() from a build script in its <head>.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { siteName } from "./site.ts";

/**
 * The absolute URL of the page being built, or undefined when the site URL is not known (the dev server). The
 * domain is never written into the source: it comes from BASCIK_SITE_URL.
 */
export function pageUrl(): string | undefined {
  const origin = process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "");
  if (!origin) return undefined;
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  return \`\${origin}\${base}\${process.env.BASCIK_PAGE_PATH || "/"}\`;
}

export interface PageHead {
  /** The page's own title; the site name is added after it. */
  title: string;
  description: string;
  /** Keep the page out of search results, as for the 404 page. */
  noindex?: boolean;
}

/** The title, description, canonical URL and social tags of one page. */
export function pageHead(page: PageHead): SafeHtml {
  const title = \`\${page.title} - \${siteName}\`;
  const url = page.noindex ? undefined : pageUrl();
  return html\`<title>\${title}</title>
    <meta name="description" content="\${page.description}" />
    \${page.noindex ? html\`<meta name="robots" content="noindex" />\` : ""}
    \${
      url
        ? html\`<link rel="canonical" href="\${url}" />
            <meta property="og:url" content="\${url}" />\`
        : ""
    }
    <meta property="og:type" content="website" />
    <meta property="og:title" content="\${title}" />
    <meta property="og:description" content="\${page.description}" />
    <meta property="og:site_name" content="\${siteName}" />\`;
}
`;

/** `src/lib/tables.test.ts` */
const TABLES_TEST_TS = `import { html } from "@bascik/bascik/html";
import { describe, expect, it } from "vitest";
import { dataTable, salesTable } from "./tables.ts";
import { AWKWARD, flat, sale, twoReports } from "./testing.ts";

describe("dataTable", () => {
  const table = flat(
    dataTable({
      caption: "Sales by format",
      testId: "formats",
      columns: [{ header: "Format" }, { header: "Units", numeric: true }],
      rows: [
        ["Vintage", "12"],
        ["GT3", "3"],
      ],
      totals: ["Total", "15"],
    }),
  );

  it("has a caption, scoped headers and right-aligned numbers", () => {
    expect(table).toContain("<caption>Sales by format</caption>");
    expect(table).toContain('<th scope="col">Format</th>');
    expect(table).toContain('<th scope="col" class="num">Units</th>');
    expect(table).toContain(
      '<th scope="row">Vintage</th><td class="num">12</td>',
    );
    expect(table).toContain('data-testid="formats"');
  });

  it("puts the total in <tfoot>", () => {
    expect(table).toMatch(
      /<tfoot><tr><th scope="row">Total<\\/th><td class="num">15<\\/td><\\/tr><\\/tfoot>/,
    );
  });

  it("sits in a named, focusable region, so a wide table can be scrolled with the keyboard", () => {
    expect(table).toMatch(
      /^<div class="table-scroll" role="region" aria-label="Sales by format" tabindex="0" data-testid="formats-scroll">/,
    );
  });

  it("says so when there are no rows, and has no <tfoot> without totals", () => {
    const empty = flat(
      dataTable({
        caption: "None",
        testId: "none",
        columns: [{ header: "A" }, { header: "B" }],
        rows: [],
      }),
    );
    expect(empty).toContain('<td colspan="2">No sales recorded.</td>');
    expect(empty).not.toContain("<tfoot>");
  });

  it("escapes text cells and the caption, and keeps html cells as markup", () => {
    const awkward = flat(
      dataTable({
        caption: AWKWARD,
        testId: "t",
        columns: [{ header: "A" }, { header: "B" }],
        rows: [[AWKWARD, html\`<time datetime="2026-07">July</time>\`]],
      }),
    );
    expect(awkward).toContain(
      '<th scope="row">Porsche &lt;b&gt;&amp; 963, $&amp; &#39;n&#39; more</th>',
    );
    expect(awkward).toContain('<td><time datetime="2026-07">July</time></td>');
    expect(awkward).not.toContain("<b>");
  });
});

describe("salesTable", () => {
  it("adds up by title with the author, and the total row matches the rows", () => {
    const table = flat(
      salesTable(twoReports()[1].sales, "title", "By title", "titles"),
    );
    expect(table).toContain(
      '<th scope="row">Porsche 911 RSR</th><td>Jordan Taylor</td><td class="num">12</td><td class="num">$204.00</td><td class="num">77.3%</td>',
    );
    expect(table).toContain(
      '<th scope="row">Total</th><td></td><td class="num">15</td><td class="num">$263.97</td><td class="num">100.0%</td>',
    );
  });

  it("adds up by format with no author column", () => {
    const table = flat(
      salesTable(twoReports()[1].sales, "format", "By format", "formats"),
    );
    expect(table).toContain(
      '<th scope="col">Format</th><th scope="col" class="num">Units</th>',
    );
    expect(table).toContain(
      '<th scope="row">LMDh</th><td class="num">3</td>',
    );
  });

  it('writes "n/a" shares, not NaN, when revenue is zero or there are no sales', () => {
    for (const sales of [[], [sale({ units: 0, revenueCents: 0 })]]) {
      const table = flat(
        salesTable(sales, "channel", "By channel", "channels"),
      );
      expect(table).not.toMatch(/NaN|Infinity|undefined/);
      expect(table).toContain(
        '<td class="num">$0.00</td><td class="num">n/a</td>',
      );
    }
  });
});
`;

/** `src/lib/tables.ts` */
const TABLES_TS = `// src/lib/tables.ts: the data tables. Every table has a caption, column and row headers with a scope, numbers
// aligned right (the "num" class in src/pages/css/styles.css) and, where rows add up, a total in <tfoot>.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { count, money, share } from "./format.ts";
import { groupBy, totals, type Sale } from "./reports.ts";

export interface Column {
  header: string;
  numeric?: boolean;
}

export type Cell = string | SafeHtml;

export interface Table {
  caption: string;
  /** The table's data-testid. */
  testId: string;
  /** The first column holds each row's header. */
  columns: readonly Column[];
  rows: readonly (readonly Cell[])[];
  /** The cells of the total row, one per column. */
  totals?: readonly Cell[];
}

// A hole cannot add or remove an attribute, so a cell with the class and one without are written out.
const headerCell = (column: Column): SafeHtml =>
  column.numeric
    ? html\`<th scope="col" class="num">\${column.header}</th>\`
    : html\`<th scope="col">\${column.header}</th>\`;

const row = (cells: readonly Cell[], columns: readonly Column[]): SafeHtml =>
  html\`<tr>
    \${cells.map((cell, index) =>
      index === 0
        ? html\`<th scope="row">\${cell}</th>\`
        : columns[index]?.numeric
          ? html\`<td class="num">\${cell}</td>\`
          : html\`<td>\${cell}</td>\`,
    )}
  </tr>\`;

export function dataTable(table: Table): SafeHtml {
  const body =
    table.rows.length === 0
      ? html\`<tr>
          <td colspan="\${table.columns.length}">No sales recorded.</td>
        </tr>\`
      : table.rows.map((cells) => row(cells, table.columns));
  // The wrapper can scroll, so it takes keyboard focus and has a name, as a scrolling region must.
  return html\`<div
    class="table-scroll"
    role="region"
    aria-label="\${table.caption}"
    tabindex="0"
    data-testid="\${table.testId}-scroll"
  >
    <table class="data-table" data-testid="\${table.testId}">
      <caption>
        \${table.caption}
      </caption>
      <thead>
        <tr>
          \${table.columns.map(headerCell)}
        </tr>
      </thead>
      <tbody>
        \${body}
      </tbody>
      \${
        table.totals
          ? html\`<tfoot>
              \${row(table.totals, table.columns)}
            </tfoot>\`
          : ""
      }
    </table>
  </div>\`;
}

const HEADERS = {
  title: "Title",
  author: "Author",
  format: "Format",
  channel: "Channel",
} as const;

/** Sales added up by title, author, format or channel: units, revenue and share of revenue, with a total row. */
export function salesTable(
  sales: readonly Sale[],
  by: keyof typeof HEADERS,
  caption: string,
  testId: string,
): SafeHtml {
  const total = totals(sales);
  const byTitle = by === "title";
  return dataTable({
    caption,
    testId,
    columns: [
      { header: HEADERS[by] },
      ...(byTitle ? [{ header: "Author" }] : []),
      { header: "Units", numeric: true },
      { header: "Revenue", numeric: true },
      { header: "Share of revenue", numeric: true },
    ],
    rows: groupBy(sales, by).map((group) => [
      group.label,
      ...(byTitle ? [group.author ?? ""] : []),
      count(group.units),
      money(group.revenueCents),
      share(group.revenueCents, total.revenueCents),
    ]),
    totals: [
      "Total",
      ...(byTitle ? [""] : []),
      count(total.units),
      money(total.revenueCents),
      share(total.revenueCents, total.revenueCents),
    ],
  });
}
`;

/** `src/lib/testing.ts` */
const TESTING_TS = `// src/lib/testing.ts: small reports for the unit tests. The site itself never imports this file.
import {
  reportRoutes,
  type Report,
  type ReportRoute,
  type Sale,
} from "./reports.ts";

/** One sales line, with any field replaced. */
export const sale = (fields: Partial<Sale> = {}): Sale => ({
  title: "Porsche 911 RSR",
  author: "Jordan Taylor",
  format: "GTP",
  channel: "Sebring",
  units: 2,
  revenueCents: 3400,
  ...fields,
});

export const report = (
  period: string,
  sales: Sale[] = [sale()],
  notes: string[] = [],
): Report => ({ period, notes, sales });

/** Two periods: July sells one title, August sells two in two formats and channels. */
export const twoReports = (): Report[] => [
  report("2026-07", [sale({ units: 10, revenueCents: 17000 })]),
  report(
    "2026-08",
    [
      sale({ units: 12, revenueCents: 20400 }),
      sale({
        title: "Porsche 962C",
        author: "Hurley Haywood",
        format: "LMDh",
        channel: "Daytona",
        units: 3,
        revenueCents: 5997,
      }),
    ],
    ["No events were held in August."],
  ),
];

/** The route of one of \`reports\` (the last one unless \`index\` says otherwise), as a report page receives it. */
export const routeOf = (
  reports: readonly Report[],
  index: number = reports.length - 1,
): ReportRoute => reportRoutes(reports)[index];

/** Text that would break HTML, SVG or CSV if it were not escaped for each. */
export const AWKWARD = \`Porsche <b>& 963, $& 'n' more\`;

/**
 * Markup on one line, with no space next to a tag, so a test never depends on how a template or a component file
 * is wrapped.
 */
export const flat = (markup: unknown): string =>
  String(markup)
    .replace(/\\s+/g, " ")
    .replace(/ ?([<>]) ?/g, "$1")
    .trim();
`;

/** Everything under `src/lib/` except `site.ts`. */
export const LIB_FILES: TemplateFile[] = [
  ["src/lib/charts.test.ts", CHARTS_TEST_TS],
  ["src/lib/charts.ts", CHARTS_TS],
  ["src/lib/csv.test.ts", CSV_TEST_TS],
  ["src/lib/csv.ts", CSV_TS],
  ["src/lib/figures.test.ts", FIGURES_TEST_TS],
  ["src/lib/figures.ts", FIGURES_TS],
  ["src/lib/format.test.ts", FORMAT_TEST_TS],
  ["src/lib/format.ts", FORMAT_TS],
  ["src/lib/reports.test.ts", REPORTS_TEST_TS],
  ["src/lib/reports.ts", REPORTS_TS],
  ["src/lib/seo.test.ts", SEO_TEST_TS],
  ["src/lib/seo.ts", SEO_TS],
  ["src/lib/tables.test.ts", TABLES_TEST_TS],
  ["src/lib/tables.ts", TABLES_TS],
  ["src/lib/testing.ts", TESTING_TS],
];
