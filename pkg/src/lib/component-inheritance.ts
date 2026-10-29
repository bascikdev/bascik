import { ATTR_VALUE, scanWholeAttributes } from "./component-attribute-scan.ts";
import { maskRawTextContent } from "./component-masking.ts";
import {
  BLOCKED_URL,
  decodeAttributeEntities,
  urlSlot,
  urlVerdict,
} from "./url-safety.ts";
import {
  DEFAULT_BINDING_POLICY,
  type BindingPolicy,
} from "./component-props.ts";
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

/** A class or style the root's template wrote: where it sits and its value. */
interface OwnAttribute {
  start: number;
  end: number;
  name: string;
  quote: '"' | "'" | null;
  value: string;
}

/**
 * Merge inheritable attributes onto the first (root) element of transpiled HTML.
 *  - class: appended to existing classes, or added if absent.
 *  - style: appended to the existing style after a `;`, or added if absent.
 *  - Other attributes: added only if the root element does not already have them.
 * The root's own class and style are found once, in the root as the
 * template wrote it, never in text inheritance adds: a usage value that
 * spells ` class=x` is a value, not a place to merge into.
 * Each value has the quote it is written in encoded (`inDoubleQuotes`,
 * `inSingleQuotes`), whatever quote the usage used, so no value can end its
 * attribute early.
 *
 *
 * Values are inherited exactly as written, with one exception: an attribute
 * that is a URL only because of the root's real tag (`data` on an
 * `<object>`, `to` or `values` on an SVG animation), and was not a URL on
 * the usage tag by name (`usageTag`, judged as html`` judges a tag), gets
 * the URL check, its value read as the browser decodes it: a script URL
 * becomes `about:invalid`, and `warn` receives a message for the caller to
 * locate. html`` saw `<x-embed data>` and could not know; every other
 * attribute (an `on*` handler, `srcdoc`, `style`, an `href` that was
 * already a URL by name) is the author's markup, as html`` or the author
 * left it. With `security.blockScriptUrls` off (`policy`), that value is
 * inherited as written too, with no warning.
 */
export const mergeAttributesOntoRoot = (
  html: string,
  attrs: Record<string, string>,
  warn: (message: string) => void = console.warn,
  usageTag = "",
  policy: BindingPolicy = DEFAULT_BINDING_POLICY,
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
  const own = existing || "";
  // The root's own attribute names, lowercased (the first wins, as in the
  // browser), and where its own class and style sit. One scan of the root
  // as the template wrote it: inherited text is never searched, so a value
  // that spells ` class=` cannot be taken for the root's class.
  const existingAttrs = new Set<string>();
  const ownSpans = new Map<"class" | "style", OwnAttribute>();
  // Spans from the tokenizer-state scan are relative to `<tagName${own}`.
  const offset = 1 + tagName.length;
  const ownTag = `<${tagName}${own}`;
  for (const attr of scanWholeAttributes(ownTag)) {
    const lower = attr.name.toLowerCase();
    if (existingAttrs.has(lower)) continue;
    const before = attr.valueStart > 0 ? ownTag[attr.valueStart - 1] : "";
    const quote = before === '"' || before === "'" ? before : null;
    const value =
      attr.valueStart === -1
        ? ""
        : ownTag.slice(attr.valueStart, attr.valueEnd);
    existingAttrs.add(lower);
    if (lower === "class" || lower === "style")
      ownSpans.set(lower, {
        start: attr.start - offset,
        end: attr.end - offset,
        name: attr.name,
        quote,
        value,
      });
  }
  const rootName = tagName.toLowerCase();
  const usageName = usageTag.toLowerCase();

  // What inheritance adds: values merged into the root's own class and
  // style, and new attributes in usage order (a class or style the root
  // lacks takes the place of its first inherited value).
  const merged = new Map<"class" | "style", string[]>();
  const added: { name: string; merge?: "class" | "style"; value: string }[] =
    [];

  for (const [name, written] of Object.entries(attrs)) {
    const lowerName = name.toLowerCase();
    const merges =
      (lowerName === "class" || lowerName === "style") && written
        ? (lowerName as "class" | "style")
        : undefined;
    if (!merges && (written === undefined || existingAttrs.has(lowerName)))
      continue;
    let value = written;
    if (
      !merges &&
      policy.blockScriptUrls &&
      urlSlot(rootName, lowerName) !== null &&
      urlSlot(usageName, lowerName) === null &&
      urlVerdict(rootName, lowerName, decodeAttributeEntities(written)) ===
        "blocked"
    ) {
      warn(
        `inherited attribute ${name} received a URL that can run script (such as javascript:), so ${name} on the root <${rootName}> is set to ${BLOCKED_URL}.`,
      );
      value = BLOCKED_URL;
    }
    if (!merges) {
      added.push({ name, value });
      continue;
    }
    if (!value) continue;
    const values = merged.get(merges);
    if (values) values.push(value);
    else {
      merged.set(merges, [value]);
      if (!ownSpans.has(merges)) added.push({ name, merge: merges, value });
    }
  }

  /** A root class or style with the inherited values joined on. */
  const join = (kind: "class" | "style", base: string): string =>
    (merged.get(kind) ?? []).reduce(
      (acc, value) =>
        kind === "class"
          ? `${acc ? `${acc} ` : ""}${value}`
          : `${acc}${acc ? (acc.trimEnd().endsWith(";") ? " " : "; ") : ""}${value}`,
      base,
    );

  // The root's own attributes, with its class and style spliced in place
  // (each in its own quote; an unquoted one becomes double-quoted).
  let attrStr = "";
  let cursor = 0;
  for (const [kind, span] of [...ownSpans].sort(
    (a, b) => a[1].start - b[1].start,
  )) {
    if (!merged.has(kind)) continue;
    const value = join(kind, span.value);
    attrStr +=
      own.slice(cursor, span.start) +
      (span.quote === "'"
        ? `${span.name}='${inSingleQuotes(value)}'`
        : `${span.name}="${inDoubleQuotes(value)}"`);
    cursor = span.end;
  }
  attrStr += own.slice(cursor);
  for (const entry of added)
    attrStr += ` ${entry.name}="${inDoubleQuotes(
      entry.merge ? join(entry.merge, "") : entry.value,
    )}"`;

  const mergedRoot = `<${tagName}${attrStr}${close}`;
  return (
    html.slice(0, rootMatch.index) +
    mergedRoot +
    html.slice(rootMatch.index + rootTag.length)
  );
};
