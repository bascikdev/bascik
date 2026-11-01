/**
 * Linear-time checks for stringTypedFlow, which withholds the wrap fix from
 * a template whose value reaches a `string` annotation
 * (server-script-unescaped-markup.test.ts has its behavior). Each query
 * walks back over tokens, so these check that the walks are shared: a long
 * `||` chain of templates, many returns in one function, and a chain of
 * const aliases. CPU-growth sampling takes minutes on Windows, so this runs
 * in the `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import { scanJavaScript } from "./module-specifiers.js";
import { findTemplateLiterals } from "./server-script-templates.js";
import { stringTypedFlow } from "./string-typed-flow.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const T = "`<p>${process.env.X}</p>`";

/** Every template's verdict, as the rules ask for them. */
const verdicts = (body: string): (string | undefined)[] => {
  const typedAt = stringTypedFlow(body, scanJavaScript(body).tokens);
  return findTemplateLiterals(body).map((l) => typedAt(l.start, l.end));
};

describe("stringTypedFlow: linear time", () => {
  it.each([
    [
      "a || chain of templates",
      (n: number) =>
        `function f(a?: string): string {\n  return a${` || ${T}`.repeat(n)};\n}\n`,
    ],
    [
      "returns in one function",
      (n: number) =>
        `function f(a: number): string {\n${`  if (a) { return ${T}; }\n`.repeat(n)}  return "";\n}\n`,
    ],
    [
      "ternaries nested in parentheses",
      (n: number) =>
        `function f(a: boolean): string {\n  return ${"(a ? ".repeat(n)}${T}${` : ${T})`.repeat(n)};\n}\n`,
    ],
    [
      "a chain of const aliases",
      (n: number) =>
        `function f(): string {\n  const v0 = ${T};\n${Array.from({ length: n }, (_, i) => `  const v${i + 1} = v${i};\n`).join("")}  return v${n};\n}\n`,
    ],
    [
      "untyped consts each read many times",
      (n: number) =>
        Array.from(
          { length: n },
          (_, i) =>
            `const c${i} = ${T};\nexport const d${i} = [c${i}, c${i}];\n`,
        ).join(""),
    ],
  ])(
    "misuse: %s is checked in linear time",
    (_name, build) => {
      const small = build(1_000);
      const large = build(4_000);
      expect(verdicts(large).length).toBeGreaterThan(0);
      // Tick-aware CPU-time growth: see linear-time.test.util.ts.
      expect(
        growthOf(
          () => verdicts(small),
          () => verdicts(large),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it("the first template of a long || chain still reaches the annotation", () => {
    const body = `function f(a?: string): string {\n  return a${` || ${T}`.repeat(50)};\n}\n`;
    expect(new Set(verdicts(body))).toEqual(new Set(["string"]));
  });
});
