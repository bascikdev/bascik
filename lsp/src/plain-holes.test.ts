import { describe, expect, it } from "vitest";
import { isNumberText } from "./plain-holes.js";

describe("isNumberText", () => {
  it("accepts digits, radix and exponent letters, white space and comments", () => {
    expect(isNumberText("")).toBe(true);
    expect(isNumberText(" 0x1f ")).toBe(true);
    expect(isNumberText("1_000n")).toBe(true);
    expect(isNumberText("1e3 // ten\n")).toBe(true);
    expect(isNumberText("1 /* one */ .5")).toBe(true);
    expect(isNumberText("1 // to the end")).toBe(true);
  });

  it("accepts a sign only when asked", () => {
    expect(isNumberText("1 + 2")).toBe(false);
    expect(isNumberText("1 + 2", true)).toBe(true);
    expect(isNumberText("-1", true)).toBe(true);
  });

  it("misuse: rejects letters, markup, a lone slash and an unclosed comment", () => {
    expect(isNumberText("1 + g")).toBe(false);
    expect(isNumberText("<b>")).toBe(false);
    expect(isNumberText("1 / 2")).toBe(false);
    expect(isNumberText("1 /* open")).toBe(false);
    expect(isNumberText("1 */")).toBe(false);
  });

  it("reads a long run of slashes and comment starts in linear time", () => {
    // Each of these made the former regular expression backtrack exponentially.
    expect(isNumberText("/".repeat(50_000) + "g")).toBe(true);
    expect(isNumberText("/".repeat(50_000) + "\ng")).toBe(false);
    expect(isNumberText("/*".repeat(50_000) + "g")).toBe(false);
    expect(isNumberText("*//*".repeat(25_000) + "g", true)).toBe(false);
  });
});
