import { ATTR_VALUE } from "./component-attribute-scan.ts";
import { maskRawTextContent } from "./component-masking.ts";
import {
  createOpenTagScanner,
  isWordOrHyphenCode,
} from "./element-content-scan.ts";

/**
 * One attribute after whitespace: name and optional value. The lookbehind
 * starts a match only at the first character of a whitespace run (a match
 * never ends in whitespace, so the run before the next one is never cut),
 * which finds the same matches as `\s+...` but scans a run that holds no
 * attribute once instead of once per position: quadratic on a long run of
 * spaces in visitor slot content or a usage tag.
 */
const ATTRIBUTE_RE =
  /(?<!\s)\s+([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`/>]+))?/g;

/**
 * Extract attributes from a component usage tag that should be inherited by
 * the component's root element.  All data-bascik-* attributes are excluded.
 *
 * e.g. '<my-nav class="sticky" aria-label="nav" data-bascik-prop-x="y">'
 *      → { class: "sticky", "aria-label": "nav" }
 */
export const extractInheritableAttributes = (
  componentContent: string | undefined,
): Record<string, string> => {
  if (!componentContent) return {};
  const attrs: Record<string, string> = {};
  // Grab just the opening tag text (up to the first > or />).
  // The attribute scan is quote-aware so a `>` inside a quoted attribute value
  // (e.g. title="a > b") does not end the opening tag early.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagMatch = componentContent.match(
    new RegExp(`^<[\\w-]+(${ATTR_VALUE})(?:\\s*\\/?>)`),
  );
  if (!openTagMatch || !openTagMatch[1]) return attrs;
  const attrStr = openTagMatch[1];
  // Accept double-quoted, single-quoted, whitespace-spaced, and unquoted attribute values.
  const attrRegex = ATTRIBUTE_RE;
  attrRegex.lastIndex = 0;
  let match;
  while ((match = attrRegex.exec(attrStr)) !== null) {
    const [, name, rawValue] = match;
    if (name.startsWith("data-bascik-")) continue;
    if (rawValue === undefined) {
      attrs[name] = "";
    } else if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      attrs[name] = rawValue.slice(1, -1);
    } else {
      attrs[name] = rawValue;
    }
  }
  return attrs;
};

/**
 * An inherited value as written on the usage tag (entities kept), made safe
 * for the quote it is written in: HTML allows a raw `"` inside a
 * single-quoted value and a raw `'` inside a double-quoted one, and the root
 * element may quote the attribute the other way. Only the destination's own
 * quote is encoded, which leaves the value the browser decodes unchanged and
 * every other byte as written.
 */
const inDoubleQuotes = (value: string): string => value.replace(/"/g, "&quot;");
const inSingleQuotes = (value: string): string => value.replace(/'/g, "&#39;");

/**
 * Merge inheritable attributes onto the first (root) element of transpiled HTML.
 *  - class: appended to existing classes, or added if absent.
 *  - Other attributes: added only if the root element does not already have them.
 * Each value has the quote it is written in encoded (`inDoubleQuotes`,
 * `inSingleQuotes`), whatever quote the usage used, so no value can end its
 * attribute early.
 */
export const mergeAttributesOntoRoot = (
  html: string,
  attrs: Record<string, string>,
): string => {
  if (!Object.keys(attrs).length) return html;
  const masked = maskRawTextContent(html);
  // `<([a-zA-Z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*>` (flags `gi`) in linear
  // time: the attribute part starts after the whole name (it would take any
  // name characters a shorter name left), so the name is the whole run.
  const tags = createOpenTagScanner(masked, (start) => {
    const first = masked.charCodeAt(start + 1) | 0x20;
    if (first < 0x61 || first > 0x7a) return -1;
    let index = start + 2;
    while (isWordOrHyphenCode(masked.charCodeAt(index))) index++;
    return index;
  });
  const metadataTags = new Set(["link", "meta", "script", "style"]);
  let rootMatch: { index: number; end: number } | null = null;
  for (let tag = tags.next(0); tag !== null; tag = tags.next(tag.end)) {
    if (
      !metadataTags.has(
        masked.slice(tag.start + 1, tag.chainStart).toLowerCase(),
      )
    ) {
      rootMatch = { index: tag.start, end: tag.end };
      break;
    }
  }
  if (!rootMatch) return html;

  const rootTag = html.slice(rootMatch.index, rootMatch.end);
  const rootParts =
    /^<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\s*\/?>)$/i.exec(rootTag);
  if (!rootParts) return html;
  const [, tagName, existing, close] = rootParts;
  let attrStr = existing || "";
  const existingNames = new Set<string>();
  const attrRegex = ATTRIBUTE_RE;
  attrRegex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrStr)) !== null) {
    existingNames.add(match[1].toLowerCase());
  }

  for (const [name, value] of Object.entries(attrs)) {
    const lowerName = name.toLowerCase();
    if (lowerName === "class" && value) {
      if (/\sclass\s*=\s*"/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(class)\s*=\s*"([^"]*)"/i,
          (_, attrName: string, classes: string) =>
            ` ${attrName}="${classes ? `${classes} ` : ""}${inDoubleQuotes(value)}"`,
        );
      } else if (/\sclass\s*=\s*'/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(class)\s*=\s*'([^']*)'/i,
          (_, attrName: string, classes: string) =>
            ` ${attrName}='${classes ? `${classes} ` : ""}${inSingleQuotes(value)}'`,
        );
      } else if (/\sclass\s*=\s*[^\s"'=<>`/>]+/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(class)\s*=\s*([^\s"'=<>`/>]+)/i,
          (_, attrName: string, classes: string) =>
            ` ${attrName}="${classes} ${inDoubleQuotes(value)}"`,
        );
      } else {
        attrStr += ` class="${inDoubleQuotes(value)}"`;
      }
    } else if (lowerName === "style" && value) {
      if (/\sstyle\s*=\s*"/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*"([^"]*)"/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}="${style}${style.trimEnd().endsWith(";") ? " " : "; "}${inDoubleQuotes(value)}"`,
        );
      } else if (/\sstyle\s*=\s*'/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*'([^']*)'/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}='${style}${style.trimEnd().endsWith(";") ? " " : "; "}${inSingleQuotes(value)}'`,
        );
      } else if (/\sstyle\s*=\s*[^\s"'=<>`/>]+/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*([^\s"'=<>`/>]+)/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}="${style}${style.trimEnd().endsWith(";") ? " " : "; "}${inDoubleQuotes(value)}"`,
        );
      } else {
        attrStr += ` style="${inDoubleQuotes(value)}"`;
      }
    } else if (value !== undefined && !existingNames.has(lowerName)) {
      attrStr += ` ${name}="${inDoubleQuotes(value)}"`;
    }
  }

  const mergedRoot = `<${tagName}${attrStr}${close}`;
  return (
    html.slice(0, rootMatch.index) +
    mergedRoot +
    html.slice(rootMatch.index + rootTag.length)
  );
};
