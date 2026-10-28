/**
 * Linear-time replacements for the compiler's tag regexes. Since request-time
 * component rendering, script output that can echo request input (`?q=`) goes
 * through these on every request, so each must stay linear in its input. The
 * regexes they replace are quadratic: every opener that cannot reach a `>`,
 * or whose element has no closer, scans to the end of the input, and the
 * regex then retries from the next character.
 *
 * Each scan finds exactly the matches its regex finds, scanning left to
 * right and resuming after each match. Two ideas keep them linear:
 *
 * - The attribute part `(?:[^>"']|"[^"]*"|'[^']*')*>` is a chain: from the
 *   first `>`, `"` or `'`, a quote jumps to the next same quote, then to the
 *   next special character after it, until a `>`. None of its alternatives can
 *   consume `>`, and a quote can only be consumed by its own quoted string, so
 *   the regex's attribute part ends exactly where this chain ends, or nowhere,
 *   and needs no backtracking. Every link is memoized, so each chain is walked
 *   once (`createAttributeScanner`).
 * - Closers are collected by one forward scan, extended only as far as a
 *   lookup needs, and found by binary search.
 */

const GT = 0x3e;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const SLASH = 0x2f;

/** `[A-Za-z0-9_]`, the regex's `\w` without the `u` flag. */
export const isWordCode = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f;

/** The regex's `\s`: ECMAScript WhiteSpace and LineTerminator code units. */
export const isRegexWhitespace = (code: number): boolean =>
  (code >= 0x09 && code <= 0x0d) ||
  code === 0x20 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

/** `[\t\n\f\r ]`: the HTML tokenizer's whitespace (CR before newline normalization). */
export const isTagSpace = (code: number): boolean =>
  code === 0x09 ||
  code === 0x0a ||
  code === 0x0c ||
  code === 0x0d ||
  code === 0x20;

const isSpecialCode = (code: number): boolean =>
  code === GT || code === DOUBLE_QUOTE || code === SINGLE_QUOTE;

/**
 * Names the scanner handles: lowercase ASCII tag-name characters. With the
 * `i` flag and no `u` flag, the regex folds case only within ASCII for these,
 * so comparing `code | 0x20` for letters is the same test.
 */
const SCANNABLE_NAME = /^[a-z0-9_:-]+$/;

export const isScannableElementName = (name: string): boolean =>
  SCANNABLE_NAME.test(name);

/** Whether `html` has `name` (lowercase) at `at`, ASCII case-insensitively. */
export const nameAt = (html: string, at: number, name: string): boolean => {
  if (at + name.length > html.length) return false;
  for (let index = 0; index < name.length; index++) {
    const expected = name.charCodeAt(index);
    const code = html.charCodeAt(at + index);
    if (code === expected) continue;
    // Letters only: `| 0x20` maps A-Z onto a-z and nothing else onto a letter.
    if (expected < 0x61 || expected > 0x7a || (code | 0x20) !== expected)
      return false;
  }
  return true;
};

/**
 * Where `(?:[^>"']|"[^"]*"|'[^']*')*>` matched at `from` ends: the index of
 * its `>`, or -1 when it cannot match. Linear over all calls when `from` never
 * decreases between calls (it is correct in any order).
 */
export const createAttributeScanner = (
  html: string,
): ((from: number) => number) => {
  const length = html.length;
  // The first special character at or after `from`, cached because callers
  // come in increasing order: no special character in [specialFrom, specialAt).
  let specialFrom = -1;
  let specialAt = -1;
  const firstSpecialFrom = (from: number): number => {
    if (from >= specialFrom && from <= specialAt) return specialAt;
    let index = from;
    while (index < length && !isSpecialCode(html.charCodeAt(index))) index++;
    specialFrom = from;
    specialAt = index; // `length` when there is none
    return index;
  };
  const endMemo = new Map<number, number>();
  return (from: number): number => {
    const chain: number[] = [];
    let at = firstSpecialFrom(from);
    let result: number;
    for (;;) {
      if (at >= length) {
        result = -1;
        break;
      }
      const known = endMemo.get(at);
      if (known !== undefined) {
        result = known;
        break;
      }
      const code = html.charCodeAt(at);
      if (code === GT) {
        result = at;
        break;
      }
      chain.push(at);
      // For one quote character the stretches searched here are disjoint:
      // the next same quote after `at` is the first one, so no other opening
      // quote lies between them.
      const close = html.indexOf(code === DOUBLE_QUOTE ? '"' : "'", at + 1);
      if (close === -1) {
        result = -1;
        break;
      }
      // The stretch after a closing quote belongs to this chain alone.
      let next = close + 1;
      while (next < length && !isSpecialCode(html.charCodeAt(next))) next++;
      at = next;
    }
    for (const link of chain) endMemo.set(link, result);
    return result;
  };
};

/**
 * One match per element, as offsets into the input: the opener starts at
 * `start` and its content runs from `contentStart` to `contentEnd`, where the
 * closer starts; the closer ends at `end`.
 */
