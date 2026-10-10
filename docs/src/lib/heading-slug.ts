/**
 * heading-slug.ts: One definition of how a rendered heading becomes an id.
 *
 * The Markdown renderer (md-renderer.ts) stamps these ids on h2/h3 headings and
 * the "On this page" table of contents (render-nav.ts) links to them, so both
 * must derive the id from the same input: the heading's rendered inline HTML.
 */

const ENTITIES: Record<string, string> = {
  '&#39;': "'",
  '&apos;': "'",
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
};

/**
 * Decodes the entities marked emits inside heading text in one pass, so a
 * decoded `&` never starts another entity (`&amp;lt;` reads as `&lt;`).
 */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#39|apos|quot|amp|lt|gt);/g, (entity) => ENTITIES[entity]);
}

/** Plain text of a heading's rendered inline HTML (tags removed, entities decoded). */
export function headingPlainText(headingHtml: string): string {
  // codeql[js/incomplete-multi-character-sanitization] Plain text, not markup: render-nav.ts escapes it at the sink.
  return decodeEntities(headingHtml.replace(/<[^>]+>/g, ''));
}

/** The id for a heading, from its rendered inline HTML. */
export function slugFromHeadingHtml(headingHtml: string): string {
  return headingPlainText(headingHtml)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
