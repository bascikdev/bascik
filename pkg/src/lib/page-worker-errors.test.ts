import { describe, expect, it } from "vitest";
import { BuildScriptError, locateBuildError } from "./build-error.ts";
import { PageProcessingError } from "./page-diagnostics.ts";
import {
  failedDependenciesOf,
  fromPageWorkerFailure,
  toPageWorkerFailure,
} from "./page-worker-errors.ts";

const PAGE = "/site/src/pages/index.html";
const buildError = () =>
  new BuildScriptError(
    '[bascik] build script error in "components/site-footer.html" at (line 7, column 3):\nboom',
    { sourceFile: "components/site-footer.html", line: 7, column: 3 },
  );

/** What the main thread receives: the description after a structured clone. */
const acrossThreads = (error: unknown, deps?: string[]) =>
  structuredClone(toPageWorkerFailure(error, deps));

describe("page worker failures across the thread boundary (F054)", () => {
  it("keeps a component build script's file, line and column", () => {
    const restored = fromPageWorkerFailure(PAGE, acrossThreads(buildError()));
    expect(restored).toBeInstanceOf(BuildScriptError);
    expect(restored!.message).toBe(buildError().message);
    expect(locateBuildError(restored)).toEqual({
      file: "components/site-footer.html",
      line: 7,
      column: 3,
    });
  });

  it("keeps the stage of a PageProcessingError and the location inside it", () => {
    const thrown = new PageProcessingError(
      PAGE,
      "validate markup",
      buildError(),
    );
    const restored = fromPageWorkerFailure(PAGE, acrossThreads(thrown));
    expect(restored).toBeInstanceOf(PageProcessingError);
    expect((restored as PageProcessingError).stage).toBe("validate markup");
    expect(restored!.message).toBe(thrown.message);
    expect(locateBuildError(restored)?.file).toBe(
      "components/site-footer.html",
    );
  });

  it("keeps a plain failure's message, with no location", () => {
    const restored = fromPageWorkerFailure(
      PAGE,
      acrossThreads(new Error("Page does not contain a non-empty <body>")),
    );
    expect(restored?.message).toBe("Page does not contain a non-empty <body>");
    expect(locateBuildError(restored)).toBeUndefined();
    expect(
      fromPageWorkerFailure(PAGE, acrossThreads("thrown string"))?.message,
    ).toBe("thrown string");
  });

  it("carries the helpers the compile could not import (F053)", () => {
    const detail = acrossThreads(buildError(), ["src/pages/lib/prices.ts"]);
    expect(failedDependenciesOf(detail)).toEqual(["src/pages/lib/prices.ts"]);
    expect(failedDependenciesOf(acrossThreads(buildError()))).toEqual([]);
  });

  it.each([undefined, null, "boom", 42, {}, { message: 7 }])(
    "ignores a detail that is not a failure description (%s)",
    (detail) => {
      expect(fromPageWorkerFailure(PAGE, detail)).toBeUndefined();
      expect(failedDependenciesOf(detail)).toEqual([]);
    },
  );

  it("drops anything in failedDependencies that is not a path", () => {
    expect(
      failedDependenciesOf({
        message: "x",
        failedDependencies: ["a.ts", 3, null, "b.ts"],
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });
});
