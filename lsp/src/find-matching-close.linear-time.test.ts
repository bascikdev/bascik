/**
 * Linear-time checks for `findMatchingClose`, which pairs a component's open
 * tag with its end tag for the unclosed-component diagnostics on every edit.
 * A document being typed is full of half-written tags, so neither a run of
 * end tags with no `>`, nor deep nesting, nor open tags with no `>` may cost
 * a rescan of the rest of the document per tag.
 */
import { describe, expect, it } from "vitest";
import { findMatchingClose } from "./analyzer.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const cases: Array<[string, (n: number) => string, number]> = [
  ["end tags missing their >", (n) => `<a-b>${"</a-b ".repeat(n)}`, -1],
  [
    "deep nesting closed at the end",
    (n) => `<a-b>${"<a-b>".repeat(n)}${"</a-b>".repeat(n)}</a-b>`,
    0,
  ],
  ["open tags missing their >", (n) => `<a-b>${"<a-b ".repeat(n)}`, -1],
  [
    "self-closing tags before the end tag",
    (n) => `<a-b>${"<a-b />".repeat(n)}</a-b>`,
    0,
  ],
];

describe("findMatchingClose: linear time", () => {
  it.each(cases)(
    "on %s",
    (_label, html, expected) => {
      const result = findMatchingClose(html(10), "a-b", 5);
      if (expected === -1) expect(result).toBe(-1);
      else expect(result).toBe(html(10).lastIndexOf("</a-b>"));
      const runOf = (n: number) => {
        const text = html(n);
        return () => findMatchingClose(text, "a-b", 5);
      };
      expect(growthOf(runOf(2_000), runOf(8_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
