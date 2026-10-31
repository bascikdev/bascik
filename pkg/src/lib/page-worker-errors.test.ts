import { describe, expect, it } from "vitest";
import { BuildScriptError, locateBuildError } from "./build-error.ts";
import { normalizePageError, PageProcessingError } from "./page-diagnostics.ts";
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

describe("every error shape a page worker can throw (R2-03)", () => {
  /** What the terminal and overlay read from a page error: message, stage, location. */
  const reported = (error: unknown) => {
    const normalized = normalizePageError(PAGE, error);
    return {
      message: normalized.message,
      stage: normalized.stage,
      location: locateBuildError(normalized),
    };
  };
  const located = buildError();
  const shapes: Array<[string, unknown]> = [
    ["a BuildScriptError with its location", located],
    ["a plain Error", new Error("Page does not contain a non-empty <body>")],
    ["a TypeError", new TypeError("x is not a function")],
    [
      "an Error whose cause is a located BuildScriptError",
      new Error("compile failed", { cause: located }),
    ],
    [
      "an AggregateError holding a located BuildScriptError",
      new AggregateError([new Error("other"), located], "2 failures"),
    ],
    ["an AggregateError with no message", new AggregateError([located])],
    [
      "a PageProcessingError whose cause is not an Error",
      new PageProcessingError(PAGE, "render components", "a thrown string"),
    ],
    [
      "a PageProcessingError around an AggregateError",
      new PageProcessingError(
        PAGE,
        "validate markup",
        new AggregateError([located], "many"),
      ),
    ],
    ["a thrown string", "boom"],
    ["a thrown number", 42],
    ["thrown null", null],
    ["thrown undefined", undefined],
    ["a thrown plain object", { message: "looks like an error", code: 7 }],
    ["a thrown Symbol", Symbol("odd")],
  ];

  it.each(shapes)(
    "%s reports the same message, stage and location as the serial path",
    (_label, thrown) => {
      const restored = fromPageWorkerFailure(PAGE, acrossThreads(thrown));
      expect(restored).toBeInstanceOf(Error);
      expect(reported(restored)).toEqual(reported(thrown));
    },
  );

  it("keeps the message of an Error whose message is not a string", () => {
    const odd = Object.assign(new Error("x"), { message: 404 });
    const detail = acrossThreads(odd);
    expect(detail.message).toBe("404");
    expect(fromPageWorkerFailure(PAGE, detail)?.message).toBe("404");
  });

  it("survives a cyclic cause chain", () => {
    const cyclic = new Error("loop");
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(fromPageWorkerFailure(PAGE, acrossThreads(cyclic))?.message).toBe(
      "loop",
    );
  });
});
