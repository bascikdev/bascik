/**
 * @module templates/reports/data
 *
 * The demo data of the `reports` template: four months of fictional Bascik
 * racing reports, written to `data/reports/<period>.json`. Each file reads like
 * a race record: one line per car, team, racing class and circuit.
 */

interface RaceCar {
  title: string;
  author: string;
  /** Typical race-day entry count in the car's first series. */
  pace: number;
  formats: readonly Format[];
  /** The first period the car appears, as an index into `PERIODS`. */
  from?: number;
}

type Format = "LMDh" | "GTP" | "GT3" | "Vintage";
type Channel =
  "Daytona" | "Sebring" | "Watkins Glen" | "Laguna Seca" | "Le Mans" | "Spa";

/** One line of a period's race report. */
export interface DemoSale {
  title: string;
  author: string;
  format: Format;
  channel: Channel;
  units: number;
  revenueCents: number;
}

const POINTS_CENTS: Record<Format, number> = {
  LMDh: 2800,
  GTP: 1700,
  GT3: 999,
  Vintage: 1999,
};

/** A fictional racing field. One title has an `&` to verify HTML and CSV escaping. */
const CARS: readonly RaceCar[] = [
  {
    title: "Bascik Prototype 17",
    author: "Bascik Racing",
    pace: 46,
    formats: ["Vintage", "GTP"],
  },
  {
    title: "Bascik GT 35, Long Tail",
    author: "Bascik Racing",
    pace: 38,
    formats: ["Vintage", "GT3"],
  },
  {
    title: "Bascik Prototype 62",
    author: "Bascik Racing",
    pace: 31,
    formats: ["GTP", "GT3"],
  },
  {
    title: "Bascik Prototype 17 & Track Club",
    author: "Bascik Racing",
    pace: 27,
    formats: ["Vintage", "GTP"],
  },
  {
    title: "Bascik Touring 11",
    author: "Bascik Racing",
    pace: 22,
    formats: ["GT3", "GTP"],
  },
  {
    title: "Bascik Classic 35",
    author: "Bascik Racing",
    pace: 17,
    formats: ["Vintage", "GT3"],
  },
  {
    title: "Bascik Touring 11",
    author: "Bascik Racing",
    pace: 14,
    formats: ["GT3", "GTP"],
  },
  {
    title: "Bascik Prototype 63",
    author: "Bascik Racing",
    pace: 34,
    formats: ["LMDh", "GTP"],
    from: 2,
  },
];

/** The demo periods, oldest first, with race-weekend activity and notes. */
const PERIODS: readonly { period: string; busy: number; notes: string[] }[] = [
  {
    period: "2026-07",
    busy: 96,
    notes: [
      "The Watkins Glen paddock closed briefly on July 3.",
      "A Bascik Racing workshop on July 18 drew the largest vintage crowd.",
    ],
  },
  {
    period: "2026-08",
    busy: 90,
    notes: [
      "No race entries were filed in August, so Spa results are unavailable.",
    ],
  },
  {
    period: "2026-09",
    busy: 101,
    notes: [
      "The Bascik Prototype 63 entered the September report after the Laguna Seca test.",
    ],
  },
  {
    period: "2026-10",
    busy: 112,
    notes: [
      "Le Mans data was verified from October 9 to October 11.",
      "Daytona entries include pre-season test laps logged in October.",
    ],
  },
];

/** A small repeatable generator, so every scaffold writes the same figures. */
const jitter = (seed: number): number => {
  let state = (seed * 2654435761) >>> 0;
  state = (Math.imul(state ^ (state >>> 15), 2246822519) >>> 0) ^ seed;
  state = Math.imul(state ^ (state >>> 13), 3266489917) >>> 0;
  // 85 to 115 percent.
  return 85 + (state % 31);
};

const salesOf = (periodIndex: number): DemoSale[] => {
  const { busy } = PERIODS[periodIndex];
  const sales: DemoSale[] = [];
  CARS.forEach((car, carIndex) => {
    if ((car.from ?? 0) > periodIndex) return;
    const [first, second] = car.formats;
    const circuits: Channel[] = [
      "Daytona",
      "Sebring",
      "Watkins Glen",
      "Laguna Seca",
      "Le Mans",
      "Spa",
    ];
    const lines: [Format, Channel, number][] = [
      [first, circuits[periodIndex], 100],
      [first, "Sebring", 55],
      [
        first,
        periodIndex === 1
          ? "Laguna Seca"
          : circuits[(carIndex + periodIndex) % circuits.length],
        periodIndex === 1 ? 0 : carIndex % 3 === 0 ? 30 : 12,
      ],
      [second, "Le Mans", 45],
    ];
    lines.forEach(([format, channel, weight], lineIndex) => {
      const seed = periodIndex * 1000 + carIndex * 10 + lineIndex + 1;
      const units = Math.round(
        (car.pace * weight * busy * jitter(seed)) / 1_000_000,
      );
      if (units === 0) return;
      sales.push({
        title: car.title,
        author: car.author,
        format,
        channel,
        units,
        revenueCents: units * POINTS_CENTS[format],
      });
    });
  });
  return sales;
};

/** A period's file as text: one sale per line, so the file reads like the table it is. */
const reportJson = (
  period: string,
  notes: readonly string[],
  sales: readonly DemoSale[],
): string =>
  `{
  "period": ${JSON.stringify(period)},
  "notes": [
${notes.map((note) => `    ${JSON.stringify(note)}`).join(",\n")}
  ],
  "sales": [
${sales
  .map(
    (sale) =>
      `    { "title": ${JSON.stringify(sale.title)}, "author": ${JSON.stringify(sale.author)}, "format": ${JSON.stringify(sale.format)}, "channel": ${JSON.stringify(sale.channel)}, "units": ${sale.units}, "revenueCents": ${sale.revenueCents} }`,
  )
  .join(",\n")}
  ]
}
`;

