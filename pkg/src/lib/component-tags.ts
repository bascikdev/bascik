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
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A fresh `g` instance per call so `lastIndex` is invocation-local (pages
  // may transpile concurrently); V8 caches the compiled pattern by source.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRegexp = new RegExp(`<${tn}(?![\\w-])(?:${ATTR_VALUE})>`, "gi");
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

  const rawKeys = Object.keys(componentList);
  const keyCount = rawKeys.length;
  const firstKey = rawKeys[0];
  const lastKey = rawKeys[keyCount - 1];
  let cached = componentRegexCache.get(componentList);
  if (
    !cached ||
    cached.keyCount !== keyCount ||
    cached.firstKey !== firstKey ||
    cached.lastKey !== lastKey
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
    cached = { keyCount, firstKey, lastKey, regex };
    componentRegexCache.set(componentList, cached);
  }

  if (!cached.regex) return {};
  // Never exec the shared cached instance: `lastIndex` on a `g` regex is
  // mutable state, and pages can transpile concurrently. Clone per call.
  const matchComponentName = new RegExp(
    cached.regex.source,
    cached.regex.flags,
  );
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
  const tagInfo = getTag(
    htmlString,
    firstComponentName,
    componentList,
    maskedHtml,
    match.index,
    attributeScan,
  );
  const resultObj: Partial<BascikComponent> & {
    index?: number;
    startIndex?: number;
    endIndex?: number;
    contentStart?: number;
    closeIndex?: number;
  } = {
    name: firstComponentName,
    index: match.index,
    ...tagInfo,
  };
  if (typeof tagInfo.startIndex === "number") {
    Object.defineProperty(resultObj, "startIndex", {
      value: tagInfo.startIndex,
      enumerable: false,
    });
  }
  if (typeof tagInfo.endIndex === "number") {
    Object.defineProperty(resultObj, "endIndex", {
      value: tagInfo.endIndex,
      enumerable: false,
    });
  }
  // Where the usage tag's inner content starts and its closing tag begins (-1 when the tag has
  // no closing tag), so a caller can edit just the inner content.
  if (typeof tagInfo.contentStart === "number") {
    Object.defineProperty(resultObj, "contentStart", {
      value: tagInfo.contentStart,
      enumerable: false,
    });
  }
  if (typeof tagInfo.closeIndex === "number") {
    Object.defineProperty(resultObj, "closeIndex", {
      value: tagInfo.closeIndex,
      enumerable: false,
    });
  }
  return resultObj;
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
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try paired tags: <tagName ...>content</tagName>
  // Use findMatchingClose (a depth counter) instead of a lazy regex so nested
  // same-name elements pair with the correct (balanced) closing tag, e.g.
  // <my-list>...<my-list></my-list>...</my-list>.
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  // A caller's scanner is only valid for the mask it was built on.
  const attributeScan =
    scanner && masked !== undefined
      ? scanner
      : createAttributeValueScanner(maskedHtml);
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
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const closeTagRegexp = new RegExp(`^<\\/${tn}\\s*>`, "i");
      const closeTagMatch = closeTagRegexp.exec(htmlString.slice(closeIndex));
      if (closeTagMatch) {
        const returnObj: Partial<BascikComponent> & {
          startIndex?: number;
          contentStart?: number;
          closeIndex?: number;
          endIndex?: number;
        } = {
          content: htmlString.slice(
            openTag.start,
            closeIndex + closeTagMatch[0].length,
          ),
          innerContent: htmlString.slice(openTag.end, closeIndex),
        };
        Object.defineProperties(returnObj, {
          startIndex: { value: openTag.start, enumerable: false },
          contentStart: { value: openTag.end, enumerable: false },
          closeIndex: { value: closeIndex, enumerable: false },
          endIndex: {
            value: closeIndex + closeTagMatch[0].length,
            enumerable: false,
          },
        });
        if (!componentList) return returnObj;
        const res = { ...returnObj, ...componentList[tagName.toLowerCase()] };
        Object.defineProperties(res, {
          startIndex: { value: openTag.start, enumerable: false },
          contentStart: { value: openTag.end, enumerable: false },
          closeIndex: { value: closeIndex, enumerable: false },
          endIndex: {
            value: closeIndex + closeTagMatch[0].length,
            enumerable: false,
          },
        });
        return res;
      }
    }
  }

  if (openTag) {
    const returnObj: Partial<BascikComponent> & {
      startIndex?: number;
      contentStart?: number;
      closeIndex?: number;
      endIndex?: number;
    } = {
      content: openTag.openTag,
      innerContent: "",
    };
    Object.defineProperties(returnObj, {
      startIndex: { value: openTag.start, enumerable: false },
      contentStart: { value: openTag.end, enumerable: false },
      closeIndex: { value: -1, enumerable: false },
      endIndex: { value: openTag.end, enumerable: false },
    });
    if (!componentList) return returnObj;
    const res = { ...returnObj, ...componentList[tagName.toLowerCase()] };
    Object.defineProperties(res, {
      startIndex: { value: openTag.start, enumerable: false },
      contentStart: { value: openTag.end, enumerable: false },
      closeIndex: { value: -1, enumerable: false },
      endIndex: { value: openTag.end, enumerable: false },
    });
    return res;
  }

  // Try self-closing: <tagName ... /> or <tagName/>
  // Search the masked string so literal tag text inside raw-text elements is skipped.
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
    const returnObj: Partial<BascikComponent> & {
      startIndex?: number;
      contentStart?: number;
      closeIndex?: number;
      endIndex?: number;
    } = {
      content: htmlString.slice(
        selfClosingMatch.index,
        selfClosingMatch.index + selfClosingMatch[0].length,
      ),
      innerContent: "",
    };
    Object.defineProperties(returnObj, {
      startIndex: { value: selfClosingMatch.index, enumerable: false },
      contentStart: {
        value: selfClosingMatch.index + selfClosingMatch[0].length,
        enumerable: false,
      },
      closeIndex: { value: -1, enumerable: false },
      endIndex: {
        value: selfClosingMatch.index + selfClosingMatch[0].length,
        enumerable: false,
      },
    });
    if (!componentList) return returnObj;
    const res = { ...returnObj, ...componentList[tagName.toLowerCase()] };
    Object.defineProperties(res, {
      startIndex: { value: selfClosingMatch.index, enumerable: false },
      contentStart: {
        value: selfClosingMatch.index + selfClosingMatch[0].length,
        enumerable: false,
      },
      closeIndex: { value: -1, enumerable: false },
      endIndex: {
        value: selfClosingMatch.index + selfClosingMatch[0].length,
        enumerable: false,
      },
    });
    return res;
  }

  return {};
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