export interface ElementContentMatch {
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

/**
 * The regex an element scan reproduces, for a lowercase `name`:
 *
 * - opener `"word-boundary"`: `<name(?:\b(?:[^>"']|"[^"]*"|'[^']*')*)?>`;
 *   `"tag-space"`: `<name(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>`.
 * - closer `"exact"`: `<\/name>`; `"regex-space"`: `<\/name\s*>`;
 *   `"attributes"`: `<\/name(?:[\t\n\f\r /][^>]*)?>`.
 * - content between them: `[\s\S]*?`, flags `gi`.
 *
 * `scriptEscapes` (for `script` with the `"regex-space"` closer) also follows
 * the tokenizer's escaped and double-escaped script data states: a closer is
 * skipped while a `<!--` ... `<script>` inside the content is open, as the
 * browser skips it. Without it every closer counts, as the regex does.
 */
export interface ElementScanOptions {
  opener: "word-boundary" | "tag-space";
  closer: "exact" | "regex-space" | "attributes";
  scriptEscapes?: boolean;
}

export interface ElementScanner {
  /**
   * The first match whose opener starts at or after `from`, or null. Calls
   * must come with `from` never decreasing; together they take linear time.
   */
  next(from: number): ElementContentMatch | null;
}

/**
 * The closers of an element, found by one lazy forward scan from `origin`
 * over each `</` and looked up by binary search, so any number of lookups at
 * or after `origin` take linear time in total.
 */
export interface CloserIndex {
  /** Closer starts and ends found so far, in order. */
  readonly starts: number[];
  readonly ends: number[];
  /**
   * Index into `starts` of the first closer starting at or after `from`, or
   * -1. The first call fixes the origin of the scan at `origin` (default
   * `from`); later lookups must not start before it.
   */
  first(from: number, origin?: number): number;
}

/**
 * Where a closer of `name` (lowercase) that starts at a `</` ends, by the
 * rule `closer` names (see `ElementScanOptions`), or -1 when none starts
 * there. Linear over calls in increasing order.
 */
export const namedCloserEnd = (
  html: string,
  name: string,
  closer: ElementScanOptions["closer"],
): ((at: number) => number) => {
  const length = html.length;

  // The first `>` at or after a position; queried in increasing order.
  let gtFrom = Infinity; // nothing cached yet
  let gtAt = -1;
  const nextGt = (from: number): number => {
    if (from >= gtFrom && (from <= gtAt || gtAt === -1)) return gtAt;
    gtFrom = from;
    gtAt = html.indexOf(">", from);
    return gtAt;
  };

  return (at: number): number => {
    if (!nameAt(html, at + 2, name)) return -1;
    let index = at + 2 + name.length;
    if (closer === "regex-space") {
      while (index < length && isRegexWhitespace(html.charCodeAt(index)))
        index++;
    } else if (closer === "attributes") {
      const code = html.charCodeAt(index);
      if (isTagSpace(code) || code === SLASH) {
        const gt = nextGt(index + 1);
        return gt === -1 ? -1 : gt + 1;
      }
    }
    return html.charCodeAt(index) === GT ? index + 1 : -1;
  };
};

/**
 * The closers `closerEndAt` accepts (the end of a closer starting at a given
 * `</`, or -1), indexed lazily (see `CloserIndex`).
 */
export const createCloserIndex = (
  html: string,
  closerEndAt: (at: number) => number,
): CloserIndex => {
  const starts: number[] = [];
  const ends: number[] = [];
  // Where the forward scan resumes: -2 before the first lookup, -1 once it
  // reached the end.
  let scan = -2;
  return {
    starts,
    ends,
    first(from: number, origin = from): number {
      if (scan === -2) scan = origin;
      let low = 0;
      let high = starts.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (starts[middle] < from) low = middle + 1;
        else high = middle;
      }
      if (low < starts.length) return low;
      while (scan !== -1) {
        const at = html.indexOf("</", scan);
        if (at === -1) {
          scan = -1;
          break;
        }
        scan = at + 2;
        const end = closerEndAt(at);
        if (end === -1) continue;
        starts.push(at);
        ends.push(end);
        if (at >= from) return starts.length - 1;
      }
      return -1;
    },
  };
};

export const createElementScanner = (
  html: string,
  name: string,
  options: ElementScanOptions,
): ElementScanner => {
  const openers = createNamedOpenTagScanner(html, name, options.opener);

  const closers = createCloserIndex(
    html,
    namedCloserEnd(html, name, options.closer),
  );
  const closerStarts = closers.starts;
  const closerEnds = closers.ends;
  // The scan for closers starts at the first opener: no closer before it can
  // matter. Later lookups can start before earlier ones (an opener inside an
  // earlier opener's quoted value ends sooner), so every closer after it is
  // kept.
  let closerOrigin = -1;
  /** Index into closerStarts of the first closer starting at or after `from`. */
  const closerFrom = (from: number): number =>
    closers.first(from, closerOrigin);

  const scriptCloser = options.scriptEscapes
    ? createScriptCloserFinder(html, closerFrom, closerStarts)
    : undefined;

  let lastFrom = -1;
  let last: ElementContentMatch | null | undefined;
  const search = (from: number): ElementContentMatch | null => {
    for (
      let opener = openers.next(from);
      opener !== null;
      opener = openers.next(opener.start + 1)
    ) {
      const { start, end: contentStart } = opener;
      if (closerOrigin === -1) closerOrigin = start;
      const closer = scriptCloser
        ? scriptCloser(contentStart)
        : closerFrom(contentStart);
      if (closer !== -1)
        return {
          start,
          contentStart,
          contentEnd: closerStarts[closer],
          end: closerEnds[closer],
        };
    }
    return null;
  };

  return {
    next(from: number): ElementContentMatch | null {
      // A match found from an earlier position is still the first one from
      // any position up to its start: every opener before it failed, and an
      // opener's success depends only on the text after it.
      if (
        last !== undefined &&
        from >= lastFrom &&
        (last === null || from <= last.start)
      )
        return last;
      lastFrom = from;
      last = search(from);
      return last;
    },
  };
};

