/**
 * Linear-time checks for the tag scans behind Find All References:
 * `scanHtmlTags` and `findComponentUsages` (references-scan.test.ts has
 * their behavior). Each input is a pathological run that a backtracking or
 * rescanning scan would make quadratic. CPU-growth sampling takes minutes on
 * Windows, so these run in the `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import { scanHtmlTags } from "./references.js";
import { findComponentUsages } from "./component-usages.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

/** A label, and the input made of `n` repeats of its pathological unit. */
type Case = [string, (n: number) => string, number];

describe("scanHtmlTags: linear time", () => {
  it.each<Case>([
    ["many tags with unterminated quotes", (n) => '<a b="'.repeat(n), 10_000],
    [
      "an unterminated quote between many tag starts",
      (n) => `<a"${'"<a"'.repeat(n)}`,
      10_000,
    ],
    ["many unclosed script openers", (n) => "<script>".repeat(n), 20_000],
    ["many unclosed comments", (n) => "<!-- ".repeat(n), 20_000],
    ["a long comment dash run", (n) => `<!--${"-".repeat(n)}`, 40_000],
    [
      "an unclosed tag name with a long hyphen run",
      (n) => `<a${"-".repeat(n)}`,
      40_000,
    ],
  ])(
    "runs in linear time on %s",
    (_label, sourceOf, large) => {
      // Tick-aware CPU-time growth: see linear-time.test.util.ts.
      const small = sourceOf(large / 4);
      const big = sourceOf(large);
      expect(
        growthOf(
          () => scanHtmlTags(small),
          () => scanHtmlTags(big),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("findComponentUsages: linear time", () => {
  const names = new Set(["my-card", "x-a", "style-guide", "script-loader"]);

  it.each<Case>([
    ["many unclosed script openers", (n) => "<script>".repeat(n), 20_000],
    [
      "many unclosed style-guide openers",
      (n) => "<style-guide>".repeat(n),
      20_000,
    ],
    [
      "many escaped script openers",
      (n) => "<script><!--<script>".repeat(n),
      10_000,
    ],
    ["many unclosed comments", (n) => "<!-- ".repeat(n), 20_000],
    ["many tags with unterminated quotes", (n) => '<a b="'.repeat(n), 10_000],
    ["many names with no >", (n) => "<my-card ".repeat(n), 20_000],
    ["many usages", (n) => "<my-card></my-card>".repeat(n), 20_000],
  ])(
    "runs in linear time on %s",
    (_label, sourceOf, large) => {
      // Tick-aware CPU-time growth: see linear-time.test.util.ts.
      const small = sourceOf(large / 4);
      const big = sourceOf(large);
      expect(
        growthOf(
          () => findComponentUsages(small, names),
          () => findComponentUsages(big, names),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
