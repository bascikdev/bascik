export interface ApiRouteDiagnostic {
  /** The rule id, as shown by `bascik --check` and usable in `bascik-ignore` and `disabledRules`. */
  code:
    | "invalid-method-case"
    | "api-handler-return-type"
    | "missing-method-handler"
    | "api-unguarded-json";
  message: string;
  severity: "error" | "warning" | "info";
  range?: {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
  };
}

const VALID_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);
const METHOD_LIKE_REGEX =
  /\bexport\s+(?:async\s+)?(?:const|function|let|var)\s+([a-zA-Z0-9_$]+)\b/g;
/** `export { a, b as GET }` and `export { ... } from "..."`; `export type { ... }` exports no value. */
const EXPORT_CLAUSE_REGEX = /\bexport\s*(type\s*)?\{([^{}]*)\}/g;
/** `export * from "..."` may re-export any method; `export * as ns` exports one name. */
const STAR_EXPORT_REGEX = /\bexport\s*\*\s*from\b/;

/**
 * `text` with comments and the contents of strings and template text blanked to spaces, keeping every
 * offset and line break, so keywords and calls are only found in code. A template's `${...}` stays code.
 * One pass. A `/` starts a regex literal (whose body is blanked too) where an expression may begin: at
 * the start, after an operator or punctuator other than `)` and `]`, or after a keyword such as `return`.
 */
function maskCommentsAndStrings(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const templateBraceDepths: number[] = [];
  let braceDepth = 0;
  let i = 0;
  // The last character of code before `i` that is not whitespace or a comment, and where it is.
  let lastSignificant = "";
  let lastSignificantAt = -1;
  // A regex scan that met the end of its line marks the rest of that line as no place for one, so a
  // line of unclosed `/[` is scanned once, not once per slash.
  let noRegexBefore = -1;
  const regexMayStart = (): boolean => {
    if (i < noRegexBefore) return false;
    if (lastSignificantAt < 0 || REGEX_PRECEDERS.has(lastSignificant))
      return true;
    if (!/[\w$]/.test(lastSignificant)) return false;
    let start = lastSignificantAt;
    while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
    return REGEX_KEYWORDS.has(text.slice(start, lastSignificantAt + 1));
  };
  // Scans a regex literal from its opening `/`; returns the index after its flags, or -1 when the
  // line ends first (then the `/` was division after all).
  const scanRegex = (from: number): number => {
    let j = from + 1;
    let inClass = false;
    while (j < text.length && text[j] !== "\n") {
      const ch = text[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "/" && !inClass) {
        blank(from + 1, j);
        j++;
        while (j < text.length && /[a-z]/i.test(text[j])) j++;
        return j;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      j++;
    }
    noRegexBefore = j;
    return -1;
  };
  // Scans template text from `from`; returns the index after its closing backtick or `${`.
  const scanTemplate = (from: number): number => {
    let j = from;
    while (j < text.length) {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "`") {
        blank(from, j);
        return j + 1;
      } else if (text[j] === "$" && text[j + 1] === "{") {
        blank(from, j);
        templateBraceDepths.push(braceDepth);
        return j + 2;
      } else j++;
    }
    blank(from, text.length);
    return text.length;
  };
  while (i < text.length) {
    const c = text[i];
    const at = i;
    const regexEnd =
      c === "/" && text[i + 1] !== "/" && text[i + 1] !== "*" && regexMayStart()
        ? scanRegex(i)
        : -1;
    if (regexEnd > 0) {
      i = regexEnd;
    } else if (c === "/" && text[i + 1] === "/") {
      let end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
      blank(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n")
        j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, text.length));
      i = j + 1;
    } else if (c === "`") {
      i = scanTemplate(i + 1);
    } else if (c === "{") {
      braceDepth++;
      i++;
    } else if (c === "}") {
      if (templateBraceDepths.at(-1) === braceDepth) {
        templateBraceDepths.pop();
        i = scanTemplate(i + 1);
      } else {
        braceDepth--;
        i++;
      }
    } else i++;
    const commented =
      c === "/" && (text[at + 1] === "/" || text[at + 1] === "*");
    if (!commented && !/\s/.test(c)) {
      lastSignificant = text[i - 1] ?? c;
      lastSignificantAt = i - 1;
    }
  }
  return out.join("");
}

/** Characters after which a `/` begins a regex literal rather than dividing. */
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
/** Keywords after which a `/` begins a regex literal. */
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "of",
]);

/**
 * For each offset (ascending), whether it sits inside the block of a `try` statement in `code` (already
 * masked), from one pass that tracks which open braces belong to a `try`. A `catch` or `finally` block
 * does not guard, and neither does a `try` block that has closed.
 */