const DATA = 0;
const ESCAPED = 1;
const DOUBLE_ESCAPED = 2;

const COMMENT_OPEN = 1; // `<!--`
const COMMENT_CLOSE = 2; // `-->`
const SCRIPT_START = 4; // `<script` + whitespace, `/` or `>`
const SCRIPT_END = 8; // `</script` + whitespace, `/` or `>`
const END_TAG = 16; // `</script` followed by anything: maybe a closer

/**
 * For `<script>` content: the closer (an index into `closerStarts`, as
 * `closerFrom` returns) that ends content starting at `contentStart`, with
 * the tokenizer's script data states. `<!--` enters the escaped state and
 * `-->` leaves it (its dashes may be those of the `<!--`, so `<!-->` is
 * empty); in it, `<script` enters the double-escaped state, where closers
 * are text, and `</script` or `-->` leaves it. Closers count in the plain
 * and escaped states. -1 when no closer ends the content.
 *
 * Tokens are collected by one lazy forward scan. The state machine is
 * deterministic, so the result of a walk from a token in a state is memoized
 * for every (token, state) the walk passed: each pair is walked once.
 */
const createScriptCloserFinder = (
  html: string,
  closerFrom: (from: number) => number,
  closerStarts: number[],
): ((contentStart: number) => number) => {
  const tokenAt: number[] = [];
  const tokenKind: number[] = [];
  let lessScan = 0;
  let dashScan = 0;
  let nextLess = -2;
  let nextDash = -2;
  const kindOfLess = (at: number): number => {
    const code = html.charCodeAt(at + 1);
    if (code === 0x21) return html.startsWith("--", at + 2) ? COMMENT_OPEN : 0;
    const end = code === SLASH;
    const nameStart = end ? at + 2 : at + 1;
    if (!nameAt(html, nameStart, "script")) return 0;
    const after = html.charCodeAt(nameStart + 6);
    if (!end)
      return isTagSpace(after) || after === SLASH || after === GT
        ? SCRIPT_START
        : 0;
    // The regex's closer allows any `\s` before `>` (a vertical tab, a
    // no-break space), which the tokenizer does not take as an end tag.
    return isTagSpace(after) || after === SLASH || after === GT
      ? SCRIPT_END | END_TAG
      : END_TAG;
  };
  /** Collect the next token; false once the input is exhausted. */
  const collect = (): boolean => {
    for (;;) {
      if (nextLess === -2)
        nextLess = lessScan === -1 ? -1 : html.indexOf("<", lessScan);
      if (nextDash === -2)
        nextDash = dashScan === -1 ? -1 : html.indexOf("-->", dashScan);
      if (nextLess === -1 && nextDash === -1) return false;
      if (nextDash === -1 || (nextLess !== -1 && nextLess < nextDash)) {
        const at = nextLess;
        lessScan = at + 1;
        nextLess = -2;
        const kind = kindOfLess(at);
        if (kind === 0) continue;
        tokenAt.push(at);
        tokenKind.push(kind);
        return true;
      }
      const at = nextDash;
      dashScan = at + 1;
      nextDash = -2;
      tokenAt.push(at);
      tokenKind.push(COMMENT_CLOSE);
      return true;
    }
  };
  /** Index of the first token at or after `from`, or tokenAt.length. */
  const firstTokenFrom = (from: number): number => {
    while (
      (tokenAt.length === 0 || tokenAt[tokenAt.length - 1] < from) &&
      collect()
    );
    let low = 0;
    let high = tokenAt.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tokenAt[middle] < from) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  /** The closer index a SCRIPT_END token at `at` stands for, or -1. */
  const closerAtToken = (at: number): number => {
    const closer = closerFrom(at);
    return closer !== -1 && closerStarts[closer] === at ? closer : -1;
  };
  const memo = new Map<number, number>();
  return (contentStart: number): number => {
    const trace: number[] = [];
    let state = DATA;
    let index = firstTokenFrom(contentStart);
    let result = -1;
    for (;;) {
      if (index >= tokenAt.length && !collect()) break;
      const key = index * 3 + state;
      const known = memo.get(key);
      if (known !== undefined) {
        result = known;
        break;
      }
      trace.push(key);
      const kind = tokenKind[index];
      if (state === DOUBLE_ESCAPED) {
        if (kind === COMMENT_CLOSE) state = DATA;
        else if (kind & SCRIPT_END) state = ESCAPED;
      } else {
        // A closer by the regex's rule ends the content; a tokenizer end tag
        // the regex does not accept (`</script/>`) is text, as before.
        if (kind & END_TAG) {
          const closer = closerAtToken(tokenAt[index]);
          if (closer !== -1) {
            result = closer;
            break;
          }
        }
        if (state === DATA) {
          if (kind === COMMENT_OPEN) state = ESCAPED;
        } else if (kind === COMMENT_CLOSE) state = DATA;
        else if (kind === SCRIPT_START) state = DOUBLE_ESCAPED;
      }
      index++;
    }
    for (const key of trace) memo.set(key, result);
    return result;
  };
};

