import { ATTR_VALUE } from "./component-attribute-scan.ts";
import { maskRawTextContent } from "./component-masking.ts";
import { createMatchingCloseFinder, getTag } from "./component-tags.ts";

interface NamedSlot {
  slotName: string;
  startIndex: number;
  endIndex: number;
  content: string;
}

/**
 * Parse all `data-bascik-slot="name"` wrapper elements from `innerContent`,
 * returning an array of `{ slotName, startIndex, endIndex, content }` objects
 * where `startIndex`/`endIndex` delimit the entire wrapper element (including
 * its opening and closing tags) in the original string.
 *
 * Uses a stack-based depth counter so nested same-tag elements are handled
 * correctly — e.g. a `<div data-bascik-slot="x"><div>…</div></div>` wrapper
 * that contains inner `<div>` elements will be correctly closed at the outer
 * `</div>`, not the first inner one.
 */
const parseNamedSlots = (
  innerContent: string,
  componentNames: ReadonlySet<string> = new Set(),
): NamedSlot[] => {
  if (!innerContent.includes("data-bascik-slot")) return [];
  const results: NamedSlot[] = [];
  const masked = maskRawTextContent(innerContent);
  // Quote-aware attribute scan (ATTR_VALUE) so the marker may appear after
  // other attributes, and `data-bascik-slot` inside a quoted attribute value
  // never false-positives.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRe = new RegExp(
    `<(\\w+(?:-\\w+)*)(?=[\\s>])(?:${ATTR_VALUE}?)\\s+data-bascik-slot\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s"'=<>` +
      "`" +
      `/>]+))(?:${ATTR_VALUE})>`,
    "gi",
  );
  // One close finder and one nested-component index for the whole scan:
  // wrappers come in document order, so each advances monotonically instead
  // of rescanning from each wrapper (quadratic in a template that repeats a
  // slot, or leaves thousands of wrappers unclosed).
  const findClose = createMatchingCloseFinder(innerContent, masked);
  const isInsideNestedComponent = createNestedComponentCheck(
    innerContent,
    componentNames,
    masked,
  );
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(masked)) !== null) {
    const [fullOpen, tagName, doubleName, singleName, unquotedName] = match;
    const slotName = doubleName ?? singleName ?? unquotedName;
    if (isInsideNestedComponent(match.index)) continue;
    const contentStart = match.index + fullOpen.length;
    const closeIndex = findClose(tagName, contentStart);
    if (closeIndex === -1) continue;
    const closeTagMatch = closeTagAt(innerContent, tagName, closeIndex);
    const closeTagLen = closeTagMatch
      ? closeTagMatch[0].length
      : `</${tagName}>`.length;
    const endIndex = closeIndex + closeTagLen;
    results.push({
      slotName,
      startIndex: match.index,
      endIndex,
      content: innerContent.slice(contentStart, closeIndex),
    });
    // Advance past the entire wrapper element so we don't re-process it
    openTagRe.lastIndex = endIndex;
  }
  return results;
};

/**
 * The close tag `</tagName>` (any case, optional whitespace before `>`) that
 * starts exactly at `closeIndex`, matched in place instead of on a copy of the
 * rest of the template.
 */
const closeTagAt = (
  html: string,
  tagName: string,
  closeIndex: number,
): RegExpExecArray | null => {
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const closeRe = new RegExp(`<\\/${tagName}\\s*>`, "iy");
  closeRe.lastIndex = closeIndex;
  return closeRe.exec(html);
};

interface ChildSpan {
  startIndex: number;
  contentStart?: number;
  closeIndex?: number;
}

/**
 * Returns a check telling whether an index is inside an unresolved child
 * component usage. Named slots belong to their nearest component boundary, so
 * a parent must not consume slot wrappers authored inside a nested component's
 * usage content.
 *
 * The check is built for indices in increasing order (wrappers are scanned in
 * document order): the tag names opened so far and each component's usages
 * are found once and reused, so a template with thousands of wrappers is not
 * rescanned from the start per wrapper. An index lower than the previous one
 * starts over, so the answer never depends on the order of the calls.
 */
