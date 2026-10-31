/**
 * Growth checks for the bascik skill's markup.mjs on hostile input: tags
 * that never close. The fixed-input tests stay in
 * attribute-tokenizer-agreement.test.ts. These measure CPU time with
 * linear-time.test-helper.ts, so they run in the `linear-time` Vitest project
 * (`yarn skills:linear-time`), never under coverage, where a wall-clock
 * ratio read 3.79 against a bound of 2.5 (R3-19).
 */
import { describe, expect, it } from "vitest";
import { parseMarkup } from "../../skills/bascik/scripts/lib/markup.mjs";
import {
  LINEAR_TIME_TIMEOUT_MS,
  MAX_GROWTH,
  growthOf,
} from "./linear-time.test-helper.ts";

/**
 * The growth of parseMarkup from `count` to four times `count` copies of
 * `fragment`, after `prefix`.
 */
const growthOfRepeats = (
  fragment: string,
  count: number,
  prefix = "",
): number => {
  const small = prefix + fragment.repeat(count);
  const large = prefix + fragment.repeat(count * 4);
  return growthOf(
    () => parseMarkup(small),
    () => parseMarkup(large),
  );
};

describe("markup.mjs reads a tag that never closes in linear time (R3-17)", () => {
  it(
    "unquoted values full of = and quotes",
    () => {
      expect(growthOfRepeats(` a=b"c='d=e`, 5_000, "<p")).toBeLessThan(
        MAX_GROWTH,
      );
      // A ceiling for a catastrophic regression, at the unit test's size.
      const html = `<p${" a=b\"c='d=e".repeat(20_000)}`;
      const started = performance.now();
      expect(() => parseMarkup(html)).not.toThrow();
      expect(performance.now() - started).toBeLessThan(2_000);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "quoted, unquoted and bare attributes",
    () => {
      expect(growthOfRepeats(` a="x" b=y c`, 5_000, "<p")).toBeLessThan(
        MAX_GROWTH,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

/**
 * R3-18: many tags that never close. Each `<` used to start a scan to the
 * end of the input (the attribute text read through `<`, and a raw-text or
 * comment body looked for its end from every opening), so the work grew
 * with the square of the input: the markup.mjs before R3-18 read 12.3 to
 * 16.4 on these shapes, the current one 3.6 to 4.7.
 */
describe("markup.mjs reads many unclosed tags in linear time (R3-18)", () => {
  it.each([
    ["an element name", "<x "],
    ["unquoted values", "<x a=b "],
    ["values with no whitespace", "<xa="],
    ["quoted values that never close", '<x a="'],
    ["a script open tag", "<script "],
    ["script elements with no end tag", "<script>"],
    ["comments with no end", "<!--"],
  ])(
    "%s",
    (_name, fragment) => {
      expect(growthOfRepeats(fragment, 2_000)).toBeLessThan(MAX_GROWTH);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