/**
 * Every match of an element scan (see `ElementScanOptions`) for `name` (a
 * lowercase name accepted by `isScannableElementName`) in `html`, in order.
 */
export const scanElementContents = (
  html: string,
  name: string,
  options: ElementScanOptions,
): ElementContentMatch[] => {
  const scanner = createElementScanner(html, name, options);
  const matches: ElementContentMatch[] = [];
  let from = 0;
  for (
    let match = scanner.next(from);
    match !== null;
    match = scanner.next(from)
  ) {
    matches.push(match);
    from = match.end;
  }
  return matches;
};

/**
 * The end of the comment `<!--[\s\S]*?-->` matches at `start` (which must
 * hold `<!--`), or -1 when no `-->` follows. Linear over calls whose `start`
 * never decreases.
 */
export const createCommentEndFinder = (
  html: string,
): ((start: number) => number) => {
  let closeFrom = Infinity; // nothing cached yet
  let closeAt = -1;
  return (start: number): number => {
    const from = start + 4;
    if (!(from >= closeFrom && (from <= closeAt || closeAt === -1))) {
      closeFrom = from;
      closeAt = html.indexOf("-->", from);
    }
    return closeAt === -1 ? -1 : closeAt + 3;
  };
};

export interface OpeningTagScanOptions {
  /** Also match closing tags: `<\/?` in place of `<`. */
  closingTags?: boolean;
  /** Also match comments, as a first alternative `<!--[\s\S]*?-->|`. */
  comments?: boolean;
}

/**
 * Every match of `/<[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g`
 * in `html`, as `[start, end)` pairs in order. After the name the regex
 * accepts `>`, `/>`, or whitespace followed by an attribute part that
 * reaches a `>` (its `[^>"']` also takes the trailing whitespace and `/`).
 * The options reproduce `<!--[\s\S]*?-->|<\/?[a-zA-Z]...` (shielding.ts).
 */
export const scanOpeningTags = (
  html: string,
  options: OpeningTagScanOptions = {},
): Array<[number, number]> => {
  const tags: Array<[number, number]> = [];
  const length = html.length;
  const attributeEnd = createAttributeScanner(html);
  const commentEnd = options.comments ? createCommentEndFinder(html) : null;
  let start = html.indexOf("<");
  while (start !== -1) {
    let end = -1;
    let index = start + 1;
    if (commentEnd !== null && html.startsWith("!--", index))
      end = commentEnd(start);
    else if (options.closingTags && html.charCodeAt(index) === SLASH) index++;
    const first = end === -1 ? html.charCodeAt(index) | 0x20 : 0;
    if (first >= 0x61 && first <= 0x7a) {
      index++;
      while (index < length) {
        const code = html.charCodeAt(index);
        if (
          (code >= 0x61 && code <= 0x7a) ||
          (code >= 0x41 && code <= 0x5a) ||
          (code >= 0x30 && code <= 0x3a) || // digits and `:`
          code === 0x2d
        )
          index++;
        else break;
      }
      const code = html.charCodeAt(index);
      if (code === GT) end = index + 1;
      else if (code === SLASH) {
        if (html.charCodeAt(index + 1) === GT) end = index + 2;
      } else if (isRegexWhitespace(code)) {
        const gt = attributeEnd(index + 1);
        if (gt !== -1) end = gt + 1;
      }
    }
    if (end === -1) start = html.indexOf("<", start + 1);
    else {
      tags.push([start, end]);
      start = html.indexOf("<", end);
    }
  }
  return tags;
};

/**
 * Every match of `/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>\s*<\/script\s*>/gi`
 * in `html`: an empty script element, as `[start, end)` and the attribute
 * text between the name and the opener's `>` (the regex's group 1).
 */
