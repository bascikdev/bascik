import { describe, it, expect } from "vitest";
import { fileToApiRoutePath } from "./api-routes.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

describe("fileToApiRoutePath", () => {
  it(
    "runs in linear time on a long slash run inside the path",
    () => {
      // `/\/+$/` is quadratic on a slash run that does not end the string.
      const relPath = (slashes: number) => `a${"/".repeat(slashes)}b.ts`;
      expect(fileToApiRoutePath(relPath(50_000))).toBe(
        `/api/a${"/".repeat(50_000)}b`,
      );
      expectLinearTime(relPath, 50_000, fileToApiRoutePath);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
