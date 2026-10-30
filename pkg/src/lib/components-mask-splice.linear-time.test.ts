import { describe, expect, it } from "vitest";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
} from "./components.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
} from "./linear-time.test-helper.ts";

describe("comment masking on a run of unclosed comment openers", () => {
  // `<!--[\s\S]*?-->` retried from every `<!--` scans to the end each time:
  // quadratic, about 3 s for this input. Both maskers must stay linear.
  const COUNT = 50_000;
  const openers = (count: number) => "<!--".repeat(count);
  const html = openers(COUNT);

  it(
    "masks in linear time in maskRawTextContent",
    () => {
      expect(maskRawTextContent(html)).toBe(html);
      expectLinearTime(openers, COUNT, maskRawTextContent);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "masks and reports open in linear time in maskRawTextContentWithClosure",
    () => {
      expect(maskRawTextContentWithClosure(html)).toEqual({
        masked: html,
        closed: false,
      });
      expectLinearTime(openers, COUNT, maskRawTextContentWithClosure);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
