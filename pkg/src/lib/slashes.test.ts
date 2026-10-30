import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { trimSlashes, trimTrailingSlashes } from "./slashes.ts";

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
      fc.property(
        fc.string({ unit: fc.constantFrom("/", "\\", "a", ".", " ") }),
        (input) => {
          expect(trimTrailingSlashes(input)).toBe(input.replace(/\/+$/, ""));
        },
      ),
    );
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
      fc.property(
        fc.string({ unit: fc.constantFrom("/", "a", ".") }),
        (input) => {
          expect(trimSlashes(input)).toBe(input.replace(/^\/+|\/+$/g, ""));
        },
      ),
    );
  });
});
