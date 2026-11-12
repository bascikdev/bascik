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
 * A script that is a generator yields its output instead of returning it.
 * Its host pulls the values (`invokeLoadedWithDeadline` with `chunks`) and
 * classifies each one here, so the same rules apply to every yielded value.
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
  | "generator"
  | "bytes"
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

/** The `toString` every typed array inherits: its numbers joined by commas. */
const TYPED_ARRAY_TO_STRING: unknown = (
  Object.getPrototypeOf(Uint8Array.prototype) as { toString: unknown }
).toString;

/**
 * Whether a view of bytes has a `toString` of its own that gives text. A
 * Node `Buffer` does (its UTF-8 text); a typed array and a `DataView` do
 * not. Read from the value, not from a `Buffer` global, so this module
 * stays free of Node names.
 */
const printsOwnText = (view: object): boolean => {
  const own = (view as { toString?: unknown }).toString;
  return (
    typeof own === "function" &&
    own !== TYPED_ARRAY_TO_STRING &&
    own !== Object.prototype.toString
  );
};

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
  // Bytes are not text: a typed array's toString is its numbers joined by
  // commas (the chunks of a fetched body, yielded as they come). A Node
  // Buffer is the exception: its toString is its UTF-8 text, so a file read
  // without an encoding has always printed, and still does.
  if (
    (ArrayBuffer.isView(object) && !printsOwnText(object)) ||
    tag === "[object ArrayBuffer]"
  )
    return { kind: "bytes", what: `bytes (${tag.slice(8, -1)})` };
  // A script that is itself a generator never reaches here: its host pulls
  // the values it yields and classifies each. This is a generator object
  // used as a value: yielded, or put in an array.
  if (tag === "[object AsyncGenerator]" || tag === "[object Generator]")
    return { kind: "generator", what: "a generator" };
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

const FIXES: Record<
  ServerScriptOutputErrorKind,
  (inArray: boolean, yielded: boolean) => string
> = {
  promise: (inArray, yielded) =>
    inArray
      ? `An async callback in .map returns Promises: ${yielded ? "yield" : "return"} await Promise.all(items.map(...)) instead.`
      : yielded
        ? "Await it before the yield: yield await value."
        : "Add await where the value is made (the default export may be async).",
  error: (_inArray, yielded) =>
    yielded
      ? "To fail the script, throw it instead of yielding it (scripts.onServerScriptError decides what the page shows); to show a message, yield markup that says it."
      : "To fail the script, throw it instead of returning it (scripts.onServerScriptError decides what the page shows); to show a message, return markup that says it.",
  response: (_inArray, yielded) =>
    `A script on a page prints markup into it; a Response belongs in an API route (src/api/). ${yielded ? "Yield" : "Return"} the markup (a string or html\`...\`) instead.`,
  object: (_inArray, yielded) =>
    `${yielded ? "Yield" : "Return"} markup built from its fields, for example html\`<p>\${item.name}</p>\`.`,
  function: (_inArray, yielded) =>
    yielded
      ? "Call it and yield what it returns."
      : "Call it and return what it returns.",
  symbol: (_inArray, yielded) =>
    `${yielded ? "Yield" : "Return"} a string instead.`,
  generator: (inArray, yielded) =>
    yielded && !inArray
      ? "Delegate to it so its values are yielded one by one: yield* rows()."
      : inArray
        ? "To print what it yields, make the default export an async function* and delegate to it: yield* rows()."
        : // Every Bascik host runs a script that is a generator, so a bare one
          // reaches here only on a host that has not asked for chunks.
          "This host does not run scripts that yield; return the markup instead. (An adapter runs them by invoking the script with chunks: true.)",
  bytes: (_inArray, yielded) =>
    yielded
      ? "Decode them to text first (new TextDecoder().decode(bytes, { stream: true })) and yield whole elements, not the slices a byte stream arrives in."
      : "Decode them to text first: new TextDecoder().decode(bytes), or read the file or the response as text.",
  "array-depth": (_inArray, yielded) =>
    `Flatten the data in code before you ${yielded ? "yield" : "return"} it.`,
};

/**
 * The located message for a refused return, in the frame every server-script
 * error uses on both hosts (`server script error at "<pathname>"`). `owner`
 * names the script (`server script in src/pages/x.html:12`); each host
 * builds it from what it knows. The production form says what the visitor
 * got (an empty slot) and that the warning is not repeated. `yielded` is
 * for a value a script that is a generator yielded: the message says so,
 * and in production that one value is skipped, not the whole slot.
 */
export const serverScriptOutputErrorMessage = (
  error: ServerScriptOutputError,
  requestUrl: string,
  owner: string | undefined,
  options: { production?: boolean; yielded?: boolean } = {},
): string => {
  const who = owner ? `The ${owner}` : "The script";
  const yielded = options.yielded === true;
  return (
    `[bascik] server script error at "${new URL(requestUrl).pathname}":\n` +
    `${who} ${yielded ? "yielded" : "returned"} ${error.received}, which is not markup. ` +
    `A server or stream script ${yielded ? "yields" : "returns"} a string, an html\`...\` value, or an array of them (joined with no separator). ` +
    FIXES[error.kind](error.inArray, yielded) +
    (options.production
      ? `\n${yielded ? "That value is skipped" : "The slot is empty"}. This warning is logged once per script until the server restarts.`
      : "")
  );
};
