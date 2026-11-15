import { describe, it } from "vitest";
import { scanHtml, scanHtmlComments } from "./html-scanner.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

describe("scanHtml", () => {
  it(
    "stays linear on hostile input",
    () => {
      const cases = [
        (n: number) => `<svg>${"<g>".repeat(n)}${"</x>".repeat(n)}`,
        (n: number) =>
          `<svg><foreignObject>${"<div>".repeat(n)}${"</g>".repeat(n)}`,
        (n: number) => `<p ${'a="b" '.repeat(n * 2.5)}`,
        (n: number) => `<script>${"</scripts".repeat(n * 2.5)}`,
        (n: number) => "<!--".repeat(n * 2.5),
        (n: number) => "<".repeat(n * 5),
        // A start tag that closes a <p> walks the tracked elements to a
        // boundary (R2-07-b); depth is bounded, so each walk is too.
        (n: number) =>
          `<svg><foreignObject>${"<span>".repeat(500)}${"<div></div>".repeat(n / 2)}`,
        (n: number) =>
          `<svg><foreignObject>${"<b>".repeat(500)}${"<td><th><tr>".repeat(n / 3)}`,
        // End tags in a select in foreign content stop the scan at once.
        (n: number) =>
          `<svg><foreignObject><select>${"<option>a".repeat(n / 2)}</p>`,
      ];
      for (const input of cases)
        expectLinearTime(input, 20_000, scanHtml, {
          label: input(2).slice(0, 24),
        });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("scanHtmlComments", () => {
  it(
    "stays linear, including past the point where the scan stops",
    () => {
      // An end tag in a select in foreign content stops the scan at once, so
      // the comments after it are found by the fallback walk.
      const stopped = "<svg><foreignObject><select></p>";
      const cases = [
        (n: number) => "<!--a-->".repeat(n),
        (n: number) =>
          `<style>${"<!--".repeat(n)}</style>${"<!--a-->".repeat(n)}`,
        (n: number) => `${stopped}${"<!--a-->".repeat(n)}`,
        (n: number) => `${stopped}${"<!--".repeat(n * 2)}`,
        (n: number) => `${stopped}${"<!--a--".repeat(n)}`,
      ];
      for (const input of cases)
        expectLinearTime(input, 20_000, scanHtmlComments, {
          label: input(2).slice(0, 40),
        });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
