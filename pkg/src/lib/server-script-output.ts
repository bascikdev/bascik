/**
 * @module server-script-output
 *
 * What a `data-bascik-server` or `data-bascik-stream` script's return value
 * prints (prompt 158 R3-04, F060).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A server script returns markup. The rules follow how the `html` helper
 * inserts a value into a text hole, minus the escaping (a script's own
 * string is markup, not text):
 *
 * - a string is printed as it is;
 * - a number, a bigint or `true` is its text; `null`, `undefined` and
 *   `false` print nothing;
 * - an `html` or `raw()` value (from any copy of the module: the brand is a
 *   registered symbol) prints its markup, a `json()` value its text;
 * - an array is each item by these rules with no separator, nested arrays
 *   flattened (up to 1000 levels), so `items.map((p) => html`...`)` just
 *   works;
 * - an object with its own `toString` (a `Date`, a `URL`, a class) prints
 *   that text, except an `Error`, whose text may be an internal message.
 *
 * Anything else is a mistake that `String(value)` would print as
 * `[object ...]` or worse: a Promise (a forgotten `await`, or an async
 * `.map`), a `Response` (the API-route habit), an `Error` (`return e` in a
 * `catch`), a plain object, a `Map`, a function or a symbol. Those come back as an error the host reports: a
 * located server-script error in development, a once-per-script warning and
 * an empty slot in production.
 *
 * Portable (no `node:` imports, no config): Node's `runServerScriptJob` and
 * the Cloudflare Worker's job runner both classify a return here, so the two
 * hosts print the same bytes and word the same mistake the same way.
 */

const HTML = Symbol.for("bascik.html");
const JSON_TEXT = Symbol.for("bascik.json");

/** Arrays in a returned value nest at most this deep (a cycle reaches it too), as in `html`. */
export const MAX_RETURN_ARRAY_DEPTH = 1000;

export type ServerScriptOutputErrorKind =
  | "promise"
  | "response"
  | "error"
  | "object"
  | "function"
  | "symbol"
  | "array-depth";

export interface ServerScriptOutputError {
  kind: ServerScriptOutputErrorKind;
  /** What was received, for a message: "a Promise", "an array holding a Promise at [2]". */
  received: string;
  /** Whether the value was inside a returned array. */
  inArray: boolean;
}

export type ServerScriptOutput =
  | { text: string; error?: undefined }
  | { text?: undefined; error: ServerScriptOutputError };

const isThenable = (value: object): boolean => {
  const then = (value as { then?: unknown }).then;
  return typeof then === "function";
};

/** The `[object Tag]` of a value, or "" when reading it throws (a hostile Proxy). */
const objectTag = (value: object): string => {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "";
  }
};

const OBJECT_TAG = /^\[object [^\]]*\]$/;

/** An Error's name for a message, never its text (which may be internal). */
const errorName = (value: object): string => {
  try {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string" && /^[\w$.]{1,64}$/.test(name)) return name;
  } catch {
    // A hostile getter: fall back to the generic name.
  }
  return "Error";
};

interface Failure {
  kind: ServerScriptOutputErrorKind;
  what: string;
}

/** The text of one non-array value, or what is wrong with it. */
const valueText = (value: unknown): string | Failure => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined || value === false) return "";
  switch (typeof value) {
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    case "function":
      return { kind: "function", what: "a function" };
    case "symbol":
      return { kind: "symbol", what: "a symbol" };
  }
  const object = value as object;
  const brand =
    (object as Record<symbol, unknown>)[HTML] ??
    (object as Record<symbol, unknown>)[JSON_TEXT];
  if (typeof brand === "string") return brand;
  if (isThenable(object)) return { kind: "promise", what: "a Promise" };
  const tag = objectTag(object);
  if (tag === "[object Response]")
    return { kind: "response", what: "a Response" };
  // An Error has its own toString (`Name: message`), but a returned one is
  // a caught failure, not markup: printing it would show the visitor an
  // internal message, so it is refused whatever its toString says.
  if (tag === "[object Error]" || object instanceof Error)
    return { kind: "error", what: `an Error (${errorName(object)})` };
  let printed: string;
  try {
    printed = String(object);
  } catch (error) {
    // No usable toString or valueOf (a null-prototype object, a JSON field
    // named toString). Any other throw is the author's own code: it passes
    // through and fails the script like any throw from it.
    if (!(error instanceof TypeError)) throw error;
    return {
      kind: "object",
      what: "an object that cannot be converted to text",
    };
  }
  if (OBJECT_TAG.test(printed))
    return { kind: "object", what: `an object (${printed})` };
  return printed;
};

