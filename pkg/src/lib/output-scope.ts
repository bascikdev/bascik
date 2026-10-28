/** Helpers for applying a component's scoped names to build-script output. */
import { findCommentEnd } from "./html-scanner.ts";
import { maskElementContents } from "./shielding.ts";

/**
 * Same-length copy with comments blanked. Comments end where the browser ends
 * them (`-->`, `--!>`, `<!-->`, `<!--->`, or the end of input), so markup the
 * browser treats as live is never hidden. An indexOf walk, not
 * `/<!--[\s\S]*?-->/g`: that regex rescans to the end from every unclosed
 * opener, which is quadratic on request-time output carrying visitor text.
 */
const blankComments = (html: string): string => {
  let start = html.indexOf("<!--");
  if (start === -1) return html;
  let result = "";
  let cursor = 0;
  while (start !== -1) {
    const end = findCommentEnd(html, start);
    const stop = end === -1 ? html.length : end;
    result += html.slice(cursor, start) + " ".repeat(stop - start);
    cursor = stop;
    start = end === -1 ? -1 : html.indexOf("<!--", stop);
  }
  return result + html.slice(cursor);
};

/** Same-length copy with comments and raw-text element content blanked out. */
const maskNonMarkup = (html: string): string =>
  maskElementContents(blankComments(html), ["script", "style", "textarea"]);

export const OUTPUT_SCOPE_ATTRIBUTE = "data-bascik-output-scope";

export interface OutputScope {
  /** Class names defined by the component's stylesheet, mapped to their scoped names. */
  classes: Record<string, string>;
  /** Element names styled by the component's stylesheet, mapped to their injected class. */
  elements: Record<string, string>;
}

export const encodeOutputScope = (scope: OutputScope): string =>
  encodeURIComponent(JSON.stringify(scope));

export const decodeOutputScope = (
  value: string | undefined | null,
): OutputScope | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      decodeURIComponent(value),
    ) as Partial<OutputScope>;
    return {
      classes: keepStringEntries(parsed.classes),
      elements: keepStringEntries(parsed.elements),
    };
  } catch {
    return null;
  }
};

/** Keep only string-keyed pairs whose value is a string, so a malformed map never reaches the scope. */
const keepStringEntries = (map: unknown): Record<string, string> => {
  const result: Record<string, string> = {};
  if (map && typeof map === "object") {
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "string") result[key] = value;
    }
  }
  return result;
};

/** Remove the annotation from a script open tag (it never reaches emitted HTML or the script). */
export const stripOutputScopeAttribute = (openTag: string): string =>
  openTag.replace(
    // The lookbehind starts a match only at the first character of a
    // whitespace run, so a run without the annotation is scanned once, not
    // once per position (quadratic on a long run).
    /(?<!\s)\s+data-bascik-output-scope\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
    "",
  );

const OPEN_TAG_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>$/;

const isAsciiAlpha = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

// Scan states: outside quotes, inside "...", inside '...'.
const OUTSIDE = 1;
const IN_DOUBLE = 2;
const IN_SINGLE = 4;

/**
 * Yields `[start, end)` of each open tag `OPEN_TAG_RE` would find with the
 * `g` flag, in linear time. The regex scanned from every `<` to the end of
 * the input whenever a tag never closed (`<a<a<a...`, or an unclosed quote),
 * which is quadratic on request-time output carrying visitor text. The
 * grammar is deterministic, so a scan that reaches a (position, quote state)
 * a failed scan already passed through fails the same way; `failed` records
 * those, and each pair is walked at most once.
 */
function* openTags(html: string): Generator<[number, number]> {
  const failed = new Uint8Array(html.length + 1);
  let start = html.indexOf("<");
  while (start !== -1) {
    if (!isAsciiAlpha(html.charCodeAt(start + 1))) {
      start = html.indexOf("<", start + 1);
      continue;
    }
    const visited: number[] = [];
    let state = OUTSIDE;
    let end = -1;
    for (let i = start + 1; i < html.length; i++) {
      if (failed[i] & state) break;
      visited.push(i, state);
      const char = html[i];
      if (state === OUTSIDE) {
        if (char === ">") {
          end = i + 1;
          break;
        }
        if (char === '"') state = IN_DOUBLE;
        else if (char === "'") state = IN_SINGLE;
      } else if (
        (state === IN_DOUBLE && char === '"') ||
        (state === IN_SINGLE && char === "'")
      ) {
        state = OUTSIDE;
      }
    }
    if (end !== -1) {
      yield [start, end];
      start = html.indexOf("<", end);
      continue;
    }
    for (let k = 0; k < visited.length; k += 2)
      failed[visited[k]] |= visited[k + 1];
    start = html.indexOf("<", start + 1);
  }
}
// One attribute at a time, so text inside another attribute's quoted value
// (for example `title="<a class=item>"`) is never mistaken for `class`.
const ATTRIBUTE_RE =
  /(\s+)([^\s"'>/=]+)(?:(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const findClassAttribute = (
  attributes: string,
): {
  start: number;
  length: number;
  prefix: string;
  value: string;
  quote: string;
  suffix: string;
} | null => {
  ATTRIBUTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_RE.exec(attributes)) !== null) {
    if (match[2].toLowerCase() !== "class" || match[3] === undefined) continue;
    const rawUnquoted = match[7];
    const hasTrailingSlash =
      rawUnquoted !== undefined &&
      rawUnquoted.endsWith("/") &&
      match.index + match[0].length === attributes.length;
    const unquotedValue = hasTrailingSlash
      ? rawUnquoted.slice(0, -1)
      : rawUnquoted;
    const value = match[5] ?? match[6] ?? unquotedValue ?? "";
    const quote = match[6] !== undefined ? "'" : '"';
    const suffix = hasTrailingSlash ? "/" : "";
    return {
      start: match.index,
      length: match[0].length,
      prefix: `${match[1]}class${match[3]}`,
      value,
      quote,
      suffix,
    };
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

  const { start, length, prefix, value, quote, suffix } = classMatch;
  const tokens = value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => scope.classes[token] ?? token);
  if (elementClass && !tokens.includes(elementClass)) tokens.push(elementClass);
  const replacement = `${prefix}${quote}${tokens.join(" ")}${quote}${suffix}`;
  const updated =
    attributes.slice(0, start) + replacement + attributes.slice(start + length);
  return `<${tagName}${updated}>`;
};

/**
 * Apply a component's output scope to HTML printed by one of its build
 * scripts. Only real open tags are touched: markup inside comments,
 * `<script>`, `<style>`, and `<textarea>` content, and attribute values is
 * left as written. Class names the component's stylesheet does not define
 * stay global, the same rule as for template markup.
 */
export const applyOutputScope = (html: string, scope: OutputScope): string => {
  if (
    !html ||
    (Object.keys(scope.classes).length === 0 &&
      Object.keys(scope.elements).length === 0)
  ) {
    return html;
  }
  const masked = maskNonMarkup(html);
  let result = "";
  let cursor = 0;
  for (const [start, end] of openTags(masked)) {
    const original = html.slice(start, end);
    // Re-match on the original text: masking blanks only raw-text content and
    // comments, so an open tag found in the mask is identical in the source.
    const originalMatch = OPEN_TAG_RE.exec(original);
    if (!originalMatch) continue;
    result +=
      html.slice(cursor, start) +
      scopeOpenTag(original, originalMatch[1], originalMatch[2], scope);
    cursor = end;
  }
  return result + html.slice(cursor);
};
