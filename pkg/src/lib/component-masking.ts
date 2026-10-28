import {
  createElementScanner,
  type ElementContentMatch,
  type ElementScanner,
} from "./element-content-scan.ts";
import { findCommentEnd } from "./html-scanner.ts";
import {
  createAttributeValueScanner,
  type AttributeValueScanner,
} from "./component-attribute-scan.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";

/**
 * Return a same-length copy of `htmlString` where HTML comments and the inner content of
 * `<script>`, `<style>`, and `<textarea>` elements are blanked out with
 * spaces. Component-tag searches run against the masked string so literal
 * tag text inside comments or raw-text elements (e.g. `<my-card>` or `<body>`
 * mentioned in a comment, JSON-LD string, or code example) is never resolved
 * as a component or structural tag.
 * Because lengths are preserved, indices found in the masked string are
 * valid in the original.
 */
export const maskRawTextContent = (htmlString: string): string =>
  maskInDocumentOrder(htmlString).masked;

const RAW_TEXT_TAGS = ["script", "style", "textarea"];
const HAS_RAW_TAG = /<(?:script|style|textarea)\b/i;

/**
 * The mask, as the tokenizer reads the page: left to right, whichever of a
 * comment or a raw-text element opens first is resolved first, and its
 * content is text. So a `<!--` inside a script string is not a comment, and
 * a `</style>` inside a comment does not end an earlier stylesheet.
 *
 * - A `<!--` inside a tag (in an attribute value, say) is not a comment, as
 *   the component search reads tags (`createAttributeValueScanner`, started
 *   in text after the last region that began in text). Otherwise a `<!--` in
 *   `<input value="<!--">` would run to a later `--!>` and hide what follows.
 * - A comment ends where the tokenizer ends it (`findCommentEnd`): at the
 *   first `-->` or `--!>`, and `<!-->` and `<!--->` are complete empty
 *   comments. Its inside is blanked; its `<!--` and its closing `-->` or
 *   `--!>` are kept. A comment with no end is left as it is, and comments
 *   are not looked for after it (none can end), as before.
 * - A raw-text element is found as the old
 *   `(<tag(?:\b(?:[^>"']|"[^"]*"|'[^']*')*)?>)([\s\S]*?)(<\/tag\s*>)` regex
 *   found it (element-content-scan.ts), and its content is blanked. A script
 *   follows the tokenizer's escaped script data states, so its legacy
 *   `<!-- ... -->` wrapper with a nested `<script>` string stays whole. An
 *   opener with no closer is left, and the scan goes on after its `<`.
 *
 * Returns the mask, every blanked region's `[start, end)` (whole comment or
 * element) in order, and whether an unclosed comment stopped the comment
 * search. Linear: each scanner is asked for positions that never decrease.
 */
const maskInDocumentOrder = (
  html: string,
  wantEndState = false,
): {
  masked: string;
  starts: number[];
  ends: number[];
  openComment: boolean;
  endsInTag: boolean;
} => {
  const starts: number[] = [];
  const ends: number[] = [];
  let comments = html.includes("<!--");
  const raw = HAS_RAW_TAG.test(html);
  // Whether a position is inside a tag, read from `tagsFrom`, the end of the
  // last region that started in text (a region ends in text).
  let tagsFrom = 0;
  let tags: AttributeValueScanner | undefined;
  const insideTag = (at: number): boolean => {
    tags ??= createAttributeValueScanner(html, {
      cursor: tagsFrom,
      state: "text",
      quote: "",
    });
    tags.isInsideValue(at);
    return tags.checkpoint().state !== "text";
  };
  if (!comments && !raw)
    return {
      masked: html,
      starts,
      ends,
      openComment: false,
      endsInTag: wantEndState && insideTag(html.length),
    };
  const scanners: ElementScanner[] = raw
    ? RAW_TEXT_TAGS.map((tag) =>
        createElementScanner(html, tag, {
          opener: "word-boundary",
          closer: "regex-space",
          scriptEscapes: tag === "script",
        }),
      )
    : [];
  let openComment = false;
  let masked = "";
  let cursor = 0;
  let position = 0;
  let commentAt = -2;
  for (;;) {
    if (comments && (commentAt === -2 || commentAt < position))
      commentAt = html.indexOf("<!--", position);
    if (commentAt === -1) comments = false;
    let element: ElementContentMatch | null = null;
    for (const scanner of scanners) {
      const match = scanner.next(position);
      if (match && (!element || match.start < element.start)) element = match;
    }
    if (comments && (!element || commentAt < element.start)) {
      if (insideTag(commentAt)) {
        commentAt = html.indexOf("<!--", commentAt + 1);
        if (commentAt === -1) comments = false;
        continue;
      }
      const end = findCommentEnd(html, commentAt);
      if (end === -1) {
        comments = false;
        openComment = true;
        continue;
      }
      starts.push(commentAt);
      ends.push(end);
      const closeLength = html.charCodeAt(end - 2) === 0x21 ? 4 : 3;
      const innerLength = end - commentAt - 4 - closeLength;
      if (innerLength > 0) {
        masked += `${html.slice(cursor, commentAt + 4)}${" ".repeat(innerLength)}`;
        cursor = end - closeLength;
      }
      position = end;
      tagsFrom = end;
      tags = undefined;
      continue;
    }
    if (!element) break;
    starts.push(element.start);
    ends.push(element.end);
    masked += `${html.slice(cursor, element.contentStart)}${" ".repeat(element.contentEnd - element.contentStart)}`;
    cursor = element.contentEnd;
    position = element.end;
    // An element whose opener sits inside a tag (an attribute value that
    // reads `<script>`) is masked as before, but the tag goes on around it:
    // the browser sees no element there, so a `<!--` after it is still
    // inside the tag. Only tracked while it can matter.
    if (!((comments || wantEndState) && insideTag(element.start))) {
      tagsFrom = element.end;
      tags = undefined;
    }
  }
  return {
    masked: cursor === 0 ? html : masked + html.slice(cursor),
    starts,
    ends,
    openComment,
    endsInTag: wantEndState && insideTag(html.length),
  };
};

