/**
 * @module html-scanner
 * Linear scan of an HTML document that follows the WHATWG HTML tokenizer, so
 * build steps that remove or move markup act only on what a browser parses as
 * a comment or a `<script>` element.
 *
 * Regex scans assume well-formed markup. Browsers follow exact recovery rules
 * for everything else: `a < b` is text, `<scr<script>` is one start tag, and
 * the contents of `<noscript>`, `<textarea>`, or `<title>` are text. Removing
 * or moving markup on a regex's say-so can make dead code run, make a running
 * script dead, or change rendered text. This scan reports comments and script
 * elements exactly where the tokenizer finds them.
 *
 * Tokenizer states are followed for HTML content, including raw text
 * (`script`, `style`, `xmp`, `iframe`, `noembed`, `noframes`, `noscript`),
 * RCDATA (`textarea`, `title`), and `plaintext`. Tree construction is modeled
 * only where it changes tokenization or whether a script runs: SVG and MathML
 * foreign content (integration points and breakout tags included),
 * `<template>` contents, and `<pre>`/`<listing>` for callers that keep that
 * content verbatim, plus the `<select>` and `<frameset>` cases that change
 * tokenization. Script bodies follow the script data escape states: after
 * `<!--<script>` inside a script, `</script>` does not end it until `-->`.
 *
 * Known limits, each chosen to err in the safe direction:
 * - Where the model cannot follow the browser, the scan stops and reports the
 *   rest of the input as one `unparsed` token, so callers never act on a
 *   guess. It stops at raw text, RCDATA, or SVG/MathML start tags inside
 *   `<select>` (parsers disagree there), `<frameset>`, CDATA directly inside
 *   an SVG/MathML integration point, end tags in foreign content that may
 *   close an element the scan does not track, and nesting deeper than
 *   MAX_TRACKED_DEPTH.
 * - Ordinary HTML elements are not tracked, only counted where it matters.
 *   `inPre` and `inTable` can stay true after the element was closed
 *   implicitly (`<div><pre></div>`), and once a `<table>` or `<select>` opens
 *   inside `<pre>`, `inPre` stays true until the template level ends. Callers
 *   then keep more whitespace than needed, never less.
 */

export interface ScanContext {
  /** Inside `<template>` contents, which never run until cloned. */
  inTemplate: boolean;
  /** Inside SVG or MathML, including HTML inside an integration point. */
  inForeign: boolean;
  /** Inside `<pre>` or `<listing>`. */
  inPre: boolean;
  /**
   * A `<table>` may be open. Text in a table is moved before it when it is
   * not all whitespace, run by run, so removing markup between two runs of
   * text there can change what moves. Errs toward true.
   */
  inTable: boolean;
}

export interface HtmlRange {
  /** Index of the first character. */
  start: number;
  /** Index just past the last character. */
  end: number;
}

export interface ScannedComment extends HtmlRange, ScanContext {
  /** False when the input ends inside the comment; `end` is then the input length. */
  terminated: boolean;
}

export interface ScannedScript extends HtmlRange, ScanContext {
  /** Index just past the start tag's `>`. */
  openTagEnd: number;
  /**
   * False when the input ends inside the script; `end` is then the input
   * length. Such a script never runs.
   */
  terminated: boolean;
}

/**
 * One piece of the document, in order. Together the tokens cover the input
 * exactly once, from index 0 to its length.
 *
 * - `text`: character data parsed as markup content (a `<` that starts no
 *   markup is part of it).
 * - `tag`: a start or end tag, `<` through `>`.
 * - `raw`: the body of a raw text or RCDATA element (`script`, `style`,
 *   `textarea`, `title`, `xmp`, ...), between its start and end tags.
 * - `markup`: a comment, DOCTYPE, CDATA section, bogus comment, or `</>`.
 * - `unparsed`: the rest of the input from where the scan stopped or the
 *   input ended inside markup. Its meaning is unknown, so keep it verbatim.
 */
export interface HtmlToken extends HtmlRange, ScanContext {
  kind: "text" | "tag" | "raw" | "markup" | "unparsed";
  /** Lowercased tag name for `tag`, element name for `raw`, otherwise "". */
  name: string;
  /** For `tag`: true for an end tag. */
  isEndTag: boolean;
  /**
   * Inside an SVG or MathML `script` or `style` element, whose text is code
   * even though it is tokenized as markup.
   */
  inForeignCode: boolean;
}

export interface HtmlScanHandlers {
  comment?(comment: ScannedComment): void;
  script?(script: ScannedScript): void;
  token?(token: HtmlToken): void;
}

export interface HtmlScanResult {
  /**
   * The latest index where inserted markup is parsed as ordinary HTML content
   * outside `<template>` and SVG/MathML, so an inserted `<script>` runs. It is
   * the input length unless the document ends inside an unclosed tag,
   * comment, raw text element, `<template>`, foreign content, or `<plaintext>`;
   * then it is the start of that markup.
   */
  insertionPoint: number;
  /**
   * Index where the scan stopped because it could no longer follow the
   * browser's parse; nothing at or after it was reported. The input length
   * when the scan followed the whole document.
   */
  stoppedAt: number;
}

