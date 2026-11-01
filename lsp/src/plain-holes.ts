/**
 * Whether a template hole is provably plain data, so wrapping its template
 * in html`...` only escapes text and never markup someone meant (the
 * allowlist behind the server-script-unescaped-markup quick fix).
 *
 * A hole is plain when every value it reads comes from these sources,
 * directly or through local `const` bindings of them, string concatenation
 * or templates of them, String(), Number() and the like, and string methods
 * (toFixed, toUpperCase, trim, slice, padStart and similar) on them:
 *
 * - string, number, bigint and boolean literals with no `&` or `<` in
 *   their value (an escape such as `\x3c` or `\u0026` counts by the
 *   character it writes), and `const` objects or arrays of only those that
 *   the file reads by a literal key or index and never changes, exports or
 *   passes on;
 * - request data: the `request` parameter, `context.params` and
 *   `context.remoteIp`, in request-time code (and `const` values taken
 *   from them, and a URL or URLSearchParams made from them), while the
 *   script neither changes it (headers.set, a params write) nor hands a
 *   request object to other code;
 * - `process.env` values;
 * - `Date` and `Date.now()`-derived values, and `Math` results;
 * - parameters typed number, bigint or boolean (or a union of those) of a
 *   local function that is not exported and is only called by name, that
 *   the file never reassigns or casts with `as`, and that every call and
 *   the default value fill with a provable number;
 * - local functions that are not exported, are only called by name, and
 *   whose every return is plain itself;
 * - html values (an html`...` template, raw(), safeUrl(), json()), which
 *   html inserts as they are, while nothing turns them into text (String(),
 *   a string method, + or a template).
 *
 * Every argument of a call in the chain (a string method, a Date or
 * request method, optional calls too) must be plain itself.
 *
 * Anything else is unknown: object fields and array slots other code can
 * change, Map and Set reads, class fields, closures, catch and loop
 * bindings, globalThis, destructuring targets, imported values, `let` and
 * `var`, parameters of any other type, and parameters of exported
 * functions, callbacks and methods (a JavaScript caller can pass markup
 * whatever the type says).
 *
 * The built-ins are trusted only while the file leaves them alone: a file
 * that declares its own String, Math, Date, process and the like, writes to
 * one of them or to process.env, hands one to other code (Object.assign,
 * Object.defineProperty), writes through globalThis, or reaches a prototype
 * gets no fix for those reads (for a prototype, for any hole). Code that
 * rewrites built-ins or globals is out of scope: a file that calls eval,
 * Function, Object.defineProperty, Reflect.defineProperty, Reflect.set or
 * Object.setPrototypeOf gets no fix for any hole.
 *
 * Names are merged across scopes: a name declared anywhere in a way that
 * is not plain is unknown wherever it is read. Each name, `const` value
 * and helper is judged once, so a file's checks stay linear in its tokens.
 */
import type { Token } from "./module-specifiers.js";

/** Why a hole is not provably plain: the value it reads and why. */
export interface Unproven {
  what: string;
  why: string;
}

/** A local function as localFunctions finds it. */
export interface PlainFunction {
  name: string;
  /** The name's offset. */
  start: number;
  end: number;
  /** The body's first offset: its `{`, or an arrow's expression. */
  body: number;
  /** An arrow whose body is an expression, not a block. */
  expression: boolean;
}

export interface PlainOptions {
  /** Request-time code: `request` and `context` parameters hold request data. */
  requestTime: boolean;
  functions: readonly PlainFunction[];
  /** Template holes, as [first code offset, end offset) pairs. */
  holes: readonly (readonly [number, number])[];
  /** Whether markup is built as a string between two offsets. */
  markupWithin: (from: number, to: number) => boolean;
  /**
   * Whether an untagged template literal whose text holds `&` or `<` (see
   * holdsMarkupCharacter) starts between two offsets. A template with holes
   * leaves no token for its text, so this is how its text is seen.
   */
  markupCharacterTextWithin?: (from: number, to: number) => boolean;
  /**
   * Whether an untagged (or plain-string tagged) template literal starts
   * between two offsets: an html value in its hole turns into text.
   */
  plainTemplateWithin?: (from: number, to: number) => boolean;
  /** html tag names and html, raw, safeUrl and json as the script imports them. */
  isHtmlValue: (name: string) => boolean;
  htmlTags: readonly string[];
  /** The end offset of the template literal whose backtick is at an offset. */
  templateEndAt: (start: number) => number | undefined;
}

const LITERAL_WORDS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
]);

/** Methods that return text or a number made only from their receiver and arguments. */
const STRING_METHODS = new Set(
  "toFixed toPrecision toExponential toString toUpperCase toLowerCase toLocaleUpperCase toLocaleLowerCase toLocaleString trim trimStart trimEnd slice substring substr padStart padEnd charAt at repeat normalize replace replaceAll concat valueOf toISOString toDateString toTimeString toUTCString toLocaleDateString toLocaleTimeString".split(
    " ",
  ),
);

/** Methods that read request data without changing it. */
const REQUEST_READ_METHODS = new Set([
  ...STRING_METHODS,
  "get",
  "getAll",
  "has",
  "json",
  "text",
  "formData",
]);

/**
 * Members of request data (the request, a URL, context) that are text,
 * not objects other code could change: url, method, a URL's parts.
 */
const REQUEST_TEXT_MEMBERS = new Set(
  "url method href origin protocol username password host hostname port pathname search hash remoteIp mode credentials cache redirect referrer referrerPolicy integrity destination keepalive bodyUsed size".split(
    " ",
  ),
);

/** Calls that can rewrite any built-in or global: a file that makes one gets no wrap fix. */
const REWRITING_MEMBERS: Record<string, ReadonlySet<string>> = {
  Object: new Set(["defineProperty", "defineProperties", "setPrototypeOf"]),
  Reflect: new Set(["defineProperty", "set", "setPrototypeOf"]),
};

/** Globals whose call returns text made only from their arguments. */
const STRING_CALLS = new Set(["String", "encodeURIComponent", "encodeURI"]);

/** Globals whose call returns a number or boolean, whatever the arguments. */
const NUMBER_CALLS = new Set(["Number", "Boolean", "parseInt", "parseFloat"]);

const ASSIGN_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
]);
const OP_CHARS = new Set("=+-*/%&|^<>!?~");

const NOT_PARAMS_BEFORE = new Set(["if", "for", "while", "switch", "with"]);
const PARAM_MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "readonly",
  "override",
]);
const MEMBER_MODIFIERS = new Set([
  "async",
  "static",
  "get",
  "set",
  "public",
  "private",
  "protected",
  "override",
  "readonly",
  "abstract",
  "declare",
  "accessor",
]);
const TYPE_DECLARATIONS = new Set([
  "class",
  "enum",
  "interface",
  "type",
  "namespace",
  "module",
  "declare",
]);
const UNKNOWN_WORDS = new Set([
  "this",
  "super",
  "arguments",
  "globalThis",
  "window",
  "self",
  "function",
  "class",
  "yield",
  "import",
  "async",
  "delete",
]);

const PLAIN_PARAMETER_TYPE =
  /^\s*\|?\s*(?:number|bigint|boolean|true|false)(?:\s*\|\s*(?:number|bigint|boolean|true|false))*\s*$/;

/**
 * Whether a string or template literal's value, its escapes decoded,
 * holds `&` or `<`: html would escape it, so an entity (`&mdash;`) or a
 * tag written as `\x3cb>` would show as text after wrapping.
 */
export function holdsMarkupCharacter(raw: string): boolean {
  if (raw.includes("&") || raw.includes("<")) return true;
  if (!raw.includes("\\")) return false;
  const decoded = raw.replace(
    /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|([0-3][0-7]{0,2}|[4-7][0-7]?)|([\s\S]))/g,
    (
      _m,
      x?: string,
      braced?: string,
      u?: string,
      octal?: string,
      other?: string,
    ) => {
      if (x !== undefined) return String.fromCharCode(parseInt(x, 16));
      if (braced !== undefined) {
        const code = parseInt(braced, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      if (u !== undefined) return String.fromCharCode(parseInt(u, 16));
      if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8));
      return other === "\n" || other === "\r" ? "" : (other ?? "");
    },
  );
  return decoded.includes("&") || decoded.includes("<");
}

/** Built-ins the checker trusts by name, while the file leaves them alone. */
const TRUSTED_GLOBALS = new Set([
  "String",
  "encodeURIComponent",
  "encodeURI",
  "Number",
  "Boolean",
  "parseInt",
  "parseFloat",
  "Math",
  "Date",
  "process",
  "URL",
  "URLSearchParams",
]);
/** Names for the global object: writing through one can replace any built-in. */
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);
/** Names that reach an object's prototype. */
const PROTOTYPE_WORDS = new Set([
  "prototype",
  "__proto__",
  "setPrototypeOf",
  "getPrototypeOf",
]);

/** What a value is, for what may follow it. */
type Kind =
  | { k: "prim" }
  | { k: "date" }
  | { k: "html" }
  | { k: "request"; name?: string; escapes?: boolean }
  | { k: "table" }
  | { k: "helper" }
  | { k: "global" };

type NameVerdict = Kind | { k: "unknown"; cause: Unproven };

type Result =
  { ok: true; kind: Kind; end: number } | { ok: false; cause: Unproven };

const PRIM: Kind = { k: "prim" };
const HTML: Kind = { k: "html" };

