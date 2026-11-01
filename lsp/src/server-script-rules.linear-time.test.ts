/**
 * Linear-time checks for `analyzeServerScriptSource` (server-script-rules.test.ts
 * has the rules' behavior). Deciding whether a `/` starts a regex looks only
 * at the text just before it. Testing end-anchored patterns against
 * everything scanned so far made the scan quadratic: a 320 KB minified script
 * took 3.7 s and stalled every diagnostics pass of the language server.
 * CPU-growth sampling takes minutes on Windows, so these run in the
 * `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import { analyzeServerScriptSource } from "./server-script-rules.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const scriptOf = (unit: string, n: number): string =>
  `const x = ${unit.repeat(n)}b;\nexport default () => x;`;

const analyze = (body: string) =>
  analyzeServerScriptSource(body, {
    hasSrcAttribute: false,
    directive: "server",
  });

describe("Server Script Diagnostics: linear time", () => {
  it.each([
    ["division", "a/"],
    ["division after whitespace", "a  /"],
    ["a keyword-like identifier", "returned/"],
    ["a property named like a keyword", "x.of/"],
  ])(
    "misuse: a huge script full of %s is analyzed in linear time",
    (_name, unit) => {
      const small = scriptOf(unit, 40_000);
      const large = scriptOf(unit, 160_000);
      expect(
        analyze(large).filter(
          (d) => d.code === "server-script-missing-default-export",
        ),
      ).toEqual([]);
      // Tick-aware CPU-time growth: see linear-time.test.util.ts.
      expect(
        growthOf(
          () => analyze(small),
          () => analyze(large),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  // server-script-returns-response walks the default export's body once:
  // each `(`, `{` and `:` looks back only to the previous token.
  it.each([
    ["nested blocks and calls", "if (a) { f(b); } "],
    ["annotated helpers", "function h(x: T): R { return new Response(x); } "],
    ["spaced parentheses", "g(   (   (   x   )   )   ); "],
    ["returned Responses", 'if (q) return new Response("x"); '],
  ])(
    "misuse: a huge handler full of %s is checked for returned Responses in linear time",
    (_name, unit) => {
      const handlerOf = (n: number): string =>
        `export default async (request) => {\n${unit.repeat(n)}\nreturn "";\n};`;
      const small = handlerOf(4_000);
      const large = handlerOf(16_000);
      analyze(large);
      expect(
        growthOf(
          () => analyze(small),
          () => analyze(large),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  // CodeQL alert 207 (js/polynomial-redos): a regex star over parentheses,
  // `await` and whitespace before the Response. A loop skips that prefix now.
  it.each([
    ["tabs after return", (n: number) => `{\n  return ${"\t".repeat(n)}x;\n}`],
    [
      "tabs after return (",
      (n: number) => `{\n  return (${"\t".repeat(n)}x);\n}`,
    ],
    [
      "tabs after await",
      (n: number) => `{\n  return await${"\t".repeat(n)}x;\n}`,
    ],
    ["tabs in an arrow body", (n: number) => `(${"\t".repeat(n)}x)`],
  ])(
    "misuse: a returned value after a huge run of %s is checked in linear time",
    (_name, bodyOf) => {
      const handlerOf = (n: number): string =>
        `export default async (request) => ${bodyOf(n)};`;
      const small = handlerOf(40_000);
      const large = handlerOf(160_000);
      expect(
        analyze(large).filter(
          (d) => d.code === "server-script-returns-response",
        ),
      ).toEqual([]);
      expect(
        growthOf(
          () => analyze(small),
          () => analyze(large),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  // projectImportNames reads each import forward only as far as a clause can reach.
  it(
    "misuse: a huge script of side-effect imports that never reach a from is scanned in linear time",
    () => {
      const importsOf = (n: number): string =>
        `${'import "/x.js";\n'.repeat(n)}export default () => "";`;
      const small = importsOf(4_000);
      const large = importsOf(16_000);
      analyze(large);
      expect(
        growthOf(
          () => analyze(small),
          () => analyze(large),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
