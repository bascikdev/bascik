import {
  createElementScanner,
  isRegexWhitespace,
  type ElementContentMatch,
  type ElementScanner,
} from "./element-content-scan.ts";
import { findCommentEnd } from "./html-scanner.ts";
import {
  createAttributeValueScanner,
  stepAttributeValueState,
  type AttributeScanState,
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

/**
 * Where the masker's tag reading stands: the attribute-value scanner's state
 * (`createAttributeValueScanner`), with its quote in the quoted state. It
 * decides whether a `<!--` is a comment.
 */
interface TagState {
  state: AttributeScanState;
  quote: string;
}

const TEXT_STATE: TagState = { state: "text", quote: "" };

const sameTagState = (a: TagState, b: TagState): boolean =>
  a.state === b.state && (a.state !== "quoted" || a.quote === b.quote);
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
  origin: TagState = TEXT_STATE,
  commentsOn = true,
): {
  masked: string;
  starts: number[];
  ends: number[];
  /** The `<!--` of the comment with no end, or -1. */
  openCommentAt: number;
  /** The tag state at the end, when `wantEndState`. */
  endState: TagState;
} => {
  const starts: number[] = [];
  const ends: number[] = [];
  let comments = commentsOn && html.includes("<!--");
  const raw = HAS_RAW_TAG.test(html);
  // Whether a position is inside a tag, read from `tagsFrom`, the end of the
  // last region that started in text (a region ends in text), or from the
  // start in the `origin` state.
  let tagsFrom = 0;
  let tags: AttributeValueScanner | undefined;
  const tagStateAt = (at: number): TagState => {
    tags ??= createAttributeValueScanner(
      html,
      tagsFrom === 0
        ? { cursor: 0, state: origin.state, quote: origin.quote }
        : { cursor: tagsFrom, state: "text", quote: "" },
    );
    tags.isInsideValue(at);
    const { state, quote } = tags.checkpoint();
    return { state, quote };
  };
  const insideTag = (at: number): boolean => tagStateAt(at).state !== "text";
  const endState = (): TagState =>
    wantEndState ? tagStateAt(html.length) : TEXT_STATE;
  if (!comments && !raw)
    return {
      masked: html,
      starts,
      ends,
      openCommentAt: -1,
      endState: endState(),
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
  let openCommentAt = -1;
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
        openCommentAt = commentAt;
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
    openCommentAt,
    endState: endState(),
  };
};

// Every place a raw-text match could start: a raw-text name followed by a
// character `\b` passes for (outside [A-Za-z0-9_]) or by the end of input. A
// `<!--` outside every region is either inside a tag, which does not depend on
// what follows, or an unclosed comment, which `openCommentAt` reports.
const OPENER = /<(?:script|style|textarea)(?![A-Za-z0-9_])/gi;
const OPENER_AT = /<(?:script|style|textarea)(?![A-Za-z0-9_])/iy;

// The end of a segment is unsafe when it could be the start of an opener that
// the following text completes (`<scr` + `ipt>`).
const PARTIAL_OPENER_AT_END =
  /<(?:!-?-?|s(?:c(?:r(?:i(?:pt?)?)?)?|t(?:y(?:le?)?)?)?|t(?:e(?:x(?:t(?:a(?:r(?:ea?)?)?)?)?)?)?)?$/i;

/**
 * What text left open before a position, by the first position of each: a
 * raw-text opener with no element (`script`, `style`, `textarea`), and a
 * comment with no end (`comment`), after which comments are not looked for.
 * Each stays open in a longer text only while no closer for it follows (see
 * `MaskFacts`): then it never becomes a region, and the mask after it is the
 * mask without it.
 */
export interface PendingOpeners {
  script?: number;
  style?: number;
  textarea?: number;
  comment?: number;
}

type PendingKind = keyof PendingOpeners;
const PENDING_KINDS: readonly PendingKind[] = [
  "script",
  "style",
  "textarea",
  "comment",
];

/**
 * The masker's state at `at`, as it reads a page from the start: every
 * comment and raw-text element that starts before `at` ends at or before it,
 * except the `pending` ones, which the text before `at` does not close; and
 * it reads the tag state `tag` (with `quote`) there. It holds for any page
 * with the same text before `at` in which no closer follows a pending opener
 * (`staysOpen`), which every use checks: the mask of such a page from `at` on
 * is the mask of that text read from this state. A page in which one follows
 * falls back to a whole re-mask, and the checkpoint stays, so the next
 * splice resumes there instead of reading the page from the start.
 */
