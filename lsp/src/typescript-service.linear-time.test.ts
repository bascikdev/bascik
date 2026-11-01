/**
 * Linear-time checks for TypeScript block diagnostics, which run on every keystroke in a page.
 *
 * A keystroke in one block of a page with four times the blocks may cost about four times as much (each block's
 * errors are asked for again), never sixteen: finding the blocks, keeping the unchanged ones' versions and mapping
 * offsets back must not rescan the page per block. The block scan itself must stay linear on half-typed markup:
 * script tags that never close, quotes that never end, and comments.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  extractPageScopeScripts,
  extractTypeScriptBlocks,
} from "./typescript-blocks.js";
import { TypeScriptProject } from "./typescript-service.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";
import { createFixture, typescript6 as ts } from "./typescript.test.util.js";

const fixture = createFixture({ "bascik.config.ts": "export default {};\n" });
afterAll(() => fixture.remove());

// Both inputs must exceed V8's large-object allocation boundary. Unit counts alone
// cross it for some fixtures: 8,000/32,000 unclosed-comment units are 56 KB/224 KB.
const SMALL_SCAN_CHARACTERS = 256_000;
const scanGrowth = (
  html: (count: number) => string,
  scan: (text: string) => unknown,
): number => {
  const prefixLength = html(0).length;
  const unitLength = html(1).length - prefixLength;
  expect(unitLength).toBeGreaterThan(0);
  const smallCount = Math.ceil(SMALL_SCAN_CHARACTERS / unitLength);
  const small = html(smallCount);
  const large = html(4 * smallCount);
  expect(small.length).toBeGreaterThanOrEqual(SMALL_SCAN_CHARACTERS);
  expect(large.length - prefixLength).toBe(4 * (small.length - prefixLength));
  return growthOf(
    () => scan(small),
    () => scan(large),
  );
};

/** A page of `count` client blocks, each with a little typed code. */
const pageOf = (count: number, edited: string) =>
  Array.from(
    { length: count },
    (_, index) =>
      `<section>Milk frother ${index}</section>\n<script type="text/typescript">\n  const speed${index}: number = ${index === 0 ? edited : index};\n  document.title = String(speed${index});\n</script>\n`,
  ).join("");

describe("TypeScript block diagnostics: linear time", () => {
  it(
    "costs a keystroke in proportion to the page's block count",
    () => {
      const keystrokeIn = (count: number) => {
        const service = new TypeScriptProject({
          ts,
          projectRoot: fixture.root,
          importRoot: fixture.file("src"),
        });
        const file = fixture.write(
          `src/pages/blocks-${count}.html`,
          pageOf(count, "0"),
        );
        let typed = 0;
        // Warm the program, as an open page is, so the samples measure keystrokes only.
        service.diagnostics(file, pageOf(count, "0"));
        return () => {
          typed++;
          // Alternate between a valid and an invalid value in the first block only.
          const text = pageOf(
            count,
            typed % 2 === 0 ? String(typed) : `"${typed}"`,
          );
          const diagnostics = service.diagnostics(file, text);
          if (diagnostics.length !== typed % 2)
            throw new Error("unexpected diagnostics");
        };
      };
      expect(growthOf(keystrokeIn(10), keystrokeIn(40))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  const scans: Array<[string, (n: number) => string]> = [
    [
      "script tags that never close",
      (n) => `text/typescript ${'<script type="text/typescript">'.repeat(n)}`,
    ],
    [
      "open tags missing their >",
      (n) => `text/typescript ${"<script type=x ".repeat(n)}`,
    ],
    [
      "a quote that never ends",
      (n) => `text/typescript <script type="${"a".repeat(n)}`,
    ],
    [
      "many comments",
      (n) => `text/typescript ${"<!-- <script> -->".repeat(n)}`,
    ],
    [
      "an unclosed comment",
      (n) => `text/typescript <!--${"<script>".repeat(n)}`,
    ],
    [
      "many closed blocks",
      (n) => '<script type="text/typescript">let a = 1;</script>'.repeat(n),
    ],
    [
      "end tags that are not script end tags",
      (n) =>
        `<script type="text/typescript">${"</scripts>".repeat(n)}</script>`,
    ],
  ];

  it.each(scans)(
    "finds blocks in linear time with %s",
    (_label, html) => {
      expect(scanGrowth(html, extractTypeScriptBlocks)).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it.each(scans)(
    "finds the page's classic scripts in linear time with %s",
    (_label, html) => {
      expect(
        scanGrowth(
          (n) => html(n).replaceAll("text/typescript", "text/javascript"),
          extractPageScopeScripts,
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "costs a keystroke in proportion to the page's plain scripts, whose names stay known",
    () => {
      const keystrokeIn = (count: number) => {
        const service = new TypeScriptProject({
          ts,
          projectRoot: fixture.root,
          importRoot: fixture.file("src"),
        });
        const plain = Array.from(
          { length: count },
          (_, index) =>
            `<script>function track${index}(name) { return name; }</script>\n`,
        ).join("");
        const pageWith = (value: string) =>
          `${plain}<script type="text/typescript">\n  track${count - 1}("open");\n  const speed: number = ${value};\n</script>\n`;
        const file = fixture.write(
          `src/pages/plain-${count}.html`,
          pageWith("0"),
        );
        let typed = 0;
        service.diagnostics(file, pageWith("0"));
        return () => {
          typed++;
          const diagnostics = service.diagnostics(
            file,
            pageWith(typed % 2 === 0 ? String(typed) : `"${typed}"`),
          );
          if (diagnostics.length !== typed % 2)
            throw new Error("unexpected diagnostics");
        };
      };
      expect(growthOf(keystrokeIn(50), keystrokeIn(200))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
