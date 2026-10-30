import { describe, expect, it } from "vitest";
import {
  applyOutputScope,
  stripOutputScopeAttribute,
  type OutputScope,
} from "./output-scope.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

const scope: OutputScope = {
  classes: { item: "bascik__c__item", wrap: "bascik__c__wrap" },
  elements: { h2: "bascik__c__el__h2", a: "bascik__c__el__a" },
};

describe("stripOutputScopeAttribute", () => {
  it(
    "runs in linear time on a long whitespace run without the annotation",
    () => {
      // `\s+data-...` retried the run from every whitespace position: 100k
      // tabs took 17 s (CodeQL js/polynomial-redos).
      const open = (tabs: number) =>
        `<script${"\t".repeat(tabs)}data-bascik-build>`;
      expect(stripOutputScopeAttribute(open(100_000))).toBe(open(100_000));
      expectLinearTime(open, 100_000, stripOutputScopeAttribute);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("applyOutputScope", () => {
  it(
    "runs in linear time on many comment openers without a close",
    () => {
      // `<!--[\s\S]*?-->` rescanned to the end from every opener: 40k
      // openers took 2 s (CodeQL js/polynomial-redos). Request-time output can
      // carry text a visitor typed.
      const html = (openers: number) =>
        `<p class="item">a</p>${"<!--".repeat(openers)}`;
      expect(applyOutputScope(html(50_000), scope)).toBe(
        `<p class="bascik__c__item">a</p>${"<!--".repeat(50_000)}`,
      );
      expectLinearTime(html, 50_000, (h) => applyOutputScope(h, scope));
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "runs in linear time on open-tag starts that never close",
    () => {
      // Each `<a` used to be scanned to the end of the output: no `>` at all,
      // an unclosed quote at the end, or quotes that pair differently from
      // each start. A later real tag is still found.
      const shapes = [
        (n: number) => "<a".repeat(n),
        (n: number) => '<a"'.repeat(n),
        (n: number) => `${'<a""'.repeat(n)}'>`,
        (n: number) => `<a${'"<a"'.repeat(n)}'>`,
        (n: number) => `<a${"\"<a'".repeat(n)}`,
      ];
      for (const shape of shapes) {
        const label = shape(2).slice(0, 8);
        expect(applyOutputScope(shape(20_000), scope), label).toBe(
          shape(20_000),
        );
        expectLinearTime(shape, 20_000, (h) => applyOutputScope(h, scope), {
          label,
        });
      }
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
