/**
 * meta-tags.ts: reads a page shell's <title> and <meta name="description"> the way a browser does, for every
 * build script that restates them (the search index's Home entry, Open Graph and Twitter tags, the
 * TechArticle schema). Attribute values keep an apostrophe inside double quotes and a double quote inside
 * single quotes, `name` and `content` may come in either order, and entities are decoded once.
 */

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

/** Decodes the entities page shells use, in one pass, so `&amp;lt;` reads as `&lt;`, not `<`. */
export function decodeHtmlText(value: string): string {
  return value.replace(
    /&(?:quot|#39|#x27|apos|lt|gt|amp);/gi,
    (entity) => ENTITIES[entity.toLowerCase()],
  );
}

/** The value of `name` in one tag's attributes, in either quote style and in any attribute order. */
function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** The raw content of `<meta name="description">` (entities not decoded), wherever `name` and `content` sit. */
export function metaDescription(html: string): string | undefined {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
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

/** The page's <title> as text: decoded and trimmed. Empty when it has none. */
export function pageTitle(html: string): string {
  const match = /<title\b[^>]*>([^<]*)<\/title>/i.exec(html);
  return match ? decodeHtmlText(match[1]).trim() : "";
}
