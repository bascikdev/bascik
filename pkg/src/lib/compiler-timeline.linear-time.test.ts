import { describe, expect, it } from "vitest";
import { isClinicTraceJoinFailure } from "../../bench/profile-workload.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";

describe("rotated Node trace log join", () => {
  it(
    "recognizes only Clinic trace-join failures after a normal target exit",
    () => {
      const stack =
        "    at onclosenexttick (/repo/node_modules/end-of-stream/index.js:55:86)\n    at process.processTicksAndRejections (node:internal/process/task_queues:85:11)\n";
      const failure = `✓ Build complete in 28.42s\nAnalysing data\nError: premature close\n${stack}`;
      expect(isClinicTraceJoinFailure(failure)).toBe(true);
      expect(
        isClinicTraceJoinFailure("Analysing data\nError: premature close\n"),
      ).toBe(true);
      expect(
        isClinicTraceJoinFailure(`process exited with exit code 1\n${failure}`),
      ).toBe(false);
      expect(
        isClinicTraceJoinFailure(
          `${failure}Output file is /p/1.clinic-bubbleprof\n`,
        ),
      ).toBe(false);
      expect(isClinicTraceJoinFailure("Analysing data\nError: ENOSPC\n")).toBe(
        false,
      );
      expect(isClinicTraceJoinFailure(`${failure}Another failure\n`)).toBe(
        false,
      );
      expect(
        isClinicTraceJoinFailure(
          "Analysing data\r\nError: premature close\r\n    at a (x.js:1:1)\r",
        ),
      ).toBe(true);
      // Many frame-like repetitions on one line with a non-matching tail must not backtrack exponentially.
      const log = (frames: number) =>
        `Analysing data\nError: premature close\n\tat ${"\tat ".repeat(frames)}\nnot a frame`;
      expect(isClinicTraceJoinFailure(log(5000))).toBe(false);
      expectLinearTime(log, 5000, isClinicTraceJoinFailure);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
