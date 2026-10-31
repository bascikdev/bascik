/**
 * linear-time.test-helper.ts in its own project: a check without
 * LINEAR_TIME_TIMEOUT_MS throws on every platform, rather than timing out
 * only on Windows CI, and linear and quadratic work read apart.
 */
import { describe, expect, it } from "vitest";
import {
  LINEAR_TIME_TIMEOUT_MS,
  MAX_GROWTH,
  growthOf,
} from "./linear-time.test-helper.ts";

/** Visits every pair of characters: quadratic in the length. */
const pairs = (text: string): number => {
  let count = 0;
  for (let i = 0; i < text.length; i++)
    for (let j = i; j < text.length; j++)
      if (text.charCodeAt(i) === text.charCodeAt(j)) count++;
  return count;
};

/** Visits every character once: linear in the length. */
const characters = (text: string): number => {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 97) count++;
  return count;
};

describe("linear-time.test-helper.ts", () => {
  it("misuse: growthOf in a test with the default timeout throws and names the timeout", () => {
    expect(() =>
      growthOf(
        () => "milk frother",
        () => "milk frother",
      ),
    ).toThrow(/give this test LINEAR_TIME_TIMEOUT_MS \(it has 5000 ms\)/);
  });

  it(
    "reads linear work under MAX_GROWTH and quadratic work over it",
    () => {
      const small = "ab".repeat(500);
      const large = "ab".repeat(2_000);
      expect(
        growthOf(
          () => characters(small.repeat(20)),
          () => characters(large.repeat(20)),
        ),
      ).toBeLessThan(MAX_GROWTH);
      expect(
        growthOf(
          () => pairs(small),
          () => pairs(large),
        ),
      ).toBeGreaterThan(MAX_GROWTH);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