export interface TagAttribute {
  /** Lowercased attribute name. */
  name: string;
  /** Raw value, without character reference decoding. */
  value: string;
}

const TAB = 9;
const LF = 10;
const FF = 12;
const CR = 13;
const SPACE = 32;
const BANG = 33;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const DASH = 45;
const SLASH = 47;
const LT = 60;
const EQUALS = 61;
const GT = 62;
const QUESTION = 63;

const isWhitespace = (code: number): boolean =>
  code === SPACE || code === LF || code === TAB || code === FF || code === CR;

const isAsciiAlpha = (code: number): boolean => {
  const lower = code | 32;
  return lower >= 97 && lower <= 122;
};

/** Elements whose start tag switches the tokenizer to raw text or RCDATA in HTML content. */
const RAW_TEXT_ELEMENTS = new Set([
  "script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title",
]);

const VOID_ELEMENTS = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input",
  "keygen", "link", "meta", "param", "source", "track", "wbr",
]);

/** HTML start tags that end foreign content (WHATWG "parsing tokens in foreign content"). */
const BREAKOUT_ELEMENTS = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em",
  "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li", "listing", "menu",
  "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span", "strong", "strike", "sub", "sup",
  "table", "tt", "u", "ul", "var",
]);

/** HTML "special" elements: an unmatched end tag stops at one of these. */
const SPECIAL_ELEMENTS = new Set([
  "address", "applet", "area", "article", "aside", "base", "basefont", "bgsound", "blockquote",
  "body", "br", "button", "caption", "center", "col", "colgroup", "dd", "details", "dir", "div",
  "dl", "dt", "embed", "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "iframe", "img",
  "input", "keygen", "li", "link", "listing", "main", "marquee", "menu", "meta", "nav", "noembed",
  "noframes", "noscript", "object", "ol", "p", "param", "plaintext", "pre", "script", "search",
  "section", "select", "source", "style", "summary", "table", "tbody", "td", "template",
  "textarea", "tfoot", "th", "thead", "title", "tr", "track", "ul", "wbr", "xmp",
]);

/**
 * End tags that close their element whenever it is in scope, implying end
 * tags for anything opened inside it (`<div><p>x</div>` closes both).
 */
const SCOPED_END_TAGS = new Set([
  "address", "article", "aside", "blockquote", "button", "center", "details", "dialog", "dir",
  "div", "dl", "fieldset", "figcaption", "figure", "footer", "header", "hgroup", "listing",
  "main", "menu", "nav", "ol", "pre", "search", "section", "summary", "ul", "form", "li", "dd",
  "dt", "h1", "h2", "h3", "h4", "h5", "h6", "applet", "marquee", "object", "p",
]);

/** Elements that bound the HTML "has an element in scope" search. */
const SCOPE_BOUNDARY_ELEMENTS = new Set([
  "applet", "caption", "html", "table", "td", "th", "marquee", "object", "template",
]);

const MATHML_TEXT_INTEGRATION_POINTS = new Set(["mi", "mo", "mn", "ms", "mtext"]);

/**
 * Start tags that "in select" parsing ignores but body parsing gives meaning:
 * raw text, RCDATA, and foreign content. Parsers also differ here (the newer
 * customizable `<select>` parses more content), so the scan stops instead.
 */
const UNCERTAIN_IN_SELECT = new Set([
  "style", "title", "noscript", "iframe", "xmp", "noembed", "noframes", "plaintext", "svg", "math",
]);

/**
 * Deepest foreign-content nesting the scan tracks. End tags walk the tracked
 * elements, so a bound keeps hostile input linear; real SVG and MathML stay
 * far below it. Deeper nesting stops the scan.
 */
const MAX_TRACKED_DEPTH = 512;

const NOT_AN_INTEGRATION_POINT = 0;
const HTML_INTEGRATION_POINT = 1;
const MATHML_TEXT_INTEGRATION_POINT = 2;

type Namespace = "html" | "svg" | "math";

interface OpenElement {
  name: string;
  namespace: Namespace;
  integrationPoint: number;
  start: number;
  openTagEnd: number;
}

interface ScannedTag {
  /** Lowercased tag name. */
  name: string;
  /** Index just past the tag's `>`, or -1 when the input ends inside the tag. */
  end: number;
  selfClosing: boolean;
}

const BEFORE_ATTRIBUTE_NAME = 0;
const ATTRIBUTE_NAME = 1;
const AFTER_ATTRIBUTE_NAME = 2;
const BEFORE_ATTRIBUTE_VALUE = 3;
const ATTRIBUTE_VALUE_DOUBLE_QUOTED = 4;
const ATTRIBUTE_VALUE_SINGLE_QUOTED = 5;
const ATTRIBUTE_VALUE_UNQUOTED = 6;
const AFTER_ATTRIBUTE_VALUE_QUOTED = 7;
const SELF_CLOSING_START_TAG = 8;

