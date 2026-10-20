import { ATTR_VALUE } from "./component-attribute-scan.ts";
import { maskRawTextContent } from "./component-masking.ts";

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
  const attrRegex = /\s+([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`/>]+))?/g;
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
 * Merge inheritable attributes onto the first (root) element of transpiled HTML.
 *  - class: appended to existing classes, or added if absent.
 *  - Other attributes: added only if the root element does not already have them.
 */
export const mergeAttributesOntoRoot = (
  html: string,
  attrs: Record<string, string>,
): string => {
  if (!Object.keys(attrs).length) return html;
  const masked = maskRawTextContent(html);
  const tagRegex = new RegExp(`<([a-zA-Z][\\w-]*)(?:${ATTR_VALUE})>`, "gi");
  const metadataTags = new Set(["link", "meta", "script", "style"]);
  let rootMatch: RegExpExecArray | null = null;
  let candidate: RegExpExecArray | null;
  while ((candidate = tagRegex.exec(masked)) !== null) {
    if (!metadataTags.has(candidate[1].toLowerCase())) {
      rootMatch = candidate;
      break;
    }
  }
  if (!rootMatch) return html;

  const rootTag = html.slice(
    rootMatch.index,
    rootMatch.index + rootMatch[0].length,
  );
  const rootParts =
    /^<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\s*\/?>)$/i.exec(rootTag);
  if (!rootParts) return html;
  const [, tagName, existing, close] = rootParts;
  let attrStr = existing || "";
  const existingNames = new Set<string>();
  const attrRegex = /\s+([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`/>]+))?/g;
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
            ` ${attrName}="${classes ? `${classes} ` : ""}${value}"`,
        );
      } else if (/\sclass\s*=\s*'/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(class)\s*=\s*'([^']*)'/i,
          (_, attrName: string, classes: string) =>
            ` ${attrName}='${classes ? `${classes} ` : ""}${value}'`,
        );
      } else if (/\sclass\s*=\s*[^\s"'=<>`/>]+/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(class)\s*=\s*([^\s"'=<>`/>]+)/i,
          (_, attrName: string, classes: string) =>
            ` ${attrName}="${classes} ${value}"`,
        );
      } else {
        attrStr += ` class="${value}"`;
      }
    } else if (lowerName === "style" && value) {
      if (/\sstyle\s*=\s*"/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*"([^"]*)"/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}="${style}${style.trimEnd().endsWith(";") ? " " : "; "}${value}"`,
        );
      } else if (/\sstyle\s*=\s*'/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*'([^']*)'/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}='${style}${style.trimEnd().endsWith(";") ? " " : "; "}${value}'`,
        );
      } else if (/\sstyle\s*=\s*[^\s"'=<>`/>]+/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*([^\s"'=<>`/>]+)/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}="${style}${style.trimEnd().endsWith(";") ? " " : "; "}${value}"`,
        );
      } else {
        attrStr += ` style="${value}"`;
      }
    } else if (value !== undefined && !existingNames.has(lowerName)) {
      attrStr += ` ${name}="${value}"`;
    }
  }

  const mergedRoot = `<${tagName}${attrStr}${close}`;
  return (
    html.slice(0, rootMatch.index) +
    mergedRoot +
    html.slice(rootMatch.index + rootTag.length)
  );
};
