import { describe, expect, it } from "vitest";
import {
  databaseProcessId,
  dataTools,
  MAX_REPLY_BYTES,
  MAX_VALUE_CHARS,
  runSql,
} from "./data-tools.ts";

const runTool = (sql: string) =>
  dataTools.find((candidate) => candidate.name === "run_sql")!.run!(
    { sql },
    {},
  );

/** Run `work` while a 10 ms timer ticks, and return the longest gap between ticks. */
async function longestLoopGap(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  try {
    await work().catch(() => undefined);
    const now = performance.now();
    return Math.max(longest, now - last);
  } finally {
    clearInterval(ticker);
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runSql", () => {
  it("answers a SELECT with columns and rows", async () => {
    const result = await runSql("SELECT COUNT(*) AS books FROM books;");
    expect(result).toEqual({
      columns: ["books"],
      rows: [[40]],
      truncated: false,
    });
  });

  it("builds the same data on every start", async () => {
    const top = await runSql(
      "SELECT b.title, SUM(o.quantity) AS units FROM orders o JOIN books b ON b.id = o.book_id GROUP BY b.id ORDER BY units DESC, b.id LIMIT 1",
    );
    expect(top.rows).toHaveLength(1);
    expect((await runSql("SELECT COUNT(*) FROM orders")).rows).toEqual([
      [6000],
    ]);
  });

  it("returns at most 200 rows and says when it cut the result", async () => {
    const result = await runSql("SELECT id FROM orders");
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("still answers a CTE that does not refer to itself", async () => {
    const result = await runSql(
      "WITH cheap AS (SELECT id FROM books WHERE price < 1000) SELECT COUNT(*) AS n FROM cheap",
    );
    expect(result.columns).toEqual(["n"]);
  });

  it.each([
    "DELETE FROM books",
    "DROP TABLE books",
    "UPDATE books SET price = 0",
    "PRAGMA query_only = OFF",
    "ATTACH DATABASE 'x.db' AS x",
    "SELECT 1; DROP TABLE books",
    "WITH gone AS (SELECT 1) DELETE FROM books",
    "INSERT INTO books(id) VALUES (999)",
  ])("refuses %s", async (sql) => {
    await expect(runSql(sql)).rejects.toThrow();
    expect((await runSql("SELECT COUNT(*) FROM books")).rows).toEqual([[40]]);
  });

  it.each([
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
    "with recursive c(x) as (select 1 union all select x+1 from c limit 5) select * from c",
    // SQLite treats a CTE that names itself as recursive without the keyword.
    "WITH c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
  ])("refuses a recursive query: %s", async (sql) => {
    await expect(runSql(sql)).rejects.toThrow(/Recursive queries/);
  });

  it("stops a query that runs past its deadline and keeps answering", async () => {
    await runSql("SELECT 1");
    const slowPid = databaseProcessId()!;
    // Every timer in this test would never fire if the query blocked the thread.
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    try {
      const started = Date.now();
      await expect(
        runSql("SELECT count(*) FROM orders a, orders b, orders c, orders d", {
          timeoutMs: 300,
        }),
      ).rejects.toThrow(/ran longer than 300 ms/);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(ticker);
    }
    // The stopped query does not keep running anywhere.
    await expect.poll(() => isRunning(slowPid)).toBe(false);
    // A fresh process answers the next query with the same data.
    expect((await runSql("SELECT COUNT(*) FROM orders")).rows).toEqual([
      [6000],
    ]);
    expect(databaseProcessId()).not.toBe(slowPid);
  });

  it("is the tool the model calls", async () => {
    const tool = dataTools.find((candidate) => candidate.name === "run_sql")!;
    const output = await tool.run!({ sql: "SELECT 1 AS one" }, {});
    expect(JSON.parse(output)).toEqual({
      columns: ["one"],
      rows: [[1]],
      truncated: false,
    });
  });

  describe("keeps the reply small", () => {
    // The probe from the security review: SQLite answers at once, and the
    // cost lands on whoever copies and serializes the reply.
    it.each([
      "SELECT zeroblob(4000000) FROM orders LIMIT 200",
      "SELECT zeroblob(2000000) FROM orders LIMIT 200",
      "SELECT zeroblob(150000) FROM orders LIMIT 200",
      "SELECT zeroblob(900000) AS a, zeroblob(900000) AS b FROM orders LIMIT 200",
      "SELECT printf('%.*c', 900000, 'x') FROM orders LIMIT 200",
      "SELECT randomblob(500000), * FROM orders LIMIT 200",
    ])("does not block the server's event loop: %s", async (sql) => {
      let output = "";
      const gap = await longestLoopGap(async () => {
        output = await runTool(sql);
      });
      expect(gap).toBeLessThan(500);
      expect(output.length).toBeLessThanOrEqual(MAX_REPLY_BYTES);
      // The server keeps answering afterwards.
      expect((await runSql("SELECT COUNT(*) FROM books")).rows).toEqual([[40]]);
    });

    it("replaces a blob with a short placeholder", async () => {
      const result = await runSql("SELECT zeroblob(150000) AS b, x'abcd' AS h");
      expect(result.rows).toEqual([
        ["[blob, 150000 bytes, not shown]", "[blob, 2 bytes, not shown]"],
      ]);
    });

    it("cuts a long text value and says so", async () => {
      const result = await runSql("SELECT printf('%.*c', 50000, 'x') AS t");
      const value = result.rows[0]![0] as string;
      expect(value.startsWith("x".repeat(MAX_VALUE_CHARS))).toBe(true);
      expect(value.slice(MAX_VALUE_CHARS)).toBe(
        " [cut, 50000 characters in all]",
      );
      expect(result.truncated).toBe(true);
    });

    it("cuts a long column name", async () => {
      const name = "n".repeat(5000);
      const result = await runSql(`SELECT 1 AS "${name}"`);
      expect(result.columns[0]!.length).toBeLessThan(MAX_VALUE_CHARS + 100);
    });

    it("stops adding rows at the byte budget and says so", async () => {
      const result = await runSql(
        `SELECT printf('%.*c', ${MAX_VALUE_CHARS}, 'x') FROM orders LIMIT 200`,
      );
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows.length).toBeLessThan(200);
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(
        MAX_REPLY_BYTES,
      );
    });

    it("refuses one value too big to build", async () => {
      await expect(
        runSql("SELECT zeroblob(4000000), printf('%.*c', 4000000, 'x')"),
      ).rejects.toThrow(/too big/);
    });

    it("leaves numbers and short text alone", async () => {
      const result = await runSql(
        "SELECT 1.5 AS n, NULL AS z, 'short' AS s, 9007199254740991 AS big",
      );
      expect(result).toEqual({
        columns: ["n", "z", "s", "big"],
        rows: [[1.5, null, "short", 9007199254740991]],
        truncated: false,
      });
    });
  });
});
