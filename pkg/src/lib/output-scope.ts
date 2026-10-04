/**
 * Output scope for page-aware component build scripts.
 *
 * A `data-bascik-build="page"` script inside a component is deferred: it runs
 * when each page is transpiled, after the component's own scoping pass has
 * already rewritten its template. Its output would otherwise be inserted with
 * plain class and element names that the component's scoped CSS no longer
 * matches. The class scoping pass records the component's mapping on the
 * deferred script tag as `data-bascik-output-scope`, and `executeBuildScripts`
 * applies it to the script's stdout, so printed markup is scoped exactly like
 * markup written in the template.
 */
import { maskElementContents } from "./shielding.ts";

/** Same-length copy with comments and raw-text element content blanked out. */
const maskNonMarkup = (html: string): string =>
  maskElementContents(
    html.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length)),
    ["script", "style", "textarea"],
  );

export const OUTPUT_SCOPE_ATTRIBUTE = "data-bascik-output-scope";

export interface OutputScope {
  /** Class names defined by the component's stylesheet, mapped to their scoped names. */
  classes: Record<string, string>;
  /** Element names styled by the component's stylesheet, mapped to their injected class. */
  elements: Record<string, string>;
}

export const encodeOutputScope = (scope: OutputScope): string =>
  encodeURIComponent(JSON.stringify(scope));

export const decodeOutputScope = (value: string | undefined | null): OutputScope | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<OutputScope>;
    return {
      classes: parsed.classes && typeof parsed.classes === "object" ? parsed.classes : {},
      elements: parsed.elements && typeof parsed.elements === "object" ? parsed.elements : {},
    };
  } catch {
    return null;
  }
};

/** Remove the annotation from a script open tag (it never reaches emitted HTML or the script). */
export const stripOutputScopeAttribute = (openTag: string): string =>
  openTag.replace(/\s+data-bascik-output-scope\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");

const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
// One attribute at a time, so text inside another attribute's quoted value
// (for example `title="<a class=item>"`) is never mistaken for `class`.
const ATTRIBUTE_RE = /(\s+)([^\s"'>/=]+)(?:(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const findClassAttribute = (
  attributes: string,
): { start: number; length: number; prefix: string; value: string; quote: string } | null => {
  ATTRIBUTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_RE.exec(attributes)) !== null) {
    if (match[2].toLowerCase() !== "class" || match[3] === undefined) continue;
    const value = match[5] ?? match[6] ?? match[7] ?? "";
    const quote = match[6] !== undefined ? "'" : '"';
    return { start: match.index, length: match[0].length, prefix: `${match[1]}class${match[3]}`, value, quote };
  }
  return null;
};

const scopeOpenTag = (
  tag: string,
  tagName: string,
  attributes: string,
  scope: OutputScope,
): string => {
  const elementClass = scope.elements[tagName.toLowerCase()];
  const classMatch = findClassAttribute(attributes);
  if (!classMatch && !elementClass) return tag;

  if (!classMatch) {
    return `<${tagName} class="${elementClass}"${attributes}>`;
  }

  const { start, length, prefix, value, quote } = classMatch;
  const tokens = value.split(/\s+/).filter(Boolean).map((token) => scope.classes[token] ?? token);
  if (elementClass && !tokens.includes(elementClass)) tokens.push(elementClass);
  const replacement = `${prefix}${quote}${tokens.join(" ")}${quote}`;
  const updated = attributes.slice(0, start) + replacement + attributes.slice(start + length);
  return `<${tagName}${updated}>`;
};

/**
 * Apply a component's output scope to HTML printed by one of its page-aware
 * build scripts. Only real open tags are touched: markup inside comments,
 * `<script>`, `<style>`, and `<textarea>` content, and attribute values is
 * left as written. Class names the component's stylesheet does not define
 * stay global, the same rule as for template markup.
 */
export const applyOutputScope = (html: string, scope: OutputScope): string => {
  if (!html || (Object.keys(scope.classes).length === 0 && Object.keys(scope.elements).length === 0)) {
    return html;
  }
  const masked = maskNonMarkup(html);
  let result = "";
  let cursor = 0;
  OPEN_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPEN_TAG_RE.exec(masked)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const original = html.slice(start, end);
    // Re-match on the original text: masking blanks only raw-text content and
    // comments, so an open tag found in the mask is identical in the source.
    const originalMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>$/.exec(original);
    if (!originalMatch) continue;
    result += html.slice(cursor, start) + scopeOpenTag(original, originalMatch[1], originalMatch[2], scope);
    cursor = end;
  }
  return result + html.slice(cursor);
};
