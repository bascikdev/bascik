/**
 * What a script threw when it was not an Error: `throw "text"`, `throw null`,
 * `Promise.reject()`. Such a value carries no stack, so nothing in it names
 * the script's file or line; the report says what was thrown and how to get
 * a located one. `String(value)` alone read as Bascik's own `Error: null`.
 *
 * Self-contained (no imports, no helpers outside its body): the build and
 * routes script runner embeds its source text.
 */
export function describeNonErrorThrow(value: unknown): string {
  let shown: string;
  if (value === undefined) shown = "undefined (or rejected with no reason)";
  else if (value === null) shown = "null";
  else if (typeof value === "string")
    shown = `the string ${JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value)}`;
  else if (typeof value === "object") {
    let text: string;
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = Object.prototype.toString.call(value);
    }
    shown = `an object ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
  } else {
    let text: string;
    try {
      text = String(value);
    } catch {
      text = typeof value;
    }
    // A thrown function prints its whole source.
    shown = `the ${typeof value} ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
  }
  return `The script threw ${shown}, not an Error, so there is no stack trace with its line. Throw an Error instead: throw new Error("...").`;
}

const wrapped = new WeakSet<Error>();

/**
 * The Error a host reports for `raw`: `raw` itself when it is one, else an
 * Error whose message describes it and whose stack is only that message, so
 * no report shows the frames of the Bascik code that made it.
 */
export const toThrownError = (raw: unknown): Error => {
  if (raw instanceof Error) return raw;
  const error = new Error(describeNonErrorThrow(raw));
  error.stack = error.message;
  wrapped.add(error);
  return error;
};

/** True for an Error `toThrownError` made from a value that was not one. */
export const isWrappedNonErrorThrow = (error: unknown): boolean =>
  error instanceof Error && wrapped.has(error);
