/**
 * @module js-literal-spans
 * Where the string and template literals of a JavaScript source are, in one linear pass.
 *
 * Attribute scoping reads HTML that a script builds in its literals (`'<p class="note">'`,
 * `` html`<div id="panel">` ``), but script code around them is not markup: `count<max && ok`
 * is a comparison, not a `<max>` tag. Callers use these spans to scan only the literals.
 */
import { findTemplateLiteralEnd } from "./js-minifier.ts";

export interface JsLiteralSpan {
  /** Offset of the opening quote or backtick. */
  start: number;
  /** Offset just past the closing quote or backtick (or the end of an unterminated literal). */
  end: number;
}

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "yield",
  "await",
  "delete",
  "typeof",
  "void",
  "default",
  "in",
  "of",
  "instanceof",
  "new",
  "do",
  "else",
]);

const isIdentifierChar = (code: number): boolean =>
  (code >= 97 && code <= 122) ||
  (code >= 65 && code <= 90) ||
  (code >= 48 && code <= 57) ||
  code === 95 ||
  code === 36 ||
  code > 127;

const isLineBreak = (c: string): boolean =>
  c === "\n" || c === "\r" || c === " " || c === " ";

/** End of the quoted string at `start`; an unterminated string stops at its line break. */
const quotedStringEnd = (js: string, start: number): number => {
  const quote = js[start];
  let i = start + 1;
  while (i < js.length) {
    const c = js[i];
    if (c === "\\") {
      i += 2;
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
 * `,`, a keyword such as `return`, or at the start), and a division after a value, `)`, `]`,
 * `}` or a postfix update, the same rule the built-in minifier uses.
 */
export const findJsLiteralSpans = (js: string): JsLiteralSpan[] => {
  const spans: JsLiteralSpan[] = [];
  // "" (start), "value", a keyword from REGEX_PRECEDING_KEYWORDS, or a punctuator.
  let lastToken = "";
  let i = 0;
  while (i < js.length) {
    const c = js[i];
    const code = js.charCodeAt(i);
    if (code <= 32 || c === " " || c === "﻿" || isLineBreak(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = quotedStringEnd(js, i);
      spans.push({ start: i, end });
      i = end;
      lastToken = "value";
      continue;
    }
    if (c === "`") {
      const end = findTemplateLiteralEnd(js, i);
      spans.push({ start: i, end });
      i = end;
      lastToken = "value";
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
      const regexAllowed =
        lastToken === "" ||
        REGEX_PRECEDING_KEYWORDS.has(lastToken) ||
        !["value", ")", "]", "}", "++", "--"].includes(lastToken);
      if (regexAllowed) {
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
      lastToken =
        REGEX_PRECEDING_KEYWORDS.has(word) && js[wordStart - 1] !== "."
          ? word
          : "value";
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
