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

/**
 * A `data-bascik-server` or `data-bascik-stream` script that failed. The message
 * is the complete report: the header and the user's cleaned stack. Whoever logs
 * it prints the message, not `stack`, which would add Bascik's own frames.
 */
export class ServerScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerScriptError";
  }
}

/**
 * A component source the browser could not read safely: a `<style>` or `<script>` that is never
 * closed, or a client script with a JavaScript syntax error. The page would build and then fail
 * in the browser, so the build stops instead and names the file and line.
 */
export class ComponentSyntaxError extends Error {
  readonly sourceFile: string;
  readonly line: number;
  readonly column: number;

  constructor(message: string, location: BuildScriptLocation) {
    super(message);
    this.name = "ComponentSyntaxError";
    this.sourceFile = location.sourceFile;
    this.line = location.line;
    this.column = location.column;
  }
}

/**
 * Component CSS the browser could not read safely, such as an unbalanced brace. All component
 * CSS is joined into one page stylesheet, so the mistake would break other components' rules;
 * the build stops instead and names the file and line.
 */
export class ComponentCssSyntaxError extends ComponentSyntaxError {
  constructor(message: string, location: BuildScriptLocation) {
    super(message, location);
    this.name = "ComponentCssSyntaxError";
  }
}

/** The location shape the browser overlay reads. */
export interface LocatedFailure {
  file: string;
  line: number;
  column: number;
}

/**
 * Finds the first {@link BuildScriptError} or {@link ComponentSyntaxError} inside `error` and returns its location.
 *
 * Failures are wrapped on their way up: a compile scope collects them into an
 * `AggregateError`, and page processing keeps the original as `cause`. Both are
 * searched, to any depth. A visited set stops a cyclic cause chain from looping.
 */
export const locateBuildError = (
  error: unknown,
): LocatedFailure | undefined => {
  const seen = new Set<unknown>();
  const visit = (value: unknown): LocatedFailure | undefined => {
    if (typeof value !== "object" || value === null || seen.has(value))
      return undefined;
    seen.add(value);
    if (
      value instanceof BuildScriptError ||
      value instanceof ComponentSyntaxError
    ) {
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
