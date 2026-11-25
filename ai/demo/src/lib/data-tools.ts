/**
 * A small bookshop database (SQLite, in memory, seeded the same way on every
 * start) and one read-only query tool over it.
 */
import { DatabaseSync } from "node:sqlite";
import type { Tool } from "@bascik/ai";

export const SCHEMA = `
books(id INTEGER, title TEXT, author TEXT, genre TEXT, price REAL, pages INTEGER, year INTEGER)
orders(id INTEGER, book_id INTEGER REFERENCES books(id), quantity INTEGER, ordered_on TEXT /* YYYY-MM-DD, 2025-01-01 to 2026-06-30 */, region TEXT /* North, South, East, West */, channel TEXT /* web, store, partner */)
`.trim();

const AUTHORS = [
  "Grace Lin",
  "Ada Okafor",
  "Sam Rivera",
  "Mina Park",
  "Noor Haddad",
  "Ivo Marek",
  "Lena Fischer",
  "Tariq Aziz",
];
const GENRES = ["Engineering", "Design", "Fiction", "History", "Science"];
const TITLE_STARTS = [
  "Refactoring",
  "Practical",
  "Shipping",
  "Quiet",
  "Designing",
  "A History of",
  "Notes on",
  "Beyond",
];
const TITLE_ENDS = [
  "Monoliths",
  "Type Systems",
  "Small Changes",
  "Network",
  "Interfaces",
  "Measurement",
  "Deep Time",
  "Compilers",
];

/** A fixed-seed generator, so every start builds the same data. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE books(id INTEGER PRIMARY KEY, title TEXT, author TEXT, genre TEXT, price REAL, pages INTEGER, year INTEGER);
    CREATE TABLE orders(id INTEGER PRIMARY KEY, book_id INTEGER REFERENCES books(id), quantity INTEGER, ordered_on TEXT, region TEXT, channel TEXT);
    CREATE INDEX orders_book ON orders(book_id);
  `);
  const random = seeded(42);
  const pick = <T>(values: T[]): T =>
    values[Math.floor(random() * values.length)]!;
  const addBook = db.prepare("INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?)");
  const titles = new Set<string>();
  for (let id = 1; id <= 40; id++) {
    let title = "";
    do title = `${pick(TITLE_STARTS)} ${pick(TITLE_ENDS)}`;
    while (titles.has(title));
    titles.add(title);
    addBook.run(
      id,
      title,
      pick(AUTHORS),
      pick(GENRES),
      Math.round(900 + random() * 3600) / 100,
      120 + Math.floor(random() * 480),
      2015 + Math.floor(random() * 11),
    );
  }
  const addOrder = db.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)");
  const start = Date.UTC(2025, 0, 1);
  const days = 546;
  db.exec("BEGIN");
  for (let id = 1; id <= 6000; id++) {
    // A few books sell far more than the rest, and sales grow over time.
    const book = 1 + Math.floor(random() ** 2.2 * 40);
    const day = Math.floor(Math.sqrt(random()) * days);
    addOrder.run(
      id,
      book,
      1 + Math.floor(random() ** 3 * 5),
      new Date(start + day * 86_400_000).toISOString().slice(0, 10),
      pick(["North", "South", "East", "West"]),
      pick(["web", "web", "web", "store", "store", "partner"]),
    );
  }
  db.exec("COMMIT");
  // From here on the connection refuses every write.
  db.exec("PRAGMA query_only = ON");
  return db;
}

let database: DatabaseSync | undefined;
const MAX_ROWS = 200;

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** Run one read-only SELECT and return at most 200 rows. */
export function runSql(sql: string): QueryResult {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(statement)) {
    throw new Error("Only a SELECT statement is allowed.");
  }
  if (statement.includes(";")) {
    throw new Error("Send one statement, with no semicolons inside it.");
  }
  database ??= createDatabase();
  const prepared = database.prepare(
    `SELECT * FROM (${statement}) LIMIT ${MAX_ROWS + 1}`,
  );
  const records = prepared.all() as Record<string, unknown>[];
  const columns = prepared.columns().map((column) => column.name);
  return {
    columns,
    rows: records
      .slice(0, MAX_ROWS)
      .map((record) => columns.map((column) => record[column])),
    truncated: records.length > MAX_ROWS,
  };
}

export const dataTools: Tool[] = [
  {
    name: "run_sql",
    description: `Run one read-only SQLite SELECT against the bookshop database and get the result as JSON: {columns, rows, truncated}. At most ${MAX_ROWS} rows come back, so aggregate in SQL. Revenue is quantity * price. Schema:\n${SCHEMA}`,
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "One SELECT statement" },
      },
      required: ["sql"],
    },
    note: () => `<tool-note>Querying the database</tool-note>`,
    run: (input) => JSON.stringify(runSql(String(input.sql))),
  },
];
