/**
 * @module html-minifier
 * Built-in lightweight, safe HTML minifier for Bascik.
 *
 * Strips HTML comments, collapses redundant whitespace while preserving
 * whitespace between inline HTML elements, and consolidates script tags at
 * the end of the output. Content whose whitespace matters is kept verbatim:
 * `<pre>` and `<listing>` content, raw text and RCDATA element bodies
 * (`<script>`, `<style>`, `<textarea>`, `<xmp>`, `<noscript>`, ...), SVG and
 * MathML `<script>` and `<style>`, attribute values, and comments, DOCTYPEs,
 * and CDATA sections. Only HTML whitespace is touched, never U+00A0 or other
 * Unicode spaces.
 *
 * Every decision comes from the spec-following scan in html-scanner.ts,
 * never from a regex over the raw document: removing or moving only what the
 * browser parses as a comment or script keeps every script that ran running,
 * and never makes text or dead markup run.
 *
 * Known limits, inherent to minifying HTML without its CSS:
 * - Whitespace is collapsed in any element that is not `<pre>` or
 *   `<listing>`, so an element styled `white-space: pre` (or `pre-wrap`,
 *   `pre-line`, `break-spaces`) loses its extra spaces and line breaks.
 * - Whitespace between two tags is kept as one space only when both are
 *   inline elements by default (`INLINE_TAGS`); elsewhere it is removed. An
 *   element made inline with CSS can lose the space next to it.
 * - Where the scan cannot follow the browser's parse of malformed markup
 *   (see html-scanner.ts), the rest of the document is left as written.
 */

import {
  readQuotedValueRanges,
  readStartTagAttributes,
  removeHtmlRanges,
  scanHtml,
  type HtmlRange,
  type HtmlToken,
  type TagAttribute,
} from "./html-scanner.ts";

const DIRECTIVE_ATTRIBUTES = new Set(["data-bascik-build", "data-bascik-server", "data-bascik-routes", "data-bascik-stream"]);

/** JavaScript MIME type essences (WHATWG MIME Sniffing). */
const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript",
]);

type ScriptKind = "classic" | "module" | "processed" | "inert";

/**
 * How the browser treats a script, from its tokenized attributes (WHATWG
 * "prepare the script element"): a classic or module script runs; an import
 * map or speculation rules are processed in place; any other type is a data
 * block. Bascik directive scripts never reach the browser as written.
 */
const scriptKind = (attributes: TagAttribute[]): ScriptKind => {
  if (attributes.some((attribute) => DIRECTIVE_ATTRIBUTES.has(attribute.name))) return "inert";
  // The tokenizer drops repeated attributes, so the first one counts.
  const type = attributes.find((attribute) => attribute.name === "type");
  const language = attributes.find((attribute) => attribute.name === "language");
  let typeString: string;
  if (type ? type.value === "" : !language || language.value === "") typeString = "text/javascript";
  else if (type) typeString = type.value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  else typeString = `text/${language!.value}`;
  const lower = typeString.toLowerCase();
  if (JAVASCRIPT_MIME_TYPES.has(lower)) return "classic";
  if (lower === "module") return "module";
  if (lower === "importmap" || lower === "speculationrules") return "processed";
  return "inert";
};

interface MinificationPlan {
  /** The document without its comments and hoisted scripts. */
  remainder: string;
  /** Hoisted script elements, verbatim, in document order. */
  scripts: string[];
  /** Where in `remainder` the hoisted scripts still run when placed. */
  insertAt: number;
}

/**
 * Decide, from one spec-following scan of the original document, which
 * comments to drop and which scripts to hoist.
 *
 * - Comments are dropped everywhere except inside `<pre>`, whose content stays
 *   verbatim. Comment-like text in raw text or RCDATA (a `<script>` or
 *   `<style>` body, `<textarea>`, `<title>`, `<noscript>`) is not a comment.
 * - Ordinary JavaScript scripts are hoisted. Scripts inside `<template>` (inert
 *   until cloned), SVG or MathML (parsed differently), or `<pre>` stay where
 *   they are, as does anything after the point the scan cannot follow.
 *   Execution order is kept: a script that is processed in place (one of
 *   those, or an import map) keeps every earlier script before it, so those
 *   are not hoisted either. Data blocks and Bascik directive scripts stay put
 *   and do not affect order.
 * - Hoisted scripts are placed at the end, unless the document ends inside
 *   markup where an appended script would not run, such as an unclosed tag,
 *   comment, `<template>`, or `<textarea>`. They then go just before it.
 */