const createNestedComponentCheck = (
  html: string,
  componentNames: ReadonlySet<string>,
  masked: string,
): ((index: number) => boolean) => {
  if (componentNames.size === 0) return () => false;
  // Lowercase names `getTag` could find opening before the index: each `<name`
  // token, plus its prefixes ending at a `:` (`<a:b` also opens `a`).
  let present = new Set<string>();
  let tokenRe = /<([a-zA-Z][\w:-]*)/g;
  let pendingToken = tokenRe.exec(masked);
  // Each component's usages in document order, found lazily: the sequence a
  // scan from the start yields does not depend on the index asked about.
  let usages = new Map<
    string,
    { spans: ChildSpan[]; live: number; searchFrom: number; done: boolean }
  >();
  let lastIndex = -1;
  return (index: number): boolean => {
    if (index < lastIndex) {
      present = new Set();
      tokenRe = /<([a-zA-Z][\w:-]*)/g;
      pendingToken = tokenRe.exec(masked);
      usages = new Map();
    }
    lastIndex = index;
    while (pendingToken !== null && pendingToken.index < index) {
      const name = pendingToken[1].toLowerCase();
      present.add(name);
      for (let colon = name.indexOf(":"); colon !== -1;) {
        present.add(name.slice(0, colon));
        colon = name.indexOf(":", colon + 1);
      }
      pendingToken = tokenRe.exec(masked);
    }
    for (const componentName of componentNames) {
      if (!present.has(componentName.toLowerCase())) continue;
      let state = usages.get(componentName);
      if (state === undefined) {
        state = { spans: [], live: 0, searchFrom: 0, done: false };
        usages.set(componentName, state);
      }
      while (!state.done && state.searchFrom < index) {
        const child = getTag(
          html,
          componentName,
          undefined,
          masked,
          state.searchFrom,
        );
        const startIndex = child.startIndex;
        if (typeof startIndex !== "number") {
          state.done = true;
          break;
        }
        state.spans.push({
          startIndex,
          contentStart: child.contentStart,
          closeIndex: child.closeIndex,
        });
        const endIndex = child.endIndex;
        state.searchFrom =
          typeof endIndex === "number" && endIndex > startIndex
            ? endIndex
            : startIndex + 1;
        if (startIndex >= index) break;
      }
      // A usage that closes at or before this index (or never closes) cannot
      // contain this or any later index: skip the leading run of them for good.
      while (state.live < state.spans.length) {
        const closeIndex = state.spans[state.live].closeIndex;
        if (
          typeof closeIndex === "number" &&
          closeIndex !== -1 &&
          closeIndex > index
        )
          break;
        state.live++;
      }
      for (let at = state.live; at < state.spans.length; at++) {
        const span = state.spans[at];
        if (span.startIndex >= index) break;
        const { contentStart, closeIndex } = span;
        if (
          typeof contentStart === "number" &&
          typeof closeIndex === "number" &&
          closeIndex !== -1 &&
          index >= contentStart &&
          index < closeIndex
        ) {
          return true;
        }
      }
    }
    return false;
  };
};

/**
 * Strip `data-bascik-slot="name"` wrapper elements from inner content,
 * leaving only the content intended for the default slot.
 *
 * e.g. '<p>body</p><div data-bascik-slot="side"><nav>nav</nav></div>'
 *      → '<p>body</p>'
 */
export const extractDefaultSlotContent = (
  innerContent: string | undefined,
  componentNames: ReadonlySet<string> = new Set(),
): string => {
  if (!innerContent) return "";
  const named = parseNamedSlots(innerContent, componentNames);
  if (named.length === 0) return innerContent.trim();
  // Keep the text between the wrappers (document order, never overlapping)
  // and join once instead of splicing each wrapper out of the whole string.
  const parts: string[] = [];
  let cursor = 0;
  for (const { startIndex, endIndex } of named) {
    parts.push(innerContent.slice(cursor, startIndex));
    cursor = endIndex;
  }
  parts.push(innerContent.slice(cursor));
  return parts.join("").trim();
};

/**
 * Extract named slot content from a component usage's inner HTML.
 * Looks for wrapper elements carrying `data-bascik-slot="slotName"`.
 *
 * e.g. '<div data-bascik-slot="header"><h1>H</h1></div>'
 *      → { header: "<h1>H</h1>" }
 */
