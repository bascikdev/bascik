import { describe, expect, test } from "vitest";
import { sentenceEnd, sentencesOf } from "./sentences.ts";

describe("sentenceEnd", () => {
  test("takes everything once the reply is over", () => {
    expect(sentenceEnd("Kindred is a novel", true)).toBe(18);
  });

  test("stops after the last whole sentence while the reply streams", () => {
    const rest = "Kindred is a novel. It was written by Octavia";
    expect(rest.slice(0, sentenceEnd(rest, false))).toBe(
      "Kindred is a novel. ",
    );
  });

  test("a line break or a colon ends a sentence too", () => {
    expect(sentenceEnd("Books\nKindred", false)).toBe(6);
    expect(sentenceEnd("Three books: Kindred", false)).toBe(13);
    expect(sentenceEnd("Really? Yes! Dawn", false)).toBe(13);
  });

  test("a full stop without a space after it is not the end yet", () => {
    expect(sentenceEnd("It costs 9.99", false)).toBe(0);
    expect(sentenceEnd("The end.", false)).toBe(0);
  });
});

describe("sentencesOf", () => {
  test("splits sentences and lines, one space between words", () => {
    expect(
      sentencesOf("Kindred is a  novel. It is\tgood!\n\nDawn: next"),
    ).toEqual(["Kindred is a novel.", "It is good!", "Dawn:", "next"]);
  });

  test("leaves out pieces with no letter or digit", () => {
    expect(sentencesOf("…\n— \n42.")).toEqual(["42."]);
  });
});
