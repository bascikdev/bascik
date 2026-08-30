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
  const { css: shielded, restore } = shieldCssStrings(removeCommentsFromCss(css));
  const minified = shielded
    .replace(/\n/g, " ")
    .replace(/\s\s+/g, " ")
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .trim();
  return restore(minified);
};
