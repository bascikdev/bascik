/**
 * The excerpt in an HtmlError folds each line break, with the whitespace
 * around it, into one space. It runs on the author's static template text,
 * and stays linear on any input (CodeQL alert 171: the regex it replaced,
 * whitespace-star newline whitespace-star, backtracks quadratically on a long
 * run of whitespace with no line break).
 */
import { describe, it } from "vitest";
import { foldLineBreaks } from "./html-template.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
  repeatTo,
} from "./linear-time.test-helper.ts";

describe("foldLineBreaks", () => {
  it(
    "takes linear time on a long run of tabs and spaces with no line break",
    () => {
      expectLinearTime(
        (size) => `<p>${repeatTo("\t ", size)}x</p>`,
        40_000,
        foldLineBreaks,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "takes linear time on whitespace runs that each end in a line break",
    () => {
      expectLinearTime(
        (size) => repeatTo("\t \t \n", size),
        200_000,
        foldLineBreaks,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
