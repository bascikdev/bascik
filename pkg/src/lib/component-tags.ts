import {
  createAttributeValueScanner,
  type AttributeValueCheckpoint,
  type AttributeValueScanner,
  type ComponentSearchState,
} from "./component-attribute-scan.ts";
import { maskRawTextContent } from "./component-masking.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";
import {
  createOpenTagScanner,
  isTagNameEndCode,
  isWordOrHyphenCode,
  nameAt,
  type OpenTagMatch,
  type OpenTagScanner,
} from "./element-content-scan.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

/**
 * The names a component list's tag search looks for: lowercase, with the
 * longest one's length.
 */
interface ComponentNameMatcher {
  names: ReadonlySet<string>;
  maxLength: number;
}

interface ComponentMatcherCacheEntry {
  /** The list's names, in key order, when the matcher was built. */
  keys: string[];
  /** Whether the list was already frozen then, so it cannot have changed since. */
  frozen: boolean;
  matcher: ComponentNameMatcher | null;
}

/** Whether `keys` names exactly `cached` in the same order (property keys are interned). */
const sameKeys = (keys: string[], cached: string[]): boolean => {
  if (keys.length !== cached.length) return false;
  for (let index = 0; index < keys.length; index++)
    if (keys[index] !== cached[index]) return false;
  return true;
};

const componentMatcherCache = new WeakMap<
  ComponentList,
  ComponentMatcherCacheEntry
>();

/**
 * `<tagName(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>` (flags `gi`) for
 * a name `/^[a-zA-Z][\w:-]*$/` accepts, in linear time
 * (element-content-scan.ts): the tags whose whole name is `tagName`, as a
 * browser reads a tag name (`isTagNameEndCode`), so `<my-card.foo>`,
 * `<my-card:x>` and `<my-card</p>` are no `my-card`.
 */
const componentOpenTags = (html: string, tagName: string): OpenTagScanner => {
  const name = tagName.toLowerCase();
  return createOpenTagScanner(html, (start) => {
    if (!nameAt(html, start + 1, name)) return -1;
    const after = start + 1 + name.length;
    return isTagNameEndCode(html.charCodeAt(after)) ? after : -1;
  });
};

const SELF_CLOSING_END_RE = /\/\s*>$/;

/**
 * A component's close as the browser ends one: `</name` (any case), then
 * tag whitespace, `/` or `>`, then anything up to the first `>`, the regex
 * `<\/name(?:[\t\n\f\r /][^>]*)?>`. So `</my-card foo>` and `</my-card/>`
 * close `my-card`, and `</my-card\v>` and `</my-card\u00a0>` (end tags of
 * other names) do not. Escaped `tagName` only; sticky, for a close known to
 * start at `lastIndex`.
 */
const closeAtPattern = (escapedName: string, flags = "iy"): RegExp =>
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  new RegExp(`<\\/${escapedName}(?:[\\t\\n\\f\\r /][^>]*)?>`, flags);

/** Where a close (`closeAtPattern`) starts and ends. */
interface CloseMatch {
  index: number;
  end: number;
}

/**
 * The first close of `tagName` (`closeAtPattern`) starting at or after a
 * position, in linear time over calls in increasing order: the start is
 * found by `</name` and the character after it, and the end is the first
 * `>` after the name. With no `>` after one start, none follows a later one,
 * so there is no close from there on.
 */
const createCloseSearch = (
  html: string,
  tagName: string,
): ((from: number) => CloseMatch | null) => {
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const start = new RegExp(`<\\/${tn}(?=[\\t\\n\\f\\r />])`, "gi");
  const nameLength = tagName.length + 2;
  // The first `>` at or after `gtFrom` is `gtAt` (-1 for none).
  let gtFrom = Infinity;
  let gtAt = -1;
  return (from: number): CloseMatch | null => {
    start.lastIndex = from;
    const match = start.exec(html);
    if (!match) return null;
    const after = match.index + nameLength;
    if (!(after >= gtFrom && (gtAt === -1 || after <= gtAt))) {
      gtFrom = after;
      gtAt = html.indexOf(">", after);
    }
    return gtAt === -1 ? null : { index: match.index, end: gtAt + 1 };
  };
};

