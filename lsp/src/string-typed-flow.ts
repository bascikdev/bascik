/**
 * Where a template's value lands with a TypeScript `string` type: the
 * return of a function annotated `: string` (or `Promise<string>`, or a
 * union with string), a `const`, `let` or class field annotated `: string`,
 * an `as string` or `satisfies string`, or a local `const` that reaches one
 * of those. Wrapping such a template in html makes it a SafeHtml value, so
 * the "Wrap template in html`...`" fix would leave code that fails type
 * checking; the caller withholds the fix and names the annotation.
 *
 * The value is followed only through what keeps it whole: parentheses,
 * `? :`, `||`, `??`, `&&` and `await`. A template joined to a string with
 * `+`, passed to a call, or nested in another template stays a string (or
 * goes where this file cannot see), so those are not reported here.
 *
 * Every query is answered from the tokens with memos, so a file with many
 * templates in one long expression is read in linear time.
 */
import type { Token } from "./module-specifiers.js";

/** How many local `const` names deep a value is followed (`const a = tpl; const b = a; return b;`). */
const MAX_NAME_DEPTH = 4;
/** How many tokens before a `{` or `=>` a return type annotation is read. */
const MAX_ANNOTATION_TOKENS = 60;

/** Statement words that end an expression without passing its value on. */
const NO_FLOW_WORDS = new Set([
  "throw",
  "case",
  "yield",
  "else",
  "do",
  "in",
  "of",
  "extends",
  "export",
  "default",
  "typeof",
  "void",
  "delete",
  "instanceof",
]);
/** Words before `(` that make it a statement's head, not a call. */
const CONTROL_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
]);
/** Words before `(` that make it grouping parentheses, not a call. */
const OPERATOR_WORDS = new Set([
  "return",
  "await",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "case",
  "throw",
  "yield",
  "new",
  "instanceof",
]);
const DECLARATION_WORDS = new Set(["const", "let", "var"]);
const FIELD_PREFIX_WORDS = new Set([
  "readonly",
  "private",
  "protected",
  "public",
  "static",
  "declare",
  "override",
]);

/** Whether an annotation gives a value the string type, so a SafeHtml value would not fit. */
const isStringType = (annotation: string): boolean =>
  /\bstring\b/.test(annotation) && !/\bSafeHtml\b/.test(annotation);

/**
 * A checker for one script body: given a template's offsets, the `string`
 * annotation its value reaches (`: string`, `: Promise<string>`, `as
 * string`), or undefined. The tokens' bracket partners are found on the
 * first query, so files without a fixable template pay nothing.
 */
