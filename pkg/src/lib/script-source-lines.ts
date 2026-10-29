/**
 * @module script-source-lines
 *
 * Keeps DevTools line numbers for component scripts equal to the lines in the
 * component's source file.
 *
 * A component script reaches the browser as an inline `<script>` that ends in
 * `//# sourceURL=<component file>`. DevTools shows such a script as its own
 * file, and line 1 of that file is the text right after `<script>`. For line N
 * in DevTools to be line N of the component file, the script body has to be
 * pushed down by the number of lines above it in the source.
 *
 * That number cannot be read off the HTML that reaches the scoping pipeline:
 * by then inline `<style>` blocks are extracted, build scripts have run, and
 * the HTML may be minified, all of which move scripts. So the line is recorded
 * on the tag (`data-bascik-script-line`) as soon as the raw file is read, and
 * `namespaceScriptTags` turns it into newline padding and removes it.
 *
 * Separately, every instance of a component carries the same sourceURL.
 * DevTools keeps one file per URL, so only the last instance on a page could
 * be shown when paused. `numberInstanceSourceUrls` gives the second and later
 * instances their own URL (`?instance=2`, `?instance=3`, ...).
 */
import { ANY_DIRECTIVE_ATTR_NAME } from "./html-patterns.ts";
import {
  createNamedOpenTagScanner,
  openTagsOf,
  replaceSpans,
  scanAlternatives,
  type ScanAlternative,
} from "./element-content-scan.ts";
import { getScriptType, isJavaScriptScript } from "./script-types.ts";

/** Internal attribute: the source line the script's body starts on. Never reaches the output. */
export const SCRIPT_LINE_ATTRIBUTE = "data-bascik-script-line";

const DIRECTIVE_SCRIPT_RE = new RegExp(
  String.raw`\s${ANY_DIRECTIVE_ATTR_NAME}`,
  "i",
);
/**
 * A comment, or a whole script element. Comments come first so a script
 * written inside one is skipped. This is the regex
 * `<!--[\s\S]*?-->|(<script(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script(?:[\t\n\f\r /][^>]*)?>)`
 * (flags `gi`), scanned in linear time.
 */
const COMMENT_OR_SCRIPT: readonly ScanAlternative[] = [
  { kind: "comment" },
  {
    kind: "element",
    name: "script",
    options: { opener: "tag-space", closer: "attributes" },
  },
];
const SCRIPT_LINE_ATTR_RE = /\s+data-bascik-script-line="(\d+)"/i;

/** Scripts that end up in the browser with a sourceURL: classic, module, and `text/typescript` (stripped later). */
const getsSourceUrl = (openTag: string): boolean =>
  !DIRECTIVE_SCRIPT_RE.test(openTag) &&
  !/\s+src\s*=/i.test(openTag) &&
  (isJavaScriptScript(openTag) || getScriptType(openTag) === "text/typescript");

/** Adds the stamp to a script open tag (`<script ...>`). */
export const withScriptLine = (openTag: string, line: number): string =>
  openTag.replace(/>$/, ` ${SCRIPT_LINE_ATTRIBUTE}="${line}">`);

/**
 * Stamps every browser script in a raw component file with the line its body
 * starts on. Directive, external, and data scripts are left alone, as are
 * scripts written inside comments.
 */
export const stampScriptLines = (html: string): string => {
  if (!/<script\b/i.test(html)) return html;
  let line = 1;
  let counted = 0;
  let result = "";
  let cursor = 0;
  for (const match of scanAlternatives(html, COMMENT_OR_SCRIPT)) {
    if (match.alternative === 0) continue;
    const open = html.slice(match.start, match.contentStart);
    if (!getsSourceUrl(open) || SCRIPT_LINE_ATTR_RE.test(open)) continue;
    const bodyStart = match.contentStart;
    for (let index = counted; index < bodyStart; index++)
      if (html.charCodeAt(index) === 10) line++;
    counted = bodyStart;
    result += html.slice(cursor, match.start) + withScriptLine(open, line);
    cursor = bodyStart;
  }
  return cursor === 0 ? html : result + html.slice(cursor);
};

/** Splits the stamp off a script open tag. */
export const takeScriptLine = (
  openTag: string,
): { openTag: string; line: number | undefined } => {
  const match = SCRIPT_LINE_ATTR_RE.exec(openTag);
  if (!match) return { openTag, line: undefined };
  return {
    openTag: openTag.replace(SCRIPT_LINE_ATTR_RE, ""),
    line: Number(match[1]),
  };
};

/** Removes every stamp, for when script scoping is turned off. */
export const stripScriptLines = (html: string): string => {
  if (!html.includes(SCRIPT_LINE_ATTRIBUTE)) return html;
  // `/<script(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>/gi`, in linear time.
  return replaceSpans(
    html,
    openTagsOf(createNamedOpenTagScanner(html, "script")),
    (openTag) => takeScriptLine(openTag).openTag,
  );
};

/**
 * The newlines to put before a script body (and its IIFE wrapper) so the
 * body's first line lands on `sourceLine`. `leading` is the newline the
 * wrapper adds after `(function() {` when the body does not start with one;
 * it is dropped when the body starts on line 1, where there is no room for it.
 */
export const sourceLinePadding = (
  sourceLine: number | undefined,
  leading: string,
): { padding: string; leading: string } => {
  if (sourceLine === undefined) return { padding: "", leading };
  const lines = sourceLine - 1 - (leading ? 1 : 0);
  if (lines < 0) return { padding: "", leading: "" };
  return { padding: "\n".repeat(lines), leading };
};

/** The `//# sourceURL` line Bascik appends as the last line of a component script. */
const TRAILING_SOURCE_URL_RE = /(\n\/\/# sourceURL=)([^\n]*?)(<\/script)/gi;

/**
 * Gives the scripts of the `ordinal`-th instance of a component on a page
 * their own sourceURL. The first instance keeps the plain file path.
 */
export const numberInstanceSourceUrls = (
  html: string,
  ordinal: number,
): string => {
  if (ordinal < 2 || !html.includes("//# sourceURL=")) return html;
  return html.replace(
    TRAILING_SOURCE_URL_RE,
    (_match, prefix: string, url: string, close: string) =>
      `${prefix}${url}${url.includes("?") ? "&" : "?"}instance=${ordinal}${close}`,
  );
};
