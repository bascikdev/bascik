import { describe, expect, it } from "vitest";
import {
  convertCssElementSelectorsToClasses,
  removeIdSelectors,
} from "./styles.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

const rules = (n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `.bascik__card__y${i} h2 { color: blue }`,
  ).join("\n");

describe("convertCssElementSelectorsToClasses on a missing `)`", () => {
  it.each([
    [
      ":is(",
      ".bascik__card__x :is(.bascik__card__a, .bascik__card__b { color: red }\n",
    ],
    [":not(", ".bascik__card__x:not(.bascik__card__a h2 { color: red }\n"],
    [
      "a pseudo-class argument",
      ".bascik__card__x:nth-child(2n h2 { color: red }\n",
    ],
    ["an attribute selector", ".bascik__card__x[data-a h2 { color: red }\n"],
    [
      "an & chain",
      ".bascik__card__x { &:is(.bascik__card__a p { color: red } }\n",
    ],
  ])(
    "stays linear after an unclosed %s (a typo) followed by many rules",
    (_label, head) => {
      // The two `[^)]*` runs around a required `.bascik__` class each scanned
      // to the next `)` anywhere in the stylesheet: 31 KB took 4 s.
      const css = (n: number) => head + rules(n);
      const { css: out } = convertCssElementSelectorsToClasses(css(50), "card");
      expect(out).toContain(".bascik__card__y49 .bascik__card__el__h2");
      expectLinearTime(css, 2_000, (text) =>
        convertCssElementSelectorsToClasses(text, "card"),
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("removeIdSelectors", () => {
  it(
    "stays linear on many [id] rules and selector lists",
    () => {
      const css = (n: number) =>
        Array.from(
          { length: n },
          (_, i) =>
            `.a${i}, :is(.b, [id="x"]) { color: red; &:hover { color: blue } }`,
        ).join("\n");
      expect(removeIdSelectors(css(2))).toBe(
        ".a0 { color: red; &:hover { color: blue } }\n.a1 { color: red; &:hover { color: blue } }",
      );
      expectLinearTime(css, 4_000, removeIdSelectors);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
