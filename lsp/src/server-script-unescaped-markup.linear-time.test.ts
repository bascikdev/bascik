/**
 * Linear-time checks for server-script-unescaped-markup
 * (server-script-unescaped-markup.test.ts has the rule's behavior).
 * CPU-growth sampling takes minutes on Windows, so these run in the
 * `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeServerScriptSource,
  type AnalyzeOptions,
} from "./server-script-rules.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const RULE = "server-script-unescaped-markup";
const IMPORT = `import { html, raw, esc, safeUrl, json } from "@bascik/bascik/html";\n`;

const analyze = (body: string) =>
  analyzeServerScriptSource(body, {
    hasSrcAttribute: false,
    directive: "server",
  } as AnalyzeOptions);

/** The source text each diagnostic of the rule covers. */
const covered = (body: string) =>
  analyze(body)
    .filter((d) => d.code === RULE)
    .map((d) => body.slice(d.start, d.end));

describe("server-script-unescaped-markup: linear time", () => {
  // Tick-aware CPU-time growth: see linear-time.test.util.ts.
  const growthOfBodies = (small: string, large: string): number =>
    growthOf(
      () => analyze(small),
      () => analyze(large),
    );

  it(
    "a 10k-line script of markup templates lints in linear time (CPU growth under 8x for 4x the lines)",
    () => {
      const line = (i: number) =>
        `  out += \`<li data-i="\${i}">\${rows[${i}].name} \${esc(rows[${i}].x)}</li>\`;\n`;
      const script = (lines: number) =>
        `${IMPORT}export default () => {\n  let out = "";\n${Array.from({ length: lines }, (_, i) => line(i)).join("")}  return out;\n};\n`;
      const small = script(2_500);
      const large = script(10_000);
      const diags = analyze(large).filter((d) => d.code === RULE);
      expect(diags).toHaveLength(10_000 * 2);
      expect(growthOfBodies(small, large)).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "an import specifier with a long run of tabs reads in linear time (CPU growth under 8x for 4x the tabs)",
    () => {
      // `{ html<tabs>x }`: splitting the specifier on /\s+as\s+/ retried the
      // tab run from every tab, so typing in a large import froze the editor.
      const script = (tabs: number) =>
        `import { html${"\t".repeat(tabs)}x } from "@bascik/bascik/html";\nexport default () => \`<p>\${q}</p>\`;\n`;
      const small = script(5_000);
      const large = script(20_000);
      expect(covered(large)).toEqual(["${q}"]);
      expect(growthOfBodies(small, large)).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
