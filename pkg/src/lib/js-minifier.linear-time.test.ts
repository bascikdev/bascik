/**
 * CPU-time growth checks for the built-in JS minifier.
 * js-minifier-complexity.test.ts counts the characters the scan examines,
 * which cannot see work the engine does behind a string call: the ASI pass
 * read `processedText.lastIndexOf(")")` on a string built by `+=`, and V8
 * flattens such a string on every read, so each `)`-terminated line cost the
 * whole output so far (40,000 lines took 1.1 s).
 */
import { describe, expect, it } from "vitest";
import { minifyJs } from "./js-minifier.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
  repeatTo,
} from "./linear-time.test-helper.ts";

describe("minifyJs takes linear time", () => {
  it.each([
    ["lines ending in a call", "a = b\nc()\n"],
    ["a call line after a value line", "a = b\n(c)\n"],
    ["control headers with a body on the next line", "if (x)\n  y()\n"],
    ["semicolon-terminated lines (pinned)", "a = b;\n"],
    ["restricted productions before ( lines", "x()\nreturn\n(a)\n"],
  ])(
    "on %s",
    (_label, unit) => {
      expect(minifyJs(repeatTo(unit, 200)).length).toBeGreaterThan(0);
      expectLinearTime((n) => repeatTo(unit, n), 200_000, minifyJs);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
