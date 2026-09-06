/**
 * @module css-tokenizer
 * Protects literal CSS regions from regex-based syntax rewrites.
 *
 * Bascik's CSS scoping transforms are regex-based. A bare `#id`/`url(#id)`
 * regex cannot tell a genuine ID selector (or URL fragment reference) from
 * incidental hash text inside a string literal:
 *
 *   a[href="#tab"] { color: red; }              // value of an attribute selector
 *   .icon::before { content: "url(#local)"; }   // generated-content string
 *
 * `maskCssSyntax` hides every region whose text must never be treated as CSS
 * syntax, replacing it with a unique collision-safe token (via
 * `createContentShield`). The token contains `\x00`, which the existing regex
 * transforms never match, so tokens flow through untouched and `restore`
 * splices the original bytes back after the transform runs.
 *
 * Hidden regions:
 *
 *   - quoted string literals (single and double, with escape handling)
 *   - CSS comments (slash-star ... star-slash)
 *   - the interior of bracketed attribute selectors (`[attr="..."]`)
 *
 * When `keepUrlArguments` is true (default), quoted arguments of a genuine
 * `url("#id")` function stay live so the URL-fragment pass can still scope
 * them (`fill: url("#grad")` rewrites, `content: "url(#local)"` stays). The
 * ID-selector transform passes `keepUrlArguments: false` so `url(...)`
 * arguments are masked like any other string there.
 */

import { createContentShield } from "./shielding.ts";

export type MaskCssSyntaxOptions = {
  /** When true (default), keep `url("…")`/`url('…')` arguments as live syntax. */
  keepUrlArguments?: boolean;
};

/** True when an odd number of unescaped backslashes precede `index`. */
const hasOddBackslashes = (css: string, index: number): boolean => {
  let count = 0;
  let i = index - 1;
  while (i >= 0 && css[i] === "\\") {
    count++;
    i--;
  }
  return count % 2 === 1;
};

/** True when the char at `index` is the start of a CSS comment. */
const isCssCommentStart = (css: string, index: number): boolean =>
  css.startsWith("/*", index);

/** True when `index` is a quote that begins a live `url("…")` argument. */
const isUrlArgumentQuote = (css: string, index: number): boolean =>
  // Anchoring to the end means the `url(` must be the last consumer before
  // the quote (allowing interleaved whitespace).
  /url\(\s*$/i.test(css.slice(Math.max(0, index - 16), index));

/** Find the end of a string starting at `start` (inclusive of its quote). */
const scanStringEnd = (css: string, start: number, quote: string): number => {
  for (let i = start + 1; i < css.length; i++) {
    if (css[i] === quote && !hasOddBackslashes(css, i)) return i;
  }
  return -1;
};

/** Find the `]` that closes the bracket opened before `afterIndex`. */
const findClosingBracket = (css: string, afterIndex: number): number => {
  let quote: string | null = null;
  let inComment = false;
  let depth = 0;
  for (let i = afterIndex; i < css.length; i++) {
    const ch = css[i];
    if (inComment) {
      if (css[i - 1] === "*" && ch === "/") inComment = false;
      continue;
    }
    if (quote) {
      if (ch === quote && !hasOddBackslashes(css, i)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      depth++;
      continue;
    }
    if (ch === "]") {
      if (depth === 0) return i;
      depth--;
      continue;
    }
    if (isCssCommentStart(css, i)) {
      inComment = true;
      i += 1;
    }
  }
  return -1;
};

/** A half-open region of `css` to preserve byte-for-byte. */
type Region = { start: number; end: number };

/**
 * Hide every region of `css` that must not be treated as CSS syntax, replacing
 * each with a collision-safe token. `restore` splices the original bytes back
 * into the (possibly rewritten) string.
 */
export const maskCssSyntax = (
  css: string,
  options: MaskCssSyntaxOptions = {},
): { masked: string; restore: (s: string) => string } => {
  const keepUrlArguments = options.keepUrlArguments ?? true;
  const regions: Region[] = [];
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (isCssCommentStart(css, i)) {
      const end = css.indexOf("*/", i + 2);
      const close = end === -1 ? css.length : end + 2;
      regions.push({ start: i, end: close });
      i = close;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const isUrlArg = keepUrlArguments && isUrlArgumentQuote(css, i);
      if (isUrlArg) {
        // Leave the whole real url("...") argument live so its fragment can
        // still be scoped. Skip past the closing quote.
        const end = scanStringEnd(css, i, ch);
        i = end === -1 ? css.length : end + 1;
        continue;
      }
      const end = scanStringEnd(css, i, ch);
      const close = end === -1 ? css.length : end + 1;
      regions.push({ start: i, end: close });
      i = close;
      continue;
    }
    i++;
  }
  // Attribute-selector interiors are literal; mask them too.
  for (let j = 0; j < css.length; j++) {
    if (css[j] !== "[" || regionCovers(regions, j)) continue;
    const close = findClosingBracket(css, j + 1);
    if (close === -1) continue;
    regions.push({ start: j, end: close + 1 });
    j = close;
  }

  // Sort and merge so non-overlapping tokens never nest.
  regions.sort((a, b) => a.start - b.start);
  const merged: Region[] = [];
  for (const region of regions) {
    const last = merged[merged.length - 1];
    if (last && region.start < last.end) {
      last.end = Math.max(last.end, region.end);
    } else {
      merged.push({ ...region });
    }
  }

  const shield = createContentShield(css);
  let masked = css;
  for (let k = merged.length - 1; k >= 0; k--) {
    const { start, end } = merged[k];
    const content = css.slice(start, end);
    masked =
      masked.slice(0, start) + shield.hide(content) + masked.slice(end);
  }
  return { masked, restore: shield.restore };
};

/** True when any region already covers `index`. */
const regionCovers = (regions: Region[], index: number): boolean =>
  regions.some((region) => region.start <= index && index < region.end);