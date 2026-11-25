/**
 * A small bookshop database (SQLite, in memory, seeded the same way on every
 * start) and one read-only query tool over it.
 *
 * The model writes the SQL, so a query can be slow on purpose: a recursive
 * CTE that never ends, or a cross join of the orders table with itself a few
 * times. node:sqlite runs a statement synchronously, with no time limit and
 * no progress handler, so the database lives in a child process. A query
 * that runs past its deadline is stopped by killing that process, and the
 * next query starts a fresh one. A worker thread would not do: terminating
 * one cannot interrupt SQLite's native loop, so the thread would keep a CPU
 * core busy forever. The server's own process never runs model-written SQL.
 *
 * A fast query can still return a huge result (200 rows of a 4 MB zeroblob),
 * and copying and serializing that on the server would block its event loop
 * for a minute. So the child caps the reply before it sends it: values SQLite
 * may build, rows, bytes of JSON, and the length of each text value, with
 * blobs replaced by a short placeholder.
 */
import { fork, type ChildProcess } from "node:child_process";
import { constants, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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

const MAX_ROWS = 200;
/** The longest text value, in characters, a reply carries; longer ones are cut. */
export const MAX_VALUE_CHARS = 1000;
/** The longest column name, in characters, a reply carries. */
const MAX_NAME_CHARS = 200;
/** The largest reply, in UTF-8 bytes of its JSON; rows past it are dropped. */
export const MAX_REPLY_BYTES = 64_000;
/**
 * The largest string or blob SQLite may build while it runs a query. A
 * bigger one fails the query inside the child, before it is copied anywhere.
 */
const MAX_SQLITE_VALUE_BYTES = 1_000_000;
/** How long one query may run before its process is stopped. */
export const QUERY_TIMEOUT_MS = 2000;
const CHILD_FLAG = "--bascik-data-tools-database";
/** SQLITE_AUTH: the authorizer refused the statement. */
const SQLITE_AUTH = 23;
/** SQLITE_TOOBIG: a string or blob passed the length limit. */
const SQLITE_TOOBIG = 18;

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** Check that `sql` is one SELECT, and return it without a final semicolon. */
function selectStatement(sql: string): string {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(statement)) {
    throw new Error("Only a SELECT statement is allowed.");
  }
  if (statement.includes(";")) {
    throw new Error("Send one statement, with no semicolons inside it.");
  }
  return statement;
}

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

function cutText(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)} [cut, ${text.length} characters in all]`
    : text;
}

/**
 * Turn one SQLite value into something small and safe to send: a blob
 * becomes a placeholder (serialized, a Uint8Array writes one key per byte),
 * and long text is cut with a marker.
 */
function replyValue(value: unknown): { value: unknown; cut: boolean } {
  if (value instanceof Uint8Array) {
    return {
      value: `[blob, ${value.byteLength} bytes, not shown]`,
      cut: false,
    };
  }
  if (typeof value === "bigint") return { value: String(value), cut: false };
  if (typeof value === "string" && value.length > MAX_VALUE_CHARS) {
    return { value: cutText(value, MAX_VALUE_CHARS), cut: true };
  }
  return { value, cut: false };
}

/**
 * Run a checked statement on the child process's database. Rows are read one
 * at a time and the reply stops at MAX_ROWS rows or MAX_REPLY_BYTES, so what
 * the child sends, and what the server copies and serializes, stays small.
 */
function query(database: DatabaseSync, statement: string): QueryResult {
  let prepared;
  try {
    prepared = database.prepare(
      `SELECT * FROM (${statement}) LIMIT ${MAX_ROWS + 1}`,
    );
  } catch (error) {
    if ((error as { errcode?: unknown }).errcode === SQLITE_AUTH) {
      throw new Error(
        "Recursive queries are not allowed. Write the query without a CTE that refers to itself.",
      );
    }
    throw error;
  }
  prepared.setReturnArrays(true);
  const columns = prepared
    .columns()
    .map((column) => cutText(column.name, MAX_NAME_CHARS));
  const rows: unknown[][] = [];
  let truncated = false;
  let bytes = jsonBytes({ columns, rows: [], truncated: true });
  if (bytes > MAX_REPLY_BYTES) {
    throw new Error(
      `The result's column names alone are larger than ${MAX_REPLY_BYTES} bytes. Select fewer columns.`,
    );
  }
  try {
    for (const record of prepared.iterate() as Iterable<unknown[]>) {
      if (rows.length === MAX_ROWS) {
        truncated = true;
        break;
      }
      const row = record.map((cell) => {
        const { value, cut } = replyValue(cell);
        if (cut) truncated = true;
        return value;
      });
      const rowBytes = jsonBytes(row) + (rows.length > 0 ? 1 : 0);
      if (bytes + rowBytes > MAX_REPLY_BYTES) {
        if (rows.length === 0) {
          throw new Error(
            `One row of the result is larger than ${MAX_REPLY_BYTES} bytes. Select fewer or shorter columns.`,
          );
        }
        truncated = true;
        break;
      }
      bytes += rowBytes;
      rows.push(row);
    }
  } catch (error) {
    if ((error as { errcode?: unknown }).errcode === SQLITE_TOOBIG) {
      throw new Error(
        `A value in the query is too big: SQLite builds strings and blobs of at most ${MAX_SQLITE_VALUE_BYTES} bytes here. Return smaller values.`,
      );
    }
    throw error;
  }
  return { columns, rows, truncated };
}