export const scanEmptyScriptElements = (
  html: string,
): Array<{ start: number; end: number; attributes: string }> => {
  const elements: Array<{ start: number; end: number; attributes: string }> =
    [];
  const length = html.length;
  const attributeEnd = createAttributeScanner(html);
  // Many openers can share one `>` (their attributes run to the same one),
  // so what follows a `>` is read once: the end of `\s*<\/script\s*>`, or -1.
  const closeAfterMemo = new Map<number, number>();
  const closeAfter = (gt: number): number => {
    const known = closeAfterMemo.get(gt);
    if (known !== undefined) return known;
    let end = -1;
    let index = gt + 1;
    while (index < length && isRegexWhitespace(html.charCodeAt(index))) index++;
    if (
      html.charCodeAt(index) === 0x3c &&
      html.charCodeAt(index + 1) === SLASH &&
      nameAt(html, index + 2, "script")
    ) {
      index += 8;
      while (index < length && isRegexWhitespace(html.charCodeAt(index)))
        index++;
      if (html.charCodeAt(index) === GT) end = index + 1;
    }
    closeAfterMemo.set(gt, end);
    return end;
  };
  let start = html.indexOf("<");
  while (start !== -1) {
    let end = -1;
    const nameEnd = start + 7;
    let gt = -1;
    // `\b` after `script` needs a non-word character; at the end of input it
    // holds but `>` cannot follow.
    if (
      nameAt(html, start + 1, "script") &&
      nameEnd < length &&
      !isWordCode(html.charCodeAt(nameEnd))
    ) {
      gt = attributeEnd(nameEnd);
      if (gt !== -1) end = closeAfter(gt);
    }
    if (end === -1) start = html.indexOf("<", start + 1);
    else {
      elements.push({
        start,
        end,
        attributes: html.slice(nameEnd, gt),
      });
      start = html.indexOf("<", end);
    }
  }
  return elements;
};

/** `[\w-]` without the `u` flag. */
export const isWordOrHyphenCode = (code: number): boolean =>
  isWordCode(code) || code === 0x2d;

/**
 * One open tag found by `createOpenTagScanner`: it starts at `start`, its
 * attribute part starts at `chainStart`, and its `>` is at `end - 1`.
 */
export interface OpenTagMatch {
  start: number;
  chainStart: number;
  end: number;
}

export interface OpenTagScanner {
  /**
   * The first tag starting at or after `from`, or null. Linear in total over
   * calls whose `from` never decreases (correct in any order).
   */
  next(from: number): OpenTagMatch | null;
}

/**
 * Every match, in the order a `g` regex finds them, of
 * `<NAME(?:[^>"']|"[^"]*"|'[^']*')*>` where `chainStartAt(start)` decides the
 * part before the attributes for a `<` at `start`: where the attribute part
 * starts (just past the name, after any lookahead the regex makes), or -1
 * when the name part cannot match there. A name part whose characters are
 * neither `>` nor quotes, and whose shorter backtracked forms the attribute
 * part could absorb, leaves the match the same, which the regexes this
 * replaces all satisfy (each site says why).
 */
export const createOpenTagScanner = (
  html: string,
  chainStartAt: (start: number) => number,
): OpenTagScanner => {
  const attributeEnd = createAttributeScanner(html);
  let lastFrom = -1;
  let last: OpenTagMatch | null | undefined;
  const search = (from: number): OpenTagMatch | null => {
    for (
      let start = html.indexOf("<", from);
      start !== -1;
      start = html.indexOf("<", start + 1)
    ) {
      const chainStart = chainStartAt(start);
      if (chainStart === -1) continue;
      const gt = attributeEnd(chainStart);
      if (gt !== -1) return { start, chainStart, end: gt + 1 };
    }
    return null;
  };
  return {
    next(from: number): OpenTagMatch | null {
      // A match found from an earlier position is still the first one from
      // any position up to its start (see `createElementScanner`).
      if (
        last !== undefined &&
        from >= lastFrom &&
        (last === null || from <= last.start)
      )
        return last;
      lastFrom = from;
      last = search(from);
      return last;
    },
  };
};

/**
 * Positions where an attribute marker could start, in increasing order: each
 * match of `literal` (a `g` regex for the marker's fixed name, so matches
 * never overlap) mapped by `anchorAt` to where the marker's regex starts, or
 * dropped when it returns -1. `anchorAt` validates the whole marker.
 */
export const findMarkerAnchors = (
  html: string,
  literal: RegExp,
  anchorAt: (index: number) => number,
): number[] => {
  const anchors: number[] = [];
  literal.lastIndex = 0;
  for (
    let match = literal.exec(html);
    match !== null;
    match = literal.exec(html)
  ) {
    const anchor = anchorAt(match.index);
    if (anchor !== -1 && anchor > (anchors.at(-1) ?? -1)) anchors.push(anchor);
  }
  return anchors;
};

/**
 * Where an attribute chain `(?:[^>"']|"[^"]*"|'[^']*')*` started at `from`
 * can stop before a marker: the first (`pick: "first"`, a lazy chain) or
 * last (`"last"`, a greedy chain) of `anchors` it can stop at, or -1.
 *
 * The chain can stop at any position outside the quoted strings it walks,
 * up to the first unquoted `>`, an unclosed quote, or the end of the input.
 * Those positions are the stretches between the quoted strings: the one from
 * `from` to the first special character, then one after each closing quote.
 * A stretch after a closing quote belongs to that quote alone, so the answer
 * for the rest of a walk from each quote is memoized, and every stretch is
 * searched once (by binary search over `anchors`). `anchors` must be sorted
 * and hold neither `>` nor quotes.
 *
 * Whether the marker's own regex then matches, and whether the tag ends in a
 * `>`, is the caller's: for a marker whose characters the chain itself walks
 * the same way (no `>`, and a quoted value closing at the first same quote),
 * the chain after it ends where `createAttributeScanner` says the whole tag
 * does.
 */