const HTML_AS_TEXT =
  "an html value turned into text (by String(), a string method, + or a template), which html would escape";

/**
 * Whether the text between tokens of a number holds only digits, a radix or exponent, white space and
 * comments (and, with `signs`, + and -). A hand-written scan: a regular expression with comments in a
 * repeated group backtracks exponentially on a run of slashes.
 */
export function isNumberText(text: string, signs = false): boolean {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      if (end === -1) return true;
      i = end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else if (
      /[\s\d._xXoObBnaAcCdDeEfF]/.test(c) ||
      (signs && (c === "+" || c === "-"))
    ) {
      i++;
    } else {
      return false;
    }
  }
  return true;
}

const MARKUP_CHARACTER =
  "a literal with & or < in its value (written out or as an escape such as \\x3c), which html would escape, so an entity or a tag in it would show as text";

/** How many names, values and helpers deep a check follows. */
const MAX_DEPTH = 200;

/**
 * Builds the checker for one script: `(from, to)` gives undefined when the
 * code between the offsets (a hole's expression) is provably plain data,
 * or what it reads that is not.
 */
export function plainHoleChecker(
  body: string,
  tokens: readonly Token[],
  opts: PlainOptions,
): (from: number, to: number) => Unproven | undefined {
  const n = tokens.length;
  const punct = (k: number, v: string): boolean =>
    k >= 0 &&
    k < n &&
    tokens[k].type === "punctuation" &&
    tokens[k].value === v;
  const word = (k: number, v?: string): boolean =>
    k >= 0 &&
    k < n &&
    tokens[k].type === "identifier" &&
    (v === undefined || tokens[k].value === v);
  const adjacent = (k: number): boolean =>
    k > 0 && k < n && tokens[k].start === tokens[k - 1].end;

  // Brackets: partners and the innermost open bracket around each token.
  const partner = new Int32Array(n).fill(-1);
  const parentOpen = new Int32Array(n).fill(-1);
  {
    const stack: number[] = [];
    for (let k = 0; k < n; k++) {
      parentOpen[k] = stack.length > 0 ? stack[stack.length - 1] : -1;
      const t = tokens[k];
      if (t.type !== "punctuation") continue;
      if (t.value === "(" || t.value === "[" || t.value === "{") stack.push(k);
      else if (
        (t.value === ")" || t.value === "]" || t.value === "}") &&
        stack.length > 0
      ) {
        const o = stack.pop()!;
        partner[o] = k;
        partner[k] = o;
      }
    }
  }
  /** The first token index at or after an offset. */
  const tokenAt = (offset: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid].start < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** The operator that starts at token k (adjacent punctuation), as text. */
  const opAt = (k: number): string => {
    let s = "";
    for (let j = k; j < n && j < k + 4; j++) {
      const t = tokens[j];
      if (t.type !== "punctuation" || !OP_CHARS.has(t.value)) break;
      if (j > k && !adjacent(j)) break;
      s += t.value;
    }
    return s;
  };
  /** Whether an operator assigns: `=`, `+=`, `??=`, or one followed by a unary (`=-1`). */
  const isAssignOp = (op: string): boolean => {
    if (op.startsWith("++") || op.startsWith("--")) return true;
    for (let len = Math.min(4, op.length); len > 0; len--)
      if (
        ASSIGN_OPS.has(op.slice(0, len)) &&
        op[len] !== "=" &&
        op[len] !== ">"
      )
        return true;
    return false;
  };
  const isAssignAt = (k: number): boolean => isAssignOp(opAt(k));
  const isPrefixUpdate = (k: number): boolean =>
    k >= 2 &&
    adjacent(k - 1) &&
    ((punct(k - 1, "+") && punct(k - 2, "+")) ||
      (punct(k - 1, "-") && punct(k - 2, "-")));
  const isSpread = (k: number): boolean =>
    punct(k - 1, ".") && punct(k - 2, ".") && punct(k - 3, ".");

  // The first token of each template hole: a read there is a hole's value.
  const holeFirst = new Set<number>();
  for (const [from, to] of opts.holes) {
    const k = tokenAt(from);
    if (k < n && tokens[k].start < to) holeFirst.add(k);
  }

  // Import clauses bind names; export clauses and export declarations
  // hand names to other modules.
  const imported = new Uint8Array(n);
  const exported = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (word(k, "import") && !punct(k - 1, ".") && !punct(k + 1, "(")) {
      if (punct(k + 1, ".")) continue;
      let j = k + 1;
      for (; j < n && tokens[j].type !== "string" && !punct(j, ";"); j++)
        imported[j] = 1;
      k = j;
      continue;
    }
    if (!word(k, "export") || punct(k - 1, ".")) continue;
    if (punct(k + 1, "{") && partner[k + 1] !== -1) {
      for (let j = k + 2; j < partner[k + 1]; j++) exported[j] = 1;
      continue;
    }
    let j = k + 1;
    if (word(j, "default")) {
      j++;
      if (word(j) && !punct(j + 1, "(") && !punct(j + 1, ".")) exported[j] = 1;
    }
    if (word(j, "async")) j++;
    if (word(j, "function") || word(j, "class")) j++;
    else if (word(j, "const") || word(j, "let") || word(j, "var")) j++;
    if (punct(j, "*")) j++;
    if (word(j)) exported[j] = 1;
  }

  // Parameter lists: each bound name, whether its type makes it plain,
  // and whether it holds request data.
  const params = new Map<
    number,
    {
      plain: boolean;
      request: boolean;
      catch: boolean;
      /** The local function whose parameter list this is, if any. */
      owner?: PlainFunction;
      /** The parameter's position in its list. */
      index: number;
      /** Its default value, as a token range. */
      defaultRange?: readonly [number, number];
    }
  >();
  // A parameter list's owner: the outermost local function whose name
  // comes before the list and whose body after it. Outermost, because a
  // binding's type annotation (`const f: (s: number) => string = ...`)
  // reads like a function of its own. Lists are met in source order, so
  // one sweep with a stack of the functions still open finds each owner.
  const byStart = [...opts.functions].sort((x, y) => x.start - y.start);
  const open: PlainFunction[] = [];
  let nextFn = 0;
  const ownerOf = (offset: number): PlainFunction | undefined => {
    while (nextFn < byStart.length && byStart[nextFn].start <= offset) {
      const f = byStart[nextFn++];
      while (open.length > 0 && open[open.length - 1].body <= f.start)
        open.pop();
      open.push(f);
    }
    while (open.length > 0 && open[open.length - 1].body <= offset) open.pop();
    return open.length > 0 && open[0].body > offset ? open[0] : undefined;
  };
  /** For `)` at `c`: whether a function body or arrow follows (past a return type). */
  const bodyFollows = (c: number): boolean => {
    if (punct(c + 1, "=") && punct(c + 2, ">")) return true;
    if (punct(c + 1, "{")) return true;
    if (!punct(c + 1, ":")) return false;
    for (let j = c + 2; j < n && j <= c + 32; j++) {
      if (punct(j, "=") && punct(j + 1, ">")) return true;
      if (punct(j, "{")) {
        // `): { a: string } {` is a type; `): Foo {` a body.
        const close = partner[j];
        if (close !== -1 && (punct(close + 1, "{") || punct(close + 1, "=")))
          return true;
        return !word(j - 1, "return");
      }
      if (punct(j, "(") || punct(j, "[") || punct(j, "<")) {
        if (partner[j] !== -1) j = partner[j];
        continue;
      }
      if (punct(j, ";") || punct(j, ",") || punct(j, ")") || punct(j, "}"))
        return false;
    }
    return false;
  };
  const addParams = (p: number, isCatch: boolean): void => {
    const c = partner[p];
    const owner = isCatch ? undefined : ownerOf(tokens[p].start);
    let names: number[] = [];
    let pattern = false;
    let rest = false;
    let part = 0;
    let typeFrom = -1;
    let typeTo = -1;
    let index = 0;
    let defaultFrom = -1;
    const finish = (endToken: number): void => {
      const type =
        typeFrom !== -1 ? body.slice(typeFrom, typeTo) : (undefined as unknown);
      const plain =
        !pattern &&
        !rest &&
        typeof type === "string" &&
        PLAIN_PARAMETER_TYPE.test(type);
      for (const k of names) {
        const name = tokens[k].value;
        params.set(k, {
          plain,
          request:
            opts.requestTime &&
            !pattern &&
            !rest &&
            !isCatch &&
            (name === "request" || name === "context"),
          catch: isCatch,
          owner,
          index,
          defaultRange:
            defaultFrom !== -1 ? [defaultFrom, endToken] : undefined,
        });
      }
      names = [];
      pattern = rest = false;
      part = 0;
      typeFrom = typeTo = -1;
      defaultFrom = -1;
      index++;
    };
    for (let j = p + 1; j < c; j++) {
      const t = tokens[j];
      if (t.type === "punctuation") {
        if (t.value === ",") {
          finish(j);
          continue;
        }
        if (part === 0 && t.value === "." && isSpread(j + 1)) {
          rest = true;
          continue;
        }
        if (part === 0 && t.value === ":") {
          part = 1;
          continue;
        }
        if (part !== 2 && t.value === "=" && !punct(j + 1, ">")) {
          part = 2;
          defaultFrom = j + 1;
          continue;
        }
        if (t.value === "(" || t.value === "[" || t.value === "{") {
          const end = partner[j] === -1 ? c : partner[j];
          if (part === 0 && t.value !== "(") {
            pattern = true;
            for (let q = j + 1; q < end; q++)
              if (
                tokens[q].type === "identifier" &&
                !punct(q + 1, ":") &&
                !punct(q - 1, ".")
              )
                names.push(q);
          }
          if (part === 1) {
            if (typeFrom === -1) typeFrom = t.start;
            typeTo = tokens[end].end;
          }
          j = end;
          continue;
        }
        if (part === 1 && t.value !== "?") {
          if (typeFrom === -1) typeFrom = t.start;
          typeTo = t.end;
        }
        continue;
      }
      if (part === 0 && t.type === "identifier") {
        if (t.value === "this") {
          part = 1;
          continue;
        }
        if (PARAM_MODIFIERS.has(t.value) && word(j + 1)) continue;
        names.push(j);
      } else if (part === 1) {
        if (typeFrom === -1) typeFrom = t.start;
        typeTo = t.end;
      }
    }
    finish(c);
  };
  for (let k = 0; k < n; k++) {
    if (punct(k, "(") && partner[k] !== -1) {
      const before = k > 0 ? tokens[k - 1] : undefined;
      const isCatch = word(k - 1, "catch");
      if (
        isCatch ||
        word(k - 1, "function") ||
        (bodyFollows(partner[k]) &&
          !(
            before?.type === "identifier" && NOT_PARAMS_BEFORE.has(before.value)
          ))
      )
        addParams(k, isCatch);
    } else if (
      word(k) &&
      punct(k + 1, "=") &&
      punct(k + 2, ">") &&
      adjacent(k + 2) &&
      !punct(k - 1, ".")
    )
      params.set(k, { plain: false, request: false, catch: false, index: 0 });
  }

  // The outermost bracket of a chain of nested `{` and `[`: a pattern root.
  const patternRoot = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    if (!punct(k, "{") && !punct(k, "[")) continue;
    const p = parentOpen[k];
    patternRoot[k] =
      p !== -1 && (punct(p, "{") || punct(p, "[")) ? patternRoot[p] : k;
  }
  /** `[` after a value is an index, not an array or a pattern. */
  const isIndex = (o: number): boolean =>
    punct(o, "[") &&
    o > 0 &&
    (tokens[o - 1].type === "identifier"
      ? !/^(?:return|typeof|void|in|of|case|await|yield|const|let|var|new|delete|instanceof)$/.test(
          tokens[o - 1].value,
        )
      : tokens[o - 1].type === "string" ||
        punct(o - 1, ")") ||
        punct(o - 1, "]"));

  // Each reference to a name, by name. Property names, object keys and
  // method names are not references.
  const occurrences = new Map<string, number[]>();
  for (let k = 0; k < n; k++) {
    if (tokens[k].type !== "identifier") continue;
    if (punct(k - 1, ".") && !isSpread(k)) continue;
    const prev = k > 0 ? tokens[k - 1] : undefined;
    const afterOpenOrComma =
      punct(k - 1, "{") ||
      punct(k - 1, ",") ||
      punct(k - 1, ";") ||
      punct(k - 1, "}") ||
      (prev?.type === "identifier" && MEMBER_MODIFIERS.has(prev.value));
    const insideBraces = parentOpen[k] !== -1 && punct(parentOpen[k], "{");
    // { key: value } and { key?: type }.
    if (
      insideBraces &&
      (punct(k - 1, "{") || punct(k - 1, ",")) &&
      (punct(k + 1, ":") || (punct(k + 1, "?") && punct(k + 2, ":")))
    )
      continue;
    // A method: name(...) { or name(...): type {.
    if (
      afterOpenOrComma &&
      insideBraces &&
      punct(k + 1, "(") &&
      partner[k + 1] !== -1 &&
      bodyFollows(partner[k + 1]) &&
      !(punct(partner[k + 1] + 1, "=") && punct(partner[k + 1] + 2, ">"))
    )
      continue;
    const name = tokens[k].value;
    let list = occurrences.get(name);
    if (!list) occurrences.set(name, (list = []));
    list.push(k);
  }

  /** A function by its name's offset. */
  const functionAt = new Map(opts.functions.map((f) => [f.start, f]));
  // Each `return`'s innermost local function.
  const returnsOf = new Map<PlainFunction, number[]>();
  {
    const sorted = [...opts.functions].sort(
      (a, b) => a.start - b.start || b.end - a.end,
    );
    const stack: PlainFunction[] = [];
    let f = 0;
    for (let k = 0; k < n; k++) {
      const at = tokens[k].start;
      while (f < sorted.length && sorted[f].start <= at) {
        while (
          stack.length > 0 &&
          stack[stack.length - 1].end <= sorted[f].start
        )
          stack.pop();
        stack.push(sorted[f++]);
      }
      while (stack.length > 0 && stack[stack.length - 1].end <= at) stack.pop();
      if (word(k, "return") && stack.length > 0) {
        const owner = stack[stack.length - 1];
        if (at < owner.body) continue;
        const list = returnsOf.get(owner) ?? [];
        list.push(k);
        returnsOf.set(owner, list);
      }
    }
  }

  /**
   * Where an expression that starts at token `k` ends (exclusive): a `;`
   * or `,` at its depth, a bracket that closes around it, or a line break
   * that ends the statement.
   */
  const CONTINUES_LINE = /[-+*/%&|^<>=?:.,!~([{]$/;
  const CONTINUES_NEXT = /^[-+*/%&|^<>=?:.([`]/;
  const expressionEnd = (k: number, stopAtComma: boolean): number => {
    let j = k;
    for (; j < n; j++) {
      const t = tokens[j];
      if (t.type === "punctuation") {
        if (t.value === ";" || (stopAtComma && t.value === ",")) return j;
        if (t.value === ")" || t.value === "]" || t.value === "}") return j;
        if (
          (t.value === "(" || t.value === "[" || t.value === "{") &&
          partner[j] !== -1
        ) {
          j = partner[j];
          continue;
        }
      }
      if (j + 1 < n) {
        const gap = body.slice(tokens[j].end, tokens[j + 1].start);
        const nl = gap.indexOf("\n");
        if (nl !== -1) {
          const line = (tokens[j].value + gap.slice(0, nl))
            .replace(/\/\/.*$/, "")
            .trimEnd();
          const nextLine = gap.slice(nl).replace(/^\s+/, "");
          const next = nextLine === "" ? tokens[j + 1].value : nextLine;
          const lastIsOp =
            tokens[j].type === "punctuation" &&
            line === tokens[j].value &&
            CONTINUES_LINE.test(line);
          const lineEndsInOp =
            line.length > tokens[j].value.length && CONTINUES_LINE.test(line);
          if (!lastIsOp && !lineEndsInOp && !CONTINUES_NEXT.test(next))
            return j + 1;
        }
      }
    }
    return j;
  };

  const nameMemo = new Map<string, NameVerdict | "pending">();
  /** The hole being checked, so a range inside it never reaches the template around it. */
  let holeLo = -1;
  let holeHi = -1;
  let depth = 0;
  const helperMemo = new Map<PlainFunction, Unproven | undefined | "pending">();
  /** Local functions that may return an html value. */
  const helperHtml = new Set<PlainFunction>();

  const unknown = (what: string, why: string): Result => ({
    ok: false,
    cause: { what, why },
  });

  /** The tokens after the value at k that form its member chain: [end, assigned, calls]. */
  const chainAfter = (
    k: number,
  ): { end: number; members: number; assigned: boolean; methods: string[] } => {
    let j = k + 1;
    let members = 0;
    const methods: string[] = [];
    for (;;) {
      if (punct(j, "!") && !punct(j + 1, "=")) {
        j++;
        continue;
      }
      if (punct(j, "?") && punct(j + 1, ".") && adjacent(j + 1)) j++;
      if (punct(j, ".") && word(j + 1)) {
        members++;
        if (punct(j + 2, "(")) methods.push(tokens[j + 1].value);
        j += 2;
        continue;
      }
      if (punct(j, "[") && partner[j] !== -1) {
        members++;
        j = partner[j] + 1;
        continue;
      }
      if (punct(j, "(") && partner[j] !== -1) {
        j = partner[j] + 1;
        continue;
      }
      break;
    }
    return { end: j, members, assigned: isAssignAt(j), methods };
  };

  /** Whether the `(` at o opens a call's arguments. */
  const isCallParen = (o: number): boolean =>
    punct(o, "(") &&
    o > 0 &&
    (tokens[o - 1].type === "identifier"
      ? !/^(?:if|while|switch|for|return|typeof|await|case|in|of|void|delete|catch|with|yield)$/.test(
          tokens[o - 1].value,
        )
      : punct(o - 1, ")") || punct(o - 1, "]"));
  /** Whether a bare read at k hands the value on: an argument, an alias, a return, an element. */
  const handsOn = (k: number): boolean => {
    if (holeFirst.has(k)) return false;
    if (isSpread(k)) return true;
    if (word(k - 1, "return") || word(k - 1, "yield") || word(k - 1, "export"))
      return true;
    if (punct(k - 1, "=")) {
      const op = opAt(k - 1);
      if (
        op === "=" &&
        !(k >= 2 && adjacent(k - 1) && OP_CHARS.has(tokens[k - 2].value))
      )
        return true;
    }
    if (punct(k - 1, ">") && punct(k - 2, "=") && adjacent(k - 1)) return true;
    if (punct(k - 1, "(")) return isCallParen(k - 1);
    if (punct(k - 1, "[")) return !isIndex(k - 1);
    if (punct(k - 1, "{")) return true;
    if (punct(k - 1, ",")) {
      const p = parentOpen[k];
      if (p === -1) return false;
      if (punct(p, "(")) return isCallParen(p);
      if (punct(p, "[")) return !isIndex(p);
      return true;
    }
    if (punct(k - 1, ":")) {
      const p = parentOpen[k];
      return p !== -1 && punct(p, "{");
    }
    return false;
  };

  // Built-ins the file changes: a write to one or one of its members, or
  // the object handed to other code (Object.assign, defineProperty). A
  // write through the global object can replace any of them, and a
  // prototype reached anywhere can change what any method returns.
  const patched = new Set<string>();
  let everyGlobalPatched = false;
  let prototypeReach: Unproven | undefined;
  {
    /** The member chain after the name at k: whether it calls, and whether it names prototype. */
    const chainShape = (k: number): { call: boolean; prototype: boolean } => {
      let call = false;
      let prototype = false;
      for (let j = k + 1; j < n;) {
        if (punct(j, "?") && punct(j + 1, ".")) j++;
        if (punct(j, ".") && word(j + 1)) {
          if (PROTOTYPE_WORDS.has(tokens[j + 1].value)) prototype = true;
          j += 2;
        } else if (punct(j, "[") && partner[j] !== -1) {
          if (
            partner[j] === j + 2 &&
            (tokens[j + 1].type === "string" ||
              tokens[j + 1].type === "template") &&
            PROTOTYPE_WORDS.has(tokens[j + 1].value)
          )
            prototype = true;
          j = partner[j] + 1;
        } else if (punct(j, "(") && partner[j] !== -1) {
          call = true;
          j = partner[j] + 1;
        } else break;
      }
      return { call, prototype };
    };
    const declaresName = (list: readonly number[]): boolean =>
      list.some((k) => {
        const prev = k > 0 ? tokens[k - 1] : undefined;
        return (
          params.has(k) ||
          imported[k] === 1 ||
          (prev?.type === "identifier" &&
            /^(?:const|let|var|function|class)$/.test(prev.value))
        );
      });
    for (const [name, list] of occurrences) {
      const trusted = TRUSTED_GLOBALS.has(name);
      const globalObject = GLOBAL_OBJECTS.has(name);
      if (!trusted && !globalObject) continue;
      if (declaresName(list)) continue;
      for (const k of list) {
        const chain = chainAfter(k);
        const shape = chainShape(k);
        const handed = !shape.call && handsOn(k);
        if (shape.prototype && (chain.assigned || handed))
          prototypeReach ??= {
            what: body.slice(tokens[k].start, tokens[chain.end - 1].end),
            why: "a prototype this file changes, which can change what any method returns",
          };
        if (globalObject) {
          // Only a direct method call (globalThis.fetch(...)) leaves it alone.
          if (!(chain.members === 1 && shape.call && !chain.assigned))
            everyGlobalPatched = true;
          continue;
        }
        if (
          chain.assigned ||
          isPrefixUpdate(k) ||
          (handed &&
            (chain.members === 0 ||
              (name === "process" &&
                chain.members === 1 &&
                word(k + 2, "env"))))
        )
          patched.add(name);
      }
    }
    // A prototype reached any other way: "".__proto__, setPrototypeOf, or
    // X.prototype on any object that is not only read through a method.
    if (prototypeReach === undefined)
      for (let k = 0; k < n; k++) {
        const t = tokens[k];
        if (!PROTOTYPE_WORDS.has(t.value)) continue;
        const keyed = t.type === "string" || t.type === "template";
        if (keyed && !(punct(k - 1, "[") && punct(k + 1, "]"))) continue;
        if (t.type !== "identifier" && !keyed) continue;
        const chain = chainAfter(keyed ? k + 1 : k);
        if (
          t.value === "prototype" &&
          t.type === "identifier" &&
          !chain.assigned &&
          chain.methods.length > 0
        )
          continue;
        prototypeReach = {
          what: t.value,
          why: "a prototype this file reaches, which can change what any method returns",
        };
        break;
      }
  }
  // Out of scope by design: code that rewrites built-ins or globals.
  // Rather than follow eval, Function, defineProperty, Reflect.set or
  // setPrototypeOf, a file that calls one gets no fix for any hole.
  let rewrites: Unproven | undefined;
  for (let k = 0; k < n && rewrites === undefined; k++) {
    const t = tokens[k];
    if (t.type !== "identifier" || punct(k - 1, ".")) continue;
    let what: string | undefined;
    if (t.value === "eval" && punct(k + 1, "(")) what = "eval()";
    else if (
      t.value === "Function" &&
      (punct(k + 1, "(") || word(k - 1, "new"))
    )
      what = word(k - 1, "new") ? "new Function()" : "Function()";
    else if (
      REWRITING_MEMBERS[t.value] !== undefined &&
      punct(k + 1, ".") &&
      word(k + 2) &&
      REWRITING_MEMBERS[t.value].has(tokens[k + 2].value)
    )
      what = `${t.value}.${tokens[k + 2].value}()`;
    if (what !== undefined)
      rewrites = {
        what,
        why: "code that can rewrite built-ins or globals, so no hole in this file is proven plain",
      };
  }

  /** Why a trusted built-in is not trusted in this file, if it is not. */
  const builtinChanged = (name: string): Unproven | undefined =>
    everyGlobalPatched
      ? {
          what: name,
          why: "a built-in, and this file writes through the global object, which can replace it",
        }
      : patched.has(name)
        ? { what: name, why: "a built-in this file changes" }
        : undefined;

  // Request data the script changes or hands to other code: a header it
  // sets, appends or deletes, params or searchParams it writes, or the
  // request, its headers, params or a URL made from it passed to a
  // function. Other code may write markup into it, so no value read from
  // request data keeps the fix.
  let requestTaint: Unproven | undefined;
  if (opts.requestTime) {
    /** Names that hold a request object, and whether its members are text (params). */
    const roots = new Map<string, boolean>();
    for (const [k, p] of params)
      if (p.request) roots.set(tokens[k].value, false);
    /** The member chain after a request object at k: where it ends, whether on an object, and whether it changes one. */
    const walk = (
      k: number,
      textMembers: boolean,
    ): { end: number; object: boolean; text: boolean; changes: boolean } => {
      let object = true;
      let text = textMembers;
      let changes = false;
      let j = k + 1;
      for (;;) {
        if (punct(j, "!") && !punct(j + 1, "=")) {
          j++;
          continue;
        }
        if (punct(j, "?") && punct(j + 1, ".")) {
          j++;
          if (punct(j + 1, "(") || punct(j + 1, "[")) j++;
        }
        if (punct(j, ".") && word(j + 1)) {
          const member = tokens[j + 1].value;
          const callAt = punct(j + 2, "(")
            ? j + 2
            : punct(j + 2, "?") && punct(j + 3, ".") && punct(j + 4, "(")
              ? j + 4
              : -1;
          if (callAt !== -1 && partner[callAt] !== -1) {
            if (object && !REQUEST_READ_METHODS.has(member)) changes = true;
            object = false;
            j = partner[callAt] + 1;
            continue;
          }
          if (object) {
            if (text || REQUEST_TEXT_MEMBERS.has(member)) object = false;
            else if (member === "params") text = true;
          }
          j += 2;
          continue;
        }
        if (punct(j, "[") && partner[j] !== -1) {
          object = false;
          j = partner[j] + 1;
          continue;
        }
        if (punct(j, "(") && partner[j] !== -1) {
          if (object) changes = true;
          object = false;
          j = partner[j] + 1;
          continue;
        }
        break;
      }
      return { end: j, object, text, changes };
    };
    // Aliases, in source order: const h = request.headers, const u = new
    // URL(...), const { headers } = request.
    for (let k = 0; k < n; k++) {
      if (!word(k, "const")) continue;
      if (word(k + 1) && punct(k + 2, "=") && !punct(k + 3, "=")) {
        const v = k + 3;
        // The value starts right after `=` (not inside a template).
        if (v >= n || body.slice(tokens[k + 2].end, tokens[v].start).trim())
          continue;
        let w: ReturnType<typeof walk> | undefined;
        if (
          word(v, "new") &&
          (word(v + 1, "URL") || word(v + 1, "URLSearchParams")) &&
          punct(v + 2, "(") &&
          partner[v + 2] !== -1
        )
          w = walk(partner[v + 2], false);
        else if (word(v) && roots.has(tokens[v].value))
          w = walk(v, roots.get(tokens[v].value)!);
        if (w?.object && expressionEnd(v, true) === w.end)
          roots.set(tokens[k + 1].value, w.text);
        continue;
      }
      const close = punct(k + 1, "{") ? partner[k + 1] : -1;
      if (close === -1 || !punct(close + 1, "=") || !word(close + 2)) continue;
      const from = roots.get(tokens[close + 2].value);
      if (from === undefined) continue;
      const w = walk(close + 2, from);
      if (!w.object || w.text) continue;
      for (let j = k + 2; j < close; j++) {
        if (punct(j, "{") || punct(j, "[")) {
          requestTaint ??= {
            what: body.slice(tokens[k].start, tokens[close].end).slice(0, 60),
            why: "request data destructured in a way Bascik does not follow",
          };
          break;
        }
        if (!word(j) || !(punct(j - 1, "{") || punct(j - 1, ","))) continue;
        const key = tokens[j].value;
        const local = punct(j + 1, ":") && word(j + 2) ? j + 2 : j;
        if (!REQUEST_TEXT_MEMBERS.has(key))
          roots.set(tokens[local].value, key === "params");
        j = local;
      }
    }
    for (const [name, text] of roots) {
      if (requestTaint !== undefined) break;
      for (const k of occurrences.get(name) ?? []) {
        if (params.has(k)) continue;
        if (
          word(k - 1, "const") ||
          word(k - 1, "let") ||
          word(k - 1, "var") ||
          word(k - 1, "function")
        )
          continue;
        const open = parentOpen[k];
        if (
          open !== -1 &&
          (punct(open, "{") || punct(open, "[")) &&
          !isIndex(open)
        ) {
          const root = patternRoot[open];
          if (
            word(root - 1, "const") ||
            word(root - 1, "let") ||
            word(root - 1, "var")
          )
            continue;
        }
        const w = walk(k, text);
        const shown = (why: string): Unproven => ({
          what: body
            .slice(tokens[k].start, tokens[Math.max(k, w.end - 1)].end)
            .slice(0, 60),
          why,
        });
        if (w.changes) {
          requestTaint = shown(
            "request data this script changes, so a value read from it may be markup the script wrote",
          );
          break;
        }
        if (isAssignAt(w.end) || isPrefixUpdate(k) || word(k - 1, "delete")) {
          requestTaint = shown(
            "request data this script writes to, so a value read from it may be markup the script wrote",
          );
          break;
        }
        if (!w.object) continue;
        const alias =
          punct(k - 1, "=") &&
          word(k - 2) &&
          word(k - 3, "const") &&
          expressionEnd(k, true) === w.end;
        const handed =
          handsOn(k) ||
          (!holeFirst.has(k) &&
            (punct(k - 1, "?") ||
              punct(k - 1, ":") ||
              punct(k - 1, "|") ||
              punct(k - 1, "&")));
        if (!alias && handed) {
          requestTaint = shown(
            "request data this script hands to other code, which may change it",
          );
          break;
        }
      }
    }
  }

  /** The value of a `const NAME =` or `const NAME: Type =` declaration at k: token range. */
  const constValue = (k: number): [number, number] | undefined => {
    let eq = -1;
    if (punct(k + 1, "=") && !punct(k + 2, "=") && !punct(k + 2, ">"))
      eq = k + 1;
    else if (punct(k + 1, ":")) {
      let angle = 0;
      for (let j = k + 2; j < n && j <= k + 200; j++) {
        if (tokens[j].type !== "punctuation") continue;
        const v = tokens[j].value;
        if ((v === "(" || v === "[" || v === "{") && partner[j] !== -1)
          j = partner[j];
        else if (v === "<") angle++;
        else if (v === ">") angle = Math.max(0, angle - 1);
        else if (v === "=") {
          if (punct(j + 1, ">")) j++;
          else if (punct(j + 1, "=")) return undefined;
          else if (angle === 0) {
            eq = j;
            break;
          }
        } else if (v === ";" || v === ")" || v === "]" || v === "}")
          return undefined;
      }
    }
    if (eq === -1) return undefined;
    return [eq + 1, expressionEnd(eq + 1, true)];
  };

  /** Whether tokens [a, b) are an object or array literal of only literals. */
  const isTable = (a: number, b: number): boolean => {
    if (!(punct(a, "{") || punct(a, "[")) || partner[a] === -1) return false;
    const close = partner[a];
    if (
      close !== b - 1 &&
      !(close === b - 3 && word(b - 2, "as") && word(b - 1, "const"))
    )
      return false;
    const object = punct(a, "{");
    for (let j = a + 1; j < close; j++) {
      const t = tokens[j];
      if (t.type === "punctuation") {
        if (t.value === "," || t.value === ":" || t.value === "-") continue;
        return false;
      }
      if (t.type === "string") {
        if (holdsMarkupCharacter(t.value)) return false;
        if (
          object &&
          !punct(j + 1, ":") &&
          !punct(j + 1, ",") &&
          j + 1 !== close
        )
          return false;
        continue;
      }
      if (t.type === "identifier") {
        if (LITERAL_WORDS.has(t.value) && !punct(j + 1, ":")) continue;
        if (object && punct(j + 1, ":")) continue;
        return false;
      }
      return false;
    }
    // Numbers, comments and white space only between the tokens.
    for (let j = a; j < close; j++) {
      let gap = body.slice(tokens[j].end, tokens[j + 1].start);
      if (tokens[j].type === "string") gap = gap.slice(1);
      if (tokens[j + 1].type === "string") gap = gap.slice(0, -1);
      if (!isNumberText(gap, true)) return false;
    }
    return true;
  };

  /** Calls `each(from, to)` for each top-level comma-separated piece of tokens [a, b); false stops. */
  const eachArgument = (
    a: number,
    b: number,
    each: (from: number, to: number) => boolean,
  ): boolean => {
    let start = a;
    for (let j = a; j <= b; j++) {
      if (j < b && !punct(j, ",")) {
        if (
          (punct(j, "(") || punct(j, "[") || punct(j, "{")) &&
          partner[j] !== -1 &&
          partner[j] < b
        )
          j = partner[j];
        continue;
      }
      if (!each(start, j)) return false;
      start = j + 1;
    }
    return true;
  };

  /**
   * Evaluates call arguments, tokens [a, b): each must be plain (an
   * options object of literals counts), and none an html value, which a
   * call turns into text.
   */
  const evalArgs = (a: number, b: number): Result => {
    let failed: Result | undefined;
    eachArgument(a, b, (from, to) => {
      if (from >= to || isTable(from, to)) return true;
      const r = evalRange(from, to);
      if (!r.ok) failed = r;
      else if (r.kind.k === "html")
        failed = unknown(
          body.slice(tokens[from].start, tokens[to - 1].end).slice(0, 40),
          HTML_AS_TEXT,
        );
      return failed === undefined;
    });
    return failed ?? { ok: true, kind: PRIM, end: b };
  };

  /** Each const table's keys whose value is a number literal. */
  const tableNumbers = new Map<string, Map<string, boolean> | null>();
  const tableNumber = (name: string, key: string): boolean => {
    let map = tableNumbers.get(name);
    if (map === undefined) {
      map = null;
      const decls = (occurrences.get(name) ?? []).filter((k) =>
        word(k - 1, "const"),
      );
      const range = decls.length === 1 ? constValue(decls[0]) : undefined;
      if (
        nameVerdict(name).k === "table" &&
        range !== undefined &&
        punct(range[0], "{")
      ) {
        map = new Map();
        const close = partner[range[0]];
        for (let j = range[0] + 1; j < close; j++) {
          if (
            tokens[j].type === "punctuation" ||
            !punct(j + 1, ":") ||
            !(punct(j - 1, "{") || punct(j - 1, ","))
          )
            continue;
          const next = j + 2;
          const text = body.slice(tokens[j + 1].end, tokens[next].start);
          const isNumber =
            (punct(next, ",") || next === close) &&
            isNumberText(text) &&
            /\d/.test(text);
          map.set(
            tokens[j].value,
            isNumber && map.get(tokens[j].value) !== false,
          );
        }
      }
      tableNumbers.set(name, map);
    }
    return map?.get(key) === true;
  };

  const numericMemo = new Map<string, boolean | "pending">();
  /** Whether a name holds a number: a number const, or a checked number parameter. */
  const numericName = (name: string): boolean => {
    const memo = numericMemo.get(name);
    if (memo !== undefined) return memo === true;
    numericMemo.set(name, "pending");
    let ok = nameVerdict(name).k === "prim";
    for (const k of ok ? (occurrences.get(name) ?? []) : []) {
      if (word(k - 1, "const")) {
        const range = constValue(k);
        ok =
          range !== undefined &&
          numericSpan(
            range[0],
            range[1],
            tokens[range[0] - 1].end,
            range[1] < n ? tokens[range[1]].start : body.length,
          );
      } else if (params.has(k)) ok = params.get(k)!.plain;
      else if (word(k - 1, "function")) ok = false;
      if (!ok) break;
    }
    numericMemo.set(name, ok);
    return ok;
  };

  /**
   * Whether the code between offsets from and to, tokens [a, b), is
   * provably a number: number literals, number names, Math, Number(),
   * parseInt(), parseFloat(), Boolean(), Date.now(), a const table's
   * number and a plain value's length, joined by operators.
   */
  const numericSpan = (
    a: number,
    b: number,
    from: number,
    to: number,
    self?: string,
  ): boolean => {
    let digits = false;
    let at = from;
    for (let j = a; j <= b; j++) {
      const gap = body.slice(at, j < b ? tokens[j].start : to);
      if (!isNumberText(gap)) return false;
      if (/\d/.test(gap.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")))
        digits = true;
      if (j < b) at = tokens[j].end;
    }
    if (a >= b) return digits;
    const trusted = (w: string): boolean =>
      nameVerdict(w).k === "global" && builtinChanged(w) === undefined;
    for (let j = a; j < b;) {
      const t = tokens[j];
      if (t.type === "punctuation") {
        if (!/^[-+*/%()~!<>=&|^?:]$/.test(t.value)) return false;
        j++;
        continue;
      }
      if (t.type !== "identifier" || punct(j - 1, ".")) return false;
      const w = t.value;
      if (LITERAL_WORDS.has(w)) {
        j++;
        continue;
      }
      if ((w === "Math" || w === "Number" || w === "Date") && trusted(w)) {
        let q = j + 1;
        if (punct(q, ".") && word(q + 1)) {
          if (w === "Date" && !/^(?:now|parse|UTC)$/.test(tokens[q + 1].value))
            return false;
          q += 2;
        } else if (w !== "Number") return false;
        if (punct(q, "(") && partner[q] !== -1 && partner[q] < b)
          q = partner[q] + 1;
        else if (w === "Date" || q === j + 1) return false;
        j = q;
        continue;
      }
      if (
        (w === "parseInt" || w === "parseFloat" || w === "Boolean") &&
        trusted(w) &&
        punct(j + 1, "(") &&
        partner[j + 1] !== -1 &&
        partner[j + 1] < b
      ) {
        j = partner[j + 1] + 1;
        continue;
      }
      if (punct(j + 1, ".") && word(j + 2)) {
        if (punct(j + 3, "(") || punct(j + 3, ".") || punct(j + 3, "["))
          return false;
        const member = tokens[j + 2].value;
        const verdict = nameVerdict(w);
        // A table's number, or the length of a plain value.
        if (
          !(verdict.k === "table"
            ? tableNumber(w, member)
            : member === "length" && evalRange(j, j + 1).ok)
        )
          return false;
        j += 3;
        continue;
      }
      if (punct(j + 1, "(") || punct(j + 1, "[")) return false;
      // The parameter being judged, passed on to its own position
      // (label(n) inside a function of n): a number if every other
      // call passes one.
      if (w !== self && !numericName(w)) return false;
      j++;
    }
    return true;
  };

  /** For each local function: argument positions where some call passes what may not be a number (null: a spread). */
  const callNumbers = new Map<PlainFunction, boolean[] | null | "pending">();
  /** Each local function's parameter names, by position. */
  const parameterNames = new Map<PlainFunction, string[]>();
  for (const [k, p] of params)
    if (p.owner !== undefined) {
      const list = parameterNames.get(p.owner) ?? [];
      list[p.index] = tokens[k].value;
      parameterNames.set(p.owner, list);
    }
  const callsPassNumbers = (fn: PlainFunction, index: number): boolean => {
    if (!callNumbers.has(fn)) {
      callNumbers.set(fn, "pending");
      const names = parameterNames.get(fn) ?? [];
      let bad: boolean[] | null = [];
      for (const k of occurrences.get(fn.name) ?? []) {
        if (bad === null) break;
        if (tokens[k].start === fn.start || word(k - 1, "function")) continue;
        if (!punct(k + 1, "(") || partner[k + 1] === -1) continue;
        const close = partner[k + 1];
        let position = 0;
        const flags: boolean[] = bad;
        eachArgument(k + 2, close, (from, to) => {
          if (
            punct(from, ".") &&
            punct(from + 1, ".") &&
            punct(from + 2, ".")
          ) {
            bad = null;
            return false;
          }
          const start = tokens[from - 1].end;
          const end = to < n ? tokens[to].start : body.length;
          if (!(from === to && body.slice(start, end).trim() === ""))
            if (!numericSpan(from, to, start, end, names[position]))
              flags[position] = true;
          position++;
          return true;
        });
      }
      callNumbers.set(fn, bad);
    }
    const flags = callNumbers.get(fn);
    return Array.isArray(flags) && flags[index] !== true;
  };

  /** A helper's verdict: undefined when every return is plain. */
  const helperVerdict = (fn: PlainFunction): Unproven | undefined => {
    const memo = helperMemo.get(fn);
    if (memo === "pending")
      return { what: `${fn.name}()`, why: "a function that calls itself" };
    if (memo !== undefined || helperMemo.has(fn)) return memo;
    if (depth >= MAX_DEPTH)
      return {
        what: `${fn.name}()`,
        why: "a chain of calls too long to follow",
      };
    helperMemo.set(fn, "pending");
    depth++;
    let cause: Unproven | undefined;
    if (fn.expression) {
      const a = tokenAt(fn.body);
      const b = tokenAt(fn.end);
      const r = evalRange(a, b);
      if (!r.ok) cause = r.cause;
      else if (r.kind.k === "html") helperHtml.add(fn);
    } else
      for (const k of returnsOf.get(fn) ?? []) {
        if (punct(k + 1, ";") || punct(k + 1, "}")) continue;
        const r = evalRange(k + 1, expressionEnd(k + 1, false));
        if (!r.ok) {
          cause = r.cause;
          break;
        }
        if (r.kind.k === "html") helperHtml.add(fn);
      }
    depth--;
    helperMemo.set(fn, cause);
    return cause;
  };

  /** What a name holds, judged from every declaration and use of it in the file. */
  const nameVerdict = (name: string): NameVerdict => {
    const memo = nameMemo.get(name);
    if (memo === "pending")
      return {
        k: "unknown",
        cause: { what: name, why: "a value defined in terms of itself" },
      };
    if (memo !== undefined) return memo;
    // A chain of names this long is not followed: the stack stays bounded.
    if (depth >= MAX_DEPTH)
      return {
        k: "unknown",
        cause: { what: name, why: "a chain of values too long to follow" },
      };
    nameMemo.set(name, "pending");
    depth++;
    const v = judgeName(name);
    depth--;
    nameMemo.set(name, v);
    return v;
  };
  const judgeName = (name: string): NameVerdict => {
    const occs = occurrences.get(name) ?? [];
    const kinds: Kind[] = [];
    const reads: number[] = [];
    const no = (why: string, what = name): NameVerdict => ({
      k: "unknown",
      cause: { what, why },
    });
    let fromParam = false;
    for (const k of occs) {
      const prev = k > 0 ? tokens[k - 1] : undefined;
      const prevWord = prev?.type === "identifier" ? prev.value : "";
      if (imported[k]) return no("a value imported from another module");
      if (prevWord === "let" || prevWord === "var")
        return no("a let or var, which can be reassigned");
      if (TYPE_DECLARATIONS.has(prevWord) && prevWord !== "declare")
        return no("a class or one of its fields");
      if (prevWord === "declare") return no("a declared global");
      if (prevWord === "const") {
        const range = constValue(k);
        if (range === undefined) return no("a loop variable");
        const [a, b] = range;
        const fn = functionAt.get(tokens[k].start);
        if (fn !== undefined && (word(a) || punct(a, "("))) {
          if (exported[k]) return no("an exported function", `${name}()`);
          kinds.push({ k: "helper" });
          continue;
        }
        if (isTable(a, b)) {
          if (exported[k])
            return no("an exported object, which other modules can change");
          kinds.push({ k: "table" });
          continue;
        }
        const r = evalRange(a, b);
        if (!r.ok) return { k: "unknown", cause: r.cause };
        kinds.push(r.kind);
        continue;
      }
      if (prevWord === "function") {
        const fn = functionAt.get(tokens[k].start);
        if (fn === undefined)
          return no("a function Bascik cannot follow", `${name}()`);
        if (exported[k]) return no("an exported function", `${name}()`);
        kinds.push({ k: "helper" });
        continue;
      }
      const param = params.get(k);
      if (param !== undefined) {
        if (param.catch) return no("a catch binding");
        if (param.request) {
          kinds.push({ k: "request", name });
          continue;
        }
        if (!param.plain)
          return no("a parameter not typed number, bigint or boolean");
        if (
          param.owner === undefined ||
          param.owner.name === name ||
          nameVerdict(param.owner.name).k !== "helper"
        )
          return no(
            "a parameter of a function whose callers this file cannot all see (exported, a callback, a method, or passed on), and a JavaScript caller can pass markup whatever its type says",
          );
        if (param.defaultRange !== undefined) {
          const [a, b] = param.defaultRange;
          if (!numericSpan(a, b, tokens[a - 1].end, tokens[b].start))
            return no(
              "a number parameter whose default value Bascik cannot prove is a number",
            );
        }
        if (!callsPassNumbers(param.owner, param.index))
          return no(
            "a number parameter that a call fills with a value Bascik cannot prove is a number",
          );
        fromParam = true;
        kinds.push(PRIM);
        continue;
      }
      // A destructuring pattern: a declaration or an assignment target.
      const open = parentOpen[k];
      if (
        open !== -1 &&
        (punct(open, "{") || punct(open, "[")) &&
        !isIndex(open)
      ) {
        const root = patternRoot[open];
        const close = partner[root];
        const declared =
          word(root - 1, "const") ||
          word(root - 1, "let") ||
          word(root - 1, "var");
        if (
          !isIndex(root) &&
          (declared ||
            (close !== -1 &&
              punct(close + 1, "=") &&
              !punct(close + 2, "=") &&
              !punct(close + 2, ">")))
        ) {
          if (word(root - 1, "const") && punct(root, "{") && close !== -1) {
            let simple = true;
            for (let j = root + 1; j < close; j++)
              if (!(word(j) || punct(j, ","))) simple = false;
            if (simple && punct(close + 1, "=")) {
              const r = evalRange(close + 2, expressionEnd(close + 2, true));
              if (r.ok && r.kind.k === "request") {
                kinds.push({ k: "request" });
                continue;
              }
            }
          }
          return no(
            declared
              ? "a destructured name"
              : "a destructuring assignment target",
          );
        }
      }
      reads.push(k);
    }
    if (kinds.length === 0) return { k: "global" };
    if (TRUSTED_GLOBALS.has(name) || GLOBAL_OBJECTS.has(name))
      return no("a built-in name this file declares as its own");
    const first = kinds[0];
    if (!kinds.every((x) => x.k === first.k))
      return no("a name declared more than once in different ways");
    let escapes = false;
    for (const k of reads) {
      if (isAssignAt(k + 1) || isPrefixUpdate(k))
        return no("a value assigned elsewhere in the file");
      if (fromParam && word(k + 1, "as")) return no("a parameter cast with as");
      if (exported[k] && first.k !== "prim")
        return no("a value exported to other modules");
      switch (first.k) {
        case "helper":
          if (!punct(k + 1, "(") || word(k - 1, "new"))
            return no(
              "a function passed on as a value, so its callers are out of sight",
              `${name}()`,
            );
          break;
        case "table": {
          const literalKey =
            (punct(k + 1, ".") && word(k + 2) && !punct(k + 3, "(")) ||
            (punct(k + 1, "[") &&
              partner[k + 1] !== -1 &&
              (partner[k + 1] === k + 2 ||
                (partner[k + 1] === k + 3 &&
                  tokens[k + 2].type === "string")) &&
              /^\[\s*(?:\d+|"[^"]*"|'[^']*')\s*\]$/.test(
                body.slice(tokens[k + 1].start, tokens[partner[k + 1]].end),
              ));
          const after = punct(k + 1, ".") ? k + 3 : partner[k + 1] + 1;
          if (!literalKey || isAssignAt(after))
            return no("an object or array other code can change");
          break;
        }
        case "request":
        case "date": {
          const chain = chainAfter(k);
          if (chain.assigned && chain.members > 0)
            return no(
              "an object whose fields are written elsewhere in the file",
            );
          if (
            first.k === "request" &&
            first.name !== "request" &&
            chain.methods.some((m) => !REQUEST_READ_METHODS.has(m))
          )
            return no("an object changed elsewhere in the file");
          if (
            chain.members === 0 &&
            !(first.k === "request" && first.name === "request") &&
            handsOn(k)
          )
            escapes = true;
          break;
        }
      }
    }
    if (first.k === "date" && escapes)
      return no("a Date handed to other code, which may change it");
    if (first.k === "request")
      return { k: "request", name: first.name, escapes };
    return first;
  };

  /** Evaluates the value at token k (a name, a call, `new ...`) and what follows it. */
  const evalChain = (k: number, limit: number): Result => {
    const t = tokens[k];
    const name = t.value;
    let j = k + 1;
    let kind: Kind | undefined;
    const tagged = (at: number): boolean =>
      body[tokens[at - 1]?.end ?? 0] === "`";
    // An html value: html`...`, raw(), safeUrl(), json(). What follows it
    // (a member, a call) is checked below.
    let htmlEnd = -1;
    if (opts.isHtmlValue(name) || opts.htmlTags.includes(name)) {
      const end = tagged(j) ? opts.templateEndAt(t.end) : undefined;
      if (end !== undefined) {
        kind = HTML;
        j = htmlEnd = tokenAt(end);
      } else if (punct(j, "(") && partner[j] !== -1) {
        kind = HTML;
        j = htmlEnd = partner[j] + 1;
      }
    }
    if (kind !== undefined) {
      // An html value; nothing more to resolve.
    } else if (name === "new") {
      const ctor = tokens[k + 1];
      if (!word(k + 1) || !punct(k + 2, "(") || partner[k + 2] === -1)
        return unknown(
          `new ${ctor?.value ?? ""}`.trim(),
          "a constructed object",
        );
      const close = partner[k + 2];
      const changed = builtinChanged(ctor.value);
      if (changed !== undefined && TRUSTED_GLOBALS.has(ctor.value))
        return { ok: false, cause: changed };
      if (ctor.value === "Date" && nameVerdict("Date").k === "global")
        kind = { k: "date" };
      else if (
        (ctor.value === "URL" || ctor.value === "URLSearchParams") &&
        nameVerdict(ctor.value).k === "global"
      ) {
        // A URL decodes %3C and %26 into < and &: it holds request data
        // only when built from request data (a base may be a literal with
        // no % in it).
        if (requestTaint !== undefined)
          return { ok: false, cause: requestTaint };
        let failed: Result | undefined;
        let position = 0;
        eachArgument(k + 3, close, (from, to) => {
          const plainBase =
            position > 0 &&
            to === from + 1 &&
            tokens[from].type === "string" &&
            !tokens[from].value.includes("%");
          position++;
          if (plainBase) return true;
          const r = from < to ? evalRange(from, to) : undefined;
          if (r !== undefined && !r.ok) failed = r;
          else if (r === undefined || r.kind.k !== "request")
            failed = unknown(
              `new ${ctor.value}()`,
              "a URL built from something other than request data, which decodes %3C and %26 into markup characters",
            );
          return failed === undefined;
        });
        if (failed !== undefined) return failed;
        kind = { k: "request" };
      } else return unknown(`new ${ctor.value}()`, "a constructed object");
      j = close + 1;
    } else {
      const v = nameVerdict(name);
      if (v.k === "unknown") {
        const cause =
          v.cause.what === name || v.cause.what === `${name}()`
            ? v.cause
            : {
                what: `${v.cause.what.split(" (through ")[0]} (through ${name})`,
                why: v.cause.why,
              };
        return { ok: false, cause };
      }
      if (v.k === "global") {
        const changed = builtinChanged(name);
        if (changed !== undefined) return { ok: false, cause: changed };
        if (STRING_CALLS.has(name) && punct(j, "(") && partner[j] !== -1) {
          const r = evalArgs(j + 1, partner[j]);
          if (!r.ok) return r;
          kind = PRIM;
          j = partner[j] + 1;
        } else if (
          NUMBER_CALLS.has(name) &&
          punct(j, "(") &&
          partner[j] !== -1
        ) {
          kind = PRIM;
          j = partner[j] + 1;
        } else if (
          name === "Number" &&
          punct(j, ".") &&
          /^(?:isFinite|isInteger|isSafeInteger|isNaN|parseInt|parseFloat|MAX_SAFE_INTEGER|MIN_SAFE_INTEGER|EPSILON)$/.test(
            tokens[j + 1]?.value ?? "",
          )
        ) {
          j += 2;
          if (punct(j, "(") && partner[j] !== -1) j = partner[j] + 1;
          kind = PRIM;
        } else if (name === "Math" && punct(j, ".") && word(j + 1)) {
          j += 2;
          if (punct(j, "(") && partner[j] !== -1) j = partner[j] + 1;
          kind = PRIM;
        } else if (
          name === "Date" &&
          punct(j, ".") &&
          /^(?:now|parse|UTC)$/.test(tokens[j + 1]?.value ?? "") &&
          punct(j + 2, "(") &&
          partner[j + 2] !== -1
        ) {
          j = partner[j + 2] + 1;
          kind = PRIM;
        } else if (
          name === "process" &&
          punct(j, ".") &&
          word(j + 1, "env") &&
          ((punct(j + 2, ".") && word(j + 3)) ||
            (punct(j + 2, "[") &&
              partner[j + 2] === j + 4 &&
              tokens[j + 3].type === "string"))
        ) {
          j = punct(j + 2, ".") ? j + 4 : j + 5;
          kind = PRIM;
        } else
          return unknown(
            name,
            "a value from outside the file (a global or an undeclared name)",
          );
      } else if (v.k === "helper") {
        if (!punct(j, "(") || partner[j] === -1)
          return unknown(`${name}()`, "a function passed on as a value");
        const fn = opts.functions.filter((f) => f.name === name);
        for (const f of fn) {
          const cause = helperVerdict(f);
          if (cause !== undefined)
            return {
              ok: false,
              cause:
                cause.what === `${name}()`
                  ? cause
                  : {
                      what: `${name}()`,
                      why: `a function that returns ${cause.what}, ${cause.why}`,
                    },
            };
        }
        if (fn.length === 0)
          return unknown(`${name}()`, "a function Bascik cannot follow");
        // Its arguments reach the result only through its parameters,
        // which are judged where they are read.
        kind = fn.some((f) => helperHtml.has(f)) ? HTML : PRIM;
        j = partner[j] + 1;
      } else if (v.k === "table") {
        if (punct(j, ".") && word(j + 1)) j += 2;
        else if (punct(j, "[") && partner[j] !== -1) j = partner[j] + 1;
        else return unknown(name, "an object or array other code can change");
        kind = PRIM;
      } else if (v.k === "request") {
        if (v.name === "context") {
          if (!(
            punct(j, ".") &&
            /^(?:params|remoteIp)$/.test(tokens[j + 1]?.value ?? "")
          ))
            return unknown(
              `${name}.${tokens[j + 1]?.value ?? ""}`,
              "context data other than params and remoteIp, which can hold the host's own values",
            );
        }
        if (v.escapes && (punct(j, ".") || punct(j, "[")))
          return unknown(
            name,
            "an object handed to other code, which may change it",
          );
        if (requestTaint !== undefined)
          return { ok: false, cause: requestTaint };
        kind = { k: "request" };
      } else kind = v;
    }
    // What follows: members, calls and indexes.
    for (;;) {
      if (j >= limit) break;
      if (punct(j, "!") && !punct(j + 1, "=")) {
        j++;
        continue;
      }
      if (punct(j, "?") && punct(j + 1, ".") && adjacent(j + 1)) {
        j++;
        if (punct(j + 1, "(") || punct(j + 1, "[")) j++;
      }
      if (punct(j, ".") && word(j + 1)) {
        const member = tokens[j + 1].value;
        // The call's `(`: right after the member, or after `?.`.
        const callAt =
          punct(j + 2, "(") && partner[j + 2] !== -1
            ? j + 2
            : punct(j + 2, "?") &&
                punct(j + 3, ".") &&
                adjacent(j + 3) &&
                punct(j + 4, "(") &&
                partner[j + 4] !== -1
              ? j + 4
              : -1;
        const call = callAt !== -1;
        if (kind.k === "date") {
          // A Date's methods return text or numbers; its other members
          // (constructor and the like) are not followed.
          if (!call)
            return unknown(
              body.slice(t.start, tokens[j + 1].end),
              `a read of .${member} on a Date, which Bascik cannot follow`,
            );
          const r = evalArgs(callAt + 1, partner[callAt]);
          if (!r.ok) return r;
          j = partner[callAt] + 1;
          kind = PRIM;
          continue;
        }
        if (kind.k === "request") {
          if (call && !REQUEST_READ_METHODS.has(member))
            return unknown(
              `.${member}()`,
              "a method Bascik does not know returns text",
            );
          j += 2;
          if (call) {
            const r = evalArgs(callAt + 1, partner[callAt]);
            if (!r.ok) return r;
            j = partner[callAt] + 1;
          }
          continue;
        }
        if (member === "length" && !call) {
          kind = PRIM;
          j += 2;
          continue;
        }
        if (STRING_METHODS.has(member) && call && kind.k !== "html") {
          const r = evalArgs(callAt + 1, partner[callAt]);
          if (!r.ok) return r;
          j = partner[callAt] + 1;
          kind = PRIM;
          continue;
        }
        return unknown(
          body.slice(t.start, tokens[call ? partner[callAt] : j + 1].end),
          call
            ? `a call of .${member}(), which Bascik does not know returns text`
            : `a read of .${member}, which Bascik cannot follow`,
        );
      }
      if (punct(j, "[") && partner[j] !== -1) {
        if (kind.k === "html")
          return unknown(
            body.slice(t.start, tokens[partner[j]].end),
            "an index Bascik cannot follow",
          );
        const r = evalRange(j + 1, partner[j]);
        if (!r.ok) return r;
        j = partner[j] + 1;
        if (kind.k !== "request") kind = PRIM;
        continue;
      }
      if (punct(j, "(") && partner[j] !== -1) {
        return unknown(
          body.slice(t.start, tokens[partner[j]].end),
          "a call Bascik cannot follow",
        );
      }
      break;
    }
    if (j !== htmlEnd && tagged(j) && j <= limit)
      return unknown(
        body.slice(t.start, tokens[j - 1].end),
        "a tagged template",
      );
    return { ok: true, kind, end: j };
  };

  /** Evaluates tokens [a, b): every value in them must be plain. */
  const evalRange = (a: number, b: number): Result => {
    if (a >= b) return { ok: true, kind: PRIM, end: b };
    // A template with holes leaves no token for its backtick or text, so
    // the gaps around the range count too (kept inside the hole itself).
    let lo = a > 0 ? tokens[a - 1].end : 0;
    let hi = b < n ? tokens[b].start : body.length;
    if (tokens[a].start >= holeLo && tokens[b - 1].end <= holeHi) {
      lo = Math.max(lo, holeLo);
      hi = Math.min(hi, holeHi);
    }
    lo = Math.min(lo, tokens[a].start);
    hi = Math.max(hi, tokens[b - 1].end);
    if (opts.markupWithin(lo, hi))
      return unknown(
        body.slice(tokens[a].start, tokens[b - 1].end).slice(0, 40),
        "markup built as a string",
      );
    if (opts.markupCharacterTextWithin?.(lo, hi))
      return unknown(
        body.slice(tokens[a].start, tokens[b - 1].end).slice(0, 40),
        MARKUP_CHARACTER,
      );
    let chains = 0;
    let other = false;
    let last: Kind = PRIM;
    // An html value here, and whether + or a template turns it into text.
    let html = false;
    let plus = false;
    let i = a;
    while (i < b) {
      const t = tokens[i];
      if (t.type === "punctuation") {
        const v = t.value;
        if (v === "(") {
          if (partner[i] === -1 || partner[i] >= b)
            return unknown(t.value, "an expression Bascik cannot follow");
          const r = evalRange(i + 1, partner[i]);
          if (!r.ok) return r;
          i = partner[i] + 1;
          other = true;
          if (r.kind.k === "html") html = true;
          // A member of a parenthesized value.
          while (punct(i, ".") && word(i + 1)) {
            const m = tokens[i + 1].value;
            if (r.kind.k === "html") return unknown(`.${m}`, HTML_AS_TEXT);
            if (m === "length" && !punct(i + 2, "(")) {
              i += 2;
              continue;
            }
            if (
              STRING_METHODS.has(m) &&
              punct(i + 2, "(") &&
              partner[i + 2] !== -1
            ) {
              const ar = evalArgs(i + 3, partner[i + 2]);
              if (!ar.ok) return ar;
              i = partner[i + 2] + 1;
              continue;
            }
            return unknown(`.${m}`, "a member Bascik cannot follow");
          }
          continue;
        }
        if (v === "{")
          return unknown(
            "{...}",
            "an object literal, which Bascik does not follow",
          );
        if (v === "[")
          return unknown(
            "[...]",
            "an array literal, which Bascik does not follow",
          );
        if (v === ".") {
          if (isSpread(i + 3) || (punct(i + 1, ".") && punct(i + 2, ".")))
            return unknown("...", "a spread, which Bascik does not follow");
          // A member of a literal or a template.
          if (word(i + 1)) {
            const m = tokens[i + 1].value;
            if (m === "length" && !punct(i + 2, "(")) {
              i += 2;
              continue;
            }
            if (
              STRING_METHODS.has(m) &&
              punct(i + 2, "(") &&
              partner[i + 2] !== -1
            ) {
              const ar = evalArgs(i + 3, partner[i + 2]);
              if (!ar.ok) return ar;
              i = partner[i + 2] + 1;
              continue;
            }
            return unknown(`.${m}`, "a member Bascik cannot follow");
          }
          i++;
          continue;
        }
        if (OP_CHARS.has(v)) {
          const op = opAt(i);
          if (op.includes("=>"))
            return unknown("=>", "a function, which Bascik does not follow");
          if (isAssignOp(op))
            return unknown(op, "an assignment, which Bascik does not follow");
          if (op.includes("+")) plus = true;
          i += Math.max(1, op.length);
          other = true;
          continue;
        }
        other = true;
        i++;
        continue;
      }
      if (t.type === "string" || t.type === "template") {
        if (holdsMarkupCharacter(t.value))
          return unknown(
            (t.type === "string" ? `"${t.value}"` : `\`${t.value}\``).slice(
              0,
              40,
            ),
            MARKUP_CHARACTER,
          );
        // A template token is a template with no holes; one right after a
        // value is tagged, which evalChain has refused already.
        i++;
        other = true;
        continue;
      }
      const w = t.value;
      if (LITERAL_WORDS.has(w)) {
        i++;
        other = true;
        continue;
      }
      if (w === "typeof" || w === "void") {
        // typeof x is a type name and void x is undefined, whatever x is.
        i++;
        if (punct(i, "(") && partner[i] !== -1) i = partner[i] + 1;
        else if (word(i)) i = chainAfter(i).end;
        other = true;
        continue;
      }
      if (w === "await" || w === "in" || w === "instanceof") {
        i++;
        if (w !== "await") other = true;
        continue;
      }
      if (w === "as" || w === "satisfies") {
        if (w === "as" && word(i + 1, "const")) {
          i += 2;
          continue;
        }
        return unknown("as", "a value cast with as");
      }
      if (UNKNOWN_WORDS.has(w))
        return unknown(
          w,
          w === "this" ? "a this field" : "a value Bascik cannot follow",
        );
      const r = evalChain(i, b);
      if (!r.ok) return r;
      chains++;
      last = r.kind;
      if (r.kind.k === "html") html = true;
      i = r.end;
    }
    if (html && (plus || opts.plainTemplateWithin?.(lo, hi)))
      return unknown(
        body.slice(tokens[a].start, tokens[b - 1].end).slice(0, 40),
        HTML_AS_TEXT,
      );
    return {
      ok: true,
      kind: html ? HTML : chains === 1 && !other ? last : PRIM,
      end: b,
    };
  };

  return (from: number, to: number): Unproven | undefined => {
    if (rewrites !== undefined) return rewrites;
    if (prototypeReach !== undefined) return prototypeReach;
    const a = tokenAt(from);
    let b = a;
    while (b < n && tokens[b].start < to) b++;
    holeLo = from;
    holeHi = to;
    const r = evalRange(a, b);
    holeLo = holeHi = -1;
    return r.ok ? undefined : r.cause;
  };
}
