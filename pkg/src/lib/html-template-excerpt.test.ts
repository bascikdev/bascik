/**
 * The excerpt in an HtmlError folds each line break, with the whitespace
 * around it, into one space. It runs on the author's static template text,
 * and stays linear on any input (CodeQL alert 171: the regex it replaced,
 * whitespace-star newline whitespace-star, backtracks quadratically on a long
 * run of whitespace with no line break).
 */
import { describe, expect, it } from "vitest";
import { foldLineBreaks, html, HtmlError } from "./html-template.ts";

/** The regex the fold replaced, kept as the reference for its output. */
const reference = (text: string): string => text.replace(/\s*\n\s*/g, " ");

/** A seeded generator, so a failure names an input that reproduces. */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
};

// Every kind of JS whitespace (\s), the line terminators among them, and a
// few visible characters so runs start and end mid-text.
const ALPHABET = [
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "　",
  "﻿",
  "a",
  "<",
  "$",
];

describe("foldLineBreaks", () => {
  it("matches the old regex on random whitespace strings", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const next = random(seed);
      const length = Math.floor(next() * 40);
      let text = "";
      for (let i = 0; i < length; i++)
        text += ALPHABET[Math.floor(next() * ALPHABET.length)];
      expect(
        foldLineBreaks(text),
        `seed ${seed}: ${JSON.stringify(text)}`,
      ).toBe(reference(text));
    }
  });

  it("matches the old regex on the edge cases", () => {
    for (const text of [
      "",
      "\n",
      " \n ",
      "\n\n\n",
      "a\nb",
      "a \t\n\t b",
      "  a  ",
      "\t\t\t",
      "a\r\nb",
      "a\n \n b",
      "\n a \n",
    ])
      expect(foldLineBreaks(text), JSON.stringify(text)).toBe(reference(text));
  });

  it("still folds line breaks in an HtmlError's excerpt", () => {
    let error: unknown;
    try {
      html`<div>
        <a ${"x"}>
      </div>`;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HtmlError);
    expect((error as HtmlError).template).not.toContain("\n");
    expect((error as HtmlError).template).toContain("<div> <a ${…}");
  });
});
