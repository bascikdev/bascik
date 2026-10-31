/**
 * Linear-time checks for `findJsLiteralSpans` (js-literal-spans.test.ts has
 * its behavior). Attribute scoping runs it over every inline script of every
 * page, so a 2 MB script must cost linear time whatever it holds.
 */
import { describe, expect, it } from "vitest";
import { findJsLiteralSpans } from "./js-literal-spans.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
  repeatTo,
} from "./linear-time.test-helper.ts";

const SCRIPT_SIZE = 2_000_000;

describe("findJsLiteralSpans takes linear time", () => {
  it.each([
    [
      "mixed code, strings, regexes, templates and comments",
      "a = b / c / d; if (x) /'/.test(s); y = `${ /`/.test(z) }` + 'q'; // c\n",
    ],
    ["a run of slashes", "/"],
    ["open parens and slashes", "(/"],
    ["an unclosed regex class on each line", "x = /[a\n"],
    ["nested parens of headers", "if (while (for ("],
    ["line continuations with CRLF", "'a\\\r\n"],
    ["unclosed block comments", "/*"],
  ])(
    "on %s",
    (_label, unit) => {
      expect(() => findJsLiteralSpans(repeatTo(unit, 1_000))).not.toThrow();
      expectLinearTime(
        (n) => repeatTo(unit, n),
        SCRIPT_SIZE,
        findJsLiteralSpans,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
