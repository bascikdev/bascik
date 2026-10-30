import { describe, it, expect } from "vitest";
import { getHttpPath } from "./paths.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

describe("getHttpPath", () => {
  it(
    "runs in linear time when the pages directory holds a long slash run",
    () => {
      // `/\/+$/` is quadratic on a slash run that does not end the string.
      const pagesDir = (slashes: number) => `${"/".repeat(slashes)}pages`;
      expect(getHttpPath("pages/about.html", pagesDir(50_000))).toBe("/about");
      expectLinearTime(pagesDir, 50_000, (dir) =>
        getHttpPath("pages/about.html", dir),
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
