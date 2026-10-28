import {
  ATTR_VALUE,
  createAttributeValueScanner,
  type AttributeValueCheckpoint,
  type AttributeValueScanner,
  type ComponentSearchState,
} from "./component-attribute-scan.ts";
import { maskRawTextContent } from "./component-masking.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

interface ComponentRegexCacheEntry {
  keyCount: number;
  firstKey: string | undefined;
  lastKey: string | undefined;
  regex: RegExp | null;
}

const componentRegexCache = new WeakMap<
  ComponentList,
  ComponentRegexCacheEntry
>();

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
  // Shared (see tagPattern): this search is synchronous and sets lastIndex.
  const openTagRegexp = tagPattern("open", tagName);
  openTagRegexp.lastIndex = searchFrom;
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  const attributeScan = scanner ?? createAttributeValueScanner(maskedHtml);
  let openTagMatch: RegExpExecArray | null;
  while ((openTagMatch = openTagRegexp.exec(maskedHtml)) !== null) {
    if (attributeScan.isInsideValue(openTagMatch.index)) continue;
    return {
      openTag: openTagMatch[0],
      start: openTagMatch.index,
      end: openTagMatch.index + openTagMatch[0].length,
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
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const closeTagRegexp = new RegExp(`^<\\/${tn}\\s*>`, "i");
      const closeTagMatch = closeTagRegexp.exec(htmlString.slice(closeIndex));
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
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const selfClosingRegexp = new RegExp(
    `<${tn}(?:${ATTR_VALUE})\\s*\\/?>`,
    "gi",
  );
  const attributeScan = createAttributeValueScanner(maskedHtml);
  let selfClosingMatch: RegExpExecArray | null;
  while ((selfClosingMatch = selfClosingRegexp.exec(maskedHtml)) !== null) {
    if (attributeScan.isInsideValue(selfClosingMatch.index)) continue;
    break;
  }
  if (!selfClosingMatch) return htmlString;
  return (
    htmlString.slice(0, selfClosingMatch.index) +
    transpiledTag +
    htmlString.slice(selfClosingMatch.index + selfClosingMatch[0].length)
  );
};

/**
 * The list's tag regex (longest name first), or null when it names nothing.
 * The shared instance is safe to exec: its users are synchronous and set
 * `lastIndex` before each search.
 */
const componentRegexFor = (componentList: ComponentList): RegExp | null => {
  let cached = componentRegexCache.get(componentList);
  // A frozen list (the request path's, one per manifest) cannot change, so
  // its regex is keyed on identity alone; any other list may be edited in
  // place between calls (the build's, in dev), so its names are re-read.
  const rawKeys =
    cached && Object.isFrozen(componentList)
      ? undefined
      : Object.keys(componentList);
  const keyCount = rawKeys?.length;
  const firstKey = rawKeys?.[0];
  const lastKey = rawKeys?.[rawKeys.length - 1];
  if (
    rawKeys &&
    (!cached ||
      cached.keyCount !== keyCount ||
      cached.firstKey !== firstKey ||
      cached.lastKey !== lastKey)
  ) {
    const componentNames = rawKeys
      .filter((name) => /^[a-zA-Z][\w:-]*$/.test(name))
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    // Super important here, reverse, makes it so we're matching on the most specific tag first
    // Meaning, it will find test-comp-clone before test-comp,
    // because reverse, the longer tag will be first in the regexp, and therefore match first.
    // It's like how an ingress controller works.
    const escapedComponentNames = componentNames.map((name) =>
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const regex =
      escapedComponentNames.length === 0
        ? null
        : new RegExp(
            `<(${escapedComponentNames.join("|")})(?![\\w-])[\\s\\S]*?>`,
            "gi",
          );
    cached = { keyCount: keyCount!, firstKey, lastKey, regex };
    componentRegexCache.set(componentList, cached);
  }

  return cached!.regex;
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
  const regex = componentRegexFor(componentList);
  if (!regex) return false;
  regex.lastIndex = 0;
  return regex.test(html);
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

  const matchComponentName = componentRegexFor(componentList);
  if (!matchComponentName) return {};
  matchComponentName.lastIndex = searchFrom;

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
  let match: RegExpExecArray | null;
  while ((match = matchComponentName.exec(maskedHtml)) !== null) {
    if (searchState && match.index > 0) {
      // Stop one byte short: replacing the tag changes the byte the scan peeks at.
      attributeScan.isInsideValue(match.index - 1);
      checkpoint = attributeScan.checkpoint();
    }
    if (attributeScan.isInsideValue(match.index)) continue;
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
  const firstComponentName = match[1].toLowerCase();
  const found = findTag(
    htmlString,
    firstComponentName,
    maskedHtml,
    match.index,
    attributeScan,
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
 * One compiled pattern per tag name and kind, shared: every user sets
 * `lastIndex` before it executes and runs synchronously, so a shared
 * instance never carries state from one search into another. Bounded,
 * since `getTag` takes any tag name.
 */
const tagPatterns = new Map<string, RegExp>();
const tagPattern = (kind: "open" | "close", tagName: string): RegExp => {
  const key = `${kind}:${tagName.toLowerCase()}`;
  let pattern = tagPatterns.get(key);
  if (!pattern) {
    const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (kind === "open") {
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      pattern = new RegExp(`<${tn}(?![\\w-])(?:${ATTR_VALUE})>`, "gi");
    } else {
      // Sticky: matches only at `lastIndex`, with no copy of the rest.
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      pattern = new RegExp(`<\\/${tn}\\s*>`, "iy");
    }
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
    const closeIndex = findMatchingClose(
      htmlString,
      tagName,
      openTag.end,
      maskedHtml,
      attributeScan,
    );
    if (closeIndex !== -1) {
      const closeTag = tagPattern("close", tagName);
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
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const selfClosingPattern = new RegExp(
    `<${tn}(?![\\w-])([\\s\\S]*?)\\/?>`,
    "gi",
  );
  selfClosingPattern.lastIndex = searchFrom;
  let selfClosingMatch: RegExpExecArray | null;
  while ((selfClosingMatch = selfClosingPattern.exec(maskedHtml)) !== null) {
    if (attributeScan.isInsideValue(selfClosingMatch.index)) continue;
    break;
  }
  if (selfClosingMatch) {
    const endIndex = selfClosingMatch.index + selfClosingMatch[0].length;
    return {
      content: htmlString.slice(selfClosingMatch.index, endIndex),
      innerContent: "",
      startIndex: selfClosingMatch.index,
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
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openRe = new RegExp(`<${tn}(?![\\w-])(?:${ATTR_VALUE})>`, "gi");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const closeRe = new RegExp(`<\\/${tn}\\s*>`, "gi");
  // Scan the masked string so literal tag text inside <script>/<style>/<textarea>
  // content never skews the depth counter. Indices are valid in the original.
  const maskedHtml = masked !== undefined ? masked : maskRawTextContent(html);
  const attributeScan =
    scanner && masked !== undefined
      ? scanner
      : createAttributeValueScanner(maskedHtml);
  let depth = 1;
  let pos = contentStart;
  while (pos < maskedHtml.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const openMatch = openRe.exec(maskedHtml);
    const closeMatch = closeRe.exec(maskedHtml);
    if (!closeMatch) return -1;
    if (!openMatch || closeMatch.index < openMatch.index) {
      if (attributeScan.isInsideValue(closeMatch.index)) {
        pos = closeMatch.index + closeMatch[0].length;
        continue;
      }
      depth--;
      if (depth === 0) return closeMatch.index;
      pos = closeMatch.index + closeMatch[0].length;
    } else {
      if (!attributeScan.isInsideValue(openMatch.index)) {
        if (!/\/\s*>$/.test(openMatch[0])) {
          depth++;
        }
      }
      pos = openMatch.index + openMatch[0].length;
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
  openRe: RegExp;
  closeRe: RegExp;
  nextOpen: RegExpExecArray | null | undefined;
  nextClose: RegExpExecArray | null | undefined;
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
  const scanner = createAttributeValueScanner(masked);
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
      tokens.closeRe.lastIndex = pos;
      tokens.nextClose = tokens.closeRe.exec(masked);
    }
    const close = tokens.nextClose;
    if (close === null) return finish(tokens);
    if (
      tokens.nextOpen === undefined ||
      (tokens.nextOpen !== null && tokens.nextOpen.index < pos)
    ) {
      tokens.openRe.lastIndex = pos;
      tokens.nextOpen = tokens.openRe.exec(masked);
    }
    const open = tokens.nextOpen;
    let start: number;
    let end: number;
    let delta = 0;
    if (open === null || close.index < open.index) {
      start = close.index;
      end = start + close[0].length;
      if (!scanner.isInsideValue(start)) delta = -1;
    } else {
      start = open.index;
      end = start + open[0].length;
      if (!scanner.isInsideValue(start) && !/\/\s*>$/.test(open[0])) delta = 1;
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
      const tn = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      tokens = {
        starts: [],
        ends: [],
        depths: [0],
        answers: [],
        pending: [0],
        // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
        openRe: new RegExp(`<${tn}(?![\\w-])(?:${ATTR_VALUE})>`, "gi"),
        // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
        closeRe: new RegExp(`<\\/${tn}\\s*>`, "gi"),
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