/**
 * The first match at or after `from` of the list's tag regex,
 * `<(names)(?=[\t\n\f\r />])[\s\S]*?>` (flags `gi`): the tag's start, its
 * name as written, and the end of the first `>` after the name. Linear: the
 * regex scanned to the end of the input from every opener when no `>`
 * followed.
 *
 * A name matches only as the whole tag name, as a browser reads one: the
 * `[\w:-]` run after the `<`, followed by tag whitespace, `/` or `>`
 * (`isTagNameEndCode`). `<my-card.foo>`, `<my-card</p>` and `<my-card:x>` are
 * the tags `my-card.foo`, `my-card<` and `my-card:x`, never `my-card`.
 */
const findComponentTag = (
  html: string,
  matcher: ComponentNameMatcher,
  from: number,
): { index: number; name: string; end: number } | null => {
  const length = html.length;
  for (
    let start = html.indexOf("<", from);
    start !== -1;
    start = html.indexOf("<", start + 1)
  ) {
    const nameStart = start + 1;
    let index = nameStart;
    const limit = Math.min(length, nameStart + matcher.maxLength);
    let nameEnd = -1;
    for (; index <= limit; index++) {
      const code = html.charCodeAt(index);
      if (isWordOrHyphenCode(code) || code === 0x3a) continue;
      if (
        index > nameStart &&
        isTagNameEndCode(code) &&
        matcher.names.has(html.slice(nameStart, index).toLowerCase())
      )
        nameEnd = index;
      break;
    }
    if (nameEnd === -1) continue;
    const gt = html.indexOf(">", nameEnd);
    // No `>` after this name means none after any later one either.
    if (gt === -1) return null;
    return {
      index: start,
      name: html.slice(nameStart, nameEnd),
      end: gt + 1,
    };
  }
  return null;
};

/**
 * Find the first `<tagName ...>` opening tag in `htmlString` and return its
 * full text plus start/end indices.  The attribute scan is quote-aware so a
 * `>` inside a quoted attribute value does not end the tag early.
 * Occurrences inside `<script>`, `<style>`, and `<textarea>` content are
 * ignored — they are text, not markup.
 */
const findOpenTag = (
  htmlString: string,
  tagName: string,
  masked?: string,
  searchFrom = 0,
  scanner?: AttributeValueScanner,
): { openTag: string; start: number; end: number } | null => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return null;
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  const attributeScan = scanner ?? createAttributeValueScanner(maskedHtml);
  const openTags = componentOpenTags(maskedHtml, tagName);
  for (
    let tag = openTags.next(searchFrom);
    tag !== null;
    tag = openTags.next(tag.end)
  ) {
    if (attributeScan.isInsideTag(tag.start)) continue;
    return {
      openTag: maskedHtml.slice(tag.start, tag.end),
      start: tag.start,
      end: tag.end,
    };
  }
  return null;
};