export interface MaskCheckpoint {
  readonly at: number;
  readonly tag: AttributeScanState;
  readonly quote: string;
  readonly pending: Readonly<PendingOpeners>;
}

/** A checkpoint at `at` in text with nothing open: a closed prefix. */
const textCheckpoint = (at: number): MaskCheckpoint => ({
  at,
  tag: "text",
  quote: "",
  pending: {},
});

const shiftPending = (pending: PendingOpeners, by: number): PendingOpeners => {
  const shifted: PendingOpeners = {};
  for (const kind of PENDING_KINDS) {
    const at = pending[kind];
    if (at !== undefined) shifted[kind] = at + by;
  }
  return shifted;
};

/** `before` with each kind it lacks taken from `after` (the first one wins). */
const mergePending = (
  before: Readonly<PendingOpeners>,
  after: PendingOpeners,
): PendingOpeners => {
  const merged: PendingOpeners = { ...before };
  for (const kind of PENDING_KINDS)
    if (merged[kind] === undefined && after[kind] !== undefined)
      merged[kind] = after[kind];
  return merged;
};

const hasPending = (pending: Readonly<PendingOpeners>): boolean =>
  PENDING_KINDS.some((kind) => pending[kind] !== undefined);

/**
 * Mask `text` read from `origin` (with comments no longer looked for after an
 * unclosed one when `commentsOff`), and report what it leaves open: the tag
 * state at its end, the pending openers (relative to `text`), and whether a
 * partial opener ends it.
 */
const resolveSlice = (
  text: string,
  origin: TagState = TEXT_STATE,
  commentsOff = false,
): {
  masked: string;
  endState: TagState;
  pending: PendingOpeners;
  tail: boolean;
} => {
  __componentScanStatsForTests.closureBytesChecked += text.length;
  const { masked, starts, ends, openCommentAt, endState } = maskInDocumentOrder(
    text,
    true,
    origin,
    !commentsOff,
  );
  const pending: PendingOpeners = {};
  if (openCommentAt !== -1) pending.comment = openCommentAt;
  let region = 0;
  OPENER.lastIndex = 0;
  for (
    let opener = OPENER.exec(text);
    opener !== null;
    opener = OPENER.exec(text)
  ) {
    while (region < ends.length && ends[region] <= opener.index) region++;
    if (region >= starts.length || opener.index < starts[region]) {
      // An opener outside every region: one with no element.
      const kind = opener[0].slice(1).toLowerCase() as PendingKind;
      pending[kind] ??= opener.index;
      OPENER.lastIndex = opener.index + 1;
      continue;
    }
    // Openers inside a region are its text; skip to the region's end.
    OPENER.lastIndex = Math.max(opener.index + 1, ends[region]);
  }
  return {
    masked,
    endState,
    pending,
    tail: PARTIAL_OPENER_AT_END.test(text.slice(-9)),
  };
};

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
  const { masked, endState, pending, tail } = resolveSlice(htmlString);
  return {
    masked,
    closed: endState.state === "text" && !hasPending(pending) && !tail,
  };
};

const PARTIAL_OPENER_LENGTH = 9; // `<textarea`
const RAW_TEXT_NAME_AT = /^<(?:script|style|textarea)/i;

// `[a-zA-Z/!?]`: a `<` before one of these starts a tag (or a comment).
const isTagStartCode = (code: number): boolean =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 47 ||
  code === 33 ||
  code === 63;

/**
 * Whether `head`, the text that follows `body[0, at)`, completes a token a
 * `<` in the last few characters before `at` starts: a `<!--`, a raw-text
 * opener's name (or the character after it, which decides whether it is
 * one), or, for a `<` right before `at`, a tag (the tokenizer reads `<`
 * before `[a-zA-Z/!?]` as one, and a `<!--` inside it is not a comment).
 * Conservative: true whenever such a token reaches `at`. When false, a
 * prefix that is closed but for a partial opener at its end masks the same
 * followed by `head` as on its own.
 */
const completesOpener = (body: string, at: number, head: string): boolean => {
  if (head.length === 0) return false;
  const from = Math.max(0, at - PARTIAL_OPENER_LENGTH);
  const joint = at - from;
  const joined =
    body.slice(from, at) + head.slice(0, PARTIAL_OPENER_LENGTH + 1);
  for (
    let index = joined.indexOf("<");
    index !== -1 && index < joint;
    index = joined.indexOf("<", index + 1)
  ) {
    if (index === joint - 1) return isTagStartCode(joined.charCodeAt(joint));
    const rest = joined.slice(index);
    if (rest.startsWith("<!--")) {
      if (index + 4 > joint) return true;
      continue;
    }
    const name = RAW_TEXT_NAME_AT.exec(rest);
    // The opener's name, or the character after it, is in `head`.
    if (name && index + name[0].length >= joint) return true;
  }
  return false;
};

