/**
 * @module build-error
 *
 * A build script that throws is an authoring mistake in one specific file. The
 * dev server's error overlay needs to name that file and line, so the failure
 * carries them as data. Reading them back out of the message text would break
 * the first time the wording changed.
 */

/** Where a build script sits in the file it was written in. */
export interface BuildScriptLocation {
  /** Display path such as `components/site-footer.html` or `pages/index.html`. */
  sourceFile: string;
  /** 1-based line of the script's opening tag. */
  line: number;
  /** 1-based column of the script's opening tag. */
  column: number;
}

/**
 * A `data-bascik-build` script that failed. The message is the full human text,
 * unchanged, so the CLI's duplicate-message filter and existing log readers still
 * recognize it.
 */
export class BuildScriptError extends Error {
  readonly sourceFile: string;
  readonly line: number;
  readonly column: number;

  constructor(message: string, location: BuildScriptLocation) {
    super(message);
    this.name = "BuildScriptError";
    this.sourceFile = location.sourceFile;
    this.line = location.line;
    this.column = location.column;
  }
}

/** The location shape the browser overlay reads. */
export interface LocatedFailure {
  file: string;
  line: number;
  column: number;
}

/**
 * Finds the first {@link BuildScriptError} inside `error` and returns its location.
 *
 * Failures are wrapped on their way up: a compile scope collects them into an
 * `AggregateError`, and page processing keeps the original as `cause`. Both are
 * searched, to any depth. A visited set stops a cyclic cause chain from looping.
 */
export const locateBuildError = (error: unknown): LocatedFailure | undefined => {
  const seen = new Set<unknown>();
  const visit = (value: unknown): LocatedFailure | undefined => {
    if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
    seen.add(value);
    if (value instanceof BuildScriptError) {
      return { file: value.sourceFile, line: value.line, column: value.column };
    }
    const nested: unknown[] = [];
    if (value instanceof AggregateError) nested.push(...value.errors);
    if ("cause" in value) nested.push((value as { cause?: unknown }).cause);
    for (const child of nested) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(error);
};
