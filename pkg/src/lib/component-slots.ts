import { ATTR_VALUE } from "./component-attribute-scan.ts";
import { maskRawTextContent } from "./component-masking.ts";
import { findMatchingClose, getTag } from "./component-tags.ts";

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
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(masked)) !== null) {
    const [fullOpen, tagName, doubleName, singleName, unquotedName] = match;
    const slotName = doubleName ?? singleName ?? unquotedName;
    if (
      isInsideNestedComponent(innerContent, match.index, componentNames, masked)
    )
      continue;
    const contentStart = match.index + fullOpen.length;
    const closeIndex = findMatchingClose(
      innerContent,
      tagName,
      contentStart,
      masked,
    );
    if (closeIndex === -1) continue;
    const closeTagMatch = new RegExp(`^<\\/${tagName}\\s*>`, "i").exec(
      innerContent.slice(closeIndex),
    );
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
 * Lowercase names `getTag` could find opening before `index`: each `<name`
 * token, plus its prefixes ending at a `:` (`<a:b` also opens `a`).
 */
const tagNamesOpenedBefore = (masked: string, index: number): Set<string> => {
  const names = new Set<string>();
  const tokenRe = /<([a-zA-Z][\w:-]*)/g;
  for (
    let token = tokenRe.exec(masked);
    token !== null && token.index < index;
    token = tokenRe.exec(masked)
  ) {
    const name = token[1].toLowerCase();
    names.add(name);
    for (let colon = name.indexOf(":"); colon !== -1;) {
      names.add(name.slice(0, colon));
      colon = name.indexOf(":", colon + 1);
    }
  }
  return names;
};

/**
 * Returns true when an index is inside an unresolved child component usage.
 * Named slots belong to their nearest component boundary, so a parent must not
 * consume slot wrappers authored inside a nested component's usage content.
 */
const isInsideNestedComponent = (
  html: string,
  index: number,
  componentNames: ReadonlySet<string>,
  preMasked?: string,
): boolean => {
  if (componentNames.size === 0) return false;
  const masked = preMasked !== undefined ? preMasked : maskRawTextContent(html);
  const present = tagNamesOpenedBefore(masked, index);
  for (const componentName of componentNames) {
    if (!present.has(componentName.toLowerCase())) continue;
    let searchFrom = 0;
    while (searchFrom < index) {
      const child = getTag(html, componentName, undefined, masked, searchFrom);
      const startIndex = child.startIndex;
      const contentStart = child.contentStart;
      const closeIndex = child.closeIndex;
      const endIndex = child.endIndex;
      if (typeof startIndex !== "number" || startIndex >= index) break;
      if (
        typeof contentStart === "number" &&
        typeof closeIndex === "number" &&
        closeIndex !== -1 &&
        index >= contentStart &&
        index < closeIndex
      ) {
        return true;
      }
      searchFrom =
        typeof endIndex === "number" && endIndex > startIndex
          ? endIndex
          : startIndex + 1;
    }
  }
  return false;
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
  // Remove each named-slot wrapper from right-to-left to preserve indices
  let result = innerContent;
  for (let i = named.length - 1; i >= 0; i--) {
    const { startIndex, endIndex } = named[i];
    result = result.slice(0, startIndex) + result.slice(endIndex);
  }
  return result.trim();
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
  // handled correctly, then replace right-to-left to preserve indices.
  const wrappers = parseNamedSlots(fileContent, componentNames);
  if (wrappers.length === 0) return fileContent;
  const slotsLowerMap = new Map<string, string>();
  for (const [key, val] of Object.entries(slots)) {
    slotsLowerMap.set(key.toLowerCase(), val);
  }
  let result = fileContent;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const { slotName, startIndex, endIndex, content } = wrappers[i];
    // Use the element's own inner content as fallback when the slot is not provided
    // Own keys only: a slot named `constructor` or `toString` that the usage
    // did not fill keeps its fallback instead of Object.prototype's member.
    const matchedSlot = Object.hasOwn(slots, slotName)
      ? slots[slotName]
      : slotsLowerMap.get(slotName.toLowerCase());
    const replacement = matchedSlot !== undefined ? matchedSlot : content;
    result = result.slice(0, startIndex) + replacement + result.slice(endIndex);
  }
  return result;
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
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(masked)) !== null) {
    const [fullOpen, tagName] = match;
    const contentStart = match.index + fullOpen.length;
    const closeIndex = findMatchingClose(
      fileContent,
      tagName,
      contentStart,
      masked,
    );
    if (closeIndex === -1) continue;
    const closeTagMatch = new RegExp(`^<\\/${tagName}\\s*>`, "i").exec(
      fileContent.slice(closeIndex),
    );
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