// Every place a raw-text match could start: a raw-text name followed by a
// character `\b` passes for (outside [A-Za-z0-9_]) or by the end of input. A
// `<!--` outside every region is either inside a tag, which does not depend on
// what follows, or an unclosed comment, which `openComment` reports.
const OPENER = /<(?:script|style|textarea)(?![A-Za-z0-9_])/gi;

// The end of a segment is unsafe when it could be the start of an opener that
// the following text completes (`<scr` + `ipt>`).
const PARTIAL_OPENER_AT_END =
  /<(?:!-?-?|s(?:c(?:r(?:i(?:pt?)?)?)?|t(?:y(?:le?)?)?)?|t(?:e(?:x(?:t(?:a(?:r(?:ea?)?)?)?)?)?)?)?$/i;

/**
 * Mask `htmlString` exactly like `maskRawTextContent`, and report whether the
 * string is closed: no comment or tag is left open, every opener lies inside a
 * resolved comment or element (an opener outside them is one with no closer,
 * which more text could complete), and no partial opener ends the string.
 * For a closed string `a`, `maskRawTextContent(a + b)` always equals
 * `masked + maskRawTextContent(b)`, so its mask can be reused as a prefix:
 * every region of `a` is resolved by text inside `a`, and the scan leaves
 * `a` with nothing pending.
 */
export const maskRawTextContentWithClosure = (
  htmlString: string,
): { masked: string; closed: boolean } => {
  __componentScanStatsForTests.closureBytesChecked += htmlString.length;
  const { masked, starts, ends, openComment, endsInTag } = maskInDocumentOrder(
    htmlString,
    true,
  );
  // A string that ends inside a tag decides whether a following `<!--` is a
  // comment, so it is open too.
  if (
    openComment ||
    endsInTag ||
    PARTIAL_OPENER_AT_END.test(htmlString.slice(-9))
  )
    return { masked, closed: false };
  let region = 0;
  OPENER.lastIndex = 0;
  for (
    let opener = OPENER.exec(htmlString);
    opener !== null;
    opener = OPENER.exec(htmlString)
  ) {
    while (region < ends.length && ends[region] <= opener.index) region++;
    if (region >= starts.length || opener.index < starts[region])
      return { masked, closed: false };
    // Openers inside a region are its text; skip to the region's end.
    OPENER.lastIndex = Math.max(opener.index + 1, ends[region]);
  }
  return { masked, closed: true };
};

/**
 * Update `masked` (the mask of `body`) after `body[start, end)` is replaced by
 * `replacement`, without re-masking the whole page. `closedThrough` is a
 * position at or before `start` whose prefix `body[0, closedThrough)` is
 * already known to be closed, or -1 when the prefix is known not to be.
 *
 * `masked` is null when any part (the prefix, the replaced text, or the
 * replacement) is not closed; the caller must then re-mask the whole page.
 * The returned `closedThrough` is `start` when the prefix is closed (the
 * prefix is unchanged by the substitution, so it stays closed for the next
 * one) and -1 when it is not, so later substitutions skip the attempt.
 * On success `closedEnd` is the end of the inserted text: everything before it
 * is closed, so a later splice at or after it can verify from there.
 */
export const spliceRawTextMask = (
  body: string,
  masked: string,
  start: number,
  end: number,
  replacement: string,
  closedThrough: number,
): { masked: string | null; closedThrough: number; closedEnd?: number } => {
  if (closedThrough < 0 || closedThrough > start)
    return { masked: null, closedThrough: -1 };
  if (!maskRawTextContentWithClosure(body.slice(closedThrough, start)).closed)
    return { masked: null, closedThrough: -1 };
  if (!maskRawTextContentWithClosure(body.slice(start, end)).closed)
    return { masked: null, closedThrough: start };
  const inserted = maskRawTextContentWithClosure(replacement);
  if (!inserted.closed) return { masked: null, closedThrough: start };
  return {
    masked: masked.slice(0, start) + inserted.masked + masked.slice(end),
    closedThrough: start,
    closedEnd: start + replacement.length,
  };
};
