import { describe, expect, test } from "vitest";
import { spokenWords, wordErrorRate } from "./words.ts";

describe("spokenWords", () => {
  test("compares what was said, not how it was written down", () => {
    expect(spokenWords("  What's a GOOD book, about gardening?! ")).toEqual([
      "whats",
      "a",
      "good",
      "book",
      "about",
      "gardening",
    ]);
    expect(spokenWords("Café: 2 cups")).toEqual(["cafe", "two", "cups"]);
    expect(spokenWords("?!")).toEqual([]);
  });
});

describe("wordErrorRate", () => {
  test("is 0 when every word was heard", () => {
    expect(wordErrorRate("Recommend a book.", "recommend a book")).toBe(0);
  });

  test("counts a wrong, a missing and an extra word as one each", () => {
    expect(wordErrorRate("recommend a book", "recommend a look")).toBeCloseTo(
      1 / 3,
    );
    expect(wordErrorRate("recommend a book", "recommend book")).toBeCloseTo(
      1 / 3,
    );
    expect(
      wordErrorRate("recommend a book", "please recommend a book"),
    ).toBeCloseTo(1 / 3);
  });

  test("is 1 when nothing was heard, and can pass 1", () => {
    expect(wordErrorRate("recommend a book", "")).toBe(1);
    expect(wordErrorRate("yes", "no not at all")).toBe(4);
  });

  test("nothing said is right only when nothing was heard", () => {
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("", "hello")).toBe(1);
  });
});
