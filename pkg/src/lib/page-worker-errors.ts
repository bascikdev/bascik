/**
 * @module page-worker-errors
 *
 * A page that fails inside a page worker reaches the main thread as a
 * message, and a structured clone keeps neither an error's class nor its
 * own fields (`BuildScriptError.sourceFile`, `PageProcessingError.stage`).
 * The worker therefore sends what the main thread needs as plain data, and
 * the main thread rebuilds the error the serial path would have thrown, so
 * the dev overlay names the build script's file and line and the terminal
 * names the same stage in both modes. It also carries the dependencies the
 * failed compile tried to import and could not find: the watchers read them
 * from the main thread's store, never the worker's (F053, F054).
 */

import {
  BuildScriptError,
  locateBuildError,
  type BuildScriptLocation,
} from "./build-error.ts";
import { PageProcessingError } from "./page-diagnostics.ts";

/** What a page worker sends for a page that failed, beside the message. */
export interface PageWorkerFailure {
  /** The innermost message: the cause's, when `stage` is set. */
  message: string;
  /** The stage of a `PageProcessingError` the worker threw. */
  stage?: string;
  /** Where the build script that threw was written. */
  location?: BuildScriptLocation;
  /** Project-relative dependencies the failed compile could not find. */
  failedDependencies?: string[];
}

/** Plain data for `error`, safe to post across the thread boundary. */
export const toPageWorkerFailure = (
  error: unknown,
  failedDependencies: string[] = [],
): PageWorkerFailure => {
  const failure: PageWorkerFailure = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof PageProcessingError) {
    failure.stage = error.stage;
    const cause = error.cause;
    failure.message = cause instanceof Error ? cause.message : String(cause);
  }
  const located = locateBuildError(error);
  if (located)
    failure.location = {
      sourceFile: located.file,
      line: located.line,
      column: located.column,
    };
  if (failedDependencies.length > 0)
    failure.failedDependencies = [...failedDependencies];
  return failure;
};

const isPageWorkerFailure = (value: unknown): value is PageWorkerFailure =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { message?: unknown }).message === "string";

/**
 * The error the serial path would have seen for `failure`: a
 * `BuildScriptError` when a build script threw, wrapped in the worker's
 * `PageProcessingError` stage when there was one. Anything that is not a
 * failure description (an older worker, a crash) yields undefined.
 */
export const fromPageWorkerFailure = (
  pagePath: string,
  failure: unknown,
): Error | undefined => {
  if (!isPageWorkerFailure(failure)) return undefined;
  const cause = failure.location
    ? new BuildScriptError(failure.message, failure.location)
    : new Error(failure.message);
  return failure.stage
    ? new PageProcessingError(pagePath, failure.stage, cause)
    : cause;
};

/** The missing dependencies a failure description carries, or none. */
export const failedDependenciesOf = (failure: unknown): string[] =>
  isPageWorkerFailure(failure) && Array.isArray(failure.failedDependencies)
    ? failure.failedDependencies.filter(
        (dep): dep is string => typeof dep === "string",
      )
    : [];
