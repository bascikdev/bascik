import { describe, expect, it } from "vitest";
import { dataTools, runSql } from "./data-tools.ts";

describe("runSql", () => {
  it("answers a SELECT with columns and rows", () => {
    const result = runSql("SELECT COUNT(*) AS books FROM books;");
    expect(result).toEqual({
      columns: ["books"],
      rows: [[40]],
      truncated: false,
    });
  });

  it("builds the same data on every start", () => {
    const top = runSql(
      "SELECT b.title, SUM(o.quantity) AS units FROM orders o JOIN books b ON b.id = o.book_id GROUP BY b.id ORDER BY units DESC, b.id LIMIT 1",
    );
    expect(top.rows).toHaveLength(1);
    expect(runSql("SELECT COUNT(*) FROM orders").rows).toEqual([[6000]]);
  });

  it("returns at most 200 rows and says when it cut the result", () => {
    const result = runSql("SELECT id FROM orders");
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
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
  ])("refuses %s", (sql) => {
    expect(() => runSql(sql)).toThrow();
    expect(runSql("SELECT COUNT(*) FROM books").rows).toEqual([[40]]);
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
});