/**
 * Scan a start or end tag whose name begins at `nameStart` (an ASCII letter),
 * following the tokenizer's tag name, attribute, and self-closing states: a
 * quote delimits a value only after `=`, and `<` inside a tag is ordinary.
 * Pass `attributes` to collect the tag's attributes, and `quotedValues` to
 * collect each quoted value's range as start and end index pairs.
 */
const scanTag = (
  html: string,
  nameStart: number,
  attributes?: TagAttribute[],
  quotedValues?: number[],
): ScannedTag => {
  const n = html.length;
  let i = nameStart + 1;
  while (i < n) {
    const code = html.charCodeAt(i);
    if (isWhitespace(code) || code === SLASH || code === GT) break;
    i++;
  }
  const name = html.slice(nameStart, i).toLowerCase();
  const unterminated: ScannedTag = { name, end: -1, selfClosing: false };
  if (i >= n) return unterminated;
  let code = html.charCodeAt(i);
  if (code === GT) return { name, end: i + 1, selfClosing: false };
  let state = code === SLASH ? SELF_CLOSING_START_TAG : BEFORE_ATTRIBUTE_NAME;
  i++;

  let attributeStart = -1;
  let attributeNameEnd = -1;
  let valueStart = -1;
  const finishAttribute = (valueEnd: number): void => {
    if (attributes && attributeStart !== -1) {
      attributes.push({
        name: html.slice(attributeStart, attributeNameEnd).toLowerCase(),
        value: valueStart === -1 ? "" : html.slice(valueStart, valueEnd),
      });
    }
    attributeStart = -1;
    valueStart = -1;
  };

  for (;;) {
    if (i >= n) return unterminated;
    code = html.charCodeAt(i);
    switch (state) {
      case BEFORE_ATTRIBUTE_NAME:
        if (isWhitespace(code)) {
          i++;
        } else if (code === SLASH || code === GT) {
          state = AFTER_ATTRIBUTE_NAME;
        } else {
          // `=` here starts a name, as does any other character.
          attributeStart = i;
          state = ATTRIBUTE_NAME;
          i++;
        }
        break;
      case ATTRIBUTE_NAME:
        if (isWhitespace(code) || code === SLASH || code === GT) {
          attributeNameEnd = i;
          state = AFTER_ATTRIBUTE_NAME;
        } else if (code === EQUALS) {
          attributeNameEnd = i;
          state = BEFORE_ATTRIBUTE_VALUE;
          i++;
        } else {
          i++;
        }
        break;
      case AFTER_ATTRIBUTE_NAME:
        if (isWhitespace(code)) {
          i++;
        } else if (code === SLASH) {
          finishAttribute(i);
          state = SELF_CLOSING_START_TAG;
          i++;
        } else if (code === EQUALS) {
          state = BEFORE_ATTRIBUTE_VALUE;
          i++;
        } else if (code === GT) {
          finishAttribute(i);
          return { name, end: i + 1, selfClosing: false };
        } else {
          finishAttribute(i);
          attributeStart = i;
          state = ATTRIBUTE_NAME;
          i++;
        }
        break;
      case BEFORE_ATTRIBUTE_VALUE:
        if (isWhitespace(code)) {
          i++;
        } else if (code === DOUBLE_QUOTE) {
          valueStart = i + 1;
          state = ATTRIBUTE_VALUE_DOUBLE_QUOTED;
          i++;
        } else if (code === SINGLE_QUOTE) {
          valueStart = i + 1;
          state = ATTRIBUTE_VALUE_SINGLE_QUOTED;
          i++;
        } else if (code === GT) {
          finishAttribute(i);
          return { name, end: i + 1, selfClosing: false };
        } else {
          valueStart = i;
          state = ATTRIBUTE_VALUE_UNQUOTED;
        }
        break;
      case ATTRIBUTE_VALUE_DOUBLE_QUOTED:
      case ATTRIBUTE_VALUE_SINGLE_QUOTED: {
        const close = html.indexOf(state === ATTRIBUTE_VALUE_DOUBLE_QUOTED ? '"' : "'", i);
        if (close === -1) return unterminated;
        quotedValues?.push(valueStart, close);
        finishAttribute(close);
        state = AFTER_ATTRIBUTE_VALUE_QUOTED;
        i = close + 1;
        break;
      }
      case ATTRIBUTE_VALUE_UNQUOTED:
        if (isWhitespace(code)) {
          finishAttribute(i);
          state = BEFORE_ATTRIBUTE_NAME;
          i++;
        } else if (code === GT) {
          finishAttribute(i);
          return { name, end: i + 1, selfClosing: false };
        } else {
          i++;
        }
        break;
      case AFTER_ATTRIBUTE_VALUE_QUOTED:
        if (isWhitespace(code)) {
          state = BEFORE_ATTRIBUTE_NAME;
          i++;
        } else if (code === SLASH) {
          state = SELF_CLOSING_START_TAG;
          i++;
        } else if (code === GT) {
          return { name, end: i + 1, selfClosing: false };
        } else {
          state = BEFORE_ATTRIBUTE_NAME;
        }
        break;
      default: // SELF_CLOSING_START_TAG
        if (code === GT) return { name, end: i + 1, selfClosing: true };
        state = BEFORE_ATTRIBUTE_NAME;
        break;
    }
  }
};

