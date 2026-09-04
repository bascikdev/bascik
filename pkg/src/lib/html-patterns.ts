/**
 * Shared regular expression fragments for quote-aware HTML open-tag and script tag matching.
 */

export const BARE_TOKEN = String.raw`[^\s"'=<>\`]+`;
export const ATTR_VALUE = String.raw`(?:"[^"]*"|'[^']*'|${BARE_TOKEN})`;
export const ATTR = String.raw`${BARE_TOKEN}(?:\s*=\s*${ATTR_VALUE})?`;
export const BUILD_FLAG = String.raw`data-bascik-build(?:\s*=\s*${ATTR_VALUE})?`;
export const SERVER_FLAG = String.raw`data-bascik-server(?:\s*=\s*${ATTR_VALUE})?`;
export const ROUTES_FLAG = String.raw`data-bascik-routes(?:\s*=\s*${ATTR_VALUE})?`;
export const SCRIPT_TAG_PREFIX = "<script\\b";

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