export const replaceTag = (
  htmlString: string,
  tagName: string,
  transpiledTag: string,
  masked?: string,
  offsets?: { startIndex?: number; endIndex?: number },
): string => {
  if (
    offsets &&
    typeof offsets.startIndex === "number" &&
    typeof offsets.endIndex === "number"
  ) {
    return (
      htmlString.slice(0, offsets.startIndex) +
      transpiledTag +
      htmlString.slice(offsets.endIndex)
    );
  }
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return htmlString;
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try paired tags first: <tagName ...>...</tagName>
  // Use findMatchingClose (a depth counter) instead of a lazy regex so nested
  // same-name elements pair with the correct (balanced) closing tag, e.g.
  // <my-list>...<my-list></my-list>...</my-list>.
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  const openTag = findOpenTag(htmlString, tagName, maskedHtml);
  if (openTag && !/\/\s*>$/.test(openTag.openTag)) {
    const closeIndex = findMatchingClose(
      htmlString,
      tagName,
      openTag.end,
      maskedHtml,
    );
    if (closeIndex !== -1) {
      const closeTagRegexp = closeAtPattern(tn);
      closeTagRegexp.lastIndex = closeIndex;
      const closeTagMatch = closeTagRegexp.exec(htmlString);
      if (closeTagMatch) {
        // Splice by index so that `$` characters in transpiledTag (e.g.
        // SQL positional parameters like $1, $2 in slot content) are never
        // interpreted as back-references, which would cause infinite
        // expansion loops.
        const endIndex = closeIndex + closeTagMatch[0].length;
        return (
          htmlString.slice(0, openTag.start) +
          transpiledTag +
          htmlString.slice(endIndex)
        );
      }
    }
  }
  // Fall back to self-closing: <tagName ... /> or <tagName/>
  // Use a replacement function for the same `$`-safety reason.
  // Search the masked string so a literal tag inside <script>/<style>/<textarea>
  // content is never replaced; splice by index into the original string.
  // This is `<tagName(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*\s*\/?>`
  // (flags `gi`) in linear time: the attribute part starts right after the
  // whole tag name (`componentOpenTags`), and its `>` ends the match.
  const selfClosingTags = componentOpenTags(maskedHtml, tagName);
  const attributeScan = createAttributeValueScanner(maskedHtml);
  let selfClosingMatch: OpenTagMatch | null;
  for (
    selfClosingMatch = selfClosingTags.next(0);
    selfClosingMatch !== null;
    selfClosingMatch = selfClosingTags.next(selfClosingMatch.end)
  ) {
    if (attributeScan.isInsideTag(selfClosingMatch.start)) continue;
    break;
  }
  if (!selfClosingMatch) return htmlString;
  return (
    htmlString.slice(0, selfClosingMatch.start) +
    transpiledTag +
    htmlString.slice(selfClosingMatch.end)
  );
};

/**
 * The list's tag search (see `findComponentTag`), or null when it names
 * nothing. It is built once per list and only read.
 */
const componentMatcherFor = (
  componentList: ComponentList,
): ComponentNameMatcher | null => {
  let cached = componentMatcherCache.get(componentList);
  // A list that was frozen when its matcher was built (the request path's, one
  // per manifest) cannot have changed, so it is keyed on identity alone. Any
  // other list may have been edited in place since (the build's, in dev, or
  // one frozen only after it was searched), so its names are re-read and
  // compared whole: a count/first/last signature misses an edit that keeps
  // all three.
  if (cached?.frozen) return cached.matcher;
  const rawKeys = Object.keys(componentList);
  if (!cached || !sameKeys(rawKeys, cached.keys)) {
    const componentNames = rawKeys.filter((name) =>
      /^[a-zA-Z][\w:-]*$/.test(name),
    );
    // The most specific (longest) name wins where several match, so
    // test-comp-clone is found before test-comp (see findComponentTag).
    const matcher: ComponentNameMatcher | null =
      componentNames.length === 0
        ? null
        : {
            names: new Set(componentNames.map((name) => name.toLowerCase())),
            maxLength: componentNames.reduce(
              (longest, name) => Math.max(longest, name.length),
              0,
            ),
          };
    if (matcher) __componentScanStatsForTests.searchesCompiled++;
    cached = {
      keys: rawKeys,
      frozen: Object.isFrozen(componentList),
      matcher,
    };
    componentMatcherCache.set(componentList, cached);
  } else if (!cached.frozen && Object.isFrozen(componentList)) {
    // Frozen since the matcher was built, and its names are the ones it was
    // built from: from here on identity is enough.
    cached.frozen = true;
  }

  return cached.matcher;
};

/**
 * Whether `html` may contain a usage of a component in the list: false only
 * when no tag in it names one, so a caller can skip masking and scanning an
 * output that has none. True is not a decision (a name inside a script or
 * an attribute value matches here and is skipped by the real search).
 */
