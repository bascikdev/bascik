/**
 * Linear-time checks for the extension config reader (config.test.ts has its
 * behavior). The reader tokenizes the whole `bascik.ext.ts` on every
 * diagnostics pass whose file changed, so a large or odd file must not cost
 * quadratic time. CPU-growth sampling takes minutes on Windows, so these run
 * in the `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import {
  parseExtensionConfigFile,
  parseExtensionConfigSource,
} from "./config-reader.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

/** About `bytes` of config: a large literal with strings, escapes, comments and numbers. */
const bigConfig = (bytes: number): string => {
  const entry = `  "rule-\\u0041-'x'", // a comment with "quotes" and /slashes/\n  1_000, 0x1F, .5e1, /* block */ \`plain\`,\n`;
  const count = Math.ceil(bytes / entry.length);
  return `export default {\n diagnostics: { disabledRules: [\n${entry.repeat(count)} ] },\n} satisfies X;\n`;
};

/** A line of `(/[`: every `/` may start a regex whose class never closes on its line. */
const slashLine = (bytes: number): string =>
  `const x = ${"(/[".repeat(Math.ceil(bytes / 3))};\nexport default {};\n`;

describe("extension config reader: linear time", () => {
  it(
    "reads a 1 MB config in linear time",
    () => {
      expect(
        (
          parseExtensionConfigSource(bigConfig(1_000)) as {
            diagnostics: { disabledRules: unknown[] };
          }
        ).diagnostics.disabledRules.length,
      ).toBeGreaterThan(0);
      const readOf = (bytes: number) => {
        const source = bigConfig(bytes);
        return () => parseExtensionConfigSource(source);
      };
      expect(growthOf(readOf(250_000), readOf(1_000_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "scans a line of slashes that never close as a regex once",
    () => {
      expect(parseExtensionConfigSource(slashLine(100))).toEqual({});
      const readOf = (bytes: number) => {
        const source = slashLine(bytes);
        return () => parseExtensionConfigSource(source);
      };
      expect(growthOf(readOf(50_000), readOf(200_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "reports a broken 1 MB JSON config with its line in linear time",
    () => {
      const brokenJson = (bytes: number) =>
        `{\n "diagnostics": { "disabledRules": [\n${' "a",\n'.repeat(Math.ceil(bytes / 6))} ] },\n}\n`;
      expect(
        parseExtensionConfigFile("bascik.ext.json", brokenJson(60)).problem
          ?.line,
      ).toBeGreaterThan(1);
      const readOf = (bytes: number) => {
        const raw = brokenJson(bytes);
        return () => parseExtensionConfigFile("bascik.ext.json", raw);
      };
      expect(growthOf(readOf(250_000), readOf(1_000_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
