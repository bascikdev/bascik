import { describe, it } from "vitest";
import { trimSlashes, trimTrailingSlashes } from "./slashes.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

// A long run of "/" that does not end the string is the worst case for the
// anchored regex `/\/+$/`: V8 retries the run from every start position, so the
// cost grows with the square of its length (about 4 s for 50,000 slashes).
const SLASH_RUN = 50_000;
const slashRun = (length: number): string => `${"/".repeat(length)}x`;

describe("trimTrailingSlashes", () => {
  it(
    "runs in linear time on a long slash run that does not end the string",
    () => {
      expectLinearTime(slashRun, SLASH_RUN, trimTrailingSlashes);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("trimSlashes", () => {
  it(
    "runs in linear time on a long slash run that does not end the string",
    () => {
      expectLinearTime(slashRun, SLASH_RUN, trimSlashes);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
