/**
 * Linear-time checks for hand-written-html-escaper and the Node module
 * scan (hand-written-escaper.test.ts and script-modules.test.ts have the
 * behavior). CPU-growth sampling takes minutes on Windows, so these run in
 * the `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { findHandWrittenEscapers } from "./hand-written-escaper.js";
import { analyzeServerScriptSource } from "./server-script-rules.js";
import { findScriptModules } from "./script-modules.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const growth = (fn: (input: string) => unknown, small: string, large: string) =>
  growthOf(
    () => fn(small),
    () => fn(large),
  );

describe("hand-written-html-escaper: linear time", () => {
  it(
    "a file of 4k escapers (CPU growth under 8x for 4x the escapers)",
    () => {
      const escaper = (i: number) =>
        `export function escape${i}(s: string): string {\n  return s\n    .replace(/&/g, "&amp;")\n    .replace(/</g, "&lt;")\n    .replace(/>/g, "&gt;");\n}\n`;
      const file = (n: number) =>
        Array.from({ length: n }, (_, i) => escaper(i)).join("");
      const large = file(4_000);
      expect(findHandWrittenEscapers(large)).toHaveLength(4_000);
      expect(growth(findHandWrittenEscapers, file(1_000), large)).toBeLessThan(
        8,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "one lookup object with 40k entity entries, each climbing to the same owner (CPU growth under 8x for 4x the entries)",
    () => {
      // Every entity climbs out through the same object; the climb is cached
      // per bracket, so it is not walked once per entry.
      const file = (n: number) =>
        `const ENTITIES = {\n${Array.from({ length: n }, (_, i) => `  "c${i}": "${i % 2 ? "&amp;" : "&lt;"}",\n`).join("")}};\n`;
      const large = file(40_000);
      expect(findHandWrittenEscapers(large).map((e) => e.name)).toEqual([
        "ENTITIES",
      ]);
      expect(growth(findHandWrittenEscapers, file(10_000), large)).toBeLessThan(
        8,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "deeply nested callbacks around entities (CPU growth under 8x for 4x the depth)",
    () => {
      const file = (depth: number) =>
        `export function escapeHtml(s) {\n  return ${"f((c) => ".repeat(depth)}s.replace(/&/g, "&amp;").replace(/</g, "&lt;")${")".repeat(depth)};\n}\n`;
      const large = file(8_000);
      expect(findHandWrittenEscapers(large).map((e) => e.name)).toEqual([
        "escapeHtml",
      ]);
      expect(growth(findHandWrittenEscapers, file(2_000), large)).toBeLessThan(
        8,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "a 10k-line build-time module of markup helpers lints in linear time (CPU growth under 8x for 4x the lines)",
    () => {
      const analyze = (body: string) =>
        analyzeServerScriptSource(body, {
          hasSrcAttribute: false,
          directive: "module",
        });
      const line = (i: number) =>
        `export const card${i} = (p: { name: string }) =>\n  \`<li style="--i: \${p.name}" class=\${p.name}>\${p.name}</li>\`;\n`;
      const file = (n: number) =>
        Array.from({ length: n }, (_, i) => line(i)).join("");
      const large = file(10_000);
      expect(analyze(large).length).toBeGreaterThanOrEqual(10_000);
      expect(growth(analyze, file(2_500), large)).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("findScriptModules: linear time", () => {
  it(
    "a page with 8k directive scripts (CPU growth under 8x for 4x the scripts)",
    () => {
      const root = path.resolve("/nonexistent-bascik-project");
      const scan = (text: string) =>
        findScriptModules({
          projectRoot: root,
          importRoot: path.join(root, "src"),
          html: [[path.join(root, "src/pages/index.html"), text]],
        });
      const page = (n: number) =>
        Array.from(
          { length: n },
          (_, i) =>
            `<script data-bascik-build>import x from "marked"; export default () => "${i}";</script>\n<p>Milk frother ${i}</p>\n`,
        ).join("");
      const large = page(8_000);
      expect(scan(large).size).toBe(0);
      expect(growth(scan, page(2_000), large)).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
