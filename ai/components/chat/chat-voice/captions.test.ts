import { describe, expect, test } from "vitest";
import { captionParts, wordAt, wordDelay, wordStarts } from "./captions.ts";

describe("captionParts", () => {
  const words = "Kindred is a novel by Octavia Butler".split(" ");

  test("shows six words, the current one marked", () => {
    expect(captionParts(words, 2)).toEqual([
      "Kindred ",
      "is ",
      { current: "a" },
      " ",
      "novel ",
      "by ",
      "Octavia ",
    ]);
  });

  test("moves on to the next group", () => {
    expect(captionParts(words, 6)).toEqual([{ current: "Butler" }, " "]);
  });
});

describe("wordDelay", () => {
  test("paces 190 words a minute at normal speed, longer for long words", () => {
    const perWord = 60_000 / 190;
    expect(wordDelay("a", "1")).toBeCloseTo(perWord * 0.7);
    expect(wordDelay("Octavia", 1)).toBeCloseTo(perWord * 1.3);
    // Very long words stop growing at twelve letters.
    expect(wordDelay("x".repeat(30), 1)).toBeCloseTo(perWord * 1.8);
  });

  test("goes faster at a higher speed", () => {
    expect(wordDelay("Dawn", "2")).toBeCloseTo(wordDelay("Dawn", "1") / 2);
  });
});

describe("wordStarts and wordAt", () => {
  const words = ["Parable", "of", "the", "Sower"];

  test("finds where each word starts", () => {
    expect(wordStarts(words)).toEqual([0, 8, 11, 15]);
  });

  test("finds the word a boundary falls in", () => {
    const starts = wordStarts(words);
    expect(wordAt(starts, 0)).toBe(0);
    expect(wordAt(starts, 9)).toBe(1);
    expect(wordAt(starts, 15)).toBe(3);
    expect(wordAt(starts, 99)).toBe(3);
    expect(wordAt(starts, -1)).toBe(0);
  });
});