export const mayContainComponent = (
  html: string,
  componentList: ComponentList,
): boolean => {
  if (!html.includes("<")) return false;
  const matcher = componentMatcherFor(componentList);
  if (!matcher) return false;
  return findComponentTag(html, matcher, 0) !== null;
};

/**
 * Find the first component tag in `htmlString` at or after `searchFrom`.
 *
 * `searchFrom` is the cursor from prompt 63: after a replacement at index S,
 * no new component tag can appear before S in the unchanged prefix, so the
 * caller resumes the search at S (never at the replacement END, which would
 * skip components nested in the inserted template). Returned indices are
 * always in whole-document coordinates.
 */
export const getFirstComponent = (
  htmlString: string,
  componentList: ComponentList,
  masked?: string,
  searchFrom = 0,
  searchState?: ComponentSearchState,
): Partial<BascikComponent> & { index?: number } => {
  if (!htmlString) return {};

  const matcher = componentMatcherFor(componentList);
  if (!matcher) return {};

  // Match against the masked string so literal component-tag text inside
  // <script>/<style>/<textarea> content (e.g. JSON-LD strings) is ignored.
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  const resume = searchState?.attributeCheckpoint;
  const attributeScan = createAttributeValueScanner(
    maskedHtml,
    resume && resume.cursor <= searchFrom ? resume : undefined,
  );
  let checkpoint: AttributeValueCheckpoint | undefined;
  let match: ReturnType<typeof findComponentTag>;
  for (
    match = findComponentTag(maskedHtml, matcher, searchFrom);
    match !== null;
    match = findComponentTag(maskedHtml, matcher, match.end)
  ) {
    if (searchState && match.index > 2) {
      // Stop three bytes short: replacing the tag changes the bytes the scan
      // peeks at after a `<` (up to three, `<!--`).
      attributeScan.isInsideValue(match.index - 3);
      checkpoint = attributeScan.checkpoint();
    }
    // A name inside another tag (`<p<my-card>`, `</p <my-card>`) or a bogus
    // comment (`<!x<my-card>`) is part of it, as is one in an attribute value.
    if (attributeScan.isInsideTag(match.index)) continue;
    break;
  }
  if (match && searchState) searchState.attributeCheckpoint = checkpoint;
  if (!match) {
    __componentScanStatsForTests.prefixBytesExamined += Math.max(
      0,
      maskedHtml.length - searchFrom,
    );
    return {};
  }
  __componentScanStatsForTests.prefixBytesExamined += match.index - searchFrom;
  const firstComponentName = match.name.toLowerCase();
  const found = findTag(
    htmlString,
    firstComponentName,
    maskedHtml,
    match.index,
    attributeScan,
    searchState?.closeFinder,
    searchState?.lastCloseAt,
  );
  if (!found) return { name: firstComponentName, index: match.index };
  return tagResult(
    found,
    componentList[firstComponentName],
    firstComponentName,
    match.index,
  );
};

/** Where a tag was found, in whole-document coordinates. */
interface FoundTag {
  content: string;
  innerContent: string;
  startIndex: number;
  /** Where the inner content starts (the end of the open tag). */
  contentStart: number;
  /** Where the closing tag starts; -1 when there is none. */
  closeIndex: number;
  endIndex: number;
}

type TagResult = Partial<BascikComponent> & {
  index?: number;
  startIndex?: number;
  contentStart?: number;
  closeIndex?: number;
  endIndex?: number;
};

/**
 * The public shape of a found tag: `content` and `innerContent` (after the
 * `name` and `index` `getFirstComponent` leads with), then the list entry's
 * fields, with the four indices as non-enumerable properties so spreading
 * or comparing a result sees only the component. One object, one define.
 */
