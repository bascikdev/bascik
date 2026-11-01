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
 * - string, number, bigint and boolean literals, and `const` objects or
 *   arrays of only those that the file reads by a literal key or index
 *   and never changes, exports or passes on;
 * - request data: the `request` parameter, `context.params` and
 *   `context.remoteIp`, in request-time code (and `const` values taken
 *   from them);
 * - `process.env` values;
 * - `Date` and `Date.now()`-derived values, and `Math` results;
 * - parameters typed number, bigint or boolean (or a union of those) that
 *   the file never reassigns or casts with `as`;
 * - local functions that are not exported, are only called by name, and
 *   whose every return is plain itself;
 * - html values (an html`...` template, raw(), safeUrl(), json()), which
 *   html inserts as they are.
 *
 * Anything else is unknown: object fields and array slots other code can
 * change, Map and Set reads, class fields, closures, catch and loop
 * bindings, globalThis, destructuring targets, imported values, `let` and
 * `var`, and parameters of any other type.
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
    { plain: boolean; request: boolean; catch: boolean }
  >();
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
    let names: number[] = [];
    let pattern = false;
    let rest = false;
    let part = 0;
    let typeFrom = -1;
    let typeTo = -1;
    const finish = (): void => {
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
        });
      }
      names = [];
      pattern = rest = false;
      part = 0;
      typeFrom = typeTo = -1;
    };
    for (let j = p + 1; j < c; j++) {
      const t = tokens[j];
      if (t.type === "punctuation") {
        if (t.value === ",") {
          finish();
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
    finish();
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
      params.set(k, { plain: false, request: false, catch: false });
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
  let depth = 0;
  const helperMemo = new Map<PlainFunction, Unproven | undefined | "pending">();

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
      if (
        !/^(?:\s|[\d._xXoObBnaAbBcCdDeEfF+-]|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/.test(
          gap,
        )
      )
        return false;
    }
    return true;
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
    } else
      for (const k of returnsOf.get(fn) ?? []) {
        if (punct(k + 1, ";") || punct(k + 1, "}")) continue;
        const r = evalRange(k + 1, expressionEnd(k + 1, false));
        if (!r.ok) {
          cause = r.cause;
          break;
        }
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
    if (first.k === "request")
      return { k: "request", name: first.name, escapes };
    return first;
  };

  /** Evaluates the value at token k (a name, a call, `new ...`) and what follows it. */
  const evalChain = (k: number, limit: number): Result => {
    const t = tokens[k];
    const name = t.value;
    let j = k + 1;
    let kind: Kind;
    const tagged = (at: number): boolean =>
      body[tokens[at - 1]?.end ?? 0] === "`";
    if (opts.isHtmlValue(name) || opts.htmlTags.includes(name)) {
      if (tagged(j)) {
        const end = opts.templateEndAt(t.end);
        if (end !== undefined)
          return { ok: true, kind: { k: "html" }, end: tokenAt(end) };
      }
      if (punct(j, "(") && partner[j] !== -1)
        return { ok: true, kind: { k: "html" }, end: partner[j] + 1 };
    }
    if (name === "new") {
      const ctor = tokens[k + 1];
      if (!word(k + 1) || !punct(k + 2, "(") || partner[k + 2] === -1)
        return unknown(
          `new ${ctor?.value ?? ""}`.trim(),
          "a constructed object",
        );
      const close = partner[k + 2];
      if (ctor.value === "Date" && nameVerdict("Date").k === "global")
        kind = { k: "date" };
      else if (
        (ctor.value === "URL" || ctor.value === "URLSearchParams") &&
        nameVerdict(ctor.value).k === "global"
      ) {
        const r = evalRange(k + 3, close);
        if (!r.ok) return r;
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
        if (STRING_CALLS.has(name) && punct(j, "(") && partner[j] !== -1) {
          const r = evalRange(j + 1, partner[j]);
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
        kind = PRIM;
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
      let optional = false;
      if (punct(j, "?") && punct(j + 1, ".") && adjacent(j + 1)) {
        optional = true;
        j++;
        if (punct(j + 1, "(") || punct(j + 1, "[")) j++;
      }
      if (punct(j, ".") && word(j + 1)) {
        const member = tokens[j + 1].value;
        const call = punct(j + 2, "(") && partner[j + 2] !== -1;
        if (kind.k === "date") {
          j += 2;
          if (call) {
            j = partner[j] + 1;
            kind = PRIM;
          }
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
            const r = evalRange(j + 1, partner[j]);
            if (!r.ok) return r;
            j = partner[j] + 1;
          }
          continue;
        }
        if (member === "length" && !call) {
          kind = PRIM;
          j += 2;
          continue;
        }
        if (STRING_METHODS.has(member) && call && kind.k !== "html") {
          const r = evalRange(j + 3, partner[j + 2]);
          if (!r.ok) return r;
          j = partner[j + 2] + 1;
          kind = PRIM;
          continue;
        }
        return unknown(
          body.slice(t.start, tokens[call ? partner[j + 2] : j + 1].end),
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
        if (kind.k === "request" && optional) {
          j = partner[j] + 1;
          continue;
        }
        return unknown(
          body.slice(t.start, tokens[partner[j]].end),
          "a call Bascik cannot follow",
        );
      }
      break;
    }
    if (tagged(j) && j <= limit)
      return unknown(
        body.slice(t.start, tokens[j - 1].end),
        "a tagged template",
      );
    return { ok: true, kind, end: j };
  };

  /** Evaluates tokens [a, b): every value in them must be plain. */
  const evalRange = (a: number, b: number): Result => {
    if (a >= b) return { ok: true, kind: PRIM, end: b };
    if (opts.markupWithin(tokens[a].start, tokens[b - 1].end))
      return unknown(
        body.slice(tokens[a].start, tokens[b - 1].end).slice(0, 40),
        "markup built as a string",
      );
    let chains = 0;
    let other = false;
    let last: Kind = PRIM;
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
          // A member of a parenthesized value.
          while (punct(i, ".") && word(i + 1)) {
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
              const ar = evalRange(i + 3, partner[i + 2]);
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
              const ar = evalRange(i + 3, partner[i + 2]);
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
          i += Math.max(1, op.length);
          other = true;
          continue;
        }
        other = true;
        i++;
        continue;
      }
      if (t.type === "string") {
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
      i = r.end;
    }
    return { ok: true, kind: chains === 1 && !other ? last : PRIM, end: b };
  };

  return (from: number, to: number): Unproven | undefined => {
    const a = tokenAt(from);
    let b = a;
    while (b < n && tokens[b].start < to) b++;
    const r = evalRange(a, b);
    return r.ok ? undefined : r.cause;
  };
}
