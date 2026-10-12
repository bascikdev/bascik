import { describe, expect, it } from "vitest";
import { BuildScriptError, locateBuildError } from "./build-error.ts";

const scriptError = () =>
  new BuildScriptError("[bascik] build script error in \"components/x.html\" at (line 4, column 7):\nboom", {
    sourceFile: "components/x.html",
    line: 4,
    column: 7,
  });

describe("BuildScriptError", () => {
  it("is an Error whose message is exactly the text it was given", () => {
    const error = scriptError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BuildScriptError");
    expect(error.message).toBe("[bascik] build script error in \"components/x.html\" at (line 4, column 7):\nboom");
  });

  it("exposes where the script is as data", () => {
    expect(scriptError()).toMatchObject({ sourceFile: "components/x.html", line: 4, column: 7 });
  });
});

describe("locateBuildError", () => {
  it("returns the location of a BuildScriptError", () => {
    expect(locateBuildError(scriptError())).toEqual({ file: "components/x.html", line: 4, column: 7 });
  });

  it("finds it inside an AggregateError, which is how the compile cycle wraps failures", () => {
    const wrapped = new AggregateError([scriptError()], "wrapped");
    expect(locateBuildError(wrapped)).toEqual({ file: "components/x.html", line: 4, column: 7 });
  });

  it("finds it behind a cause chain", () => {
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: scriptError() }) });
    expect(locateBuildError(wrapped)).toEqual({ file: "components/x.html", line: 4, column: 7 });
  });

  it("finds it through an aggregate nested in an aggregate", () => {
    const wrapped = new AggregateError([new Error("unrelated"), new AggregateError([scriptError()])]);
    expect(locateBuildError(wrapped)).toEqual({ file: "components/x.html", line: 4, column: 7 });
  });

  it("returns undefined for an error with no location", () => {
    expect(locateBuildError(new Error("plain"))).toBeUndefined();
    expect(locateBuildError("a string")).toBeUndefined();
    expect(locateBuildError(undefined)).toBeUndefined();
  });

  it("terminates on a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    expect(locateBuildError(a)).toBeUndefined();
  });
});
