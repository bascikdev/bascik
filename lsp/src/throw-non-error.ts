/**
 * throw-non-error: a `throw`, a `Promise.reject()` or a Promise executor's
 * `reject()` whose value can never be an Error. Such a value has no stack,
 * so when a server, stream, build or routes script (or an API route, or a
 * module one of them runs) throws it, Bascik's report can name only where
 * the script starts. This marks the line instead, while the code is written.
 *
 * The same idea as ESLint's `no-throw-literal` and
 * `prefer-promise-reject-errors` (and typescript-eslint's `only-throw-error`
 * without types): an identifier, a call, `new`, a member access, `await`,
 * `yield` or a tagged template could hold an Error, so it is never reported;
 * a literal, a template, an object or array literal, `undefined`, a function
 * and unary, binary and update expressions never can. A conditional or a
 * logical expression is reported only when no branch could be an Error, and
 * a sequence by its last expression.
 *
 * Syntactic and deterministic: no type checker. It reads the tokens of
 * `scanJavaScript`, so strings, comments, template text and regular
 * expressions hide what they hold, and it walks each expression's top-level
 * tokens, stepping over a bracketed group in one step, so a script costs one
 * pass however its throws nest. Anything it cannot read for certain (a
 * TypeScript construct it does not know, a cast it cannot step over) is not
 * reported.
 */
import { scanJavaScript } from "./module-specifiers.js";

export const THROW_NON_ERROR_RULE = "throw-non-error";

export interface NonErrorThrow {
  /** A `throw` statement, a `Promise.reject()` call, or a call to a Promise executor's reject parameter. */
  site: "throw" | "Promise.reject" | "reject";
  /** What the value is, for the message: "a string", "null", "an object". Empty when the call passes nothing. */
  value: string;
  /** The value (or, with no value, the call), as offsets in the source. */
  start: number;
  end: number;
  /** The value is one string or template literal, so `new Error(value)` keeps its text. */
  wrappable: boolean;
  /** site "reject": the executor's name for its reject parameter. */
  callee?: string;
}

type Kind =
  "identifier" | "string" | "template" | "number" | "regex" | "punctuation";

interface Tok {
  kind: Kind;
  value: string;
  start: number;
  end: number;
  /** A string or template that never closes (code being typed). */
  unclosed?: boolean;
}

/** What an expression evaluates to: could it be an Error, and if not, what it is. */
interface Value {
  couldBeError: boolean;
  kind: string;
  wrappable: boolean;
}

const COULD_BE_ERROR: Value = {
  couldBeError: true,
  kind: "",
  wrappable: false,
};
const plain = (kind: string): Value => ({
  couldBeError: false,
  kind,
  wrappable: false,
});

/** Punctuators longer than one character, longest first. */
const OPERATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "**",
  "++",
  "--",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
];

const BINARY_PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "===": 6,
  "!==": 6,
  "<": 7,
  ">": 7,
  "<=": 7,
  ">=": 7,
  instanceof: 7,
  in: 7,
  "<<": 8,
  ">>": 8,
  ">>>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "**": 11,
};

