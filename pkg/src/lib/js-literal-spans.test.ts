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

  it("ends an unterminated string at U+2028 and U+2029 too", () => {
    expect(literals("a = 'open\u2028b = 'closed'")).toEqual([
      "'open",
      "'closed'",
    ]);
    expect(literals("a = 'open\u2029b = 'closed'")).toEqual([
      "'open",
      "'closed'",
    ]);
  });

  it("skips a byte order mark and no-break spaces as whitespace", () => {
    expect(literals("\ufeff/'/.test(s);\u00a0x = 'k'")).toEqual(["'k'"]);
  });

  it("reads `/` after a regex keyword, `else` included, as a regex", () => {
    expect(literals("if (a) b(); else /'/.test(s); c = 'k'")).toEqual(["'k'"]);
  });

  it("reads `/` after `}` as division, unlike the minifier's statement scan", () => {
    // The minifier tries a regex after `}` (a block can end there) and keeps it only when it
    // closes on the same line; this scan, like the minifier's `${}` scan, reads a division.
    expect(literals("x = {} / 2 + 'q' / 3")).toEqual(["'q'"]);
    expect(literals("function f() {}\n/ a '/.test(s)")).toEqual(["'/.test(s)"]);
  });

  it("handles escapes", () => {
    expect(literals(`a = 'it\\'s'; b = "q\\"" + \`t\\\`\``)).toEqual([
      "'it\\'s'",
      '"q\\""',
      "`t\\``",
    ]);
  });

  it("continues a string over a backslash line continuation, CRLF included", () => {
    // A Windows checkout writes `\` + CRLF; the string goes on past the line break.
    expect(literals("a = 'x\\\r\ny'; b = 'k'")).toEqual(["'x\\\r\ny'", "'k'"]);
    expect(literals("a = 'x\\\ny'; b = 'k'")).toEqual(["'x\\\ny'", "'k'"]);
    expect(literals("a = 'x\\\u2028y'; b = 'k'")).toEqual([
      "'x\\\u2028y'",
      "'k'",
    ]);
  });

  it("reads `/` after an if, while, for or with header as a regex", () => {
    expect(
      literals(`if (ok) /"/.test(s); el.innerHTML = '<p class="x">'`),
    ).toEqual([`'<p class="x">'`]);
    expect(literals("while (f(a)) /'/.exec(s); b = 'k'")).toEqual(["'k'"]);
    expect(literals("for (;;) /'/.test(s); b = 'k'")).toEqual(["'k'"]);
    expect(literals("with (o) /'/.test(s); b = 'k'")).toEqual(["'k'"]);
    // A call or a property named like a keyword still divides.
    expect(literals("x = f(a) / 2 + 'q' / 3")).toEqual(["'q'"]);
    expect(literals("x = o.if(a) / 2 + 'q' / 3")).toEqual(["'q'"]);
    expect(literals("x = (if_(a)) / 2 + 'q' / 3")).toEqual(["'q'"]);
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
