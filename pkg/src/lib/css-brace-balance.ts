/**
 * @module css-brace-balance
 * Finds the first unbalanced `{` or `}` in a stylesheet.
 *
 * Every component's CSS is joined into one page stylesheet, so a missing `}`
 * in one component nests every later component's rules inside its last rule,
 * and a stray `}` makes the browser drop the rule after it. The build stops
 * on either, naming the line, instead of shipping CSS that breaks another
 * component.
 *
 * Braces inside strings, comments, escapes (`\{`), and unquoted `url(...)`
 * are text, not blocks. One pass, so the scan is linear in the input. An
 * unclosed string ends at its line break and an unclosed comment or `url(`
 * at the end of the input, as the CSS Syntax tokenizer reads them.
 *
 * `lsp/src/css-brace-balance.ts` is a copy for the language server and
 * `bascik --check`; keep the two identical.
 */

export interface CssBraceImbalance {
  /** `unclosed`: a `{` that is never closed. `stray`: a `}` with nothing open. */
  kind: "unclosed" | "stray";
  /** Offset of the offending brace in the input. */
  offset: number;
}

const isNameCode = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 45 ||
  code === 95 ||
  code >= 128;

/** Whether `css` has an unquoted `url(` starting at `i` (any case, not part of a longer name). */
const unquotedUrlAt = (css: string, i: number): boolean => {
  if (
    (css.charCodeAt(i) | 32) !== 117 ||
    (css.charCodeAt(i + 1) | 32) !== 114 ||
    (css.charCodeAt(i + 2) | 32) !== 108 ||
    css[i + 3] !== "("
  )
    return false;
  if (i > 0 && isNameCode(css.charCodeAt(i - 1))) return false;
  let j = i + 4;
  while (j < css.length && /\s/.test(css[j])) j++;
  return css[j] !== '"' && css[j] !== "'";
};

/**
 * The first brace that does not balance, or `undefined` when every `{` has
 * its `}`. A stray `}` is reported where it occurs; otherwise the outermost
 * `{` left open at the end.
 */
export const findCssBraceImbalance = (
  css: string,
): CssBraceImbalance | undefined => {
  const open: number[] = [];
  const length = css.length;
  let i = 0;
  while (i < length) {
    const ch = css[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      i = close < 0 ? length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < length) {
        const c = css[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === ch) {
          i++;
          break;
        }
        if (c === "\n" || c === "\r" || c === "\f") break;
        i++;
      }
      continue;
    }
    if (unquotedUrlAt(css, i)) {
      i += 4;
      while (i < length && css[i] !== ")") i += css[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "{") open.push(i);
    else if (ch === "}") {
      if (open.length === 0) return { kind: "stray", offset: i };
      open.pop();
    }
    i++;
  }
  return open.length > 0 ? { kind: "unclosed", offset: open[0] } : undefined;
};

/** What is wrong and the one-line fix, shared by the build error and the editor diagnostic. */
export const cssBraceImbalanceMessage = (
  imbalance: CssBraceImbalance,
): string =>
  imbalance.kind === "unclosed"
    ? `This "{" is never closed, so every rule after it, including other components' rules in the page stylesheet, would be nested inside it. Add the missing "}".`
    : `This "}" closes no block, so the browser would drop the rule after it. Remove the "}", or add the "{" it was meant to close.`;