/**
 * Where the tokens that could close a pending opener last start in a page:
 * a closer as the masker's element scanner reads it (`</script\s*>`,
 * `</style\s*>` or `</textarea\s*>`, any case) for a raw-text opener, `-->`
 * or `--!>` for a comment. Unknown (`last` undefined) until a pending opener
 * needs it, then found once and kept up to date across splices by
 * `spliceRawTextMask`, which reads it as an upper bound (a script closer the
 * escape states skip still counts). Reset it (or pass a fresh one) whenever
 * the page changes some other way.
 */
export interface MaskFacts {
  last?: Record<PendingKind, number>;
}

// `\s` is the white space `isRegexWhitespace` accepts.
const CLOSER_TOKEN = /<\/(script|style|textarea)\s*>|--!?>/gi;

/** The start of the last closer token of each kind in `text`, plus `offset`. */
const lastClosers = (
  text: string,
  offset = 0,
  into: Record<PendingKind, number> = {
    script: -1,
    style: -1,
    textarea: -1,
    comment: -1,
  },
): Record<PendingKind, number> => {
  CLOSER_TOKEN.lastIndex = 0;
  for (
    let token = CLOSER_TOKEN.exec(text);
    token !== null;
    token = CLOSER_TOKEN.exec(text)
  ) {
    const kind = (token[1]?.toLowerCase() ?? "comment") as PendingKind;
    into[kind] = Math.max(into[kind], token.index + offset);
    // Tokens overlap (`--->`): look again from the next character.
    CLOSER_TOKEN.lastIndex = token.index + 1;
  }
  return into;
};

/** `</textarea`, the longest closer before its white space. */
const CLOSER_REACH = 10;

/**
 * How far a white-space run is followed at a seam (`spliceWindow`) before the
 * caller is told to assume a token there.
 */
const WINDOW_WALK = 4096;

/** A `</name` and white space up to the end of a string, from its `</`. */
const OPEN_CLOSE_AT_END = /<\/[A-Za-z][\w:-]*\s*$/y;

/**
 * The page `body` with `body[start, end)` replaced by `replacement`, and the
 * part of it around the replacement that holds every token touching the
 * replacement or either seam: `{ from, text }`, `text` starting at `from` in
 * the new page. Tokens are closers shaped `</name\s*>`, whose `</name` is at
 * most `reach` characters long, or tokens of at most `reach` characters with
 * no white space (`-->`). Every other token of the new page lies wholly
 * before `start`, as it was, or wholly after the replacement, where it was
 * after `end`. Null when a white-space run longer than `WINDOW_WALK` might
 * belong to such a token: the caller then assumes one at the replacement's
 * end. The cost is the window's length, plus white space that a token could
 * run through.
 */
export const spliceWindow = (
  body: string,
  start: number,
  end: number,
  replacement: string,
  reach: number,
): { from: number; text: string } | null => {
  const after = start + replacement.length;
  const shift = end - after;
  const length = body.length - shift;
  const codeAt = (index: number): number =>
    index < start
      ? body.charCodeAt(index)
      : index < after
        ? replacement.charCodeAt(index - start)
        : body.charCodeAt(index + shift);
  const slice = (from: number, to: number): string =>
    (from < start ? body.slice(from, Math.min(to, start)) : "") +
    (to > start && from < after
      ? replacement.slice(
          Math.max(from, start) - start,
          Math.min(to, after) - start,
        )
      : "") +
    (to > after ? body.slice(Math.max(from, after) + shift, to + shift) : "");
  let from = Math.max(0, start - reach);
  // A token whose `</name` ends further back reaches the replacement only
  // through white space up to `start`, and on to a `>` at or after it.
  if (start > 0 && isRegexWhitespace(codeAt(start - 1))) {
    let gt = start;
    while (
      gt < length &&
      gt - start <= WINDOW_WALK &&
      isRegexWhitespace(codeAt(gt))
    )
      gt++;
    if (gt - start > WINDOW_WALK || (gt < length && codeAt(gt) === 0x3e)) {
      let run = start - 1;
      while (run > 0 && isRegexWhitespace(body.charCodeAt(run - 1))) {
        run--;
        if (start - run > WINDOW_WALK) return null;
      }
      from = Math.max(0, Math.min(from, run - reach));
    }
  }
  // A token that starts before the replacement's end and is still open at
  // `until` goes on through white space to its `>`.
  const headEnd = Math.min(length, after + reach);
  const head = slice(from, headEnd);
  // Such a token holds no `<` after its own: it starts at the last `</`.
  const openAt = head.lastIndexOf("</");
  let until = headEnd;
  OPEN_CLOSE_AT_END.lastIndex = openAt;
  if (openAt !== -1 && from + openAt < after && OPEN_CLOSE_AT_END.test(head)) {
    while (until < length && isRegexWhitespace(codeAt(until))) {
      until++;
      if (until - headEnd > WINDOW_WALK) return null;
    }
  }
  until = Math.min(length, until + 1);
  return { from, text: head + slice(headEnd, until) };
};

