import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { trimSlashes, trimTrailingSlashes } from "./slashes.ts";

// A long run of "/" that does not end the string is the worst case for the
// anchored regex `/\/+$/`: V8 retries the run from every start position, so the
// cost grows with the square of its length (about 4 s for 50,000 slashes).
const LONG_SLASH_RUN = `${"/".repeat(50_000)}x`;
const LINEAR_BUDGET_MS = 250;

const timed = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

describe("trimTrailingSlashes", () => {
  it.each([
    ["", ""],
    ["/", ""],
    ["///", ""],
    ["a", "a"],
    ["a/", "a"],
    ["a///", "a"],
    ["/a/b//", "/a/b"],
    ["https://bascik.dev/", "https://bascik.dev"],
  ])("trims %j to %j", (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });

  it("matches the regex it replaces for any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("/", "\\", "a", ".", " ") }), (input) => {
        expect(trimTrailingSlashes(input)).toBe(input.replace(/\/+$/, ""));
      }),
    );
  });

  it("runs in linear time on a long slash run that does not end the string", () => {
    expect(timed(() => trimTrailingSlashes(LONG_SLASH_RUN))).toBeLessThan(LINEAR_BUDGET_MS);
  });
});

describe("trimSlashes", () => {
  it.each([
    ["", ""],
    ["/", ""],
    ["//a//", "a"],
    ["/a/b/", "a/b"],
    ["a", "a"],
  ])("trims %j to %j", (input, expected) => {
    expect(trimSlashes(input)).toBe(expected);
  });

  it("matches the regex it replaces for any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("/", "a", ".") }), (input) => {
        expect(trimSlashes(input)).toBe(input.replace(/^\/+|\/+$/g, ""));
      }),
    );
  });

  it("runs in linear time on a long slash run that does not end the string", () => {
    expect(timed(() => trimSlashes(LONG_SLASH_RUN))).toBeLessThan(LINEAR_BUDGET_MS);
  });
});