export const createMarkerWalk = (
  html: string,
  anchors: readonly number[],
  pick: "first" | "last",
): ((from: number) => number) => {
  const length = html.length;
  // No special character in [specialFrom, specialAt); html[specialAt] is one,
  // or specialAt is the length.
  let specialFrom = length;
  let specialAt = length;
  const firstSpecialFrom = (from: number): number => {
    if (from >= specialFrom && from <= specialAt) return specialAt;
    let index = from;
    if (from < specialFrom) {
      while (index < specialFrom && !isSpecialCode(html.charCodeAt(index)))
        index++;
      if (index === specialFrom) {
        specialFrom = from;
        return specialAt;
      }
    } else {
      while (index < length && !isSpecialCode(html.charCodeAt(index))) index++;
    }
    specialFrom = from;
    specialAt = index;
    return index;
  };
  const anchorBetween = (low: number, high: number): number => {
    if (low >= high || anchors.length === 0) return -1;
    const target = pick === "first" ? low : high;
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const middle = (lo + hi) >>> 1;
      if (anchors[middle] < target) lo = middle + 1;
      else hi = middle;
    }
    if (pick === "first")
      return lo < anchors.length && anchors[lo] < high ? anchors[lo] : -1;
    return lo > 0 && anchors[lo - 1] >= low ? anchors[lo - 1] : -1;
  };
  // The answer for the stretches after the special character at a position.
  const tailMemo = new Map<number, number>();
  const tail = (from: number): number => {
    const links: number[] = [];
    const own: number[] = [];
    let at = from;
    let result = -1;
    for (;;) {
      if (at >= length) break;
      const known = tailMemo.get(at);
      if (known !== undefined) {
        result = known;
        break;
      }
      const code = html.charCodeAt(at);
      if (code === GT) {
        tailMemo.set(at, -1);
        break;
      }
      const close = html.indexOf(code === DOUBLE_QUOTE ? '"' : "'", at + 1);
      if (close === -1) {
        tailMemo.set(at, -1);
        break;
      }
      let next = close + 1;
      while (next < length && !isSpecialCode(html.charCodeAt(next))) next++;
      links.push(at);
      own.push(anchorBetween(close + 1, next));
      at = next;
    }
    for (let index = links.length - 1; index >= 0; index--) {
      if (pick === "last") {
        if (result === -1) result = own[index];
      } else if (own[index] !== -1) result = own[index];
      tailMemo.set(links[index], result);
    }
    return result;
  };
  return (from: number): number => {
    const firstSpecial = firstSpecialFrom(from);
    const head = anchorBetween(from, firstSpecial);
    if (pick === "first" && head !== -1) return head;
    const rest = tail(firstSpecial);
    return rest !== -1 ? rest : head;
  };
};

/**
 * The opening tags an element scan (see `ElementScanOptions.opener`) finds
 * for `name` (lowercase, accepted by `isScannableElementName`):
 * `<name(?:\b(?:[^>"']|"[^"]*"|'[^']*')*)?>` for `"word-boundary"` (the same
 * as `<name\b...>` for a name ending in a word character) and
 * `<name(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>` for `"tag-space"`,
 * flags `gi`.
 */
export const createNamedOpenTagScanner = (
  html: string,
  name: string,
  opener: ElementScanOptions["opener"],
): OpenTagScanner => {
  const length = html.length;
  const nameEndsInWord = isWordCode(name.charCodeAt(name.length - 1));
  return createOpenTagScanner(html, (start) => {
    if (!nameAt(html, start + 1, name)) return -1;
    const nameEnd = start + 1 + name.length;
    if (nameEnd >= length) return -1;
    const next = html.charCodeAt(nameEnd);
    if (next === GT) return nameEnd;
    return (
      opener === "word-boundary"
        ? nameEndsInWord !== isWordCode(next)
        : isTagSpace(next) || next === SLASH
    )
      ? nameEnd
      : -1;
  });
};

/** One alternative of a regex `scanAlternatives` reproduces. */
export type ScanAlternative =
  | { kind: "comment" }
  | { kind: "element"; name: string; options: ElementScanOptions };

/**
 * One match of a `scanAlternatives` scan: the index of the alternative that
 * matched, with offsets as in `ElementContentMatch` (a comment's content is
 * between `<!--` and `-->`).
 */
export interface AlternativeMatch extends ElementContentMatch {
  alternative: number;
}

/**
 * Every match, in order, of a `g` regex that alternates comments
 * `<!--[\s\S]*?-->` and element scans (see `ElementScanOptions`): at each
 * position the first alternative that matches wins, and the scan resumes
 * after each match. Each alternative's next match is cached, so the scan is
 * linear: the leftmost match overall is the leftmost of the alternatives'.
 */
