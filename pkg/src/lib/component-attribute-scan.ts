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
 * Scan the attributes of one opening tag string (the text between `<` and
 * `>`).  Following the WHATWG tokenizer states, a quote delimits a value only
 * after `=`, so a token that merely looks like an attribute inside another
 * attribute's quoted value (e.g. `data-bascik-prop-x` inside `title=...`) is
 * never reported as an attribute.  Returns the attributes in document order.
 */
export const scanWholeAttributes = (openTag: string): ScannedAttribute[] => {
  const attrs: ScannedAttribute[] = [];
  // Skip the `<` and the tag name: the first attribute can start anywhere
  // after the name (whitespace or directly, as in `<div/disabled>`).
  let i = 0;
  const n = openTag.length;
  if (n > 0 && openTag.charCodeAt(0) === 60 /* < */) i = 1;
  while (i < n && !/[\s/>]/.test(openTag[i])) i++;
  while (i < n) {
    while (i < n && /[\s/]/.test(openTag[i])) i++;
    if (i >= n || openTag[i] === ">") break;
    const nameStart = i;
    while (i < n && !/[\s=/>]/.test(openTag[i])) i++;
    const nameEnd = i;
    let valueStart = -1;
    let valueEnd = -1;
    let attrEnd = nameEnd;
    while (i < n && /[\s]/.test(openTag[i])) i++;
    if (i < n && openTag[i] === "=") {
      i++;
      while (i < n && /[\s]/.test(openTag[i])) i++;
      if (i < n && (openTag[i] === '"' || openTag[i] === "'")) {
        const quote = openTag[i];
        i++;
        valueStart = i;
        while (i < n && openTag[i] !== quote) i++;
        valueEnd = i;
        if (i < n) i++; // past the closing quote
      } else {
        // Unquoted value: characters other than whitespace, quotes, `=`, `<`,
        // `>`, and backtick. `/` is allowed (e.g. `path=/about`).
        valueStart = i;
        while (i < n && !/[\s"'=<>`]/.test(openTag[i])) i++;
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
  return attrs;
};

type AttributeScanState =
  "text" | "tag" | "before-value" | "quoted" | "unquoted";

/**
 * Tokenizer state after reading `html[0, cursor)`. It also depends on
 * `html[cursor]` (the peek after a `<`), so it is valid for any string that
 * shares `html[0, cursor]`.
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

// `[a-zA-Z/!?]`; NaN past the end is false.
const isTagStartCode = (code: number): boolean =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 47 ||
  code === 33 ||
  code === 63;

/**
 * Answers whether a position in masked HTML falls inside an attribute value.
 * Queries in increasing order cost one pass in total; an earlier query
 * restarts from `origin` (or offset zero before it).
 */
export const createAttributeValueScanner = (
  html: string,
  origin: AttributeValueCheckpoint = SCAN_START,
) => {
  let { cursor, state, quote } = origin;
  const advance = (index: number): void => {
    __componentScanStatsForTests.attributeValueBytesScanned += index - cursor;
    while (cursor < index) {
      if (state === "text") {
        const open = html.indexOf("<", cursor);
        if (open === -1 || open >= index) {
          cursor = index;
          return;
        }
        if (isTagStartCode(html.charCodeAt(open + 1))) state = "tag";
        cursor = open + 1;
        continue;
      }
      if (state === "quoted") {
        const close = html.indexOf(quote, cursor);
        if (close === -1 || close >= index) {
          cursor = index;
          return;
        }
        state = "tag";
        cursor = close + 1;
        continue;
      }
      const code = html.charCodeAt(cursor);
      if (state === "unquoted") {
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
  return {
    isInsideValue(index: number): boolean {
      if (index < cursor)
        ({ cursor, state, quote } =
          index >= origin.cursor ? origin : SCAN_START);
      if (cursor < index) advance(index);
      return (
        state === "quoted" || state === "unquoted" || state === "before-value"
      );
    },
    checkpoint: (): AttributeValueCheckpoint => ({ cursor, state, quote }),
  };
};

export type AttributeValueScanner = ReturnType<
  typeof createAttributeValueScanner
>;
