import { describe, expect, it } from "vitest";
import { hostnameExpectation } from "./server-address.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

describe("hostnameExpectation", () => {
  it(
    "runs in linear time on an unclosed bracket full of colons",
    () => {
      // `/^\[[^\]]*:[^\]]*\]/` lets both classes take the colons, so a
      // `[:::...` that never closes backtracks over every split point.
      const host = (colons: number) => `[${":".repeat(colons)}`;
      const check = (value: string) => hostnameExpectation(value, "--port");
      expect(check(host(20_000))).not.toMatch(/without brackets/);
      expectLinearTime(host, 20_000, check);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