function insideTryBlocks(code: string, offsets: readonly number[]): boolean[] {
  const results: boolean[] = [];
  const frames: boolean[] = [];
  let tryFrames = 0;
  let next = 0;
  const tokenRe = /\btry\s*\{|[{}]/g;
  let token: RegExpExecArray | null;
  while (next < offsets.length) {
    token = tokenRe.exec(code);
    const at = token ? token.index : code.length;
    while (next < offsets.length && offsets[next] < at) {
      results.push(tryFrames > 0);
      next++;
    }
    if (!token) break;
    if (token[0] === "}") {
      if (frames.pop()) tryFrames--;
    } else {
      const isTry = token[0] !== "{";
      frames.push(isTry);
      if (isTry) tryFrames++;
    }
  }
  return results;
}

export function analyzeApiRouteSource(text: string): ApiRouteDiagnostic[] {
  const diagnostics: ApiRouteDiagnostic[] = [];
  const code = maskCommentsAndStrings(text);
  METHOD_LIKE_REGEX.lastIndex = 0;

  const exportedNames: string[] = [];
  let match: RegExpExecArray | null;

  // Warning: lowercase or mixed-case export that looks like a method (e.g. `post`, `Get`, `pOST`)
  const checkMethodCase = (name: string) => {
    const upper = name.toUpperCase();
    if (VALID_METHODS.has(upper) && name !== upper) {
      diagnostics.push({
        code: "invalid-method-case",
        message: `API route method export "${name}" must be uppercase ("${upper}"). Lowercase or mixed-case HTTP methods are not recognized by the dispatcher.`,
        severity: "warning",
      });
    }
  };

  EXPORT_CLAUSE_REGEX.lastIndex = 0;
  while ((match = EXPORT_CLAUSE_REGEX.exec(code)) !== null) {
    if (match[1]) continue;
    for (const specifier of match[2].split(",")) {
      const parts = specifier.trim().split(/\s+/);
      if (parts[0] === "type" && parts.length > 1) continue;
      const name =
        parts.length === 3 && parts[1] === "as" ? parts[2] : parts[0];
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      exportedNames.push(name);
      checkMethodCase(name);
    }
  }

  while ((match = METHOD_LIKE_REGEX.exec(code)) !== null) {
    const name = match[1];
    exportedNames.push(name);
    checkMethodCase(name);

    // Warning: handler whose return type is annotated and not Response / Promise<Response>
    // Check for pattern like: `export const GET = async (...): Promise<string> =>` or `export function GET(...): string`
    const lineStartIndex = text.lastIndexOf("\n", match.index) + 1;
    const lineEndIndex = text.indexOf("\n", match.index);
    const line = text.slice(
      lineStartIndex,
      lineEndIndex === -1 ? undefined : lineEndIndex,
    );

    const returnTypeMatch = line.match(
      /:\s*(?:Promise<([a-zA-Z0-9_$]+)>|([a-zA-Z0-9_$]+))\s*(?:=>|\{)/,
    );
    if (returnTypeMatch) {
      const returnType = returnTypeMatch[1] ?? returnTypeMatch[2];
      if (
        returnType &&
        returnType !== "Response" &&
        returnType !== "any" &&
        returnType !== "unknown"
      ) {
        diagnostics.push({
          code: "api-handler-return-type",
          message: `API route handler "${name}" has return type "${returnType}". Handlers must return a standard WHATWG Response (or Promise<Response>).`,
          severity: "warning",
        });
      }
    }
  }

  const hasRecognizedMethod =
    exportedNames.some((n) => VALID_METHODS.has(n)) ||
    STAR_EXPORT_REGEX.test(code);
  if (!hasRecognizedMethod) {
    diagnostics.push({
      code: "missing-method-handler",
      message: `API route file does not export any recognized HTTP method handler (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD).`,
      severity: "error",
    });
  }

  // Info diagnostic: request.json() or req.json() called outside a try block. Whole keywords and
  // braces in code only (comments and strings masked), so `entry` or a "try" string decides nothing.
  const jsonCalls = Array.from(
    code.matchAll(/\b(?:request|req)\.json\s*\(/g),
    (m) => m.index,
  );
  const guarded = insideTryBlocks(code, jsonCalls);
  for (const [callIndex, insideTry] of guarded.entries()) {
    if (!insideTry) {
      const callStart = jsonCalls[callIndex];
      const callEnd = code.indexOf("(", callStart);
      const lineStart = text.lastIndexOf("\n", callStart - 1) + 1;
      const line = (text.slice(0, callStart).match(/\n/g) ?? []).length;
      diagnostics.push({
        range: {
          startLine: line,
          startChar: callStart - lineStart,
          endLine: line,
          endChar: callEnd - lineStart,
        },
        code: "api-unguarded-json",
        message: `Calling request.json() without a surrounding try/catch will throw an unhandled error on malformed JSON payloads (resulting in a 500 response). Consider wrapping in a try/catch or validating input.`,
        severity: "info",
      });
    }
  }

  return diagnostics;
}
