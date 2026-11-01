/**
 * Linear-time checks for scanTemplateHtml's URL scheme rule
 * (server-script-templates.test.ts has its behavior). CPU-growth sampling
 * takes minutes on Windows, so these run in the `linear-time` Vitest
 * project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import { scanTemplateHtml } from "./server-script-templates.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

describe("scanTemplateHtml: URL values, linear time (fix round 9)", () => {
  it(
    "a srcset or href with thousands of holes and long text reads in linear time (CPU growth under 8x for 4x the holes)",
    () => {
      // Each srcset entry's scheme is read once, however many holes it has;
      // a blank entry of holes and spaces starts its URL without a scan.
      const parts = (n: number): string[] => [
        '<img alt="" srcset="',
        ...Array.from({ length: n }, () => ""),
        " 1x, /a",
        ...Array.from({ length: n }, () => "b".repeat(20)),
        ' 2x"><a href="/p/',
        ...Array.from({ length: n }, () => `x${"y".repeat(20)}`),
        '">x</a>',
      ];
      expect(scanTemplateHtml(parts(10)).throwsAt).toBe(-1);
      const small = parts(5_000);
      const large = parts(20_000);
      expect(
        growthOf(
          () => scanTemplateHtml(small),
          () => scanTemplateHtml(large),
        ),
      ).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