export function stringTypedFlow(
  body: string,
  tokens: readonly Token[],
): (start: number, end: number) => string | undefined {
  let ready = false;
  const n = tokens.length;
  let partner: Int32Array = new Int32Array(0);
  /** Each `const|let|var NAME: Type` declaration's annotation, by NAME. */
  const declared = new Map<string, string>();
  /** Identifier token indexes by name, for following a const to its uses. */
  const uses = new Map<string, number[]>();
  /** scanStart results by token index: one walk per stretch of tokens. */
  const scanMemo = new Map<number, string | null>();
  /** Each token's innermost open bracket, as a token index, or -1. */
  let enclosing: Int32Array = new Int32Array(0);
  /** The return annotation a `return` gets from the block that opens at a `{` index. */
  const returnMemo = new Map<number, string | null>();
  const nameMemo = new Map<string, string | null>();

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
  /** Whether tokens k and k + 1 touch (`=>`, `||`, `==`). */
  const touches = (k: number): boolean =>
    k >= 0 && k + 1 < n && tokens[k].end === tokens[k + 1].start;
  /** An arrow's `=` at k: `=` then `>` touching. */
  const isArrow = (k: number): boolean =>
    punct(k, "=") && punct(k + 1, ">") && touches(k);
  /** A plain assignment `=` at k (not `==`, `=>`, `<=`, `+=`, `||=`). */
  const isAssignment = (k: number): boolean => {
    if (!punct(k, "=")) return false;
    if (k + 1 < n && touches(k) && /^[=>]$/.test(tokens[k + 1].value))
      return false;
    if (
      k > 0 &&
      tokens[k - 1].type === "punctuation" &&
      touches(k - 1) &&
      /^[=!<>+\-*/%&|^?]$/.test(tokens[k - 1].value)
    )
      return false;
    return true;
  };

  const prepare = (): void => {
    ready = true;
    partner = new Int32Array(n).fill(-1);
    enclosing = new Int32Array(n).fill(-1);
    const stack: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = tokens[k];
      enclosing[k] = stack.length > 0 ? stack[stack.length - 1] : -1;
      if (t.type === "identifier") {
        const list = uses.get(t.value);
        if (list) list.push(k);
        else uses.set(t.value, [k]);
        continue;
      }
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
    for (let k = 1; k + 1 < n; k++)
      if (
        word(k) &&
        punct(k + 1, ":") &&
        word(k - 1) &&
        DECLARATION_WORDS.has(tokens[k - 1].value)
      ) {
        const end = annotationEnd(k + 1);
        if (end !== -1)
          declared.set(
            tokens[k].value,
            body.slice(tokens[k + 1].end, tokens[end].start).trim(),
          );
      }
  };

  /**
   * From a `:` at k that starts a variable's annotation: the index of the
   * `=`, `;` or `,` that ends it (brackets and type arguments skipped), or
   * -1 past MAX_ANNOTATION_TOKENS.
   */
  const annotationEnd = (k: number): number => {
    let angle = 0;
    for (let j = k + 1; j < n && j <= k + MAX_ANNOTATION_TOKENS; j++) {
      const t = tokens[j];
      if (t.type !== "punctuation") continue;
      const v = t.value;
      if (v === "(" || v === "[" || v === "{") {
        if (partner[j] === -1) return -1;
        j = partner[j];
      } else if (v === "<") angle++;
      else if (v === ">") {
        if (!isArrow(j - 1)) angle = Math.max(0, angle - 1);
      } else if (angle === 0 && (v === ";" || v === ",")) return j;
      else if (angle === 0 && v === "=" && !isArrow(j)) return j;
      else if (v === ")" || v === "]" || v === "}") return j;
    }
    return -1;
  };

  /**
   * The return type annotation just before a function body that starts at
   * token `b` (its `{`, or the token after `=>`): "" for a function with
   * none, undefined when `b` does not start a function body.
   */
  const returnAnnotationBefore = (b: number): string | undefined => {
    let p = b - 1;
    let bodyStartOffset = tokens[b]?.start ?? body.length;
    if (p >= 1 && punct(p, ">") && isArrow(p - 1)) {
      bodyStartOffset = tokens[p - 1].start;
      p -= 2;
    } else if (!punct(b, "{")) return undefined;
    if (punct(p, ")")) {
      const open = partner[p];
      if (open === -1) return undefined;
      return word(open - 1) && CONTROL_WORDS.has(tokens[open - 1].value)
        ? undefined
        : "";
    }
    // `): Type {` or `): Type =>`: a `:` at depth 0 right after `)`.
    let depth = 0;
    for (let q = p; q >= 0 && q >= p - MAX_ANNOTATION_TOKENS; q--) {
      const t = tokens[q];
      if (t.type !== "punctuation") continue;
      const v = t.value;
      if (v === ")" || v === "]" || v === "}" || v === ">") {
        if (v === ">" && isArrow(q - 1)) {
          q--;
          continue;
        }
        if (v !== ">" && partner[q] !== -1) {
          q = partner[q];
          continue;
        }
        depth++;
      } else if (v === "<") depth--;
      else if (v === "(" || v === "[" || v === "{") return undefined;
      else if (v === ";" || v === "=" || v === ",") return undefined;
      else if (v === ":" && depth === 0)
        return punct(q - 1, ")")
          ? body.slice(t.end, bodyStartOffset).trim()
          : undefined;
    }
    return undefined;
  };

  /**
   * The return annotation of the function a `return` at token r is in:
   * outward through blocks (`if (...) {`, `else {`, `try {`) to the first
   * function body; null for none or an unannotated function.
   */
  const returnTypeOf = (r: number): string | null => {
    let b = enclosing[r];
    const path: number[] = [];
    let result: string | null = null;
    while (b !== -1 && punct(b, "{")) {
      const known = returnMemo.get(b);
      if (known !== undefined) {
        result = known;
        break;
      }
      path.push(b);
      const annotation = returnAnnotationBefore(b);
      if (annotation !== undefined) {
        result = annotation === "" ? null : annotation;
        break;
      }
      // A block: `if (...) {`, `else {`, `try {`, a bare `{`.
      const before = b - 1;
      if (
        before < 0 ||
        punct(before, ")") ||
        punct(before, "{") ||
        punct(before, "}") ||
        punct(before, ";") ||
        word(before, "else") ||
        word(before, "try") ||
        word(before, "finally") ||
        word(before, "do")
      ) {
        b = enclosing[b];
        continue;
      }
      break;
    }
    for (const at of path) returnMemo.set(at, result);
    return result;
  };

  /** Where a value ends up from an assignment `=` at token e. */
  const assignmentTarget = (e: number, depth: number): string | null => {
    // `NAME: Type =` (a declaration or a class field).
    let angle = 0;
    for (let q = e - 1; q >= 0 && q >= e - MAX_ANNOTATION_TOKENS; q--) {
      const t = tokens[q];
      if (t.type !== "punctuation") continue;
      const v = t.value;
      if (v === ")" || v === "]" || v === "}") {
        if (partner[q] === -1) break;
        q = partner[q];
      } else if (v === ">") {
        if (isArrow(q - 1)) q--;
        else angle++;
      } else if (v === "<") angle--;
      else if (v === ":" && angle === 0) {
        if (
          word(q - 1) &&
          (q - 2 < 0 ||
            (word(q - 2) &&
              (DECLARATION_WORDS.has(tokens[q - 2].value) ||
                FIELD_PREFIX_WORDS.has(tokens[q - 2].value))) ||
            punct(q - 2, "{") ||
            punct(q - 2, "}") ||
            punct(q - 2, ";"))
        )
          return body.slice(t.end, tokens[e].start).trim();
        break;
      } else break;
    }
    if (!word(e - 1) || punct(e - 2, ".")) return null;
    const name = tokens[e - 1].value;
    const type = declared.get(name);
    if (type !== undefined) return type;
    // An untyped const or let: where its uses go.
    if (word(e - 2) && DECLARATION_WORDS.has(tokens[e - 2].value))
      return nameTarget(name, e - 1, depth + 1);
    return null;
  };

  /** The string annotation a local name's value reaches through any of its uses. */
  const nameTarget = (
    name: string,
    declaredAt: number,
    depth: number,
  ): string | null => {
    if (depth > MAX_NAME_DEPTH) return null;
    const known = nameMemo.get(name);
    if (known !== undefined) return known;
    nameMemo.set(name, null);
    let result: string | null = null;
    for (const k of uses.get(name) ?? []) {
      if (k === declaredAt || punct(k - 1, ".")) continue;
      // Read whole: not a member, a call, an index or an assignment target.
      if (
        punct(k + 1, ".") ||
        punct(k + 1, "(") ||
        punct(k + 1, "[") ||
        isAssignment(k + 1)
      )
        continue;
      const found = afterUnit(tokens[k].end) ?? leftFlow(k - 1, depth);
      if (found !== null && isStringType(found)) {
        result = found;
        break;
      }
    }
    nameMemo.set(name, result);
    return result;
  };

  /** `as Type` or `satisfies Type` right after a value ending at `end`. */
  const afterUnit = (end: number): string | null => {
    const m = /^\s*(?:as|satisfies)\s+([^;,)\]}\n]{1,200})/.exec(
      body.slice(end, end + 220),
    );
    return m && isStringType(m[1]) ? m[1].trim() : null;
  };

  /** The return annotation of an arrow whose `=` is at token a. */
  const arrowType = (a: number): string | null => {
    const annotation = returnAnnotationBefore(a + 2);
    return annotation ? annotation : null;
  };

  /**
   * Where a value goes, from the token just left of it (index `start`): an
   * annotation, or null when it goes nowhere this checker follows. Two
   * steps alternate in one loop, so parentheses and ternaries nested
   * thousands deep cannot overflow the stack:
   *
   * - left: the token before a value says where it goes (`return`, `=>`,
   *   `=`), or that it is an operand of `? :`, `||`, `??`, `&&` or `await`,
   *   or that the value is in grouping parentheses (then the group is the
   *   value);
   * - scan: for an operand, back over the rest of the expression at its
   *   depth to the token before it. Every scanned token's answer is stored,
   *   so each token is scanned once per script.
   */
  const leftFlow = (start: number, depth: number): string | null => {
    const visited: number[] = [];
    let result: string | null = null;
    let j = start;
    walk: for (;;) {
      // left
      if (j < 0) break;
      const t = tokens[j];
      let k: number;
      if (t.type === "identifier") {
        if (t.value === "return") {
          result = returnTypeOf(j);
          break;
        }
        if (t.value !== "await") break;
        k = j - 1;
      } else if (t.type !== "punctuation") break;
      else if (t.value === ">") {
        result = isArrow(j - 1) ? arrowType(j - 1) : null;
        break;
      } else if (t.value === "=") {
        result = isAssignment(j) ? assignmentTarget(j, depth) : null;
        break;
      } else if (t.value === "(") {
        // A call's or a statement head's `(` (`f(`, `if (`): the value
        // goes into the call or the condition.
        const before = j - 1;
        if (
          punct(before, ")") ||
          punct(before, "]") ||
          (word(before) && !OPERATOR_WORDS.has(tokens[before].value))
        )
          break;
        const close = partner[j];
        const after = close === -1 ? null : afterUnit(tokens[close].end);
        if (after !== null) {
          result = after;
          break;
        }
        j = before;
        continue;
      } else if (t.value === "?" || t.value === ":") k = j - 1;
      else if (
        (t.value === "|" || t.value === "&") &&
        punct(j - 1, t.value) &&
        touches(j - 1)
      )
        k = j - 2;
      else break;
      // scan
      for (;;) {
        if (k < 0) break walk;
        const known = scanMemo.get(k);
        if (known !== undefined) {
          result = known;
          break walk;
        }
        visited.push(k);
        const u = tokens[k];
        if (u.type === "identifier") {
          if (u.value === "return" || u.value === "await") {
            j = k;
            continue walk;
          }
          if (NO_FLOW_WORDS.has(u.value)) break walk;
          k--;
          continue;
        }
        if (u.type !== "punctuation") {
          k--;
          continue;
        }
        const v = u.value;
        if (v === ")" || v === "]" || v === "}") {
          if (partner[k] === -1) break walk;
          k = partner[k] - 1;
          continue;
        }
        if (v === "(") {
          j = k;
          continue walk;
        }
        if (v === "[" || v === "{" || v === "," || v === ";") break walk;
        if (v === ">" && isArrow(k - 1)) {
          result = arrowType(k - 1);
          break walk;
        }
        if (v === "=" && isAssignment(k)) {
          result = assignmentTarget(k, depth);
          break walk;
        }
        k--;
      }
    }
    for (const at of visited) scanMemo.set(at, result);
    return result;
  };

  /** The token index just left of `offset`, by binary search. */
  const tokenBefore = (offset: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid].end <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };

  return (start: number, end: number): string | undefined => {
    if (!ready) prepare();
    const after = afterUnit(end);
    if (after !== null) return after;
    const found = leftFlow(tokenBefore(start), 0);
    return found !== null && isStringType(found) ? found : undefined;
  };
}
