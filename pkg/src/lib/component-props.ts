import { createContentShield, shieldElementContents } from "./shielding.ts";
import { ATTR_VALUE, scanWholeAttributes } from "./component-attribute-scan.ts";
import { findMatchingClose } from "./component-tags.ts";

const decodePropEntities = (value: string): string =>
  value.replace(
    /&(amp|lt|gt|quot|#39|#x27);/gi,
    (_match, entity: string) =>
      ({
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        "#39": "'",
        "#x27": "'",
      })[entity.toLowerCase()] ?? _match,
  );

const escapePropValue = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Extract data-bascik-prop-* attributes from a component usage tag string.
 * e.g. '<my-comp data-bascik-prop-title="Hello">' → { title: "Hello" }
 * `warn` receives the authoring diagnostics (a request host routes them to
 * its own log, prompt 157).
 */
export const extractProps = (
  componentContent: string | undefined,
  warn: (message: string) => void = console.warn,
): Record<string, string> => {
  const props: Record<string, string> = {};
  if (!componentContent || !/data-bascik-prop-/i.test(componentContent))
    return props;
  const openingTag = componentContent.match(
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    new RegExp(`^<[a-zA-Z][\\w:-]*(?:${ATTR_VALUE})>`, "i"),
  )?.[0];
  if (!openingTag) return props;
  // Only whole attribute names count. A token that looks like a prop marker
  // inside another attribute's quoted value (e.g. a doc reference in
  // `title="see data-bascik-prop-x"`) is text, never a prop.
  const propRegexpPrefix = /^data-bascik-prop-/i;
  for (const attr of scanWholeAttributes(openingTag)) {
    const propMatch = propRegexpPrefix.exec(attr.name);
    if (!propMatch) continue;
    const propName = attr.name.slice(propMatch[0].length);
    if (!/^[\w-]+$/.test(propName)) continue;
    // A valueless marker is a template receiver, not a provided value; it
    // contributes no prop (matching the pre-scanner extraction which required
    // an `= value`).
    if (attr.valueStart === -1) continue;
    const rawVal = openingTag.slice(attr.valueStart, attr.valueEnd);
    const isQuoted =
      openingTag[attr.valueStart - 1] === '"' ||
      openingTag[attr.valueStart - 1] === "'";
    if (isQuoted) {
      const followingCharacter = openingTag[attr.valueEnd + 1];
      if (followingCharacter && !/[\s/>]/.test(followingCharacter)) {
        warn(
          `Ignoring malformed data-bascik-prop-${propName}: the value contains an unescaped delimiting quote. Use &quot; or &#39; for quotes inside prop values.`,
        );
        continue;
      }
      props[propName] = decodePropEntities(rawVal);
    } else {
      // Unquoted value: it never contains `/>` or `=` delimiters; a trailing
      // `/` belongs to the self-closing syntax, so drop it.
      const cleanUnquoted = rawVal.endsWith("/") ? rawVal.slice(0, -1) : rawVal;
      props[propName] = decodePropEntities(cleanUnquoted);
    }
  }
  return props;
};

/**
 * Fill `data-bascik-attr-<target>="<prop>"` bindings with the prop values.
 * `rewriteValue` sees each bound value with its target attribute's name
 * before escaping: a request-time renderer injects after scoping and maps id
 * references per target through the scoped id names (prompt 157).
 */
export const injectPropAttributes = (
  fileContent: string | undefined,
  props: Record<string, string>,
  rewriteValue?: (targetName: string, value: string) => string,
  warn: (message: string) => void = console.warn,
): string => {
  if (!fileContent) return "";
  if (!fileContent.includes("data-bascik-attr-")) return fileContent;

  const propsLowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(props)) {
    propsLowerMap.set(k.toLowerCase(), v);
  }

  const commentShield = createContentShield(fileContent);
  const withoutComments = fileContent.includes("<!--")
    ? fileContent.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
        commentShield.hide(comment),
      )
    : fileContent;
  const rawShield = shieldElementContents(withoutComments, [
    "script",
    "style",
    "textarea",
  ]);

  const rewritten = rawShield.html.replace(
    new RegExp(`<([a-zA-Z][\\w:-]*)(?:${ATTR_VALUE})>`, "gi"),
    (openingTag: string) => {
      if (!openingTag.includes("data-bascik-attr-")) return openingTag;
      // Whole attribute names only: a token that looks like a directive inside
      // another attribute's quoted value is text, never a directive.
      const directives: Array<{
        start: number;
        end: number;
        targetName: string;
        rawPropName?: string;
      }> = [];
      for (const attr of scanWholeAttributes(openingTag)) {
        const match = /^data-bascik-attr-(.*)$/i.exec(attr.name);
        if (!match) continue;
        const targetName = match[1];
        const rawPropName =
          attr.valueStart !== -1
            ? openingTag.slice(attr.valueStart - 1, attr.valueEnd + 1)
            : undefined;
        let start = attr.start;
        if (start > 0 && /\s/.test(openingTag[start - 1])) start--;
        directives.push({
          start,
          end: attr.end,
          targetName,
          rawPropName,
        });
      }

      let result = openingTag;
      for (let index = directives.length - 1; index >= 0; index--) {
        const directive = directives[index];
        result = result.slice(0, directive.start) + result.slice(directive.end);
      }

      for (const { targetName, rawPropName } of directives) {
        const isQuoted =
          rawPropName?.startsWith('"') || rawPropName?.startsWith("'");
        const propName = isQuoted ? rawPropName?.slice(1, -1) : undefined;
        if (
          !/^[a-zA-Z_:][\w:.-]*$/.test(targetName) ||
          !propName ||
          !/^[a-zA-Z0-9_-]+$/.test(propName)
        ) {
          warn(
            `Ignoring malformed data-bascik-attr-${targetName}: expected a quoted prop name.`,
          );
          continue;
        }

        const propValue =
          props[propName] ?? propsLowerMap.get(propName.toLowerCase());
        if (propValue === undefined) continue;
        const boundValue = rewriteValue
          ? rewriteValue(targetName, propValue)
          : propValue;
        const attribute = ` ${targetName}="${escapePropValue(boundValue)}"`;
        // Whole-name conflict check: the target may already exist, but a
        // "target-looking" token inside another attribute's quoted value is
        // text and must not count as the target.
        const existing = scanWholeAttributes(result).find(
          (attr) => attr.name.toLowerCase() === targetName.toLowerCase(),
        );
        if (existing) {
          warn(
            `Attribute binding conflict: attribute "${targetName}" already exists; prop "${propName}" wins.`,
          );
          result =
            result.slice(0, existing.start) +
            attribute.slice(1) +
            result.slice(existing.end);
        } else {
          result = result.replace(
            /(\s*\/?>)$/,
            (_match, close: string) => `${attribute}${close}`,
          );
        }
      }

      return result;
    },
  );
  return commentShield.restore(rawShield.restore(rewritten));
};