/**
 * How far before a splice an earlier checkpoint must be to stay valid
 * through it: past `</textarea`, the longest partial token, plus a margin.
 */
const SEAM = 16;

/** Whether no closer for any of `pending` follows its opener in the page `last` describes. */
const staysOpen = (
  pending: Readonly<PendingOpeners>,
  last: Record<PendingKind, number>,
): boolean =>
  PENDING_KINDS.every((kind) => {
    const at = pending[kind];
    if (at === undefined) return true;
    // A comment's own `<!--` can read as `--!>` or `-->` from its third
    // character; the tokenizer looks for its end from its fifth.
    return last[kind] < (kind === "comment" ? at + 2 : at);
  });

/**
 * How far the text after a splice is followed, beyond the spliced lengths,
 * for the old and new tag states to agree before giving up.
 */
const RESYNC_SLACK = 256;

/**
 * Update `masked` (the mask of `body`) after `body[start, end)` is replaced by
 * `replacement`, without re-masking the whole page. `from` is a checkpoint at
 * or before `start` (`MaskCheckpoint`; a number `n` is a closed prefix
 * `body[0, n)`, -1 or null none known).
 *
 * The masker is resumed: the text from the checkpoint to `start`, the
 * replaced text, and the replacement are each masked from the state the page
 * leaves them in, and the old mask after the replaced text is kept once the
 * old and new readings of the text after it agree, which they do at once
 * unless the two leave a tag in different states, and otherwise usually at
 * the next `>` or closing quote. Every comment and raw-text element must end
 * inside the part it starts in, or stay open for good (`MaskFacts`); a token
 * cut by the splice falls back. The cost is the length of those parts plus
 * the resync distance.
 *
 * `masked` is null when the page must be re-masked whole. `checkpoint` is the
 * state at `start` once the text before it is read (else, when a partial
 * opener meets the splice, an earlier one still valid, or null for none):
 * after a fallback it may hold an opener a later closer ends, so the next
 * splice falls back again having read only the text since. `endCheckpoint`,
 * on success, is the state after the replacement. `facts` is updated to the new
 * page in every case. `closedThrough` and `closedEnd` are their positions
 * (-1 for none).
 */
