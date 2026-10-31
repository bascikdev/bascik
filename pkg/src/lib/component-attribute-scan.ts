import { __componentScanStatsForTests } from "./component-scan-stats.ts";

/**
 * Matches a run of attribute text inside an opening tag, stopping at the
 * first unquoted `>`.  The alternation is unambiguous: a character is either
 * a quote (starting a quoted value) or a non-quote, non-`>` character, so the
 * regex engine never has to explore overlapping parses.  The previous form,
 * `(?:"[^"]*"|'[^']*'|[^>])*`, let `[^>]` also match quote characters, which
 * made the parser ambiguous and caused catastrophic (exponential) backtracking
 * whenever the surrounding pattern could not match — e.g. a `data-bascik-prop-*`
 * marker with no balancing close tag would hang the build.
 */
export const ATTR_VALUE = `(?:[^>"']|"[^"]*"|'[^']*')*`;

/**
 * One attribute of a start tag: the name with its span, plus the value with
 * the raw (still entity-encoded, quote chars included when quoted) text.
 * `valueStart`/`valueEnd` are -1 when the attribute has no value. Span
 * coordinates are relative to the scanned tag string.
 */
export interface ScannedAttribute {
  /** Authored attribute name, case preserved. */
  name: string;
  nameStart: number;
  nameEnd: number;
  /** -1 when the attribute has no value (`disabled`, `data-bascik-slot`). */
  valueStart: number;
  valueEnd: number;
  /** The whole `name=value` span, from name start to value end. */
  start: number;
  end: number;
}

/**
 * What JavaScript's `\s` matches (WhiteSpace and LineTerminator), as a
 * code-unit test: the attribute scan runs per character on every tag, and
 * a one-character regex test per character costs a string and a match.
 */
const isJsSpace = (c: number): boolean =>
  c === 32 ||
  (c >= 9 && c <= 13) ||
  (c > 127 &&
    (c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff));
/** `[\s/>]` */
const isSpaceSlashOrGt = (c: number): boolean =>
  c === 47 || c === 62 || isJsSpace(c);
/** `[\s/]` */
const isSpaceOrSlash = (c: number): boolean => c === 47 || isJsSpace(c);
/** `[\s=/>]` */
const isNameEnd = (c: number): boolean =>
  c === 61 || c === 47 || c === 62 || isJsSpace(c);
/**
 * `[\s>]`: the WHATWG "attribute value (unquoted) state" ends only at
 * whitespace or `>`. Quotes, `=`, `<` and backtick there are parse errors
 * that the browser keeps in the value (`href=/a?b=c`, `title=it's`).
 */
const isUnquotedEnd = (c: number): boolean => c === 62 || isJsSpace(c);

/**
 * Scan the attributes of one opening tag string (the text between `<` and
 * `>`).  Following the WHATWG tokenizer states, a quote delimits a value only
 * after `=`, so a token that merely looks like an attribute inside another
 * attribute's quoted value (e.g. `data-bascik-prop-x` inside `title=...`) is
 * never reported as an attribute.  Returns the attributes in document order.
 */
export const scanWholeAttributes = (openTag: string): ScannedAttribute[] =>
  scanStartTag(openTag).attributes;

/**
 * The length of the start tag at the beginning of `html` (through its `>`),
 * read with the same rules as scanWholeAttributes, or -1 when it has no `>`.
 * A `>` inside a quoted value does not end it, and a quote inside an
 * unquoted value (`title=it's`) does not start one.
 */
export const startTagLength = (html: string): number => scanStartTag(html).end;

const scanStartTag = (
  openTag: string,
): { attributes: ScannedAttribute[]; end: number } => {
  const attrs: ScannedAttribute[] = [];
  // Skip the `<` and the tag name: the first attribute can start anywhere
  // after the name (whitespace or directly, as in `<div/disabled>`).
  let i = 0;
  const n = openTag.length;
  if (n > 0 && openTag.charCodeAt(0) === 60 /* < */) i = 1;
  while (i < n && !isSpaceSlashOrGt(openTag.charCodeAt(i))) i++;
  while (i < n) {
    while (i < n && isSpaceOrSlash(openTag.charCodeAt(i))) i++;
    if (i >= n || openTag[i] === ">") break;
    const nameStart = i;
    // A name may start with `=` (a parse error the browser keeps in the name).
    if (openTag[i] === "=") i++;
    while (i < n && !isNameEnd(openTag.charCodeAt(i))) i++;
    const nameEnd = i;
    let valueStart = -1;
    let valueEnd = -1;
    let attrEnd = nameEnd;
    while (i < n && isJsSpace(openTag.charCodeAt(i))) i++;
    if (i < n && openTag[i] === "=") {
      i++;
      while (i < n && isJsSpace(openTag.charCodeAt(i))) i++;
      if (i < n && (openTag[i] === '"' || openTag[i] === "'")) {
        const quote = openTag[i];
        i++;
        valueStart = i;
        while (i < n && openTag[i] !== quote) i++;
        valueEnd = i;
        if (i < n) i++; // past the closing quote
      } else {
        // Unquoted value: every character up to whitespace or `>`, `/`
        // included (e.g. `path=/about`).
        valueStart = i;
        while (i < n && !isUnquotedEnd(openTag.charCodeAt(i))) i++;
        valueEnd = i;
      }
      attrEnd = i;
    }
    attrs.push({
      name: openTag.slice(nameStart, nameEnd),
      nameStart,
      nameEnd,
      valueStart,
      valueEnd,
      start: nameStart,
      end: attrEnd,
    });
  }
  return { attributes: attrs, end: i < n ? i + 1 : -1 };
};