// ─────────────────────────────────────────────────────────────────────────────
// Prop injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For each prop, find elements in the component template that carry a
 * `data-bascik-prop-{name}` attribute, replace their inner content with the
 * prop value, and strip the marker attribute.
 *
 * e.g. template `<p data-bascik-prop-title></p>` + { title: "Hi" }
 *      → `<p>Hi</p>`
 */
export const injectProps = (
  fileContent: string | undefined,
  props: Record<string, string>,
): string => {
  if (!fileContent) return "";
  // With no lowercase marker, an empty props object returns early, and without any marker nothing changes.
  if (
    !fileContent.includes("data-bascik-prop-") &&
    (Object.keys(props).length === 0 || !/data-bascik-prop-/i.test(fileContent))
  )
    return fileContent;
  const commentShield = createContentShield(fileContent);
  const withoutComments = fileContent.includes("<!--")
    ? fileContent.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
        commentShield.hide(comment),
      )
    : fileContent;
  const rawShield = shieldElementContents(withoutComments, [
    "script",
    "style",
    "textarea",
  ]);
  let result = rawShield.html;
  const resultLower = result.toLowerCase();
  Object.entries(props).forEach(([propName, propValue]) => {
    if (!resultLower.includes(propName.toLowerCase())) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(propName)) return;
    const attrName = `data-bascik-prop-${propName}`;
    const escapedPropValue = escapePropValue(propValue);
    // Scan whole opening tags and act only on whole attribute names, so a
    // marker token inside another attribute's quoted value is never confused
    // with a receiver.
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const openTagRe = new RegExp(`<([a-zA-Z][\\w:-]*)(?:${ATTR_VALUE})>`, "gi");
    let searchIndex = 0;
    while (searchIndex < result.length) {
      openTagRe.lastIndex = searchIndex;
      const openMatch = openTagRe.exec(result);
      if (!openMatch) break;
      const openTag = openMatch[0];
      const tagName = openMatch[1];
      const receiverAttr = scanWholeAttributes(openTag).find(
        (attr) =>
          attr.name.toLowerCase() === attrName.toLowerCase() &&
          attr.valueStart === -1 &&
          // A self-closing marker (`data-bascik-prop-x/>`) is not a receiver.
          (/[\s>]/.test(openTag[attr.nameEnd] ?? "") ||
            attr.nameEnd >= openTag.length),
      );
      if (!receiverAttr) {
        searchIndex = openMatch.index + openTag.length;
        continue;
      }
      const contentStart = openMatch.index + openTag.length;
      const closeIndex = findMatchingClose(result, tagName, contentStart);
      if (closeIndex === -1) {
        searchIndex = contentStart;
        continue;
      }
      const closeTag = new RegExp(`^<\\/${tagName}\\s*>`, "i").exec(
        result.slice(closeIndex),
      )?.[0];
      if (!closeTag) {
        searchIndex = contentStart;
        continue;
      }
      // Remove the receiver attribute from the opening tag.
      let attrStart = receiverAttr.start;
      if (attrStart > 0 && /\s/.test(openTag[attrStart - 1])) attrStart--;
      const newOpenTag =
        openTag.slice(0, attrStart) + openTag.slice(receiverAttr.end);
      const replacement = `${newOpenTag}${escapedPropValue}${closeTag}`;
      result =
        result.slice(0, openMatch.index) +
        replacement +
        result.slice(closeIndex + closeTag.length);
      searchIndex = openMatch.index + replacement.length;
    }
  });
  // Strip any remaining data-bascik-prop-* markers whose prop was not provided.
  // Only strip markers that are whole attribute names WITHOUT a value (prop
  // receivers, e.g. `data-bascik-prop-label` followed by whitespace or `>`).
  // Markers with a value (e.g. `data-bascik-prop-label="featured"`) are child
  // component prop declarations and must be preserved so nested components
  // receive their props.  A token that only appears inside prose or inside
  // another attribute's quoted value is text, never a marker.
  const stripped = stripUnfilledPropMarkers(result);
  return commentShield.restore(rawShield.restore(stripped));
};