const ASSIGNMENT_OPERATORS = new Set([
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

const PREFIX_OPERATORS = new Set(["!", "-", "+", "~", "++", "--"]);
const PREFIX_KEYWORDS = new Set(["typeof", "void", "delete", "await"]);

/** Words that cannot start an expression: a statement keyword means this is not code the parser understands. */
const NOT_AN_EXPRESSION = new Set([
  "break",
  "case",
  "catch",
  "const",
  "continue",
  "debugger",
  "default",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "if",
  "in",
  "instanceof",
  "let",
  "return",
  "switch",
  "throw",
  "try",
  "var",
  "while",
  "with",
]);

/** How deep the expression parser recurses before it gives up (and reports nothing). */
const MAX_DEPTH = 64;
/** How many tokens a look for TypeScript type arguments (`f<T>(x)`) reads. */
const TYPE_ARGUMENT_LOOKAHEAD = 64;

const isLineBreak = (code: number): boolean =>
  code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

/**
 * The script's tokens with every value a token of its own, and
 * multi-character operators joined. A template with holes is one token,
 * followed by the tokens of the code in its holes, which `skipTo` steps over
 * (for every other token it is the next index); `gapStart` is where the text
 * before each token starts, so a template's closing text is not read as a
 * gap between two tokens.
 */
function tokensOf(source: string): {
  toks: Tok[];
  skipTo: Int32Array;
  gapStart: Int32Array;
} {
  const { tokens, values } = scanJavaScript(source);
  const merged: Tok[] = [];
  const addValue = (value: (typeof values)[number]): number =>
    merged.push({
      kind: value.type,
      value: source.slice(value.start, value.end),
      start: value.start,
      end: value.end,
      ...(value.type === "template" &&
      (value.end - value.start < 2 || source[value.end - 1] !== "`")
        ? { unclosed: true }
        : {}),
    });
  let v = 0;
  for (const token of tokens) {
    while (v < values.length && values[v].start < token.start)
      addValue(values[v++]);
    if (token.type === "string" || token.type === "template")
      merged.push({
        kind: token.type,
        value: token.value,
        start: token.start - 1,
        end: Math.min(token.end + 1, source.length),
        // The quote that opened it, where the closing one should be.
        ...(source[token.end] !== source[token.start - 1]
          ? { unclosed: true }
          : {}),
      });
    else
      merged.push({
        kind: token.type,
        value: token.value,
        start: token.start,
        end: token.end,
      });
  }
  while (v < values.length) addValue(values[v++]);

  const out: Tok[] = [];
  for (let i = 0; i < merged.length; i++) {
    const tok = merged[i];
    if (tok.kind !== "punctuation") {
      out.push(tok);
      continue;
    }
    let length = 1;
    for (const operator of OPERATORS) {
      if (!source.startsWith(operator, tok.start)) continue;
      let adjacent = true;
      for (let k = 1; k < operator.length; k++) {
        const next = merged[i + k];
        if (next?.kind !== "punctuation" || next.start !== tok.start + k) {
          adjacent = false;
          break;
        }
      }
      // `a?.5:b` is a conditional, not an optional chain.
      if (operator === "?." && /[0-9]/.test(source[tok.start + 2] ?? ""))
        adjacent = false;
      if (adjacent) {
        length = operator.length;
        break;
      }
    }
    // `.5` is a number.
    const next = merged[i + 1];
    if (
      length === 1 &&
      tok.value === "." &&
      next?.kind === "number" &&
      next.start === tok.end
    ) {
      out.push({
        kind: "number",
        value: source.slice(tok.start, next.end),
        start: tok.start,
        end: next.end,
      });
      i++;
      continue;
    }
    out.push({
      kind: "punctuation",
      value: source.slice(tok.start, tok.start + length),
      start: tok.start,
      end: tok.start + length,
    });
    i += length - 1;
  }

  const n = out.length;
  const skipTo = new Int32Array(n);
  // One more entry: gapStart[n] is where the last token (or template) ends.
  const gapStart = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    if (i < n) skipTo[i] = i + 1;
    gapStart[i] = i > 0 ? out[i - 1].end : 0;
  }
  for (let i = 0; i < n; i++) {
    const tok = out[i];
    if (tok.kind !== "template" || tok.end - tok.start < 2) continue;
    // The first token after the template: a binary search, so templates
    // nested in holes cost no rescan.
    let low = i + 1;
    let high = n;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (out[mid].start < tok.end) low = mid + 1;
      else high = mid;
    }
    skipTo[i] = low;
    gapStart[low] = Math.max(gapStart[low], tok.end);
  }
  return { toks: out, skipTo, gapStart };
}

