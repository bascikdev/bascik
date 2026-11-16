import { describe, expect, it } from "vitest";
import {
  PageProcessingAggregateError,
  PageProcessingError,
  unprintedBuildFailureMessage,
} from "./page-diagnostics.ts";

const buildScriptError = new PageProcessingError(
  "src/pages/index.html",
  "transpile page",
  new Error(
    '[bascik] build script error in "src/pages/index.html" at (line 1, column 1):\nError: boom',
  ),
);
const routesScriptError = new PageProcessingError(
  "src/pages/[slug].html",
  "transpile page",
  new Error(
    '[bascik] routes script error in "src/pages/[slug].html":\nError: boom',
  ),
);
const unreadablePage = new PageProcessingError(
  "src/pages/bad.html",
  "transpile page",
  new Error("EACCES: permission denied, open 'src/pages/bad.html'"),
);

describe("unprintedBuildFailureMessage", () => {
  it("prints nothing when every page error printed itself", () => {
    const error = new PageProcessingAggregateError([
      buildScriptError,
      routesScriptError,
    ]);
    expect(unprintedBuildFailureMessage(error)).toBeNull();
  });

  it("prints the whole summary when no page error printed itself", () => {
    const error = new PageProcessingAggregateError([unreadablePage]);
    expect(unprintedBuildFailureMessage(error)).toBe(error.message);
  });

  it("keeps the pages a script error would have hidden, without repeating the script error", () => {
    const message = unprintedBuildFailureMessage(
      new PageProcessingAggregateError([
        buildScriptError,
        unreadablePage,
        routesScriptError,
      ]),
    );
    expect(message).toMatch(
      /^Build failed with 3 page errors \(2 printed above\):\n/,
    );
    expect(message).toMatch(/^ {2}src\/pages\/bad\.html$/m);
    expect(message).toMatch(/EACCES/);
    expect(message).not.toMatch(/script error|boom/);
  });

  it("skips a plain error that printed itself and prints any other", () => {
    expect(
      unprintedBuildFailureMessage(
        new Error("[bascik] build script error:\nError: boom"),
      ),
    ).toBeNull();
    expect(
      unprintedBuildFailureMessage(new Error("Pages directory not found")),
    ).toBe("Pages directory not found");
    // A thrown non-Error value is still reported, not dropped.
    expect(unprintedBuildFailureMessage("plain failure")).toBe("plain failure");
  });
});