const planMinification = (htmlString: string): MinificationPlan => {
  const removals: (HtmlRange & { separate: boolean })[] = [];
  const candidates: (HtmlRange & { separate: boolean })[] = [];
  /** End of the last script that runs where it stands; nothing before it may move after it. */
  let keepBefore = 0;
  const { insertionPoint } = scanHtml(htmlString, {
    // In a table, a comment or script keeps the text runs around it apart,
    // which decides what text moves before the table; an empty comment stands in.
    comment(comment) {
      if (!comment.inPre) removals.push({ start: comment.start, end: comment.end, separate: comment.inTable });
    },
    script(script) {
      // A script cut off by the end of the input never runs; it stays as is.
      if (script.inTemplate || !script.terminated) return;
      const kind = scriptKind(readStartTagAttributes(htmlString, script.start));
      if (kind === "inert") return;
      if ((kind === "classic" || kind === "module") && !script.inForeign && !script.inPre) {
        candidates.push({ start: script.start, end: script.end, separate: script.inTable });
      }
      else keepBefore = Math.max(keepBefore, script.end);
    },
  });
  const hoisted = candidates.filter((script) => script.start >= keepBefore);
  const { html, index } = removeHtmlRanges(htmlString, [...removals, ...hoisted], insertionPoint);
  return { remainder: html, scripts: hoisted.map((script) => htmlString.slice(script.start, script.end)), insertAt: index };
};

export const extractScriptTags = (htmlString: string): string =>
  planMinification(htmlString).scripts.join("\n");

export const INLINE_TAGS = new Set([
  "a",

  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "button",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "img",
  "input",
  "kbd",
  "label",
  "mark",
  "meter",
  "output",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "select",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "textarea",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);

/**
 * Whitespace the CSS white space rules collapse in rendered text: spaces,
 * tabs, and line breaks (the HTML parser turns CR into LF). Runs of two or
 * more, and every line break, become one space. Form feeds, U+00A0, and other
 * Unicode spaces are content and stay.
 */
const TEXT_WHITESPACE_RE = /[\t\n\r ]{2,}|[\n\r]/g;
const TEXT_WHITESPACE_ONLY_RE = /^[\t\n\r ]+$/;
/** HTML ASCII whitespace, which separates the parts of a tag. */
const TAG_WHITESPACE_RE = /[\t\n\f\r ]{2,}|[\n\r]/g;
const HAS_TAG_WHITESPACE_RE = /[\t\n\f\r ]{2}|[\n\r]/;

const collapseText = (text: string): string => text.replace(TEXT_WHITESPACE_RE, " ");

/** Collapse whitespace between the parts of a tag, leaving quoted values as written. */
const collapseTag = (html: string, start: number, end: number): string => {
  const tag = html.slice(start, end);
  if (!HAS_TAG_WHITESPACE_RE.test(tag)) return tag;
  const values = readQuotedValueRanges(html, start);
  let out = "";
  let cursor = start;
  for (let k = 0; k < values.length; k += 2) {
    out += html.slice(cursor, values[k]).replace(TAG_WHITESPACE_RE, " ") + html.slice(values[k], values[k + 1]);
    cursor = values[k + 1];
  }
  return out + html.slice(cursor, end).replace(TAG_WHITESPACE_RE, " ");
};

/** HTML formatting elements, which the parser re-creates after they are implicitly closed. */
const FORMATTING_ELEMENTS = new Set([
  "a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u",
]);

/** Tags and other complete markup end with `>` and start with `<`. */
const isMarkupToken = (token: HtmlToken | undefined): token is HtmlToken =>
  token !== undefined && (token.kind === "tag" || token.kind === "markup");

const isInlineTag = (token: HtmlToken): boolean => token.kind === "tag" && INLINE_TAGS.has(token.name);

interface CollapsedHtml {
  html: string;
  /** Output index of the token that started at the requested split, or the output length. */
  split: number;
  /**
   * Whitespace added or removed at `split` could change the page: it is
   * `<pre>` content there, or a formatting element may be open, which text
   * makes the parser re-create.
   */
  keepWhitespaceAtSplit: boolean;
}

/**
 * Collapse whitespace in `html`, following its tokens: text outside `<pre>`
 * is collapsed, whitespace-only text between two tags becomes one space when
 * both are inline elements and nothing otherwise, and tags collapse outside
 * their quoted values. Everything else is kept verbatim. `splitAt` must be a
 * token start in `html`; its output position is returned as `split`.
 *
 * While a formatting element (`<b>`, `<a>`, ...) may be open, whitespace
 * between tags is kept as one space instead. Text makes the parser re-create
 * formatting elements that a misnested end tag closed implicitly, so removing
 * it there could change which elements end up inside them.
 */
const collapseWhitespace = (html: string, splitAt = html.length): CollapsedHtml => {
  const tokens: HtmlToken[] = [];
  scanHtml(html, { token: (token) => tokens.push(token) });
  const parts: string[] = [];
  let length = 0;
  let split = -1;
  let preAtSplit = false;
  let formattingAtSplit = false;
  /**
   * Formatting start tags not yet matched by an end tag of the same name. An
   * overcount only keeps a space; an end tag with no match is ignored, as the
   * parser ignores it.
   */
  const formattingByName = new Map<string, number>();
  let openFormatting = 0;
  const write = (text: string): void => {
    parts.push(text);
    length += text.length;
  };
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (split === -1 && token.start >= splitAt) {
      split = length;
      formattingAtSplit = openFormatting > 0;
    }
    const source = html.slice(token.start, token.end);
    if (token.kind === "tag") {
      if (FORMATTING_ELEMENTS.has(token.name) && !token.inForeign) {
        const count = formattingByName.get(token.name) ?? 0;
        if (!token.isEndTag) {
          formattingByName.set(token.name, count + 1);
          openFormatting++;
        } else if (count > 0) {
          formattingByName.set(token.name, count - 1);
          openFormatting--;
        }
      }
      write(collapseTag(html, token.start, token.end));
    } else if (token.kind === "raw") {
      // `document.title` strips and collapses whitespace itself; every other
      // raw text or RCDATA body is code, data, or preformatted text.
      write(token.name === "title" && !token.inPre && !token.inForeignCode ? collapseText(source) : source);
    } else if (token.kind !== "text") {
      write(source);
    } else if (token.inPre || token.inForeignCode) {
      write(source);
    } else if (TEXT_WHITESPACE_ONLY_RE.test(source) && isMarkupToken(tokens[k - 1]) && isMarkupToken(tokens[k + 1])) {
      write(openFormatting > 0 || (isInlineTag(tokens[k - 1]) && isInlineTag(tokens[k + 1])) ? " " : "");
    } else {
      write(collapseText(source));
    }
    // Each token carries the context at its end, so the last one before the split gives it there.
    if (split === -1) preAtSplit = token.inPre;
  }
  if (split === -1) formattingAtSplit = openFormatting > 0;
  return {
    html: parts.join(""),
    split: split === -1 ? length : split,
    keepWhitespaceAtSplit: preAtSplit || formattingAtSplit,
  };
};