/** Attributes of the start tag whose `<` is at `tagStart`, as the tokenizer reads them. */
export const readStartTagAttributes = (html: string, tagStart: number): TagAttribute[] => {
  const attributes: TagAttribute[] = [];
  if (isAsciiAlpha(html.charCodeAt(tagStart + 1))) scanTag(html, tagStart + 1, attributes);
  return attributes;
};

/**
 * Ranges of the quoted attribute values in the start or end tag whose `<` is
 * at `tagStart`, as start and end index pairs (quotes excluded). Unquoted
 * values end at whitespace, so outside these ranges whitespace in a tag only
 * separates its parts.
 */
export const readQuotedValueRanges = (html: string, tagStart: number): number[] => {
  const ranges: number[] = [];
  const nameStart = html.charCodeAt(tagStart + 1) === SLASH ? tagStart + 2 : tagStart + 1;
  if (isAsciiAlpha(html.charCodeAt(nameStart))) scanTag(html, nameStart, undefined, ranges);
  return ranges;
};

/**
 * Index just past the comment whose `<!--` is at `start`, or -1 when the
 * input ends first. Ends at `-->` or `--!>`, and `<!-->` and `<!--->` are
 * complete empty comments.
 */
export const findCommentEnd = (html: string, start: number): number => {
  const bodyStart = start + 4;
  if (html.charCodeAt(bodyStart) === GT) return bodyStart + 1;
  if (html.charCodeAt(bodyStart) === DASH && html.charCodeAt(bodyStart + 1) === GT) return bodyStart + 2;
  let dashes = html.indexOf("--", bodyStart);
  while (dashes !== -1) {
    const next = html.charCodeAt(dashes + 2);
    if (next === GT) return dashes + 3;
    if (next === BANG && html.charCodeAt(dashes + 3) === GT) return dashes + 4;
    dashes = html.indexOf("--", dashes + 1);
  }
  return -1;
};

/**
 * Index of the `</name` that ends a raw text or RCDATA body starting at
 * `from`: the name matches case-insensitively and is followed by whitespace,
 * `/`, or `>`. -1 when the input ends first.
 */
const findRawTextEnd = (html: string, from: number, name: string): number => {
  let close = html.indexOf("</", from);
  while (close !== -1) {
    let matched = 0;
    while (matched < name.length && (html.charCodeAt(close + 2 + matched) | 32) === name.charCodeAt(matched)) {
      matched++;
    }
    if (matched === name.length) {
      const after = html.charCodeAt(close + 2 + matched);
      if (isWhitespace(after) || after === SLASH || after === GT) return close;
    }
    close = html.indexOf("</", close + 2);
  }
  return -1;
};

/** `script` (any case) at `at`, followed by whitespace, `/`, or `>`. */
const isScriptNameAt = (html: string, at: number): boolean => {
  for (let k = 0; k < 6; k++) {
    if ((html.charCodeAt(at + k) | 32) !== "script".charCodeAt(k)) return false;
  }
  const after = html.charCodeAt(at + 6);
  return isWhitespace(after) || after === SLASH || after === GT;
};

const SCRIPT_DATA = 0;
const SCRIPT_DATA_ESCAPED = 1;
const SCRIPT_DATA_DOUBLE_ESCAPED = 2;

/**
 * Index of the `</script` that ends a script body starting at `from`, or -1
 * when the input ends first. Follows the script data escape states: `<!--`
 * starts an escaped run that `-->` ends; inside it, `<script` starts a double
 * escaped run in which `</script` only returns to the escaped run.
 */
const findScriptEnd = (html: string, from: number): number => {
  const n = html.length;
  let state = SCRIPT_DATA;
  let dashes = 0;
  let i = from;
  while (i < n) {
    if (state === SCRIPT_DATA) {
      const lt = html.indexOf("<", i);
      if (lt === -1) return -1;
      if (html.charCodeAt(lt + 1) === SLASH && isScriptNameAt(html, lt + 2)) return lt;
      if (html.startsWith("<!--", lt)) {
        // The opener's dashes count toward `-->`, so `<!-->` ends at once.
        state = SCRIPT_DATA_ESCAPED;
        dashes = 2;
        i = lt + 4;
      } else {
        i = lt + 1;
      }
      continue;
    }
    const code = html.charCodeAt(i);
    if (code === DASH) {
      dashes++;
      i++;
      continue;
    }
    if (code === GT && dashes >= 2) {
      state = SCRIPT_DATA;
      dashes = 0;
      i++;
      continue;
    }
    dashes = 0;
    if (code === LT) {
      if (html.charCodeAt(i + 1) === SLASH && isScriptNameAt(html, i + 2)) {
        if (state === SCRIPT_DATA_ESCAPED) return i;
        state = SCRIPT_DATA_ESCAPED;
        i += 8;
        continue;
      }
      if (state === SCRIPT_DATA_ESCAPED && isScriptNameAt(html, i + 1)) {
        state = SCRIPT_DATA_DOUBLE_ESCAPED;
        i += 7;
        continue;
      }
    }
    i++;
  }
  return -1;
};

