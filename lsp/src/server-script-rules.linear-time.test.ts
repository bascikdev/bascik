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
});
