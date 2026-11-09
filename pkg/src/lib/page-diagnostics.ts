import { getCompilationPageErrorPolicy } from "./compilation-events.ts";

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findComponentRoot } from "./component-roots.ts";
import { getProjectPath, getRelativePath } from "./file-system.ts";

import { locateBuildError } from "./build-error.ts";
import { BascikConfig } from "./config.ts";
import { eventEmitter } from "./events.ts";

export const getFilePosition = (
  filePath: string,
  searchString: string,
  tagName?: string,
): { line: number; character: number } | null => {
  try {
    const content = readFileSync(filePath, "utf8");
    let index = content.indexOf(searchString);
    if (index === -1 && tagName) {
      const regex = new RegExp(`<${tagName}\\b`, "i");
      const match = content.match(regex);
      if (match && match.index !== undefined) {
        index = match.index;
      }
    }
    if (index === -1 && searchString.length > 30) {
      index = content.indexOf(searchString.slice(0, 30));
    }
    if (index !== -1) {
      const prefix = content.slice(0, index);
      const lines = prefix.split(/\r?\n/);
      return {
        line: lines.length,
        character: lines[lines.length - 1].length + 1,
      };
    }
  } catch {
    // Ignore read errors
  }
  return null;
};

/** Project-relative, forward-slash path for user-facing diagnostics. */
export const relativePagePathForDiagnostics = (pagePath: string): string =>
  (resolve(pagePath).startsWith(process.cwd())
    ? relative(process.cwd(), pagePath)
    : pagePath
  ).replace(/\\/g, "/");

export const getDisplayPath = (path: string): string => {
  if (findComponentRoot(path) !== undefined) {
    return getRelativePath(path, "components");
  }
  if (
    BascikConfig.directory?.pages &&
    path.includes(BascikConfig.directory.pages)
  ) {
    return getRelativePath(path, "pages");
  }
  return path;
};

export const findActiveSourceFile = (
  html: string,
  index: number,
  fallback: string,
): string => {
  const substring = html.slice(0, index);
  const regex =
    /<!--bascik-source-file:(.*?)-->|<!--bascik-source-file-end:(.*?)-->/g;
  const stack: string[] = [];
  let match;
  while ((match = regex.exec(substring)) !== null) {
    if (match[1] !== undefined) {
      stack.push(match[1]);
    } else if (match[2] !== undefined) {
      const idx = stack.lastIndexOf(match[2]);
      if (idx !== -1) {
        stack.splice(idx, 1);
      } else {
        stack.pop();
      }
    }
  }
  return stack[stack.length - 1] || fallback;
};

export class PageProcessingError extends Error {
  readonly pagePath: string;
  readonly stage: string;

  constructor(pagePath: string, stage: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`${stage}: ${causeMessage}`, { cause });
    this.name = "PageProcessingError";
    this.pagePath = pagePath;
    this.stage = stage;
  }
}

export class PageProcessingAggregateError extends AggregateError {
  readonly pageErrors: PageProcessingError[];

  constructor(pageErrors: PageProcessingError[]) {
    const details = pageErrors
      .map(
        ({ pagePath, stage, message }) =>
          `  ${relativePagePathForDiagnostics(pagePath)}\n    ${stage}: ${message.replace(`${stage}: `, "")}`,
      )
      .join("\n");
    // Project-relative paths and a correct plural: this is the summary the
    // CLI prints, as docs/content/cli.md shows it (audit 159 finding 79).
    super(
      pageErrors,
      `Build failed with ${pageErrors.length} page error${pageErrors.length === 1 ? "" : "s"}:\n${details}`,
    );
    this.name = "PageProcessingAggregateError";
    this.pageErrors = pageErrors;
  }
}

export const normalizePageError = (
  pagePath: string,
  error: unknown,
  stage = "transpile page",
): PageProcessingError =>
  error instanceof PageProcessingError
    ? error
    : new PageProcessingError(pagePath, stage, error);

export const publishBuildError = (err: PageProcessingError): void => {
  // A build script carries where it was written (which may be a component, not the page),
  // named as the terminal names it, so the overlay and the terminal agree.
  const located = locateBuildError(err);
  if (located) {
    eventEmitter.emit("build-error", { message: err.message, ...located });
    return;
  }
  const position = getFilePosition(err.pagePath, err.message, undefined);
  eventEmitter.emit("build-error", {
    message: err.message,
    file: getProjectPath(err.pagePath),
    line: position?.line,
    column: position?.character,
  });
};

const componentLoadFailures = new WeakSet<object>();

/**
 * True for an error that {@link reportComponentLoadFailure} has seen: the components could not be loaded,
 * so no page compiled. Dev boot keeps the server up for this one and lets a fixed component recover it
 * (audit 159 finding 43); any other boot failure (a missing pages directory) still ends the process.
 */
export const isComponentLoadFailure = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  componentLoadFailures.has(error);

/**
 * Tells the dev browser that the components could not be loaded, which is the one failure that happens
 * before any page exists to attach it to. A component's build script that throws lands here.
 *
 * It follows the same ownership rule as {@link reportPageErrors}: a production build has no browsers, and
 * a compile scope with the `throw` policy hands the failure to its source cycle, which reports it once.
 * Everything else (the plain dev watcher, a newly added component) has no other owner, so it publishes.
 */
export const reportComponentLoadFailure = (error: unknown): void => {
  if (typeof error === "object" && error !== null)
    componentLoadFailures.add(error);
  if (BascikConfig.isBuild || getCompilationPageErrorPolicy() === "throw")
    return;
  const location = locateBuildError(error);
  eventEmitter.emit("build-error", {
    message: error instanceof Error ? error.message : String(error),
    ...(location ?? {}),
  });
};

export const reportPageErrors = (pageErrors: PageProcessingError[]): void => {
  if (pageErrors.length === 0) return;
  const aggregateError = new PageProcessingAggregateError(pageErrors);
  const pageErrorPolicy = getCompilationPageErrorPolicy();
  if (BascikConfig.isBuild || pageErrorPolicy === "throw") throw aggregateError;

  // One owner publishes located build failures to the SSE layer. The dev
  // browser overlay needs the source file and line; suppressing stack detail
  // is not required in dev, but we still publish a concise located payload.
  for (const err of pageErrors) {
    publishBuildError(err);
  }
  console.error(aggregateError.message);
};