export const extractNamedSlotContent = (
  innerContent: string | undefined,
  componentNames: ReadonlySet<string> = new Set(),
): Record<string, string> => {
  if (!innerContent) return {};
  const slots: Record<string, string> = {};
  for (const { slotName, content } of parseNamedSlots(
    innerContent,
    componentNames,
  )) {
    slots[slotName] = content;
  }
  return slots;
};

/**
 * In a component template, replace `data-bascik-slot="name"` placeholder
 * elements with the corresponding named slot content.  Placeholders with no
 * matching content are removed entirely.
 *
 * e.g. template `<footer><div data-bascik-slot="links"></div></footer>`
 *      slots   `{ links: "<a href='/'>Home</a>" }`
 *      → `<footer><a href='/'>Home</a></footer>`
 */
export const replaceNamedSlots = (
  fileContent: string,
  slots: Record<string, string>,
  componentNames: ReadonlySet<string> = new Set(),
): string => {
  // Scan wrappers with the same depth-aware parser used for extraction so
  // nested same-tag elements inside a placeholder's fallback content are
  // handled correctly.
  const wrappers = parseNamedSlots(fileContent, componentNames);
  if (wrappers.length === 0) return fileContent;
  const slotsLowerMap = new Map<string, string>();
  for (const [key, val] of Object.entries(slots)) {
    slotsLowerMap.set(key.toLowerCase(), val);
  }
  // One join, not a splice per wrapper: slicing the growing result copied it
  // once per wrapper, quadratic in a template that repeats a slot. The
  // wrappers are in document order and never overlap.
  const parts: string[] = [];
  let cursor = 0;
  for (const { slotName, startIndex, endIndex, content } of wrappers) {
    // Use the element's own inner content as fallback when the slot is not provided
    // Own keys only: a slot named `constructor` or `toString` that the usage
    // did not fill keeps its fallback instead of Object.prototype's member.
    const matchedSlot = Object.hasOwn(slots, slotName)
      ? slots[slotName]
      : slotsLowerMap.get(slotName.toLowerCase());
    const replacement = matchedSlot !== undefined ? matchedSlot : content;
    parts.push(fileContent.slice(cursor, startIndex), replacement);
    cursor = endIndex;
  }
  parts.push(fileContent.slice(cursor));
  return parts.join("");
};

/**
 * In a component template, replace valueless `data-bascik-slot` default slot
 * marker elements with `defaultSlotContent`.  When no content is provided the
 * marker element's own inner content is kept as fallback.
 *
 * Depth-aware: nested same-tag elements inside the marker's fallback content
 * are balanced correctly, and other attributes may precede the marker.
 */
export const replaceDefaultSlots = (
  fileContent: string,
  defaultSlotContent: string,
): string => {
  if (!fileContent.includes("data-bascik-slot")) return fileContent;
  const masked = maskRawTextContent(fileContent);
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRe = new RegExp(
    `<(\\w+(?:-\\w+)*)(?=[\\s>])(?:${ATTR_VALUE}?)\\s+data-bascik-slot(?!\\s*=)(?:${ATTR_VALUE})>`,
    "gi",
  );
  const wrappers: Array<{
    startIndex: number;
    endIndex: number;
    content: string;
  }> = [];
  const findClose = createMatchingCloseFinder(fileContent, masked);
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(masked)) !== null) {
    const [fullOpen, tagName] = match;
    const contentStart = match.index + fullOpen.length;
    const closeIndex = findClose(tagName, contentStart);
    if (closeIndex === -1) continue;
    const closeTagMatch = closeTagAt(fileContent, tagName, closeIndex);
    const closeTagLen = closeTagMatch
      ? closeTagMatch[0].length
      : `</${tagName}>`.length;
    const endIndex = closeIndex + closeTagLen;
    wrappers.push({
      startIndex: match.index,
      endIndex,
      content: fileContent.slice(contentStart, closeIndex),
    });
    openTagRe.lastIndex = endIndex;
  }
  // One join, not a splice per marker: slicing the growing result copied it
  // once per marker, quadratic in a template that repeats the slot. The
  // wrappers are in document order and never overlap.
  const parts: string[] = [];
  let cursor = 0;
  for (const { startIndex, endIndex, content } of wrappers) {
    parts.push(
      fileContent.slice(cursor, startIndex),
      defaultSlotContent || content,
    );
    cursor = endIndex;
  }
  parts.push(fileContent.slice(cursor));
  return parts.join("");
};