const tagResult = (
  found: FoundTag,
  entry: ComponentList[string] | undefined,
  name?: string,
  index?: number,
): TagResult => {
  const res: TagResult =
    name === undefined
      ? { content: found.content, innerContent: found.innerContent, ...entry }
      : {
          name,
          index,
          content: found.content,
          innerContent: found.innerContent,
          ...entry,
        };
  return Object.defineProperties(res, {
    startIndex: { value: found.startIndex, enumerable: false },
    contentStart: { value: found.contentStart, enumerable: false },
    closeIndex: { value: found.closeIndex, enumerable: false },
    endIndex: { value: found.endIndex, enumerable: false },
  });
};

export const getTag = (
  htmlString: string,
  tagName: string,
  componentList?: ComponentList,
  masked?: string,
  searchFrom = 0,
  scanner?: AttributeValueScanner,
): Partial<BascikComponent> & {
  startIndex?: number;
  contentStart?: number;
  closeIndex?: number;
  endIndex?: number;
} => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return {};
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  // A caller's scanner is only valid for the mask it was built on.
  const found = findTag(
    htmlString,
    tagName,
    maskedHtml,
    searchFrom,
    scanner && masked !== undefined ? scanner : undefined,
  );
  if (!found) return {};
  return tagResult(found, componentList?.[tagName.toLowerCase()]);
};

/**
 * One compiled close-tag pattern per tag name, shared: every user sets
 * `lastIndex` before it executes and runs synchronously, so a shared
 * instance never carries state from one search into another. Bounded,
 * since `getTag` takes any tag name.
 */
const tagPatterns = new Map<string, RegExp>();
const closeTagPattern = (tagName: string): RegExp => {
  const key = tagName.toLowerCase();
  let pattern = tagPatterns.get(key);
  if (!pattern) {
    const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Sticky: matches only at `lastIndex`, with no copy of the rest.
    pattern = closeAtPattern(tn);
    if (tagPatterns.size >= 1024) tagPatterns.clear();
    tagPatterns.set(key, pattern);
  }
  return pattern;
};

/**
 * Find the first `tagName` element at or after `searchFrom`: paired (with
 * its balanced close), unclosed (the open tag alone), or self-closing.
 * Indices are whole-document coordinates. Null when there is none.
 */
const findTag = (
  htmlString: string,
  tagName: string,
  maskedHtml: string,
  searchFrom: number,
  scanner?: AttributeValueScanner,
  closeFinder?: ComponentSearchState["closeFinder"],
  lastCloseAt?: ComponentSearchState["lastCloseAt"],
): FoundTag | null => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return null;
  // Use findMatchingClose (a depth counter) instead of a lazy regex so nested
  // same-name elements pair with the correct (balanced) closing tag, e.g.
  // <my-list>...<my-list></my-list>...</my-list>.
  const attributeScan = scanner ?? createAttributeValueScanner(maskedHtml);
  const openTag = findOpenTag(
    htmlString,
    tagName,
    maskedHtml,
    searchFrom,
    attributeScan,
  );
  if (openTag && !/\/\s*>$/.test(openTag.openTag)) {
    const closeIndex =
      lastCloseAt && lastCloseAt(tagName) < openTag.end
        ? -1
        : closeFinder
          ? closeFinder(tagName, openTag.end)
          : findMatchingClose(
              htmlString,
              tagName,
              openTag.end,
              maskedHtml,
              attributeScan,
            );
    if (closeIndex !== -1) {
      const closeTag = closeTagPattern(tagName);
      closeTag.lastIndex = closeIndex;
      const closeTagMatch = closeTag.exec(htmlString);
      if (closeTagMatch) {
        const endIndex = closeIndex + closeTagMatch[0].length;
        return {
          content: htmlString.slice(openTag.start, endIndex),
          innerContent: htmlString.slice(openTag.end, closeIndex),
          startIndex: openTag.start,
          contentStart: openTag.end,
          closeIndex,
          endIndex,
        };
      }
    }
  }

  if (openTag) {
    return {
      content: openTag.openTag,
      innerContent: "",
      startIndex: openTag.start,
      contentStart: openTag.end,
      closeIndex: -1,
      endIndex: openTag.end,
    };
  }

  // Try self-closing: <tagName ... /> or <tagName/>
  // Search the masked string so literal tag text inside raw-text elements is skipped.
  // This is `<tagName(?=[\t\n\f\r />])([\s\S]*?)\/?>` (flags `gi`) in
  // linear time: a match ends just past the first `>` after the name, and
  // when no `>` follows one opener none follows a later one.
  const name = tagName.toLowerCase();
  for (
    let start = maskedHtml.indexOf("<", searchFrom);
    start !== -1;
    start = maskedHtml.indexOf("<", start + 1)
  ) {
    if (!nameAt(maskedHtml, start + 1, name)) continue;
    const nameEnd = start + 1 + name.length;
    if (!isTagNameEndCode(maskedHtml.charCodeAt(nameEnd))) continue;
    const gt = maskedHtml.indexOf(">", nameEnd);
    if (gt === -1) break;
    if (attributeScan.isInsideTag(start)) {
      start = gt;
      continue;
    }
    const endIndex = gt + 1;
    return {
      content: htmlString.slice(start, endIndex),
      innerContent: "",
      startIndex: start,
      contentStart: endIndex,
      closeIndex: -1,
      endIndex,
    };
  }

  return null;
};