export const scanAlternatives = (
  html: string,
  alternatives: readonly ScanAlternative[],
): AlternativeMatch[] => {
  const commentEnd = createCommentEndFinder(html);
  // A comment at the first `<!--` from `from`: when no `-->` follows it,
  // none follows a later `<!--` either.
  const nextComment = (from: number): ElementContentMatch | null => {
    const start = html.indexOf("<!--", from);
    if (start === -1) return null;
    const end = commentEnd(start);
    return end === -1
      ? null
      : { start, contentStart: start + 4, contentEnd: end - 3, end };
  };
  const scanners = alternatives.map((alternative) =>
    alternative.kind === "comment"
      ? null
      : createElementScanner(html, alternative.name, alternative.options),
  );
  const cached: Array<ElementContentMatch | null | undefined> =
    alternatives.map(() => undefined);
  const matches: AlternativeMatch[] = [];
  let from = 0;
  for (;;) {
    let best = -1;
    for (let index = 0; index < alternatives.length; index++) {
      let match = cached[index];
      if (match === undefined || (match !== null && match.start < from)) {
        const scanner = scanners[index];
        match = scanner === null ? nextComment(from) : scanner.next(from);
        cached[index] = match;
      }
      if (match !== null && (best === -1 || match.start < cached[best]!.start))
        best = index;
    }
    if (best === -1) return matches;
    const match = cached[best]!;
    matches.push({ ...match, alternative: best });
    from = match.end;
  }
};

/**
 * Every match, in order, of `(<NAME(?:\b(?:[^>"']|"[^"]*"|'[^']*')*)?>)([\s\S]*?)(CLOSER)`
 * (flags `gi`) for a NAME pattern that matches neither `>` nor quotes (the
 * `*` entries of `scoping.preserve`, `vendor-[a-zA-Z0-9-]*`). `name` is
 * `NAME(?:\b|(?=>))` and `closer` is `CLOSER`, both sticky (`iy`).
 *
 * Every way NAME can match from a `<` ends inside the run of characters
 * before the first `>` or quote, so the attribute part, from wherever it
 * starts, reaches the same `>`: an opener matches when that `>` exists and
 * NAME can end at a word boundary or right before a `>` (what `name`
 * tests), and its content runs to the first closer after that `>`.
 * Closers are found once, in one forward scan.
 */
export const scanPatternElementContents = (
  html: string,
  name: RegExp,
  closer: RegExp,
): ElementContentMatch[] => {
  const attributeEnd = createAttributeScanner(html);
  const closers = createCloserIndex(html, (at) => {
    closer.lastIndex = at;
    const match = closer.exec(html);
    return match === null ? -1 : at + match[0].length;
  });
  const closerStarts = closers.starts;
  const closerEnds = closers.ends;
  const closerFrom = (from: number): number => closers.first(from, 0);
  const matches: ElementContentMatch[] = [];
  let start = html.indexOf("<");
  while (start !== -1) {
    name.lastIndex = start + 1;
    if (name.test(html)) {
      const gt = attributeEnd(start + 1);
      if (gt !== -1) {
        const found = closerFrom(gt + 1);
        if (found !== -1) {
          matches.push({
            start,
            contentStart: gt + 1,
            contentEnd: closerStarts[found],
            end: closerEnds[found],
          });
          start = html.indexOf("<", closerEnds[found]);
          continue;
        }
      }
    }
    start = html.indexOf("<", start + 1);
  }
  return matches;
};

/**
 * Anchors (see `createMarkerWalk`) for a marker that starts with one `\s`:
 * each match of `literal` (a `gi` regex for the marker's name) preceded by
 * whitespace where the sticky `marker` regex (`iy`, starting with `\s`)
 * matches from that whitespace.
 */
export const findWhitespaceMarkerAnchors = (
  html: string,
  literal: RegExp,
  marker: RegExp,
): number[] =>
  findMarkerAnchors(html, literal, (index) => {
    if (index === 0) return -1;
    marker.lastIndex = index - 1;
    return marker.test(html) ? index - 1 : -1;
  });

/**
 * Whether `<script\b` at `start` opens a script tag: the name in any case,
 * then a non-word character (or the end of the input, where nothing after
 * it can match).
 */
const isScriptOpenerAt = (html: string, start: number): boolean =>
  nameAt(html, start + 1, "script") && !isWordCode(html.charCodeAt(start + 7));

/**
 * The start of the first match of `<script\b(?:[^>"']|"[^"]*"|'[^']*')*`
 * followed by a marker (no `>` needed), or -1: the first script opener whose
 * attribute chain can stop at one of `anchors` (see `createMarkerWalk`).
 * Linear, where the regex retried the chain from every opener.
 */
export const findScriptOpenerWithMarker = (
  html: string,
  anchors: readonly number[],
): number => {
  if (anchors.length === 0) return -1;
  const markerAt = createMarkerWalk(html, anchors, "first");
  for (
    let start = html.indexOf("<");
    start !== -1 && start < anchors[anchors.length - 1];
    start = html.indexOf("<", start + 1)
  )
    if (isScriptOpenerAt(html, start) && markerAt(start + 7) !== -1)
      return start;
  return -1;
};

/** One alternative of a `scanMarkedScripts` regex. */
export interface MarkedScriptAlternative {
  /** Where the marker's regex can match, sorted (see `createMarkerWalk`). */
  anchors: readonly number[];
  /** Where the marker that starts at `anchor` ends. */
  markerEnd: (anchor: number) => number;
  /** A lazy (`"first"`) or greedy (`"last"`) attribute chain before it. */
  pick: "first" | "last";
}

