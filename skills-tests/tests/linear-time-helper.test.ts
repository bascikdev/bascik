/**
 * Misuse: a growth check left in a unit test file. The unit project is the
 * one coverage instruments and Windows runs on every pull request, so
 * linear-time.test-helper.ts refuses to measure there and names the fix.
 */
import { describe, expect, it } from "vitest";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test-helper.ts";

describe("linear-time.test-helper.ts in the unit project", () => {
  it(
    "misuse: growthOf in a unit test throws and says where the check goes",
    () => {
      expect(() =>
        growthOf(
          () => "milk frother",
          () => "milk frother",
        ),
      ).toThrow(/move this test into a \*\.linear-time\.test\.ts file/);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