/**
 * Classify a server or stream script's return value: the text it prints,
 * or what is wrong with it. Never throws for a value Bascik refuses; an
 * error thrown by the author's own `toString` passes through.
 */
export const serverScriptOutput = (value: unknown): ServerScriptOutput => {
  if (!Array.isArray(value)) {
    const result = valueText(value);
    return typeof result === "string"
      ? { text: result }
      : { error: { kind: result.kind, received: result.what, inArray: false } };
  }
  let out = "";
  // Iterative walk: a self-containing or very deep array must not overflow
  // the stack before the depth limit is reached.
  const stack: Array<{ items: readonly unknown[]; next: number }> = [
    { items: value, next: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.next >= frame.items.length) {
      stack.pop();
      continue;
    }
    const index = frame.next++;
    const item = frame.items[index];
    if (Array.isArray(item)) {
      if (stack.length >= MAX_RETURN_ARRAY_DEPTH) {
        return {
          error: {
            kind: "array-depth",
            received: `an array nested more than ${MAX_RETURN_ARRAY_DEPTH} levels deep, or one that contains itself`,
            inArray: true,
          },
        };
      }
      stack.push({ items: item, next: 0 });
      continue;
    }
    const result = valueText(item);
    if (typeof result === "string") {
      out += result;
      continue;
    }
    const at = stack.map((f) => `[${f.next - 1}]`).join("");
    return {
      error: {
        kind: result.kind,
        received: `an array holding ${result.what} at ${at}`,
        inArray: true,
      },
    };
  }
  return { text: out };
};

const FIXES: Record<ServerScriptOutputErrorKind, (inArray: boolean) => string> =
  {
    promise: (inArray) =>
      inArray
        ? "An async callback in .map returns Promises: return await Promise.all(items.map(...)) instead."
        : "Add await where the value is made (the default export may be async).",
    error: () =>
      "To fail the script, throw it instead of returning it (scripts.onServerScriptError decides what the page shows); to show a message, return markup that says it.",
    response: () =>
      "A script on a page prints markup into it; a Response belongs in an API route (src/api/). Return the markup (a string or html`...`) instead.",
    object: () =>
      "Return markup built from its fields, for example html`<p>${item.name}</p>`.",
    function: () => "Call it and return what it returns.",
    symbol: () => "Return a string instead.",
    "array-depth": () => "Flatten the data in code before you return it.",
  };

/**
 * The located message for a refused return, in the frame every server-script
 * error uses on both hosts (`server script error at "<pathname>"`). `owner`
 * names the script (`server script in src/pages/x.html:12`); each host
 * builds it from what it knows. The production form says what the visitor
 * got (an empty slot) and that the warning is not repeated.
 */
export const serverScriptOutputErrorMessage = (
  error: ServerScriptOutputError,
  requestUrl: string,
  owner: string | undefined,
  options: { production?: boolean } = {},
): string => {
  const who = owner ? `The ${owner}` : "The script";
  return (
    `[bascik] server script error at "${new URL(requestUrl).pathname}":\n` +
    `${who} returned ${error.received}, which is not markup. ` +
    "A server or stream script returns a string, an html`...` value, or an array of them (joined with no separator). " +
    FIXES[error.kind](error.inArray) +
    (options.production
      ? "\nThe slot is empty. This warning is logged once per script until the server restarts."
      : "")
  );
};