export interface MarkedScriptMatch extends ElementContentMatch {
  /** The index of the alternative that matched. */
  alternative: number;
  /** The anchor of the marker the match used. */
  marker: number;
}

/**
 * Every match, in order, of a `gi` regex alternating forms of
 * `<script\b(CHAIN)MARKER(CHAIN)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>`,
 * CHAIN being `(?:[^>"']|"[^"]*"|'[^']*')*` (or its lazy form), in linear
 * time. Those regexes took cubic time: both chains retried from every
 * opener.
 *
 * What follows a marker does not depend on the opener: the chain after it
 * reaches the `>` `createAttributeScanner` finds from the marker's end, and
 * the body runs to the first end tag after that. So each marker is checked
 * once, and an opener matches with the first (lazy) or last (greedy) of the
 * markers that pass where its first chain can stop. A marker whose quotes
 * pair differently than the chain's (`type="text/bascik-server'`) is handled
 * the same way, from its own end.
 */
export const scanMarkedScripts = (
  html: string,
  alternatives: readonly MarkedScriptAlternative[],
): MarkedScriptMatch[] => {
  const closers = createCloserIndex(
    html,
    namedCloserEnd(html, "script", "attributes"),
  );
  const walks = alternatives.map((alternative) => {
    const attributeEnd = createAttributeScanner(html);
    const passing: number[] = [];
    const gts = new Map<number, number>();
    for (const anchor of alternative.anchors) {
      const gt = attributeEnd(alternative.markerEnd(anchor));
      if (gt === -1 || closers.first(gt + 1, 0) === -1) continue;
      passing.push(anchor);
      gts.set(anchor, gt);
    }
    return {
      gts,
      markerAt:
        passing.length === 0
          ? null
          : createMarkerWalk(html, passing, alternative.pick),
    };
  });
  const matches: MarkedScriptMatch[] = [];
  if (walks.every((walk) => walk.markerAt === null)) return matches;
  let start = html.indexOf("<");
  while (start !== -1) {
    let end = -1;
    if (isScriptOpenerAt(html, start)) {
      for (let index = 0; index < walks.length && end === -1; index++) {
        const { markerAt, gts } = walks[index];
        const marker = markerAt === null ? -1 : markerAt(start + 7);
        if (marker === -1) continue;
        const gt = gts.get(marker)!;
        const closer = closers.first(gt + 1, 0);
        end = closers.ends[closer];
        matches.push({
          start,
          contentStart: gt + 1,
          contentEnd: closers.starts[closer],
          end,
          alternative: index,
          marker,
        });
      }
    }
    start = html.indexOf("<", end === -1 ? start + 1 : end);
  }
  return matches;
};

/**
 * `html` with each span (in order, never overlapping) replaced by
 * `replace(text, span)`: what `html.replace(regex, replace)` does with the
 * matches a scan found in place of the regex's.
 */
export const replaceSpans = <Span extends { start: number; end: number }>(
  html: string,
  spans: Iterable<Span>,
  replace: (text: string, span: Span) => string,
): string => {
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result +=
      html.slice(cursor, span.start) +
      replace(html.slice(span.start, span.end), span);
    cursor = span.end;
  }
  return cursor === 0 ? html : result + html.slice(cursor);
};

/**
 * `html.replace(regex, (match, open, content, close, offset) => ...)` for the
 * regex an element scan reproduces (see `ElementScanOptions`) with its
 * opener, content and closer captured, in linear time.
 */
export const replaceScannedElements = (
  html: string,
  name: string,
  options: ElementScanOptions,
  replace: (
    open: string,
    content: string,
    close: string,
    start: number,
  ) => string,
): string =>
  replaceSpans(html, scanElementContents(html, name, options), (_text, match) =>
    replace(
      html.slice(match.start, match.contentStart),
      html.slice(match.contentStart, match.contentEnd),
      html.slice(match.contentEnd, match.end),
      match.start,
    ),
  );

/**
 * Every match, in order, of `/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g`
 * (with or without `i`): `chainStart` ends the name. The attribute part would
 * take any name characters a shorter name left, so the name is the whole
 * `[\w:-]` run, and the tag ends where the chain after it reaches a `>`.
 */
export const createWordNameOpenTagScanner = (html: string): OpenTagScanner =>
  createOpenTagScanner(html, (start) => wordTagNameEnd(html, start));

/** `[a-zA-Z][\w:-]*` after the `<` at `start`: the index just past it, or -1. */
export const wordTagNameEnd = (html: string, start: number): number => {
  const first = html.charCodeAt(start + 1) | 0x20;
  if (first < 0x61 || first > 0x7a) return -1;
  let index = start + 2;
  for (;;) {
    const code = html.charCodeAt(index);
    if (isWordCode(code) || code === 0x2d || code === 0x3a) index++;
    else return index;
  }
};

/** The matches of an open-tag scanner from `from`, in order. */
export function* openTagsOf(
  scanner: OpenTagScanner,
  from = 0,
): Generator<OpenTagMatch> {
  for (let tag = scanner.next(from); tag !== null; tag = scanner.next(tag.end))
    yield tag;
}