/**
 * Find the index of the closing `</tagName>` that properly balances with the
 * opening tag whose content starts at `contentStart`.  Uses a simple depth
 * counter so nested elements of the same tag type are handled correctly.
 *
 * Returns the index of `</tagName>` in `html`, or -1 if not found.
 */
export const findMatchingClose = (
  html: string,
  tagName: string,
  contentStart: number,
  masked?: string,
  scanner?: AttributeValueScanner,
): number => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return -1;
  // Scan the masked string so literal tag text inside <script>/<style>/<textarea>
  // content never skews the depth counter. Indices are valid in the original.
  const maskedHtml = masked !== undefined ? masked : maskRawTextContent(html);
  const attributeScan =
    scanner && masked !== undefined
      ? scanner
      : createAttributeValueScanner(maskedHtml);
  const openTags = componentOpenTags(maskedHtml, tagName);
  const closes = createCloseSearch(maskedHtml, tagName);
  let depth = 1;
  let pos = contentStart;
  // The leftmost close from an earlier position that still starts at or
  // after this one is the leftmost from here too: reuse it instead of
  // searching again past every open tag before it.
  let closeMatch: CloseMatch | null | undefined;
  while (pos < maskedHtml.length) {
    if (closeMatch === undefined || (closeMatch && closeMatch.index < pos))
      closeMatch = closes(pos);
    const openMatch = openTags.next(pos);
    if (!closeMatch) return -1;
    if (!openMatch || closeMatch.index < openMatch.start) {
      // A close inside another tag or a bogus comment is part of it.
      if (attributeScan.isInsideTag(closeMatch.index)) {
        pos = closeMatch.end;
        continue;
      }
      depth--;
      if (depth === 0) return closeMatch.index;
      pos = closeMatch.end;
    } else {
      if (!attributeScan.isInsideTag(openMatch.start)) {
        if (
          !SELF_CLOSING_END_RE.test(
            maskedHtml.slice(openMatch.start, openMatch.end),
          )
        ) {
          depth++;
        }
      }
      pos = openMatch.end;
    }
  }
  return -1;
};

interface CloseTokens {
  /** Start and end of each open or close token, in scan order. */
  starts: number[];
  ends: number[];
  /** `depths[k]`: the depth change before token k, relative to the start. */
  depths: number[];
  /** Close index for a scan starting at token boundary k, once known. */
  answers: number[];
  /** Boundaries whose matching close is not found yet (depths ascending). */
  pending: number[];
  openTags: OpenTagScanner;
  /**
   * Its own, so its queries only move forward: one scanner shared by
   * several names restarts from the top whenever one name's tokens lag
   * another's.
   */
  scanner: AttributeValueScanner;
  closes: (from: number) => CloseMatch | null;
  nextOpen: OpenTagMatch | null | undefined;
  nextClose: CloseMatch | null | undefined;
  pos: number;
  done: boolean;
}

