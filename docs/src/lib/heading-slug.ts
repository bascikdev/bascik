/**
 * heading-slug.ts: One definition of how a rendered heading becomes an id.
 *
 * The Markdown renderer (md-renderer.ts) stamps these ids on h2/h3 headings and
 * the "On this page" table of contents (render-nav.ts) links to them, so both
 * must derive the id from the same input: the heading's rendered inline HTML.
 */

/** Decodes the entities marked emits inside heading text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Plain text of a heading's rendered inline HTML (tags removed, entities decoded). */
export function headingPlainText(headingHtml: string): string {
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
