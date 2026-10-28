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
const isWordCode = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f;

/** The regex's `\s`: ECMAScript WhiteSpace and LineTerminator code units. */
const isRegexWhitespace = (code: number): boolean =>
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
const isTagSpace = (code: number): boolean =>
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
const nameAt = (html: string, at: number, name: string): boolean => {
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
const createAttributeScanner = (html: string): ((from: number) => number) => {
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

export const createElementScanner = (
  html: string,
  name: string,
  options: ElementScanOptions,
): ElementScanner => {
  const length = html.length;
  const nameEndsInWord = isWordCode(name.charCodeAt(name.length - 1));
  const attributeEnd = createAttributeScanner(html);

  // The first `>` at or after a position; queried in increasing order.
  let gtFrom = Infinity; // nothing cached yet
  let gtAt = -1;
  const nextGt = (from: number): number => {
    if (from >= gtFrom && (from <= gtAt || gtAt === -1)) return gtAt;
    gtFrom = from;
    gtAt = html.indexOf(">", from);
    return gtAt;
  };

  // The end of a closer starting at `at` (which holds `</`), or -1.
  const closerEndAt = (at: number): number => {
    if (!nameAt(html, at + 2, name)) return -1;
    let index = at + 2 + name.length;
    if (options.closer === "regex-space") {
      while (index < length && isRegexWhitespace(html.charCodeAt(index)))
        index++;
    } else if (options.closer === "attributes") {
      const code = html.charCodeAt(index);
      if (isTagSpace(code) || code === SLASH) {
        const gt = nextGt(index + 1);
        return gt === -1 ? -1 : gt + 1;
      }
    }
    return html.charCodeAt(index) === GT ? index + 1 : -1;
  };

  // Closer starts and ends found so far, in order; `closerScan` is where the
  // forward scan for more resumes, or -1 once it reached the end.
  const closerStarts: number[] = [];
  const closerEnds: number[] = [];
  // -2 until the first opener is found: no closer before it can matter. Later
  // lookups can start before earlier ones (an opener inside an earlier
  // opener's quoted value ends sooner), so every closer after it is kept.
  let closerScan = -2;
  /** Index into closerStarts of the first closer starting at or after `from`. */
  const closerFrom = (from: number): number => {
    let low = 0;
    let high = closerStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (closerStarts[middle] < from) low = middle + 1;
      else high = middle;
    }
    if (low < closerStarts.length) return low;
    while (closerScan !== -1) {
      const at = html.indexOf("</", closerScan);
      if (at === -1) {
        closerScan = -1;
        break;
      }
      closerScan = at + 2;
      const end = closerEndAt(at);
      if (end === -1) continue;
      closerStarts.push(at);
      closerEnds.push(end);
      if (at >= from) return closerStarts.length - 1;
    }
    return -1;
  };

  const scriptCloser = options.scriptEscapes
    ? createScriptCloserFinder(html, closerFrom, closerStarts)
    : undefined;

  let lastFrom = -1;
  let last: ElementContentMatch | null | undefined;
  const search = (from: number): ElementContentMatch | null => {
    let searchFrom = from;
    for (;;) {
      // The next `<` followed by the name in any case.
      let start = html.indexOf("<", searchFrom);
      while (start !== -1 && !nameAt(html, start + 1, name))
        start = html.indexOf("<", start + 1);
      if (start === -1) return null;
      if (closerScan === -2) closerScan = start;
      const nameEnd = start + 1 + name.length;
      let gt = -1;
      if (nameEnd < length) {
        const next = html.charCodeAt(nameEnd);
        if (next === GT) gt = nameEnd;
        else if (
          options.opener === "word-boundary"
            ? nameEndsInWord !== isWordCode(next)
            : isTagSpace(next) || next === SLASH
        )
          gt = attributeEnd(nameEnd);
      }
      if (gt !== -1) {
        const closer = scriptCloser ? scriptCloser(gt + 1) : closerFrom(gt + 1);
        if (closer !== -1)
          return {
            start,
            contentStart: gt + 1,
            contentEnd: closerStarts[closer],
            end: closerEnds[closer],
          };
      }
      searchFrom = start + 1;
    }
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
 * Every match of `/<[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g`
 * in `html`, as `[start, end)` pairs in order. After the name the regex
 * accepts `>`, `/>`, or whitespace followed by an attribute part that
 * reaches a `>` (its `[^>"']` also takes the trailing whitespace and `/`).
 */
export const scanOpeningTags = (html: string): Array<[number, number]> => {
  const tags: Array<[number, number]> = [];
  const length = html.length;
  const attributeEnd = createAttributeScanner(html);
  let start = html.indexOf("<");
  while (start !== -1) {
    let end = -1;
    let index = start + 1;
    const first = html.charCodeAt(index) | 0x20;
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