/** Every throw and rejection in `source` whose value can never be an Error. */
export function findNonErrorThrows(source: string): NonErrorThrow[] {
  // Most scripts throw nothing: skip the token pass for them.
  if (!source.includes("throw") && !source.includes("Promise")) return [];
  const { toks, skipTo, gapStart } = tokensOf(source);
  const n = toks.length;
  const found: NonErrorThrow[] = [];

  // The token that closes each bracket (and opens each closing one), and the
  // innermost bracket around each token, from one pass with a stack.
  const match = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const open: number[] = [];
  const CLOSES: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < n; i++) {
    const tok = toks[i];
    parent[i] = open.length > 0 ? open[open.length - 1] : -1;
    if (tok.kind !== "punctuation") continue;
    if (tok.value === "(" || tok.value === "[" || tok.value === "{")
      open.push(i);
    else if (tok.value in CLOSES) {
      const top = open[open.length - 1];
      if (top !== undefined && toks[top].value === CLOSES[tok.value]) {
        match[top] = i;
        match[i] = top;
        open.pop();
      }
    }
  }

  // 0: not read yet, 1: no line break before the token, 2: a line break.
  const breaks = new Int8Array(n);
  const lineBreakBefore = (i: number): boolean => {
    if (i <= 0 || i >= n) return false;
    if (breaks[i] === 0) {
      let found = false;
      for (let c = gapStart[i]; c < toks[i].start; c++)
        if (isLineBreak(source.charCodeAt(c))) {
          found = true;
          break;
        }
      breaks[i] = found ? 2 : 1;
    }
    return breaks[i] === 2;
  };

  const isPunct = (i: number, value: string): boolean =>
    i >= 0 &&
    i < n &&
    toks[i].kind === "punctuation" &&
    toks[i].value === value;
  const isWord = (i: number, value: string): boolean =>
    i >= 0 && i < n && toks[i].kind === "identifier" && toks[i].value === value;
  const isMemberName = (i: number): boolean =>
    isPunct(i - 1, ".") || isPunct(i - 1, "?.") || isPunct(i - 1, "#");

  /** The index after a group that opens at `i`, or -1 when it never closes. */
  const after = (i: number): number => (match[i] < 0 ? -1 : match[i] + 1);

  /**
   * The index after TypeScript type arguments that open with `<` at `i`
   * (`f<T>(x)`, `new Map<string, number>()`), or -1 when what follows is no
   * type argument list. Reads at most TYPE_ARGUMENT_LOOKAHEAD tokens, so a
   * chain of comparisons costs no rescan.
   */
  const typeArgumentsEnd = (i: number): number => {
    let depth = 0;
    let read = 0;
    for (let k = i; k < n && read < TYPE_ARGUMENT_LOOKAHEAD; read++) {
      const tok = toks[k];
      if (tok.kind === "punctuation") {
        if (tok.value === "<") depth++;
        else if (tok.value === ">" || tok.value === ">>" || tok.value === ">>>")
          depth -= tok.value.length;
        else if (tok.value === "(" || tok.value === "[" || tok.value === "{") {
          const end = after(k);
          if (end < 0) return -1;
          k = end;
          continue;
        } else if (![",", ".", "|", "&", "=>", "?", ":"].includes(tok.value))
          return -1;
        if (depth < 0) return -1;
        if (depth === 0) return k + 1;
      } else if (tok.kind === "regex" || tok.kind === "template") return -1;
      k++;
    }
    return -1;
  };

  const TYPE_OPERATORS = new Set([
    "keyof",
    "typeof",
    "readonly",
    "unique",
    "infer",
  ]);
  /** A token a type can end with, so a word after it starts something else. */
  const completesType = (tok: Tok): boolean =>
    tok.kind === "identifier"
      ? !TYPE_OPERATORS.has(tok.value)
      : tok.kind === "punctuation"
        ? [")", "]", "}", ">", ">>", ">>>"].includes(tok.value)
        : true;

  /**
   * The index after a TypeScript type that starts at `i` (after `as`,
   * `satisfies`, or `:` in a parameter list), or -1. It stops at the first
   * token at depth 0 that a type cannot hold.
   */
  const typeEnd = (i: number): number => {
    let k = i;
    let angle = 0;
    let read = 0;
    while (k < n) {
      if (++read > 4 * TYPE_ARGUMENT_LOOKAHEAD) return -1;
      const tok = toks[k];
      if (tok.kind === "punctuation") {
        const v = tok.value;
        if (v === "(" || v === "[" || v === "{") {
          // `{` after a complete type ends it (a body); inside angles it is an object type.
          if (v === "{" && angle === 0 && k > i) return k;
          const end = after(k);
          if (end < 0) return -1;
          k = end;
          continue;
        }
        if (v === "<") angle++;
        else if (v === ">" || v === ">>" || v === ">>>") {
          if (angle === 0) return k;
          angle = Math.max(0, angle - v.length);
        } else if (v === "|" || v === "&" || v === "." || v === "=>") {
          // part of the type
        } else if (angle > 0 && (v === "," || v === "?" || v === ":")) {
          // inside type arguments
        } else return k;
      } else if (tok.kind === "identifier") {
        // A word after a complete type ends it (`x as T as U`, `x as T[]
        // satisfies U`); after a type operator (`keyof T`, `typeof x`,
        // `readonly string[]`) or `|`, `&`, `.`, `=>` it is part of it.
        if (k > i && angle === 0 && completesType(toks[k - 1])) return k;
      } else if (tok.kind === "regex" || tok.kind === "template") return k;
      k++;
    }
    return k;
  };

  // The expression parser. `p` is the token it reads next; each function
  // reads one construct and returns what it is, or null when the code is
  // not something it can read for certain (nothing is then reported).
  let p = 0;
  let depth = 0;

  const kindOf = (a: Value, b: Value): Value => {
    if (a.couldBeError || b.couldBeError) return COULD_BE_ERROR;
    if (a.kind === b.kind) return plain(a.kind);
    const kinds = new Set(
      [...a.kind.split(" or "), ...b.kind.split(" or ")].filter(Boolean),
    );
    return plain(kinds.size <= 3 ? [...kinds].join(" or ") : "a plain value");
  };

  /** An arrow function's body after `=>` at `p`. */
  const arrowBody = (): boolean => {
    if (isPunct(p, "{")) {
      const end = after(p);
      if (end < 0) return false;
      p = end;
      return true;
    }
    if (++depth > MAX_DEPTH) return false;
    const body = parseAssignment();
    depth--;
    return body !== null;
  };

  const parsePrimary = (): Value | null => {
    if (p >= n) return null;
    const tok = toks[p];
    switch (tok.kind) {
      case "string":
      case "template":
        if (tok.unclosed) return null;
        p = skipTo[p];
        return { couldBeError: false, kind: "a string", wrappable: true };
      case "number":
        p++;
        return plain(
          /^[0-9][0-9_]*n$/.test(tok.value) ? "a bigint" : "a number",
        );
      case "regex":
        p++;
        return plain("a regular expression");
      case "punctuation": {
        if (tok.value === "(") {
          const end = after(p);
          if (end < 0) return null;
          if (isPunct(end, "=>") && !lineBreakBefore(end)) {
            p = end + 1;
            return arrowBody() ? plain("a function") : null;
          }
          if (end === p + 2) return null; // `()` that is no arrow
          const close = end - 1;
          p++;
          if (++depth > MAX_DEPTH) return null;
          const inner = parseExpression();
          depth--;
          if (!inner || p !== close) return null;
          p = end;
          return { ...inner, wrappable: false };
        }
        if (tok.value === "[" || tok.value === "{") {
          const end = after(p);
          if (end < 0) return null;
          p = end;
          return plain(tok.value === "[" ? "an array" : "an object");
        }
        return null;
      }
      case "identifier": {
        const word = tok.value;
        if (NOT_AN_EXPRESSION.has(word)) return null;
        if (word === "undefined") {
          p++;
          return plain("undefined");
        }
        if (word === "null") {
          p++;
          return plain("null");
        }
        if (word === "true" || word === "false") {
          p++;
          return plain("a boolean");
        }
        if (word === "class") return null;
        if (word === "function") {
          p++;
          if (isPunct(p, "*")) p++;
          if (toks[p]?.kind === "identifier") p++;
          if (!isPunct(p, "(")) return null;
          const end = after(p);
          if (end < 0 || !isPunct(end, "{")) return null;
          const bodyEnd = after(end);
          if (bodyEnd < 0) return null;
          p = bodyEnd;
          return plain("a function");
        }
        if (word === "async" && !lineBreakBefore(p + 1)) {
          if (isWord(p + 1, "function")) {
            p++;
            return parsePrimary();
          }
          if (
            toks[p + 1]?.kind === "identifier" &&
            isPunct(p + 2, "=>") &&
            !lineBreakBefore(p + 2)
          ) {
            p += 3;
            return arrowBody() ? plain("a function") : null;
          }
          if (isPunct(p + 1, "(")) {
            const end = after(p + 1);
            if (end > 0 && isPunct(end, "=>") && !lineBreakBefore(end)) {
              p = end + 1;
              return arrowBody() ? plain("a function") : null;
            }
          }
        }
        if (isPunct(p + 1, "=>") && !lineBreakBefore(p + 1)) {
          p += 2;
          return arrowBody() ? plain("a function") : null;
        }
        if (word === "new") return parseNew();
        p++;
        // An identifier, `this`, `super`, `import`: could hold an Error.
        return COULD_BE_ERROR;
      }
    }
    return null;
  };

  /** `new X(...)`, `new X`, `new.target`: could be an Error. */
  const parseNew = (): Value | null => {
    p++; // new
    if (isPunct(p, ".")) {
      p += 2;
      return COULD_BE_ERROR;
    }
    if (++depth > MAX_DEPTH) return null;
    const callee = isWord(p, "new") ? parseNew() : parsePrimary();
    depth--;
    if (!callee) return null;
    // The callee's member accesses; the first call is the constructor's arguments.
    for (;;) {
      if (isPunct(p, ".") || isPunct(p, "?.")) {
        p++;
        if (isPunct(p, "#")) p++;
        if (toks[p]?.kind !== "identifier") return null;
        p++;
      } else if (isPunct(p, "[")) {
        const end = after(p);
        if (end < 0) return null;
        p = end;
      } else if (isPunct(p, "<")) {
        const end = typeArgumentsEnd(p);
        if (end < 0) break;
        p = end;
      } else break;
    }
    if (isPunct(p, "(")) {
      const end = after(p);
      if (end < 0) return null;
      p = end;
    }
    return COULD_BE_ERROR;
  };

  /** A primary followed by member accesses, calls, tagged templates, casts and `++`. */
  const parsePostfix = (): Value | null => {
    let value = parsePrimary();
    if (!value) return null;
    for (;;) {
      if (p >= n) break;
      const tok = toks[p];
      if (tok.kind === "template") {
        // A tagged template.
        p = skipTo[p];
        value = COULD_BE_ERROR;
        continue;
      }
      if (tok.kind === "identifier") {
        if (
          (tok.value === "as" || tok.value === "satisfies") &&
          !lineBreakBefore(p)
        ) {
          const end = typeEnd(p + 1);
          if (end < 0 || end === p + 1) return null;
          p = end;
          value = { ...value, wrappable: false };
          continue;
        }
        break;
      }
      if (tok.kind !== "punctuation") break;
      const v = tok.value;
      if (v === "." || v === "?.") {
        p++;
        if (isPunct(p, "#")) p++;
        if (toks[p]?.kind === "identifier") p++;
        else if (v === "?." && (isPunct(p, "(") || isPunct(p, "["))) {
          const end = after(p);
          if (end < 0) return null;
          p = end;
        } else return null;
        value = COULD_BE_ERROR;
      } else if (v === "(" || v === "[") {
        const end = after(p);
        if (end < 0) return null;
        p = end;
        value = COULD_BE_ERROR;
      } else if (v === "!" && !lineBreakBefore(p)) {
        // TypeScript's non-null assertion: the same value.
        p++;
        value = { ...value, wrappable: false };
      } else if (v === "<") {
        const end = typeArgumentsEnd(p);
        if (end < 0 || !(isPunct(end, "(") || toks[end]?.kind === "template"))
          break;
        p = end;
      } else if ((v === "++" || v === "--") && !lineBreakBefore(p)) {
        p++;
        return plain("a number");
      } else break;
    }
    return value;
  };

  const parseUnary = (): Value | null => {
    const tok = toks[p];
    if (!tok) return null;
    const isPrefix =
      (tok.kind === "punctuation" && PREFIX_OPERATORS.has(tok.value)) ||
      (tok.kind === "identifier" &&
        PREFIX_KEYWORDS.has(tok.value) &&
        // `await` that is a name (`throw await;`) is an identifier.
        !(
          tok.value === "await" &&
          (p + 1 >= n ||
            lineBreakBefore(p + 1) ||
            isPunct(p + 1, ";") ||
            isPunct(p + 1, ")"))
        ));
    if (!isPrefix) return parsePostfix();
    p++;
    if (++depth > MAX_DEPTH) return null;
    const operand = parseUnary();
    depth--;
    if (!operand) return null;
    switch (tok.value) {
      case "await":
        return COULD_BE_ERROR;
      case "typeof":
        return plain("a string");
      case "void":
        return plain("undefined");
      case "delete":
      case "!":
        return plain("a boolean");
      default:
        return plain("a number");
    }
  };

  const combineBinary = (
    operator: string,
    left: Value,
    right: Value,
  ): Value => {
    if (operator === "&&")
      return right.couldBeError ? COULD_BE_ERROR : plain(right.kind);
    if (operator === "||" || operator === "??") return kindOf(left, right);
    const precedence = BINARY_PRECEDENCE[operator];
    if (precedence === 6 || precedence === 7) return plain("a boolean");
    if (operator === "+") {
      if (left.kind === "a string" || right.kind === "a string")
        return plain("a string");
      if (left.kind === "a number" && right.kind === "a number")
        return plain("a number");
      return plain("a string or a number");
    }
    return plain("a number");
  };

  const operatorAt = (i: number): string | undefined => {
    const tok = toks[i];
    if (!tok) return undefined;
    if (tok.kind === "punctuation" && tok.value in BINARY_PRECEDENCE)
      return tok.value;
    if (
      tok.kind === "identifier" &&
      (tok.value === "in" || tok.value === "instanceof")
    )
      return tok.value;
    return undefined;
  };

  const parseBinary = (minPrecedence: number): Value | null => {
    let left = parseUnary();
    if (!left) return null;
    for (;;) {
      const operator = operatorAt(p);
      if (operator === undefined) break;
      const precedence = BINARY_PRECEDENCE[operator];
      if (precedence < minPrecedence) break;
      p++;
      if (++depth > MAX_DEPTH) return null;
      const right = parseBinary(
        operator === "**" ? precedence : precedence + 1,
      );
      depth--;
      if (!right) return null;
      left = combineBinary(operator, left, right);
    }
    return left;
  };

  const parseConditional = (): Value | null => {
    const test = parseBinary(1);
    if (!test) return null;
    if (!isPunct(p, "?")) return test;
    p++;
    if (++depth > MAX_DEPTH) return null;
    const consequent = parseAssignment();
    if (!consequent || !isPunct(p, ":")) return null;
    p++;
    const alternate = parseAssignment();
    depth--;
    if (!alternate) return null;
    return kindOf(consequent, alternate);
  };

  function parseAssignment(): Value | null {
    if (isWord(p, "yield")) {
      p++;
      if (
        p < n &&
        !lineBreakBefore(p) &&
        ![")", "]", "}", ",", ";", ":"].includes(toks[p].value)
      ) {
        if (isPunct(p, "*")) p++;
        if (++depth > MAX_DEPTH) return null;
        const operand = parseAssignment();
        depth--;
        if (!operand) return null;
      }
      return COULD_BE_ERROR;
    }
    const left = parseConditional();
    if (!left) return null;
    const tok = toks[p];
    if (tok?.kind !== "punctuation" || !ASSIGNMENT_OPERATORS.has(tok.value))
      return left;
    p++;
    if (++depth > MAX_DEPTH) return null;
    const right = parseAssignment();
    depth--;
    if (!right) return null;
    if (tok.value === "=" || tok.value === "&&=")
      return right.couldBeError ? COULD_BE_ERROR : plain(right.kind);
    if (tok.value === "||=" || tok.value === "??=") return kindOf(left, right);
    return plain(tok.value === "+=" ? "a string or a number" : "a number");
  }

  function parseExpression(): Value | null {
    let value = parseAssignment();
    while (value && isPunct(p, ",")) {
      p++;
      value = parseAssignment();
    }
    return value;
  }

  /** What the expression at `start` is, and where it ends, or null. */
  const expressionAt = (
    start: number,
    full: boolean,
  ): { value: Value; end: number } | null => {
    p = start;
    depth = 0;
    const value = full ? parseExpression() : parseAssignment();
    return value ? { value, end: p } : null;
  };

  const report = (
    site: NonErrorThrow["site"],
    from: number,
    to: number,
    value: Value | undefined,
    callee?: string,
  ): void => {
    found.push({
      site,
      value: value?.kind ?? "",
      start: toks[from].start,
      end: gapStart[to],
      wrappable: value !== undefined && value.wrappable && to === skipTo[from],
      ...(callee !== undefined ? { callee } : {}),
    });
  };

  /**
   * A call's arguments in the group that opens at `open`: reports the call
   * when it passes nothing, or its first argument when that can never be an
   * Error. `from` is where the call starts.
   */
  const checkRejectCall = (
    site: NonErrorThrow["site"],
    from: number,
    open: number,
    callee?: string,
  ): void => {
    const close = match[open];
    if (close < 0) return;
    if (close === open + 1) {
      report(site, from, close + 1, undefined, callee);
      return;
    }
    if (isPunct(open + 1, "...")) return;
    const argument = expressionAt(open + 1, false);
    if (!argument || argument.value.couldBeError) return;
    if (argument.end !== close && !isPunct(argument.end, ",")) return;
    report(site, open + 1, argument.end, argument.value, callee);
  };

  /** The reject parameter's name of the executor that starts at `i`, with the token range of its body. */
  const executorAt = (
    i: number,
    limit: number,
  ): { name: string; bodyStart: number; bodyEnd: number } | undefined => {
    let k = i;
    if (isWord(k, "async")) k++;
    let params: number;
    if (isWord(k, "function")) {
      k++;
      if (isPunct(k, "*")) k++;
      if (toks[k]?.kind === "identifier") k++;
      if (!isPunct(k, "(")) return undefined;
      params = k;
    } else if (isPunct(k, "(")) params = k;
    else return undefined;
    const paramsEnd = match[params];
    if (paramsEnd < 0) return undefined;
    // The second parameter, when it is a plain name (typed or not).
    let second = -1;
    let commas = 0;
    for (let j = params + 1; j < paramsEnd; j++) {
      if (match[j] > j) {
        j = match[j];
        continue;
      }
      if (isPunct(j, "<")) {
        const end = typeArgumentsEnd(j);
        if (end < 0) return undefined;
        j = end - 1;
        continue;
      }
      if (isPunct(j, ",")) {
        commas++;
        if (commas === 1) second = j + 1;
      }
    }
    if (second < 0 || toks[second]?.kind !== "identifier") return undefined;
    if (!(
      second + 1 === paramsEnd ||
      isPunct(second + 1, ",") ||
      isPunct(second + 1, ":")
    ))
      return undefined;
    const name = toks[second].value;
    let body = paramsEnd + 1;
    if (isPunct(body, ":")) {
      const end = typeEnd(body + 1);
      if (end < 0) return undefined;
      body = end;
    }
    if (isPunct(body, "=>")) body++;
    else if (!isPunct(body, "{")) return undefined;
    if (isPunct(body, "{")) {
      const end = match[body];
      if (end < 0) return undefined;
      return { name, bodyStart: body + 1, bodyEnd: end };
    }
    return { name, bodyStart: body, bodyEnd: limit };
  };

  /** Identifier token indexes by name, built when the first executor is found. */
  let byName: Map<string, number[]> | undefined;
  const occurrences = (name: string): number[] => {
    if (!byName) {
      byName = new Map();
      for (let i = 0; i < n; i++)
        if (toks[i].kind === "identifier") {
          const list = byName.get(toks[i].value);
          if (list) list.push(i);
          else byName.set(toks[i].value, [i]);
        }
    }
    return byName.get(name) ?? [];
  };
  const firstAtOrAfter = (list: number[], at: number): number => {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid] < at) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  /**
   * The executor's calls to its reject parameter, or none when the body
   * might declare the name again (a nested parameter, a `const`, a catch
   * binding, a reassignment): only a name that is clearly the parameter
   * counts.
   */
  const checkExecutor = (executor: {
    name: string;
    bodyStart: number;
    bodyEnd: number;
  }): void => {
    const list = occurrences(executor.name);
    const calls: number[] = [];
    for (
      let at = firstAtOrAfter(list, executor.bodyStart);
      at < list.length && list[at] < executor.bodyEnd;
      at++
    ) {
      const i = list[at];
      if (isMemberName(i)) continue;
      const previous = toks[i - 1];
      if (
        previous !== undefined &&
        previous.kind !== "string" &&
        previous.kind !== "template" &&
        ["const", "let", "var", "function", "class", "...", "catch"].includes(
          previous.value,
        )
      )
        return;
      if (isPunct(i - 1, "(") && isWord(i - 2, "catch")) return;
      const next = toks[i + 1];
      if (next?.kind === "punctuation") {
        if (next.value === "=>" || next.value === ":" || next.value === "?")
          return;
        if (ASSIGNMENT_OPERATORS.has(next.value)) return;
        if (next.value === "(") {
          const end = after(i + 1);
          // A method `reject() {}` declares the name.
          if (end < 0 || isPunct(end, "{")) return;
          calls.push(i);
          continue;
        }
      }
      // A plain read (`setTimeout(reject, 10)`, `.catch(reject)`), unless the
      // brackets around it are a parameter list or a destructuring pattern.
      const around = parent[i];
      if (around >= 0) {
        const end = after(around);
        if (
          end > 0 &&
          (isPunct(end, "=>") ||
            isPunct(end, "=") ||
            (toks[around].value === "(" &&
              (isPunct(end, "{") || isPunct(end, ":"))))
        )
          return;
      }
    }
    for (const call of calls)
      checkRejectCall("reject", call, call + 1, executor.name);
  };

  for (let i = 0; i < n; i++) {
    const tok = toks[i];
    if (tok.kind !== "identifier") continue;
    if (tok.value === "throw") {
      if (isMemberName(i)) continue;
      const next = i + 1;
      if (next >= n || lineBreakBefore(next)) continue;
      const nextTok = toks[next];
      if (
        nextTok.kind === "punctuation" &&
        [":", "?", ",", ";", "}", ")", "]", "=", ".", "?.", "=>", "<"].includes(
          nextTok.value,
        )
      )
        continue;
      if (isPunct(next, "!") && isPunct(next + 1, ":")) continue;
      // `throw(x) {}` is a method named throw; `throw (x)` throws x.
      if (isPunct(next, "(")) {
        const end = after(next);
        if (end < 0 || isPunct(end, "{") || isPunct(end, ":")) continue;
      }
      const expression = expressionAt(next, true);
      if (!expression || expression.value.couldBeError) continue;
      // The statement must end here, or this was not read right.
      const end = expression.end;
      if (
        end < n &&
        !isPunct(end, ";") &&
        !isPunct(end, "}") &&
        !lineBreakBefore(end)
      )
        continue;
      report("throw", next, end, expression.value);
    } else if (tok.value === "Promise" && !isMemberName(i)) {
      if (
        (isPunct(i + 1, ".") || isPunct(i + 1, "?.")) &&
        isWord(i + 2, "reject") &&
        (isPunct(i + 3, "(") || (isPunct(i + 3, "?.") && isPunct(i + 4, "(")))
      )
        checkRejectCall(
          "Promise.reject",
          i,
          isPunct(i + 3, "(") ? i + 3 : i + 4,
        );
      else if (isWord(i - 1, "new") && !isMemberName(i - 1)) {
        let open = i + 1;
        if (isPunct(open, "<")) {
          const end = typeArgumentsEnd(open);
          if (end < 0) continue;
          open = end;
        }
        if (!isPunct(open, "(") || match[open] < 0) continue;
        const executor = executorAt(open + 1, match[open]);
        if (executor) checkExecutor(executor);
      }
    }
  }
  return found;
}

/** The diagnostic message for a value `findNonErrorThrows` found. */
export function nonErrorThrowMessage(
  found: NonErrorThrow,
  sourceText: string,
): string {
  const shown =
    found.wrappable &&
    sourceText.length <= 60 &&
    !Array.from(sourceText).some((c) => isLineBreak(c.charCodeAt(0)))
      ? sourceText
      : '"..."';
  const why =
    "Only an Error carries a stack trace, so without one Bascik's error report cannot name this line.";
  const kind = found.value;
  if (found.site === "throw")
    return `Throw an Error, not ${kind}: throw new Error(${shown}). ${why}`;
  const call = found.site === "reject" ? found.callee! : "Promise.reject";
  if (kind === "")
    return `Pass ${call}() an Error: ${call}(new Error("...")). A rejection with no reason has no stack trace, so Bascik's error report cannot name this line.`;
  return `Reject with an Error, not ${kind}: ${call}(new Error(${shown})). ${why}`;
}
