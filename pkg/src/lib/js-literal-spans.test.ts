import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { findJsLiteralSpans } from "./js-literal-spans.ts";

const literals = (js: string): string[] =>
  findJsLiteralSpans(js).map(({ start, end }) => js.slice(start, end));

describe("findJsLiteralSpans", () => {
  it("finds string and template literals in order", () => {
    expect(literals(`a = "x"; b = 'y'; c = \`z\${"q"}\`;`)).toEqual([
      '"x"',
      "'y'",
      '`z${"q"}`',
    ]);
  });

  it("skips quotes inside comments and regex literals", () => {
    expect(literals("// it's\n/* don't */ x = /'/g; y = 'k'")).toEqual(["'k'"]);
    expect(literals('if (a) return /"/.test(s)')).toEqual([]);
  });

  it("reads `/` after a value, `)`, `]` or a postfix update as division", () => {
    expect(literals("x = a / 2 / 'b'")).toEqual(["'b'"]);
    expect(literals("x = f() / 2; y = 'q' / 1")).toEqual(["'q'"]);
    expect(literals("x = i++ / 2 + 'r' / 3")).toEqual(["'r'"]);
    expect(literals("x = a[0] / 2 + 's' / 3")).toEqual(["'s'"]);
    expect(literals("x = o.return / 2 + 't' / 3")).toEqual(["'t'"]);
  });

  it("ends an unterminated string at its line break", () => {
    expect(literals("a = 'open\nb = 'closed'")).toEqual(["'open", "'closed'"]);
  });

  it("handles escapes", () => {
    expect(literals(`a = 'it\\'s'; b = "q\\"" + \`t\\\`\``)).toEqual([
      "'it\\'s'",
      '"q\\""',
      "`t\\``",
    ]);
  });

  it("returns ordered, non-overlapping, in-range spans for any input", () => {
    fc.assert(
      fc.property(fc.string(), (js) => {
        let previousEnd = 0;
        for (const { start, end } of findJsLiteralSpans(js)) {
          expect(start).toBeGreaterThanOrEqual(previousEnd);
          expect(end).toBeGreaterThan(start);
          expect(end).toBeLessThanOrEqual(js.length);
          previousEnd = end;
        }
      }),
      { numRuns: 300 },
    );
  });
});