/**
 * Where the tokenizer stands: in text; inside a tag's name (`name`, where
 * `=` and quotes are name characters, up to tag whitespace, `/` or `>`), at
 * or in an attribute name or between attributes (`tag`), or in an attribute
 * value (`before-value`, `quoted`, `unquoted`); or in a bogus comment
 * (`bogus`), which `<!` (other than `<!--`), `<?`, or `</` before a
 * character that is not a letter opens, and the next `>` ends, quotes or not.
 */
export type AttributeScanState =
  "text" | "name" | "tag" | "before-value" | "quoted" | "unquoted" | "bogus";

/**
 * Tokenizer state after reading `html[0, cursor)`. It also depends on
 * `html[cursor, cursor + 3)` (the peek after a `<`, up to `<!--`), so it is
 * valid for any string that shares `html[0, cursor + 3)`.
 */
export interface AttributeValueCheckpoint {
  readonly cursor: number;
  readonly state: AttributeScanState;
  readonly quote: string;
}

/**
 * Lets a caller resume attribute-value scanning across searches of one
 * document whose text through the checkpoint never changes.
 */
export interface ComponentSearchState {
  attributeCheckpoint?: AttributeValueCheckpoint;
  /**
   * `findMatchingClose` for the searched text and its mask, answering every
   * search in linear total time (`createMatchingCloseFinder`). Only for a
   * caller that never changes the text between searches: a search for each
   * of many unclosed openers otherwise walks to the end of the text from
   * every one of them.
   */
  closeFinder?: (tagName: string, contentStart: number) => number;
  /**
   * Where the last close of `tagName` (`</tagName` before tag whitespace,
   * `/` or `>`, any case) starts in the searched mask, or -1; a later
   * position is allowed (an upper bound). A usage whose content starts after
   * it has no close, so its close is not looked for: an unclosed usage
   * otherwise walks to the end of the text, once per usage.
   */
  lastCloseAt?: (tagName: string) => number;
}

const SCAN_START: AttributeValueCheckpoint = {
  cursor: 0,
  state: "text",
  quote: "",
};

// Matches `/\s/` on one UTF-16 code unit.
const isScanSpace = (code: number): boolean =>
  code === 32 ||
  (code >= 9 && code <= 13) ||
  (code > 127 && /\s/.test(String.fromCharCode(code)));

/** `[a-zA-Z]`; NaN past the end is false. */
const isLetterCode = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/**
 * The state a `<` at `at`, read in text, leads to, as the tokenizer reads
 * it from the characters after it (up to three: `<!--`):
 *
 * - `<` and a letter, or `</` and a letter, starts a tag's name (`name`).
 * - `<!--` starts a comment. The masker resolves comments itself and blanks
 *   their insides, and leaves one with no end as text, so it stays `text`.
 * - `<!`, `<?`, or `</` and anything else but the end of input, starts a
 *   bogus comment (`bogus`) up to the next `>`. `</>` is one with nothing
 *   inside.
 * - A `<` (or `</`) before anything else, or the end of input, is text.
 */
const stateAfterLess = (html: string, at: number): AttributeScanState => {
  const next = html.charCodeAt(at + 1);
  if (isLetterCode(next)) return "name";
  if (next === 63) return "bogus";
  if (next === 33) return html.startsWith("--", at + 2) ? "text" : "bogus";
  if (next !== 47) return "text";
  const after = html.charCodeAt(at + 2);
  if (Number.isNaN(after)) return "text";
  return isLetterCode(after) ? "name" : "bogus";
};

/** `[\t\n\f\r /]`: what ends a tag name and starts the attributes. */
const isTagNameSpaceOrSlash = (code: number): boolean =>
  code === 32 ||
  code === 9 ||
  code === 10 ||
  code === 12 ||
  code === 13 ||
  code === 47;

