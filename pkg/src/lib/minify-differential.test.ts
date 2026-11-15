/**
 * The source-versus-minified checker in `pkg/bench/minify-differential.ts`, tested with
 * stand-in minifiers so it does not depend on what the real one gets right today.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalProgram,
  compareWithSource,
  shrinkFailure,
} from "../../bench/minify-differential.ts";

const identity = (code: string): string => code;
const stripLineBreaks = (code: string): string => code.replace(/\n/g, "");
const dropSecondLine = (code: string): string =>
  code
    .split("\n")
    .filter((_line, index) => index !== 1)
    .join("\n");

describe("canonicalProgram", () => {
  it("ignores comments, whitespace, optional semicolons and empty statements", () => {
    const expected = canonicalProgram("const a = 1;\nconst b = a + 2;");
    expect(expected).toBeDefined();
    expect(
      canonicalProgram("const a=1 // one\n;;const b = a +   2 /* two */"),
    ).toBe(expected);
  });

  it("ignores a dropped @__PURE__ annotation", () => {
    expect(canonicalProgram("/*@__PURE__*/ make(a)")).toBe(
      canonicalProgram("make(a)"),
    );
  });

  it("tells two programs apart", () => {
    expect(canonicalProgram("a + ++b")).not.toBe(canonicalProgram("a++ + b"));
  });

  it("returns undefined for code that does not parse", () => {
    expect(canonicalProgram("const a = 1 const b = 2")).toBeUndefined();
  });
});

describe("compareWithSource", () => {
  it.each([
    ["same", "const a = 1\nconst b = 2", identity],
    ["syntax", "const a = 1\nconst b = 2", stripLineBreaks],
    ["differs", "let a = 1\na++\nuse(a)", dropSecondLine],
    ["unparsable-source", "const = ;", identity],
    [
      "threw",
      "const a = 1",
      () => {
        throw new Error("boom");
      },
    ],
  ] as const)("reports %s", (verdict, source, minify) => {
    expect(compareWithSource(source, minify)).toBe(verdict);
  });
});

describe("shrinkFailure", () => {
  it("reduces a failing file to the lines that make it fail", () => {
    // Breaks only `first()\nsecond()`: every other line break becomes a `;`.
    const minify = (code: string): string =>
      code.replace("first()\nsecond()", "first()second()").replace(/\n/g, ";");
    const source = [
      "const a = 1",
      "function unrelated(b) {",
      "  return b + a",
      "}",
      "first()",
      "second()",
      "unrelated(2)",
    ].join("\n");
    expect(compareWithSource(source, minify)).toBe("syntax");
    const shrunk = shrinkFailure(source, "syntax", minify);
    expect(shrunk).toBe("first()\nsecond()");
    expect(compareWithSource(shrunk, minify)).toBe("syntax");
  });
});