/**
 * Scan `html` once, reporting each comment and each complete `<script>`
 * element (start tag through end tag) in the order the browser closes them.
 * Script data escapes aside, ranges match the browser's parse exactly.
 */
export const scanHtml = (html: string, handlers: HtmlScanHandlers = {}): HtmlScanResult => {
  const n = html.length;
  /** Open elements since entering foreign content; empty in ordinary HTML content. */
  const stack: OpenElement[] = [];
  let templateDepth = 0;
  /**
   * Open `<pre>` and `<listing>` elements, counted by name (`</pre>` never
   * closes a listing) and per template level: an end tag inside a template's
   * contents never closes an element outside it.
   */
  const preformattedFrames = [{ pre: 0, listing: 0, sticky: false, tables: 0 }];
  let openTables = 0;
  let openPreformatted = 0;
  const isPreformatted = (name: string): name is "pre" | "listing" => name === "pre" || name === "listing";
  const preformatted = () => preformattedFrames[preformattedFrames.length - 1];
  const openPreformattedElement = (name: "pre" | "listing"): void => {
    preformatted()[name]++;
    openPreformatted++;
  };
  const closePreformattedElement = (name: "pre" | "listing"): void => {
    const frame = preformatted();
    // Past a scope boundary such as `<table>`, `</pre>` may not reach the
    // `<pre>`, and the scan does not track when the boundary closes. It errs
    // toward still being in `<pre>`, which only keeps more whitespace.
    if (frame[name] === 0 || frame.sticky) return;
    frame[name]--;
    openPreformatted--;
  };
  const openTemplate = (): void => {
    templateDepth++;
    preformattedFrames.push({ pre: 0, listing: 0, sticky: false, tables: 0 });
  };
  const closeTemplate = (): void => {
    if (templateDepth === 0) return;
    templateDepth--;
    const frame = preformattedFrames.pop()!;
    openPreformatted -= frame.pre + frame.listing;
    openTables -= frame.tables;
  };
  /** A `<select>` may be open: only explicit closers clear it, so it errs toward open. */
  let selectOpen = false;
  /** Set when the scan can no longer follow the browser's parse. */
  let lost = false;
  /** Start of the current stretch where inserted markup would not run, or -1. */
  let notInsertableSince = -1;
  /** Open SVG/MathML `script` and `style` elements on the stack. */
  let foreignCodeDepth = 0;
  /** Start of text not yet reported as a token. */
  let textFrom = 0;
  /** Set by startHtmlElement for a raw text or RCDATA element: its body and end tag. */
  let rawElement: { name: string; close: number; end: number } | null = null;

  const context = (): ScanContext => ({
    inTemplate: templateDepth > 0,
    inForeign: stack.length > 0,
    inPre: openPreformatted > 0,
    inTable: openTables > 0,
  });
  /** A nested `<table>` start tag closes the outer one; counting both only errs toward a table being open. */
  const openTable = (): void => {
    preformatted().tables++;
    openTables++;
  };
  const closeTable = (): void => {
    if (preformatted().tables === 0) return;
    preformatted().tables--;
    openTables--;
  };
  const emit = (kind: HtmlToken["kind"], start: number, end: number, name = "", isEndTag = false): void => {
    if (end > start) handlers.token?.({ kind, start, end, name, isEndTag, inForeignCode: foreignCodeDepth > 0, ...context() });
  };
  /** Report text up to `start`, where markup begins. */
  const flushText = (start: number): void => {
    emit("text", textFrom, start);
    textFrom = start;
  };
  /** Report markup spanning `start` to `end`, after any text before it. */
  const emitMarkup = (kind: HtmlToken["kind"], start: number, end: number, name = "", isEndTag = false): void => {
    flushText(start);
    emit(kind, start, end, name, isEndTag);
    textFrom = end;
  };
  const isInsertable = (): boolean => stack.length === 0 && templateDepth === 0;
  /** Report a foreign script, with the context captured before its elements were popped. */
  const reportForeignScript = (entry: OpenElement, end: number, terminated: boolean, where: ScanContext): void => {
    if (entry.name !== "script" || entry.namespace === "html") return;
    handlers.script?.({ start: entry.start, openTagEnd: entry.openTagEnd, end, terminated, ...where, inForeign: true });
  };
  /** The input ends at `start`, inside the markup that begins there when start < n. */
  const endAt = (start: number): HtmlScanResult => {
    const where = context();
    for (let k = stack.length - 1; k >= 0; k--) reportForeignScript(stack[k], n, false, where);
    emitMarkup("unparsed", start, n);
    return {
      insertionPoint: notInsertableSince === -1 ? start : notInsertableSince,
      stoppedAt: n,
    };
  };
  /** The scan lost track at the token starting at `start`. */
  const giveUpAt = (start: number): HtmlScanResult => {
    emitMarkup("unparsed", start, n);
    return {
      insertionPoint: notInsertableSince === -1 ? start : notInsertableSince,
      stoppedAt: start,
    };
  };
  const isForeignCode = (element: OpenElement): boolean =>
    element.namespace !== "html" && (element.name === "script" || element.name === "style");
  const push = (element: OpenElement): void => {
    if (stack.length >= MAX_TRACKED_DEPTH) {
      lost = true;
      return;
    }
    stack.push(element);
    if (isForeignCode(element)) foreignCodeDepth++;
  };

  /**
   * Pop open elements down to and including `index`, for the end tag token
   * spanning `tokenStart` to `end`. The element at `index` is closed by that
   * token when `closesTarget`; everything above it is closed implicitly, so
   * it ends where the token starts.
   */
  const popTo = (index: number, tokenStart: number, end: number, closesTarget: boolean): void => {
    const where = context();
    const popped = stack.splice(index);
    for (let k = popped.length - 1; k >= 0; k--) {
      const entry = popped[k];
      if (entry.namespace === "html") {
        if (entry.name === "template") closeTemplate();
        else if (isPreformatted(entry.name)) closePreformattedElement(entry.name);
        else if (entry.name === "table") closeTable();
      } else {
        if (isForeignCode(entry)) foreignCodeDepth--;
        reportForeignScript(entry, k === 0 && closesTarget ? end : tokenStart, true, where);
      }
    }
  };

  /** Pop foreign elements until an HTML element or integration point is current. */
  const breakOutOfForeignContent = (tokenStart: number): void => {
    const where = context();
    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      if (current.namespace === "html" || current.integrationPoint !== NOT_AN_INTEGRATION_POINT) return;
      stack.pop();
      if (isForeignCode(current)) foreignCodeDepth--;
      reportForeignScript(current, tokenStart, true, where);
    }
  };

  /** Tree construction dispatcher for a start tag: HTML rules or foreign content rules. */
  const startTagUsesHtmlRules = (name: string): boolean => {
    if (stack.length === 0) return true;
    const current = stack[stack.length - 1];
    if (current.namespace === "html") return true;
    if (current.integrationPoint === MATHML_TEXT_INTEGRATION_POINT) return name !== "mglyph" && name !== "malignmark";
    if (current.namespace === "math" && current.name === "annotation-xml" && name === "svg") return true;
    return current.integrationPoint === HTML_INTEGRATION_POINT;
  };

  const integrationPointOf = (namespace: Namespace, name: string, start: number): number => {
    if (namespace === "svg") {
      return name === "foreignobject" || name === "desc" || name === "title"
        ? HTML_INTEGRATION_POINT
        : NOT_AN_INTEGRATION_POINT;
    }
    if (MATHML_TEXT_INTEGRATION_POINTS.has(name)) return MATHML_TEXT_INTEGRATION_POINT;
    if (name === "annotation-xml") {
      const encoding = readStartTagAttributes(html, start)
        .find((attribute) => attribute.name === "encoding")?.value.toLowerCase();
      if (encoding === "text/html" || encoding === "application/xhtml+xml") return HTML_INTEGRATION_POINT;
    }
    return NOT_AN_INTEGRATION_POINT;
  };

  /** Returns the index to resume at, or -1 when the rest of the input is this element's text. */
  const startHtmlElement = (start: number, tag: ScannedTag): number => {
    const { name } = tag;
    if (selectOpen && UNCERTAIN_IN_SELECT.has(name)) {
      lost = true;
      return tag.end;
    }
    if (name === "select") {
      // A `<select>` inside a select closes it rather than opening another.
      selectOpen = !selectOpen;
    } else if (name === "input" || name === "keygen" || name === "textarea") {
      selectOpen = false;
    } else if (name === "frameset" && templateDepth === 0 && stack.length === 0) {
      // A frameset replaces the body: browsers drop what follows except
      // frames, so nothing after it can be judged or moved.
      lost = true;
      return tag.end;
    }
    if (name === "svg" || name === "math") {
      if (!tag.selfClosing) {
        push({ name, namespace: name, integrationPoint: NOT_AN_INTEGRATION_POINT, start, openTagEnd: tag.end });
      }
      return tag.end;
    }
    if (name === "plaintext") return -1;
    if (RAW_TEXT_ELEMENTS.has(name)) {
      // The self-closing flag is ignored here: `<script/>` still opens a script.
      const close = name === "script" ? findScriptEnd(html, tag.end) : findRawTextEnd(html, tag.end, name);
      const endTag = close === -1 ? undefined : scanTag(html, close + 2);
      if (!endTag || endTag.end === -1) {
        if (name === "script") handlers.script?.({ start, openTagEnd: tag.end, end: n, terminated: false, ...context() });
        return -1;
      }
      if (name === "script") handlers.script?.({ start, openTagEnd: tag.end, end: endTag.end, terminated: true, ...context() });
      rawElement = { name, close, end: endTag.end };
      return endTag.end;
    }
    if (name === "template") openTemplate();
    else if (isPreformatted(name)) openPreformattedElement(name);
    else if (name === "table") openTable();
    // In a select, end tags other than its own are ignored, so `</pre>` may not close the `<pre>` either.
    if ((SCOPE_BOUNDARY_ELEMENTS.has(name) || name === "select") && openPreformatted > 0) preformatted().sticky = true;
    if (stack.length > 0 && !VOID_ELEMENTS.has(name)) {
      push({ name, namespace: "html", integrationPoint: NOT_AN_INTEGRATION_POINT, start, openTagEnd: tag.end });
    }
    return tag.end;
  };

  const startForeignElement = (start: number, tag: ScannedTag): number => {
    const { name } = tag;
    const breaksOut = BREAKOUT_ELEMENTS.has(name) ||
      (name === "font" && readStartTagAttributes(html, start)
        .some((attribute) => attribute.name === "color" || attribute.name === "face" || attribute.name === "size"));
    if (breaksOut) {
      breakOutOfForeignContent(start);
      return startHtmlElement(start, tag);
    }
    if (tag.selfClosing) {
      if (name === "script") handlers.script?.({ start, openTagEnd: tag.end, end: tag.end, terminated: true, ...context() });
      return tag.end;
    }
    const namespace = stack[stack.length - 1].namespace;
    push({ name, namespace, integrationPoint: integrationPointOf(namespace, name, start), start, openTagEnd: tag.end });
    return tag.end;
  };

  /**
   * HTML rules for an end tag ("in body"), walking the open elements tracked
   * since entering foreign content. Integration points (and MathML
   * `annotation-xml`) are special and scope boundaries, so the walk stops at
   * them; other foreign elements are passed over.
   */
  const endElementWithHtmlRules = (name: string, tokenStart: number, end: number): void => {
    if (name === "template") {
      // `</template>` closes the nearest open template, whatever is inside it.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].namespace === "html" && stack[k].name === "template") {
          popTo(k, tokenStart, end, true);
          return;
        }
      }
      if (templateDepth > 0) {
        popTo(0, tokenStart, end, false);
        closeTemplate();
      }
      return;
    }
    const closesInScope = SCOPED_END_TAGS.has(name);
    for (let k = stack.length - 1; k >= 0; k--) {
      const entry = stack[k];
      if (entry.namespace === "html") {
        if (entry.name === name) {
          popTo(k, tokenStart, end, true);
          return;
        }
        if (closesInScope ? SCOPE_BOUNDARY_ELEMENTS.has(entry.name) : SPECIAL_ELEMENTS.has(entry.name)) return;
      } else if (entry.integrationPoint !== NOT_AN_INTEGRATION_POINT || entry.name === "annotation-xml") {
        return;
      }
    }
    // The walk left the tracked elements, so it continues through the HTML
    // elements around the foreign content, which the scan does not track.
    // A raw text, RCDATA, or void element can never be open around other
    // content, so such an end tag matches nothing and is ignored. Any other
    // end tag may close an outer element, and the foreign content with it.
    // `</body>`, `</html>`, and `</head>` only change the insertion mode, and
    // `</pre>` with no `<pre>` open matches nothing either.
    if (RAW_TEXT_ELEMENTS.has(name) || VOID_ELEMENTS.has(name) || name === "plaintext") return;
    if (name === "body" || name === "html" || name === "head") return;
    if (isPreformatted(name) && preformatted()[name] === 0) return;
    lost = true;
  };

  const endElement = (name: string, tokenStart: number, end: number): void => {
    if (name === "select") selectOpen = false;
    if (stack.length === 0) {
      if (name === "template") closeTemplate();
      else if (isPreformatted(name)) closePreformattedElement(name);
      else if (name === "table") closeTable();
      return;
    }
    if (stack[stack.length - 1].namespace !== "html") {
      // Rules for parsing tokens in foreign content.
      if (name === "br" || name === "p") {
        breakOutOfForeignContent(tokenStart);
        if (name === "p" && stack.length > 0) endElementWithHtmlRules(name, tokenStart, end);
        return;
      }
      for (let k = stack.length - 1; k >= 0 && stack[k].namespace !== "html"; k--) {
        if (stack[k].name === name) {
          popTo(k, tokenStart, end, true);
          return;
        }
      }
      // Reached an HTML element or the bottom: the browser continues with HTML rules.
    }
    endElementWithHtmlRules(name, tokenStart, end);
  };

  let i = html.indexOf("<");
  while (i !== -1) {
    const start = i;
    const next = html.charCodeAt(start + 1);

    if (isAsciiAlpha(next)) {
      const tag = scanTag(html, start + 1);
      if (tag.end === -1) return endAt(start);
      const wasInsertable = isInsertable();
      // Text before the tag carries the context it was parsed in.
      flushText(start);
      rawElement = null;
      const resume = startTagUsesHtmlRules(tag.name) ? startHtmlElement(start, tag) : startForeignElement(start, tag);
      if (lost) return giveUpAt(start);
      if (resume === -1) return endAt(start);
      emitMarkup("tag", start, tag.end, tag.name);
      if (rawElement) {
        const { name, close, end } = rawElement;
        emitMarkup("raw", tag.end, close, name);
        emitMarkup("tag", close, end, name, true);
      }
      if (wasInsertable && !isInsertable()) notInsertableSince = start;
      i = html.indexOf("<", resume);
      continue;
    }

    if (next === SLASH) {
      const afterSlash = html.charCodeAt(start + 2);
      if (isAsciiAlpha(afterSlash)) {
        const tag = scanTag(html, start + 2);
        if (tag.end === -1) return endAt(start);
        const wasInsertable = isInsertable();
        flushText(start);
        endElement(tag.name, start, tag.end);
        if (lost) return giveUpAt(start);
        emitMarkup("tag", start, tag.end, tag.name, true);
        const nowInsertable = isInsertable();
        if (wasInsertable && !nowInsertable) notInsertableSince = start;
        else if (!wasInsertable && nowInsertable) notInsertableSince = -1;
        i = html.indexOf("<", tag.end);
        continue;
      }
      if (afterSlash === GT) {
        // `</>` is dropped.
        emitMarkup("markup", start, start + 3);
        i = html.indexOf("<", start + 3);
        continue;
      }
      // `</` at the end of input is text, but markup appended after it would
      // open a bogus comment, so the input is not appendable from here.
      if (start + 2 >= n) return endAt(start);
      // Any other `</` opens a bogus comment that ends at `>`.
      const close = html.indexOf(">", start + 2);
      if (close === -1) return endAt(start);
      emitMarkup("markup", start, close + 1);
      i = html.indexOf("<", close + 1);
      continue;
    }

    if (next === BANG) {
      if (html.startsWith("--", start + 2)) {
        const end = findCommentEnd(html, start);
        handlers.comment?.({ start, end: end === -1 ? n : end, terminated: end !== -1, ...context() });
        if (end === -1) return endAt(start);
        emitMarkup("markup", start, end);
        i = html.indexOf("<", end);
        continue;
      }
      const current = stack[stack.length - 1];
      if (current && current.namespace !== "html" && html.startsWith("[CDATA[", start + 2)) {
        // Parsers disagree on CDATA directly inside an integration point
        // (`<svg><title><![CDATA[`), so the scan stops there.
        if (current.integrationPoint !== NOT_AN_INTEGRATION_POINT) return giveUpAt(start);
        // A CDATA section is text in foreign content.
        const close = html.indexOf("]]>", start + 9);
        if (close === -1) return endAt(start);
        emitMarkup("markup", start, close + 3);
        i = html.indexOf("<", close + 3);
        continue;
      }
      // DOCTYPE, CDATA in HTML content, and other `<!` constructs end at `>`.
      const close = html.indexOf(">", start + 2);
      if (close === -1) return endAt(start);
      emitMarkup("markup", start, close + 1);
      i = html.indexOf("<", close + 1);
      continue;
    }

    if (next === QUESTION) {
      const close = html.indexOf(">", start + 2);
      if (close === -1) return endAt(start);
      emitMarkup("markup", start, close + 1);
      i = html.indexOf("<", close + 1);
      continue;
    }

    // `<` followed by anything else is text.
    i = html.indexOf("<", start + 1);
  }
  return endAt(n);
};