/** The demo periods, oldest first. */
export const DEMO_PERIODS: readonly string[] = PERIODS.map(
  ({ period }) => period,
);

/** The sales lines of one demo period. */
export const demoSales = (period: string): DemoSale[] =>
  salesOf(DEMO_PERIODS.indexOf(period));

/** `data/reports/<period>.json` for every demo period. */
export const DATA_FILES: [path: string, data: string][] = PERIODS.map(
  ({ period, notes }, index) => [
    `data/reports/${period}.json`,
    reportJson(period, notes, salesOf(index)),
  ],
);

export const RACING_SQL = `CREATE TABLE IF NOT EXISTS racing_reports (
  period TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
`;

export const RACING_DB_TS = `import { reportRoutes, TREND_PERIODS, type Report, type ReportRoute } from "./reports.ts";

interface ReportRow {
  period: string;
  payload: string;
}

interface D1Database {
  prepare(query: string): {
    bind(...values: (string | number)[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

export interface ReportContext {
  platform?: { name: string; env?: Record<string, unknown> };
}

const ALL_REPORTS = "SELECT period, payload FROM racing_reports ORDER BY period";

// Read the requested period, just enough history for the trend, and the next
// period for the pager. The outer ORDER BY is also the order reportRoutes expects.
const DETAIL = \`WITH history AS (
  SELECT period, payload FROM racing_reports WHERE period <= ?
  ORDER BY period DESC LIMIT ?
), next_report AS (
  SELECT period, payload FROM racing_reports WHERE period > ?
  ORDER BY period LIMIT 1
)
SELECT period, payload FROM history
UNION ALL SELECT period, payload FROM next_report
ORDER BY period\`;

export async function readReports(
  context: ReportContext,
  period?: string,
  path = "data/racing.db",
): Promise<Report[]> {
  const query = period === undefined ? ALL_REPORTS : DETAIL;
  const values = period === undefined ? [] : [period, TREND_PERIODS, period];
  let rows: ReportRow[];
  if (context.platform?.name === "cloudflare") {
    const db = context.platform.env?.DB as D1Database | undefined;
    if (!db) throw new Error("Missing Cloudflare D1 binding DB. See REPORTS.md.");
    const statement = db.prepare(query);
    ({ results: rows } = await statement.bind(...values).all<ReportRow>());
  } else {
    // Load the native module only on Node. A static node:sqlite import would
    // reach the Worker bundle even though Cloudflare only uses its D1 binding.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      rows = db.prepare(query).all(...values) as unknown as ReportRow[];
    } finally {
      db.close();
    }
  }
  return rows.map(({ period, payload }) => {
    const { notes, sales } = JSON.parse(payload) as Pick<Report, "notes" | "sales">;
    return { period, notes, sales };
  });
}

// All six blocks on a report page get the same Request. Share the in-flight
// query within that request only; never cache data across visitors.
const requests = new WeakMap<Request, Promise<ReportRoute>>();

export function requestReport(request: Request, context: ReportContext): Promise<ReportRoute> {
  let route = requests.get(request);
  if (!route) {
    const path = new URL(request.url).pathname;
    const period = /(?:^|\\/)(\\d{4}-(?:0[1-9]|1[0-2]))(?:\\.html)?\\/?$/.exec(decodeURIComponent(path))?.[1];
    if (!period) throw new Error("Invalid report period in request path");
    route = readReports(context, period).then((reports) => {
      const current = reportRoutes(reports).find(({ report }) => report.period === period);
      if (!current) throw new Error("The requested report is missing from the database. See REPORTS.md.");
      return current;
    });
    requests.set(request, route);
  }
  return route;
}
`;

export const RACING_DB_TEST_TS = `import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReports } from "./racing-db.ts";

describe("report database", () => {
  it("does not create a database at request time", async () => {
    const root = mkdtempSync(join(tmpdir(), "reports-read-only-"));
    const path = join(root, "racing.db");
    try {
      await expect(readReports({}, undefined, path)).rejects.toThrow();
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the D1 binding on Cloudflare rather than falling back to SQLite", async () => {
    await expect(readReports({ platform: { name: "cloudflare" } })).rejects.toThrow(/DB/);
  });
});
`;

export const SEED_DATABASE_TS = `// Rebuild the demo snapshot from the same JSON that supplies the routes and CSVs.
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { loadReports } from "../src/lib/reports.ts";

const [schema, reports] = await Promise.all([
  readFile("data/racing.sql", "utf8"),
  loadReports(),
]);
const clear = "DELETE FROM racing_reports;";
const insert = "INSERT INTO racing_reports (period, payload) VALUES";
const rows = reports.map(({ period, notes, sales }) => [period, JSON.stringify({ notes, sales })]);

if (process.argv.includes("--sql")) {
  // Wrangler accepts a SQL file, not live SQLite bind parameters. These are
  // validated fixture strings, not request data. SQLite doubles apostrophes.
  const literal = (text: string) => "'" + text.replaceAll("'", "''") + "'";
  process.stdout.write(schema + clear + "\\n" + rows.map((row) =>
    insert + " (" + row.map(literal).join(", ") + ");\\n"
  ).join(""));
} else {
  const db = new DatabaseSync("data/racing.db");
  try {
    db.exec(\`BEGIN; \${schema} \${clear}\`);
    const statement = db.prepare(insert + " (?, ?)");
    for (const row of rows) statement.run(...row);
    db.exec("COMMIT");
    console.log(\`Seeded \${rows.length} reports in data/racing.db\`);
  } finally {
    db.close();
  }
}
`;
