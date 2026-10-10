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
/** `data-bascik-server` as a whole attribute name. */
export const SERVER_ATTR_NAME = String.raw`data-bascik-server${ATTR_NAME_END}`;
/** `data-bascik-routes` as a whole attribute name. */
export const ROUTES_ATTR_NAME = String.raw`data-bascik-routes${ATTR_NAME_END}`;
/** `data-bascik-stream` as a whole attribute name (prompt 65). */
export const STREAM_ATTR_NAME = String.raw`data-bascik-stream${ATTR_NAME_END}`;

/** Any of the four script directives as a whole attribute name. */
export const ANY_DIRECTIVE_ATTR_NAME = String.raw`data-bascik-(?:build|server|routes|stream)${ATTR_NAME_END}`;

export const BUILD_FLAG = String.raw`data-bascik-build${ATTR_NAME_END}(?:\s*=\s*${ATTR_VALUE})?`;
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
 * `</script/>`). `</scripts>` does not close the element. Regex literals that
 * cannot interpolate this constant spell the same fragment inline.
 */
export const SCRIPT_END_TAG = String.raw`<\/script(?:[\s/][^>]*)?>`;

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const TRAILING_SCRIPT_END_TAG_RE = new RegExp(`${SCRIPT_END_TAG}$`, "i");

/**
 * Open tag of a matched script element whose body capture is `body`. A lazy
 * body stops at the first end tag, so the earliest end tag reaching the end of
 * `element` is the one the element match ended on, whatever its spelling.
 */
export const scriptOpenTag = (element: string, body: string): string => {
	const endTagLength = TRAILING_SCRIPT_END_TAG_RE.exec(element)?.[0].length ?? 0;
	return element.slice(0, element.length - body.length - endTagLength);
};

const ATTR_PAIR_REGEX =
	/(?:^|\s)([^\s"'=<>\`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\`]+))/gi;

export const getHtmlAttributeValue = (openTag: string, attribute: string): string | undefined => {
	const target = attribute.toLowerCase();
	for (const match of openTag.matchAll(ATTR_PAIR_REGEX)) {
		if (match[1]?.toLowerCase() === target) {
			return match[2] ?? match[3] ?? match[4];
		}
	}
	return undefined;
};