/** `ahead` before the text or quoted state has looked for its end. */
const NOT_SEARCHED = -2;

/**
 * Answers whether a position in masked HTML falls inside an attribute value
 * (`isInsideValue`) or anywhere inside a tag or bogus comment
 * (`isInsideTag`). The state at a position depends on up to three characters
 * after it (`stateAfterLess`). Queries in increasing order cost one pass in
 * total; an earlier query restarts from `origin` (or offset zero before it).
 */
export const createAttributeValueScanner = (
  html: string,
  origin: AttributeValueCheckpoint = SCAN_START,
) => {
  let { cursor, state, quote } = origin;
  // In the text or quoted state, where that state ends (the next `<`, or
  // the closing quote; -1 for none), once searched. A query that stops
  // short of it leaves the state as it is, and the next query reuses it:
  // searching again from every query (a `<!--` each, in a long quoted
  // value) rescanned the same stretch each time, quadratic in total.
  let ahead = NOT_SEARCHED;
  const advance = (index: number): void => {
    __componentScanStatsForTests.attributeValueBytesScanned += index - cursor;
    while (cursor < index) {
      if (state === "text" || state === "quoted" || state === "bogus") {
        if (ahead === NOT_SEARCHED)
          ahead = html.indexOf(
            state === "text" ? "<" : state === "bogus" ? ">" : quote,
            cursor,
          );
        const end = ahead;
        if (end === -1 || end >= index) {
          cursor = index;
          return;
        }
        ahead = NOT_SEARCHED;
        if (state === "quoted") state = "tag";
        else if (state === "bogus") state = "text";
        else state = stateAfterLess(html, end);
        cursor = end + 1;
        continue;
      }
      const code = html.charCodeAt(cursor);
      if (state === "name") {
        if (code === 62) state = "text";
        else if (isTagNameSpaceOrSlash(code)) state = "tag";
      } else if (state === "unquoted") {
        if (code === 62) state = "text";
        else if (isScanSpace(code)) state = "tag";
      } else if (state === "before-value") {
        if (code === 34 || code === 39) {
          quote = html[cursor];
          state = "quoted";
        } else if (code === 62) state = "text";
        else if (!isScanSpace(code)) state = "unquoted";
      } else if (code === 61) state = "before-value";
      else if (code === 62) state = "text";
      cursor++;
    }
  };
  const moveTo = (index: number): void => {
    if (index < cursor) {
      ({ cursor, state, quote } = index >= origin.cursor ? origin : SCAN_START);
      ahead = NOT_SEARCHED;
    }
    if (cursor < index) advance(index);
  };
  return {
    isInsideValue(index: number): boolean {
      moveTo(index);
      return (
        state === "quoted" || state === "unquoted" || state === "before-value"
      );
    },
    /**
     * Whether `index` is inside a tag (its name, an attribute, or an end tag)
     * or a bogus comment: a `<` there is part of that token, and starts no
     * element of its own.
     */
    isInsideTag(index: number): boolean {
      moveTo(index);
      return state !== "text";
    },
    checkpoint: (): AttributeValueCheckpoint => ({ cursor, state, quote }),
  };
};

/**
 * The scanner's state after one more character, `html[index]`, read in
 * `state` (with `quote` in the quoted state): the transitions `advance`
 * makes, one character at a time, for a caller that follows two readings of
 * the same text until they agree. The peek after a `<` in text is up to
 * `html[index + 3]` (`stateAfterLess`).
 */
export const stepAttributeValueState = (
  html: string,
  index: number,
  state: AttributeScanState,
  quote: string,
): { state: AttributeScanState; quote: string } => {
  const code = html.charCodeAt(index);
  switch (state) {
    case "text":
      return code === 60
        ? { state: stateAfterLess(html, index), quote }
        : { state, quote };
    case "bogus":
      return code === 62 ? { state: "text", quote } : { state, quote };
    case "name":
      if (code === 62) return { state: "text", quote };
      return isTagNameSpaceOrSlash(code)
        ? { state: "tag", quote }
        : { state, quote };
    case "quoted":
      return html[index] === quote ? { state: "tag", quote } : { state, quote };
    case "unquoted":
      if (code === 62) return { state: "text", quote };
      return isScanSpace(code) ? { state: "tag", quote } : { state, quote };
    case "before-value":
      if (code === 34 || code === 39)
        return { state: "quoted", quote: html[index] };
      if (code === 62) return { state: "text", quote };
      return isScanSpace(code)
        ? { state, quote }
        : { state: "unquoted", quote };
    default:
      if (code === 61) return { state: "before-value", quote };
      return code === 62 ? { state: "text", quote } : { state, quote };
  }
};

export type AttributeValueScanner = ReturnType<
  typeof createAttributeValueScanner
>;
