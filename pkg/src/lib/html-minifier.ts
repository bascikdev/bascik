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
 *   inline elements by default (`INLINE_TAGS`, custom elements, and SVG text
 *   content elements such as `<tspan>`); elsewhere it is removed. An element
 *   made inline with CSS can lose the space next to it.
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

const DIRECTIVE_ATTRIBUTES = new Set([
  "data-bascik-build",
  "data-bascik-build-once",
  "data-bascik-server",
  "data-bascik-routes",
  "data-bascik-stream",
]);

/** JavaScript MIME type essences (WHATWG MIME Sniffing). */
const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

type ScriptKind = "classic" | "module" | "processed" | "inert";

/**
 * How the browser treats a script, from its tokenized attributes (WHATWG
 * "prepare the script element"): a classic or module script runs; an import
 * map or speculation rules are processed in place; any other type is a data
 * block. Bascik directive scripts never reach the browser as written.
 */
const scriptKind = (attributes: TagAttribute[]): ScriptKind => {
  if (attributes.some((attribute) => DIRECTIVE_ATTRIBUTES.has(attribute.name)))
    return "inert";
  // The tokenizer drops repeated attributes, so the first one counts.
  const type = attributes.find((attribute) => attribute.name === "type");
  const language = attributes.find(
    (attribute) => attribute.name === "language",
  );
  let typeString: string;
  if (type ? type.value === "" : !language || language.value === "")
    typeString = "text/javascript";
  else if (type)
    typeString = type.value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
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
      if (!comment.inPre)
        removals.push({
          start: comment.start,
          end: comment.end,
          separate: comment.inTable,
        });
    },
    script(script) {
      // A script cut off by the end of the input never runs; it stays as is.
      if (script.inTemplate || !script.terminated) return;
      const kind = scriptKind(readStartTagAttributes(htmlString, script.start));
      if (kind === "inert") return;
      if (
        (kind === "classic" || kind === "module") &&
        !script.inForeign &&
        !script.inPre
      ) {
        candidates.push({
          start: script.start,
          end: script.end,
          separate: script.inTable,
        });
      } else keepBefore = Math.max(keepBefore, script.end);
    },
  });
  const hoisted = candidates.filter((script) => script.start >= keepBefore);
  const { html, index } = removeHtmlRanges(
    htmlString,
    [...removals, ...hoisted],
    insertionPoint,
  );
  return {
    remainder: html,
    scripts: hoisted.map((script) =>
      htmlString.slice(script.start, script.end),
    ),
    insertAt: index,
  };
};

export const extractScriptTags = (htmlString: string): string =>
  planMinification(htmlString).scripts.join("\n");

/**
 * Elements that are inline by default (in the browser's user-agent
 * stylesheet), so whitespace between two of them renders as one space. Custom
 * elements are inline too; see isInlineTag.
 */
export const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "acronym",
  "audio",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "button",
  "canvas",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "embed",
  "font",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "map",
  "mark",
  "math",
  "meter",
  "nobr",
  "object",
  "output",
  "picture",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "select",
  "slot",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "svg",
  "textarea",
  "time",
  "tt",
  "u",
  "var",
  "video",
  "wbr",
]);

/**
 * SVG text content child elements (lowercased, as the scan reports names).
 * Inside `<text>`, whitespace between two of them renders as one space, as
 * between inline HTML elements; `a` is already in INLINE_TAGS.
 */
const SVG_TEXT_CONTENT_TAGS = new Set(["tspan", "textpath", "tref"]);

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

const collapseText = (text: string): string =>
  text.replace(TEXT_WHITESPACE_RE, " ");

/** Collapse whitespace between the parts of a tag, leaving quoted values as written. */
const collapseTag = (html: string, start: number, end: number): string => {
  const tag = html.slice(start, end);
  if (!HAS_TAG_WHITESPACE_RE.test(tag)) return tag;
  const values = readQuotedValueRanges(html, start);
  let out = "";
  let cursor = start;
  for (let k = 0; k < values.length; k += 2) {
    out +=
      html.slice(cursor, values[k]).replace(TAG_WHITESPACE_RE, " ") +
      html.slice(values[k], values[k + 1]);
    cursor = values[k + 1];
  }
  return out + html.slice(cursor, end).replace(TAG_WHITESPACE_RE, " ");
};

/** HTML formatting elements, which the parser re-creates after they are implicitly closed. */
const FORMATTING_ELEMENTS = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u",
]);

/** Tags and other complete markup end with `>` and start with `<`. */
const isMarkupToken = (token: HtmlToken | undefined): token is HtmlToken =>
  token !== undefined && (token.kind === "tag" || token.kind === "markup");

/**
 * A tag of an element that is inline by default: one in INLINE_TAGS, an SVG
 * text content element, or a custom element (any name with a hyphen, which
 * stays inline unless styled otherwise).
 */