/** Output that ends with a pending `<` or an unfinished character reference. */
const PENDING_LOOKAHEAD_RE = /(?:<|&[#0-9A-Za-z]*)$/;

/** An empty comment: parsed as nothing, and it ends any pending `<` or `&` lookahead. */
export const SEAM_SEPARATOR = "<!---->";

/**
 * Remove `ranges` (each a complete comment or element that the scan found in
 * ordinary content) from `html`. The text around a removed range never joins
 * into new markup: where the kept text ends with a `<` that is text only
 * because markup followed it, or with an unfinished character reference such
 * as `&am`, the range is replaced with {@link SEAM_SEPARATOR}.
 *
 * Ranges may arrive in any order; a range inside or overlapping an earlier
 * one is dropped. `index` (an offset into `html`) is mapped to the output and
 * returned, so callers can keep an insertion point across the removal.
 *
 * A range with `separate` set (one removed from inside a table) is always
 * replaced with the separator, so the text runs on either side stay apart.
 */
export const removeHtmlRanges = (
  html: string,
  ranges: readonly (HtmlRange & { separate?: boolean })[],
  index: number = html.length,
): { html: string; index: number } => {
  if (ranges.length === 0) return { html, index };
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: string[] = [];
  // The last characters written, which is all the lookahead check needs.
  let tail = "";
  let length = 0;
  let cursor = 0;
  let mappedIndex = -1;
  const write = (text: string): void => {
    if (!text) return;
    parts.push(text);
    length += text.length;
    tail = (tail + text).slice(-64);
  };
  for (const range of sorted) {
    if (range.start < cursor) continue;
    if (mappedIndex === -1 && index <= range.start) mappedIndex = length + Math.max(0, index - cursor);
    write(html.slice(cursor, range.start));
    if (range.separate || PENDING_LOOKAHEAD_RE.test(tail)) write(SEAM_SEPARATOR);
    cursor = range.end;
  }
  if (mappedIndex === -1) mappedIndex = length + Math.max(0, index - cursor);
  write(html.slice(cursor));
  return { html: parts.join(""), index: mappedIndex };
};