type DatabaseReply =
  { ready: true } | { result: QueryResult } | { error: string };

/** The child's side: build the database, then answer one query at a time. */
function serveQueries(): void {
  const database = createDatabase();
  // A query that builds a huge value fails here, in the child, at once.
  database.limits.length = MAX_SQLITE_VALUE_BYTES;
  // A recursive CTE can produce rows forever, so the connection refuses one,
  // whether or not the query spells out RECURSIVE.
  database.setAuthorizer((action) =>
    action === constants.SQLITE_RECURSIVE
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  process.on("message", (statement: string) => {
    let reply: DatabaseReply;
    try {
      reply = { result: query(database, statement) };
    } catch (error) {
      reply = { error: error instanceof Error ? error.message : String(error) };
    }
    process.send!(reply);
  });
  // The server went away, so this process has nobody to answer.
  process.on("disconnect", () => process.exit(0));
  process.send!({ ready: true } satisfies DatabaseReply);
}

if (process.argv.includes(CHILD_FLAG) && typeof process.send === "function") {
  serveQueries();
}

interface DatabaseProcess {
  child: ChildProcess;
  ready: Promise<void>;
}

let current: DatabaseProcess | undefined;
// Queries run one at a time, so each deadline measures only its own query.
let queue: Promise<unknown> = Promise.resolve();

/** Let an idle child, or a busy one, decide whether the server stays up. */
function holdOpen(child: ChildProcess, busy: boolean): void {
  const channel = child.channel as
    { ref?: () => void; unref?: () => void } | null | undefined;
  if (busy) {
    child.ref();
    channel?.ref?.();
  } else {
    child.unref();
    channel?.unref?.();
  }
}

function startProcess(): DatabaseProcess {
  const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG], {
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // A failed send or spawn is reported to the query; never crash the server.
  child.on("error", () => undefined);
  const kill = () => child.kill("SIGKILL");
  process.once("exit", kill);
  child.once("exit", () => process.off("exit", kill));
  holdOpen(child, false);
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onFailure);
      child.off("exit", onFailure);
    };
    const onMessage = (reply: DatabaseReply) => {
      if ("ready" in reply) {
        cleanup();
        resolve();
      }
    };
    const onFailure = (error?: unknown) => {
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error("The database process stopped while starting."),
      );
    };
    child.on("message", onMessage);
    child.on("error", onFailure);
    child.on("exit", onFailure);
  });
  return { child, ready };
}

/** Send one statement to the child and wait at most `timeoutMs` for rows. */
async function ask(statement: string, timeoutMs: number): Promise<QueryResult> {
  const running = (current ??= startProcess());
  const { child } = running;
  const discard = () => {
    if (current === running) current = undefined;
  };
  holdOpen(child, true);
  try {
    await running.ready;
  } catch (error) {
    discard();
    holdOpen(child, false);
    throw error;
  }
  return new Promise<QueryResult>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onFailure);
      child.off("exit", onFailure);
      holdOpen(child, false);
      settle();
    };
    const onMessage = (reply: DatabaseReply) => {
      if ("result" in reply) finish(() => resolve(reply.result));
      else if ("error" in reply) finish(() => reject(new Error(reply.error)));
    };
    const onFailure = (error?: unknown) => {
      if (settled) return;
      discard();
      child.kill("SIGKILL");
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error("The database process stopped during the query."),
        ),
      );
    };
    const timer = setTimeout(() => {
      discard();
      // Only killing the process stops SQLite mid-statement.
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new Error(
            `The query ran longer than ${timeoutMs} ms and was stopped. Write a smaller query.`,
          ),
        ),
      );
    }, timeoutMs);
    child.on("message", onMessage);
    child.on("error", onFailure);
    child.on("exit", onFailure);
    child.send(statement, (error) => {
      if (error) onFailure(error);
    });
  });
}

/** The process id of the database process, if one is running (for tests). */
export function databaseProcessId(): number | undefined {
  return current?.child.pid;
}

export interface RunSqlOptions {
  /** How long the query may run, in milliseconds. */
  timeoutMs?: number;
}

/**
 * Run one read-only SELECT and return at most 200 rows and 64,000 bytes of
 * JSON, with blobs shown as placeholders and long text cut. It runs in a
 * child process, and a query that runs longer than `timeoutMs` (2 seconds by
 * default) is stopped and rejected.
 */
export function runSql(
  sql: string,
  options: RunSqlOptions = {},
): Promise<QueryResult> {
  let statement: string;
  try {
    statement = selectStatement(sql);
  } catch (error) {
    return Promise.reject(error);
  }
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  const result = queue.then(() => ask(statement, timeoutMs));
  queue = result.catch(() => undefined);
  return result;
}

export const dataTools: Tool[] = [
  {
    name: "run_sql",
    description: `Run one read-only SQLite SELECT against the bookshop database and get the result as JSON: {columns, rows, truncated}. At most ${MAX_ROWS} rows and ${MAX_REPLY_BYTES} bytes come back, blobs show as placeholders, and text over ${MAX_VALUE_CHARS} characters is cut, so aggregate in SQL. Revenue is quantity * price. Schema:\n${SCHEMA}`,
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "One SELECT statement" },
      },
      required: ["sql"],
    },
    note: () => `<tool-note>Querying the database</tool-note>`,
    run: async (input) => JSON.stringify(await runSql(String(input.sql))),
  },
];