/** Space, tab, LF, CR: the whitespace that renders as nothing at a line's edges. */
const isCollapsibleWhitespace = (code: number): boolean => code === 32 || code === 10 || code === 9 || code === 13;

/**
 * Trim collapsible whitespace from both ends. A form feed, U+00A0, or other
 * Unicode space is content and stays.
 */
const trimCollapsibleWhitespace = (text: string, trimEnd = true): string => {
  let start = 0;
  let end = text.length;
  while (start < end && isCollapsibleWhitespace(text.charCodeAt(start))) start++;
  while (trimEnd && end > start && isCollapsibleWhitespace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
};

export const minifyHtml = (htmlString: string): string => {
  const { remainder, scripts, insertAt } = planMinification(htmlString);
  if (scripts.length === 0) return collapseWhitespace(remainder).html;
  const { html, split, keepWhitespaceAtSplit } = collapseWhitespace(remainder, insertAt);
  // Inside `<pre>`, a line break between scripts would render and the
  // whitespace before them is content. With a formatting element open, a line
  // break would make the parser re-create it around what follows. Script
  // tags themselves never do, and never join with the text around them.
  const separator = keepWhitespaceAtSplit ? "" : "\n";
  const head = trimCollapsibleWhitespace(html.slice(0, split), !keepWhitespaceAtSplit);
  const tail = html.slice(split);
  const placed = `${head}${separator}${scripts.join(separator)}`;
  // When the document ends inside markup where an appended script would not
  // run, the scripts go just before it; the separator keeps the text on
  // either side from joining with them.
  return tail ? `${placed}${separator}${tail}` : placed;
};
