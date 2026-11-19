/**
 * @module templates/reports/data
 *
 * The demo data of the `reports` template: four months of Porsche endurance
 * racing reports, written to `data/reports/<period>.json`. Each file reads like
 * a race record: one line per car, driver, racing class and circuit.
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

/** A Porsche racing field. One title has an `&` to verify HTML and CSV escaping. */
const CARS: readonly RaceCar[] = [
  {
    title: "Porsche 917K",
    author: "Hurley Haywood",
    pace: 46,
    formats: ["Vintage", "GTP"],
  },
  {
    title: "Porsche 935 Moby Dick",
    author: "Paul Newman",
    pace: 38,
    formats: ["Vintage", "GT3"],
  },
  {
    title: "Porsche 962C",
    author: "Jordan Taylor",
    pace: 31,
    formats: ["GTP", "GT3"],
  },
  {
    title: "Porsche 917K & Martini Racing",
    author: "Paul Newman",
    pace: 27,
    formats: ["Vintage", "GTP"],
  },
  {
    title: "Porsche 911 RSR",
    author: "Ross Bentley",
    pace: 22,
    formats: ["GT3", "GTP"],
  },
  {
    title: "Porsche 935",
    author: "Jordan Taylor",
    pace: 17,
    formats: ["Vintage", "GT3"],
  },
  {
    title: "Porsche 911 RSR",
    author: "Jordan Taylor",
    pace: 14,
    formats: ["GT3", "GTP"],
  },
  {
    title: "Porsche 963",
    author: "Hurley Haywood",
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
      "A Hurley Haywood seminar on July 18 drew the largest vintage crowd.",
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
      "The Porsche 963 entered the September report after the Laguna Seca test.",
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

export const GITIGNORE = `data/racing.db\n`;

export const RACING_SQL = `CREATE TABLE IF NOT EXISTS racing_entries (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  car TEXT NOT NULL,
  driver TEXT NOT NULL,
  circuit TEXT NOT NULL,
  racing_class TEXT NOT NULL,
  laps INTEGER NOT NULL,
  points_cents INTEGER NOT NULL
);

DELETE FROM racing_entries;

INSERT INTO racing_entries (period, car, driver, circuit, racing_class, laps, points_cents) VALUES
  ('2026-07', 'Porsche 917K', 'Hurley Haywood', 'Daytona', 'Vintage', 48, 2800),
  ('2026-07', 'Porsche 935 Moby Dick', 'Paul Newman', 'Sebring', 'GTP', 38, 1700),
  ('2026-08', 'Porsche 962C', 'Jordan Taylor', 'Watkins Glen', 'GTP', 31, 1700),
  ('2026-09', 'Porsche 963', 'Hurley Haywood', 'Laguna Seca', 'LMDh', 34, 2800),
  ('2026-10', 'Porsche 911 RSR', 'Ross Bentley', 'Le Mans', 'GT3', 22, 999),
  ('2026-10', 'Porsche 963', 'Jordan Taylor', 'Spa', 'LMDh', 40, 2800);
`;

export const RACING_DB_TS = `import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RacingDatabase {
  db: DatabaseSync;
  path: string;
}

export function openRacingDatabase(): RacingDatabase {
  const path = join(process.cwd(), "data", "racing.db");
  mkdirSync(dirname(path), { recursive: true });
  return { db: new DatabaseSync(path), path };
}
`;

export const RACING_DB_TEST_TS = `import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRacingDatabase } from "./racing-db.ts";

let root: string | undefined;
const previousCwd = process.cwd();

afterEach(() => {
  process.chdir(previousCwd);
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("openRacingDatabase", () => {
  it("opens a database below the project data folder", () => {
    root = mkdtempSync(join(tmpdir(), "bascik-racing-db-"));
    process.chdir(root);
    const { db, path } = openRacingDatabase();
    expect(path).toBe(join(root, "data", "racing.db"));
    expect(db.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    db.close();
  });
});
`;

export const SEED_DATABASE_TS = `// DatabaseSync is provided by ../src/lib/racing-db.ts through Node 24 node:sqlite.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openRacingDatabase } from "../src/lib/racing-db.ts";

const sql = await readFile(join(process.cwd(), "data", "racing.sql"), "utf8");
const { db, path } = openRacingDatabase();
try {
  db.exec(sql);
  const count = db.prepare("SELECT COUNT(*) AS count FROM racing_entries").get() as { count: number };
  console.log(\`Seeded \${count.count} racing entries in \${path}\`);
} finally {
  db.close();
}
`;