/**
 * Return a `findMatchingClose(html, tagName, contentStart, masked)` that
 * answers many starts on one string in linear total time.
 *
 * Calling `findMatchingClose` per wrapper rescans from each start: an
 * unclosed wrapper scans to the end of the template, and a run of opens
 * closed once at the end walks every later open, so thousands of them cost
 * quadratic time. The finder tokenizes the string once per tag name, in the
 * same order `findMatchingClose` does (the earliest open or close at or after
 * the cursor), and pairs each token boundary with the first later token that
 * drops the depth below it, which is exactly where a depth count started
 * there reaches zero. A start that falls inside a token (a scan from there
 * would tokenize differently) falls back to `findMatchingClose`.
 */
export const createMatchingCloseFinder = (
  html: string,
  masked: string,
): ((tagName: string, contentStart: number) => number) => {
  const byTag = new Map<string, CloseTokens>();

  const advance = (tokens: CloseTokens): boolean => {
    if (tokens.done) return false;
    const { pos } = tokens;
    if (pos >= masked.length) return finish(tokens);
    // A match found from an earlier cursor that still starts at or after
    // this one is the leftmost match from here too.
    if (
      tokens.nextClose === undefined ||
      (tokens.nextClose !== null && tokens.nextClose.index < pos)
    ) {
      tokens.nextClose = tokens.closes(pos);
    }
    const close = tokens.nextClose;
    if (close === null) return finish(tokens);
    if (
      tokens.nextOpen === undefined ||
      (tokens.nextOpen !== null && tokens.nextOpen.start < pos)
    ) {
      tokens.nextOpen = tokens.openTags.next(pos);
    }
    const open = tokens.nextOpen;
    let start: number;
    let end: number;
    let delta = 0;
    if (open === null || close.index < open.start) {
      start = close.index;
      end = close.end;
      if (!tokens.scanner.isInsideTag(start)) delta = -1;
    } else {
      start = open.start;
      end = open.end;
      if (
        !tokens.scanner.isInsideTag(start) &&
        !SELF_CLOSING_END_RE.test(masked.slice(start, end))
      )
        delta = 1;
    }
    const token = tokens.starts.length;
    tokens.starts.push(start);
    tokens.ends.push(end);
    const depth = tokens.depths[token] + delta;
    tokens.depths.push(depth);
    while (
      tokens.pending.length > 0 &&
      tokens.depths[tokens.pending[tokens.pending.length - 1]] > depth
    )
      tokens.answers[tokens.pending.pop()!] = start;
    tokens.pending.push(token + 1);
    tokens.pos = end;
    return true;
  };

  const finish = (tokens: CloseTokens): false => {
    tokens.done = true;
    for (const boundary of tokens.pending) tokens.answers[boundary] = -1;
    tokens.pending = [];
    return false;
  };

  return (tagName: string, contentStart: number): number => {
    if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return -1;
    const key = tagName.toLowerCase();
    let tokens = byTag.get(key);
    if (tokens === undefined) {
      tokens = {
        starts: [],
        ends: [],
        depths: [0],
        answers: [],
        pending: [0],
        openTags: componentOpenTags(masked, key),
        scanner: createAttributeValueScanner(masked),
        closes: createCloseSearch(masked, key),
        nextOpen: undefined,
        nextClose: undefined,
        pos: 0,
        done: false,
      };
      byTag.set(key, tokens);
    }
    const { starts, ends } = tokens;
    while (
      (starts.length === 0 || starts[starts.length - 1] < contentStart) &&
      advance(tokens)
    );
    // The first token at or after the start.
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] < contentStart) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && ends[low - 1] > contentStart)
      return findMatchingClose(html, tagName, contentStart, masked);
    while (tokens.answers[low] === undefined && advance(tokens));
    return tokens.answers[low] ?? -1;
  };
};
