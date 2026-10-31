/**
 * @module js-literal-spans
 * Where the string and template literals of a JavaScript source are, in one linear pass.
 *
 * Attribute scoping reads HTML that a script builds in its literals (`'<p class="note">'`,
 * `` html`<div id="panel">` ``), but script code around them is not markup: `count<max && ok`
 * is a comparison, not a `<max>` tag. Callers use these spans to scan only the literals.
 */
import {
  canStartRegexAfter,
  findTemplateLiteralEnd,
  REGEX_PRECEDING_KEYWORDS,
} from "./js-minifier.ts";

export interface JsLiteralSpan {
  /** Offset of the opening quote or backtick. */
  start: number;
  /** Offset just past the closing quote or backtick (or the end of an unterminated literal). */
  end: number;
}

const isIdentifierChar = (code: number): boolean =>
  (code >= 97 && code <= 122) ||
  (code >= 65 && code <= 90) ||
  (code >= 48 && code <= 57) ||
  code === 95 ||
  code === 36 ||
  code > 127;

/** Keywords whose parenthesized header is followed by a statement, not an operator. */
const CONTROL_HEADER_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "while",
  "for",
  "with",
]);

const isLineBreak = (c: string): boolean =>
  c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";

/** End of the quoted string at `start`; an unterminated string stops at its line break. */
const quotedStringEnd = (js: string, start: number): number => {
  const quote = js[start];
  let i = start + 1;
  while (i < js.length) {
    const c = js[i];
    if (c === "\\") {
      // `\` + CRLF is one line continuation, as a Windows checkout writes it.
      i += js[i + 1] === "\r" && js[i + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (isLineBreak(c)) return i;
    i++;
  }
  return js.length;
};

/** End of the regex literal at `start` (flags included); an unterminated one stops at its line break. */
const regexLiteralEnd = (js: string, start: number): number => {
  let i = start + 1;
  let inClass = false;
  while (i < js.length) {
    const c = js[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (isLineBreak(c)) return i;
    i++;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
  }
  while (i < js.length && isIdentifierChar(js.charCodeAt(i))) i++;
  return i;
};

/**
 * The string (`'...'`, `"..."`) and template (`` `...` ``, `${}` parts included) literals of
 * `js`, in source order. Comments and regex literals are skipped so quotes inside them do not
 * open a literal. A `/` is a regex where an expression may start (after an operator, `(`,
 * `,`, a keyword such as `return` or `else`, or at the start), and a division after a value,
 * `)`, `]`, `}` or a postfix update. That is the rule the built-in minifier applies inside a
 * template's `${}` expressions, plus its statement-level rule for the `)` that closes an
 * `if`/`while`/`for`/`with` header: a statement follows, so a `/` there is a regex. After `}`
 * the minifier's statement scan tries a regex that closes on the same line (a block can end
 * there); this scan reads a division.
 */
export const findJsLiteralSpans = (js: string): JsLiteralSpan[] => {
  const spans: JsLiteralSpan[] = [];
  // "" (start), "value", a keyword from REGEX_PRECEDING_KEYWORDS, "header)", or a punctuator.
  let lastToken = "";
  // Whether the last token was a bare `if`/`while`/`for`/`with`, and for each open `(`,
  // whether it opened such a header.
  let afterControlKeyword = false;
  const openParens: boolean[] = [];
  let i = 0;
  while (i < js.length) {
    const c = js[i];
    const code = js.charCodeAt(i);
    if (code <= 32 || c === "\u00a0" || c === "\ufeff" || isLineBreak(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = quotedStringEnd(js, i);
      spans.push({ start: i, end });
      i = end;
      lastToken = "value";
      afterControlKeyword = false;
      continue;
    }
    if (c === "`") {
      const end = findTemplateLiteralEnd(js, i);
      spans.push({ start: i, end });
      i = end;
      lastToken = "value";
      afterControlKeyword = false;
      continue;
    }
    if (c === "/") {
      const next = js[i + 1];
      if (next === "/") {
        i += 2;
        while (i < js.length && !isLineBreak(js[i])) i++;
        continue;
      }
      if (next === "*") {
        const close = js.indexOf("*/", i + 2);
        i = close === -1 ? js.length : close + 2;
        continue;
      }
      afterControlKeyword = false;
      if (canStartRegexAfter(lastToken)) {
        i = regexLiteralEnd(js, i);
        lastToken = "value";
        continue;
      }
      lastToken = "/";
      i++;
      continue;
    }
    if (isIdentifierChar(code)) {
      const wordStart = i++;
      while (i < js.length && isIdentifierChar(js.charCodeAt(i))) i++;
      const word = js.slice(wordStart, i);
      // `a.return / 2` divides a property, so only a bare keyword allows a regex.
      const bare = js[wordStart - 1] !== ".";
      lastToken = REGEX_PRECEDING_KEYWORDS.has(word) && bare ? word : "value";
      afterControlKeyword = bare && CONTROL_HEADER_KEYWORDS.has(word);
      continue;
    }
    if (c === "(") {
      openParens.push(afterControlKeyword);
      afterControlKeyword = false;
      lastToken = c;
      i++;
      continue;
    }
    afterControlKeyword = false;
    if (c === ")") {
      // `if (a) /re/` starts a statement after the header; `f(a) / 2` divides.
      lastToken = openParens.pop() ? "header)" : c;
      i++;
      continue;
    }
    if ((c === "+" || c === "-") && js[i + 1] === c) {
      // Postfix after a value, prefix otherwise; a prefix update is followed by an operand.
      lastToken =
        lastToken === "value" || lastToken === ")" || lastToken === "]"
          ? c + c
          : c;
      i += 2;
      continue;
    }
    lastToken = c;
    i++;
  }
  return spans;
};
