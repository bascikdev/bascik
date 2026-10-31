import { describe, expect, it } from "vitest";
import {
  convertCssElementSelectorsToClasses,
  declaredCustomPropertyNames,
  hoistCssImports,
  prefixKeyframes,
  removeIdSelectors,
  scopeContainerNames,
  scopeCssClassSelectors,
  scopeCssCustomProperties,
  scopeLayerNames,
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

// ─── R2-03: the regexes the fix campaign added ──────────────────────────────
//
// Each case below was super-linear before (growth 11-78 for 4x the input;
// an unclosed `@import url(` was cubic: 800 spaces took 0.4 s), except where
// noted as pinned. Inputs are the adversarial shape for that regex: one long
// stretch without the `{`, `;`, `)` or quote that would end its scan.

const convert = (text: string) =>
  convertCssElementSelectorsToClasses(text, "card");

describe("element selector passes stay linear on long stretches without a stop", () => {
  it.each([
    [
      "a long selector list (Pass 2)",
      (n: number) =>
        `${Array.from({ length: n }, () => "h2").join(", ")} { color: red }`,
    ],
    [
      "a long selector list over many lines (Pass 1)",
      (n: number) =>
        `${Array.from({ length: n }, () => "h2").join(",\n")} { color: red }`,
    ],
    ["many lines with no stop at all (Pass 1)", (n: number) => "a\n".repeat(n)],
    [
      "a long list of & selectors (Pass 3)",
      (n: number) =>
        `div { ${Array.from({ length: n }, () => "& p").join(", ")} { color: red } }`,
    ],
    [
      "& selectors in a value (Pass 3)",
      (n: number) => `div { color: ${"& p ".repeat(n)}; }`,
    ],
    [
      "a long list of scoped classes with descendants (Pass 4)",
      (n: number) =>
        `${Array.from({ length: n }, (_, i) => `.bascik__card__a${i} p`).join(", ")} { color: red }`,
    ],
    [
      "an unclosed :is( holding many scoped classes (Pass 4)",
      (n: number) => `:is(${".bascik__card__a ".repeat(n)}`,
    ],
    [
      "many rules with a three-level descendant chain (Pass 4 rounds)",
      (n: number) => ".bascik__card__a p span em { color: red }\n".repeat(n),
    ],
  ])(
    "on %s",
    (_label, css) => {
      expect(convert(css(3)).css).not.toBe("");
      expectLinearTime(css, 2_000, convert);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it("converts a list in selector position and leaves the same list in a value alone", () => {
    expect(convert("h2, h3 { color: red }").css).toContain(
      ".bascik__card__el__h2, .bascik__card__el__h3 {",
    );
    expect(convert("a { font-family: h2, h3; }").css).toBe(
      ".bascik__card__el__a { font-family: h2, h3; }",
    );
  });
});

describe("hoistCssImports stays linear on unterminated statements", () => {
  it.each([
    [
      "an unclosed url( full of spaces",
      (n: number) => `@import url(${" ".repeat(n)}x`,
    ],
    [
      "a quoted url( padded with spaces",
      (n: number) => `@import url(${" ".repeat(n)}'x'${" ".repeat(n)}`,
    ],
    [
      "many @imports with no semicolon",
      (n: number) => '@import "a" '.repeat(n),
    ],
    ["many unclosed quotes", (n: number) => '@import "'.repeat(n)],
    ["spaces after @import", (n: number) => `@import${" ".repeat(n)}x`],
    [
      "imports between rules (pinned)",
      (n: number) => ".a{color:red}\n@import 'x.css';\n".repeat(n),
    ],
  ])(
    "on %s",
    (_label, css) => {
      expect(typeof hoistCssImports(css(3))).toBe("string");
      expectLinearTime(css, 20_000, hoistCssImports);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("name scoping regexes stay linear", () => {
  it.each([
    [
      "custom properties: a run of --a--a (was one scan per --)",
      (n: number) => `${"--a".repeat(n)}{--b: 1}`,
      (text: string) => scopeCssCustomProperties(text, "card"),
    ],
    [
      "custom properties: declared names in a run of --a--a",
      (n: number) => "--a".repeat(n),
      (text: string) => declaredCustomPropertyNames(text),
    ],
    [
      "@import layer( after many words (pinned)",
      (n: number) => `@import ${"x ".repeat(n)}layer(a`,
      (text: string) => scopeLayerNames(text, "card"),
    ],
    [
      "a long @layer list (pinned)",
      (n: number) => `@layer ${"a.b, ".repeat(n)}`,
      (text: string) => scopeLayerNames(text, "card"),
    ],
    [
      "repeated layer( in class scoping (pinned)",
      (n: number) => "layer(".repeat(n),
      (text: string) => scopeCssClassSelectors(text, "card"),
    ],
    [
      "a long container value (pinned)",
      (n: number) => `container: ${"a-".repeat(n)}(`,
      (text: string) => scopeContainerNames(text, "card"),
    ],
    [
      "an animation-name value that never ends (pinned)",
      (n: number) => `@keyframes x{} a{animation-name:${"x ".repeat(n)}{`,
      (text: string) => prefixKeyframes(text, "card"),
    ],
    [
      "escaped class names (pinned)",
      (n: number) => `.${"\\31 ".repeat(n)}`,
      (text: string) => scopeCssClassSelectors(text, "card"),
    ],
  ])(
    "%s",
    (_label, css, run) => {
      expect(() => run(css(3))).not.toThrow();
      expectLinearTime(css, 20_000, run);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