const stripUnfilledPropMarkers = (html: string): string => {
  // Whole attribute names only: a token that merely looks like a marker inside
  // prose or another attribute's quoted value is text and is never stripped.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRe = new RegExp(
    `<([a-zA-Z][\\w:-]*)((?:${ATTR_VALUE})[\\s>])`,
    "gi",
  );
  let result = html;
  let openTagMatch: RegExpExecArray | null;
  while ((openTagMatch = openTagRe.exec(result)) !== null) {
    const openTag = openTagMatch[0];
    const tagStart = openTagMatch.index;
    const removals: Array<{ start: number; end: number }> = [];
    for (const attr of scanWholeAttributes(openTag)) {
      if (!/^data-bascik-prop-[\w-]+$/i.test(attr.name)) continue;
      // Keep markers that carry a value: they are child component prop
      // declarations that must reach the nested component.
      if (attr.valueStart !== -1) continue;
      // A marker on a self-closing tag (`data-bascik-prop-x/>`) is left as
      // authored, matching the old receiver boundary.
      if (
        !/[\s>]/.test(openTag[attr.nameEnd] ?? "") &&
        attr.nameEnd < openTag.length
      )
        continue;
      let start = attr.start;
      if (start > 0 && /\s/.test(openTag[start - 1])) start--;
      removals.push({ start, end: attr.end });
    }
    if (removals.length === 0) {
      openTagRe.lastIndex = tagStart + openTag.length;
      continue;
    }
    // Rebuild the tag keeping only the non-removed pieces.
    let pieces = "";
    let cursor = 0;
    for (const { start, end } of removals) {
      pieces += openTag.slice(cursor, start);
      cursor = end;
    }
    pieces += openTag.slice(cursor);
    result =
      result.slice(0, tagStart) +
      pieces +
      result.slice(tagStart + openTag.length);
    // Re-scan from the same document offset: the tag was rewritten but the
    // outer regex must not skip content (positions after the tag shifted).
    openTagRe.lastIndex = tagStart;
  }
  return result;
};