export const spliceRawTextMask = (
  body: string,
  masked: string,
  start: number,
  end: number,
  replacement: string,
  from: MaskCheckpoint | number | null,
  facts: MaskFacts = {},
): {
  masked: string | null;
  checkpoint: MaskCheckpoint | null;
  endCheckpoint?: MaskCheckpoint;
  closedThrough: number;
  closedEnd?: number;
} => {
  const checkpoint =
    typeof from === "number" ? (from >= 0 ? textCheckpoint(from) : null) : from;
  const oldLast = (): Record<PendingKind, number> =>
    (facts.last ??= lastClosers(body));
  // The facts for the new page: the old ones moved past the splice, with the
  // tokens around and inside the replacement. An upper bound stays one.
  let newLastCache: Record<PendingKind, number> | undefined;
  const newLast = (): Record<PendingKind, number> => {
    if (newLastCache) return newLastCache;
    const old = oldLast();
    const delta = replacement.length - (end - start);
    const moved = {} as Record<PendingKind, number>;
    for (const kind of PENDING_KINDS)
      moved[kind] =
        old[kind] >= end ? old[kind] + delta : Math.min(old[kind], start - 1);
    const window = spliceWindow(body, start, end, replacement, CLOSER_REACH);
    if (window === null) {
      const assumed = start + replacement.length;
      for (const kind of PENDING_KINDS)
        moved[kind] = Math.max(moved[kind], assumed);
      newLastCache = moved;
    } else newLastCache = lastClosers(window.text, window.from, moved);
    return newLastCache;
  };
  const finish = (result: {
    masked: string | null;
    checkpoint: MaskCheckpoint | null;
    endCheckpoint?: MaskCheckpoint;
  }) => {
    // Keep known facts current for the page the caller builds next.
    if (facts.last) facts.last = newLast();
    return {
      ...result,
      closedThrough: result.checkpoint ? result.checkpoint.at : -1,
      ...(result.endCheckpoint ? { closedEnd: result.endCheckpoint.at } : {}),
    };
  };
  if (!checkpoint || checkpoint.at > start)
    return finish({ masked: null, checkpoint: null });
  // The prefix may end in a partial opener that the text after it does not
  // complete, before the splice (so the old mask is the prefix's own) and
  // after it. Checked on the page, not the slice: the partial opener can
  // start before the checkpoint.
  // The text after it in the new page is the replacement, and after a short
  // one the text after the replaced part. An earlier checkpoint stays valid
  // when the splice leaves the text right after it.
  if (
    completesOpener(body, start, body.slice(start, start + 10)) ||
    completesOpener(
      body,
      start,
      replacement.length >= 10
        ? replacement
        : replacement + body.slice(end, end + 10),
    )
  )
    return finish({
      masked: null,
      checkpoint: checkpoint.at + SEAM <= start ? checkpoint : null,
    });

  const commentsOff = checkpoint.pending.comment !== undefined;
  // The text from the checkpoint to the splice.
  const prefix = resolveSlice(
    body.slice(checkpoint.at, start),
    { state: checkpoint.tag, quote: checkpoint.quote },
    commentsOff,
  );
  const pendingAtStart = mergePending(
    checkpoint.pending,
    shiftPending(prefix.pending, checkpoint.at),
  );
  const startState = prefix.endState;
  // The state at the splice, in the old page and the new one alike: the text
  // before it is the same, and what it leaves open each use checks.
  const atStart: MaskCheckpoint = {
    at: start,
    tag: startState.state,
    quote: startState.quote,
    pending: pendingAtStart,
  };
  const fail = () => finish({ masked: null, checkpoint: atStart });
  if (hasPending(pendingAtStart) && !staysOpen(pendingAtStart, oldLast()))
    return fail();
  const startOff = pendingAtStart.comment !== undefined;
  // Whether the replacement closes nothing the text before it leaves open.
  const startValid = (): boolean =>
    !hasPending(pendingAtStart) || staysOpen(pendingAtStart, newLast());

  const replaced = resolveSlice(body.slice(start, end), startState, startOff);
  if (
    replaced.tail ||
    (hasPending(replaced.pending) &&
      !staysOpen(shiftPending(replaced.pending, start), oldLast()))
  )
    return fail();
  const inserted = resolveSlice(replacement, startState, startOff);
  if (!startValid()) return fail();
  const insertedPending = shiftPending(inserted.pending, start);
  if (
    inserted.tail ||
    (hasPending(insertedPending) && !staysOpen(insertedPending, newLast()))
  )
    return fail();
  const pendingAtEnd = mergePending(pendingAtStart, insertedPending);

  // The text after the splice: its mask is the old one once both readings of
  // its tags agree, before anything there that could start a region (a
  // comment's reading depends on the tag state, and an element's on whether
  // it starts in one). With a comment left open on either side, no comment
  // after it can end, so the tag state no longer matters.
  if (
    pendingAtEnd.comment === undefined &&
    replaced.pending.comment === undefined
  ) {
    let before = replaced.endState;
    let after = inserted.endState;
    const limit = end + RESYNC_SLACK + (end - start) + replacement.length;
    for (let index = end; !sameTagState(before, after); index++) {
      if (index >= body.length) break;
      if (index >= limit) return fail();
      if (body.charCodeAt(index) === 0x3c) {
        OPENER_AT.lastIndex = index;
        if (body.startsWith("<!--", index) || OPENER_AT.test(body))
          return fail();
      }
      before = stepAttributeValueState(body, index, before.state, before.quote);
      after = stepAttributeValueState(body, index, after.state, after.quote);
    }
  }

  return finish({
    masked: masked.slice(0, start) + inserted.masked + masked.slice(end),
    checkpoint: atStart,
    endCheckpoint: {
      at: start + replacement.length,
      tag: inserted.endState.state,
      quote: inserted.endState.quote,
      pending: pendingAtEnd,
    },
  });
};
