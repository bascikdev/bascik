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

export const getHtmlAttributeValue = (openTag: string, attribute: string): string | undefined => {
	const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = openTag.match(
		new RegExp(`\\s${escapedAttribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(${BARE_TOKEN}))`, "i"),
	);
	return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
};
