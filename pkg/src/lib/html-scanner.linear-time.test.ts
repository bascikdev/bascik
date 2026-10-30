import { describe, it } from "vitest";
import { scanHtml } from "./html-scanner.ts";
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
      ];
      for (const input of cases)
        expectLinearTime(input, 20_000, scanHtml, {
          label: input(2).slice(0, 24),
        });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
