/**
 * Shared regular expression fragments for quote-aware HTML open-tag and script tag matching.
 */

export const BARE_TOKEN = String.raw`[^\s"'=<>\`]+`;
export const ATTR_VALUE = String.raw`(?:"[^"]*"|'[^']*'|${BARE_TOKEN})`;
export const ATTR = String.raw`${BARE_TOKEN}(?:\s*=\s*${ATTR_VALUE})?`;
/**
 * Whole-attribute-name boundary. In JavaScript regex `\b` is satisfied between
 * `r` and `-` (hyphen is a non-word character), so `data-bascik-server\b` also
 * matched `data-bascik-server-id` and any `data-bascik-server-*` variant. An
 * attribute name ends only at whitespace, `=`, `/`, `>`, or end of input
 * (callers that pass a captured attribute list have already stripped the `>`).
 */
export const ATTR_NAME_END = String.raw`(?=[\s=/>]|$)`;
/** `data-bascik-build` as a whole attribute name. */
export const BUILD_ATTR_NAME = String.raw`data-bascik-build${ATTR_NAME_END}`;
/** `data-bascik-build-once` as a whole attribute name. */
export const BUILD_ONCE_ATTR_NAME = String.raw`data-bascik-build-once${ATTR_NAME_END}`;
/** `data-bascik-server` as a whole attribute name. */
export const SERVER_ATTR_NAME = String.raw`data-bascik-server${ATTR_NAME_END}`;
/** `data-bascik-routes` as a whole attribute name. */
export const ROUTES_ATTR_NAME = String.raw`data-bascik-routes${ATTR_NAME_END}`;
/** `data-bascik-stream` as a whole attribute name (prompt 65). */
export const STREAM_ATTR_NAME = String.raw`data-bascik-stream${ATTR_NAME_END}`;

/** Any of the script directives as a whole attribute name. */
export const ANY_DIRECTIVE_ATTR_NAME = String.raw`data-bascik-(?:build(?:-once)?|server|routes|stream)${ATTR_NAME_END}`;

export const BUILD_FLAG = String.raw`data-bascik-build${ATTR_NAME_END}(?:\s*=\s*${ATTR_VALUE})?`;
export const BUILD_ONCE_FLAG = String.raw`data-bascik-build-once${ATTR_NAME_END}(?:\s*=\s*${ATTR_VALUE})?`;
export const ANY_BUILD_FLAG = String.raw`(?:${BUILD_FLAG}|${BUILD_ONCE_FLAG})`;
export const SERVER_FLAG = String.raw`data-bascik-server${ATTR_NAME_END}(?:\s*=\s*${ATTR_VALUE})?`;
export const ROUTES_FLAG = String.raw`data-bascik-routes${ATTR_NAME_END}(?:\s*=\s*${ATTR_VALUE})?`;
export const STREAM_FLAG = String.raw`data-bascik-stream${ATTR_NAME_END}(?:\s*=\s*${ATTR_VALUE})?`;
export const SCRIPT_TAG_PREFIX = "<script\\b";
/**
 * Quote-aware attribute text of an open tag: a quoted value may contain `>`,
 * so `<script data-note="a > b" data-bascik-server>` is one open tag. Each
 * alternative starts with a different character class, so matching is linear.
 * Regex literals that cannot interpolate this constant spell it inline.
 */
export const OPEN_TAG_ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
/**
 * A `</script>` end tag as browsers parse it inside script data: `</script`
 * closes the element when followed by whitespace, `/`, or `>`, and everything
 * up to the next `>` is ignored (`</script >`, `</script\t\n foo>`,
 * `</script/>`). `</scripts>` does not close the element, and neither does
 * `</script` followed by U+00A0: only HTML ASCII whitespace counts, so the
 * class is spelled out rather than `\s`. Regex literals that cannot
 * interpolate this constant spell the same fragment inline.
 *
 * Known limit: a regex built on this ends a script at its first `</script`,
 * while a browser keeps going inside `<!--<script>` in the script body (the
 * script data escape states). The modules that use it read authored source
 * files, where that form does not occur. Code that removes or moves markup in
 * built output uses the spec-following scan in html-scanner.ts instead.
 */
export const SCRIPT_END_TAG = String.raw`<\/script(?:[\t\n\f\r /][^>]*)?>`;

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const TRAILING_SCRIPT_END_TAG_RE = new RegExp(`${SCRIPT_END_TAG}$`, "i");

/**
 * Open tag of a matched script element whose body capture is `body`. A lazy
 * body stops at the first end tag, so the earliest end tag reaching the end of
 * `element` is the one the element match ended on, whatever its spelling.
 */
export const scriptOpenTag = (element: string, body: string): string => {
  const endTagLength =
    TRAILING_SCRIPT_END_TAG_RE.exec(element)?.[0].length ?? 0;
  return element.slice(0, element.length - body.length - endTagLength);
};

const ATTR_PAIR_REGEX =
  /(?:^|\s)([^\s"'=<>\`\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\`]+?))(?=\s|\/>|>|$)/gi;

export const getHtmlAttributeValue = (
  openTag: string,
  attribute: string,
): string | undefined => {
  const target = attribute.toLowerCase();
  for (const match of openTag.matchAll(ATTR_PAIR_REGEX)) {
    if (match[1]?.toLowerCase() === target) {
      return match[2] ?? match[3] ?? match[4];
    }
  }
  return undefined;
};

const ATTRIBUTE_VALUE_RE = /\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/g;
const ATTRIBUTE_NAME_RE = /(?:^|[\s/])([^\s"'=<>`/]+)(?=[\s/>]|$)/g;

/**
 * True when `openTag` carries one of `names` (lowercase) as a whole attribute
 * name. Text inside another attribute's quoted value is never an attribute.
 */
const hasAnyHtmlAttribute = (
  openTag: string,
  names: ReadonlySet<string>,
): boolean => {
  const namesOnly = openTag.replace(ATTRIBUTE_VALUE_RE, "");
  for (const match of namesOnly.matchAll(ATTRIBUTE_NAME_RE)) {
    if (names.has(match[1].toLowerCase())) return true;
  }
  return false;
};

const BUILD_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  "data-bascik-build",
  "data-bascik-build-once",
]);

const DIRECTIVE_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  ...BUILD_ATTRIBUTE_NAMES,
  "data-bascik-server",
  "data-bascik-routes",
  "data-bascik-stream",
]);

/** True when an open tag carries `data-bascik-build` or `data-bascik-build-once` as a whole attribute name. */
export const isBuildScriptOpenTag = (openTag: string): boolean =>
  hasAnyHtmlAttribute(openTag, BUILD_ATTRIBUTE_NAMES);

/** True when an open tag carries any script directive as a whole attribute name. */
export const isDirectiveScriptOpenTag = (openTag: string): boolean =>
  hasAnyHtmlAttribute(openTag, DIRECTIVE_ATTRIBUTE_NAMES);
