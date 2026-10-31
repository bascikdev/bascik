/**
 * @module css-minifier
 * Built-in lightweight, safe CSS minifier for Bascik.
 *
 * Strips CSS comments, collapses whitespace, and removes spaces around structural
 * characters ({}, :, ;, ,) while preserving string literals and url() contents verbatim.
 */

import { shieldCssStrings, removeCommentsFromCss } from "./styles.ts";

/**
 * Minify a CSS string: strip comments, collapse whitespace, and remove
 * spaces around structural characters (`{`, `}`, `:`, `;`, `,`).
 *
 * String literals and `url()` contents are preserved verbatim — whitespace
 * and punctuation inside them (e.g. `content: "a: b; c"`, `[title="a  b"]`,
 * `url(data:...)`) is never altered.
 */
export const minifyCss = (css: string): string => {
  const { css: shielded, restore } = shieldCssStrings(
    removeCommentsFromCss(css),
  );
  const minified = shielded
    // CSS Syntax preprocessing: CRLF, a lone CR and FF are each one newline,
    // so a CRLF after a hex escape is the escape's one whitespace, not two.
    .replace(/\r\n?|\f/g, () => "\n")
    .replace(/\n/g, " ")
    // A hex escape consumes the one whitespace after it (`.\31  p` is the
    // class `1` and a descendant `p`), so a run after one keeps two spaces:
    // the escape's and the combinator's. Six digits end an escape, so a
    // longer hex run is text and its spaces collapse as usual.
    .replace(
      /(\\[0-9a-fA-F]{1,6}(?![0-9a-fA-F]))?\s\s+/g,
      (_match, hexEscape: string | undefined) =>
        hexEscape === undefined ? " " : `${hexEscape}  `,
    )
    // Preserve the single space in an empty CSS custom property declaration
    // (`--empty: ;` or `--empty: }`) per CSS Custom Properties Level 1.
    .replace(/(?<!-)--([\w-]+)\s*:\s+(?=[;}])/g, "--$1: ")
    .replace(/\s*([{};,])\s*/g, "$1")
    .replace(/:\s+/g, ":")
    // A space before `:` is a descendant combinator in a selector (`.a :hover`,
    // `.a :is(h2)`), so only strip it in a declaration. Selector context is
    // where a `{` comes before the next `;` or `}`.
    .replace(/\s+:(?![^;{}]*\{)/g, ":")
    .replace(/(?<!-)--([\w-]+):(?=[;}])/g, "--$1: ")
    .trim();
  return restore(minified);
};
