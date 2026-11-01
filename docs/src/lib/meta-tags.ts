/**
 * meta-tags.ts: reads a page shell's <title> and <meta name="description"> the way a browser does, for every
 * build script that restates them (the search index's Home entry, Open Graph and Twitter tags, the
 * TechArticle schema). Attribute values keep an apostrophe inside double quotes and a double quote inside
 * single quotes, `name` and `content` may come in either order, and entities are decoded once
 * (html-entities.ts).
 */

import { decodeHtmlText } from "./html-entities.ts";

/**
 * One attribute after whitespace in an opening tag: name, then a double-quoted, single-quoted or
 * unquoted value. Read left to right, so text inside one attribute's quoted value
 * (`data-x=" content='y'"`) is never taken for another attribute (pkg's ATTR_PAIR_REGEX in
 * html-patterns.ts is the model).
 */
const ATTRIBUTE =
  /(?:^|\s)([^\s"'=<>`/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** An opening tag that reads past a `>` inside a quoted value (`content="A > B"`). */
const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** The value of `name` in one tag's attributes, in any quote style and in any attribute order. */
function attributeValue(tag: string, name: string): string | undefined {
  for (const match of tag.matchAll(ATTRIBUTE)) {
    if (match[1].toLowerCase() === name)
      return match[2] ?? match[3] ?? match[4];
  }
  return undefined;
}

/** The raw content of `<meta name="description">` (entities not decoded), wherever `name` and `content` sit. */
export function metaDescription(html: string): string | undefined {
  for (const [tag] of html.matchAll(META_TAG)) {
    if (attributeValue(tag, "name")?.toLowerCase() === "description")
      return attributeValue(tag, "content");
  }
  return undefined;
}

/** The page's description as text: decoded, trimmed, whitespace collapsed. Empty when it has none. */
export function pageDescription(html: string): string {
  return decodeHtmlText(metaDescription(html) ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The page's <title> as text: decoded and trimmed. Empty when it has none. A title's text runs to
 * `</title>` and may hold `<` and `>` (it is RCDATA), and its opening tag may hold `>` in a quoted value.
 */
export function pageTitle(html: string): string {
  const match =
    /<title\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/title\b[^>]*>/i.exec(
      html,
    );
  return match ? decodeHtmlText(match[1]).trim() : "";
}
