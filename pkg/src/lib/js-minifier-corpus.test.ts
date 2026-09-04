/**
 * Byte-identity corpus for the JS minifier (prompt 62).
 *
 * `__fixtures__/js-minifier-corpus.json` was generated from the minifier
 * BEFORE the linear-scan refactor. Every entry is [input, expectedOutput].
 * Any diff here is a correctness regression, not an optimization, and must be
 * investigated rather than re-baselined.
 *
 * Also carries the termination/determinism property tests required by the
 * prompt: arbitrary input must finish, produce a string, and be repeatable.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { minifyJs, __scanStatsForTests } from "./js-minifier.ts";

const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__fixtures__/js-minifier-corpus.json", import.meta.url)), "utf8"),
) as [string, string][];

describe("minifyJs byte-identity corpus", () => {
  it("has a non-trivial corpus", () => {
    expect(corpus.length).toBeGreaterThan(100);
  });

  for (const [input, expected] of corpus) {
    it(`is byte-identical for ${JSON.stringify(input).slice(0, 60)}`, () => {
      expect(minifyJs(input)).toBe(expected);
    });
  }
});

describe("minifyJs termination and determinism", () => {
  const jsish = fc
    .array(
      fc.constantFrom(
        "/", "*", "\\", "'", '"', "`", "\n", " ", "[", "]", "(", ")", "{", "}", "=", ";", ",", ".", "+", "-", "?", ":",
        "a", "b", "x", "$", "_", "1", "return", "in", "typeof", "$1", "$&", "$`",
      ),
      { maxLength: 60 },
    )
    .map((parts) => parts.join(""));

  it("terminates, returns a string, and is deterministic for arbitrary input", () => {
    fc.assert(
      fc.property(jsish, (s) => {
        const first = minifyJs(s);
        expect(typeof first).toBe("string");
        expect(minifyJs(s)).toBe(first);
      }),
      { numRuns: 500 },
    );
  });

  it("never examines more than a small constant multiple of the input length", () => {
    fc.assert(
      fc.property(jsish, (s) => {
        __scanStatsForTests.reset();
        minifyJs(s);
        // Bounded work: no hidden prefix rescans on adversarial input.
        expect(__scanStatsForTests.charsExamined).toBeLessThanOrEqual(s.length * 8 + 8);
      }),
      { numRuns: 500 },
    );
  });

  it("preserves literal $ replacement tokens", () => {
    expect(minifyJs("s.replace(/x/, '$1$&$`$$')")).toBe("s.replace(/x/,'$1$&$`$$')");
    expect(minifyJs("a = '$1' / b")).toBe("a='$1'/ b");
  });
});
