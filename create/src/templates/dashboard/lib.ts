/**
 * The dashboard template's data and helpers: the root config, the seeded
 * bookshop data in `src/lib/shop.ts`, the SVG chart helpers, the order
 * table helper, and their tests. `src/lib/site.ts` is not here: it holds the
 * site's name, so `dashboard.ts` writes it.
 *
 * Each entry is one file of the generated project, as it is written: its
 * path from the project root, then its content.
 */

import type { TemplateFile } from "../../scaffold.js";

export const LIB_FILES: TemplateFile[] = [
  [
    "bascik.config.ts",
    `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // The pages read their data and chart helpers from src/lib/. Component and
    // page folders are watched already; this rebuilds the pages in dev when a
    // shared module such as src/lib/shop.ts changes.
    watchPaths: ["src/lib/"],
  },
});
`,
  ],

  [
    "data/racing.sql",
    `PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS order_lines;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS cars;

CREATE TABLE cars (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  preorder INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  customer TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE order_lines (
  order_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id),
  FOREIGN KEY(slug) REFERENCES cars(slug)
);

INSERT INTO cars (slug, title, author, price_cents, stock, preorder) VALUES
  ('porsche-917k', 'Porsche 917K', 'Hurley Haywood', 189900, 42, 0),
  ('porsche-935-moby-dick', 'Porsche 935 Moby Dick', 'Jacky Ickx', 245000, 6, 0),
  ('porsche-962c', 'Porsche 962C', 'Vern Schuppan', 320000, 17, 0),
  ('porsche-963', 'Porsche 963', 'Jordan Taylor', 165000, 58, 0),
  ('porsche-911-carrera-rsr', 'Porsche 911 Carrera RSR', 'Paul Newman', 210000, 3, 0),
  ('porsche-911-rsr', 'Porsche 911 RSR', 'Ross Bentley', 149900, 25, 0),
  ('porsche-356a', 'Porsche 356A', 'Stirling Moss', 279900, 11, 0),
  ('porsche-906', 'Porsche 906 Carrera 6', 'Jo Siffert', 349500, 8, 0),
  ('porsche-908', 'Porsche 908', 'Brian Redman', 197500, 31, 0),
  ('porsche-910', 'Porsche 910', 'Rolf Stommelen', 225000, 14, 0),
  ('porsche-718-rsk', 'Porsche 718 RSK', 'Hans Herrmann', 129900, 64, 0),
  ('porsche-718-rs-laguna', 'Porsche 718 RS Laguna Seca', 'Jean Behra', 260000, 0, 1);

INSERT INTO customers (id, name) VALUES
  (1, 'Hurley Haywood'),
  (2, 'Paul Newman'),
  (3, 'Jordan Taylor'),
  (4, 'Ross Bentley'),
  (5, 'Jacky Ickx'),
  (6, 'Brian Redman'),
  (7, 'Jo Siffert'),
  (8, 'Hans Herrmann'),
  (9, 'Vern Schuppan'),
  (10, 'Rolf Stommelen'),
  (11, 'Stirling Moss'),
  (12, 'Jean Behra');

WITH RECURSIVE seq(i) AS (
  VALUES(1)
  UNION ALL
  SELECT i + 1 FROM seq WHERE i < 160
)
INSERT INTO orders (id, date, customer, total_cents, status)
SELECT
  'IMSA-' || (1000 + i),
  date('2026-10-31', '-' || CASE WHEN i <= 80 THEN (i - 1) % 30 ELSE 30 + ((i - 81) % 30) END || ' days'),
  (SELECT name FROM customers WHERE id = ((i - 1) % 12) + 1),
  0,
  CASE
    WHEN (i - 1) % 60 = 0 THEN 'Paid'
    WHEN (i - 1) % 60 <= 2 AND i % 2 = 0 THEN 'Processing'
    WHEN i % 17 = 0 THEN 'Refunded'
    ELSE 'Shipped'
  END
FROM seq;

WITH RECURSIVE seq(i) AS (
  VALUES(1)
  UNION ALL
  SELECT i + 1 FROM seq WHERE i < 160
)
INSERT INTO order_lines (order_id, slug, quantity)
SELECT 'IMSA-' || (1000 + i),
       (SELECT slug FROM cars WHERE cars.rowid = ((i * 7) % 11) + 1),
       1 + (i % 2)
FROM seq;

INSERT INTO order_lines (order_id, slug, quantity)
SELECT 'IMSA-' || (1000 + i),
       (SELECT slug FROM cars WHERE cars.rowid = ((i * 5) % 11) + 1),
       1
FROM (WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM seq WHERE i < 160) SELECT i FROM seq)
WHERE i % 5 = 0;

UPDATE orders
SET total_cents = (
  SELECT COALESCE(SUM(cars.price_cents * order_lines.quantity), 0)
  FROM order_lines
  JOIN cars ON cars.slug = order_lines.slug
  WHERE order_lines.order_id = orders.id
);
`,
  ],

  [
    "scripts/seed-database.ts",
    `import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const databasePath = new URL("../data/racing.db", import.meta.url);
const sqlPath = new URL("../data/racing.sql", import.meta.url);

await rm(databasePath, { recursive: true, force: true }).catch((error) => {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
});

const database = new DatabaseSync(databasePath);
try {
  database.exec(await readFile(sqlPath, "utf8"));
  console.log("Seeded data/racing.db");
} finally {
  database.close();
}
`,
  ],

  [
    "src/lib/racing-db.ts",
    `export interface RacingTitle {
  slug: string;
  title: string;
  author: string;
  priceCents: number;
  stock: number;
  preorder?: boolean;
}

export interface RacingOrder {
  id: string;
  date: string;
  customer: string;
  lines: { slug: string; quantity: number }[];
  totalCents: number;
  status: "Paid" | "Processing" | "Shipped" | "Refunded";
}

const FALLBACK_TITLES: readonly RacingTitle[] = [
  { slug: "porsche-917k", title: "Porsche 917K", author: "Hurley Haywood", priceCents: 189900, stock: 42 },
  { slug: "porsche-935-moby-dick", title: "Porsche 935 Moby Dick", author: "Jacky Ickx", priceCents: 245000, stock: 6 },
  { slug: "porsche-962c", title: "Porsche 962C", author: "Vern Schuppan", priceCents: 320000, stock: 17 },
  { slug: "porsche-963", title: "Porsche 963", author: "Jordan Taylor", priceCents: 165000, stock: 58 },
  { slug: "porsche-911-carrera-rsr", title: "Porsche 911 Carrera RSR", author: "Paul Newman", priceCents: 210000, stock: 3 },
  { slug: "porsche-911-rsr", title: "Porsche 911 RSR", author: "Ross Bentley", priceCents: 149900, stock: 25 },
  { slug: "porsche-356a", title: "Porsche 356A", author: "Stirling Moss", priceCents: 279900, stock: 11 },
  { slug: "porsche-906", title: "Porsche 906 Carrera 6", author: "Jo Siffert", priceCents: 349500, stock: 8 },
  { slug: "porsche-908", title: "Porsche 908", author: "Brian Redman", priceCents: 197500, stock: 31 },
  { slug: "porsche-910", title: "Porsche 910", author: "Rolf Stommelen", priceCents: 225000, stock: 14 },
  { slug: "porsche-718-rsk", title: "Porsche 718 RSK", author: "Hans Herrmann", priceCents: 129900, stock: 64 },
  { slug: "porsche-718-rs-laguna", title: "Porsche 718 RS Laguna Seca", author: "Jean Behra", priceCents: 260000, stock: 0, preorder: true },
];

const CUSTOMERS = [
  "Hurley Haywood", "Paul Newman", "Jordan Taylor", "Ross Bentley",
  "Jacky Ickx", "Brian Redman", "Jo Siffert", "Hans Herrmann",
  "Vern Schuppan", "Rolf Stommelen", "Stirling Moss", "Jean Behra",
];

const addDays = (date: string, offset: number): string =>
  new Date(Date.parse(date + "T00:00:00Z") - offset * 86_400_000).toISOString().slice(0, 10);

const FALLBACK_ORDERS: readonly RacingOrder[] = Array.from({ length: 160 }, (_, index) => {
  const i = index + 1;
  const offset = i <= 80 ? (i - 1) % 30 : 30 + ((i - 81) % 30);
  const age = offset;
  const status = age === 0
    ? "Paid"
    : age <= 2 && i % 2 === 0
      ? "Processing"
      : i % 17 === 0
        ? "Refunded"
        : "Shipped";
  const title = FALLBACK_TITLES[(i * 7) % 11];
  const quantity = 1 + (i % 2);
  const lines = [{ slug: title.slug, quantity }];
  if (i % 5 === 0) {
    const second = FALLBACK_TITLES[(i * 5) % 11];
    lines.push({ slug: second.slug, quantity: 1 });
  }
  return {
    id: "IMSA-" + (1000 + i),
    date: addDays("2026-10-31", offset),
    customer: CUSTOMERS[(i - 1) % CUSTOMERS.length],
    lines,
    totalCents: lines.reduce((sum, line) => {
      const car = FALLBACK_TITLES.find((candidate) => candidate.slug === line.slug);
      return sum + (car?.priceCents ?? 0) * line.quantity;
    }, 0),
    status,
  };
}).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

interface SqliteModule {
  DatabaseSync: new (path: URL) => {
    exec(sql: string): unknown;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
}

let TITLES_RESULT: readonly RacingTitle[] = FALLBACK_TITLES;
let ORDERS_RESULT: readonly RacingOrder[] = FALLBACK_ORDERS;

try {
  if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function") {
    const sqlite = process.getBuiltinModule("node:sqlite") as SqliteModule | undefined;
    if (sqlite?.DatabaseSync) {
      const databaseUrl = new URL("../../data/racing.db", import.meta.url);
      const sqlUrl = new URL("../../data/racing.sql", import.meta.url);
      const fs = process.getBuiltinModule("node:fs") as {
        existsSync(path: URL): boolean;
        readFileSync(path: URL, encoding: "utf8"): string;
      };
      if (!fs.existsSync(databaseUrl)) {
        const seedDatabase = new sqlite.DatabaseSync(databaseUrl);
        try {
          seedDatabase.exec(fs.readFileSync(sqlUrl, "utf8"));
        } finally {
          seedDatabase.close();
        }
      }
      const database = new sqlite.DatabaseSync(databaseUrl);
      try {
        TITLES_RESULT = (database.prepare("SELECT slug, title, author, price_cents AS priceCents, stock, preorder FROM cars ORDER BY rowid").all() as Array<RacingTitle & { preorder: number }>).map((row) => ({ ...row, preorder: row.preorder === 1 }));
        ORDERS_RESULT = (database.prepare("SELECT id, date, customer, status FROM orders ORDER BY date DESC, id DESC").all() as Array<Omit<RacingOrder, "lines" | "totalCents">>).map((order) => {
          const lines = database.prepare("SELECT slug, quantity FROM order_lines WHERE order_id = ? ORDER BY slug").all(order.id) as { slug: string; quantity: number }[];
          const totalCents = lines.reduce((sum, line) => {
            const title = TITLES_RESULT.find((candidate) => candidate.slug === line.slug);
            return sum + (title?.priceCents ?? 0) * line.quantity;
          }, 0);
          return { ...order, lines, totalCents };
        });
      } finally {
        database.close();
      }
    }
  }
} catch {
  TITLES_RESULT = FALLBACK_TITLES;
  ORDERS_RESULT = FALLBACK_ORDERS;
}

export const TITLES: readonly RacingTitle[] = TITLES_RESULT;
export const ORDERS: readonly RacingOrder[] = ORDERS_RESULT;
`,
  ],

  [
    "src/lib/shop.ts",
    `/**
 * The bookshop's data: titles, and the orders placed for them.
 *
 * This is demo data. The orders come from a seeded generator, so every build
 * prints the same numbers, and the reporting period ends on a fixed date, not
 * today. To show real data, replace \`ORDERS\` and \`TITLES\` with what your
 * database or API returns and keep the functions below.
 */

import { ORDERS as DATABASE_ORDERS, TITLES as DATABASE_TITLES } from "./racing-db.ts";

export interface Title {
  /** The URL segment of the title's page: /titles/<slug>. */
  slug: string;
  title: string;
  author: string;
  priceCents: number;
  /** Copies in the stockroom. */
  stock: number;
  /** Announced but not on sale yet: it takes no orders. */
  preorder?: boolean;
}

export const ORDER_STATUSES = [
  "Paid",
  "Processing",
  "Shipped",
  "Refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderLine {
  slug: string;
  quantity: number;
}

export interface Order {
  id: string;
  /** The day the order was placed, as YYYY-MM-DD (UTC). */
  date: string;
  customer: string;
  lines: OrderLine[];
  totalCents: number;
  status: OrderStatus;
}

/** The last day the dashboard reports on. A fixed date keeps builds reproducible. */
export const PERIOD_END = "2026-10-31";
/** The length of the reporting period, and of the period it is compared with. */
export const PERIOD_DAYS = 30;
/** At or below this many copies a title is low on stock. */
export const LOW_STOCK = 8;

// Racing inventory and entries are loaded from data/racing.db through racing-db.ts.

/** Orders per weekday, Sunday first: the shop is busier at the weekend. */
const WEEKDAY_ORDERS: readonly number[] = [3, 1, 2, 2, 2, 3, 3];

// ─── Dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

const toTime = (date: string): number => Date.parse(\`\${date}T00:00:00Z\`);

/** The date \`days\` after \`date\` (before it, for a negative number), as YYYY-MM-DD. */
export const addDays = (date: string, days: number): string =>
  new Date(toTime(date) + days * DAY_MS).toISOString().slice(0, 10);

/** The \`days\` dates that end on \`end\`, oldest first. */
export const datesEnding = (end: string, days: number): string[] =>
  Array.from({ length: Math.max(0, days) }, (_, index) =>
    addDays(end, index - days + 1),
  );

// ─── The generator ────────────────────────────────────────────────────────────

/**
 * A small seeded random number generator (mulberry32). The same seed gives the
 * same sequence on every machine, which \`Math.random()\` cannot promise.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)];

export const titleNamed = (slug: string): Title => {
  const title = TITLES.find((candidate) => candidate.slug === slug);
  if (!title)
    throw new Error(
      \`No title has the slug "\${slug}". The slugs are listed in src/lib/shop.ts.\`,
    );
  return title;
};

const statusFor = (age: number, random: () => number): OrderStatus => {
  if (age === 0) return "Paid";
  if (age <= 2) return random() < 0.5 ? "Paid" : "Processing";
  return random() < 0.06 ? "Refunded" : "Shipped";
};

/**
 * Orders for the \`days\` days that end on \`end\`, newest first. The same
 * arguments always return the same orders.
 */
export function generateOrders(
  _seed = 20261031,
  days = PERIOD_DAYS * 2,
  end = PERIOD_END,
): Order[] {
  const from = addDays(end, 1 - days);
  return ORDERS.filter((order) => order.date >= from && order.date <= end);
}

/** Every order of the last two periods, newest first. */
export const TITLES: readonly Title[] = DATABASE_TITLES as readonly Title[];
export const ORDERS: readonly Order[] = DATABASE_ORDERS as readonly Order[];

// ─── Reading the data ─────────────────────────────────────────────────────────

/** The orders placed from \`from\` to \`to\`, both days included. */
export const ordersBetween = (
  orders: readonly Order[],
  from: string,
  to: string,
): Order[] => orders.filter((order) => order.date >= from && order.date <= to);

/** The orders of the reporting period. */
export const currentOrders = (orders: readonly Order[] = ORDERS): Order[] =>
  ordersBetween(orders, addDays(PERIOD_END, 1 - PERIOD_DAYS), PERIOD_END);

/** The orders of the period before it, for comparison. */
export const previousOrders = (orders: readonly Order[] = ORDERS): Order[] =>
  ordersBetween(
    orders,
    addDays(PERIOD_END, 1 - PERIOD_DAYS * 2),
    addDays(PERIOD_END, -PERIOD_DAYS),
  );

/** A refunded order earned nothing, so revenue and units leave it out. */
const counted = (orders: readonly Order[]): Order[] =>
  orders.filter((order) => order.status !== "Refunded");

export const revenueOf = (orders: readonly Order[]): number =>
  counted(orders).reduce((sum, order) => sum + order.totalCents, 0);

export const unitsOf = (orders: readonly Order[], slug?: string): number =>
  counted(orders)
    .flatMap((order) => order.lines)
    .filter((line) => slug === undefined || line.slug === slug)
    .reduce((sum, line) => sum + line.quantity, 0);

/** Revenue in cents for each of the \`days\` days that end on \`end\`, oldest first. */
export const dailyRevenue = (
  orders: readonly Order[] = ORDERS,
  end = PERIOD_END,
  days = PERIOD_DAYS,
): { date: string; cents: number }[] =>
  datesEnding(end, days).map((date) => ({
    date,
    cents: revenueOf(orders.filter((order) => order.date === date)),
  }));

/** Units of one title sold in each of the \`weeks\` weeks that end on \`end\`, oldest first. */
export const weeklyUnits = (
  slug: string,
  orders: readonly Order[] = ORDERS,
  end = PERIOD_END,
  weeks = 8,
): { weekOf: string; units: number }[] =>
  Array.from({ length: weeks }, (_, index) => {
    const to = addDays(end, (index - weeks + 1) * 7);
    const from = addDays(to, -6);
    return {
      weekOf: from,
      units: unitsOf(ordersBetween(orders, from, to), slug),
    };
  });

/** The titles that sold the most units, best first. */
export const topTitles = (
  orders: readonly Order[] = currentOrders(),
  limit = 6,
): { title: Title; units: number }[] =>
  TITLES.map((title) => ({ title, units: unitsOf(orders, title.slug) }))
    .filter((entry) => entry.units > 0)
    .sort(
      (a, b) => b.units - a.units || a.title.title.localeCompare(b.title.title),
    )
    .slice(0, limit);

export const ordersWithTitle = (
  slug: string,
  orders: readonly Order[] = ORDERS,
): Order[] =>
  orders.filter((order) => order.lines.some((line) => line.slug === slug));

/** Orders that still need work: paid or being packed. */
export const openOrders = (orders: readonly Order[] = ORDERS): Order[] =>
  orders.filter(
    (order) => order.status === "Paid" || order.status === "Processing",
  );

export type StockStatus = "In stock" | "Low stock" | "Preorder";

export const stockStatus = (title: Title): StockStatus =>
  title.preorder
    ? "Preorder"
    : title.stock <= LOW_STOCK
      ? "Low stock"
      : "In stock";

// ─── Formatting ───────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const wholeMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const longDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Cents as dollars: 189900 is "$1,899.00". A value that is not a number is "$0.00". */
export const formatMoney = (cents: number): string =>
  money.format(Number.isFinite(cents) ? cents / 100 : 0);

/** Cents as whole dollars, for chart axes: 189900 is "$1,899". */
export const formatWholeMoney = (cents: number): string =>
  wholeMoney.format(Number.isFinite(cents) ? cents / 100 : 0);

/** "2026-10-31" as "Oct 31, 2026". The time zone is fixed so every machine prints the same day. */
export const formatDate = (date: string): string =>
  longDate.format(toTime(date));

/** "2026-10-31" as "Oct 31". */
export const formatShortDate = (date: string): string =>
  shortDate.format(toTime(date));

export interface Change {
  direction: "up" | "down" | "flat";
  /** The change in words, so the direction never depends on color. */
  text: string;
}

/** How \`current\` compares with \`previous\`, in words. Never a division by zero. */
export function changeFrom(current: number, previous: number): Change {
  const period = \`the previous \${PERIOD_DAYS} days\`;
  if (!Number.isFinite(current) || !Number.isFinite(previous))
    return { direction: "flat", text: \`No comparison with \${period}\` };
  if (previous === 0)
    return current === 0
      ? { direction: "flat", text: \`No change from \${period}\` }
      : { direction: "up", text: \`Up from zero in \${period}\` };
  const percent =
    Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  if (percent === 0)
    return { direction: "flat", text: \`No change from \${period}\` };
  return percent > 0
    ? { direction: "up", text: \`Up \${percent}% from \${period}\` }
    : { direction: "down", text: \`Down \${Math.abs(percent)}% from \${period}\` };
}
`,
  ],

  [
    "src/lib/shop.test.ts",
    `import { describe, expect, it } from "vitest";
import {
  ORDERS,
  ORDER_STATUSES,
  PERIOD_DAYS,
  PERIOD_END,
  TITLES,
  addDays,
  changeFrom,
  currentOrders,
  dailyRevenue,
  datesEnding,
  formatDate,
  formatMoney,
  formatShortDate,
  generateOrders,
  ordersWithTitle,
  previousOrders,
  revenueOf,
  seededRandom,
  stockStatus,
  titleNamed,
  topTitles,
  unitsOf,
  weeklyUnits,
} from "./shop.ts";

describe("the seeded generator", () => {
  it("gives the same sequence for the same seed, and another for another seed", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const c = seededRandom(8);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("generates the same orders every time", () => {
    expect(generateOrders()).toEqual(generateOrders());
    expect(generateOrders()).toEqual([...ORDERS]);
    expect(generateOrders(1)).not.toEqual(generateOrders(2));
  });

  it("generates orders that add up: known titles, a correct total, a date in range, newest first", () => {
    const first = addDays(PERIOD_END, 1 - PERIOD_DAYS * 2);
    expect(ORDERS.length).toBeGreaterThan(50);
    expect(new Set(ORDERS.map((order) => order.id)).size).toBe(ORDERS.length);
    for (const order of ORDERS) {
      expect(order.id).toMatch(/^IMSA-\\d+$/);
      expect(order.date >= first && order.date <= PERIOD_END).toBe(true);
      expect(ORDER_STATUSES).toContain(order.status);
      expect(order.lines.length).toBeGreaterThan(0);
      expect(order.totalCents).toBe(
        order.lines.reduce(
          (sum, line) => sum + titleNamed(line.slug).priceCents * line.quantity,
          0,
        ),
      );
    }
    const dates = ORDERS.map((order) => order.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("asked for no days, or a negative number of them, generates no orders", () => {
    expect(generateOrders(1, 0)).toEqual([]);
    expect(generateOrders(1, -3)).toEqual([]);
    expect(datesEnding(PERIOD_END, -1)).toEqual([]);
  });

  it("never sells a title that is on preorder", () => {
    const preorder = TITLES.filter((title) => title.preorder);
    expect(preorder.length).toBeGreaterThan(0);
    for (const title of preorder) {
      expect(ordersWithTitle(title.slug)).toEqual([]);
      expect(stockStatus(title)).toBe("Preorder");
    }
  });
});

describe("reading the data", () => {
  it("splits the orders into the period and the one before it, with none in both", () => {
    const current = currentOrders();
    const previous = previousOrders();
    expect(current.length + previous.length).toBe(ORDERS.length);
    expect(current.every((order) => !previous.includes(order))).toBe(true);
  });

  it("leaves refunded orders out of revenue and units", () => {
    const [order] = ORDERS;
    const refunded = { ...order, status: "Refunded" as const };
    expect(revenueOf([order, refunded])).toBe(
      order.status === "Refunded" ? 0 : order.totalCents,
    );
    expect(revenueOf([refunded])).toBe(0);
    expect(unitsOf([refunded])).toBe(0);
    expect(revenueOf([])).toBe(0);
  });

  it("gives one figure per day, ending on the last day, that adds up to the period's revenue", () => {
    const days = dailyRevenue();
    expect(days).toHaveLength(PERIOD_DAYS);
    expect(days[days.length - 1].date).toBe(PERIOD_END);
    expect(days.reduce((sum, day) => sum + day.cents, 0)).toBe(
      revenueOf(currentOrders()),
    );
  });

  it("ranks the top titles by units, best first, and leaves out titles that sold nothing", () => {
    const top = topTitles();
    expect(top.length).toBeGreaterThan(0);
    const units = top.map((entry) => entry.units);
    expect(units).toEqual([...units].sort((a, b) => b - a));
    expect(units.every((count) => count > 0)).toBe(true);
    expect(topTitles([])).toEqual([]);
  });

  it("counts a title's weekly units, with zeros for a title nobody ordered", () => {
    const weeks = weeklyUnits("harbor-songs-for-late-arrivals");
    expect(weeks).toHaveLength(8);
    expect(weeks.every((week) => week.units === 0)).toBe(true);
  });

  it("misuse: a slug that names no title throws with the slug in the message", () => {
    expect(() => titleNamed("no-such-book")).toThrow(/"no-such-book"/);
  });
});

describe("formatting", () => {
  it("prints cents as dollars, and a value that is not a number as $0.00", () => {
    expect(formatMoney(189900)).toBe("$1,899.00");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });

  it("prints a date the same in every time zone", () => {
    expect(formatDate("2026-10-31")).toBe("Oct 31, 2026");
    expect(formatShortDate("2026-10-01")).toBe("Oct 1");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("says a change in words, with its direction", () => {
    expect(changeFrom(110, 100)).toEqual({
      direction: "up",
      text: "Up 10% from the previous 30 days",
    });
    expect(changeFrom(87.5, 100).text).toBe(
      "Down 12.5% from the previous 30 days",
    );
    expect(changeFrom(100, 100).direction).toBe("flat");
  });

  it("misuse: a comparison with zero or with a value that is not a number never prints NaN or Infinity", () => {
    for (const [current, previous] of [
      [5, 0],
      [0, 0],
      [Number.NaN, 10],
      [10, Number.NaN],
      [Number.POSITIVE_INFINITY, 10],
    ]) {
      const change = changeFrom(current, previous);
      expect(change.text).not.toMatch(/NaN|Infinity/);
      expect(["up", "down", "flat"]).toContain(change.direction);
    }
    expect(changeFrom(5, 0).direction).toBe("up");
    expect(changeFrom(0, 0).direction).toBe("flat");
  });
});
`,
  ],

  [
    "src/lib/charts.ts",
    `/**
 * Charts drawn as inline SVG, at build time or per request, with no chart
 * library and no client script. Each function returns markup built with
 * \`html\`, so a label that came from data is escaped.
 *
 * The classes (\`chart-line\`, \`chart-bar\`, ...) are styled in
 * src/pages/css/styles.css, where the colors follow the light or dark theme.
 * A chart never carries meaning by color alone: values are printed as text,
 * and \`chartTable\` gives the same numbers as a table.
 */
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartOptions {
  /** What the chart shows, read by screen readers in place of the drawing. */
  label: string;
  /** How a value is printed on an axis or a bar. */
  format?: (value: number) => string;
  /** Shown in place of the chart when there is nothing to draw. */
  emptyText?: string;
}

/** Values past this size lose whole-number precision, so they are not drawn. */
const LARGEST = Number.MAX_SAFE_INTEGER;

/** The points a chart can draw: a missing or non-finite value is left out, never drawn as zero. */
export const drawable = (points: readonly ChartPoint[]): ChartPoint[] =>
  points.filter(
    (point) => Number.isFinite(point.value) && Math.abs(point.value) <= LARGEST,
  );

/** One decimal place is finer than a screen pixel and keeps the markup short. */
const round = (value: number): number => Math.round(value * 10) / 10;

const plain = (value: number): string => String(value);

/** The step between axis ticks: 1, 2 or 5 times a power of ten. */
export function niceStep(roughStep: number): number {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(roughStep));
  const factor = roughStep / power;
  return (factor <= 1 ? 1 : factor <= 2 ? 2 : factor <= 5 ? 5 : 10) * power;
}

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * An axis that holds every value and zero, with round tick values. Values that
 * are all equal, or all zero, still get an axis with some height.
 */
export function scaleFor(values: readonly number[], tickCount = 4): Scale {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = high - low || 1;
  const step = niceStep(span / tickCount);
  const min = Math.floor(low / step) * step;
  const max = Math.max(Math.ceil(high / step) * step, min + step);
  const ticks: number[] = [];
  for (let index = 0; min + index * step <= max + step / 2; index++)
    ticks.push(Number((min + index * step).toPrecision(12)));
  return { min, max, ticks };
}

const emptyChart = (options: ChartOptions): SafeHtml =>
  html\`<p class="chart-empty">
    \${options.emptyText ?? "No data for this period."}
  </p>\`;

/** A line with the area under it filled, for a value over time. */
export function lineChart(
  points: readonly ChartPoint[],
  options: ChartOptions,
): SafeHtml {
  const series = drawable(points);
  if (series.length === 0) return emptyChart(options);
  const format = options.format ?? plain;
  const width = 640;
  const height = 260;
  const left = 64;
  const right = 28;
  const top = 16;
  const bottom = 36;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const { min, max, ticks } = scaleFor(series.map((point) => point.value));
  // One point sits in the middle; more are spread from edge to edge.
  const x = (index: number): number =>
    round(
      series.length === 1
        ? left + plotWidth / 2
        : left + (plotWidth * index) / (series.length - 1),
    );
  const y = (value: number): number =>
    round(top + (plotHeight * (max - value)) / (max - min));
  const line = series
    .map((point, index) => \`\${x(index)},\${y(point.value)}\`)
    .join(" ");
  const area = \`\${x(0)},\${y(0)} \${line} \${x(series.length - 1)},\${y(0)}\`;
  const labelEvery = Math.ceil(series.length / 6);
  const last = series.length - 1;
  return html\`<svg
    class="chart chart-wide"
    viewBox="0 0 \${width} \${height}"
    role="img"
    aria-label="\${options.label}"
  >
    \${ticks.map(
      (tick) =>
        html\`<line
            class="chart-grid"
            x1="\${left}"
            x2="\${width - right}"
            y1="\${y(tick)}"
            y2="\${y(tick)}"
          />
          <text
            class="chart-text"
            x="\${left - 8}"
            y="\${y(tick) + 4}"
            text-anchor="end"
            >\${format(tick)}</text
          >\`,
    )}
    \${series.map((point, index) =>
      index % labelEvery === 0
        ? html\`<text
            class="chart-text"
            x="\${x(index)}"
            y="\${height - 12}"
            text-anchor="middle"
            >\${point.label}</text
          >\`
        : null,
    )}
    <polygon class="chart-area" points="\${area}" />
    <polyline class="chart-line" points="\${line}" />
    <circle
      class="chart-point"
      cx="\${x(last)}"
      cy="\${y(series[last].value)}"
      r="4"
    />
  </svg>\`;
}

const shorten = (label: string, length = 34): string =>
  label.length > length ? \`\${label.slice(0, length - 1).trimEnd()}…\` : label;

/** Horizontal bars, one per point, each with its label and value printed above it. */
export function barChart(
  points: readonly ChartPoint[],
  options: ChartOptions,
): SafeHtml {
  const series = drawable(points);
  if (series.length === 0) return emptyChart(options);
  const format = options.format ?? plain;
  const width = 360;
  const rowHeight = 44;
  const barHeight = 12;
  const { min, max } = scaleFor(series.map((point) => point.value));
  const x = (value: number): number =>
    round((width * (value - min)) / (max - min));
  return html\`<svg
    class="chart chart-narrow"
    viewBox="0 0 \${width} \${series.length * rowHeight}"
    role="img"
    aria-label="\${options.label}"
  >
    \${series.map((point, index) => {
      const rowTop = index * rowHeight;
      const from = Math.min(x(0), x(point.value));
      const length = round(Math.abs(x(point.value) - x(0)));
      return html\`<text class="chart-text" x="0" y="\${rowTop + 16}"
          >\${shorten(point.label)}</text
        >
        <text
          class="chart-text chart-value"
          x="\${width}"
          y="\${rowTop + 16}"
          text-anchor="end"
          >\${format(point.value)}</text
        >
        <rect
          class="chart-track"
          x="0"
          y="\${rowTop + 24}"
          width="\${width}"
          height="\${barHeight}"
          rx="3"
        />
        <rect
          class="chart-bar"
          x="\${from}"
          y="\${rowTop + 24}"
          width="\${length}"
          height="\${barHeight}"
          rx="3"
        />\`;
    })}
  </svg>\`;
}

/** The same points as a table, for readers who cannot see the chart or want the exact numbers. */
export function chartTable(
  points: readonly ChartPoint[],
  options: {
    caption: string;
    labelHeading: string;
    valueHeading: string;
    format?: (value: number) => string;
  },
): SafeHtml {
  const format = options.format ?? plain;
  return html\`<table class="data-table">
    <caption>
      \${options.caption}
    </caption>
    <thead>
      <tr>
        <th scope="col">\${options.labelHeading}</th>
        <th scope="col" class="number">\${options.valueHeading}</th>
      </tr>
    </thead>
    <tbody>
      \${
        points.length === 0
          ? html\`<tr>
              <td colspan="2">No data for this period.</td>
            </tr>\`
          : points.map(
              (point) =>
                html\`<tr>
                  <th scope="row">\${point.label}</th>
                  <td class="number">
                    \${
                      Number.isFinite(point.value)
                        ? format(point.value)
                        : "Not available"
                    }
                  </td>
                </tr>\`,
            )
      }
    </tbody>
  </table>\`;
}
`,
  ],

  [
    "src/lib/charts.test.ts",
    `import { describe, expect, it } from "vitest";
import {
  barChart,
  chartTable,
  drawable,
  lineChart,
  niceStep,
  scaleFor,
  type ChartPoint,
} from "./charts.ts";

const points = (...values: number[]): ChartPoint[] =>
  values.map((value, index) => ({ label: \`Day \${index + 1}\`, value }));

const options = { label: "Copies sold per day" };

/** Every number in the markup's geometry attributes. */
const numbersIn = (markup: string): number[] =>
  [...markup.matchAll(/\\b(?:x|y|x1|x2|y1|y2|cx|cy|width|height)="([^"]*)"/g)]
    .map((match) => Number(match[1]))
    .concat(
      [...markup.matchAll(/points="([^"]*)"/g)].flatMap((match) =>
        match[1].split(/[ ,]+/).map(Number),
      ),
    );

/** A chart that drew: one <svg> with a viewBox and a label, and only finite numbers in it. */
const expectDrawn = (markup: string): void => {
  expect(markup).toMatch(/^<svg\\b[^>]*\\bviewBox="0 0 \\d+ \\d+"/);
  expect(markup).toContain('role="img"');
  expect(markup).toContain('aria-label="Copies sold per day"');
  expect(markup.match(/<svg\\b/g)).toHaveLength(1);
  expect(markup.trimEnd().endsWith("</svg>")).toBe(true);
  expect(markup).not.toMatch(/NaN|Infinity|undefined/);
  const numbers = numbersIn(markup);
  expect(numbers.length).toBeGreaterThan(0);
  expect(numbers.every((value) => Number.isFinite(value))).toBe(true);
};

describe.each([
  ["lineChart", lineChart],
  ["barChart", barChart],
] as const)("%s", (_name, chart) => {
  it("draws a series as SVG with a viewBox, a label, and finite numbers", () => {
    expectDrawn(String(chart(points(3, 9, 4, 12), options)));
  });

  it("misuse: an empty series is a written empty state, not an empty drawing", () => {
    const markup = String(chart([], options));
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("No data for this period.");
    expect(
      String(chart([], { ...options, emptyText: "Nothing yet" })),
    ).toContain("Nothing yet");
  });

  it("draws a single point", () => {
    expectDrawn(String(chart(points(7), options)));
  });

  it("draws values that are all equal, and values that are all zero", () => {
    expectDrawn(String(chart(points(5, 5, 5), options)));
    expectDrawn(String(chart(points(0, 0, 0), options)));
  });

  it("draws zero and negative values", () => {
    expectDrawn(String(chart(points(-4, 0, 6, -2), options)));
    expectDrawn(String(chart(points(-4, -9), options)));
  });

  it("misuse: leaves out values that are not finite, and shows the empty state when none is left", () => {
    expectDrawn(
      String(
        chart(
          points(2, Number.NaN, 8, Number.POSITIVE_INFINITY, 1e300),
          options,
        ),
      ),
    );
    const none = String(
      chart(points(Number.NaN, Number.NEGATIVE_INFINITY), options),
    );
    expect(none).not.toContain("<svg");
    expect(none).not.toMatch(/NaN|Infinity/);
  });

  it("escapes a label that came from data", () => {
    const markup = String(
      chart([{ label: '<img src=x onerror="alert(1)">', value: 2 }], {
        label: 'Sales of "Tom & Ann"',
      }),
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).toContain("Tom &amp; Ann");
  });
});

describe("lineChart", () => {
  it("draws one line point per value, inside the viewBox", () => {
    const markup = String(lineChart(points(1, 2, 3, 4, 5), options));
    const line = /<polyline[^>]*points="([^"]*)"/.exec(markup)![1].split(" ");
    expect(line).toHaveLength(5);
    for (const pair of line) {
      const [x, y] = pair.split(",").map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(640);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(260);
    }
  });
});

describe("barChart", () => {
  it("prints each value as text, so a bar's length is never the only way to read it", () => {
    const markup = String(
      barChart(points(3, 12), {
        ...options,
        format: (value) => \`\${value} sold\`,
      }),
    );
    expect(markup).toContain("3 sold");
    expect(markup).toContain("12 sold");
  });

  it("never gives a bar a negative width", () => {
    const markup = String(barChart(points(-5, 5, 0), options));
    const widths = [...markup.matchAll(/width="([^"]*)"/g)].map((match) =>
      Number(match[1]),
    );
    expect(widths.every((width) => width >= 0)).toBe(true);
  });
});

describe("the axis", () => {
  it("steps by 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(0.3)).toBeCloseTo(0.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(12)).toBe(20);
    expect(niceStep(100)).toBe(100);
  });

  it("misuse: a step of zero, a negative step, or one that is not a number is 1", () => {
    for (const step of [0, -2, Number.NaN, Number.POSITIVE_INFINITY])
      expect(niceStep(step)).toBe(1);
  });

  it("always holds zero and every value, and always has some height", () => {
    for (const values of [[], [0], [5, 5], [-3, -1], [2, 950], [0.1, 0.25]]) {
      const { min, max, ticks } = scaleFor(values);
      expect(max).toBeGreaterThan(min);
      expect(min).toBeLessThanOrEqual(Math.min(0, ...values));
      expect(max).toBeGreaterThanOrEqual(Math.max(0, ...values));
      expect(ticks.length).toBeGreaterThan(1);
      expect(ticks.every((tick) => Number.isFinite(tick))).toBe(true);
    }
  });

  it("keeps only the points it can draw", () => {
    expect(drawable(points(1, Number.NaN, 2)).map((p) => p.value)).toEqual([
      1, 2,
    ]);
  });
});

describe("chartTable", () => {
  const table = {
    caption: "Copies",
    labelHeading: "Day",
    valueHeading: "Copies",
  };

  it("gives every point a row with a row heading, under column headings and a caption", () => {
    const markup = String(chartTable(points(3, 9), table));
    expect(markup).toMatch(/<caption>\\s*Copies\\s*<\\/caption>/);
    expect(markup.match(/scope="col"/g)).toHaveLength(2);
    expect(markup.match(/scope="row"/g)).toHaveLength(2);
  });

  it("misuse: says so when there is no data, and never prints NaN for a value that is not a number", () => {
    expect(String(chartTable([], table))).toContain("No data for this period.");
    const markup = String(chartTable(points(Number.NaN), table));
    expect(markup).toContain("Not available");
    expect(markup).not.toContain("NaN");
  });
});
`,
  ],

  [
    "src/lib/order-table.ts",
    `/**
 * Order tables, shared by the overview, the orders page and each title's page.
 * The rows are built at build time, so every one is in the page without
 * JavaScript. The \`data-*\` attributes on a row hold its values in a form a
 * script can sort by; <orders-table> reads them.
 */
import { html, type SafeHtml } from "@bascik/bascik/html";
import { formatDate, formatMoney, titleNamed, type Order } from "./shop.ts";

const COLUMNS = 6;

const lineItems = (order: Order): SafeHtml[] =>
  order.lines.map((line, index) => {
    const title = titleNamed(line.slug);
    return html\`\${index > 0 ? ", " : ""}<a href="/titles/\${title.slug}"
        >\${title.title}</a
      >\${line.quantity > 1 ? \` × \${line.quantity}\` : ""}\`;
  });

/** One \`<tr>\` per order, or one row that says there are none. */
export function orderRows(
  orders: readonly Order[],
  emptyText = "No orders yet.",
): SafeHtml {
  if (orders.length === 0)
    return html\`<tr class="empty-row">
      <td colspan="\${COLUMNS}">\${emptyText}</td>
    </tr>\`;
  return html\`\${orders.map(
    (order) =>
      html\`<tr
        data-order="\${order.id}"
        data-date="\${order.date}"
        data-customer="\${order.customer}"
        data-total="\${order.totalCents}"
        data-status="\${order.status}"
      >
        <th scope="row">\${order.id}</th>
        <td><time datetime="\${order.date}">\${formatDate(order.date)}</time></td>
        <td>\${order.customer}</td>
        <td>\${lineItems(order)}</td>
        <td class="number">\${formatMoney(order.totalCents)}</td>
        <td>
          <status-badge
            data-bascik-prop-status="\${order.status}"
          ></status-badge>
        </td>
      </tr>\`,
  )}\`;
}

/** A whole table of orders with a caption. An empty list still gives a table, with one row saying so. */
export function orderTable(
  orders: readonly Order[],
  options: { caption: string; emptyText?: string },
): SafeHtml {
  return html\`<table class="data-table data-table-wide">
    <caption>
      \${options.caption}
    </caption>
    <thead>
      <tr>
        <th scope="col">Order</th>
        <th scope="col">Date</th>
        <th scope="col">Customer</th>
        <th scope="col">Titles</th>
        <th scope="col" class="number">Total</th>
        <th scope="col">Status</th>
      </tr>
    </thead>
    <tbody>
      \${orderRows(orders, options.emptyText)}
    </tbody>
  </table>\`;
}
`,
  ],

  [
    "src/lib/order-table.test.ts",
    `import { describe, expect, it } from "vitest";
import { orderRows, orderTable } from "./order-table.ts";
import { ORDERS, type Order } from "./shop.ts";

const order: Order = {
  id: "IMSA-1001",
  date: "2026-10-31",
  customer: 'Tom & "Ann" <b>',
  lines: [
    { slug: "the-lighthouse-ledger", quantity: 2 },
    { slug: "the-tin-kite-society", quantity: 1 },
  ],
  totalCents: 5097,
  status: "Paid",
};

describe("orderRows", () => {
  it("prints one row per order, with the values a script sorts by", () => {
    const markup = String(orderRows(ORDERS.slice(0, 3)));
    expect(markup.match(/<tr\\b/g)).toHaveLength(3);
    expect(markup).toContain(\`data-order="\${ORDERS[0].id}"\`);
    expect(markup).toContain(\`data-total="\${ORDERS[0].totalCents}"\`);
    expect(markup).toContain(\`<time datetime="\${ORDERS[0].date}">\`);
    expect(markup.match(/<th scope="row">/g)).toHaveLength(3);
  });

  it("links each title, shows a quantity above one, and hands the status to <status-badge>", () => {
    const markup = String(orderRows([order]));
    expect(markup).toContain('href="/titles/the-lighthouse-ledger"');
    expect(markup).toContain("× 2");
    expect(markup).toContain("$50.97");
    expect(markup).toMatch(/<status-badge\\s+data-bascik-prop-status="Paid"/);
  });

  it("escapes a customer name that holds markup", () => {
    const markup = String(orderRows([order]));
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("Tom &amp; &quot;Ann&quot; &lt;b&gt;");
  });

  it("misuse: no orders gives one row that says so, across every column", () => {
    const markup = String(orderRows([], "Nothing here."));
    expect(markup.match(/<tr\\b/g)).toHaveLength(1);
    expect(markup).toContain('colspan="6"');
    expect(markup).toContain("Nothing here.");
  });

  it("misuse: an order for a title that does not exist throws instead of printing a broken row", () => {
    expect(() =>
      orderRows([{ ...order, lines: [{ slug: "gone", quantity: 1 }] }]),
    ).toThrow(/"gone"/);
  });
});

describe("orderTable", () => {
  it("wraps the rows in a table with a caption and six column headings", () => {
    const markup = String(orderTable([order], { caption: "Newest orders" }));
    expect(markup).toMatch(/<caption>\\s*Newest orders\\s*<\\/caption>/);
    expect(markup.match(/scope="col"/g)).toHaveLength(6);
  });

  it("still gives a whole table when there are no orders", () => {
    const markup = String(
      orderTable([], { caption: "Orders", emptyText: "No orders yet." }),
    );
    expect(markup).toContain("<thead>");
    expect(markup).toContain("No orders yet.");
  });
});
`,
  ],

  [
    "src/lib/site.test.ts",
    `import { describe, expect, it } from "vitest";
import { SITE_NAME, pageTitle } from "./site.ts";

describe("pageTitle", () => {
  it("prints the page's name, then the site's", () => {
    const title = String(pageTitle("Orders"));
    expect(title.startsWith("<title>Orders - ")).toBe(true);
    expect(title.endsWith("</title>")).toBe(true);
    expect(SITE_NAME.length).toBeGreaterThan(0);
  });

  it("escapes a page name that holds markup", () => {
    const title = String(pageTitle("</title><script>alert(1)</script>"));
    expect(title).not.toContain("<script>");
    expect(title.match(/<\\/title>/g)).toHaveLength(1);
  });
});
`,
  ],
];