const isInlineTag = (token: HtmlToken | undefined): boolean =>
  token !== undefined &&
  token.kind === "tag" &&
  (INLINE_TAGS.has(token.name) ||
    SVG_TEXT_CONTENT_TAGS.has(token.name) ||
    token.name.includes("-"));

/**
 * The nearest token from `k` in direction `step` that renders: comments and
 * other markup outside SVG and MathML render nothing, nor does the
 * whitespace-only text between them and a tag.
 */
const renderingNeighbor = (
  tokens: HtmlToken[],
  html: string,
  k: number,
  step: 1 | -1,
): HtmlToken | undefined => {
  for (let i = k + step; i >= 0 && i < tokens.length; i += step) {
    const token = tokens[i];
    if (token.kind === "markup" && !token.inForeign) continue;
    if (
      token.kind === "text" &&
      !token.inPre &&
      !token.inForeignCode &&
      TEXT_WHITESPACE_ONLY_RE.test(html.slice(token.start, token.end))
    )
      continue;
    return token;
  }
  return undefined;
};

/** No other whitespace-only run follows the one at `k` before the next token that renders. */
const isLastWhitespaceRun = (tokens: HtmlToken[], k: number): boolean => {
  let i = k + 1;
  while (
    i < tokens.length &&
    tokens[i].kind === "markup" &&
    !tokens[i].inForeign
  )
    i++;
  return i >= tokens.length || tokens[i].kind !== "text";
};

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
const collapseWhitespace = (
  html: string,
  splitAt = html.length,
): CollapsedHtml => {
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
      write(
        token.name === "title" && !token.inPre && !token.inForeignCode
          ? collapseText(source)
          : source,
      );
    } else if (token.kind !== "text") {
      write(source);
    } else if (token.inPre || token.inForeignCode) {
      write(source);
    } else if (
      TEXT_WHITESPACE_ONLY_RE.test(source) &&
      isMarkupToken(tokens[k - 1]) &&
      isMarkupToken(tokens[k + 1])
    ) {
      // A comment between two inline elements renders nothing, so the space
      // around it still separates them. One space covers every run there: the
      // last, so an instance that ends in comments keeps it at its end. Only
      // a last run looks back, so each token is passed over at most twice.
      const keepInlineSpace =
        isLastWhitespaceRun(tokens, k) &&
        isInlineTag(renderingNeighbor(tokens, html, k, 1)) &&
        isInlineTag(renderingNeighbor(tokens, html, k, -1));
      write(openFormatting > 0 || keepInlineSpace ? " " : "");
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
const isCollapsibleWhitespace = (code: number): boolean =>
  code === 32 || code === 10 || code === 9 || code === 13;

/**
 * Trim collapsible whitespace from both ends. A form feed, U+00A0, or other
 * Unicode space is content and stays.
 */
const trimCollapsibleWhitespace = (text: string, trimEnd = true): string => {
  let start = 0;
  let end = text.length;
  while (start < end && isCollapsibleWhitespace(text.charCodeAt(start)))
    start++;
  while (
    trimEnd &&
    end > start &&
    isCollapsibleWhitespace(text.charCodeAt(end - 1))
  )
    end--;
  return text.slice(start, end);
};

export const minifyHtml = (htmlString: string): string => {
  const { remainder, scripts, insertAt } = planMinification(htmlString);
  if (scripts.length === 0) return collapseWhitespace(remainder).html;
  const { html, split, keepWhitespaceAtSplit } = collapseWhitespace(
    remainder,
    insertAt,
  );
  // Inside `<pre>`, a line break between scripts would render and the
  // whitespace before them is content. With a formatting element open, a line
  // break would make the parser re-create it around what follows. Script
  // tags themselves never do, and never join with the text around them.
  const separator = keepWhitespaceAtSplit ? "" : "\n";
  const head = trimCollapsibleWhitespace(
    html.slice(0, split),
    !keepWhitespaceAtSplit,
  );
  const tail = html.slice(split);
  const placed = `${head}${separator}${scripts.join(separator)}`;
  // When the document ends inside markup where an appended script would not
  // run, the scripts go just before it; the separator keeps the text on
  // either side from joining with them.
  return tail ? `${placed}${separator}${tail}` : placed;
};

// ─── Fragments (prompt 157) ──────────────────────────────────────────────────
//
// A request-time renderer minifies each rendered component instance on its
// own, inside a page whose markup it does not minify. What `minifyHtml` keeps
// or collapses in a fragment depends on the page around it: whitespace and
// comments inside a `<pre>`, the separator a comment leaves in a table, the
// space kept between tags while a formatting element is open, scripts that
// never move out of a `<template>`, and the tokens on either side of the
// fragment. `fragmentContexts` reads that from the page, and
// `minifyHtmlFragment` minifies the fragment as the whole page's
// `minifyHtml` would minify those bytes, except that hoisted scripts are
// placed at the fragment's end instead of the page's.

/** What touches a fragment's edge, as `collapseWhitespace` classifies a neighbor. */
export type FragmentNeighbor = "none" | "text" | "inline" | "block";

export interface FragmentContext {
  /**
   * The page around the fragment is SVG or MathML, or a part the scan could
   * not follow: the fragment is left as written, which keeps more whitespace
   * than the build would, never less.
   */
  verbatim: boolean;
  inTemplate: boolean;
  inTable: boolean;
  inPre: boolean;
  /** A formatting element (`<b>`, `<a>`, ...) may be open. */
  formatting: boolean;
  before: FragmentNeighbor;
  after: FragmentNeighbor;
  /**
   * The neighbor is the previous (next) span itself, as written: whoever
   * expands the spans should take the neighbor from that span's result.
   */
  beforeIsSpan?: boolean;
  afterIsSpan?: boolean;
}

/** A fragment that is a whole document. */
export const DOCUMENT_FRAGMENT_CONTEXT: FragmentContext = {
  verbatim: false,
  inTemplate: false,
  inTable: false,
  inPre: false,
  formatting: false,
  before: "none",
  after: "none",
};

/**
 * Markup that puts the scan in `context`'s state: none of it is whitespace,
 * a comment or a script, so the minifier writes it back unchanged.
 */
const openingMarkup = (context: FragmentContext): string =>
  (context.inTemplate ? "<template>" : "") +
  (context.inTable ? "<table>" : "") +
  (context.inPre ? "<pre>" : "") +
  (context.formatting ? "<b>" : "");

/** A stand-in neighbor of the same kind; text stands in as one non-space character. */
const BEFORE_STAND_IN: Record<FragmentNeighbor, string> = {
  none: "",
  text: "x",
  inline: "<span>",
  block: "<div>",
};
/**
 * Text after the fragment needs no stand-in: the fragment's trailing
 * whitespace collapses to one space either way.
 */
const AFTER_STAND_IN: Record<FragmentNeighbor, string> = {
  none: "",
  text: "",
  inline: "<span>",
  block: "<div>",
};

const classifyNeighbor = (token: HtmlToken): FragmentNeighbor =>
  token.kind === "text"
    ? "text"
    : isInlineTag(token)
      ? "inline"
      : isMarkupToken(token)
        ? "block"
        : "text";

/**
 * The context of each `span` of `html` (non-overlapping, in document order),
 * where `html` itself sits in `outer`. One scan of `html`.
 */
export const fragmentContexts = (
  html: string,
  spans: readonly HtmlRange[],
  outer: FragmentContext = DOCUMENT_FRAGMENT_CONTEXT,
): FragmentContext[] => {
  // `beforeIsSpan`/`afterIsSpan` name neighbors among THESE spans: the outer
  // context's flags are about the spans of the page around `html` and must
  // not be inherited by a span at its edge (prompt 157).
  const results: FragmentContext[] = spans.map(() => ({
    ...outer,
    beforeIsSpan: false,
    afterIsSpan: false,
  }));
  if (outer.verbatim || spans.length === 0) return results;
  const prefix = openingMarkup(outer);
  const shift = prefix.length;
  const document = prefix + html;
  const isWhitespaceText = (token: HtmlToken): boolean =>
    token.kind === "text" &&
    TEXT_WHITESPACE_ONLY_RE.test(document.slice(token.start, token.end));
  const formattingByName = new Map<string, number>();
  let openFormatting = 0;
  /** The last token of `html` seen, and the last that was not whitespace-only text. */
  let previous: HtmlToken | undefined;
  let previousSolid: HtmlToken | undefined;
  let unparsedAt = Infinity;
  let started = 0;
  let ended = 0;
  /** Spans whose `after` waits for the token past a whitespace-only text run. */
  let pendingAfter: number[] = [];
  const resolveStart = (index: number): void => {
    const result = results[index];
    if (previous) {
      result.inTemplate = previous.inTemplate;
      result.inTable = previous.inTable;
      result.inPre = previous.inPre;
      result.verbatim = previous.inForeign || previous.inForeignCode;
      // Whitespace-only text between the page's markup and the fragment
      // merges with the fragment's own edge, so that markup decides.
      const neighbor =
        isWhitespaceText(previous) && previousSolid ? previousSolid : previous;
      result.before = classifyNeighbor(neighbor);
      result.beforeIsSpan =
        index > 0 && neighbor.end === spans[index - 1].end + shift;
    }
    result.formatting = openFormatting > 0;
  };
  const resolveAfter = (index: number, token: HtmlToken): void => {
    results[index].after = classifyNeighbor(token);
    results[index].afterIsSpan =
      index + 1 < spans.length &&
      token.start === spans[index + 1].start + shift;
  };
  scanHtml(document, {
    token(token) {
      if (pendingAfter.length > 0) {
        for (const index of pendingAfter) resolveAfter(index, token);
        pendingAfter = [];
      }
      while (
        started < spans.length &&
        token.start >= spans[started].start + shift
      )
        resolveStart(started++);
      while (ended < started && token.start >= spans[ended].end + shift) {
        if (isWhitespaceText(token)) pendingAfter.push(ended);
        else resolveAfter(ended, token);
        ended++;
      }
      if (token.kind === "unparsed")
        unparsedAt = Math.min(unparsedAt, token.start);
      if (
        token.kind === "tag" &&
        FORMATTING_ELEMENTS.has(token.name) &&
        !token.inForeign
      ) {
        const count = formattingByName.get(token.name) ?? 0;
        if (!token.isEndTag) {
          formattingByName.set(token.name, count + 1);
          openFormatting++;
        } else if (count > 0) {
          formattingByName.set(token.name, count - 1);
          openFormatting--;
        }
      }
      // The opening markup only sets the state; it is no neighbor.
      if (token.end <= shift) return;
      previous = token;
      if (!isWhitespaceText(token)) previousSolid = token;
    },
  });
  // Spans the scan never reached start at the end of `html`.
  while (started < spans.length) resolveStart(started++);
  for (let index = 0; index < spans.length; index++) {
    if (unparsedAt < spans[index].end + shift) results[index].verbatim = true;
  }
  return results;
};

/**
 * The first and last tokens of `html` that its minified form keeps at its
 * edges (comments and hoisted scripts are removed, whitespace-only text is
 * no neighbor), as a fragment next to it sees them. "none" when it is empty.
 */
export const fragmentEdges = (
  html: string,
): { first: FragmentNeighbor; last: FragmentNeighbor } => {
  const { remainder } = planMinification(html);
  let first: HtmlToken | undefined;
  let last: HtmlToken | undefined;
  scanHtml(remainder, {
    token(token) {
      if (
        token.kind === "text" &&
        TEXT_WHITESPACE_ONLY_RE.test(remainder.slice(token.start, token.end))
      )
        return;
      first ??= token;
      last = token;
    },
  });
  return {
    first: first ? classifyNeighbor(first) : "none",
    last: last ? classifyNeighbor(last) : "none",
  };
};

/**
 * Minify `html`, a fragment of a page, as `minifyHtml` would minify those
 * bytes within the whole page, given the page around it (`context`). Hoisted
 * scripts go to the end of the fragment. Where the fragment cannot be
 * placed back exactly (it ends inside unclosed markup), or `context` is
 * verbatim, it is returned as written.
 */
export const minifyHtmlFragment = (
  html: string,
  context: FragmentContext,
): string => {
  if (context.verbatim) return html;
  const prefix = openingMarkup(context) + BEFORE_STAND_IN[context.before];
  const suffix = AFTER_STAND_IN[context.after];
  if (!prefix && !suffix) return minifyHtml(html);
  const document = prefix + html + suffix;
  const { remainder, scripts, insertAt } = planMinification(document);
  const end = remainder.length - suffix.length;
  if (
    !remainder.startsWith(prefix) ||
    !remainder.endsWith(suffix) ||
    (!context.inTemplate && insertAt < end)
  )
    return html;
  const {
    html: collapsed,
    split,
    keepWhitespaceAtSplit,
  } = collapseWhitespace(remainder, end);
  if (collapsed.slice(split) !== suffix || !collapsed.startsWith(prefix))
    return html;
  const body = collapsed.slice(0, split);
  if (scripts.length === 0) return body.slice(prefix.length);
  const separator = keepWhitespaceAtSplit ? "" : "\n";
  const head = trimCollapsibleWhitespace(body, !keepWhitespaceAtSplit);
  if (!head.startsWith(prefix)) return html;
  // The fragment's trailing whitespace is the page's, shared with what
  // follows (the whole page's minify never trims it), so it stays after the
  // scripts placed at the fragment's end.
  const trailing = body.slice(head.length);
  return `${head}${separator}${scripts.join(separator)}${trailing}`.slice(
    prefix.length,
  );
};

/** Collapsible whitespace at the start of `html` (space, tab, LF, CR). */
export const leadingCollapsibleWhitespace = (html: string): number => {
  let index = 0;
  while (index < html.length && isCollapsibleWhitespace(html.charCodeAt(index)))
    index++;
  return index;
};

/** Collapsible whitespace at the end of `html`. */
export const trailingCollapsibleWhitespace = (html: string): number => {
  let index = html.length;
  while (index > 0 && isCollapsibleWhitespace(html.charCodeAt(index - 1)))
    index--;
  return html.length - index;
};
